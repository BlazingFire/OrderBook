/**
 * A fixed sixty-second window per key, in memory.
 *
 * No dependency, no timer. The API-key windows are bounded by the number of keys the company
 * has issued; `rate-limit.ts` also keys it by IP, username and socket, which a caller chooses,
 * so `consume` sweeps expired windows whenever the map passes `MAX_WINDOWS`.
 *
 * Per process and reset on restart, stated rather than hidden: this is a
 * fairness control that stops one runaway integration flooding the shop's
 * database, not a security boundary.
 */

import { TooManyRequestsError } from '../../lib/errors.js';

const WINDOW_MS = 60_000;

interface Window {
  start: number;
  count: number;
}

const windows = new Map<string, Window>();

/**
 * `rate-limit.ts` keys this map by IP, username and socket as well, so a caller choosing names
 * can grow it; past this many entries an insert first drops every expired window.
 */
const MAX_WINDOWS = 5_000;

function sweep(now: number): void {
  for (const [key, window] of windows) if (now - window.start >= WINDOW_MS) windows.delete(key);
}

/**
 * Count this request, and throw if the key is over its limit.
 *
 * Returns the seconds left in the window so the route can set `Retry-After`.
 */
export function consume(keyId: string, limitPerMin: number, now: number = Date.now()): void {
  if (windows.size >= MAX_WINDOWS) sweep(now);
  const current = windows.get(keyId);

  if (!current || now - current.start >= WINDOW_MS) {
    windows.set(keyId, { start: now, count: 1 });
    return;
  }

  current.count += 1;
  if (current.count > limitPerMin) {
    const remaining = Math.max(1, Math.ceil((current.start + WINDOW_MS - now) / 1000));
    throw new TooManyRequestsError(remaining);
  }
}

/** Test seam, and what a revoked key's window costs to forget. */
export function resetRateLimits(keyId?: string): void {
  if (keyId) windows.delete(keyId);
  else windows.clear();
}

/**
 * Keys seen since the last flush, and when.
 *
 * `last_used_at` is written from the connector scheduler's own sixty-second
 * tick rather than per request: a key polled twice a second would otherwise
 * turn every read into a write, and that column is only ever read by a person
 * deciding whether a key is still in use.
 */
const pendingTouches = new Map<string, Date>();

export function noteUsed(keyId: string, at: Date = new Date()): void {
  pendingTouches.set(keyId, at);
}

/** Hands over what has accumulated and clears it, so a failed flush loses at most one tick. */
export function drainTouches(): Map<string, Date> {
  const drained = new Map(pendingTouches);
  pendingTouches.clear();
  return drained;
}
