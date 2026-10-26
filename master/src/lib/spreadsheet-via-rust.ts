/**
 * CSV sheet parsing through the Rust sidecar, with the TypeScript twin as fallback.
 *
 * `readSheetRows` sends CSV buffers here; the helper's `parseCsv` op answers
 * the same row arrays `parseCsv` computes, including blank lines as rows, so
 * the reported row numbers never shift with or without a Rust build. Any
 * helper failure answers the TypeScript parse instead.
 */

import { parseCsv } from './spreadsheet.js';
import { tryHelper } from './rust-bridge.js';

function isStringRows(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (row): row is string[] =>
      Array.isArray(row) && row.every((cell): cell is string => typeof cell === 'string'),
  );
}

/** `parseCsv`, via the helper when it answers, else the TypeScript twin. */
export async function parseCsvViaRust(text: string): Promise<string[][]> {
  const value = await tryHelper({ op: 'parseCsv', text });
  if (isStringRows(value)) return value;
  return parseCsv(text);
}
