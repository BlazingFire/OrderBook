/**
 * CSV rendering through the Rust sidecar, with the TypeScript twin as fallback.
 *
 * Cells are stringified exactly as `lib/csv.ts` stringifies them
 * (`null`/`undefined` render as an empty cell, never `0` — the absent-not-zero
 * rule the wire contract uses everywhere), then rendered by the helper's
 * `csv` op. Any helper failure answers the TypeScript rendering instead, so
 * the export is byte-identical with or without a Rust build.
 */

import { csvLines } from './csv.js';
import { tryHelper } from './rust-bridge.js';

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** `csvLines`, via the helper when it answers, else the TypeScript twin. */
export async function csvLinesViaRust(rows: ReadonlyArray<ReadonlyArray<unknown>>): Promise<string> {
  const strings = rows.map((row) => row.map(stringifyCell));
  const value = await tryHelper({ op: 'csv', rows: strings });
  if (typeof value !== 'string') return csvLines(rows);
  return value;
}

/** `toCsv`, via the helper when it answers, else the TypeScript twin. */
export async function toCsvViaRust(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): Promise<string> {
  return csvLinesViaRust([headers, ...rows]);
}
