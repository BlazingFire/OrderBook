/**
 * Running the assistant: one question, up to eight tool calls, one answer.
 *
 * Every provider call originates here, in the Master process. That is what
 * keeps a cloud key out of two browser bundles and off every shop PC, and it is
 * what lets retrieval be *literally the same code* as any other read —
 * `leadService.getLead` already scopes and masks, so the assistant inherits
 * both without knowing they exist.
 *
 * **A run requires a signed-in person.** An unattended Office panel resolves to
 * `actorType: 'office_panel'` with `userId: null`, and `ai_runs.user_id` is the
 * entire read rule — a run with no owner is a transcript nobody can be
 * responsible for. `startRun` refuses it.
 *
 * **The answer streams; the ack does not wait for it.** `ai:start` is acked the
 * moment the row exists and the request is away, because `MasterConnection`
 * hard-fails a command after fifteen seconds and would report the Master
 * offline while the model was still typing.
 *
 * **Audit carries figures, never text.** One `activity_log` entry per run,
 * through `recordDetachedActivity` — a run has no transaction to be atomic
 * with. `activity_log` is append-only by trigger and is swept by nothing, so
 * the prompt lives in `ai_runs`, which ages out, and the entry beside it names
 * only what was spent.
 */

import type {
  AiProposal,
  AiRun,
  AiRunKind,
  AiStartInput,
  AiStatus,
  AiStreamEvent,
  AiToolCall,
} from '@orderbook/shared';

