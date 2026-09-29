/**
 * Inventory: per-variant stock, reservations, and dispatch
 * (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * The behaviour worth guarding here is the *split* between reserving and
 * dispatching. Conversion holds stock aside; only dispatch takes it off the
 * ledger. Getting that wrong in either direction — deducting at conversion, or
 * never deducting at all — looks identical on a single screen and is only
 * visible in the numbers these tests assert.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as productRepo from '../src/repositories/product.repository.js';
import { onChange } from '../src/services/change-bus.js';
import * as catalog from '../src/services/catalog.service.js';
import * as dashboard from '../src/services/dashboard.service.js';
import * as inventory from '../src/services/inventory.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';

let actor: ActorContext;

/** A basin sold in two colours, so a reservation for one cannot cover the other. */
async function seed() {
  const party = await catalog.createParty({ name: 'Shah Ceramics' }, actor);
  const product = await catalog.createProduct(
    {
      name: 'Pedestal Basin',
      categoryName: 'PLAIN SET',
      hasVariants: true,
      variants: [
        { code: 'BSN-W', label: 'White', weightKg: 12 },
        { code: 'BSN-B', label: 'Blue', weightKg: 12 },
      ],
    },
    actor,
  );
  const variant = (label: string) => {
    const found = product.variants.find((candidate) => candidate.label === label);
    if (!found) throw new Error(`seed: no ${label}`);
    return found;
  };
  return { party, product, white: variant('White'), blue: variant('Blue') };
}

/**
 * A small catalogue v2 (`docs/catalogue/CATALOGUE_MODEL.md` §7): two brands,
 * three products in catalogue order, sub products whose `sort_order`
 * disagrees with their names, one fixed colour and one multicolour — and
 * nothing stocked yet.
 */
async function seedCatalogue() {
  const categories = await db().transaction((trx) =>
    productRepo.ensureCategories(
      actor.tenantId,
      [
        { name: 'Wash Basin', code: 'WB', brand: 'Swisware+', sortOrder: 2 },
        { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 },
        { name: 'Pan', code: 'PAN', brand: 'Other Brand', sortOrder: 3 },
      ],
      trx,
    ),
  );
  const sub = async (name: string, categoryCode: string, code: string, sortOrder: number, extra = {}) =>
    (await catalog.createProduct({ name, categoryCode, sortOrder, variants: [{ code }], ...extra }, actor))
      .variants[0]!;

  return {
    categories,
    // Named against their order, so a name sort would put ALPHA first.
    zeta: await sub('ZETA', 'OPT', 'OPT-0001', 1),
    alpha: await sub('ALPHA', 'OPT', 'OPT-0002', 2),
    magenta: await sub('MAGENTA', 'WB', 'WB-0001', 1, {
      hasVariants: true,
      variants: [{ code: 'WB-0001', label: 'Magenta' }],
    }),
    orissa: await sub('Orissa Pan', 'PAN', 'PAN-0001', 1, { multiColour: true }),
  };
}

async function levelFor(variantId: string) {
  const levels = await inventory.listStock({ limit: 100 }, actor);
  return levels.find((level) => level.variantId === variantId);
}

