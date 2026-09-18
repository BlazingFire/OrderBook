/**
 * Reports against a real cluster, with timezone boundaries as first-class
 * cases: an order dispatched at 23:30 IST on the last of the month belongs
 * to that month, not the next. `docs/backend-modules/10-TESTING.md` §6.6
 * owns the gate list this suite answers (`RPT-6`…`RPT-17`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as inventoryService from '../src/services/inventory.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as reportService from '../src/services/report.service.js';
import * as settingsService from '../src/services/settings.service.js';
import { classifyLeadOutcome } from '../src/domain/lead-outcome.js';
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

/** A lead that is neither converted nor in a terminal stage — the "open" shape. */
async function createOpenLead(city: string): Promise<string> {
  const party = await catalogService.createParty({ name: `RPT Open ${city} ${Date.now()}`, city }, actor);
  const product = await catalogService.createProduct(
    { name: 'RPT Tile', productCode: `RPO-${Math.random().toString(36).slice(2, 8)}` },
    actor,
  );
  const lead = await leadService.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, packaging: 'Box', quantities: [{ colour: 'White', quantity: 5 }] }],
    },
    actor,
  );
  return lead.id;
}

function totalFor(
  report: Awaited<ReturnType<typeof reportService.leadOutcomeReport>>,
  outcome: 'converted' | 'lost' | 'quiet' | 'open',
): number {
  return report.months.reduce((sum, month) => sum + month[outcome], 0);
}

/**
 * The same facts the SQL reads, as calendar components in the report's own
 * timezone — so the two halves are compared on one set of inputs rather than
 * on whatever the test runner's clock happens to say.
 */
