/**
 * The Logs keyset cursor — a payload on top of the one codec in
 * `domain/cursor.ts`, not a second encoder. `activity_log.id` is the only
 * safe keyset key: `sequence` is nullable at DDL level and not unique, and
 * `created_at` ties under `now()` within a transaction and has no unique
 * index.
 */

import { decodeCursor, encodeCursor } from './cursor.js';
import { ValidationError } from '../lib/errors.js';

const CURSOR_VERSION = 'v1';

const LOG_PAGING ={ DEFAULT_LIMIT: 50, MAX_LIMIT: 200 } as const;

/** Clamps a client-supplied page size, defaulting when absent or nonsensical. */
export function clampLogPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return LOG_PAGING.DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), LOG_PAGING.MAX_LIMIT);
}

/** `id` stays a string end to end — BIGSERIAL past 2^53 loses precision through `Number()`. */
export function encodeLogCursor(id: string): string {
  return encodeCursor({ v: CURSOR_VERSION, id });
}

export function decodeLogCursor(cursor: string): string {
  const decoded = decodeCursor<{ v?: string; id?: string }>(cursor);
  if (decoded.v !== CURSOR_VERSION || typeof decoded.id !== 'string' || !decoded.id) {
    // `decodeCursor` already throws on a structurally malformed token; this
    // catches a well-formed token from a different module's payload shape,
    // or an unknown version prefix.
    throw new ValidationError('validation.cursor.malformed', {}, { cursor });
  }
  return decoded.id;
}
