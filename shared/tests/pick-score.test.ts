/**
 * The picker's ordering, pinned once so both sides cannot drift.
 *
 * The Master ranks with Postgres and the Office panel ranks in memory over its
 * cached snapshot, which is the same question answered by two mechanisms. If
 * they disagreed, the picker would visibly reshuffle the moment a panel
 * reconnected — so the shape of the answer is here, and both call it.
 */

import { describe, expect, it } from 'vitest';

import { PICK_SCORE, comparePicked, pickScore } from '../src/index.js';

describe('pickScore', () => {
  it('ranks an exact match above a prefix above a word start above a substring', () => {
    expect(pickScore(['matt'], 'matt')).toBe(PICK_SCORE.exact);
    expect(pickScore(['matt finish'], 'matt')).toBe(PICK_SCORE.prefix);
    expect(pickScore(['ivory matt'], 'matt')).toBe(PICK_SCORE.wordStart);
    expect(pickScore(['formatted'], 'matt')).toBe(PICK_SCORE.substring);
    expect(pickScore(['glossy'], 'matt')).toBe(PICK_SCORE.none);
  });

  it('takes the best field rather than adding them up', () => {
    // The code is an exact match; the name merely contains the term. A sum
    // would let a row win by being vaguely relevant in several places.
    expect(pickScore(['Formatted Tile', 'MATT'], 'matt')).toBe(PICK_SCORE.exact);
  });

  it('ignores an empty term, so an idle picker filters nothing', () => {
    expect(pickScore(['anything'], '   ')).toBe(PICK_SCORE.none);
  });

  it('is case-insensitive and tolerant of an absent field', () => {
    expect(pickScore([null, undefined, 'IVORY'], 'ivory')).toBe(PICK_SCORE.exact);
  });

  it('does not let a regex metacharacter in the term throw', () => {
    // Real product codes contain these. A picker that crashed on one would
    // crash on the third keystroke of somebody's ordinary search.
    expect(() => pickScore(['600x600 (matt)'], '(matt')).not.toThrow();
    expect(() => pickScore(['a+b'], '+')).not.toThrow();
  });
});

describe('comparePicked', () => {
  it('puts the better score first', () => {
    const rows = [
      { score: PICK_SCORE.substring, label: 'aa' },
      { score: PICK_SCORE.exact, label: 'zzzz' },
    ];
    expect([...rows].sort(comparePicked)[0]?.label).toBe('zzzz');
  });

  it('prefers the shorter label at the same score', () => {
    // The term is a larger fraction of the shorter match, which is nearly
    // always the one somebody meant.
    const rows = [
      { score: PICK_SCORE.prefix, label: 'matt finish rustic' },
      { score: PICK_SCORE.prefix, label: 'matt' },
    ];
    expect([...rows].sort(comparePicked)[0]?.label).toBe('matt');
  });

  it('is stable rather than dependent on arrival order', () => {
    const rows = [
      { score: PICK_SCORE.prefix, label: 'bbb' },
      { score: PICK_SCORE.prefix, label: 'aaa' },
    ];
    expect([...rows].sort(comparePicked).map((row) => row.label)).toEqual(['aaa', 'bbb']);
  });
});
