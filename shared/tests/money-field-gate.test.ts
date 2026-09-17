/**
 * Which money fields a caller without the permission may set.
 *
 * Pure, so it runs everywhere — which matters, because the gap this pins was
 * invisible for exactly the opposite reason. `entities.ts` and `visibility.ts`
 * both *documented* `mrp` as "writable only under `field.saleRate.edit`", and
 * no code implemented it: `withPermittedRate` destructured `rate` alone. Three
 * services share this function (`catalog.service.ts`'s create and update, and
 * `upsertVariant`), so a role with `products.edit` and no money permission
 * could change a product's MRP through every write path the product has, and
 * `pricePerSqft` through the catalogue screen and an offline sync push.
 *
 * Dropping rather than rejecting is the deliberate part and is asserted here
 * too: an Office panel replaying a day-old draft legitimately carries whatever
 * the catalogue held then, and refusing the whole mutation would throw away
 * work somebody did in good faith. The field falls back to the variant or the
 * catalogue — the value the actor was entitled to anyway.
 */

import { describe, expect, it } from 'vitest';

import { withPermittedPurchaseRate, withPermittedRate } from '../src/domain/visibility.js';

describe('withPermittedRate', () => {
  it('passes everything through for somebody who holds the permission', () => {
    const draft = { rate: 42_000, mrp: 50_000, pricePerSqft: 1_200, name: 'Glazed Tile' };

    expect(withPermittedRate(draft, true)).toEqual(draft);
  });

  it.each(['rate', 'mrp', 'pricePerSqft'] as const)('drops %s without the permission', (field) => {
    const draft = { rate: 42_000, mrp: 50_000, pricePerSqft: 1_200, name: 'Glazed Tile' };

    const permitted = withPermittedRate(draft, false) as Record<string, unknown>;

    // Removed, not nulled: a null is an assertion that the value is empty, and
    // `columnPatch` would write it.
    expect(field in permitted).toBe(false);
    // Everything that is not a price survives.
    expect(permitted.name).toBe('Glazed Tile');
  });

  it('drops rateUnset with the rate', () => {
    // Deciding a line carries *no* price is as much a rate decision as typing
    // one, and the more consequential of the two — it stops the catalogue
    // fallback this function otherwise leans on.
    const permitted = withPermittedRate({ rateUnset: true, name: 'Tile' }, false) as Record<
      string,
      unknown
    >;

    expect('rateUnset' in permitted).toBe(false);
  });

  it('leaves a draft that asserts no money field untouched', () => {
    // The identity shortcut, so an ordinary edit is not needlessly copied.
    // Typed with the optional money keys present-but-absent, because the
    // signature requires a draft that *could* carry one — which is exactly the
    // shape a real partial product patch has.
    const draft: { rate?: number | null; name: string } = { name: 'Tile' };

    expect(withPermittedRate(draft, false)).toBe(draft);
  });

  it('does not invent keys the draft never had', () => {
    const permitted = withPermittedRate({ mrp: 50_000 }, false);

    expect(Object.keys(permitted)).toEqual([]);
  });
});

describe('withPermittedPurchaseRate', () => {
  it('drops the cost price without the permission and keeps it with', () => {
    const draft = { purchaseRate: 25_000, name: 'Tile' };

    expect('purchaseRate' in (withPermittedPurchaseRate(draft, false) as object)).toBe(false);
    expect(withPermittedPurchaseRate(draft, true)).toEqual(draft);
  });

  it('is a separate question from the sale rate', () => {
    // Two permissions because they are two decisions: what the shop charges is
    // not what the shop paid.
    const draft = { rate: 42_000, purchaseRate: 25_000 };

    const saleOnly = withPermittedPurchaseRate(withPermittedRate(draft, true), false) as Record<
      string,
      unknown
    >;
    expect(saleOnly.rate).toBe(42_000);
    expect('purchaseRate' in saleOnly).toBe(false);

    const costOnly = withPermittedPurchaseRate(withPermittedRate(draft, false), true) as Record<
      string,
      unknown
    >;
    expect('rate' in costOnly).toBe(false);
    expect(costOnly.purchaseRate).toBe(25_000);
  });
});
