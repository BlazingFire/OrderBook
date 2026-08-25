/**
 * Pure rules for the Fields module's option-list values
 * (`docs/backend-modules/04-API-CONTRACT.md` §5.3, §5.5).
 *
 * The rule the whole module hangs on: a value's identity is the exact string
 * it always was. `normaliseOptionValue` trims and deliberately does **not**
 * case-fold, because the value is a component of `stockKey()` and of two
 * case-sensitive unique indexes — folding it here would silently merge or
 * orphan live stock rows that are already two distinct records.
 */

import type { MessageKey } from '@orderbook/shared';

import { ValidationError } from '../lib/errors.js';

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Trims only. Case is preserved exactly — see the file header. */
export function normaliseOptionValue(raw: string): string {
  return raw.trim();
}

/**
 * `#RRGGBB`, normalised to lowercase so string equality is colour equality.
 * `null`/`undefined`/empty stays `null` — a set with no colour to render, or a
 * value nobody has assigned a swatch to yet, both render through the
 * two-letter ring fallback.
 */
export function assertHexColour(
  raw: string | null | undefined,
  field: 'hex' | 'colourHex' = 'hex',
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (!HEX_PATTERN.test(raw)) {
    throw new ValidationError('validation.fields.hexInvalid', {}, { field });
  }

  return raw.toLowerCase();
}

/**
 * Whether a record's option-list-backed field may keep or take `value`.
 *
 * Removing an option must not make every record that already held it
 * invalid — the string stays on the record and keeps rendering
 * ("removing a value never touches the records that used it"). So a value
 * unchanged from what the record already carries is always accepted, live
 * option or not; a *new* value is accepted only when the option is currently
 * live. The caller supplies its own token, because the sentence differs by
 * field ("not a configured lead source" vs. a custom-field validation
 * message) even though the rule is the same.
 */
export function assertOptionValueChange(
  value: string,
  previous: string | null | undefined,
  isCurrentlyValid: boolean,
  messageKey: MessageKey,
): void {
  if (value === previous || isCurrentlyValid) return;
  throw new ValidationError(messageKey, { value });
}

/**
 * A reorder submits the complete ordered id list, never a delta — a delta
 * cannot express "these two swapped" without a read-modify-write race. This
 * checks the submitted list is exactly a permutation of the live set: same
 * members, no duplicates, nothing missing.
 */
export function assertCompleteReorder(
  ids: readonly string[],
  liveIds: readonly string[],
  extraDetails: Record<string, unknown> = {},
): void {
  const idSet = new Set(ids);
  const liveSet = new Set(liveIds);

  const missing = liveIds.filter((id) => !idSet.has(id));
  const unexpected = ids.filter((id) => !liveSet.has(id));
  const hasDuplicates = idSet.size !== ids.length;

  if (missing.length > 0 || unexpected.length > 0 || hasDuplicates) {
    throw new ValidationError(
      'validation.fields.reorderMismatch',
      {},
      {
        field: 'ids',
        ...extraDetails,
        ...(missing.length > 0 ? { missing } : {}),
        ...(unexpected.length > 0 ? { unexpected } : {}),
      },
    );
  }
}

/** An ordered id list, turned into the `1..N` sequence a write path stores. */
export function resequence(ids: readonly string[]): Array<{ id: string; sequence: number }> {
  return ids.map((id, index) => ({ id, sequence: index + 1 }));
}
