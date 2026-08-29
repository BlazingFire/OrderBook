/**
 * What the assistant is, as far as the panels are concerned.
 *
 * Two rules shape every type here, and both are about authority rather than
 * taste.
 *
 * **The model never writes.** There is no write tool and no write path. A
 * change it suggests is a `AiProposal` — a per-field diff a person ticks and
 * applies through the ordinary service, with the ordinary permission check. The
 * worst a prompt-injected note in a party record can achieve is a wrong or rude
 * sentence, never an action.
 *
 * **The model never sees SQL.** Every tool is one call to a service the caller
 * could already have called, with that caller's own actor — so party scope and
 * rate masking stay exactly where they are. Generated SQL would bypass both by
 * construction, because both run *above* the query.
 */

import type { IsoTimestamp, Uuid } from './entities.js';

export type AiRunKind = 'ask' | 'draft' | 'summarise' | 'vision' | 'narrate';
export type AiRunStatus = 'running' | 'done' | 'cancelled' | 'failed';

/** One step the model took, kept so an answer can show its working. */
export interface AiToolCall {
  tool: string;
  /** Already validated by the tool; never free-form text reaching a query. */
  arguments: Record<string, unknown>;
  /** How many rows came back. Never the rows — those can be a whole catalogue. */
  resultCount: number;
  ms: number;
}

export interface AiRun {
  id: Uuid;
  kind: AiRunKind;
  status: AiRunStatus;
  model: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  prompt: string;
  answer: string | null;
  toolTrace: AiToolCall[];
  proposal: AiProposal | null;
  /**
   * Whether the person who asked could see rates at the time.
   *
   * Recorded on the run rather than recomputed on read, because it is the
   * question being asked: somebody who has since lost `field.saleRate.view`
   * must not get back a transcript that quoted rates to them last month.
   */
  ratesVisible: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  errorCode: string | null;
  latencyMs: number | null;
  createdAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
}

/**
 * The metadata half of a run.
 *
 * What an `ai.manage` holder sees: what was spent and whether it worked, never
 * the prompt or the answer — and **never `subjectKind`/`subjectId`**, because
 * `ai.manage` is admin tier while `party.accessAll` is management. They are
 * independent keys, so a subject id here would be a way to enumerate the
 * restricted parties somebody is not allowed to see.
 */
export interface AiRunSummary {
  id: Uuid;
  kind: AiRunKind;
  status: AiRunStatus;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
}

/** A suggested change, per field, for a person to accept or ignore. */
export interface AiProposal {
  entity: 'product' | 'party';
  id: Uuid;
  fields: Array<{ field: string; current: unknown; suggested: unknown; why: string }>;
}

export interface AiStartInput {
  kind: AiRunKind;
  prompt: string;
  /** A record pinned as context — passed as a tool argument, never pasted in. */
  subjectKind?: string | null;
  subjectId?: string | null;
  /** For a vision run: an image already in a product's gallery. */
  imageId?: Uuid | null;
}

/** What the stream carries. One `token` per fragment; one `done` at the end. */
export type AiStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; call: AiToolCall }
  | { type: 'done'; run: AiRun }
  | { type: 'error'; code: string };

/**
 * Whether the assistant is on, and what this machine can actually run.
 *
 * **Always answered, even when off.** A client cannot otherwise tell "switched
 * off" from "this Master is older than the feature" — and both should render
 * the same way, which they can only do if there is an answer to render.
 */
export interface AiStatus {
  enabled: boolean;
  model?: string;
  /** Local as in "on a machine in this building". Decides the timeouts and the cost. */
  local?: boolean;
  /** Whether the model answered a probe with a tool call. */
  supportsTools?: boolean;
  hardware?: AiHardware;
  /** Tokens spent today against `ai.dailyTokenBudget`; absent when local. */
  spentToday?: number;
  budget?: number;
}

export type AiHardwareTier = 'unsupported' | 'marginal' | 'supported';

export interface AiHardware {
  tier: AiHardwareTier;
  totalMemoryGb: number;
  cpus: number;
}

/** One computed observation. The figures are SQL; the sentence is the model's. */
export interface Insight {
  code: InsightCode;
  severity: 'info' | 'warn';
  subjectKind: 'product' | 'party' | 'lead' | 'order' | null;
  subjectId: string | null;
  /** Named numbers, so the card renders with or without a model. */
  figures: Record<string, number | string>;
  /** The model's sentence, or absent — the figures always render either way. */
  note?: string;
}

export type InsightCode =
  'stock.slowMoving' | 'order.unusualSize' | 'lead.overdueFollowUp' | 'dispatch.trend';

export const INSIGHT_CODES: readonly InsightCode[] = [
  'stock.slowMoving',
  'order.unusualSize',
  'lead.overdueFollowUp',
  'dispatch.trend',
];
