/**
 * The line-item rules the new-lead screen leans on, tested without a
 * database because they are pure and because each is silent when it breaks.
 *
 *   1. **The code and the weight come from the sub product**, never from
 *      the party's own record: a party has its own name for a basin, not
 *      its own weight for it.
 *   2. **A colour belongs only where the sub product offers it.** One
 *      colour offered means the line always carries it; several means the
 *      chosen one; one sent for a sub product that does not offer it is
 *      dropped, not refused — a lead queued offline must not bounce on it
 *      (`docs/catalogue/CATALOGUE_MODEL.md` §2).
 *   3. **A missing weight stays missing.** The totals leave it out and count
 *      it, rather than treating an unentered weight as zero.
 *   4. **The print side freezes resolved**: the sub product's setting, with
 *      Default following the name (a plain number right, anything else left).
 */

import { describe, expect, it } from 'vitest';

import {
  buildLineSnapshot,
  computeTotalWeightKg,
  listedColour,
  matchExistingLines,
  lineWeightKg,
  linesWithoutWeight,
  normaliseQuantity,
  type LineSnapshot,
  type ProductSnapshotSource,
} from '../src/domain/line-items.js';

const PRODUCT: ProductSnapshotSource = {
  id: 'PR0000000001',
  name: 'Pedestal standard',
  categoryName: 'One Piece Toilet',
  categoryCode: 'OPT',
  brand: 'Swisware+',
  alias: null,
  size: null,
  code: '201',
  weightKg: 12.5,
  colours: ['White'],
  printSide: 'default',
};

const ANY_COLOUR: ProductSnapshotSource = {
  ...PRODUCT,
  id: 'PR0000000002',
  name: 'E.W.C - S TRAP',
  colours: ['White', 'Ivory', 'Blue'],
};

const NO_COLOUR: ProductSnapshotSource = { ...PRODUCT, colours: [] };
const UNWEIGHED: ProductSnapshotSource = { ...PRODUCT, id: 'PR0000000003', code: '202', weightKg: null };

const PARTY_RECORD = { alias: 'Ped std', size: '22x17', productName: 'Pedestal (Ganesh)' };

const draft = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT.id,
  quantity: 4,
  ...overrides,
});

describe('the sub product is where the code and the weight come from', () => {
  it("freezes the sub product's code, colour and weight onto the line", () => {
    const line = buildLineSnapshot(draft(), PRODUCT, PARTY_RECORD, 1);

    expect(line.variantId).toBeNull();
    expect(line.code).toBe('201');
    expect(line.colour).toBe('White');
    expect(line.variantLabel).toBeNull();
    expect(line.weightKg).toBe(12.5);
    expect(line.quantity).toBe(4);
  });

  it("takes the party's own name, alias and size when the lead is party-wise", () => {
    const line = buildLineSnapshot(draft(), PRODUCT, PARTY_RECORD, 1);
    expect(line.productName).toBe('Pedestal (Ganesh)');
    expect(line.alias).toBe('Ped std');
    expect(line.size).toBe('22x17');
    expect(line.fromPartyVariant).toBe(true);
  });

  it('keeps the code and weight an offline panel already froze', () => {
    const line = buildLineSnapshot(draft({ code: '201-OLD', weightKg: 11 }), PRODUCT, null, 1);
    expect(line.code).toBe('201-OLD');
    expect(line.weightKg).toBe(11);
  });

  it('leaves the weight null when the sub product has none — never zero', () => {
    const line = buildLineSnapshot(draft({ productId: UNWEIGHED.id }), UNWEIGHED, null, 1);
    expect(line.weightKg).toBeNull();
    expect(lineWeightKg(line)).toBeNull();
  });

  it('freezes a legacy variant reference a queued older panel sent', () => {
    const line = buildLineSnapshot(draft({ variantId: 'VR0000000001' }), PRODUCT, null, 1);
    expect(line.variantId).toBe('VR0000000001');
  });
});

