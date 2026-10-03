/**
 * The Master's push gate: every `sync:push` is applied through here (rule 6,
 * docs/LEAD_GENERATION_FLOW.md §7).
 *
 * Pushes queue in one FIFO, one entry per push. The gate waits a short gather
 * window, takes everything queued, sorts all of it with
 * `compareForIdAssignment` (HLC, then device code, then mutation id) and
 * applies it one mutation at a time. So:
 *
 *  - creates from panels that push together are numbered in HLC order, not in
 *    arrival order. The order holds within one gather window only: a panel
 *    that pushes later is numbered later, and minted ids never move;
 *  - at most one mutation is being applied, so at most one pooled connection
 *    holds `applyOne`'s advisory lock while the services it calls take
 *    others. Ten panels pushing at once used to hold all ten connections and
 *    wait on each other for an eleventh (`TimeoutAcquiringConnection`).
 *
 * Gather windows, from the oldest queued push: 100 ms when a push carries a
 * live `*.create`, 6 s when it carries a `*.create` whose HLC is more than
 * 10 s old (an offline backlog, so panels coming back together sort as one),
 * and until 5 s after the Master started (panels reconnecting after a Master
 * restart). Anything else drains on the next tick.
 *
 * The backlog window is given once per connection, and only in the first
 * minute after the panel's socket connected. The Office sends its backlog in
 * batches of 100, each after the last one's answer, so later batches drain at
 * once behind the first. And a live create from a PC whose clock is behind
 * the Master's also looks more than 10 s old; this keeps it from paying 6 s,
 * and holding every other panel's push for 6 s, on each save.
 *
 * A push from a panel that already has a push waiting here (not yet started)
 * is merged into it, so a 1.2 Office's 15 s ack retry never queues the same
 * outbox twice. Each caller still gets its own answer.
 *
 * ponytail: one gate for every tenant. This is a one-company LAN product at
 * tens of mutations a second; per-tenant lanes are the upgrade path.
 * ponytail: a large backlog is applied whole, so another panel's live save
 * waits behind it for a few seconds. Round-robin slices across the group's
 * entries are the upgrade path if that wait is ever visible.
 */

import type { Mutation, MutationResult } from '@orderbook/shared';
import { compareForIdAssignment, parseHlc } from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('push-gate');

/** Work to run once a mutation's result is committed: `publishConflict`, `notify`. */
export type PostCommit = () => unknown;

/** Applies one mutation; pushes post-commit work onto `afterCommit`. */
export type ApplyMutation = (
  mutation: Mutation,
  actor: ActorContext,
  afterCommit: PostCommit[],
) => Promise<MutationResult>;

interface Entry {
  key: string;
  actor: ActorContext;
  apply: ApplyMutation;
  /** Every mutation of every push merged into this entry, once each. */
  mutations: Map<string, Mutation>;
  arrivedAt: number;
  gatherMs: number;
  waiters: Array<{ resolve(results: Map<string, MutationResult>): void; reject(error: unknown): void }>;
  results: Map<string, MutationResult>;
  failed: boolean;
  error: unknown;
}

/** A create stamped longer ago than this is an offline backlog, not a live save. */
const BACKLOG_AGE_MS = 10_000;
/** A backlog arrives right after the panel connects; later old creates are a slow clock. */
const BACKLOG_AFTER_CONNECT_MS = 60_000;

let windows = { windowMs: 100, backlogMs: 6_000, bootMs: 5_000 };
let bootAt = Date.now();
let queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
/**
 * Per push key, the connection that has had its backlog window. One entry per
 * panel and person, overwritten on reconnect, so it stays small.
 */
const backlogGiven = new Map<string, number>();

/** Tests set every window to 0 so a push applies on the next tick. */
export function configurePushGate(next: Partial<typeof windows>): void {
  windows = { ...windows, ...next };
}

/** Empties the gate and restarts the boot window from now. Only between tests. */
export function __resetGateForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queue = [];
  draining = false;
  backlogGiven.clear();
  bootAt = Date.now();
}

/**
 * Queue one push and resolve with a result for each of its mutation ids once
 * its group has been applied. Rejects, with nothing after the failure applied
 * or recorded, when one of its mutations throws (a retryable database error);
 * the panel retries the push.
 */
