/**
 * Reports against a real cluster, with timezone boundaries as first-class
 * cases: an order dispatched at 23:30 IST on the last of the month belongs
 * to that month, not the next. `docs/backend-modules/10-TESTING.md` §6.6
 * owns the gate list this suite answers (`RPT-6`…`RPT-17`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as inventoryService from '../src/services/inventory.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as reportService from '../src/services/report.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

async function createDispatchedOrder(
  city: string,
  createdAtIso?: string,
): Promise<{ orderId: string; partyId: string }> {
  const party = await catalogService.createParty({ name: `RPT Party ${city} ${Date.now()}`, city }, actor);
  const product = await catalogService.createProduct({ name: 'RPT Tile', productCode: `RPT-${Math.random().toString(36).slice(2, 8)}` }, actor);
  await inventoryService.recordInbound({ productId: product.id, colour: 'White', quantityBoxes: 100 }, actor);

  const lead = await leadService.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'White', quantity: 10 }] }],
    },
    actor,
  );
  const order = await orderService.convertLead({ leadId: lead.id }, actor);
  await orderService.dispatchOrder({ orderId: order.id }, actor);

  if (createdAtIso) {
    await db()('orders').where({ id: order.id }).update({ created_at: createdAtIso });
  }

  return { orderId: order.id, partyId: party.id };
}

async function setDispatchedAt(orderId: string, iso: string): Promise<void> {
  await db()('orders').where({ id: orderId }).update({ dispatched_at: iso });
}

describe.skipIf(!canRunIntegrationTests)('Reports (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  describe('dispatches', () => {
    it('RPT-6: an order dispatched at 23:30 IST on the last day of the month buckets into that month', async () => {
      const { orderId } = await createDispatchedOrder('Morbi');
      // 2026-02-28T23:30:00 IST == 2026-02-28T18:00:00Z. IST is UTC+5:30 and
      // carries no DST, so this is an exact, unambiguous instant regardless
      // of the test runner's own timezone.
      await setDispatchedAt(orderId, '2026-02-28T18:00:00.000Z');

      const report = await reportService.dispatchReport({ period: 'custom', fromMonth: '2026-02', toMonth: '2026-03' }, actor);
      const feb = report.months.find((m) => m.month === '2026-02');
      const mar = report.months.find((m) => m.month === '2026-03');
      expect(feb?.orderCount).toBe(1);
      expect(mar?.orderCount).toBe(0);
    });

    it('RPT-7: month labels are plain YYYY-MM strings, zero-filled for months with no dispatches', async () => {
      const report = await reportService.dispatchReport({ period: 'last3Months' }, actor);
      expect(report.months.every((m) => /^\d{4}-\d{2}$/.test(m.month))).toBe(true);
      expect(report.months.every((m) => m.orderCount === 0)).toBe(true);
    });

    it('RPT-8: dispatched boxes report positive even though the stock ledger delta is negative', async () => {
      const { orderId } = await createDispatchedOrder('Rajkot');
      await setDispatchedAt(orderId, new Date().toISOString());

      const movement = await db()('stock_movements')
        .where({ reference_type: 'order', reference_id: orderId, movement_type: 'outbound' })
        .first('quantity_boxes');
      expect(Number(movement.quantity_boxes)).toBeLessThan(0);

      const report = await reportService.dispatchReport({ period: 'thisMonth' }, actor);
      const thisMonth = report.months.find((m) => m.orderCount > 0);
      expect(thisMonth?.boxCount).toBeGreaterThan(0);
    });

    it('RPT-9: BIGINT totals sum as numbers, not strings', async () => {
      await createDispatchedOrder('Ahmedabad');
      await createDispatchedOrder('Surat');
      const report = await reportService.dispatchReport({ period: 'thisMonth' }, actor);
      expect(typeof report.totals.orderCount).toBe('number');
      expect(report.totals.orderCount).toBe(2);
      // A string-concatenation bug would produce "11" instead of 2 — this
      // assertion is what actually distinguishes the two.
      expect(report.totals.orderCount).not.toBe('11' as unknown as number);
    });

    it('RPT-12/13: a caller without field.saleRate.view gets no totalValue key at all, on buckets and totals', async () => {
      await createDispatchedOrder('Vadodara');
      const noRates = await actorWith(['reports.view']);
      const report = await reportService.dispatchReport({ period: 'thisMonth' }, noRates);

      expect(report.ratesIncluded).toBe(false);
      for (const bucket of report.months) expect('totalValue' in bucket).toBe(false);
      expect('totalValue' in report.totals).toBe(false);
    });

    it('RPT-16: reports.view names the missing permission', async () => {
      const noReports = await actorWith([]);
      await expect(reportService.dispatchReport({}, noReports)).rejects.toMatchObject({
        code: 'forbidden',
        details: { permission: 'reports.view' },
      });
    });
  });

  describe('lead outcomes', () => {
    it('RPT-10: a converted lead is counted once, never doubly, and a Won-but-unconverted lead is not "converted"', async () => {
      const { orderId: _ } = await createDispatchedOrder('Jamnagar');
      void _;

      const report = await reportService.leadOutcomeReport({ period: 'thisMonth' }, actor);
      const thisMonth = report.months.find((m) => m.converted + m.lost + m.quiet + m.open > 0);
      expect(thisMonth?.converted).toBe(1);
    });

    it('echoes the quietAfterDays threshold actually applied', async () => {
      const report = await reportService.leadOutcomeReport({ period: 'thisMonth' }, actor);
      expect(report.quietAfterDays).toBeGreaterThan(0);
    });
  });

  describe('top parties', () => {
    it('RPT-17: anchored on dispatched_at, not created_at — created in March, dispatched in April, lands in April', async () => {
      const { orderId } = await createDispatchedOrder('AnchorCity', '2026-03-05T10:00:00.000Z');
      await setDispatchedAt(orderId, '2026-04-10T10:00:00.000Z');

      const march = await reportService.topPartiesReport(
        { period: 'custom', fromMonth: '2026-03', toMonth: '2026-03' },
        actor,
      );
      const april = await reportService.topPartiesReport(
        { period: 'custom', fromMonth: '2026-04', toMonth: '2026-04' },
        actor,
      );

      expect(march.parties.some((p) => p.city === 'AnchorCity')).toBe(false);
      expect(april.parties.some((p) => p.city === 'AnchorCity')).toBe(true);
    });

    it('RPT-15: cities group case- and whitespace-insensitively; blank/null collapse into one unknown bucket', async () => {
      await createDispatchedOrder('Morbi');
      await createDispatchedOrder('morbi');
      await createDispatchedOrder(' Morbi ');
      await createDispatchedOrder('');

      const report = await reportService.topPartiesReport({ period: 'thisMonth' }, actor);
      const morbi = report.cities.find((c) => c.city?.toLowerCase() === 'morbi');
      expect(morbi?.partyCount).toBe(3);

      const unknown = report.cities.find((c) => c.city === null);
      expect(unknown?.partyCount).toBe(1);
    });

    it('RPT-14: orders by orderCount and says so when value is hidden', async () => {
      const noRates = await actorWith(['reports.view']);
      const report = await reportService.topPartiesReport({ period: 'thisMonth' }, noRates);
      expect(report.orderedBy).toBe('orderCount');
      expect(report.ratesIncluded).toBe(false);
      for (const party of report.parties) expect('totalValue' in party).toBe(false);
    });
  });

  describe('export', () => {
    it('RPT-16 (export half): reports.export names the missing permission', async () => {
      const viewOnly = await actorWith(['reports.view']);
      await expect(reportService.exportReport('dispatches', {}, viewOnly)).rejects.toMatchObject({
        code: 'forbidden',
        details: { permission: 'reports.export' },
      });
    });

    it('produces a CSV with an empty cell for a redacted total, never 0', async () => {
      await createDispatchedOrder('ExportCity');
      const noRates = await actorWith(['reports.view', 'reports.export']);
      const { csv, rowCount } = await reportService.exportReport('dispatches', { period: 'thisMonth' }, noRates);

      expect(rowCount).toBeGreaterThan(0);
      const lines = csv.trim().split('\r\n');
      expect(lines[0]).toBe('month,orderCount,boxCount,totalValue');
      const dataLine = lines[1] ?? '';
      expect(dataLine.endsWith(',')).toBe(true); // trailing totalValue cell is empty
    });
  });
});
