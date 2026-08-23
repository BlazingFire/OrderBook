/**
 * Inventory: per-colour stock, reservations, and dispatch
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
import * as catalog from '../src/services/catalog.service.js';
import * as inventory from '../src/services/inventory.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';

let actor: ActorContext;

async function seed() {
  const party = await catalog.createParty({ name: 'Shah Ceramics' }, actor);
  const product = await catalog.createProduct(
    { productCode: 'BSN-01', name: 'Pedestal Basin', rate: 30_000, weightKg: 12 },
    actor,
  );
  return { party, product };
}

async function levelFor(productId: string, colour: string) {
  const levels = await inventory.listStock({ limit: 100 }, actor);
  return levels.find((level) => level.productId === productId && level.colour === colour);
}

describe.skipIf(!canRunIntegrationTests)('inventory (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('stock in and counting', () => {
    it('tracks colours of one product separately', async () => {
      const { product } = await seed();

      await inventory.recordInbound(
        { productId: product.id, colour: 'White', quantityBoxes: 40 },
        actor,
      );
      await inventory.recordInbound(
        { productId: product.id, colour: 'Blue', quantityBoxes: 10 },
        actor,
      );

      expect((await levelFor(product.id, 'White'))?.quantityBoxes).toBe(40);
      expect((await levelFor(product.id, 'Blue'))?.quantityBoxes).toBe(10);
    });

    it('turns a counted total into a signed correction', async () => {
      const { product } = await seed();
      await inventory.recordInbound(
        { productId: product.id, colour: 'White', quantityBoxes: 40 },
        actor,
      );

      // Staff count what is on the shelf; they do not compute the difference.
      await inventory.recordAdjustment(
        { productId: product.id, colour: 'White', quantityBoxes: 37, note: 'breakage' },
        actor,
      );

      expect((await levelFor(product.id, 'White'))?.quantityBoxes).toBe(37);

      const movements = await inventory.listMovements({ limit: 10 }, actor);
      expect(movements[0]?.quantityBoxes).toBe(-3);
      expect(movements[0]?.movementType).toBe('adjustment');
      expect(movements[0]?.note).toBe('breakage');
    });

    it('refuses stock with no colour rather than filing it under a default', async () => {
      const { product } = await seed();

      await expect(
        inventory.recordInbound(
          { productId: product.id, colour: '  ', quantityBoxes: 5 },
          actor,
        ),
      ).rejects.toThrow(/which colour/i);
    });
  });

  describe('reserving on conversion', () => {
    async function convertedOrder(quantities: Array<{ colour: string; quantity: number }>) {
      const { party, product } = await seed();
      await inventory.recordInbound(
        { productId: product.id, colour: 'White', quantityBoxes: 40 },
        actor,
      );

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [{ productId: product.id, packaging: 'carton', quantities }],
        },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      return { product, order };
    }

    it('reduces what is free to sell without touching what is on the floor', async () => {
      const { product } = await convertedOrder([{ colour: 'White', quantity: 15 }]);

      const level = await levelFor(product.id, 'White');
      expect(level?.quantityBoxes).toBe(40);
      expect(level?.reservedBoxes).toBe(15);
      expect(level?.availableBoxes).toBe(25);
    });

    it('does not let a reservation for one colour cover another', async () => {
      const { product } = await convertedOrder([{ colour: 'Blue', quantity: 5 }]);

      // The hold is against Blue, so White is untouched — a white basin does
      // not satisfy a reservation for a blue one.
      expect((await levelFor(product.id, 'White'))?.availableBoxes).toBe(40);
      expect((await levelFor(product.id, 'Blue'))?.reservedBoxes).toBe(5);
    });

    it('allows a reservation larger than stock, and surfaces the shortfall', async () => {
      // Selling against an undelivered factory order is routine, so this is
      // deliberately not an error.
      const { product } = await convertedOrder([{ colour: 'White', quantity: 60 }]);

      const level = await levelFor(product.id, 'White');
      expect(level?.availableBoxes).toBe(-20);
    });

    it('judges "low" on free stock, not on what is on the floor', async () => {
      const { product } = await convertedOrder([{ colour: 'White', quantity: 35 }]);
      await inventory.setReorderLevel(
        { productId: product.id, colour: 'White', reorderLevel: 10 },
        actor,
      );

      const level = await levelFor(product.id, 'White');
      // 40 on the floor is comfortably above 10 — but only 5 can be sold.
      expect(level?.quantityBoxes).toBe(40);
      expect(level?.isLow).toBe(true);
    });
  });

  describe('dispatch', () => {
    async function readyToDispatch() {
      const { party, product } = await seed();
      await inventory.recordInbound(
        { productId: product.id, colour: 'White', quantityBoxes: 40 },
        actor,
      );

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            {
              productId: product.id,
              packaging: 'carton',
              quantities: [
                { colour: 'White', quantity: 12 },
                { colour: 'Blue', quantity: 3 },
              ],
            },
          ],
        },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      return { product, order };
    }

    it('writes one signed movement per (product, colour)', async () => {
      const { product, order } = await readyToDispatch();

      await orders.dispatchOrder({ orderId: order.id }, actor);

      const movements = await inventory.listMovements({ limit: 20 }, actor);
      const outbound = movements.filter((movement) => movement.movementType === 'outbound');

      expect(outbound).toHaveLength(2);
      expect(outbound.map((movement) => movement.quantityBoxes).sort((a, b) => a - b)).toEqual([
        -12, -3,
      ]);
      expect(outbound.every((movement) => movement.referenceId === order.id)).toBe(true);
      expect((await levelFor(product.id, 'White'))?.quantityBoxes).toBe(28);
    });

    it('consumes the reservations rather than leaving them holding stock', async () => {
      const { product, order } = await readyToDispatch();

      await orders.dispatchOrder({ orderId: order.id }, actor);

      const level = await levelFor(product.id, 'White');
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
      const { order } = await readyToDispatch();
      await orders.dispatchOrder({ orderId: order.id }, actor);

      await expect(orders.dispatchOrder({ orderId: order.id }, actor)).rejects.toThrow(
        /already dispatched/i,
      );

      // And the ledger is unchanged — the guard is not merely cosmetic.
      const movements = await db()('stock_movements').where({ movement_type: 'outbound' });
      expect(movements).toHaveLength(2);
    });

    it('leaves a dispatched order uneditable', async () => {
      const { order } = await readyToDispatch();
      await orders.dispatchOrder({ orderId: order.id }, actor);

      await expect(orders.updateOrder(order.id, { notes: 'too late' }, actor)).rejects.toThrow(
        /can no longer be edited/i,
      );
    });
  });
});
