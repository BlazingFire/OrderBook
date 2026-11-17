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
  colourLabeller,
  colourRepeatsName,
  isNumericSubProduct,
  lineColourText,
  normalizeColours,
  printSideOf,
  resolveLineColour,
  shownColour,
  subProductCells,
} from '../src/index.js';

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

describe("printSideOf: a sub product's own setting, Default keeping today's rule", () => {
  it('resolves Default as numeric to the right and anything else to the left', () => {
    expect(printSideOf('1111', 'default')).toBe('right');
    expect(printSideOf('102 (9")', 'default')).toBe('left');
    expect(printSideOf('MAGENTA', undefined)).toBe('left');
    expect(printSideOf('', 'default')).toBe('left');
  });

  it('lets an explicit Left or Right override the name rule both ways', () => {
    expect(printSideOf('1111', 'left')).toBe('left');
    expect(printSideOf('MAGENTA', 'right')).toBe('right');
  });

  it('drives the PDF cells when a setting is given', () => {
    expect(subProductCells('1111', 'left')).toEqual({ model: '1111', code: null });
    expect(subProductCells('MAGENTA', 'right')).toEqual({ model: null, code: 'MAGENTA' });
    expect(subProductCells('1111', 'default')).toEqual({ model: null, code: '1111' });
  });
});

describe('normalizeColours: the colour list a sub product offers', () => {
  it('trims, drops blanks and duplicates (case aside), and keeps order', () => {
    expect(normalizeColours([' White ', '', 'white', 'Ivory', ' IVORY '])).toEqual([
      'White',
      'Ivory',
    ]);
    expect(normalizeColours([])).toEqual([]);
    expect(normalizeColours(null)).toEqual([]);
    expect(normalizeColours(undefined)).toEqual([]);
  });
});

describe("resolveLineColour: what a line may carry for a sub product's colours", () => {
  it('carries nothing when the sub product offers no colours', () => {
    expect(resolveLineColour([], 'White')).toBeNull();
    expect(resolveLineColour([], null)).toBeNull();
  });

  it("always carries the one colour of a single-colour sub product", () => {
    expect(resolveLineColour(['Magenta'], null)).toBe('Magenta');
    expect(resolveLineColour(['Magenta'], 'White')).toBe('Magenta');
  });

  it('carries a chosen colour that is on the list, in the list spelling', () => {
    expect(resolveLineColour(['White', 'Ivory'], ' ivory ')).toBe('Ivory');
  });

  it('drops a colour that is not offered instead of refusing the line', () => {
    expect(resolveLineColour(['White', 'Ivory'], 'Ochre')).toBeNull();
    expect(resolveLineColour(['White', 'Ivory'], null)).toBeNull();
  });
});

describe('colourLabeller: lines store the VALUE, screens and notes print the LABEL', () => {
  const labelOf = colourLabeller([{ value: 'RED BROWN', label: 'Red Brown' }, { value: 'Ivory', label: 'Ivory' }]);

  it('resolves a stored value to its current label, case aside', () => {
    expect(labelOf('RED BROWN')).toBe('Red Brown');
    expect(labelOf('red brown')).toBe('Red Brown');
  });

  it('prints a value the list no longer has as stored', () => {
    expect(labelOf('Ochre')).toBe('Ochre');
  });

  it('is what lineColourText prints, one colour or several', () => {
    expect(lineColourText([{ colour: 'RED BROWN', quantity: 2 }], 'Rustic', labelOf)).toBe('Red Brown');
    expect(
      lineColourText(
        [
          { colour: 'RED BROWN', quantity: 2 },
          { colour: 'Ivory', quantity: 3 },
        ],
        'Rustic',
        labelOf,
      ),
    ).toBe('Red Brown ×2, Ivory ×3');
  });
});
