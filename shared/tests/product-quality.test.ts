/**
 * Product data-quality suspects (docs/PRODUCT_CONFLICTS.md §D, §F).
 *
 * Pure detectors: same inputs, same findings, no database. The conflicts tab
 * runs them over the loaded catalogue; the import review uses the rename/move
 * checks per row.
 */

import { describe, expect, it } from 'vitest';

import {
  aliasCollision,
  colourRuleContradiction,
  importMoveSuspect,
  importRenameSuspect,
  isCodeVariant,
  isNearName,
  levenshtein,
  normalizeSize,
  orphanColour,
  qualitySuspects,
  sizeDriftVariants,
  weightSwing,
} from '../src/domain/product-quality.js';

describe('levenshtein + isNearName (A8)', () => {
  it('measures edits and flags likely typos only', () => {
    expect(levenshtein('damru', 'damruu')).toBe(1);
    expect(levenshtein('1111', '1112')).toBe(1);
    expect(levenshtein('abc', 'xyz')).toBe(3);
    expect(isNearName('damru', 'damruu')).toBe(true);
    expect(isNearName('1111', '1112')).toBe(true);
    // Not typos: identical, too short, too far, or length classes apart.
    expect(isNearName('damru', 'damru')).toBe(false);
    expect(isNearName('ab', 'ac')).toBe(false);
    expect(isNearName('damru', 'dammarrux')).toBe(false);
    expect(isNearName('washbasin', 'washingmachine')).toBe(false);
  });
});

describe('isCodeVariant (A9)', () => {
  it('matches separator, case and padding variants of the same code', () => {
    expect(isCodeVariant('OPT-0001', 'OPT0001')).toBe(true);
    expect(isCodeVariant('OPT-0001', 'opt-001')).toBe(true);
    expect(isCodeVariant('WB-0042', 'wb0042')).toBe(true);
    expect(isCodeVariant('OPT-0001', 'OPT-0002')).toBe(false);
    expect(isCodeVariant('OPT-0001', 'KAJ-0001')).toBe(false);
    expect(isCodeVariant('OPT-0001', 'OPT-0001')).toBe(false);
    expect(isCodeVariant('ABC', 'ABC1')).toBe(false);
  });
});

describe('weightSwing (D3)', () => {
  it('fires only past a 50% move on known weights', () => {
    expect(weightSwing(20, 25)).toBe(false);
    expect(weightSwing(20, 31)).toBe(true);
    expect(weightSwing(20, 9)).toBe(true);
    expect(weightSwing(20, 20)).toBe(false);
    expect(weightSwing(null, 5)).toBe(false);
    expect(weightSwing(20, null)).toBe(false);
    expect(weightSwing(0, 5)).toBe(false);
  });
});

describe('orphanColour (D4)', () => {
  it('flags labels the list does not hold', () => {
    const colours = new Set(['white', 'ivory']);
    expect(orphanColour('White', colours)).toBe(false);
    expect(orphanColour('Magenta', colours)).toBe(true);
    expect(orphanColour(null, colours)).toBe(false);
    expect(orphanColour('  ', colours)).toBe(false);
  });
});

describe('sizeDriftVariants (D5)', () => {
  it('groups sizes that normalize the same but print differently', () => {
    const groups = sizeDriftVariants([
      { id: 'a', size: '600x600' },
      { id: 'b', size: '600X600' },
      { id: 'c', size: '600 x 600' },
      { id: 'd', size: '300x300' },
      { id: 'e', size: null },
    ]);
    expect(groups).toEqual([['600x600', '600X600', '600 x 600']]);
  });
});

