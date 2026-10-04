/**
 * Which Master this PC's cached data belongs to, and what happened to the pairing.
 *
 * The snapshot, the sync cursor, the list of people who may sign in offline and the
 * outbox are all *one Master's* data. Before this file nothing recorded whose. A
 * panel whose pairing was lost (removed by the Master, unpaired by hand) and then
 * paired to a **different** Master therefore opened with the old company's
 * snapshot and offered the old company's sync cursor to the new one.
 *
 * - `cacheMaster` is the id of the Master the cached data was received from.
 * - `adoptMaster()` runs when a pairing completes. The same Master: nothing changes
 *   (the outbox is kept and goes on to be sent). A different one: the old company's
 *   cache is dropped, and any change that was never sent is **set aside** in
 *   `parked-outbox.json`, not deleted and not sent to a Master it was not made for.
 * - `removed` is the reason a pairing was lost, so the connection screen can say so
 *   (and keep saying so after a restart) until the PC is paired again.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Mutation } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';
import { resetLocalStore } from '../sync/local-store.js';
import { pending, resetOutboxCache, settle } from '../sync/outbox.store.js';
import type { StoredCredentials } from './credentials.store.js';
import { resetOfflineAuthEvents } from './offline-auth-events.store.js';
import { resetSignInAttempts } from './sign-in-attempts.store.js';
import { resetUserStore } from './user-store.js';

const log = createLogger('master-binding');

export interface RemovedNote {
  /** When this PC found out. */
  at: string;
  companyName: string | null;
  masterUniqueId: string;
  host: string;
  port: number;
}

interface Binding {
  cacheMaster: string | null;
  removed: RemovedNote | null;
  /** The panel id this PC had before its pairing ended, sent with the next pairing. */
  lastPanelId: string | null;
  /**
   * The secret that went with it. With the id it lets the Master recognise the same PC
   * and give it its row back even when the Master never learned this PC had left
   * (an unpair while the Master was off). Kept in this 0600 file until the next
   * successful pairing, then wiped; never logged, never exported in a backup.
   */
  lastPanelSecret: string | null;
}

interface ParkedBatch {
  masterUniqueId: string;
  companyName: string | null;
  parkedAt: string;
  mutations: Mutation[];
}

let cache: Binding | null = null;

async function load(): Promise<Binding> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(
      await fs.readFile(paths().masterBindingFile, 'utf8'),
    ) as Partial<Binding>;
    cache = {
      cacheMaster: typeof parsed.cacheMaster === 'string' ? parsed.cacheMaster : null,
      removed: parsed.removed ?? null,
      lastPanelId: typeof parsed.lastPanelId === 'string' ? parsed.lastPanelId : null,
      lastPanelSecret: typeof parsed.lastPanelSecret === 'string' ? parsed.lastPanelSecret : null,
    };
  } catch {
    cache = { cacheMaster: null, removed: null, lastPanelId: null, lastPanelSecret: null };
  }
  return cache;
}

async function save(next: Binding): Promise<void> {
  cache = next;
  await fs.mkdir(path.dirname(paths().masterBindingFile), { recursive: true });
  await fs.writeFile(paths().masterBindingFile, JSON.stringify(next, null, 2), { mode: 0o600 });
}

/**
 * This PC is connected to `masterUniqueId`, so the cache it holds is that
 * Master's. Written once, when it is not yet known: a panel paired before this file
 * existed learns whose cache it has the first time it opens its connection.
 */
export async function noteCacheMaster(masterUniqueId: string): Promise<void> {
  const binding = await load();
  if (binding.cacheMaster === masterUniqueId) return;
  if (binding.cacheMaster === null) await save({ ...binding, cacheMaster: masterUniqueId });
}

export interface AdoptResult {
  /** The Master is not the one the cache came from; it has been dropped. */
  newMaster: boolean;
  /** Unsent changes set aside rather than carried to a different Master. */
  parkedChanges: number;
}

