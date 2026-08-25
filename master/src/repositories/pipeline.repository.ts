/**
 * Pipelines and their stages — the Kanban columns, which are tenant data
 * rather than a hardcoded enum (docs/LEAD_GENERATION_FLOW.md §4.2).
 *
 * Stages are read on nearly every lead and order operation, so they are cached
 * per tenant. The cache is invalidated explicitly on write rather than given a
 * time-to-live: a stage rename that takes 30 seconds to appear would look like
 * a bug, and the write path is rare enough that being exact costs nothing.
 */

import type { Pipeline, PipelineKind, PipelineStage } from '@orderbook/shared';
import type { Knex } from 'knex';

import type { Stage } from '../domain/pipeline.js';
import type { TransactionContext } from './transaction.js';
import { db } from '../db/knex.js';
import { mapPipeline, mapPipelineStage } from './mappers.js';

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

// --- Stage writes (Stage 3, docs/backend-modules/06-WORKFLOWS.md §5.1) -----

export async function findStageById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<PipelineStage | null> {
  const row = await runner('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where({ 's.id': id, 'p.tenant_id': tenantId })
    .first('s.*');
  return row ? mapPipelineStage(row) : null;
}

/** Leads and orders both point at `stage_id` — a stage archive is blocked by either. */
export async function countLiveRecordsInStage(
  tenantId: string,
  stageId: string,
  runner: Runner = db(),
): Promise<number> {
  const [leadCount, orderCount] = await Promise.all([
    runner('leads').where({ tenant_id: tenantId, stage_id: stageId }).whereNull('deleted_at').count<{ count: string }[]>('id as count'),
    runner('orders').where({ tenant_id: tenantId, stage_id: stageId }).whereNull('deleted_at').count<{ count: string }[]>('id as count'),
  ]);
  return Number(leadCount[0]?.count ?? 0) + Number(orderCount[0]?.count ?? 0);
}

/**
 * `id`/`pipelineId` are trusted here — the service resolves and tenant-checks
 * the stage via `findStageById` first and passes its `pipelineId` through, the
 * same shape `reorderStagesDeferred`/`stageIdsForPipeline` already use. A
 * `pipeline_stages` row carries no `tenant_id` of its own (§9.5,
 * `03-DATABASE.md`) — scoping every write through a join would duplicate a
 * check the read already made.
 */
export async function updateStageColumns(
  pipelineId: string,
  id: string,
  patch: { name?: string; colour?: string | null; is_terminal?: boolean },
  trx: TransactionContext,
): Promise<PipelineStage | null> {
  const [row] = await trx('pipeline_stages')
    .where({ id, pipeline_id: pipelineId })
    .update(patch)
    .returning('*');
  return row ? mapPipelineStage(row) : null;
}

/** Clear-then-set: `idx_pipeline_stages_one_default` is partial and forbids two, never zero. */
export async function setDefaultStage(
  pipelineId: string,
  stageId: string,
  trx: TransactionContext,
): Promise<void> {
  await trx('pipeline_stages').where({ pipeline_id: pipelineId, is_default: true }).update({ is_default: false });
  await trx('pipeline_stages').where({ id: stageId, pipeline_id: pipelineId }).update({ is_default: true });
}

export async function archiveStage(
  pipelineId: string,
  id: string,
  trx: TransactionContext,
): Promise<PipelineStage | null> {
  const [row] = await trx('pipeline_stages')
    .where({ id, pipeline_id: pipelineId })
    .update({ is_archived: true })
    .returning('*');
  return row ? mapPipelineStage(row) : null;
}

export async function restoreStage(
  pipelineId: string,
  id: string,
  trx: TransactionContext,
): Promise<PipelineStage | null> {
  const [row] = await trx('pipeline_stages')
    .where({ id, pipeline_id: pipelineId })
    .update({ is_archived: false })
    .returning('*');
  return row ? mapPipelineStage(row) : null;
}

/**
 * Reorder within a pipeline under the deferrable `pipeline_stages_seq_unique`
 * constraint — the caller's transaction must `SET CONSTRAINTS ... DEFERRED`
 * before this runs, or the first `UPDATE` of a transiently-colliding
 * permutation fails immediately.
 */
export async function reorderStagesDeferred(
  pipelineId: string,
  orderedIds: readonly string[],
  trx: TransactionContext,
): Promise<void> {
  await trx.raw('SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED');
  for (const [index, id] of orderedIds.entries()) {
    await trx('pipeline_stages').where({ id, pipeline_id: pipelineId }).update({ sequence: index + 1 });
  }
}

/** Non-cached — for reading a pipeline's stages back inside the same transaction as a write. */
export async function stagesForPipelineFresh(
  tenantId: string,
  pipelineId: string,
  runner: Runner = db(),
): Promise<PipelineStage[]> {
  const rows = await runner('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where({ 's.pipeline_id': pipelineId, 'p.tenant_id': tenantId })
    .orderBy('s.sequence')
    .select('s.*');
  return rows.map(mapPipelineStage);
}

export async function stageIdsForPipeline(
  tenantId: string,
  pipelineId: string,
  runner: Runner = db(),
): Promise<string[]> {
  const rows = await runner('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where({ 's.pipeline_id': pipelineId, 'p.tenant_id': tenantId })
    .orderBy('s.sequence')
    .select<{ id: string }[]>('s.id');
  return rows.map((row) => row.id);
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
