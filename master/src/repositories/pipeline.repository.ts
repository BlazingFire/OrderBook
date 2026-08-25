/**
 * Pipelines and their stages — the Kanban columns, which are tenant data
 * rather than a hardcoded enum (docs/LEAD_GENERATION_FLOW.md §4.2).
 *
 * Stages are read on nearly every lead and order operation, so they are cached
 * per tenant. The cache is invalidated explicitly on write rather than given a
 * time-to-live: a stage rename that takes 30 seconds to appear would look like
 * a bug, and the write path is rare enough that being exact costs nothing.
 *
 * The write surface below (`docs/backend-modules/04-API-CONTRACT.md` §5.5,
 * Stage 3) is deliberately narrow: no create, no delete. Stages are seeded by
 * the tenancy migration; Fields can rename, recolour, reorder, archive and
 * restore them, never mint or remove one.
 */

import type { Pipeline, PipelineKind, PipelineStage } from '@orderbook/shared';
import type { Knex } from 'knex';

import type { Stage } from '../domain/pipeline.js';
import { db } from '../db/knex.js';
import { mapPipeline, mapPipelineStage } from './mappers.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;

const cache = new Map<string, Pipeline[]>();

export function invalidatePipelineCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function listPipelines(
  tenantId: string,
  runner: Runner = db(),
): Promise<Pipeline[]> {
  const cached = cache.get(tenantId);
  if (cached) return cached;

  const pipelineRows = await runner('pipelines').where({ tenant_id: tenantId }).select('*');

  const stageRows = await runner('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where({ 'p.tenant_id': tenantId })
    .orderBy('s.sequence')
    .select('s.*');

  const stagesByPipeline = new Map<string, PipelineStage[]>();
  for (const row of stageRows) {
    const stage = mapPipelineStage(row);
    const bucket = stagesByPipeline.get(stage.pipelineId);
    if (bucket) bucket.push(stage);
    else stagesByPipeline.set(stage.pipelineId, [stage]);
  }

  const pipelines = pipelineRows.map((row) =>
    mapPipeline(row, stagesByPipeline.get(String(row.id)) ?? []),
  );

  cache.set(tenantId, pipelines);
  return pipelines;
}

export async function stagesFor(
  tenantId: string,
  kind: PipelineKind,
  runner: Runner = db(),
): Promise<Stage[]> {
  const pipelines = await listPipelines(tenantId, runner);
  const pipeline = pipelines.find((candidate) => candidate.kind === kind);

  if (!pipeline) {
    throw new Error(`No ${kind} pipeline for tenant ${tenantId} — check the tenancy migration`);
  }

  return pipeline.stages.map((stage) => ({
    id: stage.id,
    pipelineId: stage.pipelineId,
    name: stage.name,
    sequence: stage.sequence,
    isDefault: stage.isDefault,
    isTerminal: stage.isTerminal,
    isArchived: stage.isArchived,
  }));
}

// --- Fields management: stage writes ---------------------------------------

export async function findStageById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<PipelineStage | null> {
  const row = await runner('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where({ 'p.tenant_id': tenantId, 's.id': id })
    .first('s.*');

  return row ? mapPipelineStage(row) : null;
}

/** Live (non-archived) stage ids for one pipeline, in sequence order — the set a reorder must exactly permute. */
export async function liveStageIds(
  tenantId: string,
  pipelineId: string,
  runner: Runner = db(),
): Promise<string[]> {
  const rows = await runner('pipeline_stages')
    .join('pipelines', 'pipelines.id', 'pipeline_stages.pipeline_id')
    .where({ 'pipelines.tenant_id': tenantId, 'pipeline_stages.pipeline_id': pipelineId })
    .orderBy('pipeline_stages.sequence')
    .select<Array<{ id: string }>>('pipeline_stages.id');

  return rows.map((row) => row.id);
}

export interface UpdateStageInput {
  name?: string;
  colour?: string | null;
  isTerminal?: boolean;
}

export async function updateStageColumns(
  id: string,
  patch: UpdateStageInput,
  trx: TransactionContext,
): Promise<void> {
  const columns: Record<string, unknown> = {};
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.colour !== undefined) columns.colour = patch.colour;
  if (patch.isTerminal !== undefined) columns.is_terminal = patch.isTerminal;

  if (Object.keys(columns).length === 0) return;
  await trx('pipeline_stages').where({ id }).update(columns);
}

/**
 * Clear-then-set, never set-then-clear. `idx_pipeline_stages_one_default` is a
 * *partial* unique index and cannot become a deferrable constraint, so the
 * only way to move the default without ever having two — or, briefly, zero
 * visible to another reader — is two statements in one transaction, in this
 * order (`03-DATABASE.md` §6.5.2).
 */
export async function setDefaultStage(
  pipelineId: string,
  id: string,
  trx: TransactionContext,
): Promise<void> {
  await trx('pipeline_stages').where({ pipeline_id: pipelineId, is_default: true }).update({ is_default: false });
  await trx('pipeline_stages').where({ id }).update({ is_default: true });
}

/**
 * The complete `1..N` sequence for one pipeline, written under a deferred
 * constraint check. `pipeline_stages_seq_unique` (`20260306000000`) is
 * `DEFERRABLE INITIALLY IMMEDIATE`; without deferring it here, the first
 * `UPDATE` of a reorder that transiently duplicates a sequence number fails
 * outright (`03-DATABASE.md` §6.5.1).
 */
export async function reorderStages(
  ordered: ReadonlyArray<{ id: string; sequence: number }>,
  trx: TransactionContext,
): Promise<void> {
  await trx.raw('SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED');

  for (const { id, sequence } of ordered) {
    await trx('pipeline_stages').where({ id }).update({ sequence });
  }
}

export async function archiveStage(id: string, trx: TransactionContext): Promise<void> {
  await trx('pipeline_stages').where({ id }).update({ is_archived: true });
}

export async function restoreStage(id: string, trx: TransactionContext): Promise<void> {
  await trx('pipeline_stages').where({ id }).update({ is_archived: false });
}

/** Live leads and orders currently sitting in a stage — what an archive must not strand. */
export async function stageOccupancy(
  tenantId: string,
  stageId: string,
  trx: TransactionContext,
): Promise<{ leads: number; orders: number }> {
  const [leadRow] = await trx('leads')
    .where({ tenant_id: tenantId, stage_id: stageId })
    .whereNull('deleted_at')
    .count<Array<{ count: string }>>({ count: '*' });
  const [orderRow] = await trx('orders')
    .where({ tenant_id: tenantId, stage_id: stageId })
    .whereNull('deleted_at')
    .count<Array<{ count: string }>>({ count: '*' });

  return { leads: Number(leadRow?.count ?? 0), orders: Number(orderRow?.count ?? 0) };
}
