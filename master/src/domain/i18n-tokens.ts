/**
 * The invariant that every `(entityType, action)` pair a service writes to
 * `activity_log` has a catalogue token to render against.
 *
 * `action` is free-form `TEXT` with no `CHECK` constraint — nothing at the
 * database layer stops a service writing a pair the i18n catalogue has never
 * heard of. `renderActivity()` (`@orderbook/shared`) already falls back to the
 * raw pair rather than a blank cell, so this guard is not what keeps the
 * product from crashing; it is what stops a new audited action shipping
 * permanently untranslated, because a row already written can never be
 * corrected — `activity_log` refuses UPDATE and DELETE by trigger. Lives in
 * `domain/` per decision 12: a rule that only a service could see would be
 * unreachable from a pure test.
 */

import { activityMessageKey } from '@orderbook/shared';

import { ValidationError } from '../lib/errors.js';

/** Throws if the catalogue has no `activity.<entityType>.<action>` token for this pair. */
export function assertActivityTokenExists(entityType: string, action: string): void {
  if (activityMessageKey(entityType, action) === null) {
    throw new ValidationError('error.unknown', {}, { entityType, action });
  }
}
