import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as inventory from '../src/services/inventory.service.js';
import * as leads from '../src/services/lead.service.js';

const actor: ActorContext = { actorType: 'user', actorId: null };
const context = { sourcePanelId: null, actor };

async function seed(boxCoverageSqft: number | null = 15) {
  const party = await catalog.createParty({ name: 'Patel Tiles' }, actor);
  const product = await catalog.createProduct(
    { productCode: 'GVT-01', name: 'Carrara White', pricePerBox: 45_000, boxCoverageSqft },
    actor,
  );
  return { party, product };
}

async function stockFor(productId: string) {
  const levels = await inventory.listStock({});
  const level = levels.find((entry) => entry.productId === productId);
  if (!level) throw new Error('stock level missing');
  return level;
}

describe.skipIf(!canRunIntegrationTests)('inventory service (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(resetData);

  describe('listing', () => {
    it('shows a product with no stock row yet at zero rather than hiding it', async () => {
      const { product } = await seed();

      const level = await stockFor(product.id);
      expect(level.quantityBoxes).toBe(0);
      expect(level.isLow).toBe(false);
    });

    it('searches by product code, name and category', async () => {
      await seed();
      await catalog.createProduct(
        { productCode: 'WLT-02', name: 'Statuario', categoryName: 'Wall Tile' },
        actor,
      );

      expect(await inventory.listStock({ search: 'carrara' })).toHaveLength(1);
      expect(await inventory.listStock({ search: 'WLT' })).toHaveLength(1);
      expect(await inventory.listStock({ search: 'Wall' })).toHaveLength(1);
    });
  });

  describe('stock in', () => {
    it('adds boxes and records a ledger row', async () => {
      const { product } = await seed();

      const level = await inventory.recordInbound(
        { productId: product.id, quantityBoxes: 40, note: 'Factory lot 12' },
        actor,
      );

      expect(level.quantityBoxes).toBe(40);

      const movements = await inventory.listMovements({ productId: product.id });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        movementType: 'inbound',
        quantityBoxes: 40,
        note: 'Factory lot 12',
      });
    });

    it('accumulates across several deliveries', async () => {
      const { product } = await seed();

      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 10 }, actor);

      expect((await stockFor(product.id)).quantityBoxes).toBe(50);
    });

    it('mirrors the quantity in sqft using the product box coverage', async () => {
      const { product } = await seed(15);

      const level = await inventory.recordInbound({ productId: product.id, quantityBoxes: 4 }, actor);
      expect(level.quantitySqft).toBe(60);
    });

    it('leaves sqft at zero when the product has no coverage recorded', async () => {
      const { product } = await seed(null);

      const level = await inventory.recordInbound({ productId: product.id, quantityBoxes: 4 }, actor);
      expect(level.quantityBoxes).toBe(4);
      expect(level.quantitySqft).toBe(0);
    });

    it('rejects a zero or negative delivery', async () => {
      const { product } = await seed();

      await expect(
        inventory.recordInbound({ productId: product.id, quantityBoxes: 0 }, actor),
      ).rejects.toThrow(/how many boxes/i);
      await expect(
        inventory.recordInbound({ productId: product.id, quantityBoxes: -5 }, actor),
      ).rejects.toThrow(/how many boxes/i);
    });

    it('rejects an unknown product', async () => {
      await expect(
        inventory.recordInbound(
          { productId: '00000000-0000-4000-8000-000000000000', quantityBoxes: 5 },
          actor,
        ),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('adjustment after a physical count', () => {
    it('takes the counted total and derives the difference', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);

      const level = await inventory.recordAdjustment(
        { productId: product.id, quantityBoxes: 37, note: 'Breakage found at stock take' },
        actor,
      );

      expect(level.quantityBoxes).toBe(37);

      const movements = await inventory.listMovements({ productId: product.id });
      expect(movements[0]).toMatchObject({ movementType: 'adjustment', quantityBoxes: -3 });
    });

    it('records a positive movement when the count is higher than expected', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 10 }, actor);

      await inventory.recordAdjustment({ productId: product.id, quantityBoxes: 12 }, actor);

      const movements = await inventory.listMovements({ productId: product.id });
      expect(movements[0]?.quantityBoxes).toBe(2);
    });

    it('writes no ledger row when the count matches, keeping the audit trail readable', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 10 }, actor);

      await inventory.recordAdjustment({ productId: product.id, quantityBoxes: 10 }, actor);

      expect(await inventory.listMovements({ productId: product.id })).toHaveLength(1);
    });

    it('rejects a negative count', async () => {
      const { product } = await seed();
      await expect(
        inventory.recordAdjustment({ productId: product.id, quantityBoxes: -1 }, actor),
      ).rejects.toThrow(/counted number/i);
    });
  });

  describe('reorder level and low stock', () => {
    it('flags a product at or below its reorder level', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 10 }, actor);
      await inventory.setReorderLevel(product.id, 10, actor);

      expect((await stockFor(product.id)).isLow).toBe(true);
    });

    it('does not flag a product above its reorder level', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 11 }, actor);
      await inventory.setReorderLevel(product.id, 10, actor);

      expect((await stockFor(product.id)).isLow).toBe(false);
    });

    it('never flags a product with no reorder level set', async () => {
      const { product } = await seed();
      expect((await stockFor(product.id)).isLow).toBe(false);
    });

    it('filters to only low-stock products', async () => {
      const { product } = await seed();
      const other = await catalog.createProduct({ productCode: 'B1', name: 'Other' }, actor);

      await inventory.setReorderLevel(product.id, 5, actor);
      await inventory.recordInbound({ productId: other.id, quantityBoxes: 100 }, actor);

      const low = await inventory.listStock({ lowOnly: true });
      expect(low).toHaveLength(1);
      expect(low[0]?.productId).toBe(product.id);
    });

    it('clears a reorder level back to null', async () => {
      const { product } = await seed();
      await inventory.setReorderLevel(product.id, 5, actor);
      const cleared = await inventory.setReorderLevel(product.id, null, actor);

      expect(cleared.reorderLevel).toBeNull();
      expect(cleared.isLow).toBe(false);
    });

    it('rejects a negative reorder level', async () => {
      const { product } = await seed();
      await expect(inventory.setReorderLevel(product.id, -1, actor)).rejects.toThrow(/negative/i);
    });

    it('counts low-stock products for the dashboard', async () => {
      const { product } = await seed();
      await inventory.setReorderLevel(product.id, 5, actor);

      expect((await leads.getDashboardSummary()).lowStockCount).toBe(1);
    });
  });

  describe('stock moves when a lead becomes an order', () => {
    async function orderFor(productId: string, partyId: string, boxes: number) {
      const lead = await leads.createLead(
        { partyId, items: [{ productId, quantityBoxes: boxes }] },
        context,
      );
      await leads.changeLeadStatus(lead.id, 'verified', actor);
      return leads.changeLeadStatus(lead.id, 'order', actor);
    }

    it('deducts stock only when the lead reaches order, not before', async () => {
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 12 }] },
        context,
      );
      expect((await stockFor(product.id)).quantityBoxes).toBe(40);

      await leads.changeLeadStatus(lead.id, 'verified', actor);
      expect((await stockFor(product.id)).quantityBoxes).toBe(40);

      await leads.changeLeadStatus(lead.id, 'order', actor);
      expect((await stockFor(product.id)).quantityBoxes).toBe(28);
    });

    it('records the outbound movement against the order', async () => {
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);
      const order = await orderFor(product.id, party.id, 12);

      const movements = await inventory.listMovements({ productId: product.id });
      expect(movements[0]).toMatchObject({
        movementType: 'outbound',
        quantityBoxes: -12,
        referenceType: 'order',
        referenceId: order.id,
      });
    });

    it('deducts every line of a multi-product order', async () => {
      const { party, product } = await seed();
      const second = await catalog.createProduct({ productCode: 'B1', name: 'Other' }, actor);
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);
      await inventory.recordInbound({ productId: second.id, quantityBoxes: 20 }, actor);

      const lead = await leads.createLead(
        {
          partyId: party.id,
          items: [
            { productId: product.id, quantityBoxes: 5 },
            { productId: second.id, quantityBoxes: 7 },
          ],
        },
        context,
      );
      await leads.changeLeadStatus(lead.id, 'verified', actor);
      await leads.changeLeadStatus(lead.id, 'order', actor);

      expect((await stockFor(product.id)).quantityBoxes).toBe(35);
      expect((await stockFor(second.id)).quantityBoxes).toBe(13);
    });

    it('allows stock to go negative rather than blocking the sale', async () => {
      // A dealer routinely sells against a factory order that has not arrived.
      // Refusing the sale would break the real workflow; the negative figure is
      // the reorder signal.
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 5 }, actor);

      await orderFor(product.id, party.id, 12);

      expect((await stockFor(product.id)).quantityBoxes).toBe(-7);
    });

    it('restores stock when an order is cancelled', async () => {
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);
      const order = await orderFor(product.id, party.id, 12);
      expect((await stockFor(product.id)).quantityBoxes).toBe(28);

      await leads.changeLeadStatus(order.id, 'cancelled', actor);

      expect((await stockFor(product.id)).quantityBoxes).toBe(40);
    });

    it('restores by appending a movement rather than deleting history', async () => {
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);
      const order = await orderFor(product.id, party.id, 12);
      await leads.changeLeadStatus(order.id, 'cancelled', actor);

      const movements = await inventory.listMovements({ productId: product.id });
      expect(movements.map((entry) => entry.quantityBoxes)).toEqual([12, -12, 40]);
    });

    it('does not touch stock when a lead is cancelled before becoming an order', async () => {
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 12 }] },
        context,
      );
      await leads.changeLeadStatus(lead.id, 'cancelled', actor);

      expect((await stockFor(product.id)).quantityBoxes).toBe(40);
      expect(await inventory.listMovements({ productId: product.id })).toHaveLength(1);
    });

    it('ignores a line with no quantity instead of writing a zero movement', async () => {
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: null }] },
        context,
      );
      await leads.changeLeadStatus(lead.id, 'verified', actor);
      await leads.changeLeadStatus(lead.id, 'order', actor);

      expect((await stockFor(product.id)).quantityBoxes).toBe(40);
    });

    it('rolls the status change back if a stock movement fails', async () => {
      // The status change and the stock movements share one transaction, so a
      // failure must leave the lead unpromoted rather than half-applied.
      const { party, product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 40 }, actor);

      const lead = await leads.createLead(
        { partyId: party.id, items: [{ productId: product.id, quantityBoxes: 5 }] },
        context,
      );
      await leads.changeLeadStatus(lead.id, 'verified', actor);

      // Break the ledger insert so the movement cannot be written.
      await db().raw(`ALTER TABLE stock_movements ADD CONSTRAINT tmp_block CHECK (false) NOT VALID`);
      try {
        await expect(leads.changeLeadStatus(lead.id, 'order', actor)).rejects.toThrow();
      } finally {
        await db().raw(`ALTER TABLE stock_movements DROP CONSTRAINT tmp_block`);
      }

      expect((await leads.getLead(lead.id)).status).toBe('verified');
      expect((await stockFor(product.id)).quantityBoxes).toBe(40);
    });
  });

  describe('movement history', () => {
    it('returns newest first', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 10 }, actor);
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 20 }, actor);

      const movements = await inventory.listMovements({ productId: product.id });
      expect(movements.map((entry) => entry.quantityBoxes)).toEqual([20, 10]);
    });

    it('carries product identity so the list reads without a second lookup', async () => {
      const { product } = await seed();
      await inventory.recordInbound({ productId: product.id, quantityBoxes: 10 }, actor);

      expect((await inventory.listMovements({}))[0]).toMatchObject({
        productCode: 'GVT-01',
        productName: 'Carrara White',
      });
    });
  });
});
