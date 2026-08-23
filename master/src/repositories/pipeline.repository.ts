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
  }));
}
