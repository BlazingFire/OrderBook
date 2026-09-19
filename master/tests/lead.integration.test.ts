/**
 * The lead flow end to end, and the conversion guarantees the guide asks to be
 * explicitly tested (docs/LEAD_GENERATION_FLOW.md §5.2):
 *
 *   1. Conversion copies line items unchanged — no silent recalculation.
 *   2. A line's snapshotted rate and weight do not move when the product or
 *      its variant is edited afterwards.
 *   3. `packaging` is never auto-filled during conversion.
 *   4. Reservations are per variant, never aggregated to the product.
 *
 * A line is one variant with one quantity; the code and the weight resolve
 * from the variant, and two colours of one model are two lines.
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

/** A one-form product and a model with three colour variants, one unweighed. */
async function seed() {
  const party = await catalog.createParty({ name: 'Patel Sanitary' }, actor);
  const plain = await catalog.createProduct(
    {
      name: '102',
      categoryName: 'ONE PIECE TOILET',
      rate: 45_000,
      size: '9" · L-27 B-15 H-26',
      grade: 'Premium',
      variants: [{ code: '102', weightKg: 32.5 }],
    },
    actor,
  );
  const model = await catalog.createProduct(
    {
      name: 'XYZ',
      categoryName: 'ONE PIECE TOILET',
      rate: 50_000,
      hasVariants: true,
      variants: [
        { code: '1111', label: 'White', weightKg: 32 },
        { code: '1112', label: 'Blue', weightKg: 32.5 },
        { code: '1113', label: 'Red' },
      ],
    },
    actor,
  );
  const byLabel = (label: string) => {
    const found = model.variants.find((variant) => variant.label === label);
    if (!found) throw new Error(`seed: no ${label} variant`);
    return found;
  };
  return {
    party,
    plain,
    plainVariant: plain.variants[0]!,
    model,
    white: byLabel('White'),
    blue: byLabel('Blue'),
    red: byLabel('Red'),
  };
}

