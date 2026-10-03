/**
 * Draining the outbox to the Master (docs/LEAD_GENERATION_FLOW.md §4, §7).
 *
 * The panel accepts work whether or not the Master is reachable; this is the
 * half that catches it up. It runs on every reconnect, after every local save,
 * and on a retry timer while anything is still queued.
 *
 * Flushes are serialised. Two overlapping pushes would send the same mutations
 * twice — the Master would recognise them and answer `duplicate`, so nothing
 * would break, but the panel would then be settling a queue it was concurrently
 * rewriting, which is a much harder thing to reason about than a lock.
 */

import type { Mutation, MutationResult, SyncPushResponse } from '@orderbook/shared';
import { EventEmitter } from 'node:events';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { observe } from './clock.js';
import { holdNumbered } from './local-store.js';
import * as outbox from './outbox.store.js';

const log = createLogger('sync');

export interface FlushOutcome {
  pushed: number;
  applied: number;
  merged: number;
  rejected: number;
  /** Mutations the Master refused, kept so the UI can explain what was lost. */
  rejections: MutationResult[];
  remaining: number;
}

/** Injected by the master connection, so this module owns no transport. */
export type PushTransport = (mutations: Mutation[]) => Promise<SyncPushResponse>;

/** What the Master said about one mutation, for a save that waited to hear it. */
export interface SettledMutation {
  result: MutationResult;
  /** The record's id now: the permanent one once the Master has assigned it. */
  permanentId: string;
  /** The pending-order number, for an accepted `lead.create` on a Master that mints one. */
  poNumber?: string;
}

/** A pending order this panel queued now has its permanent id (and number). */
export interface NumberedEvent {
  entity: 'lead';
  temporaryId: string;
  permanentId: string;
  poNumber?: string;
  /** True when the save was still waiting, so its own answer already carried the number. */
  announced: boolean;
  /** Who saved it, so only that person is told the number. */
  forUserId: string | null;
}

const events = new EventEmitter();

let transport: PushTransport | null = null;
let flushing = false;
/** Set when a flush was asked for while one was running, so it runs straight after. */
let rerun = false;
let retryTimer: NodeJS.Timeout | null = null;

/** One save waiting for its mutation's answer, by mutation id. */
const waiters = new Map<string, (settled: SettledMutation) => void>();

/**
 * The last few answers, by mutation id, for a waiter that registers after the
 * answer already came back. A push can beat the caller to `awaitSettled`
 * because `submit` starts the flush before it returns.
 */
const recentlySettled = new Map<string, SettledMutation>();
const RECENTLY_SETTLED_LIMIT = 200;

export function setTransport(next: PushTransport | null): void {
  transport = next;
}

export function onSyncEvent(listener: () => void): () => void {
  events.on('changed', listener);
  return () => events.off('changed', listener);
}

/**
 * Every refusal this panel has been told about and nobody has cleared.
 *
 * Read from disk rather than from memory, so it survives a restart and is not
 * overwritten by the next flush — see `outbox.store.ts`'s `recordRefusals`.
 */
export async function recentRejections(): Promise<MutationResult[]> {
  return (await outbox.refusals()).map((entry) => entry.result);
}

/**
 * Wait for the Master's answer to one queued mutation.
 *
 * Resolves with the answer once a push carrying it comes back, or with null
 * after `timeoutMs` (offline, a slow Master, a full gate). Never rejects: a
 * caller that hears nothing in time treats the save as Provisional, and the
 * mutation stays in the outbox either way.
 */
