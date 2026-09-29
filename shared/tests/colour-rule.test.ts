/**
 * The colour rules and the lead PDF cells built on them
 * (`docs/catalogue/CATALOGUE_MODEL.md` §2, §8).
 *
 * Pure, and shared by the Master, both panels' screens and the PDF — which is
 * why the cases the owner named are pinned here once rather than re-derived in
 * each place: `1111` prints in Code, `102 (9")` in Model, `MAGENTA` in
 * Magenta shows no colour, and a numbered designer piece shows none at all.
 */

import { describe, expect, it } from 'vitest';

import {
  colourRepeatsName,
  colourRuleOf,
  isNumericSubProduct,
  lineColourText,
  shownColour,
  subProductCells,
} from '../src/index.js';

describe('colourRuleOf derives the rule from what the product master stores', () => {
  it('is selectable for a multi-colour sub product', () => {
    expect(colourRuleOf({ multiColour: true, variants: [{ label: null }] })).toBe('selectable');
    // The switch wins over a label: the spec's formula tests `multiColour` first.
    expect(colourRuleOf({ multiColour: true, variants: [{ label: 'White' }] })).toBe('selectable');
  });

  it('is fixed when the one variant is labelled with its colour', () => {
    expect(colourRuleOf({ multiColour: false, variants: [{ label: 'White' }] })).toBe('fixed');
  });

  it('is dedicated with no label, a blank label, or no variant at all', () => {
    expect(colourRuleOf({ multiColour: false, variants: [{ label: null }] })).toBe('dedicated');
    expect(colourRuleOf({ multiColour: false, variants: [{ label: '  ' }] })).toBe('dedicated');
    expect(colourRuleOf({ multiColour: false, variants: [] })).toBe('dedicated');
  });
});

describe('a colour that only repeats the name is not shown', () => {
  it('matches case-insensitively and after trimming', () => {
    expect(colourRepeatsName('Magenta', 'MAGENTA')).toBe(true);
    expect(colourRepeatsName(' magenta ', 'Magenta')).toBe(true);
    expect(colourRepeatsName('White', '102 (9")')).toBe(false);
    expect(colourRepeatsName(null, '')).toBe(false);
  });

  it('shows the colour otherwise, trimmed, and nothing for a blank one', () => {
    expect(shownColour('Magenta', 'MAGENTA')).toBeNull();
    expect(shownColour(' White ', '102 (9")')).toBe('White');
    expect(shownColour('', 'X')).toBeNull();
    expect(shownColour(null, 'X')).toBeNull();
  });
});

describe('which PDF column a sub product prints in', () => {
  it('puts a plain number in Code and anything else in Model', () => {
    expect(subProductCells('1111')).toEqual({ model: null, code: '1111' });
    expect(subProductCells(' 41 ')).toEqual({ model: null, code: '41' });
    expect(subProductCells('102 (9")')).toEqual({ model: '102 (9")', code: null });
    expect(subProductCells('E-01')).toEqual({ model: 'E-01', code: null });
    expect(subProductCells('')).toEqual({ model: null, code: null });
  });

  it('calls only a plain number numeric', () => {
    expect(isNumericSubProduct('7511')).toBe(true);
    expect(isNumericSubProduct('12X9')).toBe(false);
    expect(isNumericSubProduct('1.5')).toBe(false);
    expect(isNumericSubProduct(null)).toBe(false);
  });
});

describe('the Colour cell', () => {
  it("prints a fixed sub product's variant colour, and not when it repeats the name", () => {
    expect(lineColourText([{ variantLabel: 'White', quantity: 4 }], '102 (9")')).toBe('White');
    expect(lineColourText([{ variantLabel: 'Magenta', quantity: 1 }], 'MAGENTA')).toBe('');
  });

  it('prints nothing for a dedicated line', () => {
    expect(lineColourText([{ colour: null, variantLabel: null, quantity: 3 }], '1111')).toBe('');
  });

  it("groups a multicolour sub product's lines with their quantities, in line order", () => {
    const lines = [
      { colour: 'White', quantity: 10 },
      { colour: 'Ivory', quantity: 5 },
    ];
    expect(lineColourText(lines, '20" O.P')).toBe('White ×10, Ivory ×5');
  });

  it('sums two lines of the same colour, and one colour alone prints without a count', () => {
    const lines = [
      { colour: 'White', quantity: 10 },
      { colour: 'white', quantity: 5 },
      { colour: 'Ivory', quantity: 1 },
    ];
    expect(lineColourText(lines, 'X')).toBe('White ×15, Ivory ×1');
    expect(lineColourText(lines.slice(0, 2), 'X')).toBe('White');
  });

  it('prefers the colour chosen on the line over the variant label', () => {
    expect(lineColourText([{ colour: 'Ivory', variantLabel: 'White', quantity: 1 }], 'X')).toBe(
      'Ivory',
    );
  });
});
