/**
 * Stage movement rules for the configurable pipelines
 * (docs/LEAD_GENERATION_FLOW.md §4.2).
 *
 * The old model had a hardcoded status enum, so "which transitions are legal"
 * was a table in code. Stages are now tenant-configurable data, so that table
 * cannot exist — what remains are the few rules that hold whatever stages a
 * company invents. Everything else is allowed: a Kanban board whose columns
 * refuse most drags is a board people fight rather than use.
 */

import { NotFoundError, ValidationError } from '../lib/errors.js';

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  sequence: number;
  isDefault: boolean;
  isTerminal: boolean;
  isArchived: boolean;
}

/** Where a newly created record lands. */
export function defaultStage(stages: Stage[]): Stage {
  const fallback = stages.find((stage) => stage.isDefault) ?? stages[0];
  if (!fallback) {
    throw new Error('Pipeline has no stages — the tenancy migration seeds them');
  }
  return fallback;
}

export function findStage(stages: Stage[], stageId: string): Stage {
  const stage = stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new NotFoundError('Stage');
  return stage;
}

/**
 * Validate a stage move.
 *
 * Three rules, all about not rewriting history rather than about process:
 *  - a stage from another pipeline is not a move, it is a mistake;
 *  - a converted lead is history and stops moving. Its order carries the
 *    workflow from that point on, and letting the lead drift afterwards would
 *    make "which stage is this business at?" ambiguous;
 *  - an archived stage stops accepting new arrivals (`docs/backend-modules/06-WORKFLOWS.md`
 *    §5.1) — it still resolves for a record already there, and still renders
 *    in the timeline, but it is not a legal move target.
 */
export function assertStageMove(
  stages: Stage[],
  from: string,
  to: string,
  options: { convertedOrderId?: string | null } = {},
): Stage {
  const target = findStage(stages, to);
  const current = findStage(stages, from);

  if (target.pipelineId !== current.pipelineId) {
    throw new ValidationError('validation.stage.differentPipeline');
  }

  if (options.convertedOrderId) {
    throw new ValidationError('validation.stage.leadConverted');
  }

  if (target.isArchived) {
    throw new ValidationError('validation.stage.archived');
  }

  return target;
}

/** Human-readable line for the automatic timeline entry a move writes. */
export function stageChangeMessage(from: Stage, to: Stage): string {
  return `Moved from ${from.name} to ${to.name}`;
}
