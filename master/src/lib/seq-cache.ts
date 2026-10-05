/**
 * A short in-memory cache for hot read-only lookups, invalidated by writes.
 *
 * Every data write publishes a change into the ring (`change-bus.ts` → `change-ring.ts`), and
 * `currentSeq()` moves with it, so an entry is valid only while that number is the one it was
 * computed at. A write anywhere drops every entry on its next read, with no per-service
 * invalidation to forget. The TTL bounds the rest: figures that move with the clock (a due
 * date passing) and any write that publishes no change. The promise is cached, so ten Offices
 * reconnecting at once share one computation; a rejection is never kept.
 *
 * Key it by everything the answer depends on (tenant, person, permissions).
 */

import { currentSeq } from '../realtime/change-ring.js';

interface Entry {
  seq: string;
  at: number;
  value: Promise<unknown>;
}

/** Bumped by writes that publish no ring change (chat has its own channel). */
let extraVersion = 0;
export function bumpSeqCache(): void {
  extraVersion += 1;
}

const MAX_ENTRIES = 500;
const entries = new Map<string, Entry>();

export function seqCached<T>(key: string, ttlMs: number, compute: () => Promise<T>, now: number = Date.now()): Promise<T> {
  const seq = `${currentSeq()}:${extraVersion}`;
  const hit = entries.get(key);
  if (hit && hit.seq === seq && now - hit.at < ttlMs) return hit.value as Promise<T>;

  if (entries.size >= MAX_ENTRIES) entries.clear();
  const value = compute();
  const entry: Entry = { seq, at: now, value };
  entries.set(key, entry);
  value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return value;
}

/** A restore or reset replaces the data without a change event; see `process-caches.ts`. */
export function resetSeqCache(): void {
  entries.clear();
}