import { AI_TOOLS, isAiToolName, type AiToolName } from '../ai/tools.js';
import { hardwareFacts } from '../ai/hardware.js';
import { systemPrompt, toolEnvelope } from '../ai/prompt.js';
import {
  chat,
  probe,
  ProviderError,
  type ChatMessage,
  type ChatToolDeclaration,
} from '../ai/openai-compatible.js';
import { actorCan, actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { getMemoryStatus } from '../lib/memory-monitor.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as aiRunRepo from '../repositories/ai-run.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as catalogService from './catalog.service.js';
import { getSetting } from './settings.service.js';

const log = createLogger('ai');

/** Enough steps to look something up and check it; not enough to wander. */
const MAX_TOOL_CALLS = 8;
/** A whole run, from first byte to last. */
const RUN_TIMEOUT_MS = 180_000;

/** Live runs, so a cancel — or a dropped socket — can abort one. */
const running = new Map<string, AbortController>();

/** Concurrent run counter — refused when over the limit or under memory pressure. */
let activeRunCount = 0;

async function checkCanStartRun(tenantId: string): Promise<void> {
  const maxConcurrent = await getSetting(tenantId, 'ai.maxConcurrentRuns');
  if (activeRunCount >= maxConcurrent) {
    throw new ValidationError('error.ai.tooManyConcurrent');
  }

  const mem = getMemoryStatus();
  if (mem.isOverCap) {
    log.warn(
      `AI run refused: memory over cap (RSS ${mem.rssMb}MB > ${mem.capMb}MB)`,
    );
    throw new ValidationError('error.ai.memoryPressure');
  }

  activeRunCount++;
}

function releaseRunSlot(): void {
  activeRunCount = Math.max(0, activeRunCount - 1);
}

/**
 * Where a run's events go.
 *
 * The transports subscribe; this module never knows what they are. The owner
 * travels beside the payload because every transport has to filter on it — a
 * run is one person's question, and the socket room it rides is shared.
 */
export interface AiEventEnvelope {
  runId: string;
  userId: string;
  payload: AiStreamEvent;
}

type Sink = (event: AiEventEnvelope) => void;
const sinks = new Set<Sink>();

export function onAiEvent(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(runId: string, event: AiStreamEvent): void {
  const userId = ownerOf.get(runId);
  if (!userId) return;

  for (const sink of sinks) {
    try {
      sink({ runId, userId, payload: event });
    } catch (error) {
      // One broken transport must not kill a run for everybody else.
      log.warn(`AI event sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * How this installation reaches a model, if it does.
 *
 * `local` is decided from the address rather than stored: a model on this
 * machine or on the shop LAN costs nothing and can be waited for, and one
 * across the internet is billed and should not be. Deriving it means there is
 * no second setting to contradict the first.
 */
async function providerFor(tenantId: string): Promise<{
  baseUrl: string;
  model: string;
  apiKey: string;
  local: boolean;
} | null> {
  const provider = await getSetting(tenantId, 'ai.provider');
  if (provider.kind !== 'openaiCompatible') return null;
  if (!provider.baseUrl?.trim() || !provider.model?.trim()) return null;

  let host = '';
  try {
    host = new URL(provider.baseUrl).hostname;
  } catch {
    return null;
  }

  const local =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  return {
    baseUrl: provider.baseUrl.trim(),
    model: provider.model.trim(),
    apiKey: await getSetting(tenantId, 'ai.apiKey'),
    local,
  };
}

/**
 * Always answers, even when off.
 *
 * A client cannot otherwise tell "the assistant is switched off" from "this
 * Master is older than the assistant" — and both should render the same way,
 * which is only possible if there is something to render.
 */
export async function status(actor: ActorContext): Promise<AiStatus> {
  const provider = await providerFor(actor.tenantId);
  if (!provider) return { enabled: false };

  const budget = await getSetting(actor.tenantId, 'ai.dailyTokenBudget');

  return {
    enabled: true,
    model: provider.model,
    local: provider.local,
    hardware: hardwareFacts(),
    ...(budget > 0 ? { budget, spentToday: await aiRunRepo.tokensSpentToday(actor.tenantId) } : {}),
  };
}

/**
 * Delete transcripts past their retention window, for every tenant.
 *
 * Run from a timer rather than on read: a promise that a question is kept for
 * ninety days is a promise it is *gone* on the ninety-first, whether or not
 * anybody opens the screen.
 */
export async function sweepExpiredAiRuns(): Promise<number> {
  const tenants = await db()('tenants').pluck<string[]>('id');

  let removed = 0;
  for (const tenantId of tenants) {
    const days = await getSetting(tenantId, 'ai.retentionDays');
    removed += await aiRunRepo.purgeOlderThan(days);
  }

  if (removed > 0) log.info(`Swept ${removed} expired AI transcript(s)`);
  return removed;
}

/** A run still marked `running` at boot belonged to a process that is gone. */
export async function failStaleAiRuns(): Promise<number> {
  return aiRunRepo.failStaleRuns();
}

/** The Test button: one short generation, with one trivial tool declared. */
export async function testProvider(actor: ActorContext): Promise<{
  ok: boolean;
  supportsTools: boolean;
  model: string;
  error?: string;
}> {
  requirePermission(actor, 'ai.manage');

  const provider = await providerFor(actor.tenantId);
  if (!provider)
    return { ok: false, supportsTools: false, model: '', error: 'error.ai.notConfigured' };

  return probe({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || undefined,
    model: provider.model,
  });
}

export async function listOwnRuns(actor: ActorContext): Promise<AiRun[]> {
  requirePermission(actor, 'ai.use');

  const userId = actorUserId(actor);
  if (!userId) return [];

  const runs = await aiRunRepo.listOwnRuns(actor.tenantId, userId);
  // A transcript that quoted rates is withheld from an author who has since
  // lost the right to see them — the run's own record of what it showed is
  // what makes that decidable.
  return runs.filter((run) => !ratesWithheld(run, actor));
}

export async function getRun(actor: ActorContext, id: string): Promise<AiRun> {
  requirePermission(actor, 'ai.use');

  const ownership = await aiRunRepo.findRunOwnership(actor.tenantId, id);
  if (!ownership) throw new NotFoundError('Run');
  if (ownership.userId !== actorUserId(actor)) throw new ForbiddenError('ai.use');

  const run = await aiRunRepo.findRun(actor.tenantId, id);
  if (!run) throw new NotFoundError('Run');
  if (ratesWithheld(run, actor)) throw new ForbiddenError('field.saleRate.view');

  return run;
}

/**
 * Whether this transcript is withheld from this reader.
 *
 * Decided from the run's own `ratesVisible`, recorded when it was made — a
 * transcript written for somebody who could see rates may quote them, and the
 * question is whether they still can.
 */
function ratesWithheld(run: AiRun, actor: ActorContext): boolean {
  return run.ratesVisible && !actorCan(actor, 'field.saleRate.view');
}

export async function cancelRun(actor: ActorContext, runId: string): Promise<void> {
  const ownership = await aiRunRepo.findRunOwnership(actor.tenantId, runId);
  if (!ownership) throw new NotFoundError('Run');
  if (ownership.userId !== actorUserId(actor)) throw new ForbiddenError('ai.use');

  abortRun(runId);
}

/** Also called by the socket layer when the person watching a run disconnects. */
export function abortRun(runId: string): void {
  running.get(runId)?.abort();
  running.delete(runId);
}

/** Every run this user owns, for a disconnect. */
const ownerOf = new Map<string, string>();

export function abortRunsOf(userId: string): void {
  for (const [runId, owner] of ownerOf) {
    if (owner === userId) abortRun(runId);
  }
}

/**
 * Start a run and return its id immediately.
 *
 * The generation continues in the background and reaches the caller as events.
 * Awaiting it here is what would make an Office panel report the Master
 * unreachable fifteen seconds into a perfectly healthy answer.
 */
export async function startRun(
  actor: ActorContext,
  input: AiStartInput,
): Promise<{ runId: string }> {
  requirePermission(actor, 'ai.use');

  const userId = actorUserId(actor);
  // An unattended panel has no signed-in person, and a transcript with no owner
  // is one nobody can be responsible for or read back.
  if (!userId) throw new ForbiddenError('ai.use');

  const provider = await providerFor(actor.tenantId);
  if (!provider) throw new ValidationError('validation.ai.notConfigured');

  const prompt = input.prompt?.trim();
  if (!prompt) throw new ValidationError('validation.ai.promptRequired');

  await checkCanStartRun(actor.tenantId);

  const budget = await getSetting(actor.tenantId, 'ai.dailyTokenBudget');
  // The budget guards a bill, so it does not apply to a model running in the
  // building — there is nothing there to spend.
  if (!provider.local && budget > 0) {
    const spent = await aiRunRepo.tokensSpentToday(actor.tenantId);
    if (spent >= budget) throw new ValidationError('validation.ai.budgetSpent');
  }

  const runId = await aiRunRepo.insertRun({
    tenantId: actor.tenantId,
    userId,
    kind: input.kind,
    model: provider.model,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    prompt,
    ratesVisible: actorCan(actor, 'field.saleRate.view'),
  });

  const controller = new AbortController();
  running.set(runId, controller);
  ownerOf.set(runId, userId);

  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  timeout.unref?.();

  void generate(runId, actor, input, prompt, provider, controller)
    .catch((error: unknown) => {
      log.warn(`AI run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      clearTimeout(timeout);
      running.delete(runId);
      ownerOf.delete(runId);
      releaseRunSlot();
    });

  return { runId };
}

async function generate(
  runId: string,
  actor: ActorContext,
  input: AiStartInput,
  prompt: string,
  provider: { baseUrl: string; model: string; apiKey: string; local: boolean },
  controller: AbortController,
): Promise<void> {
  const started = Date.now();
  const trace: AiToolCall[] = [];
  let answer = '';
  let promptTokens = 0;
  let completionTokens = 0;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input.kind) },
    { role: 'user', content: await withSubject(actor, input, prompt) },
  ];

  const tools = declarations(actor);

  try {
    for (let step = 0; step <= MAX_TOOL_CALLS; step += 1) {
      let calls: Array<{ id: string; name: string; arguments: string }> = [];

      for await (const chunk of chat({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey || undefined,
        model: provider.model,
        messages,
        tools: step < MAX_TOOL_CALLS ? tools : undefined,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text') {
          answer += chunk.text;
          emit(runId, { type: 'token', text: chunk.text });
        } else if (chunk.type === 'usage') {
          promptTokens += chunk.promptTokens;
          completionTokens += chunk.completionTokens;
        } else {
          calls = chunk.calls;
        }
      }

      if (calls.length === 0) break;

      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of calls) {
        const result = await runTool(call, actor);
        trace.push(result.trace);
        emit(runId, { type: 'tool', call: result.trace });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: toolEnvelope(call.name, result.value),
        });
      }
    }

    await aiRunRepo.finishRun(actor.tenantId, runId, {
      status: 'done',
      answer,
      toolTrace: trace,
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - started,
    });

    await recordRun(actor, runId, input.kind, provider.model, promptTokens, completionTokens);

    const run = await aiRunRepo.findRun(actor.tenantId, runId);
    if (run) emit(runId, { type: 'done', run });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const code =
      error instanceof ProviderError
        ? error.code
        : cancelled
          ? 'error.ai.cancelled'
          : 'error.ai.failed';

    await aiRunRepo.finishRun(actor.tenantId, runId, {
      status: cancelled ? 'cancelled' : 'failed',
      answer: answer || null,
      toolTrace: trace,
      promptTokens,
      completionTokens,
      errorCode: code,
      latencyMs: Date.now() - started,
    });

    await recordRun(actor, runId, input.kind, provider.model, promptTokens, completionTokens);
    emit(runId, { type: 'error', code });
  }
}