describe('the colour on a line', () => {
  it('is null on a several-colours sub product until one is chosen', () => {
    expect(buildLineSnapshot(draft(), ANY_COLOUR, null, 1).colour).toBeNull();
    expect(buildLineSnapshot(draft({ colour: '' }), ANY_COLOUR, null, 1).colour).toBeNull();
    expect(buildLineSnapshot(draft({ colour: '   ' }), ANY_COLOUR, null, 1).colour).toBeNull();
  });

  it('is the one colour, always, on a single-colour sub product', () => {
    expect(buildLineSnapshot(draft(), PRODUCT, null, 1).colour).toBe('White');
    expect(buildLineSnapshot(draft({ colour: 'Ivory' }), PRODUCT, null, 1).colour).toBe('White');
  });

  it('is kept, in the offered spelling, where several colours are offered', () => {
    const line = buildLineSnapshot(draft({ colour: ' ivory ' }), ANY_COLOUR, null, 1);
    expect(line.colour).toBe('Ivory');
  });

  it('is dropped, not refused, where the sub product offers no colours', () => {
    const line = buildLineSnapshot(draft({ colour: 'Ivory' }), NO_COLOUR, null, 1);
    expect(line.colour).toBeNull();
    // The rest of the line survives: the lead is taken, only the colour goes.
    expect(line.quantity).toBe(4);
  });

  it('is dropped where the chosen colour is not among those offered', () => {
    expect(buildLineSnapshot(draft({ colour: 'Ochre' }), ANY_COLOUR, null, 1).colour).toBeNull();
  });
});

describe('the print side on a line', () => {
  it('resolves Default by the name: a plain number right, a name left', () => {
    expect(buildLineSnapshot(draft(), PRODUCT, null, 1).printSide).toBe('left');
    expect(
      buildLineSnapshot(draft(), { ...PRODUCT, name: '1111' }, null, 1).printSide,
    ).toBe('right');
  });

  it("takes the sub product's own side over the name rule, both ways", () => {
    expect(
      buildLineSnapshot(draft(), { ...PRODUCT, name: '1111', printSide: 'left' }, null, 1)
        .printSide,
    ).toBe('left');
    expect(
      buildLineSnapshot(draft(), { ...PRODUCT, printSide: 'right' }, null, 1).printSide,
    ).toBe('right');
  });

  it('keeps a side the panel froze over one resolved now', () => {
    expect(buildLineSnapshot(draft({ printSide: 'right' }), PRODUCT, null, 1).printSide).toBe(
      'right',
    );
  });
});

describe('an edit keeps what a line was sold as (W2-1)', () => {
  // A line taken as Ivory on a model offered in every colour, before the
  // model was corrected to a single-colour White sub product.
  const stored = {
    id: 'LI0000000001',
    productId: PRODUCT.id,
    variantId: 'VR0000000001',
    colour: 'Ivory',
    variantLabel: null,
  };

  it('matches a resent line by sub product and colour, and by id when one is sent', () => {
    expect(matchExistingLines([draft({ colour: 'ivory' })], [stored])).toEqual([stored]);
    expect(matchExistingLines([draft({ id: stored.id, colour: null })], [stored])).toEqual([stored]);
    // Another colour, or another legacy variant, is a new line.
    expect(matchExistingLines([draft({ colour: 'Red' })], [stored])).toEqual([null]);
    expect(
      matchExistingLines([draft({ variantId: 'VR0000000002', colour: 'Ivory' })], [stored]),
    ).toEqual([null]);
  });

  it('gives each stored line to one draft only', () => {
    expect(matchExistingLines([draft({ colour: 'Ivory' }), draft({ colour: 'Ivory' })], [stored])).toEqual([
      stored,
      null,
    ]);
  });

  it('keeps the stored colour on a sub product that no longer lets one be chosen', () => {
    const line = buildLineSnapshot(draft({ colour: 'Ivory', variantLabel: null }), PRODUCT, null, 1, stored);
    expect(line.colour).toBe('Ivory');
    expect(line.variantLabel).toBeNull();
  });

  it('still resolves a NEW line of such a sub product to its one colour', () => {
    const line = buildLineSnapshot(draft({ colour: 'Ivory', variantLabel: null }), PRODUCT, null, 1, null);
    expect(line.colour).toBe('White');
    expect(line.variantLabel).toBeNull();
  });
});

