/**
 * The two line-item rules the new-lead screen leans on, tested without a
 * database because they are pure and because both are silent when they break.
 *
 *   1. **A rate switched off stays off.** `rate: null` on its own falls through
 *      to the party variant and then the catalogue by design — that fallback is
 *      what keeps an offline draft priced — so a line meant to carry no price
 *      saved at the catalogue rate. `rateUnset` is the flag that stops it.
 *   2. **The colour code survives the merge.** `normalizeQuantities` collapses
 *      duplicate colours, and it used to rebuild the row from `(colour,
 *      quantity)` alone, which dropped the code the counter typed.
 */

import { describe, expect, it } from 'vitest';

import { buildLineSnapshot, normalizeQuantities } from '../src/domain/line-items.js';

const PRODUCT = {
  id: 'PR0000000001',
  name: 'Pedestal standard',
  categoryName: null,
  alias: null,
  rate: 18_000,
  productCode: 'PR-0102',
  sin: null,
  size: null,
  weightKg: null,
  grade: 'Grade A',
  productType: null,
};

const VARIANT = {
  alias: null,
  rate: 17_400,
  size: null,
  sin: null,
  grade: null,
  productType: null,
  weightKg: null,
  productName: null,
};

const ONE_WHITE = [{ colour: 'White', quantity: 4, variantCode: '201' }];

describe('a rate that was switched off', () => {
  it('stays null rather than falling back to the catalogue', () => {
    const line = buildLineSnapshot(
      { productId: PRODUCT.id, rate: null, rateUnset: true, quantities: ONE_WHITE },
      PRODUCT,
      null,
      1,
    );

    expect(line.rate).toBeNull();
  });

  it('stays null rather than falling back to the party variant', () => {
    const line = buildLineSnapshot(
      { productId: PRODUCT.id, rateUnset: true, quantities: ONE_WHITE },
      PRODUCT,
      VARIANT,
      1,
    );

    expect(line.rate).toBeNull();
  });

  it('leaves a line with no rate to be worth nothing at all', () => {
    const line = buildLineSnapshot(
      { productId: PRODUCT.id, rateUnset: true, quantities: ONE_WHITE },
      PRODUCT,
      null,
      1,
    );

    // Null, not zero: nobody has said this line is free, only that its price is
    // still to be agreed.
    expect(line.rate).toBeNull();
  });
});

describe('a rate nobody has typed yet', () => {
  it('still falls back to the party variant, then the catalogue', () => {
    expect(
      buildLineSnapshot({ productId: PRODUCT.id, quantities: ONE_WHITE }, PRODUCT, VARIANT, 1).rate,
    ).toBe(17_400);

    expect(
      buildLineSnapshot({ productId: PRODUCT.id, quantities: ONE_WHITE }, PRODUCT, null, 1).rate,
    ).toBe(18_000);
  });

  it('keeps a rate the panel did send, whatever the catalogue says now', () => {
    const line = buildLineSnapshot(
      { productId: PRODUCT.id, rate: 17_500, quantities: ONE_WHITE },
      PRODUCT,
      VARIANT,
      1,
    );

    expect(line.rate).toBe(17_500);
  });
});

describe('normalizeQuantities', () => {
  it('carries the colour code through onto the stored row', () => {
    expect(normalizeQuantities([{ colour: 'White', quantity: 4, variantCode: '201' }])).toEqual([
      { colour: 'White', quantity: 4, variantCode: '201' },
    ]);
  });

  it('keeps the first code when one colour arrives twice', () => {
    expect(
      normalizeQuantities([
        { colour: 'Grey', quantity: 2, variantCode: '202' },
        { colour: 'Grey', quantity: 3, variantCode: '999' },
      ]),
    ).toEqual([{ colour: 'Grey', quantity: 5, variantCode: '202' }]);
  });

  it('leaves a colour that never had a code as null rather than absent', () => {
    expect(normalizeQuantities([{ colour: 'Ivory', quantity: 1 }])).toEqual([
      { colour: 'Ivory', quantity: 1, variantCode: null },
    ]);
  });

  it('still drops blank colours and non-positive quantities', () => {
    expect(
      normalizeQuantities([
        { colour: '  ', quantity: 5, variantCode: '1' },
        { colour: 'White', quantity: 0, variantCode: '201' },
        { colour: 'White', quantity: -2, variantCode: '201' },
      ]),
    ).toEqual([]);
  });
});