function line(
  productId: string,
  variantId: string,
  quantity: number,
  overrides: Record<string, unknown> = {},
) {
  return { productId, variantId, quantity, packaging: 'carton', ...overrides };
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
      const { party, plain, plainVariant } = await seed();

      const first = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );
      const second = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );

      expect(first.id).toBe('LD0000000001');
      expect(second.id).toBe('LD0000000002');
    });

    it('resolves the code and the weight from the variant and totals the line', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 12)] },
        actor,
      );

      const item = lead.items[0];
      expect(item?.rate).toBe(45_000);
      expect(item?.code).toBe('102');
      expect(item?.variantLabel).toBeNull();
      expect(item?.size).toBe('9" · L-27 B-15 H-26');
      expect(item?.grade).toBe('Premium');
      expect(item?.quantity).toBe(12);
      expect(item?.weightKg).toBe(32.5);
      expect(item?.lineWeightKg).toBe(390);
      expect(item?.lineTotal).toBe(540_000);
      expect(lead.totalAmount).toBe(540_000);
      expect(lead.totalWeightKg).toBe(390);
      expect(lead.linesWithoutWeight).toBe(0);
    });

    it('takes the code and the weight from the chosen colour of a model', async () => {
      const { party, model, blue, red } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [line(model.id, blue.id, 10), line(model.id, red.id, 3)],
        },
        actor,
      );

      const [blueLine, redLine] = lead.items;
      expect(blueLine?.code).toBe('1112');
      expect(blueLine?.variantLabel).toBe('Blue');
      expect(blueLine?.weightKg).toBe(32.5);
      expect(blueLine?.lineWeightKg).toBe(325);
      // Red has no weight entered yet: the line says so instead of guessing.
      expect(redLine?.code).toBe('1113');
      expect(redLine?.weightKg).toBeNull();
      expect(redLine?.lineWeightKg).toBeNull();
      expect(lead.totalWeightKg).toBe(325);
      expect(lead.linesWithoutWeight).toBe(1);
    });

    it('keeps several colours of one model as separate lines, each with its own total', async () => {
      const { party, model, white, blue, red } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [line(model.id, white.id, 5), line(model.id, blue.id, 10), line(model.id, red.id, 3)],
        },
        actor,
      );

      expect(lead.items).toHaveLength(3);
      expect(lead.items.map((item) => [item.code, item.quantity])).toEqual([
        ['1111', 5],
        ['1112', 10],
        ['1113', 3],
      ]);
      // 5 × 32 + 10 × 32.5; the unweighed red line is left out and counted.
      expect(lead.totalWeightKg).toBe(485);
      expect(lead.linesWithoutWeight).toBe(1);
    });

    it('refuses a variant that belongs to another product', async () => {
      const { party, plain, blue } = await seed();

      await expect(
        leads.createLead({ partyId: party.id, items: [line(plain.id, blue.id, 1)] }, actor),
      ).rejects.toThrow(/variants no longer exists/i);
    });

    it('refuses a variant the administrator has taken off the form', async () => {
      const { party, model, white, blue, red } = await seed();
      // Blue is removed from the model; nothing references it yet, so it goes.
      await catalog.updateProduct(
        model.id,
        {
          name: 'XYZ',
          variants: [
            { id: white.id, code: '1111', label: 'White', weightKg: 32 },
            { id: red.id, code: '1113', label: 'Red' },
          ],
        },
        actor,
      );

      await expect(
        leads.createLead({ partyId: party.id, items: [line(model.id, blue.id, 1)] }, actor),
      ).rejects.toThrow(/variants no longer exists/i);
    });

    it('refuses a line with no quantity', async () => {
      const { party, plain, plainVariant } = await seed();

      await expect(
        leads.createLead({ partyId: party.id, items: [line(plain.id, plainVariant.id, 0)] }, actor),
      ).rejects.toThrow(/quantity/i);
    });

    it('starts the lead in the pipeline’s default stage', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      expect(lead.stageName).toBe('New');
      expect(lead.timeline.map((entry) => entry.message)).toContain('Lead created');
    });

    it('keeps a rate switched off rather than pricing the line from the catalogue', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [line(plain.id, plainVariant.id, 10, { rate: null, rateUnset: true })],
        },
        actor,
      );

      // The product is priced at 45_000 and a plain `rate: null` would land
      // there — that fallback is what keeps an offline draft priced at all.
      expect(lead.items[0]?.rate).toBeNull();
      expect(lead.items[0]?.lineTotal).toBeNull();
      expect(lead.totalAmount).toBe(0);
    });

    it('rejects a lead with no products', async () => {
      const { party } = await seed();

      await expect(leads.createLead({ partyId: party.id, items: [] }, actor)).rejects.toThrow(
        /at least one product/i,
      );
    });

    it('rejects a source platform that is not a configured option', async () => {
      const { party, plain, plainVariant } = await seed();

      await expect(
        leads.createLead(
          {
            partyId: party.id,
            sourcePlatform: 'whatsap',
            items: [line(plain.id, plainVariant.id, 1)],
          },
          actor,
        ),
      ).rejects.toThrow(/not a configured lead source/i);
    });

    it('accepts a configured source platform', async () => {
      const { party, plain, plainVariant } = await seed();

      const lead = await leads.createLead(
        {
          partyId: party.id,
          sourcePlatform: 'whatsapp',
          items: [line(plain.id, plainVariant.id, 1)],
        },
        actor,
      );

      expect(lead.sourcePlatform).toBe('whatsapp');
    });
  });

  describe('moving through the pipeline', () => {
    it('records a system timeline entry for every stage change', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
        actor,
      );

      const moved = await leads.setStage(
        { id: lead.id, stageId: await stageIdByName('lead', 'Quoted') },
        actor,
      );

      expect(moved.stageName).toBe('Quoted');
      expect(moved.timeline.map((entry) => entry.message)).toContain('Moved from New to Quoted');
    });

    it('stores a remark alongside the automatic entry, not instead of it', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1)] },
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
      const seeded = await seed();
      const { party, model, white, blue } = seeded;
      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            line(model.id, white.id, 4, { packaging: 'wooden crate' }),
            line(model.id, blue.id, 6, { packaging: 'wooden crate' }),
          ],
        },
        actor,
      );
      return { ...seeded, lead };
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
      expect(original.items).toHaveLength(2);
    });

    it('copies line items unchanged — product, variant, code, colour, weight, quantity', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items).toHaveLength(2);
      for (const [index, before] of lead.items.entries()) {
        const after = order.items[index];
        expect(after?.productId).toBe(before.productId);
        expect(after?.variantId).toBe(before.variantId);
        expect(after?.productName).toBe(before.productName);
        expect(after?.rate).toBe(before.rate);
        expect(after?.code).toBe(before.code);
        expect(after?.variantLabel).toBe(before.variantLabel);
        expect(after?.size).toBe(before.size);
        expect(after?.grade).toBe(before.grade);
        expect(after?.weightKg).toBe(before.weightKg);
        expect(after?.quantity).toBe(before.quantity);
        expect(after?.lineWeightKg).toBe(before.lineWeightKg);
        expect(after?.lineTotal).toBe(before.lineTotal);
      }
    });

    it('does not move the snapshotted rate or weight when the master is edited afterwards', async () => {
      const { model, white, blue, red, lead } = await convertible();

      // The catalogue changes *between* quoting and converting — the exact case
      // §8.3 exists to guard against: a new price, and a corrected weight.
      await catalog.updateProduct(
        model.id,
        {
          name: 'XYZ',
          rate: 99_000,
          variants: [
            { id: white.id, code: '1111', label: 'White', weightKg: 40 },
            { id: blue.id, code: '1112', label: 'Blue', weightKg: 41 },
            { id: red.id, code: '1113', label: 'Red', weightKg: 42 },
          ],
        },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items.map((item) => item.rate)).toEqual([50_000, 50_000]);
      expect(order.items.map((item) => item.weightKg)).toEqual([32, 32.5]);
      expect(order.totalAmount).toBe(500_000);
      // 4 × 32 + 6 × 32.5, from the frozen figures, not the corrected ones.
      expect(order.totalWeightKg).toBe(323);
    });

    it('leaves an existing order untouched when the variant is edited later', async () => {
      const { model, white, blue, red, lead } = await convertible();
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      await catalog.updateProduct(
        model.id,
        {
          name: 'XYZ',
          variants: [
            { id: white.id, code: '1111-N', label: 'White', weightKg: 40 },
            { id: blue.id, code: '1112-N', label: 'Blue', weightKg: 41 },
            { id: red.id, code: '1113-N', label: 'Red', weightKg: 42 },
          ],
        },
        actor,
      );

      const stored = await orders.getOrder(order.id, actor);
      expect(stored.items.map((item) => [item.code, item.weightKg])).toEqual([
        ['1111', 32],
        ['1112', 32.5],
      ]);
      expect(stored.totalWeightKg).toBe(323);
    });

    it('carries packaging across exactly as entered, never re-derived', async () => {
      const { lead } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.items.map((item) => item.packaging)).toEqual(['wooden crate', 'wooden crate']);
    });

    it('refuses to convert a lead whose line has no packaging', async () => {
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 1, { packaging: null })] },
        actor,
      );

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(
        /choose packaging/i,
      );
    });

    it('reserves stock per variant rather than per product', async () => {
      const { lead, white, blue } = await convertible();

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.reservations).toHaveLength(2);
      const byVariant = Object.fromEntries(
        order.reservations.map((reservation) => [reservation.variantId, reservation.quantity]),
      );
      expect(byVariant).toEqual({ [white.id]: 4, [blue.id]: 6 });
      expect(order.reservations.map((reservation) => reservation.variantCode).sort()).toEqual([
        '1111',
        '1112',
      ]);
      expect(order.reservations.every((r) => r.status === 'active')).toBe(true);
    });

    it('does not touch the stock ledger — reserving is not dispatching', async () => {
      const { lead } = await convertible();

      await orders.convertLead({ leadId: lead.id }, actor);

      const movements = await db()('stock_movements').select('*');
      expect(movements).toHaveLength(0);
    });

    it('sums the order weight from the line weights, over the lines that have one', async () => {
      const { party, model, blue, red } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(model.id, blue.id, 10), line(model.id, red.id, 3)] },
        actor,
      );

      const order = await orders.convertLead({ leadId: lead.id }, actor);

      // 32.5 kg × 10; the unweighed red line is counted, not guessed.
      expect(order.totalWeightKg).toBe(325);
      expect(order.linesWithoutWeight).toBe(1);
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
      const { party, plain, plainVariant } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [line(plain.id, plainVariant.id, 10)] },
        actor,
      );
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      const overridden = await orders.updateOrder(order.id, { totalWeightKgOverride: 200 }, actor);
      expect(overridden.weightSource).toBe('manual');
      expect(overridden.totalWeightKgOverride).toBe(200);
      // Still known, so clearing the override restores the real number.
      expect(overridden.totalWeightKg).toBe(325);

      const cleared = await orders.updateOrder(order.id, { totalWeightKgOverride: null }, actor);
      expect(cleared.weightSource).toBe('computed');
      expect(cleared.totalWeightKg).toBe(325);
    });
  });
});
