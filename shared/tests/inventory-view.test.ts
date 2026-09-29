/**
 * The two pure transforms every stock figure leaves the Master through.
 *
 * `inventory.defaultReorderLevel` exists because `reorder_level` is NULL on
 * every row a stock movement creates, so the Dashboard's "Low stock" tile read
 * 0 until somebody opened each line and typed a number. That fix is one
 * four-line function applied at four call sites, and everything that can go
 * wrong with it is here: overriding a level somebody chose, writing the default
 * onto the row, and a default of zero being read as "no default".
 */

import { describe, expect, it } from 'vitest';

import { withDefaultReorderLevel, withoutReservations } from '../src/index.js';
import type { InventoryStockLevel } from '../src/index.js';

function levelWith(overrides: Partial<InventoryStockLevel> = {}): InventoryStockLevel {
  return {
    productId: 'p1',
    productName: 'DAMRU',
    categoryId: 'c1',
    categoryName: 'ONE PIECE BASIN',
    categoryCode: null,
    brand: null,
    multiColour: false,
    size: '18x12',
    variantId: 'v1',
    variantCode: 'SW-101',
    variantLabel: 'Ivory',
    weightKg: null,
    quantityBoxes: 40,
    reservedBoxes: 10,
    availableBoxes: 30,
    reorderLevel: null,
    minStockLevel: null,
    maxStockLevel: null,
    isLow: false,
    updatedAt: null,
    ...overrides,
  };
}

describe('withDefaultReorderLevel', () => {
  it('judges a line with no level of its own against the company default', () => {
    const low = withDefaultReorderLevel(levelWith({ availableBoxes: 5 }), 10);
    expect(low.isLow).toBe(true);

    const fine = withDefaultReorderLevel(levelWith({ availableBoxes: 40 }), 10);
    expect(fine.isLow).toBe(false);
  });

  it('counts a line sitting exactly on the default as low, like an explicit one', () => {
    expect(withDefaultReorderLevel(levelWith({ availableBoxes: 10 }), 10).isLow).toBe(true);
  });

  it('leaves reorderLevel null, so the drawer field stays blank', () => {
    // If the default were written onto the row, saving anything else on that
    // line would persist it as though somebody had chosen that number for this
    // product — the company default would stop being a default on first edit.
    expect(withDefaultReorderLevel(levelWith({ availableBoxes: 5 }), 10).reorderLevel).toBeNull();
  });

  it('never overrides a level somebody chose, in either direction', () => {
    const chosen = levelWith({ availableBoxes: 30, reorderLevel: 5, isLow: false });
    expect(withDefaultReorderLevel(chosen, 100)).toEqual(chosen);

    const alreadyLow = levelWith({ availableBoxes: 3, reorderLevel: 5, isLow: true });
    expect(withDefaultReorderLevel(alreadyLow, 0)).toEqual(alreadyLow);
  });

  it('changes nothing when no default is set', () => {
    const level = levelWith({ availableBoxes: 0 });
    expect(withDefaultReorderLevel(level, null)).toEqual(level);
  });

  it('treats a default of zero as a real threshold, not as "no default"', () => {
    // The trap this guards: `Number(null)` is 0, so a truthiness check, or a
    // comparison that coerces the absent level, reads "no default" and "flag
    // anything that has run out" as the same thing. Only an empty line is low
    // at zero.
    expect(withDefaultReorderLevel(levelWith({ availableBoxes: 0 }), 0).isLow).toBe(true);
    expect(withDefaultReorderLevel(levelWith({ availableBoxes: 1 }), 0).isLow).toBe(false);
  });

  it('judges the figure the screen is showing when free-to-sell is off', () => {
    // Order matters: the default is applied after `withoutReservations`, so it
    // sees the floor count that panel is displaying rather than the
    // free-to-sell count it is not.
    const level = levelWith({ quantityBoxes: 40, reservedBoxes: 35, availableBoxes: 5 });

    expect(withDefaultReorderLevel(level, 10).isLow).toBe(true);
    expect(withDefaultReorderLevel(withoutReservations(level), 10).isLow).toBe(false);
  });
});
