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
 * Two rules, both about not rewriting history rather than about process:
 *  - a stage from another pipeline is not a move, it is a mistake;
 *  - a converted lead is history and stops moving. Its order carries the
 *    workflow from that point on, and letting the lead drift afterwards would
 *    make "which stage is this business at?" ambiguous.
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
    throw new ValidationError('That stage belongs to a different pipeline');
  }

  if (options.convertedOrderId) {
    throw new ValidationError(
      'This lead has already become an order — move the order instead',
    );
  }

  return target;
}

/** Human-readable line for the automatic timeline entry a move writes. */
export function stageChangeMessage(from: Stage, to: Stage): string {
  return `Moved from ${from.name} to ${to.name}`;
}