export function awaitSettled(mutationId: string, timeoutMs: number): Promise<SettledMutation | null> {
  const done = recentlySettled.get(mutationId);
  if (done) return Promise.resolve(done);

  return new Promise((resolve) => {
    const finish = (settled: SettledMutation | null): void => {
      clearTimeout(timer);
      if (waiters.get(mutationId) === finish) waiters.delete(mutationId);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    waiters.set(mutationId, finish);
  });
}

/** Told whenever a pending order queued here receives its permanent id. */
export function onNumbered(listener: (event: NumberedEvent) => void): () => void {
  events.on('numbered', listener);
  return () => events.off('numbered', listener);
}

/** Called once the panel's UI has actually shown them to somebody. */
export async function acknowledgeRejections(mutationIds?: string[]): Promise<void> {
  await outbox.clearRefusals(mutationIds);
}

/**
 * Push everything queued.
 *
 * Returns a summary rather than throwing on a failed push: being unable to
 * reach the Master is the normal condition this whole mechanism exists for, not
 * an error worth propagating to a caller who just saved a lead.
 */
export async function flush(): Promise<FlushOutcome> {
  const idle: FlushOutcome = {
    pushed: 0,
    applied: 0,
    merged: 0,
    rejected: 0,
    rejections: [],
    remaining: await outbox.pendingCount(),
  };

  if (flushing) {
    // Something was queued after the running flush took its batch. Without
    // this it would wait for the retry timer, which is as long as a save waits
    // for its number, so that save would always time out to Provisional.
    rerun = true;
    return idle;
  }
  if (!transport) return idle;
  if (idle.remaining === 0) return idle;

  flushing = true;

  try {
    const queued = await outbox.pending();
    const batch = queued.slice(0, config.sync.batchSize);

    const response = await transport(batch);

    // Fold the Master's clock in first: everything this panel stamps from now
    // on must sort after what the Master has just told us it knows.
    if (response.serverHlc) await observe(response.serverHlc);

    const mapping = new Map(
      response.idMappings.map((entry) => [entry.temporaryId, entry.permanentId]),
    );

    const byId = new Map(batch.map((mutation) => [mutation.mutationId, mutation]));
    const answers = response.results.map((result) => {
      const mutation = byId.get(result.mutationId);
      const settled: SettledMutation = {
        result,
        permanentId: (mutation && mapping.get(mutation.entityId)) ?? result.entityId,
        ...(result.number ? { poNumber: result.number } : {}),
      };
      return { mutation, settled };
    });

    // Before the queue entry goes: the local view draws a queued lead from it,
    // and the permanent record may not have reached this panel yet.
    for (const { mutation, settled } of answers) {
      if (isNumbering(mutation, settled)) holdNumbered(mutation, settled.permanentId, settled.poNumber);
    }

    // Remap before settling: a queued follow-up ("move lead X to Quoted") has to
    // learn X's permanent id, and it is still in the queue at this point.
    await outbox.remapIds(mapping);
    await outbox.settle(response.results.map((result) => result.mutationId));

    for (const { mutation, settled } of answers) {
      const waiter = waiters.get(settled.result.mutationId);
      remember(settled);
      waiter?.(settled);
      if (isNumbering(mutation, settled)) {
        const event: NumberedEvent = {
          entity: 'lead',
          temporaryId: mutation.entityId,
          permanentId: settled.permanentId,
          ...(settled.poNumber ? { poNumber: settled.poNumber } : {}),
          announced: waiter !== undefined,
          forUserId: mutation.actorUserId ?? null,
        };
        events.emit('numbered', event);
      }
    }

    const rejections = response.results.filter((result) => result.status === 'rejected');

    /*
     * Durable, not a module variable.
     *
     * `lastRejections = rejections` ran on every successful flush including
     * empty ones, so with a batch size of 100 a 500-row push kept the last
     * batch's refusals and dropped the other four — and a restart dropped all
     * of them. The queue entry was already gone by then (a refusal is recorded
     * permanently on the Master, so re-pushing earns the same answer), and the
     * optimistic record was derived from that queue entry, so the person's work
     * disappeared with nothing anywhere to say it had.
     */
    if (rejections.length > 0) {
      const refusedAt = new Date().toISOString();
      await outbox.recordRefusals(
        rejections.flatMap((result) => {
          const mutation = byId.get(result.mutationId);
          return mutation ? [{ mutation, result, refusedAt }] : [];
        }),
      );
    }

    for (const rejection of rejections) {
      log.warn(`Master refused ${rejection.mutationId}: ${rejection.error ?? 'no reason given'}`);
    }

    const outcome: FlushOutcome = {
      pushed: batch.length,
      applied: response.results.filter((result) => result.status === 'applied').length,
      merged: response.results.filter((result) => result.status === 'merged').length,
      rejected: rejections.length,
      rejections,
      remaining: await outbox.pendingCount(),
    };

    log.info(
      `Pushed ${outcome.pushed} mutation(s): ${outcome.applied} applied, ${outcome.merged} merged, ${outcome.rejected} refused, ${outcome.remaining} still queued`,
    );

    events.emit('changed');

    // More than one batch was waiting — keep going rather than waiting for the
    // next trigger.
    if (outcome.remaining > 0) scheduleRetry();

    return outcome;
  } catch (error) {
    log.warn(`Flush failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
    scheduleRetry();
    return { ...idle, remaining: await outbox.pendingCount() };
  } finally {
    flushing = false;
    if (rerun) {
      rerun = false;
      void flush();
    }
  }
}

/** An accepted `lead.create` whose temporary id the Master has just replaced. */
function isNumbering(
  mutation: Mutation | undefined,
  settled: SettledMutation,
): mutation is Mutation {
  return (
    mutation?.kind === 'lead.create' &&
    settled.result.status !== 'rejected' &&
    settled.permanentId !== mutation.entityId
  );
}

function remember(settled: SettledMutation): void {
  recentlySettled.set(settled.result.mutationId, settled);
  if (recentlySettled.size > RECENTLY_SETTLED_LIMIT) {
    // A Map iterates in insertion order, so the first key is the oldest.
    const oldest = recentlySettled.keys().next().value;
    if (oldest !== undefined) recentlySettled.delete(oldest);
  }
}

/** Queue a mutation and try to send it straight away. */
export async function submit(request: outbox.EnqueueRequest): Promise<Mutation> {
  const mutation = await outbox.enqueue(request);
  events.emit('changed');

  // Deliberately not awaited: saving must feel instant whether or not the
  // Master answers, and the outcome reaches the UI through the sync events.
  void flush();

  return mutation;
}

function scheduleRetry(): void {
  if (retryTimer) return;

  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flush();
  }, config.sync.retryMs);

  // Never hold the process open for a retry.
  retryTimer.unref?.();
}

export function stopSync(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  transport = null;
  rerun = false;
}
