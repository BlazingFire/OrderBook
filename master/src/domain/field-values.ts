/**
 * Fields domain rules (`docs/backend-modules/06-WORKFLOWS.md` §5.1).
 *
 * Pure: no database, no transport. The rule the whole module hangs on is
 * that a value's identity is the exact string it always was —
 * `normaliseOptionValue` trims but deliberately does not case-fold, because
 * a colour string is a component of `stockKey()` and of two case-sensitive
 * unique indexes; folding would split or merge live stock rows.
 */

import { ValidationError } from '../lib/errors.js';

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Trims but never case-folds — the value's identity is the exact string. */
export function normaliseOptionValue(raw: string): string {
  return raw.trim();
}

/** Lower-cased, `#RRGGBB` only — throws on anything else. */
export function assertHexColour(raw: string): string {
  if (!HEX_PATTERN.test(raw)) {
    throw new ValidationError('validation.fields.hex.invalid', {}, { field: 'hex' });
  }
  return raw.toLowerCase();
}

/**
 * Editing `value` itself is refused — it is what records hold, so changing
 * it would silently orphan every record carrying the old string. A record
 * resubmitting a value it already holds is never rejected because the
 * option was since removed: this only fires when the value genuinely
 * *changes*.
 */
export function assertOptionValueChange(previous: string, next: string, isValid: boolean): void {
  if (next === previous) return;
  if (!isValid) {
    throw new ValidationError('validation.fields.value.immutable', {}, { field: 'value' });
  }
}

/**
 * Rejects anything that is not a permutation of the set's current live ids.
 * A full permutation is idempotent and detects staleness; a delta would
 * silently corrupt order when two people drag at once.
 */
export function assertCompleteReorder(currentIds: readonly string[], submittedIds: readonly string[]): void {
  const current = new Set(currentIds);
  const submitted = new Set(submittedIds);

  const missing = currentIds.filter((id) => !submitted.has(id));
  const unexpected = submittedIds.filter((id) => !current.has(id));

  if (missing.length > 0 || unexpected.length > 0 || submittedIds.length !== currentIds.length) {
    throw new ValidationError(
      'validation.fields.reorder.notPermutation',
      {},
      { field: 'ids', missing, unexpected },
    );
  }
}

/** Renumbers a submitted permutation `1..N`, in the order given. */
export function resequence(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index + 1]));
}
