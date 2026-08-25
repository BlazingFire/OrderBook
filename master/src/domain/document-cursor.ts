/**
 * The PDF Designer's two keyset cursors — payloads on top of the one codec in
 * `domain/cursor.ts`, not a second encoder.
 *
 * Two, because the two feeds are read in genuinely different orders. A
 * template list is read **alphabetically** (nobody looks for a template by
 * when it was made), so it keys on `(lower(name), id)` ascending. An export
 * history is an append-mostly ledger read **newest-first**, so it keys on `id`
 * descending — and `document_exports.id` is BIGSERIAL, which stays a string
 * end to end because `Number()` loses precision above 2^53.
 */

import { decodeCursor, encodeCursor } from './cursor.js';
import { ValidationError } from '../lib/errors.js';

const TEMPLATE_CURSOR_VERSION = 'dt1';
const EXPORT_CURSOR_VERSION = 'de1';

export const DOCUMENT_PAGING = { DEFAULT_LIMIT: 50, MAX_LIMIT: 200 } as const;

export function clampDocumentPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DOCUMENT_PAGING.DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(limit), DOCUMENT_PAGING.MAX_LIMIT);
}

export interface TemplateCursor {
  /** Already lower-cased — it is compared against `lower(name)` in SQL. */
  name: string;
  id: string;
}

export function encodeTemplateCursor(position: TemplateCursor): string {
  return encodeCursor({ v: TEMPLATE_CURSOR_VERSION, n: position.name, id: position.id });
}

export function decodeTemplateCursor(cursor: string): TemplateCursor {
  const decoded = decodeCursor<{ v?: string; n?: string; id?: string }>(cursor);
  if (
    decoded.v !== TEMPLATE_CURSOR_VERSION ||
    typeof decoded.n !== 'string' ||
    typeof decoded.id !== 'string' ||
    !decoded.id
  ) {
    throw new ValidationError('validation.cursor.malformed', {}, { cursor });
  }
  return { name: decoded.n, id: decoded.id };
}

export function encodeExportCursor(id: string): string {
  return encodeCursor({ v: EXPORT_CURSOR_VERSION, id });
}

export function decodeExportCursor(cursor: string): string {
  const decoded = decodeCursor<{ v?: string; id?: string }>(cursor);
  if (decoded.v !== EXPORT_CURSOR_VERSION || typeof decoded.id !== 'string' || !decoded.id) {
    throw new ValidationError('validation.cursor.malformed', {}, { cursor });
  }
  return decoded.id;
}