/**
 * The record that outlives the transcript.
 *
 * Figures only. `activity_log` refuses UPDATE and DELETE by trigger and is not
 * swept by the retention setting, so a prompt written here would be permanent
 * and readable by every `logs.view` holder — while the prompt in `ai_runs`
 * ages out as promised.
 */
async function recordRun(
  actor: ActorContext,
  runId: string,
  kind: AiRunKind,
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'ai_run',
      entityId: runId,
      action: kind === 'draft' ? 'drafted' : 'asked',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { runId, kind, model, promptTokens, completionTokens },
    },
    actor,
    db(),
  );
}

/** A pinned record becomes a tool argument, never pasted text. */
async function withSubject(
  actor: ActorContext,
  input: AiStartInput,
  prompt: string,
): Promise<string> {
  if (!input.subjectKind || !input.subjectId) return prompt;

  return [
    prompt,
    '',
    `The person is looking at a ${input.subjectKind} with id ${input.subjectId}.`,
    'Fetch it with the appropriate tool rather than assuming anything about it.',
  ].join('\n');
}

/** Only the tools this caller could use anyway. */
function declarations(actor: ActorContext): ChatToolDeclaration[] {
  return (Object.entries(AI_TOOLS) as Array<[AiToolName, (typeof AI_TOOLS)[AiToolName]]>)
    .filter(([, tool]) => actorCan(actor, tool.permission))
    .map(([name, tool]) => ({
      type: 'function' as const,
      function: { name, description: tool.description, parameters: tool.schema },
    }));
}