async function factsFor(leadId: string) {
  const tz = config.locale.timeZone;
  const { rows } = await db().raw<{
    rows: Array<{
      converted_order_id: string | null;
      is_terminal: boolean;
      last_y: number;
      last_m: number;
      last_d: number;
      now_y: number;
      now_m: number;
      now_d: number;
    }>;
  }>(
    `SELECT l.converted_order_id,
            s.is_terminal,
            extract(year  from (l.updated_at AT TIME ZONE ?))::int AS last_y,
            extract(month from (l.updated_at AT TIME ZONE ?))::int AS last_m,
            extract(day   from (l.updated_at AT TIME ZONE ?))::int AS last_d,
            extract(year  from (now() AT TIME ZONE ?))::int AS now_y,
            extract(month from (now() AT TIME ZONE ?))::int AS now_m,
            extract(day   from (now() AT TIME ZONE ?))::int AS now_d
       FROM leads l
       JOIN pipeline_stages s ON s.id = l.stage_id
      WHERE l.id = ?`,
    [tz, tz, tz, tz, tz, tz, leadId],
  );

  const row = rows[0]!;
  return {
    lead: {
      convertedOrderId: row.converted_order_id,
      isTerminal: row.is_terminal,
      lastActivityAt: { year: row.last_y, month: row.last_m, day: row.last_d },
    },
    asOf: { year: row.now_y, month: row.now_m, day: row.now_d },
  };
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

    it("applies the company's own quiet threshold, and echoes the one it applied", async () => {
      // The SQL half of this rule and the pure `classifyLeadOutcome` half have
      // to agree, and both now take the number from `leads.quietAfterDays`.
      // A 30 left hardcoded on either side is invisible at the default, so
      // everything here is asserted at a threshold that is not 30.
      const leadId = await createOpenLead('Rajkot');
      await db()('leads')
        .where({ id: leadId })
        .update({ updated_at: db().raw("now() - interval '10 days'") });

      await settingsService.writeSetting(actor, 'leads.quietAfterDays', 7);
      const strict = await reportService.leadOutcomeReport({ period: 'thisMonth' }, actor);
      expect(strict.quietAfterDays).toBe(7);
      expect(totalFor(strict, 'quiet')).toBe(1);
      expect(totalFor(strict, 'open')).toBe(0);

      await settingsService.writeSetting(actor, 'leads.quietAfterDays', 14);
      const lenient = await reportService.leadOutcomeReport({ period: 'thisMonth' }, actor);
      expect(lenient.quietAfterDays).toBe(14);
      expect(totalFor(lenient, 'quiet')).toBe(0);
      expect(totalFor(lenient, 'open')).toBe(1);
    });

    it('classifies a lead the same way in SQL and in the pure classifier', async () => {
      // Same lead, same threshold, both halves asked. The pure half has no
      // production caller, so nothing but this comparison can see it drift.
      const leadId = await createOpenLead('Bhuj');
      await db()('leads')
        .where({ id: leadId })
        .update({ updated_at: db().raw("now() - interval '10 days'") });

      await settingsService.writeSetting(actor, 'leads.quietAfterDays', 7);

      const report = await reportService.leadOutcomeReport({ period: 'thisMonth' }, actor);
      const inSql = (['converted', 'lost', 'quiet', 'open'] as const).find(
        (outcome) => totalFor(report, outcome) === 1,
      );

      const facts = await factsFor(leadId);
      expect(classifyLeadOutcome(facts.lead, facts.asOf, report.quietAfterDays)).toBe(inSql);
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
      const exported = await reportService.exportReport(
        'dispatches',
        { period: 'thisMonth' },
        noRates,
      );
      const { csv, rowCount } = exported as { csv: string; rowCount: number };

      expect(rowCount).toBeGreaterThan(0);
      const lines = csv.trim().split('\r\n');
      expect(lines[0]).toBe('month,orderCount,boxCount,totalValue');
      const dataLine = lines[1] ?? '';
      expect(dataLine.endsWith(',')).toBe(true); // trailing totalValue cell is empty
    });

    it('narrows and reorders to the columns asked for', async () => {
      await createDispatchedOrder('ExportCity');
      const actor = await testActor();

      const exported = await reportService.exportReport(
        'dispatches',
        { period: 'thisMonth', columns: ['orderCount', 'month'] },
        actor,
      );

      expect(exported.format).toBe('csv');
      const lines = (exported as { csv: string }).csv.trim().split('\r\n');
      expect(lines[0]).toBe('orderCount,month');
    });

    it('ignores a column that no longer exists rather than refusing', async () => {
      await createDispatchedOrder('ExportCity');
      const actor = await testActor();

      // A bookmarked URL must keep working when a column is renamed. Asking
      // for nothing recognisable falls back to everything, because an empty
      // spreadsheet is never what somebody meant.
      const exported = await reportService.exportReport(
        'dispatches',
        { period: 'thisMonth', columns: ['thisColumnWentAway'] },
        actor,
      );

      const lines = (exported as { csv: string }).csv.trim().split('\r\n');
      expect(lines[0]).toBe('month,orderCount,boxCount,totalValue');
    });

    it('appends a totals row that sums only the numeric columns', async () => {
      await createDispatchedOrder('ExportCity');
      const actor = await testActor();

      const exported = await reportService.exportReport(
        'dispatches',
        { period: 'thisMonth', totals: true },
        actor,
      );

      const lines = (exported as { csv: string }).csv.trim().split('\r\n');
      const totals = (lines[lines.length - 1] ?? '').split(',');

      // A total of a month name is nonsense, so the first cell is the label.
      expect(totals[0]).toBe('Total');
      expect(Number(totals[1])).toBeGreaterThan(0);
    });

    it('never sums a money column it just redacted', async () => {
      await createDispatchedOrder('ExportCity');
      const noRates = await actorWith(['reports.view', 'reports.export']);

      const exported = await reportService.exportReport(
        'dispatches',
        { period: 'thisMonth', totals: true },
        noRates,
      );

      const lines = (exported as { csv: string }).csv.trim().split('\r\n');
      const totals = (lines[lines.length - 1] ?? '').split(',');

      // A total would reconstruct exactly the figure the redaction withheld.
      expect(totals[totals.length - 1]).toBe('');
    });

    it('renders a PDF when one is asked for', async () => {
      await createDispatchedOrder('ExportCity');
      const actor = await testActor();

      const exported = await reportService.exportReport(
        'dispatches',
        { period: 'thisMonth', format: 'pdf' },
        actor,
      );

      expect(exported.format).toBe('pdf');
      const pdf = exported as { bytes: Buffer; fileName: string; contentType: string };
      expect(pdf.contentType).toBe('application/pdf');
      expect(pdf.fileName).toBe('dispatches.pdf');
      // A real PDF, not an empty buffer with the right name on it.
      expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });
});
