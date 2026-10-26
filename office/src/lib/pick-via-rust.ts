/**
 * Picker scoring through the Rust sidecar, with the TypeScript twin as fallback.
 *
 * A whole page is scored in one `pickBatch` round trip. Any helper failure —
 * or any score outside the `PICK_SCORE` tiers, so a stale binary can never
 * reorder a list — answers the TypeScript `pickScore` row by row instead, so
 * the order is identical with or without a Rust build.
 */

import {
  PICK_SCORE,
  pickScore,
  type PickScore,
} from '@orderbook/shared';

import { tryHelper } from './rust-bridge.js';

const VALID_SCORES: ReadonlySet<number> = new Set([
  PICK_SCORE.none,
  PICK_SCORE.substring,
  PICK_SCORE.wordStart,
  PICK_SCORE.prefix,
  PICK_SCORE.exact,
]);

/**
 * One score per row, in order. Falls back to `pickScore` for the whole batch
 * when the helper is unavailable or answers anything unexpected.
 */
export async function pickScoresViaRust(
  rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>,
  term: string,
): Promise<PickScore[]> {
  const fallback = (): PickScore[] => rows.map((row) => pickScore(row, term));
  const strings = rows.map((row) => row.map((field) => String(field ?? '')));
  const value = await tryHelper({ op: 'pickBatch', rows: strings, term });
  if (!Array.isArray(value) || value.length !== rows.length) return fallback();
  const scores: PickScore[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !VALID_SCORES.has(entry)) return fallback();
    scores.push(entry as PickScore);
  }
  return scores;
}