async function runTool(
  call: { name: string; arguments: string },
  actor: ActorContext,
): Promise<{ trace: AiToolCall; value: unknown }> {
  const started = Date.now();

  if (!isAiToolName(call.name)) {
    return {
      trace: { tool: call.name, arguments: {}, resultCount: 0, ms: 0 },
      value: { error: 'No such tool' },
    };
  }

  const tool = AI_TOOLS[call.name];

  let parsed: Record<string, unknown> = {};
  try {
    const raw: unknown = call.arguments ? JSON.parse(call.arguments) : {};
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // A model that produced invalid JSON gets told so and can try again; it is
    // not a reason to fail the run.
    return {
      trace: { tool: call.name, arguments: {}, resultCount: 0, ms: Date.now() - started },
      value: { error: 'Arguments were not valid JSON' },
    };
  }

  // Checked here as well as in the service underneath. The service is the real
  // gate; this one keeps a refused call from costing a database round trip.
  if (!actorCan(actor, tool.permission)) {
    return {
      trace: { tool: call.name, arguments: parsed, resultCount: 0, ms: Date.now() - started },
      value: { error: `Not permitted: ${tool.permission}` },
    };
  }

  try {
    const value = await tool.run(parsed, actor);
    return {
      trace: {
        tool: call.name,
        arguments: parsed,
        resultCount: countRows(value),
        ms: Date.now() - started,
      },
      value,
    };
  } catch (error) {
    return {
      trace: { tool: call.name, arguments: parsed, resultCount: 0, ms: Date.now() - started },
      // The message, not the stack: this goes into the model's context and then
      // into a transcript a person reads.
      value: { error: error instanceof Error ? error.message : 'The tool failed' },
    };
  }
}

