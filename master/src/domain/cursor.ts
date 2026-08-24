/**
 * THE single opaque base64url cursor codec. Every keyset-paged module in this
 * batch (Recycle Bin, Logs, document exports, …) builds its own payload shape
 * on top of this one codec rather than inventing a second encoder —
 * `01-ARCHITECTURE.md` §4.2: a cursor is a token a client round-trips, and
 * three encoders would mean three formats a client cannot tell apart and
 * three places to get base64url padding wrong.
 *
 * Pure — no I/O, no database — which is what makes its test suite
 * unskippable (`master/tests/cursor.test.ts` carries no `describe.skipIf`).
 *
 * BIGINT ids arrive from node-postgres as STRINGS and stay strings all the
 * way through a payload: `Number()` silently loses precision above 2^53,
 * which a sequence column large enough eventually is.
 *
 * A malformed cursor throws rather than falling back to "start over at the
 * newest page" — a silently ignored cursor makes an Older button loop forever
 * on page one, which reads as a worse bug than an explicit refusal.
 */

import { ValidationError } from '../lib/errors.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamps a client-supplied page size into a safe range, defaulting when absent or nonsensical. */
export function clampCursorLimit(
  limit: number | undefined,
  fallback: number = DEFAULT_LIMIT,
  max: number = MAX_LIMIT,
): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.trunc(limit), max);
}

/** Encodes any JSON-safe payload as an opaque base64url token. */
export function encodeCursor<T extends Record<string, unknown>>(payload: T): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor minted by `encodeCursor`. Throws `ValidationError` — never
 * returns `null` and never falls back — on anything that is not valid
 * base64url JSON of an object, including a token from a different module's
 * payload shape or one that has been hand-edited.
 */
export function decodeCursor<T extends Record<string, unknown>>(cursor: string): T {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('cursor did not decode to an object');
    }

    return parsed as T;
  } catch {
    throw new ValidationError('validation.cursor.malformed', {}, { cursor });
  }
}
