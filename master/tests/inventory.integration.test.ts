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
import { onChange } from '../src/services/change-bus.js';
import * as catalog from '../src/services/catalog.service.js';
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
});