function countRows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    return (value as { items: unknown[] }).items.length;
  }
  return value === null || value === undefined ? 0 : 1;
}

/**
 * Apply the fields a person ticked on a proposal.
 *
 * Four gates stand in front of one applied field, and they are four different
 * questions: is the assistant configured at all, does this installation allow
 * it to write, does this person hold `ai.write`, and may they edit this kind of
 * record. The click is the fifth.
 *
 * The merge is over a **fresh unmasked read**, and the version is re-read and
 * compared afterwards. That compare is the honest ceiling, said plainly: the
 * product's update path increments `version` unconditionally and takes no
 * expected version, so this is last-write-wins with a cheap check, not
 * optimistic concurrency.
 */
export async function applyProposal(
  actor: ActorContext,
  runId: string,
  fields: string[],
): Promise<void> {
  requirePermission(actor, 'ai.write');

  if (!(await getSetting(actor.tenantId, 'ai.allowWrites'))) {
    throw new ForbiddenError('ai.write');
  }

  const run = await aiRunRepo.findRun(actor.tenantId, runId);
  if (!run?.proposal) throw new NotFoundError('Proposal');

  const ownership = await aiRunRepo.findRunOwnership(actor.tenantId, runId);
  if (ownership?.userId !== actorUserId(actor)) throw new ForbiddenError('ai.use');

  const proposal: AiProposal = run.proposal;
  // Only fields the stored proposal actually offered: the submitted list is
  // client input, and a field it invented would otherwise be written verbatim.
  const accepted = proposal.fields.filter((field) => fields.includes(field.field));
  if (accepted.length === 0) throw new ValidationError('validation.ai.nothingAccepted');

  const before = await readRecord(actor, proposal);
  if (!before) throw new NotFoundError(proposal.entity === 'party' ? 'Party' : 'Product');

  const merged: Record<string, unknown> = { ...(before as unknown as Record<string, unknown>) };
  for (const field of accepted) merged[field.field] = field.suggested;

  if (proposal.entity === 'party') {
    await catalogService.updateParty(proposal.id, merged as never, actor);
  } else {
    await catalogService.updateProduct(proposal.id, merged as never, actor);
  }

  const after = await readRecord(actor, proposal);
  const beforeVersion = (before as unknown as { version?: number }).version;
  const afterVersion = (after as unknown as { version?: number }).version;
  if (
    beforeVersion !== undefined &&
    afterVersion !== undefined &&
    afterVersion !== beforeVersion + 1
  ) {
    log.warn(`Proposal ${runId} applied over a record that moved under it`);
  }

  await aiRunRepo.markApplied(actor.tenantId, runId, actorUserId(actor) ?? '');
  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'ai_run',
      entityId: runId,
      action: 'applied',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { runId, fields: accepted.map((field) => field.field) },
    },
    actor,
    db(),
  );
}

async function readRecord(actor: ActorContext, proposal: AiProposal): Promise<unknown> {
  // Unmasked, exactly as the public API's PATCH does: a masked read drops a
  // field by key absence, and merging over that would write it away.
  return proposal.entity === 'party'
    ? partyRepo.findPartyById(actor.tenantId, proposal.id)
    : productRepo.findProductById(actor.tenantId, proposal.id);
}
