/**
 * The last few thousand changes, so a panel that was switched off for lunch
 * does not need the whole snapshot back.
 *
 * A reconnect costs a `buildSnapshot`: six paged services at 500 rows each,
 * plus variants, pipelines, option lists, custom fields, a hundred conflicts, a
 * full dashboard and the grants. That is the right answer for a panel that has
 * been off for a week and an absurd one for a panel that dropped its Wi-Fi for
 * ninety seconds.
 *
 * **In memory, deliberately.** `BOOT_ID` is minted per process, so every cursor
 * from before a Master restart is worthless — which is correct, not a
 * limitation: the ring is the only record of what happened, and a restart means
 * there is no record. A cursor naming a different boot falls back to the
 * snapshot, which is exactly what happens today. A restore or a developer
 * reset replaces the data without a restart, so `resetChangeRing` mints a new
 * one too.
 *
 * The ring is also the only place a `seq` comes from. Nothing persists one, no
 * column carries one, and no migration exists for this feature — an
 * `(tenant_id, hlc)` index was considered and rejected, because `hlc` is
 * nullable TEXT on pre-sync rows and the predicate degrades.
 */

import { randomUUID } from 'node:crypto';
import type { DataChangedEvent } from '@orderbook/shared';

/**
 * This process's identity, paired with every sequence number it hands out.
 *
 * Regenerated on restart on purpose, and by `resetChangeRing`. A live binding,
 * so `delta.service.ts` and `snapshot.service.ts` read the current one. See the
 * header.
 */
export let BOOT_ID = randomUUID();

/**
 * How many changes are kept.
 *
 * Two thousand is roughly a busy morning's worth on a shop this size, and the
 * cost is bounded by the payloads already being emitted — the ring holds the
 * same object references the sockets received, not copies.
 */
const CAPACITY = 2_000;

const ring: DataChangedEvent[] = [];
let nextSeq = 1;

/**
 * Record a change and stamp it with its sequence number.
 *
 * The event object is stamped in place and then emitted, so every recipient
 * sees the same `seq` the ring holds — a panel's cursor and the ring's contents
 * are then the same numbering by construction rather than by agreement.
 */
export function record(event: DataChangedEvent): number {
  const seq = nextSeq;
  nextSeq += 1;

  event.seq = seq;
  ring.push(event);
  if (ring.length > CAPACITY) ring.shift();

  return seq;
}

/** The highest sequence number handed out so far; 0 before the first change. */
export function currentSeq(): number {
  return nextSeq - 1;
}

/**
 * Everything after `lastSeq`, or `null` when the ring can no longer prove it
 * has everything.
 *
 * `null` is the important return. If the oldest entry still held is newer than
 * `lastSeq + 1`, changes have been evicted and any answer would be silently
 * missing rows — so the caller must fall back to a full snapshot. A cursor from
 * the future (a panel holding a `seq` this process never issued) is the same
 * kind of "cannot prove it", and answers `null` too.
 */
export function since(lastSeq: number): DataChangedEvent[] | null {
  if (lastSeq < 0 || lastSeq > currentSeq()) return null;
  if (lastSeq === currentSeq()) return [];

  const oldest = ring[0]?.seq;
  if (oldest === undefined) return null;
  if (oldest > lastSeq + 1) return null;

  return ring.filter((event) => (event.seq ?? 0) > lastSeq);
}

/**
 * Forget every change and start a new boot, after the data behind the ring was
 * replaced (a restore, a developer reset) and between tests.
 *
 * The new `BOOT_ID` is the point. Restarting `seq` at 1 under the old id let a
 * panel whose cursor was below the refilled ring get a delta of changes to
 * records it never had, instead of the snapshot it needs.
 */
export function resetChangeRing(): void {
  ring.length = 0;
  nextSeq = 1;
  BOOT_ID = randomUUID();
}
