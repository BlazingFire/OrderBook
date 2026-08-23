/**
 * The offline sync primitives: clocks, ids, and the field-level merge.
 *
 * These are pure, so they run everywhere — no database, no network. They are
 * also the pieces whose bugs are hardest to see in a browser (a merge that
 * silently drops a field looks exactly like a UI that failed to refresh), which
 * is why they carry the most detailed tests in the repo.
 */

import { describe, expect, it } from 'vitest';

import {
  compareForIdAssignment,
  compareHlc,
  deviceCodeFromSeed,
  deviceCodeOf,
  entityOfPermanentId,
  formatPermanentId,
  formatTemporaryId,
  initialHlcState,
  isPermanentId,
  isTemporaryId,
  isValidDeviceCode,
  mergeFields,
  observeHlc,
  parseHlc,
  PERMANENT_ID_LENGTH,
  TEMP_ID_LENGTH,
  tickHlc,
} from '../src/index.js';

const PANEL_A = 'A3F9K2';
const PANEL_B = 'B7QMX4';

describe('hybrid logical clock', () => {
  it('advances the counter when two events land in the same millisecond', () => {
    let state = initialHlcState(PANEL_A);

    const first = tickHlc(state, 1_700_000_000_000);
    state = first.state;
    const second = tickHlc(state, 1_700_000_000_000);

    expect(parseHlc(first.hlc).counter).toBe(0);
    expect(parseHlc(second.hlc).counter).toBe(1);
    expect(compareHlc(first.hlc, second.hlc)).toBeLessThan(0);
  });

  it('resets the counter once the wall clock moves on', () => {
    let state = initialHlcState(PANEL_A);
    state = tickHlc(state, 1_700_000_000_000).state;
    state = tickHlc(state, 1_700_000_000_000).state;

    const later = tickHlc(state, 1_700_000_000_001);

    expect(parseHlc(later.hlc).counter).toBe(0);
  });

  it('never goes backwards when the wall clock does', () => {
    // The shop PC's date gets corrected — or someone changes it by hand.
    let state = initialHlcState(PANEL_A);
    const before = tickHlc(state, 1_700_000_000_000);
    state = before.state;

    const after = tickHlc(state, 1_600_000_000_000);

    expect(compareHlc(before.hlc, after.hlc)).toBeLessThan(0);
    expect(parseHlc(after.hlc).physical).toBe(1_700_000_000_000);
  });

  it('sorts after a remote edit it has observed, even with a slower clock', () => {
    // Panel B's clock is a full minute behind panel A's.
    const remote = tickHlc(initialHlcState(PANEL_A), 1_700_000_060_000).hlc;

    const local = observeHlc(initialHlcState(PANEL_B), remote, 1_700_000_000_000);

    expect(compareHlc(remote, local.hlc)).toBeLessThan(0);
  });

  it('orders lexicographically, which is what lets Postgres sort on it', () => {
    let state = initialHlcState(PANEL_A);
    const stamps: string[] = [];

    for (let i = 0; i < 25; i += 1) {
      const tick = tickHlc(state, 1_700_000_000_000 + (i % 3));
      state = tick.state;
      stamps.push(tick.hlc);
    }

    expect([...stamps].sort()).toEqual(stamps);
  });

  it('gives two devices distinct timestamps even at the identical instant', () => {
    const a = tickHlc(initialHlcState(PANEL_A), 1_700_000_000_000).hlc;
    const b = tickHlc(initialHlcState(PANEL_B), 1_700_000_000_000).hlc;

    // Distinctness is what makes the total order a *total* one — no ties to break.
    expect(a).not.toEqual(b);
    expect(compareHlc(a, b)).not.toBe(0);
  });
});

describe('record ids', () => {
  it('mints temporary ids at the documented 15-character shape', () => {
    const id = formatTemporaryId(PANEL_A, 123);

    expect(id).toHaveLength(TEMP_ID_LENGTH);
    expect(id).toBe('A3F9K2000000123');
    expect(isTemporaryId(id)).toBe(true);
    expect(isPermanentId(id)).toBe(false);
    expect(deviceCodeOf(id)).toBe(PANEL_A);
  });

  it('mints permanent ids at the documented 12-character shape', () => {
    const id = formatPermanentId('lead', 42);

    expect(id).toHaveLength(PERMANENT_ID_LENGTH);
    expect(id).toBe('LD0000000042');
    expect(isPermanentId(id)).toBe(true);
    expect(isTemporaryId(id)).toBe(false);
    expect(entityOfPermanentId(id)).toBe('lead');
  });

  it('derives a stable device code from a seed, using only unambiguous letters', () => {
    const seed = '22222222-2222-4222-8222-222222222222';

    const code = deviceCodeFromSeed(seed);

    expect(deviceCodeFromSeed(seed)).toBe(code);
    expect(isValidDeviceCode(code)).toBe(true);
    // Characters that get misread off a printed docket or down a phone line.
    expect(code).not.toMatch(/[01OILU]/);
  });

  it('numbers a batch by (hlc, device), not by which panel synced first', () => {
    const batch = [
      { hlc: '0000001700000000002-00000-B7QMX4', deviceCode: PANEL_B },
      { hlc: '0000001700000000001-00000-A3F9K2', deviceCode: PANEL_A },
      { hlc: '0000001700000000001-00000-B7QMX4', deviceCode: PANEL_B },
    ];

    const arrivedLateFirst = [...batch].sort(compareForIdAssignment);
    const arrivedEarlyFirst = [...batch].reverse().sort(compareForIdAssignment);

    expect(arrivedLateFirst).toEqual(arrivedEarlyFirst);
    expect(arrivedLateFirst[0]?.hlc).toBe('0000001700000000001-00000-A3F9K2');
  });

  it('refuses a device code it cannot round-trip', () => {
    expect(() => formatTemporaryId('short', 1)).toThrow(/Invalid device code/);
    expect(() => formatTemporaryId(PANEL_A, -1)).toThrow(/non-negative/);
  });
});