describe('a new colour is spelled as the company list has it', () => {
  const list = [
    { value: 'Ivory', label: 'Ivory' },
    { value: 'RED BROWN', label: 'Red Brown' },
  ];

  it('matches the value or the label, case and spacing aside, and answers the VALUE', () => {
    expect(listedColour(' ivory ', list)).toBe('Ivory');
    expect(listedColour('red brown', list)).toBe('RED BROWN');
  });

  it('answers undefined for a colour the list does not have', () => {
    expect(listedColour('Blue', list)).toBeUndefined();
  });
});

describe('the brand and the product code on a line', () => {
  it('are frozen from the category when the panel sent none', () => {
    const line = buildLineSnapshot(draft(), PRODUCT, null, 1);
    expect(line.categoryName).toBe('One Piece Toilet');
    expect(line.categoryCode).toBe('OPT');
    expect(line.brandName).toBe('Swisware+');
  });

  it("keep what an offline panel froze, like every other snapshot field", () => {
    const line = buildLineSnapshot(
      draft({ categoryCode: 'OPT-OLD', brandName: 'Swisware' }),
      PRODUCT,
      null,
      1,
    );
    expect(line.categoryCode).toBe('OPT-OLD');
    expect(line.brandName).toBe('Swisware');
  });

  it('stay null for a category from before catalogue v2', () => {
    const line = buildLineSnapshot(draft(), { ...PRODUCT, categoryCode: null, brand: null }, null, 1);
    expect(line.categoryCode).toBeNull();
    expect(line.brandName).toBeNull();
  });
});

describe('the grade on a line', () => {
  it('is only ever what the panel sent — nothing in the catalogue carries one', () => {
    expect(buildLineSnapshot(draft(), PRODUCT, PARTY_RECORD, 1).grade).toBeNull();
    expect(buildLineSnapshot(draft({ grade: '' }), PRODUCT, null, 1).grade).toBeNull();
    expect(buildLineSnapshot(draft({ grade: '   ' }), PRODUCT, null, 1).grade).toBeNull();
  });

  it('is kept, trimmed, on any product — a grade is not a colour', () => {
    // Unlike the colour above, a grade needs no offer on the product: it says
    // what *this line* was sold as, so the same sub product may go out as A
    // on one lead and B on another.
    expect(buildLineSnapshot(draft({ grade: ' A ' }), PRODUCT, null, 1).grade).toBe('A');
    expect(buildLineSnapshot(draft({ grade: 'B' }), ANY_COLOUR, null, 1).grade).toBe('B');
  });
});

describe('quantities and weights', () => {
  it('treats a blank, negative or unparsable quantity as nothing entered', () => {
    expect(normaliseQuantity('')).toBe(0);
    expect(normaliseQuantity(-2)).toBe(0);
    expect(normaliseQuantity('abc')).toBe(0);
    expect(normaliseQuantity('12')).toBe(12);
  });

  it('multiplies weight by quantity to three decimals', () => {
    expect(lineWeightKg({ weightKg: 32.5, quantity: 10 })).toBe(325);
    expect(lineWeightKg({ weightKg: 0.1, quantity: 3 })).toBe(0.3);
  });

  it('totals only the weighed lines and counts the rest', () => {
    const lines: LineSnapshot[] = [
      buildLineSnapshot(draft({ quantity: 10 }), PRODUCT, null, 1),
      buildLineSnapshot(draft({ productId: UNWEIGHED.id, quantity: 3 }), UNWEIGHED, null, 2),
    ];

    expect(computeTotalWeightKg(lines)).toBe(125);
    expect(linesWithoutWeight(lines)).toBe(1);
  });
});