export function runPush(
  actor: ActorContext,
  mutations: readonly Mutation[],
  apply: ApplyMutation,
  connectedAt?: number,
): Promise<Map<string, MutationResult>> {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const key = [actor.tenantId, actor.actorType, actor.actorId, actor.userId, actor.deviceCode].join('|');
    const waiter = { resolve, reject };
    // A caller without a socket (a test) is judged by the HLC alone.
    const mayBeBacklog =
      connectedAt === undefined ||
      (now - connectedAt < BACKLOG_AFTER_CONNECT_MS && backlogGiven.get(key) !== connectedAt);
    const gatherMs = gatherMsFor(mutations, now, mayBeBacklog);
    if (connectedAt !== undefined && gatherMs === windows.backlogMs && gatherMs > 0) {
      backlogGiven.set(key, connectedAt);
    }

    // Everything queued is unstarted: a drain takes the whole queue at once.
    const pending = queue.find((entry) => entry.key === key);
    if (pending) {
      addAll(pending.mutations, mutations);
      // The newer push's actor is the fresher read of this person's permissions.
      pending.actor = actor;
      pending.gatherMs = Math.max(pending.gatherMs, gatherMs);
      pending.waiters.push(waiter);
    } else {
      queue.push({
        key,
        actor,
        apply,
        mutations: addAll(new Map(), mutations),
        arrivedAt: now,
        gatherMs,
        waiters: [waiter],
        results: new Map(),
        failed: false,
        error: undefined,
      });
    }

    schedule();
  });
}

function addAll(into: Map<string, Mutation>, mutations: readonly Mutation[]): Map<string, Mutation> {
  for (const mutation of mutations) {
    if (!into.has(mutation.mutationId)) into.set(mutation.mutationId, mutation);
  }
  return into;
}

function gatherMsFor(mutations: readonly Mutation[], now: number, mayBeBacklog: boolean): number {
  let ms = 0;
  for (const mutation of mutations) {
    if (!mutation.kind.endsWith('.create')) continue;
    const backlog = mayBeBacklog && isBacklog(mutation.hlc, now);
    ms = Math.max(ms, backlog ? windows.backlogMs : windows.windowMs);
  }
  return ms;
}

function isBacklog(hlc: string, now: number): boolean {
  try {
    return now - parseHlc(hlc).physical > BACKLOG_AGE_MS;
  } catch {
    // A malformed clock is refused when it is applied; it is not a backlog.
    return false;
  }
}

function schedule(): void {
  if (draining || queue.length === 0) return;
  // Measured from the oldest push, so a stream of live saves cannot keep
  // stretching the window: the longest wait is the backlog window.
  const gather = Math.max(...queue.map((entry) => entry.gatherMs));
  const deadline = Math.max(queue[0]!.arrivedAt + gather, bootAt + windows.bootMs);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, Math.max(0, deadline - Date.now()));
}

async function drain(): Promise<void> {
  draining = true;
  const group = queue;
  queue = [];
  try {
    await applyGroup(group);
  } finally {
    draining = false;
    schedule();
  }
}

async function applyGroup(group: Entry[]): Promise<void> {
  const items = group.flatMap((entry) =>
    [...entry.mutations.values()].map((mutation) => ({ entry, mutation })),
  );
  items.sort((a, b) => compareForIdAssignment(a.mutation, b.mutation));

  for (const { entry, mutation } of items) {
    // A failed push's later mutations are skipped and not recorded, so an
    // update that depends on a create that failed is retried with it rather
    // than refused for a record that does not exist yet.
    if (entry.failed) continue;
    const afterCommit: PostCommit[] = [];
    try {
      entry.results.set(mutation.mutationId, await entry.apply(mutation, entry.actor, afterCommit));
    } catch (error) {
      entry.failed = true;
      entry.error = error;
      continue;
    }
    for (const hook of afterCommit) {
      try {
        await hook();
      } catch (error) {
        // The mutation is committed; a lost notice must not fail the push.
        log.warn(`Post-commit work for ${mutation.mutationId} failed: ${toErrorMessage(error)}`);
      }
    }
  }

  for (const entry of group) {
    for (const waiter of entry.waiters) {
      if (entry.failed) waiter.reject(entry.error);
      else waiter.resolve(entry.results);
    }
  }
}