/** A pairing just completed: keep what belongs to this Master, set aside what does not. */
export async function adoptMaster(credentials: StoredCredentials): Promise<AdoptResult> {
  const binding = await load();
  const same = binding.cacheMaster === null || binding.cacheMaster === credentials.masterUniqueId;

  if (same) {
    await save({
      cacheMaster: credentials.masterUniqueId,
      removed: null,
      lastPanelId: null,
      lastPanelSecret: null,
    });
    return { newMaster: false, parkedChanges: 0 };
  }

  const waiting = await pending();
  if (waiting.length > 0) {
    const batches = await readParked();
    batches.push({
      masterUniqueId: binding.cacheMaster ?? 'unknown',
      companyName: binding.removed?.companyName ?? null,
      parkedAt: new Date().toISOString(),
      mutations: waiting,
    });
    await fs.mkdir(path.dirname(paths().parkedOutboxFile), { recursive: true });
    await fs.writeFile(paths().parkedOutboxFile, JSON.stringify(batches, null, 2), { mode: 0o600 });
    await settle(waiting.map((mutation) => mutation.mutationId));
    log.warn(`${waiting.length} unsent change(s) from another Master were set aside, not sent`);
  }

  await dropCachedData();
  await save({
    cacheMaster: credentials.masterUniqueId,
    removed: null,
    lastPanelId: null,
    lastPanelSecret: null,
  });
  log.info(
    `Paired with a different Master than the cached data came from; started from a clean cache`,
  );
  return { newMaster: true, parkedChanges: waiting.length };
}

/** Everything cached from a Master: its snapshot, its people, the offline records. */
export async function dropCachedData(): Promise<void> {
  const files = paths();
  for (const file of [
    files.snapshotFile,
    files.usersFile,
    files.signInAttemptsFile,
    files.offlineAuthEventsFile,
    files.refusalsFile,
  ]) {
    await fs.rm(file, { force: true });
  }
  resetLocalStore();
  resetUserStore();
  resetSignInAttempts();
  resetOfflineAuthEvents();
  resetOutboxCache();
}

async function readParked(): Promise<ParkedBatch[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(paths().parkedOutboxFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as ParkedBatch[]) : [];
  } catch {
    return [];
  }
}

/** How many unsent changes are waiting in the set-aside file (for the connection screen). */
export async function parkedChangeCount(): Promise<number> {
  return (await readParked()).reduce((total, batch) => total + batch.mutations.length, 0);
}

/** The Master removed this PC, or it was unpaired here: remember why until it is paired again. */
export async function recordRemoved(credentials: StoredCredentials | null): Promise<void> {
  if (!credentials) return;
  const binding = await load();
  await save({
    cacheMaster: binding.cacheMaster ?? credentials.masterUniqueId,
    lastPanelId: credentials.panelId,
    lastPanelSecret: credentials.panelSecret,
    removed: {
      at: new Date().toISOString(),
      companyName: credentials.companyName,
      masterUniqueId: credentials.masterUniqueId,
      host: credentials.masterHost,
      port: credentials.masterPort,
    },
  });
}

export async function removedNote(): Promise<RemovedNote | null> {
  return (await load()).removed;
}

/** Test seam. */
export function resetBindingCache(): void {
  cache = null;
}

/** Set (or, with null, forget) whose data the cache holds: used when unpairing. */
export async function recordCacheOwner(masterUniqueId: string | null): Promise<void> {
  const binding = await load();
  await save({ ...binding, cacheMaster: masterUniqueId });
}

/** This PC left on purpose: remember its id and secret so the same PC can get its row back. */
export async function rememberLastPanel(
  panelId: string,
  panelSecret: string | null,
): Promise<void> {
  const binding = await load();
  await save({ ...binding, lastPanelId: panelId, lastPanelSecret: panelSecret });
}

/** What to send as `previousPanelId` / `previousPanelSecret` with the next pairing, if this PC had a pairing before. */
export async function previousPanel(): Promise<{ id: string; secret: string | null } | null> {
  const binding = await load();
  return binding.lastPanelId ? { id: binding.lastPanelId, secret: binding.lastPanelSecret } : null;
}