describe.skipIf(!canRunIntegrationTests)('inventory (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('stock in and counting', () => {
    it('tracks variants of one product separately', async () => {
      const { white, blue } = await seed();

      await inventory.recordInbound({ variantId: white.id, quantityBoxes: 40 }, actor);
      await inventory.recordInbound({ variantId: blue.id, quantityBoxes: 10 }, actor);

      const whiteLevel = await levelFor(white.id);
      expect(whiteLevel?.quantityBoxes).toBe(40);
      expect(whiteLevel?.variantCode).toBe('BSN-W');
      expect(whiteLevel?.variantLabel).toBe('White');
      expect(whiteLevel?.weightKg).toBe(12);
      expect((await levelFor(blue.id))?.quantityBoxes).toBe(10);
    });

    it('turns a counted total into a signed correction', async () => {
      const { white } = await seed();
      await inventory.recordInbound({ variantId: white.id, quantityBoxes: 40 }, actor);

      // Staff count what is on the shelf; they do not compute the difference.
      await inventory.recordAdjustment(
        { variantId: white.id, quantityBoxes: 37, note: 'breakage' },
        actor,
      );

      expect((await levelFor(white.id))?.quantityBoxes).toBe(37);

      const movements = await inventory.listMovements({ limit: 10 }, actor);
      expect(movements[0]?.quantityBoxes).toBe(-3);
      expect(movements[0]?.movementType).toBe('adjustment');
      expect(movements[0]?.note).toBe('breakage');
      expect(movements[0]?.variantCode).toBe('BSN-W');
    });

    it('refuses stock with no variant rather than filing it under a default', async () => {
      await seed();

      await expect(
        inventory.recordInbound({ variantId: '  ', quantityBoxes: 5 }, actor),
      ).rejects.toThrow(/which product variant/i);
    });

    it('refuses stock against a variant that does not exist', async () => {
      await seed();

      await expect(
        inventory.recordInbound({ variantId: 'VR0000009999', quantityBoxes: 5 }, actor),
      ).rejects.toThrow(/not found/i);
    });

    it('publishes the stock row under the variant id', async () => {
      const { white } = await seed();
      const seen: string[] = [];
      const stop = onChange((event) => {
        if (event.entity === 'stock') seen.push(event.id);
      });

      try {
        await inventory.recordInbound({ variantId: white.id, quantityBoxes: 4 }, actor);
      } finally {
        stop();
      }

      expect(seen).toEqual([white.id]);
    });
  });

  describe('reserving on conversion', () => {
    it('does not let a reservation for one variant cover another', async () => {
      const seeded = await seed();
      await inventory.recordInbound({ variantId: seeded.white.id, quantityBoxes: 40 }, actor);
      const lead = await leads.createLead(
        {
          partyId: seeded.party.id,
          items: [
            {
              productId: seeded.product.id,
              variantId: seeded.blue.id,
              quantity: 5,
              packaging: 'carton',
            },
          ],
        },
        actor,
      );
      await orders.convertLead({ leadId: lead.id }, actor);

      // The hold is against Blue, so White is untouched — a white basin does
      // not satisfy a reservation for a blue one.
      expect((await levelFor(seeded.white.id))?.availableBoxes).toBe(40);
      const blueLevel = await levelFor(seeded.blue.id);
      expect(blueLevel?.reservedBoxes).toBe(5);
      // Blue was never stocked: the row is synthesised so the shortfall shows.
      expect(blueLevel?.quantityBoxes).toBe(0);
      expect(blueLevel?.availableBoxes).toBe(-5);
    });
  });

  describe('reserving and dispatching', () => {
    async function readyToDispatch(quantities: { white: number; blue?: number }) {
      const { party, product, white, blue } = await seed();
      await inventory.recordInbound({ variantId: white.id, quantityBoxes: 40 }, actor);

      const items = [{ productId: product.id, variantId: white.id, quantity: quantities.white, packaging: 'carton' }];
      if (quantities.blue) {
        items.push({ productId: product.id, variantId: blue.id, quantity: quantities.blue, packaging: 'carton' });
      }
      const lead = await leads.createLead({ partyId: party.id, items }, actor);
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      return { product, white, blue, order };
    }

    it('reduces what is free to sell without touching what is on the floor', async () => {
      const { white } = await readyToDispatch({ white: 15 });

      const level = await levelFor(white.id);
      expect(level?.quantityBoxes).toBe(40);
      expect(level?.reservedBoxes).toBe(15);
      expect(level?.availableBoxes).toBe(25);
    });

    it('allows a reservation larger than stock, and surfaces the shortfall', async () => {
      // Selling against an undelivered factory order is routine, so this is
      // deliberately not an error.
      const { white } = await readyToDispatch({ white: 60 });

      expect((await levelFor(white.id))?.availableBoxes).toBe(-20);
    });

    it('judges "low" on free stock, not on what is on the floor', async () => {
      const { white } = await readyToDispatch({ white: 35 });
      await inventory.setReorderLevel({ variantId: white.id, reorderLevel: 10 }, actor);

      const level = await levelFor(white.id);
      // 40 on the floor is comfortably above 10 — but only 5 can be sold.
      expect(level?.quantityBoxes).toBe(40);
      expect(level?.isLow).toBe(true);
    });

    it('writes one signed movement per variant on dispatch', async () => {
      const { white, order } = await readyToDispatch({ white: 12, blue: 3 });

      await orders.dispatchOrder({ orderId: order.id }, actor);

      const movements = await inventory.listMovements({ limit: 20 }, actor);
      const outbound = movements.filter((movement) => movement.movementType === 'outbound');

      expect(outbound).toHaveLength(2);
      expect(outbound.map((movement) => movement.quantityBoxes).sort((a, b) => a - b)).toEqual([
        -12, -3,
      ]);
      expect(outbound.map((movement) => movement.variantCode).sort()).toEqual(['BSN-B', 'BSN-W']);
      expect(outbound.every((movement) => movement.referenceId === order.id)).toBe(true);
      expect((await levelFor(white.id))?.quantityBoxes).toBe(28);
    });

    it('consumes the reservations rather than leaving them holding stock', async () => {
      const { white, order } = await readyToDispatch({ white: 12, blue: 3 });

      await orders.dispatchOrder({ orderId: order.id }, actor);

      const level = await levelFor(white.id);
      expect(level?.reservedBoxes).toBe(0);
      // 28 on the floor and nothing held against it.
      expect(level?.availableBoxes).toBe(28);

      const after = await orders.getOrder(order.id, actor);
      expect(after.reservations.every((reservation) => reservation.status === 'consumed')).toBe(
        true,
      );
      expect(after.dispatchedAt).not.toBeNull();
      expect(after.stageName).toBe('Dispatched');
    });

    it('stamps the dispatch into the sync clock like every other order write', async () => {
      const { order } = await readyToDispatch({ white: 12 });

      const dispatched = await orders.dispatchOrder({ orderId: order.id }, actor);

      // It used to change the stage and `dispatched_at` and leave `version`,
      // `hlc` and `field_hlc` exactly as they were — so to anything reading the
      // sync bookkeeping, a dispatched order had not changed since conversion.
      expect(dispatched.sync.version).toBe(order.sync.version + 1);
      expect(dispatched.sync.hlc > order.sync.hlc).toBe(true);
      expect(dispatched.sync.fieldHlc.stageId).toBe(dispatched.sync.hlc);
      expect(dispatched.sync.fieldHlc.dispatchedAt).toBe(dispatched.sync.hlc);
    });

    it('refuses to dispatch the same order twice', async () => {
      const { order } = await readyToDispatch({ white: 12, blue: 3 });
      await orders.dispatchOrder({ orderId: order.id }, actor);

      await expect(orders.dispatchOrder({ orderId: order.id }, actor)).rejects.toThrow(
        /already dispatched/i,
      );

      // And the ledger is unchanged — the guard is not merely cosmetic.
      const movements = await db()('stock_movements').where({ movement_type: 'outbound' });
      expect(movements).toHaveLength(2);
    });

    it('leaves a dispatched order uneditable', async () => {
      const { order } = await readyToDispatch({ white: 12 });
      await orders.dispatchOrder({ orderId: order.id }, actor);

      await expect(orders.updateOrder(order.id, { notes: 'too late' }, actor)).rejects.toThrow(
        /can no longer be edited/i,
      );
    });
  });

  describe('the stock list (catalogue v2)', () => {
    it('lists every live variant in catalogue order, never-stocked ones at zero', async () => {
      const { zeta, alpha, magenta, orissa } = await seedCatalogue();
      await inventory.recordInbound({ variantId: magenta.id, quantityBoxes: 7 }, actor);

      const levels = await inventory.listStock({}, actor);

      // Category order, then the sub product's own order — not the names.
      expect(levels.map((level) => level.variantId)).toEqual([zeta.id, alpha.id, magenta.id, orissa.id]);
      expect(levels[0]).toMatchObject({
        productName: 'ZETA',
        categoryName: 'One Piece Toilet',
        categoryCode: 'OPT',
        brand: 'Swisware+',
        multiColour: false,
        quantityBoxes: 0,
        reservedBoxes: 0,
        availableBoxes: 0,
        updatedAt: null,
      });
      expect(levels[2]).toMatchObject({ variantLabel: 'Magenta', quantityBoxes: 7 });
      expect(levels[3]).toMatchObject({ brand: 'Other Brand', multiColour: true });
    });

    it('never lists a deleted or deactivated sub product, stocked or not', async () => {
      const { zeta, alpha, magenta } = await seedCatalogue();
      await inventory.recordInbound({ variantId: zeta.id, quantityBoxes: 3 }, actor);
      await inventory.recordInbound({ variantId: alpha.id, quantityBoxes: 3 }, actor);

      await db()('products').where({ id: zeta.productId }).update({ deleted_at: db().fn.now() });
      await db()('product_variants').where({ id: zeta.id }).update({ deleted_at: db().fn.now() });
      await db()('products').where({ id: alpha.productId }).update({ is_active: false });

      const ids = (await inventory.listStock({}, actor)).map((level) => level.variantId);
      expect(ids).not.toContain(zeta.id);
      expect(ids).not.toContain(alpha.id);
      expect(ids).toContain(magenta.id);

      // The single-row read behind a movement still finds a deactivated
      // model: stock can arrive for it, and used to throw "Stock level missing".
      const moved = await inventory.recordInbound({ variantId: alpha.id, quantityBoxes: 2 }, actor);
      expect(moved.quantityBoxes).toBe(5);
    });

    it('lists a variant taken off the form only while boxes of it are on the floor or held', async () => {
      const party = await catalog.createParty({ name: 'Shah Ceramics' }, actor);
      const basin = await catalog.createProduct(
        {
          name: 'Pedestal Basin',
          categoryName: 'PLAIN SET',
          hasVariants: true,
          variants: ['White', 'Blue', 'Green', 'Red'].map((label) => ({
            code: `BSN-${label}`,
            label,
          })),
        },
        actor,
      );
      const [white, blue, green, red] = basin.variants;
      // Blue is on the floor, Green is held for an order, Red is only quoted:
      // each is referenced, so taking it off the form deactivates it.
      await inventory.recordInbound({ variantId: blue!.id, quantityBoxes: 3 }, actor);
      const held = await leads.createLead(
        { partyId: party.id, items: [{ productId: basin.id, variantId: green!.id, quantity: 2 }] },
        actor,
      );
      await orders.convertLead({ leadId: held.id }, actor);
      await leads.createLead(
        { partyId: party.id, items: [{ productId: basin.id, variantId: red!.id, quantity: 1 }] },
        actor,
      );
      await catalog.updateProduct(
        basin.id,
        {
          name: 'Pedestal Basin',
          hasVariants: true,
          variants: [{ id: white!.id, code: 'BSN-White', label: 'White' }],
        },
        actor,
      );

      const ids = (await inventory.listStock({}, actor)).map((level) => level.variantId);
      expect(ids).toEqual([white!.id, blue!.id, green!.id]);
    });

    it('filters by brand, by product, and searches the product code and the brand', async () => {
      const { categories } = await seedCatalogue();
      const codes = async (query: Parameters<typeof inventory.listStock>[0]) =>
        (await inventory.listStock(query, actor)).map((level) => level.variantCode);

      expect(await codes({ brand: 'swisware+' })).toEqual(['OPT-0001', 'OPT-0002', 'WB-0001']);
      expect(await codes({ brand: 'Other Brand' })).toEqual(['PAN-0001']);
      expect(await codes({ categoryId: categories.get('wb') })).toEqual(['WB-0001']);
      expect(await codes({ search: 'opt' })).toEqual(['OPT-0001', 'OPT-0002']);
      expect(await codes({ search: 'other' })).toEqual(['PAN-0001']);
    });

    it('fills a low-only page before slicing it, and counts on the Dashboard exactly what it lists', async () => {
      const { zeta, alpha, magenta, orissa } = await seedCatalogue();
      // Three low rows spread over the list, one comfortable row among them.
      for (const variant of [zeta, magenta, orissa]) {
        await inventory.setReorderLevel({ variantId: variant.id, reorderLevel: 5 }, actor);
      }
      await inventory.recordInbound({ variantId: alpha.id, quantityBoxes: 50 }, actor);
      await inventory.setReorderLevel({ variantId: alpha.id, reorderLevel: 5 }, actor);

      // Paged in SQL before the filter, the first page of two was one row.
      const first = await inventory.listStock({ lowOnly: true, limit: 2, offset: 0 }, actor);
      const second = await inventory.listStock({ lowOnly: true, limit: 2, offset: 2 }, actor);
      expect(first.map((level) => level.variantId)).toEqual([zeta.id, magenta.id]);
      expect(second.map((level) => level.variantId)).toEqual([orissa.id]);

      // A deleted model with low stock: the count used to read
      // `inventory_stock` alone and count it; the list never showed it.
      await db()('products').where({ id: zeta.productId }).update({ deleted_at: db().fn.now() });
      await db()('product_variants').where({ id: zeta.id }).update({ deleted_at: db().fn.now() });

      const listed = await inventory.listStock({ lowOnly: true }, actor);
      expect(listed).toHaveLength(2);
      expect(await inventory.countLowStock(actor.tenantId)).toBe(listed.length);
      expect((await dashboard.getDashboardSummary(actor)).lowStockCount).toBe(listed.length);
    });

    it('publishes a zero level when the last hold on a never-stocked variant is released', async () => {
      const { orissa } = await seedCatalogue();
      const party = await catalog.createParty({ name: 'Shah Ceramics' }, actor);
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: orissa.productId, variantId: orissa.id, quantity: 5, colour: 'Ivory' }],
        },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);
      expect((await levelFor(orissa.id))?.availableBoxes).toBe(-5);

      const published: unknown[] = [];
      const stop = onChange((event) => {
        if (event.entity === 'stock' && event.id === orissa.id) published.push(event.payload);
      });
      try {
        await orders.deleteOrder(order.id, actor);
      } finally {
        stop();
      }

      // Nothing was published here before, so panels kept showing -5 free.
      expect(published).toEqual([
        expect.objectContaining({ quantityBoxes: 0, reservedBoxes: 0, availableBoxes: 0 }),
      ]);
    });
  });
});
