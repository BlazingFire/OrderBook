/**
 * The lead flow end to end, and the conversion guarantees the guide asks to be
 * explicitly tested (docs/LEAD_GENERATION_FLOW.md §5.2):
 *
 *   1. Conversion copies line items unchanged — no silent recalculation.
 *   2. A line's snapshotted rate does not move when the product's rate is
 *      edited afterwards.
 *   3. `packaging` is never auto-filled during conversion.
 *   4. Reservations are per (product, colour), never aggregated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';

let actor: ActorContext;

async function seed() {
  const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
  const product = await catalog.createProduct(
    {
      productCode: 'GVT-01',
      name: 'Carrara White',
      rate: 45_000,
      weightKg: 22.5,
      size: '600x1200',
      grade: 'Premium',
    },
    actor,
  );
  return { party, product };
}

function line(productId: string, overrides: Record<string, unknown> = {}) {
  return {
    productId,
    packaging: 'carton',
    quantities: [{ colour: 'Ivory', quantity: 10 }],
    ...overrides,
  };
}

describe.skipIf(!canRunIntegrationTests)('lead flow (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('creating', () => {
    it('assigns permanent ids in the documented 12-character shape', async () => {
      const { party, product } = await seed();

      const first = await leads.createLead(
        { partyId: party.id, items: [line(product.id)] },
        actor,
      );
      const second = await leads.createLead(
        { partyId: party.id, items: [line(product.id)] },
        actor,
      );

      expect(first.id).toBe('LD0000000001');
      expect(second.id).toBe('LD0000000002');
    });

    it('snapshots the catalogue onto the line and totals it', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(product.id, { quantities: [{ colour: 'Ivory', quantity: 12 }] })] },
        actor,
      );

      const item = lead.items[0];
      expect(item?.rate).toBe(45_000);
      expect(item?.code).toBe('GVT-01');
      expect(item?.size).toBe('600x1200');
      expect(item?.grade).toBe('Premium');
      expect(item?.totalQuantity).toBe(12);
      expect(item?.lineTotal).toBe(540_000);
      expect(lead.totalAmount).toBe(540_000);
    });

    it('starts the lead in the pipeline’s default stage', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(product.id)] },
        actor,
      );

      expect(lead.stageName).toBe('New');
      expect(lead.timeline.map((entry) => entry.message)).toContain('Lead created');
    });

    it('keeps several colours as separate quantities on one line', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(product.id, {
              quantities: [
                { colour: 'Ivory', quantity: 4 },
                { colour: 'Slate', quantity: 6 },
              ],
            }),
          ],
        },
        actor,
      );

      expect(lead.items[0]?.quantities).toHaveLength(2);
      expect(lead.items[0]?.totalQuantity).toBe(10);
    });

    it('rejects a lead with no products', async () => {
      const { party } = await seed();

      await expect(leads.createLead({ partyId: party.id, items: [] }, actor)).rejects.toThrow(
        /at least one product/i,
      );
    });

    it('rejects a source platform that is not a configured option', async () => {
      const { party, product } = await seed();

      await expect(
        leads.createLead(
          { partyId: party.id, sourcePlatform: 'whatsap', items: [line(product.id)] },
          actor,
        ),
      ).rejects.toThrow(/not a configured lead source/i);
    });

    it('accepts a configured source platform', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, sourcePlatform: 'whatsapp', items: [line(product.id)] },
        actor,
      );

      expect(lead.sourcePlatform).toBe('whatsapp');
    });
  });

  describe('moving through the pipeline', () => {
    it('records a system timeline entry for every stage change', async () => {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(product.id)] },
        actor,
      );

      const moved = await leads.setStage(
        { id: lead.id, stageId: await stageIdByName('lead', 'Quoted') },
        actor,
      );

      expect(moved.stageName).toBe('Quoted');
      expect(moved.timeline.map((entry) => entry.message)).toContain(
        'Moved from New to Quoted',
      );
    });

    it('stores a remark alongside the automatic entry, not instead of it', async () => {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(product.id)] },
        actor,
      );

      const moved = await leads.setStage(
        {
          id: lead.id,
          stageId: await stageIdByName('lead', 'Negotiating'),
          remark: 'Asked for 5% off',
        },
        actor,
      );

      const kinds = moved.timeline.map((entry) => entry.kind);
      expect(kinds).toContain('system');
      expect(kinds).toContain('remark');
    });
  });

  describe('converting to an order', () => {
    async function convertible() {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(product.id, {
              packaging: 'wooden crate',
              quantities: [
                { colour: 'Ivory', quantity: 4 },
                { colour: 'Slate', quantity: 6 },
              ],
            }),
          ],
        },
        actor,
      );
      return { party, product, lead };
    }

    it('creates an order that points back at the lead, and keeps the lead', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);
      const original = await leads.getLead(lead.id, actor);

      expect(order.id).toBe('OD0000000001');
      expect(order.leadId).toBe(lead.id);
      expect(original.convertedOrderId).toBe(order.id);
      expect(original.convertedAt).not.toBeNull();
      // The lead survives with its lines intact — it is history, not a husk.
      expect(original.items).toHaveLength(1);
    });

    it('copies line items unchanged', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      const before = lead.items[0];
      const after = order.items[0];
      expect(after?.productName).toBe(before?.productName);
      expect(after?.rate).toBe(before?.rate);
      expect(after?.code).toBe(before?.code);
      expect(after?.size).toBe(before?.size);
      expect(after?.grade).toBe(before?.grade);
      expect(after?.totalQuantity).toBe(before?.totalQuantity);
      expect(after?.lineTotal).toBe(before?.lineTotal);
    });

    it('does not move the snapshotted rate when the product is repriced', async () => {
      const { product, lead } = await convertible();

      // The catalogue changes *between* quoting and converting — the exact case
      // §8.3 exists to guard against.
      await catalog.updateProduct(
        product.id,
        { productCode: 'GVT-01', name: 'Carrara White', rate: 99_000 },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items[0]?.rate).toBe(45_000);
      expect(order.totalAmount).toBe(450_000);
    });

    it('carries packaging across exactly as entered, never re-derived', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items[0]?.packaging).toBe('wooden crate');
    });

    it('refuses to convert a lead whose line has no packaging', async () => {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(product.id, { packaging: null })] },
        actor,
      );

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /choose packaging/i,
      );
    });

    it('reserves stock per (product, colour) rather than per product', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.reservations).toHaveLength(2);
      const byColour = Object.fromEntries(
        order.reservations.map((reservation) => [reservation.colour, reservation.quantity]),
      );
      expect(byColour).toEqual({ Ivory: 4, Slate: 6 });
      expect(order.reservations.every((r) => r.status === 'active')).toBe(true);
    });

    it('does not touch the stock ledger — reserving is not dispatching', async () => {
      const { lead } = await convertible();

      await orders.convertLead({ leadId: lead.id }, actor);

      const movements = await db()('stock_movements').select('*');
      expect(movements).toHaveLength(0);
    });

    it('sums the order weight from the line weights', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      // 22.5 kg × 10 boxes
      expect(order.totalWeightKg).toBe(225);
      expect(order.weightSource).toBe('computed');
    });

    it('starts the order in its own pipeline, independent of the lead’s', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.stageName).toBe('In Progress');
      expect(order.stageId).toBe(await stageIdByName('order', 'In Progress'));
    });

    it('refuses to convert the same lead twice', async () => {
      const { lead } = await convertible();
      await orders.convertLead({ leadId: lead.id }, actor);

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /already been converted/i,
      );
    });

    it('stops a converted lead being moved or edited', async () => {
      const { lead } = await convertible();
      await orders.convertLead({ leadId: lead.id }, actor);

      await expect(
        leads.setStage({ id: lead.id, stageId: await stageIdByName('lead', 'Lost') }, actor),
      ).rejects.toThrow(/already become an order/i);

      await expect(leads.updateLead(lead.id, { notes: 'too late' }, actor)).rejects.toThrow(
        /can no longer be edited/i,
      );
    });
  });

  describe('order weight override', () => {
    it('keeps the computed figure and only relabels which one is shown', async () => {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(product.id)] },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      const overridden = await orders.updateOrder(order.id, { totalWeightKgOverride: 200 }, actor);
      expect(overridden.weightSource).toBe('manual');
      expect(overridden.totalWeightKgOverride).toBe(200);
      // Still known, so clearing the override restores the real number.
      expect(overridden.totalWeightKg).toBe(225);

      const cleared = await orders.updateOrder(order.id, { totalWeightKgOverride: null }, actor);
      expect(cleared.weightSource).toBe('computed');
      expect(cleared.totalWeightKg).toBe(225);
    });
  });
});
