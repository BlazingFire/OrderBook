/**
 * The managed option-list sets the Fields screen is drawn from.
 *
 * `product.brand` came back with catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md`
 * §1): brands are option-list values, so the set has to be served, labelled in
 * both languages, and plain text — a brand has no swatch.
 */

import { describe, expect, it } from 'vitest';

import { EN_MESSAGES, FIELD_LIST_KEYS, buildFieldCatalogue, isFieldListKey } from '../src/index.js';

describe('the field sets', () => {
  const { sets } = buildFieldCatalogue();

  it('serve exactly one set per list key', () => {
    expect(sets.map((set) => set.listKey)).toEqual([...FIELD_LIST_KEYS]);
  });

  it('label every set in English', () => {
    for (const set of sets) {
      expect(EN_MESSAGES[set.labelToken], set.listKey).toBeTruthy();
    }
  });

  it('include product.brand, used by products and without a hex', () => {
    expect(isFieldListKey('product.brand')).toBe(true);
    expect(sets.find((set) => set.listKey === 'product.brand')).toEqual({
      listKey: 'product.brand',
      labelToken: 'fieldSet.product.brand',
      hasHex: false,
      usedBy: ['products'],
    });
  });
});