describe('field-level merge', () => {
  const stampA = tickHlc(initialHlcState(PANEL_A), 1_700_000_000_000).hlc;
  const stampB = tickHlc(initialHlcState(PANEL_B), 1_700_000_060_000).hlc;

  it('keeps both edits when two panels touch different fields', () => {
    // Panel A already wrote `notes`. Panel B, offline, edits `followUpDate` only.
    const outcome = mergeFields(
      { values: { notes: 'called back', followUpDate: null }, fieldHlc: { notes: stampA } },
      {
        fields: ['followUpDate'],
        values: { followUpDate: '2026-09-01' },
        baseFieldHlc: {},
        hlc: stampB,
        deviceCode: PANEL_B,
      },
    );

    expect(outcome.status).toBe('applied');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.accepted).toEqual({ followUpDate: '2026-09-01' });
    // A's note is untouched — the whole point of a per-field clock.
    expect(outcome.fieldHlc.notes).toBe(stampA);
  });

  it('gives the field to the higher HLC and keeps the loser visible', () => {
    const outcome = mergeFields(
      { values: { notes: 'A wrote this' }, fieldHlc: { notes: stampA } },
      {
        fields: ['notes'],
        values: { notes: 'B wrote this' },
        // B never saw A's value — it thought the field was still unset.
        baseFieldHlc: {},
        hlc: stampB,
        deviceCode: PANEL_B,
      },
    );

    expect(outcome.status).toBe('merged');
    expect(outcome.accepted).toEqual({ notes: 'B wrote this' });
    expect(outcome.conflicts).toEqual([
      {
        field: 'notes',
        losingValue: 'A wrote this',
        winningValue: 'B wrote this',
        winningHlc: stampB,
        winningDeviceCode: PANEL_B,
      },
    ]);
  });

  it('refuses a stale edit but still records what it wanted to write', () => {
    const outcome = mergeFields(
      { values: { notes: 'B wrote this' }, fieldHlc: { notes: stampB } },
      {
        fields: ['notes'],
        values: { notes: 'A wrote this later, but with an older clock' },
        baseFieldHlc: {},
        hlc: stampA,
        deviceCode: PANEL_A,
      },
    );

    expect(outcome.status).toBe('merged');
    // Nothing written — the stored value is newer.
    expect(outcome.accepted).toEqual({});
    expect(outcome.fieldHlc.notes).toBe(stampB);
    expect(outcome.conflicts[0]?.losingValue).toBe(
      'A wrote this later, but with an older clock',
    );
    expect(outcome.conflicts[0]?.winningDeviceCode).toBe(PANEL_B);
  });

  it('does not cry conflict when the editor had already seen the value', () => {
    // The ordinary case: B pulls A's change, then edits it. Not a clash.
    const outcome = mergeFields(
      { values: { notes: 'A wrote this' }, fieldHlc: { notes: stampA } },
      {
        fields: ['notes'],
        values: { notes: 'B revised it' },
        baseFieldHlc: { notes: stampA },
        hlc: stampB,
        deviceCode: PANEL_B,
      },
    );

    expect(outcome.status).toBe('applied');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.accepted).toEqual({ notes: 'B revised it' });
  });

  it('treats an identical value as agreement, not as a clash', () => {
    const outcome = mergeFields(
      { values: { notes: 'same text' }, fieldHlc: { notes: stampA } },
      {
        fields: ['notes'],
        values: { notes: 'same text' },
        baseFieldHlc: {},
        hlc: stampB,
        deviceCode: PANEL_B,
      },
    );

    expect(outcome.status).toBe('applied');
    expect(outcome.conflicts).toEqual([]);
  });

  it('compares line-item arrays structurally', () => {
    const lines = [{ productId: 'PR0000000001', quantities: [{ colour: 'white', quantity: 2 }] }];

    const outcome = mergeFields(
      { values: { items: lines }, fieldHlc: { items: stampA } },
      {
        fields: ['items'],
        // Same content, different object identity — resending must not conflict.
        values: { items: JSON.parse(JSON.stringify(lines)) as unknown },
        baseFieldHlc: {},
        hlc: stampB,
        deviceCode: PANEL_B,
      },
    );

    expect(outcome.conflicts).toEqual([]);
  });

  it('does not report bookkeeping fields as conflicts', () => {
    const outcome = mergeFields(
      { values: { updatedAt: 'then', notes: 'A' }, fieldHlc: { updatedAt: stampA } },
      {
        fields: ['updatedAt'],
        values: { updatedAt: 'now' },
        baseFieldHlc: {},
        hlc: stampB,
        deviceCode: PANEL_B,
      },
    );

    // The write still happens; it just is not something to ask a human about.
    expect(outcome.accepted).toEqual({ updatedAt: 'now' });
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.status).toBe('applied');
  });
});
