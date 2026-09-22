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

const events = new EventEmitter();

let transport: PushTransport | null = null;
let flushing = false;
let retryTimer: NodeJS.Timeout | null = null;

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

  if (flushing || !transport) return idle;
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

    // Remap before settling: a queued follow-up ("move lead X to Quoted") has to
    // learn X's permanent id, and it is still in the queue at this point.
    await outbox.remapIds(mapping);
    await outbox.settle(response.results.map((result) => result.mutationId));

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
      const byId = new Map(batch.map((mutation) => [mutation.mutationId, mutation]));
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
}
