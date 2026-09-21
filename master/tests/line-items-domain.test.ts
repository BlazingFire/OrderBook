/**
 * The line-item rules the new-lead screen leans on, tested without a
 * database because they are pure and because each is silent when it breaks.
 *
 *   1. **A rate switched off stays off.** `rate: null` on its own falls through
 *      to the party's rate and then the catalogue by design — that fallback is
 *      what keeps an offline draft priced — so a line meant to carry no price
 *      saved at the catalogue rate. `rateUnset` is the flag that stops it.
 *   2. **The code and the weight come from the variant**, never from the
 *      product or the party's rates: a party negotiates a price, not what a
 *      basin weighs.
 *   3. **A missing weight stays missing.** The totals leave it out and count
 *      it, rather than treating an unentered weight as zero.
 */

import { describe, expect, it } from 'vitest';

import { planDispatchMovements, planReservations } from '../src/domain/conversion.js';
import {
  buildLineSnapshot,
  computeTotalWeightKg,
  lineWeightKg,
  linesWithoutWeight,
  normaliseQuantity,
  type LineSnapshot,
} from '../src/domain/line-items.js';

const PRODUCT = {
  id: 'PR0000000001',
  name: 'Pedestal standard',
  categoryName: null,
  alias: null,
  rate: 18_000,
  sin: null,
  size: null,
  grade: 'Grade A',
  productType: null,
};

const WHITE = { id: 'VR0000000001', code: '201', label: 'White', weightKg: 12.5 };
const UNWEIGHED = { id: 'VR0000000002', code: '202', label: 'Blue', weightKg: null };

const PARTY_RATE = {
  alias: null,
  rate: 17_400,
  size: null,
  sin: null,
  grade: null,
  productType: null,
  productName: null,
};

const draft = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT.id,
  variantId: WHITE.id,
  quantity: 4,
  ...overrides,
});

describe('a rate that was switched off', () => {
  it('stays null rather than falling back to the catalogue', () => {
    const line = buildLineSnapshot(draft({ rate: null, rateUnset: true }), PRODUCT, WHITE, null, 1);
    expect(line.rate).toBeNull();
  });

  it('stays null rather than falling back to the party rate', () => {
    const line = buildLineSnapshot(draft({ rateUnset: true }), PRODUCT, WHITE, PARTY_RATE, 1);
    expect(line.rate).toBeNull();
  });
});

describe('a rate nobody has typed yet', () => {
  it('still falls back to the party rate, then the catalogue', () => {
    expect(buildLineSnapshot(draft(), PRODUCT, WHITE, PARTY_RATE, 1).rate).toBe(17_400);
    expect(buildLineSnapshot(draft(), PRODUCT, WHITE, null, 1).rate).toBe(18_000);
  });

  it('keeps a rate the panel did send, whatever the catalogue says now', () => {
    const line = buildLineSnapshot(draft({ rate: 17_500 }), PRODUCT, WHITE, PARTY_RATE, 1);
    expect(line.rate).toBe(17_500);
  });
});

describe('the variant is where the code and the weight come from', () => {
  it('freezes the variant\'s code, label and weight onto the line', () => {
    const line = buildLineSnapshot(draft(), PRODUCT, WHITE, PARTY_RATE, 1);

    expect(line.variantId).toBe(WHITE.id);
    expect(line.code).toBe('201');
    expect(line.variantLabel).toBe('White');
    expect(line.weightKg).toBe(12.5);
    expect(line.quantity).toBe(4);
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

describe('what a line means for stock', () => {
  const lines: LineSnapshot[] = [
    buildLineSnapshot(draft({ quantity: 5 }), PRODUCT, WHITE, null, 1),
    buildLineSnapshot(draft({ variantId: UNWEIGHED.id, quantity: 3 }), PRODUCT, UNWEIGHED, null, 2),
    buildLineSnapshot(draft({ quantity: 2 }), PRODUCT, WHITE, null, 3),
  ];

  it('reserves one hold per line, keyed by the variant', () => {
    expect(planReservations(lines)).toEqual([
      { productId: PRODUCT.id, variantId: WHITE.id, quantity: 5, lineIndex: 0 },
      { productId: PRODUCT.id, variantId: UNWEIGHED.id, quantity: 3, lineIndex: 1 },
      { productId: PRODUCT.id, variantId: WHITE.id, quantity: 2, lineIndex: 2 },
    ]);
  });

  it('sums the holds per variant into one signed movement each on dispatch', () => {
    expect(planDispatchMovements(planReservations(lines))).toEqual([
      { productId: PRODUCT.id, variantId: WHITE.id, quantityBoxes: -7 },
      { productId: PRODUCT.id, variantId: UNWEIGHED.id, quantityBoxes: -3 },
    ]);
  });
});
