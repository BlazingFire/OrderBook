/**
 * The transcript store.
 *
 * Two read rules live here rather than in the service, because they are about
 * the row rather than about the request:
 *
 *  · **You read your own runs.** A prompt is often about one customer, and a
 *    person's questions are not company property to be browsed.
 *  · **`rates_visible` is enforced on read, not only at write time.** Somebody
 *    who has since lost `field.saleRate.view` must not get back a transcript
 *    that quoted rates to them last month.
 *
 * Rows age out on `ai.retentionDays`. That is why the `activity_log` entry
 * beside each run carries figures only: that table is append-only by trigger
 * and is swept by nothing, so anything written there is permanent.
 */

import type { Knex } from 'knex';
import type {
  AiProposal,
  AiRun,
  AiRunKind,
  AiRunStatus,
  AiRunSummary,
  AiToolCall,
} from '@orderbook/shared';

import { db } from '../db/knex.js';

type Runner = Knex | Knex.Transaction;

const TABLE = 'ai_runs';

interface RunRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: string;
  model: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  prompt: string;
  answer: string | null;
  tool_trace: unknown;
  proposal: unknown;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  status: string;
  error_code: string | null;
  latency_ms: number | null;
  rates_visible: boolean;
  created_at: Date;
  finished_at: Date | null;
}

export async function insertRun(
  input: {
    tenantId: string;
    userId: string;
    kind: AiRunKind;
    model: string | null;
    subjectKind: string | null;
    subjectId: string | null;
    prompt: string;
    ratesVisible: boolean;
  },
  runner: Runner = db(),
): Promise<string> {
  const [row] = await runner(TABLE)
    .insert({
      tenant_id: input.tenantId,
      user_id: input.userId,
      kind: input.kind,
      model: input.model,
      subject_kind: input.subjectKind,
      subject_id: input.subjectId,
      prompt: input.prompt,
      rates_visible: input.ratesVisible,
    })
    .returning<Array<{ id: string }>>('id');

  if (!row) throw new Error('ai run insert returned no id');
  return row.id;
}

export async function finishRun(
  tenantId: string,
  id: string,
  outcome: {
    status: AiRunStatus;
    answer?: string | null;
    toolTrace?: AiToolCall[];
    proposal?: AiProposal | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    errorCode?: string | null;
    latencyMs?: number | null;
  },
  runner: Runner = db(),
): Promise<void> {
  await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      status: outcome.status,
      answer: outcome.answer ?? null,
      ...(outcome.toolTrace ? { tool_trace: JSON.stringify(outcome.toolTrace) } : {}),
      ...(outcome.proposal !== undefined
        ? { proposal: outcome.proposal ? JSON.stringify(outcome.proposal) : null }
        : {}),
      prompt_tokens: outcome.promptTokens ?? null,
      completion_tokens: outcome.completionTokens ?? null,
      error_code: outcome.errorCode ?? null,
      latency_ms: outcome.latencyMs ?? null,
      finished_at: runner.fn.now(),
    });
}

export async function findRun(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<AiRun | null> {
  const row = await runner(TABLE).where({ tenant_id: tenantId, id }).first<RunRow | undefined>();
  return row ? mapRun(row) : null;
}

/** Who a run belongs to, and what it needed to see — the read gate's inputs. */
export async function findRunOwnership(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<{ userId: string; ratesVisible: boolean } | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .first<{ user_id: string; rates_visible: boolean } | undefined>('user_id', 'rates_visible');

  return row ? { userId: row.user_id, ratesVisible: row.rates_visible } : null;
}

export async function listOwnRuns(
  tenantId: string,
  userId: string,
  limit = 30,
  runner: Runner = db(),
): Promise<AiRun[]> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, user_id: userId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select<RunRow[]>('*');

  return rows.map(mapRun);
}

/**
 * Everybody's runs, as figures.
 *
 * No prompt, no answer, and **no subject** — `ai.manage` is an admin key while
 * `party.accessAll` is a management one, so they are independent. A subject id
 * here would be a way for an administrator without party access to enumerate
 * the restricted parties they are not allowed to see.
 */
export async function listRunSummaries(
  tenantId: string,
  limit = 100,
  runner: Runner = db(),
): Promise<AiRunSummary[]> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select<RunRow[]>(
      'id',
      'kind',
      'status',
      'model',
      'prompt_tokens',
      'completion_tokens',
      'created_at',
      'finished_at',
    );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as AiRunKind,
    status: row.status as AiRunStatus,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  }));
}

/** Tokens spent today, for the daily budget. */
export async function tokensSpentToday(tenantId: string, runner: Runner = db()): Promise<number> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .where('created_at', '>=', runner.raw("date_trunc('day', now())"))
    .sum<{ total: string | null }>(
      runner.raw('COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) as total'),
    )
    .first();

  return Number(row?.total ?? 0);
}

export async function markApplied(
  tenantId: string,
  id: string,
  appliedBy: string,
  runner: Runner = db(),
): Promise<void> {
  await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({ applied_at: runner.fn.now(), applied_by: appliedBy });
}

/**
 * Delete transcripts older than the retention window.
 *
 * Returns how many went, so the sweep can say so in the log rather than being
 * a silent timer somebody has to trust.
 */
export async function purgeOlderThan(days: number, runner: Runner = db()): Promise<number> {
  if (days <= 0) return 0;
  return runner(TABLE)
    .where('created_at', '<', runner.raw(`now() - interval '${Math.floor(days)} days'`))
    .del();
}

/** Anything still `running` when the process restarted was killed with it. */
export async function failStaleRuns(runner: Runner = db()): Promise<number> {
  return runner(TABLE)
    .where({ status: 'running' })
    .update({ status: 'failed', error_code: 'error.ai.interrupted', finished_at: runner.fn.now() });
}

function mapRun(row: RunRow): AiRun {
  return {
    id: row.id,
    kind: row.kind as AiRunKind,
    status: row.status as AiRunStatus,
    model: row.model,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    prompt: row.prompt,
    answer: row.answer,
    toolTrace: Array.isArray(row.tool_trace) ? (row.tool_trace as AiToolCall[]) : [],
    proposal: (row.proposal as AiProposal | null) ?? null,
    ratesVisible: row.rates_visible,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    errorCode: row.error_code,
    latencyMs: row.latency_ms,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}
