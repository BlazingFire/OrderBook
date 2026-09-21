/**
 * The product master's fields, and the two ways they could have gone quietly
 * wrong.
 *
 * 1. **A partial write clearing what it was not asked about.** Setting the
 *    reorder level must not null the min and max the screen has never heard of.
 * 2. **A CHECK violation on the offline merge path.** That path has no
 *    validation layer; a constraint error there is recorded as a permanent
 *    rejection and replayed forever, so an offline edit would be destroyed
 *    rather than bounced with a reason. The shared validator runs first.
 *
 * The master is small on purpose (2026-09-21): name, category, alias, size,
 * the colour switch, and the variants' codes, colours and weights. Nothing
 * else is stored, so nothing else is tested here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { ValidationError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import * as inventory from '../src/services/inventory.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let admin: ActorContext;

async function seedProduct() {
  return catalog.createProduct(
    {
      categoryName: 'WATER CLOSET',
      variants: [{ code: 'EWC-S-TRAP', weightKg: 22 }],
      name: 'E.W.C - S TRAP',
      alias: 'EWC S',
      size: 'S trap',
      multiColour: true,
    },
    admin,
  );
}

describe.skipIf(!canRunIntegrationTests)('product attributes (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('stores every field and reads it back', async () => {
    const product = await seedProduct();

    expect(product).toMatchObject({
      name: 'E.W.C - S TRAP',
      categoryName: 'WATER CLOSET',
      alias: 'EWC S',
      size: 'S trap',
      multiColour: true,
      hasVariants: false,
    });
    expect(product.variants.map((variant) => [variant.code, variant.label, variant.weightKg])).toEqual([
      ['EWC-S-TRAP', null, 22],
    ]);
  });

  it('defaults the colour switch to off', async () => {
    const product = await catalog.createProduct(
      { categoryName: 'ONE PIECE TOILET', variants: [{ code: '102' }], name: '102' },
      admin,
    );
    expect(product.multiColour).toBe(false);
  });

  describe('validation refuses a bad value before the database does', () => {
    it.each([
      ['a weight of zero', [{ code: 'BAD-1', weightKg: 0 }]],
      ['a negative weight', [{ code: 'BAD-2', weightKg: -3 }]],
      ['a blank code', [{ code: '   ' }]],
      ['no variants at all', []],
    ])('refuses %s with a readable message', async (_case, variants) => {
      await expect(
        catalog.createProduct({ categoryName: 'Tiles', name: 'Bad Tile', variants }, admin),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('the stock band is a partial patch', () => {
    it('leaves min and max alone when only the reorder level is set', async () => {
      const product = await seedProduct();

      await inventory.setReorderLevel(
        { variantId: product.variants[0]!.id, minStockLevel: 10, maxStockLevel: 100 },
        admin,
      );

      // Exactly what the existing reorder-level screen sends: it knows nothing
      // about min and max and never will.
      const level = await inventory.setReorderLevel(
        { variantId: product.variants[0]!.id, reorderLevel: 25 },
        admin,
      );

      expect(level.reorderLevel).toBe(25);
      expect(level.minStockLevel).toBe(10);
      expect(level.maxStockLevel).toBe(100);
    });

    it('clears a level when told to, which is not the same as omitting it', async () => {
      const product = await seedProduct();

      await inventory.setReorderLevel(
        { variantId: product.variants[0]!.id, minStockLevel: 10 },
        admin,
      );
      const level = await inventory.setReorderLevel(
        { variantId: product.variants[0]!.id, minStockLevel: null },
        admin,
      );

      expect(level.minStockLevel).toBeNull();
    });

    it('refuses a maximum below the minimum', async () => {
      const product = await seedProduct();

      await expect(
        inventory.setReorderLevel(
          { variantId: product.variants[0]!.id, minStockLevel: 50, maxStockLevel: 10 },
          admin,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('search', () => {
    it('finds a product by its alias and its size', async () => {
      await seedProduct();

      expect((await catalog.listProducts({ search: 'EWC S' }, admin)).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'S trap' }, admin)).items).toHaveLength(1);
    });
  });
});
