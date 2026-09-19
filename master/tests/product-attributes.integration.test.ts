/**
 * The trade and ceramic attributes, and the three ways they could have gone
 * quietly wrong.
 *
 * 1. **Cost leaking through the sale-rate gate.** What the company pays is a
 *    different secret with a different audience from what it charges, and the
 *    two used to be one boolean.
 * 2. **A partial write clearing what it was not asked about.** Setting the
 *    reorder level must not null the min and max the screen has never heard of.
 * 3. **A CHECK violation on the offline merge path.** That path has no
 *    validation layer; a constraint error there is recorded as a permanent
 *    rejection and replayed forever, so an offline edit would be destroyed
 *    rather than bounced with a reason.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ValidationError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import * as inventory from '../src/services/inventory.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

let admin: ActorContext;

async function seedProduct() {
  return catalog.createProduct(
    {
      categoryName: 'Tiles',
      variants: [{ code: 'ATTR-1' }],
      name: 'Glazed Vitrified Tile',
      rate: 42_000,
      mrp: 55_000,
      purchaseRate: 31_000,
      gstRatePct: 18,
      uom: 'box',
      barcode: '8901234567890',
      brand: 'Kajaria',
      shade: 'Ivory Light',
      calibre: 'C2',
      waterAbsorptionPct: 0.5,
      peiRating: 4,
      edgeType: 'rectified',
      surfaceTexture: 'Matt',
      application: 'floor_wall',
      originPlant: 'Morbi II',
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

  it('stores every attribute and reads it back', async () => {
    const product = await seedProduct();

    expect(product).toMatchObject({
      mrp: 55_000,
      purchaseRate: 31_000,
      gstRatePct: 18,
      uom: 'box',
      barcode: '8901234567890',
      brand: 'Kajaria',
      shade: 'Ivory Light',
      calibre: 'C2',
      waterAbsorptionPct: 0.5,
      peiRating: 4,
      edgeType: 'rectified',
      surfaceTexture: 'Matt',
      application: 'floor_wall',
      originPlant: 'Morbi II',
    });
  });

  describe('the two price gates are independent', () => {
    it('withholds the purchase rate from somebody who may see the sale rate', async () => {
      await seedProduct();

      const desk = await actorWith(['products.view', 'field.saleRate.view']);
      const page = await catalog.listProducts({}, desk);
      const product = page.items[0]!;

      // Absent, not null. `purchaseRate: null` is a factual claim that the
      // product cost nothing, and a client would total it in good faith.
      expect('purchaseRate' in product).toBe(false);
      expect(product.rate).toBe(42_000);
      // MRP is printed on the box; hiding it would be theatre.
      expect(product.mrp).toBe(55_000);
    });

    it('withholds the sale rate but keeps the purchase rate for a buyer', async () => {
      await seedProduct();

      const buyer = await actorWith(['products.view', 'field.purchaseRate.view']);
      const product = (await catalog.listProducts({}, buyer)).items[0]!;

      expect('rate' in product).toBe(false);
      expect(product.purchaseRate).toBe(31_000);
    });

    it('ignores a purchase rate from an editor who may not set one', async () => {
      const product = await seedProduct();

      const clerk = await actorWith(['products.view', 'products.edit', 'field.saleRate.edit']);
      await catalog.updateProduct(
        product.id,
        { name: product.name, purchaseRate: 1 },
        clerk,
      );

      const stored = await db()('products').where({ id: product.id }).first<{ purchase_rate: number }>();
      expect(Number(stored?.purchase_rate)).toBe(31_000);
    });
  });

  describe('a rate-blind edit leaves the price alone', () => {
    it('does not null the rate when somebody who cannot price renames a product', async () => {
      const product = await seedProduct();

      const clerk = await actorWith(['products.view', 'products.edit']);
      await catalog.updateProduct(
        product.id,
        { name: 'Renamed Tile' },
        clerk,
      );

      // This is the behaviour the partial patch bought. It used to write
      // `rate: null` — the masked key came back undefined and the old
      // whole-record write turned that into a null.
      const stored = await db()('products')
        .where({ id: product.id })
        .first<{ name: string; rate: number; mrp: number }>();

      expect(stored?.name).toBe('Renamed Tile');
      expect(Number(stored?.rate)).toBe(42_000);
      expect(Number(stored?.mrp)).toBe(55_000);
    });
  });

  describe('validation refuses a bad value before the database does', () => {
    it.each([
      ['uom', { uom: 'crate' }],
      ['edgeType', { edgeType: 'bevelled' }],
      ['application', { application: 'ceiling' }],
      ['peiRating', { peiRating: 9 }],
      ['gstRatePct', { gstRatePct: 250 }],
      ['purchaseRate', { purchaseRate: -1 }],
    ])('refuses a bad %s with a readable message', async (_field, patch) => {
      await expect(
        catalog.createProduct(
          { categoryName: 'Tiles', variants: [{ code: `BAD-${_field}` }], name: 'Bad Tile', ...patch },
          admin,
        ),
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
    it('finds a product by its barcode and its brand', async () => {
      await seedProduct();

      expect((await catalog.listProducts({ search: '8901234567890' }, admin)).items).toHaveLength(1);
      expect((await catalog.listProducts({ search: 'Kajaria' }, admin)).items).toHaveLength(1);
    });
  });
});