describe('aliasCollision (D6)', () => {
  it('fires when the alias equals another name or code in the brand', () => {
    const neighbours = [
      { name: 'One Piece Toilet', codes: ['OPT-0001'], brand: 'Swisware+' },
      { name: 'DAMRU', codes: ['OPT-0002'], brand: 'Other' },
    ];
    expect(aliasCollision('opt-0001', neighbours, 'Swisware+')).toBe(true);
    expect(aliasCollision('One Piece Toilet', neighbours, 'Swisware+')).toBe(true);
    expect(aliasCollision('One Piece Toilet', neighbours, 'Other')).toBe(false);
    expect(aliasCollision(null, neighbours, 'Swisware+')).toBe(false);
    expect(aliasCollision('Fresh', neighbours, 'Swisware+')).toBe(false);
  });
});

describe('colourRuleContradiction (D7/D8)', () => {
  it('flags fixed-without-colour and dedicated-with-colour', () => {
    expect(colourRuleContradiction('fixed', [])).toBe('fixed-without-colour');
    expect(colourRuleContradiction('fixed', [{ label: 'White' }])).toBeNull();
    expect(colourRuleContradiction('dedicated', [{ label: 'White' }])).toBe('dedicated-with-colour');
    expect(colourRuleContradiction('dedicated', [])).toBeNull();
  });
});

describe('importRenameSuspect + importMoveSuspect (F4/F5)', () => {
  it('flags a same-name different-code row as a rename suspect', () => {
    const stored = { name: 'DAMRU', brand: 'Swisware+', codes: ['OPT-0002'] };
    expect(importRenameSuspect('DAMRU', 'Swisware+', 'OPT-0099', stored)).toBe(true);
    expect(importRenameSuspect('DAMRU', 'Swisware+', 'OPT-0002', stored)).toBe(false);
    expect(importRenameSuspect('OTHER', 'Swisware+', 'OPT-0099', stored)).toBe(false);
    expect(importRenameSuspect('DAMRU', 'Other', 'OPT-0099', stored)).toBe(false);
    expect(importRenameSuspect('DAMRU', 'Swisware+', '', stored)).toBe(false);
  });

  it('flags a same-name other-Product row as a move suspect', () => {
    expect(importMoveSuspect('DAMRU', 'cat-b', { name: 'DAMRU', categoryId: 'cat-a' })).toBe(true);
    expect(importMoveSuspect('DAMRU', 'cat-a', { name: 'DAMRU', categoryId: 'cat-a' })).toBe(false);
    expect(importMoveSuspect('OTHER', 'cat-b', { name: 'DAMRU', categoryId: 'cat-a' })).toBe(false);
    expect(importMoveSuspect('', 'cat-b', { name: 'DAMRU', categoryId: 'cat-a' })).toBe(false);
  });
});

describe('qualitySuspects', () => {
  it('collects row-level findings with product identity', () => {
    const found = qualitySuspects(
      {
        id: 'p1',
        name: 'DAMRU',
        size: null,
        alias: 'OPT-0002',
        categoryId: 'c1',
        brand: 'Swisware+',
        colourRule: 'fixed',
        variants: [{ id: 'v1', code: 'OPT-0002', label: null, weightKg: null }],
      },
      [{ id: 'p2', name: 'Other', categoryId: 'c1', brand: 'Swisware+', codes: ['OPT-0002'] }],
      new Set(['white']),
    );
    expect(found.map((suspect) => suspect.kind).sort()).toEqual([
      'alias-collision',
      'fixed-without-colour',
    ]);
    expect(found[0]).toMatchObject({ productId: 'p1', productName: 'DAMRU' });
  });

  it('returns nothing for a clean product', () => {
    expect(
      qualitySuspects(
        {
          id: 'p1',
          name: 'DAMRU',
          size: '600x600',
          alias: null,
          categoryId: 'c1',
          brand: 'Swisware+',
          colourRule: 'fixed',
          variants: [{ id: 'v1', code: 'OPT-0002', label: 'White', weightKg: 20 }],
        },
        [],
        new Set(['white']),
      ),
    ).toEqual([]);
  });
});

describe('normalizeSize', () => {
  it('folds spacing, case and separator width', () => {
    expect(normalizeSize('600X600')).toBe('600x600');
    expect(normalizeSize('600 x 600')).toBe('600x600');
    expect(normalizeSize(null)).toBe('');
  });
});
