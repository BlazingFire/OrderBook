import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import * as catalog from '../src/services/catalog.service.js';
import * as leads from '../src/services/lead.service.js';

const actor: catalog.ActorContext = { actorType: 'user', actorId: null };
const context = { sourcePanelId: null, actor };

async function seed() {
  const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
  const product = await catalog.createProduct(
    { productCode: 'GVT-01', name: 'Carrara White', pricePerBox: 45_000 },
    actor,
  );
  return { party, product };
}

describe.skipIf(!canRunIntegrationTests)('lead service (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  describe('creating', () => {
    it('assigns sequential lead numbers', async () => {
      const { party, product } = await seed();
      const items = [{ productId: product.id, quantityBoxes: 1 }];

      const first = await leads.createLead({ partyId: party.id, items }, context);
      const second = await leads.createLead({ partyId: party.id, items }, context);

      expect(first.leadNumber).toBe('L-000001');
      expect(second.leadNumber).toBe('L-000002');
    });

    it('snapshots the product price and computes the line total', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 12 }] },
        context,
      );

      expect(lead.items[0]?.unitPrice).toBe(45_000);
      expect(lead.items[0]?.lineTotal).toBe(540_000);
      expect(lead.totalAmount).toBe(540_000);
    });

    it('keeps the original price after the product price later changes', async () => {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 2 }] },
        context,
      );

      await catalog.updateProduct(
        product.id,
        { productCode: 'GVT-01', name: 'Carrara White', pricePerBox: 99_000 },
        actor,
      );

      const reloaded = await leads.getLead(lead.id);
      expect(reloaded.items[0]?.unitPrice).toBe(45_000);
      expect(reloaded.totalAmount).toBe(90_000);
    });

    it('honours an explicitly supplied price over the catalogue price', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 2, unitPrice: 40_000 }] },
        context,
      );

      expect(lead.items[0]?.unitPrice).toBe(40_000);
      expect(lead.totalAmount).toBe(80_000);
    });

    it('sums several line items into the total', async () => {
      const { party, product } = await seed();
      const second = await catalog.createProduct(
        { productCode: 'WLT-02', name: 'Statuario', pricePerBox: 32_000 },
        actor,
      );

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            { productId: product.id, quantityBoxes: 2 },
            { productId: second.id, quantityBoxes: 3 },
          ],
        },
        context,
      );

      expect(lead.items).toHaveLength(2);
      expect(lead.totalAmount).toBe(2 * 45_000 + 3 * 32_000);
    });

    it('rounds fractional quantities to whole currency units', async () => {
      const { party, product } = await seed();

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 1.5 }] },
        context,
      );

      expect(lead.items[0]?.lineTotal).toBe(67_500);
      expect(Number.isInteger(lead.totalAmount)).toBe(true);
    });

    it('records which office panel a lead came from', async () => {
      const { party, product } = await seed();
      const [panel] = await db()('office_panels')
        .insert({
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Front Desk',
          secret_hash: 'x',
          status: 'active',
        })
        .returning('id');

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 1 }] },
        { sourcePanelId: String(panel.id), actor: { actorType: 'office_panel', actorId: String(panel.id) } },
      );

      expect(lead.sourcePanelId).toBe(String(panel.id));
    });

    describe('rejects invalid input', () => {
      it('with no products', async () => {
        const { party } = await seed();
        await expect(leads.createLead({ partyId: party.id, items: [] }, context)).rejects.toThrow(
          /at least one product/i,
        );
      });

      it('with no party', async () => {
        await expect(leads.createLead({ partyId: '', items: [] }, context)).rejects.toThrow(
          /select a party/i,
        );
      });

      it('with a party that does not exist', async () => {
        const { product } = await seed();
        await expect(
          leads.createLead(
            {
              partyId: '00000000-0000-4000-8000-000000000000',
              items: [{ productId: product.id, quantityBoxes: 1 }],
            },
            context,
          ),
        ).rejects.toThrow(/no longer exists/i);
      });

      it('with a product that does not exist', async () => {
        const { party } = await seed();
        await expect(
          leads.createLead(
            {
              partyId: party.id,
              items: [{ productId: '00000000-0000-4000-8000-000000000000', quantityBoxes: 1 }],
            },
            context,
          ),
        ).rejects.toThrow(/no longer exists/i);
      });

      it('with a zero or negative quantity', async () => {
        const { party, product } = await seed();
        await expect(
          leads.createLead(
            { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 0 }] },
            context,
          ),
        ).rejects.toThrow(/greater than zero/i);
      });
    });

    it('writes nothing at all when one line item is invalid', async () => {
      // The insert runs in a transaction; a partially-saved order with missing
      // lines would be worse than a clean failure the user can retry.
      const { party, product } = await seed();

      await expect(
        leads.createLead(
          {
            partyId: party.id,
            items: [
              { productId: product.id, quantityBoxes: 5 },
              { productId: '00000000-0000-4000-8000-000000000000', quantityBoxes: 1 },
            ],
          },
          context,
        ),
      ).rejects.toThrow();

      expect(await db()('leads').count('id as c')).toEqual([{ c: '0' }]);
      expect(await db()('lead_items').count('id as c')).toEqual([{ c: '0' }]);
    });
  });

  describe('status machine', () => {
    async function newLead() {
      const { party, product } = await seed();
      return leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 1 }] },
        context,
      );
    }

    it('starts as new', async () => {
      expect((await newLead()).status).toBe('new');
    });

    it('walks new → verified → order', async () => {
      const lead = await newLead();

      expect((await leads.changeLeadStatus(lead.id, 'verified', actor)).status).toBe('verified');
      const ordered = await leads.changeLeadStatus(lead.id, 'order', actor);

      expect(ordered.status).toBe('order');
      expect(ordered.orderDate).not.toBeNull();
    });

    it('refuses to skip verification', async () => {
      const lead = await newLead();
      await expect(leads.changeLeadStatus(lead.id, 'order', actor)).rejects.toThrow(
        /cannot move a lead from "new" to "order"/i,
      );
    });

    it('refuses to reopen a cancelled lead', async () => {
      const lead = await newLead();
      await leads.changeLeadStatus(lead.id, 'cancelled', actor);

      await expect(leads.changeLeadStatus(lead.id, 'new', actor)).rejects.toThrow(/cannot move/i);
    });

    it('refuses to send an order back to a lead', async () => {
      const lead = await newLead();
      await leads.changeLeadStatus(lead.id, 'verified', actor);
      await leads.changeLeadStatus(lead.id, 'order', actor);

      await expect(leads.changeLeadStatus(lead.id, 'verified', actor)).rejects.toThrow(/cannot move/i);
    });

    it('allows a verified lead to go back to new for correction', async () => {
      const lead = await newLead();
      await leads.changeLeadStatus(lead.id, 'verified', actor);

      expect((await leads.changeLeadStatus(lead.id, 'new', actor)).status).toBe('new');
    });

    it('treats setting the current status as a no-op rather than an error', async () => {
      const lead = await newLead();
      expect((await leads.changeLeadStatus(lead.id, 'new', actor)).status).toBe('new');
    });

    it('reports a missing lead', async () => {
      await expect(
        leads.changeLeadStatus('00000000-0000-4000-8000-000000000000', 'verified', actor),
      ).rejects.toThrow(/not found/i);
    });

    it('logs the transition for audit', async () => {
      const lead = await newLead();
      await leads.changeLeadStatus(lead.id, 'verified', actor);

      const entry = await db()('activity_log').where({ action: 'status_changed' }).first();
      expect(entry?.details).toMatchObject({ from: 'new', to: 'verified' });
    });
  });

  describe('listing', () => {
    it('separates open leads from orders', async () => {
      const { party, product } = await seed();
      const items = [{ productId: product.id, quantityBoxes: 1 }];

      const promoted = await leads.createLead({ partyId: party.id, items }, context);
      await leads.createLead({ partyId: party.id, items }, context);
      await leads.changeLeadStatus(promoted.id, 'verified', actor);
      await leads.changeLeadStatus(promoted.id, 'order', actor);

      const open = await leads.listLeads({ statuses: ['new', 'verified'] });
      const orders = await leads.listLeads({ statuses: ['order'] });

      expect(open.items).toHaveLength(1);
      expect(orders.items).toHaveLength(1);
      expect(orders.items[0]?.id).toBe(promoted.id);
    });

    it('loads line items for every lead in the page', async () => {
      const { party, product } = await seed();
      const items = [{ productId: product.id, quantityBoxes: 1 }];
      await leads.createLead({ partyId: party.id, items }, context);
      await leads.createLead({ partyId: party.id, items }, context);

      const page = await leads.listLeads({});
      expect(page.items.every((lead) => lead.items.length === 1)).toBe(true);
      expect(page.items.every((lead) => lead.items[0]?.productName === 'Carrara White')).toBe(true);
    });

    it('searches by lead number and party name', async () => {
      const { party, product } = await seed();
      await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 1 }] },
        context,
      );

      expect((await leads.listLeads({ search: 'L-000001' })).items).toHaveLength(1);
      expect((await leads.listLeads({ search: 'patel' })).items).toHaveLength(1);
      expect((await leads.listLeads({ search: 'nothing' })).items).toHaveLength(0);
    });
  });

  describe('dashboard summary', () => {
    it('counts open leads and orders separately', async () => {
      const { party, product } = await seed();
      const items = [{ productId: product.id, quantityBoxes: 1 }];

      const promoted = await leads.createLead({ partyId: party.id, items }, context);
      await leads.createLead({ partyId: party.id, items }, context);
      await leads.changeLeadStatus(promoted.id, 'verified', actor);
      await leads.changeLeadStatus(promoted.id, 'order', actor);

      expect(await leads.getDashboardSummary()).toEqual({
        leadCount: 1,
        orderCount: 1,
        partyCount: 1,
        productCount: 1,
        lowStockCount: 0,
      });
    });

    it('excludes cancelled leads from the open count', async () => {
      const { party, product } = await seed();
      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 1 }] },
        context,
      );
      await leads.changeLeadStatus(lead.id, 'cancelled', actor);

      const summary = await leads.getDashboardSummary();
      expect(summary.leadCount).toBe(0);
      expect(summary.orderCount).toBe(0);
    });
  });
});
