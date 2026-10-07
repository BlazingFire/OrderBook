/**
 * The line-item rules the new-lead screen leans on, tested without a
 * database because they are pure and because each is silent when it breaks.
 *
 *   1. **The code and the weight come from the variant**, never from the
 *      product or the party's own record: a party has its own name for a
 *      basin, not its own weight for it.
 *   2. **A colour belongs only on a multi-colour product.** The line takes
 *      the colour the panel chose and nothing else — never the variant's own
 *      label copied over — and drops one sent for a model not made in
 *      colours, which would name a colour the factory does not make. Dropped,
 *      not refused: a lead queued offline must not bounce on it
 *      (`docs/catalogue/CATALOGUE_MODEL.md` §2).
 *   3. **A missing weight stays missing.** The totals leave it out and count
 *      it, rather than treating an unentered weight as zero.
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
} from '../src/domain/line-items.js';

const PRODUCT = {
  id: 'PR0000000001',
  name: 'Pedestal standard',
  categoryName: 'One Piece Toilet',
  categoryCode: 'OPT',
  brand: 'Swisware+',
  alias: null,
  size: null,
  multiColour: false,
};

const ANY_COLOUR = { ...PRODUCT, id: 'PR0000000002', name: 'E.W.C - S TRAP', multiColour: true };

const WHITE = { id: 'VR0000000001', code: '201', label: 'White', weightKg: 12.5 };
const UNWEIGHED = { id: 'VR0000000002', code: '202', label: 'Blue', weightKg: null };

const PARTY_RECORD = { alias: 'Ped std', size: '22x17', productName: 'Pedestal (Ganesh)' };

const draft = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT.id,
  variantId: WHITE.id,
  quantity: 4,
  ...overrides,
});

describe('the variant is where the code and the weight come from', () => {
  it("freezes the variant's code, label and weight onto the line", () => {
    const line = buildLineSnapshot(draft(), PRODUCT, WHITE, PARTY_RECORD, 1);

    expect(line.variantId).toBe(WHITE.id);
    expect(line.code).toBe('201');
    expect(line.variantLabel).toBe('White');
    expect(line.weightKg).toBe(12.5);
    expect(line.quantity).toBe(4);
  });

  it("takes the party's own name, alias and size when the lead is party-wise", () => {
    const line = buildLineSnapshot(draft(), PRODUCT, WHITE, PARTY_RECORD, 1);
    expect(line.productName).toBe('Pedestal (Ganesh)');
    expect(line.alias).toBe('Ped std');
    expect(line.size).toBe('22x17');
    expect(line.fromPartyVariant).toBe(true);
  });

  it('keeps the code and weight an offline panel already froze', () => {
    const line = buildLineSnapshot(draft({ code: '201-OLD', weightKg: 11 }), PRODUCT, WHITE, null, 1);
    expect(line.code).toBe('201-OLD');
    expect(line.weightKg).toBe(11);
  });

  it('leaves the weight null when the variant has none — never zero', () => {
    const line = buildLineSnapshot(draft({ variantId: UNWEIGHED.id }), PRODUCT, UNWEIGHED, null, 1);
    expect(line.weightKg).toBeNull();
    expect(lineWeightKg(line)).toBeNull();
  });
});

describe('the colour on a line', () => {
  it('is null unless the panel chose one — the variant label is never copied into it', () => {
    expect(buildLineSnapshot(draft(), ANY_COLOUR, WHITE, null, 1).colour).toBeNull();
    expect(buildLineSnapshot(draft({ colour: '' }), ANY_COLOUR, WHITE, null, 1).colour).toBeNull();
    expect(buildLineSnapshot(draft({ colour: '   ' }), ANY_COLOUR, WHITE, null, 1).colour).toBeNull();
  });

  it('is kept, trimmed, on a multi-colour product', () => {
    const line = buildLineSnapshot(draft({ colour: ' Ivory ' }), ANY_COLOUR, WHITE, null, 1);
    expect(line.colour).toBe('Ivory');
    expect(line.variantLabel).toBe('White');
  });

  it('is dropped, not refused, on a product that is not made in colours', () => {
    const line = buildLineSnapshot(draft({ colour: 'Ivory' }), PRODUCT, WHITE, null, 1);
    expect(line.colour).toBeNull();
    // The rest of the line survives: the lead is taken, only the colour goes.
    expect(line.variantLabel).toBe('White');
    expect(line.quantity).toBe(4);
  });
});

describe('an edit keeps what a line was sold as (W2-1)', () => {
  // A line taken as Ivory on a model made in every colour, before the model
  // was corrected to a fixed White sub product.
  const stored = { id: 'LI0000000001', variantId: WHITE.id, colour: 'Ivory', variantLabel: null };

  it('matches a resent line by variant and colour, and by id when one is sent', () => {
    expect(matchExistingLines([draft({ colour: 'ivory' })], [stored])).toEqual([stored]);
    expect(matchExistingLines([draft({ id: stored.id, colour: null })], [stored])).toEqual([stored]);
    // Another colour, or another variant, is a new line.
    expect(matchExistingLines([draft({ colour: 'Red' })], [stored])).toEqual([null]);
    expect(matchExistingLines([draft({ variantId: UNWEIGHED.id, colour: 'Ivory' })], [stored])).toEqual([null]);
  });

  it('gives each stored line to one draft only', () => {
    expect(matchExistingLines([draft({ colour: 'Ivory' }), draft({ colour: 'Ivory' })], [stored])).toEqual([
      stored,
      null,
    ]);
  });

  it('keeps the stored colour and colour text on a product that is no longer multi-colour', () => {
    const line = buildLineSnapshot(draft({ colour: 'Ivory', variantLabel: null }), PRODUCT, WHITE, null, 1, stored);
    expect(line.colour).toBe('Ivory');
    expect(line.variantLabel).toBeNull();
  });

  it('still drops a colour on a NEW line of such a product', () => {
    const line = buildLineSnapshot(draft({ colour: 'Ivory', variantLabel: null }), PRODUCT, WHITE, null, 1, null);
    expect(line.colour).toBeNull();
    expect(line.variantLabel).toBe('White');
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
    const line = buildLineSnapshot(draft(), PRODUCT, WHITE, null, 1);
    expect(line.categoryName).toBe('One Piece Toilet');
    expect(line.categoryCode).toBe('OPT');
    expect(line.brandName).toBe('Swisware+');
  });

  it("keep what an offline panel froze, like every other snapshot field", () => {
    const line = buildLineSnapshot(
      draft({ categoryCode: 'OPT-OLD', brandName: 'Swisware' }),
      PRODUCT,
      WHITE,
      null,
      1,
    );
    expect(line.categoryCode).toBe('OPT-OLD');
    expect(line.brandName).toBe('Swisware');
  });

  it('stay null for a category from before catalogue v2', () => {
    const line = buildLineSnapshot(draft(), { ...PRODUCT, categoryCode: null, brand: null }, WHITE, null, 1);
    expect(line.categoryCode).toBeNull();
    expect(line.brandName).toBeNull();
  });
});

describe('the grade on a line', () => {
  it('is only ever what the panel sent — nothing in the catalogue carries one', () => {
    expect(buildLineSnapshot(draft(), PRODUCT, WHITE, PARTY_RECORD, 1).grade).toBeNull();
    expect(buildLineSnapshot(draft({ grade: '' }), PRODUCT, WHITE, null, 1).grade).toBeNull();
    expect(buildLineSnapshot(draft({ grade: '   ' }), PRODUCT, WHITE, null, 1).grade).toBeNull();
  });

  it('is kept, trimmed, on any product — a grade is not a colour', () => {
    // Unlike the colour above, a grade needs no switch on the product: it says
    // what *this line* was sold as, so the same variant may go out as A on one
    // lead and B on another.
    expect(buildLineSnapshot(draft({ grade: ' A ' }), PRODUCT, WHITE, null, 1).grade).toBe('A');
    expect(buildLineSnapshot(draft({ grade: 'B' }), ANY_COLOUR, WHITE, null, 1).grade).toBe('B');
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
      buildLineSnapshot(draft({ quantity: 10 }), PRODUCT, WHITE, null, 1),
      buildLineSnapshot(draft({ variantId: UNWEIGHED.id, quantity: 3 }), PRODUCT, UNWEIGHED, null, 2),
    ];

    expect(computeTotalWeightKg(lines)).toBe(125);
    expect(linesWithoutWeight(lines)).toBe(1);
  });
});
