/**
 * Sign-ins this panel checked against its own offline verifier, waiting to be
 * uploaded to the Master's audit trail.
 *
 * While the Master is unreachable it cannot log who signed in here, so the
 * panel keeps the facts itself and hands them over through
 * `auth:offlineEvents` once the link is back (`realtime/master-connection.ts`).
 * An entry leaves this file only when the Master has acknowledged it.
 *
 * Written whole under a temp-then-rename, like the outbox, so a power cut
 * mid-write leaves the previous complete file rather than a torn one. Capped
 * at 500 entries: a panel left offline for weeks must not grow this file
 * without limit, and 500 is also the most the Master accepts in one call, so
 * one upload always clears it. Past the cap the oldest failure goes first, and
 * a success only once no failure is left, so a flood of wrong passwords under
 * made-up names cannot push out a sign-in that has not been uploaded yet.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { OfflineAuthEvent } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('offline-auth-events');

/** The cap, and the Master's per-call limit (`MAX_OFFLINE_EVENTS` in its auth service). */
export const MAX_OFFLINE_AUTH_EVENTS = 500;
/** The Master's `MAX_OFFLINE_USERNAME`: a longer name is not a real account. */
export const MAX_OFFLINE_USERNAME = 100;

let cache: OfflineAuthEvent[] | null = null;
/** Serialises writes, so an append during an upload cannot lose either change. */
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<OfflineAuthEvent[]> {
  if (cache) return cache;

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(paths().offlineAuthEventsFile, 'utf8'));
    cache = Array.isArray(parsed) ? (parsed as OfflineAuthEvent[]) : [];
  } catch {
    // Absent or unreadable both start empty. These are audit notes waiting to
    // be sent, not work, and refusing to sign anyone in over them would be worse.
    cache = [];
  }

  return cache;
}

async function persist(events: OfflineAuthEvent[]): Promise<void> {
  const file = paths().offlineAuthEventsFile;
  await fs.mkdir(path.dirname(file), { recursive: true });

  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(events), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function mutate(update: (current: OfflineAuthEvent[]) => OfflineAuthEvent[]): Promise<void> {
  const write = writeChain.then(async () => {
    const next = update(await load());
    await persist(next);
    cache = next;
  });

  // The next write waits for this one but not on its success, so one failed
  // write (a full disk, a locked file) does not fail every write after it.
  writeChain = write.catch(() => {});
  return write;
}

/** Drops the oldest failure, or the oldest event when none failed, until the list fits the cap. */
function withinCap(events: OfflineAuthEvent[]): OfflineAuthEvent[] {
  const kept = [...events];
  while (kept.length > MAX_OFFLINE_AUTH_EVENTS) {
    const failure = kept.findIndex((event) => !event.success);
    kept.splice(failure === -1 ? 0 : failure, 1);
  }
  return kept;
}

/** Record one offline sign-in or failure. Never throws: a sign-in must not fail over its audit note. */
export async function append(event: OfflineAuthEvent): Promise<void> {
  // The Master skips a username longer than this (`MAX_OFFLINE_USERNAME`), so
  // keeping one would only cost memory and disk on a low-RAM PC.
  if (event.username.length > MAX_OFFLINE_USERNAME) return;
  try {
    // The id lets the Master skip an event it already logged if an upload is
    // sent again after its answer was lost.
    const stored = { ...event, id: event.id ?? randomUUID() };
    await mutate((current) => withinCap([...current, stored]));
  } catch (error) {
    log.warn(`Could not record an offline sign-in: ${(error as Error).message}`);
  }
}

/** The oldest `limit` events, in the order they happened. */
export async function peek(limit = MAX_OFFLINE_AUTH_EVENTS): Promise<OfflineAuthEvent[]> {
  return (await load()).slice(0, limit);
}

/**
 * Remove events the Master has acknowledged.
 *
 * By identity rather than by count: an append that pushes the file past its
 * cap while an upload is in flight drops the oldest entry, and "drop the first
 * n" would then remove one that was never sent.
 */
export async function drop(sent: OfflineAuthEvent[]): Promise<void> {
  if (sent.length === 0) return;
  const done = new Set(sent);
  await mutate((current) => current.filter((event) => !done.has(event)));
}

/** Test seam: the cache outlives a temp directory being rebuilt. */
export function resetOfflineAuthEvents(): void {
  cache = null;
  writeChain = Promise.resolve();
}
