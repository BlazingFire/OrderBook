/**
 * What counts as "no reason given".
 *
 * `inventory.adjustmentNoteRequired` is checked in three places — the Master's
 * service, and each panel's form before it sends — and three hand-written
 * `!note` tests is exactly how a form comes to let through something the server
 * then refuses. One predicate, tested once.
 */

import { describe, expect, it } from 'vitest';

import { isBlankNote } from '../src/index.js';

describe('isBlankNote', () => {
  it('treats an absent note as blank', () => {
    expect(isBlankNote(undefined)).toBe(true);
    expect(isBlankNote(null)).toBe(true);
    expect(isBlankNote('')).toBe(true);
  });

  it('treats whitespace as blank, which a truthiness check does not', () => {
    // The case that matters. A field somebody resents gets a space, and `!note`
    // is satisfied by it — so the server would accept a correction whose stated
    // reason is nothing at all, and the audit trail would record it as given.
    expect(isBlankNote(' ')).toBe(true);
    expect(isBlankNote('   ')).toBe(true);
    expect(isBlankNote('\t\n')).toBe(true);
  });

  it('accepts a real reason, padded or not', () => {
    expect(isBlankNote('breakage')).toBe(false);
    expect(isBlankNote('  breakage  ')).toBe(false);
    // A single character is a poor reason but it is a reason; this predicate
    // decides presence, never quality.
    expect(isBlankNote('x')).toBe(false);
  });
});
