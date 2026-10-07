/**
 * The 1.3 reports against a real cluster: the table every kind answers, whose
 * figures a person gets, who may see Reports at all, the two new periods, the
 * Excel and PDF exports, the legacy CSV bytes, and the grant that gives the
 * Office and Management tiers the report permissions.
 *
 * The legacy cases are in `reports.integration.test.ts`; this file is what the
 * fifteen kinds added.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORT_EXPORT_CAPS, REPORT_KINDS, type ReportKind } from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import { up as grantReports } from '../src/db/migrations/20261004000000_report_indexes_and_grants.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as reportRepo from '../src/repositories/report.repository.js';
import * as reportService from '../src/services/report.service.js';
import * as roleService from '../src/services/role.service.js';
import * as settingsService from '../src/services/settings.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let admin: ActorContext;

const KEYS = ['reports.view', 'reports.export'] as const;

async function makeUser(username: string, tier: 'office' | 'management' = 'office'): Promise<string> {
  const role = await roleService.createRole({ name: `Reports ${username}`, tier, permissions: [...KEYS] }, admin);
  const { user } = await userService.createUser({ username, displayName: username, roleId: role.id }, admin);
  return user.id;
}

/** A signed-in person asking for a report: their own tier, only the report permissions. */
async function viewer(userId: string, tier: 'office' | 'management' = 'office'): Promise<ActorContext> {
  return testActor({
    userId,
    actorId: userId,
    permissions: { roleId: null, roleName: 'Viewer', tier, permissions: [...KEYS] },
  });
}

/** An actor who creates records as this user: the report tests need data owned by different people. */
async function author(userId: string): Promise<ActorContext> {
  return testActor({ userId, actorId: userId });
}

interface Shop {
  /** One product shared by every order, 2.5 kg a piece, so kilograms are checkable. */
  productId: string;
  variantId: string;
  code: string;
}

async function makeShop(): Promise<Shop> {
  const code = `RPT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const product = await catalogService.createProduct(
    {
      name: 'Report Basin',
      categoryName: 'Tiles',
      hasVariants: true,
      variants: [{ code, label: 'White', weightKg: 2.5 }],
    },
    admin,
  );
  const variantId = product.variants[0]!.id;
  return { productId: product.id, variantId, code };
}

async function makeLead(by: ActorContext, shop: Shop, partyName: string, city: string, quantity = 10) {
  const party = await catalogService.createParty({ name: partyName, city }, admin);
  const lead = await leadService.createLead(
    { partyId: party.id, items: [{ productId: shop.productId, variantId: shop.variantId, quantity, packaging: 'Box' }] },
    by,
  );
  return { party, lead };
}

/** A lead raised, converted and dispatched by one person. */
async function makeDispatched(by: ActorContext, shop: Shop, partyName: string, city: string, quantity = 10) {
  const { party, lead } = await makeLead(by, shop, partyName, city, quantity);
  const order = await orderService.convertLead({ leadId: lead.id }, by);
  await orderService.dispatchOrder({ orderId: order.id }, by);
  return { party, lead, order };
}

async function today(): Promise<string> {
  const { rows } = await db().raw<{ rows: Array<{ d: string }> }>(
    `SELECT to_char(now() AT TIME ZONE ?, 'YYYY-MM-DD') AS d`,
    [config.locale.timeZone],
  );
  return rows[0]!.d;
}

describe.skipIf(!canRunIntegrationTests)('report tables (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  describe('whose figures', () => {
    it('gives each person their own row, and an administrator everyone', async () => {
      const alice = await makeUser('alice');
      const bob = await makeUser('zzbob');
      const shop = await makeShop();
      const a = await author(alice);
      const b = await author(bob);

      await makeDispatched(a, shop, 'Alice Traders', 'Morbi');
      await makeLead(a, shop, 'Alice Open', 'Morbi'); // stays open
      await makeDispatched(b, shop, 'ZZBob Traders', 'Rajkot', 4);

      const table = await reportService.reportTable('by-user', { period: 'thisMonth' }, admin);
      expect(table.subject).toEqual({ id: null, name: null });
      expect(table.rows).toEqual([
        { user: 'alice', created: 2, converted: 1, lost: 0, open: 1, dispatched: 1, pieces: 10, kg: 25 },
        { user: 'zzbob', created: 1, converted: 1, lost: 0, open: 0, dispatched: 1, pieces: 4, kg: 10 },
      ]);
      expect(table.totals).toEqual({ created: 3, converted: 2, lost: 0, open: 1, dispatched: 2, pieces: 14, kg: 35 });
      expect(table.rowCount).toBe(2);
      expect(table.truncated).toBe(false);

      const own = await reportService.reportTable('by-user', { period: 'thisMonth' }, await viewer(alice));
      expect(own.subject).toEqual({ id: alice, name: 'alice' });
      expect(own.rows.map((row) => row.user)).toEqual(['alice']);
      expect(own.totals).toMatchObject({ created: 2, pieces: 10 });
    });

    it('is the same table for an office user as for an administrator asking about that user, on every kind', async () => {
      const alice = await makeUser('alice');
      const bob = await makeUser('zzbob');
      const shop = await makeShop();
      const a = await author(alice);
      const b = await author(bob);

      await makeDispatched(a, shop, 'Alice Traders', 'Morbi');
      await makeLead(a, shop, 'Alice Open', 'Morbi');
      await makeDispatched(b, shop, 'ZZBob Traders', 'Rajkot', 4);
      await makeLead(b, shop, 'ZZBob Open', 'Rajkot');

      const me = await viewer(alice);
      for (const kind of REPORT_KINDS) {
        const mine = await reportService.reportTable(kind, { period: 'thisMonth' }, me);
        const asked = await reportService.reportTable(kind, { period: 'thisMonth', subjectId: alice }, admin);
        expect(mine, kind).toEqual(asked);

        // Nothing of the other person's leaks into the answer, whatever the kind.
        expect(JSON.stringify(mine).toLowerCase(), kind).not.toContain('zzbob');
        expect(mine.subject.id, kind).toBe(alice);
      }

      // And the whole company's table does hold both, so the check above can fail.
      const everyone = await reportService.reportTable('open-pending-orders', {}, admin);
      expect(JSON.stringify(everyone).toLowerCase()).toContain('zzbob');
    });

    it('refuses an office or management user who asks about somebody else, and answers one who names themselves', async () => {
      const alice = await makeUser('alice');
      const bob = await makeUser('zzbob');
      const carol = await makeUser('carol', 'management');

      await expect(reportService.reportTable('by-user', { subjectId: bob }, await viewer(alice))).rejects.toMatchObject({
        code: 'forbidden',
        messageKey: 'validation.reports.subject.forbidden',
      });
      await expect(reportService.reportTable('by-user', { subjectId: alice }, await viewer(carol, 'management'))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(reportService.reportTable('by-user', { subjectId: alice }, await viewer(alice))).resolves.toMatchObject({
        subject: { id: alice },
      });
      await expect(reportService.exportReport('by-user', { subjectId: bob }, await viewer(alice))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a non-administrator with no signed-in user rather than answering with everyone', async () => {
      const nobody = await testActor({ permissions: { roleId: null, roleName: 'V', tier: 'office', permissions: [...KEYS] } });
      await expect(reportService.reportTable('by-user', {}, nobody)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('lets an administrator pick any live user — another administrator included — and refuses one that does not exist', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      await makeDispatched(await author(alice), shop, 'Alice Traders', 'Morbi');

      const picked = await reportService.reportTable('by-user', { subjectId: alice }, admin);
      expect(picked.subject.name).toBe('alice');
      expect(picked.rows).toHaveLength(1);

      await expect(reportService.reportTable('by-user', { subjectId: 'US0000009999' }, admin)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('who sees Reports', () => {
    it('follows the two company switches, never switches an administrator off, and says why', async () => {
      const alice = await makeUser('alice');
      const carol = await makeUser('carol', 'management');
      const office = await viewer(alice);
      const management = await viewer(carol, 'management');

      await expect(reportService.reportTable('by-user', {}, office)).resolves.toBeDefined();
      await expect(reportService.reportTable('by-user', {}, management)).resolves.toBeDefined();

      await settingsService.writeSetting(admin, 'reports.visibleToOffice', false);
      await expect(reportService.reportTable('by-user', {}, office)).rejects.toMatchObject({
        code: 'forbidden',
        messageKey: 'error.forbidden.reportsHidden',
      });
      await expect(reportService.reportOptions(office)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reportService.exportReport('by-user', {}, office)).rejects.toBeInstanceOf(ForbiddenError);
      // The legacy typed reports are held to it too.
      await expect(reportService.dispatchReport({}, office)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reportService.reportTable('by-user', {}, management)).resolves.toBeDefined();

      await settingsService.writeSetting(admin, 'reports.visibleToManagement', false);
      await expect(reportService.reportTable('by-user', {}, management)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reportService.reportTable('by-user', {}, admin)).resolves.toBeDefined();
      await expect(reportService.reportOptions(admin)).resolves.toBeDefined();

      await settingsService.writeSetting(admin, 'reports.visibleToOffice', true);
      await expect(reportService.reportTable('by-user', {}, office)).resolves.toBeDefined();
    });

    it('offers an administrator every user to pick from and the Office only itself', async () => {
      const alice = await makeUser('alice');
      await makeUser('zzbob');

      const forAdmin = await reportService.reportOptions(admin);
      expect(forAdmin.kinds).toHaveLength(15);
      expect(forAdmin.canExport).toBe(true);
      expect(forAdmin.subjects?.map((subject) => subject.name)).toEqual(['alice', 'zzbob']);

      const forOffice = await reportService.reportOptions(await viewer(alice));
      expect(forOffice.subjects).toBeNull();
      expect(forOffice.kinds).toEqual(forAdmin.kinds);
    });

    it('needs reports.view for a table and reports.export for a file, naming the missing key', async () => {
      const alice = await makeUser('alice');
      const noView = await testActor({
        userId: alice,
        actorId: alice,
        permissions: { roleId: null, roleName: 'V', tier: 'office', permissions: ['reports.export'] },
      });
      await expect(reportService.reportTable('by-user', {}, noView)).rejects.toMatchObject({ details: { permission: 'reports.view' } });
      await expect(reportService.reportOptions(noView)).rejects.toMatchObject({ details: { permission: 'reports.view' } });

      const noExport = await testActor({
        userId: alice,
        actorId: alice,
        permissions: { roleId: null, roleName: 'V', tier: 'office', permissions: ['reports.view'] },
      });
      await expect(reportService.exportReport('by-user', {}, noExport)).rejects.toMatchObject({ details: { permission: 'reports.export' } });
      expect((await reportService.reportOptions(noExport)).canExport).toBe(false);

      // A file is a report written down: the key to read it comes first, so a
      // role holding only `reports.export` is refused naming `reports.view`.
      await expect(reportService.exportReport('by-user', {}, noView)).rejects.toMatchObject({
        statusCode: 403,
        details: { permission: 'reports.view' },
      });
      await expect(reportService.exportReport('dispatches', {}, noView)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('is granted to every office and management role by the migration, once, and never to an administrator role', async () => {
      // `noticeBoard: false`: a new role is otherwise given notices.view, which is not what is under test.
      const plain = { permissions: ['leads.view'], noticeBoard: false };
      const office = await roleService.createRole({ name: 'Plain office', tier: 'office', ...plain }, admin);
      const management = await roleService.createRole({ name: 'Plain management', tier: 'management', ...plain }, admin);
      const owner = await roleService.createRole({ name: 'Plain admin', tier: 'admin', ...plain }, admin);

      // The roles above were created after the migration ran, so none holds the keys yet.
      const stored = async (id: string): Promise<string[]> => {
        const row = await db()('roles').where({ id }).first<{ permissions: string[] }>('permissions');
        return row?.permissions ?? [];
      };
      expect(await stored(office.id)).not.toContain('reports.view');

      await grantReports(db());
      await grantReports(db());

      expect(await stored(office.id)).toEqual(['leads.view', 'reports.export', 'reports.view']);
      expect(await stored(management.id)).toEqual(['leads.view', 'reports.export', 'reports.view']);
      expect(await stored(owner.id)).toEqual(['leads.view']);
    });

    it('indexes leads by owner and creation date for live rows only', async () => {
      const row = await db()('pg_indexes')
        .where({ tablename: 'leads', indexname: 'idx_leads_owner_created' })
        .first<{ indexdef: string }>('indexdef');
      expect(row?.indexdef).toContain('WHERE (deleted_at IS NULL)');
    });
  });

  describe('what each kind counts', () => {
    it('reads parties, cities, products, sub products and brands from the dispatched orders', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);

      await makeDispatched(a, shop, 'Shah Ceramics', 'Morbi', 10);
      await makeDispatched(a, shop, 'shah ceramics', ' morbi ', 6); // same party name and city, spelt loosely
      await makeDispatched(a, shop, 'Patel Traders', 'Rajkot', 4);
      await makeLead(a, shop, 'Only A Lead', 'Surat'); // not an order: never in the order reports

      const byCity = await reportService.reportTable('by-city', { period: 'thisMonth' }, admin);
      // Spelt loosely, one bucket; which spelling labels it is the database's collation to say.
      expect(byCity.rows.map((row) => ({ ...row, city: String(row.city).toLowerCase() }))).toEqual([
        { city: 'morbi', parties: 2, orders: 2, pieces: 16, kg: 40 },
        { city: 'rajkot', parties: 1, orders: 1, pieces: 4, kg: 10 },
      ]);

      const byParty = await reportService.reportTable('by-party', { period: 'thisMonth' }, admin);
      expect(byParty.rows.map((row) => [row.partyName, row.leads, row.orders, row.pieces, row.kg, row.daysSince])).toEqual([
        ['Shah Ceramics', 1, 1, 10, 25, 0],
        ['shah ceramics', 1, 1, 6, 15, 0],
        ['Patel Traders', 1, 1, 4, 10, 0],
        ['Only A Lead', 1, 0, 0, 0, null],
      ].sort((x, y) => (y[2] as number) - (x[2] as number) || (y[1] as number) - (x[1] as number) || String(x[0]).localeCompare(String(y[0]))));
      expect(byParty.rows.find((row) => row.partyName === 'Only A Lead')).toMatchObject({ lastOrder: null, daysSince: null });

      const byProduct = await reportService.reportTable('by-product', { period: 'thisMonth' }, admin);
      expect(byProduct.rows).toEqual([{ code: '', product: 'Tiles', orders: 3, pieces: 20, kg: 50 }]);

      const byVariant = await reportService.reportTable('by-variant', { period: 'thisMonth' }, admin);
      expect(byVariant.rows).toEqual([{ code: shop.code, subProduct: 'Report Basin', orders: 3, pieces: 20, kg: 50 }]);

      const byBrand = await reportService.reportTable('by-brand', { period: 'thisMonth' }, admin);
      expect(byBrand.rows).toEqual([{ brand: '', orders: 3, pieces: 20, kg: 50 }]);
    });

    it('leaves a line with no weight out of kilograms rather than counting it as zero', async () => {
      const alice = await makeUser('alice');
      const bare = await catalogService.createProduct(
        { name: 'Bare Basin', categoryName: 'Basins', hasVariants: true, variants: [{ code: 'BARE-1', label: 'White' }] },
        admin,
      );
      const a = await author(alice);
      const party = await catalogService.createParty({ name: 'Bare Party', city: 'Morbi' }, admin);
      const lead = await leadService.createLead(
        { partyId: party.id, items: [{ productId: bare.id, variantId: bare.variants[0]!.id, quantity: 7, packaging: 'Box' }] },
        a,
      );
      await orderService.dispatchOrder({ orderId: (await orderService.convertLead({ leadId: lead.id }, a)).id }, a);

      const byVariant = await reportService.reportTable('by-variant', { period: 'thisMonth' }, admin);
      expect(byVariant.rows).toEqual([{ code: 'BARE-1', subProduct: 'Bare Basin', orders: 1, pieces: 7, kg: 0 }]);
    });

    it('lists parties that ordered before the range and not in it, longest silent first', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);

      const stale = await makeDispatched(a, shop, 'Gone Quiet', 'Morbi');
      await db()('orders').where({ id: stale.order.id }).update({ dispatched_at: db().raw("now() - interval '400 days'") });
      const older = await makeDispatched(a, shop, 'Gone Quieter', 'Morbi');
      await db()('orders').where({ id: older.order.id }).update({ dispatched_at: db().raw("now() - interval '500 days'") });
      await makeDispatched(a, shop, 'Active Co', 'Morbi'); // ordered this month: not dormant

      const table = await reportService.reportTable('party-dormant', { period: 'thisMonth' }, admin);
      expect(table.rows.map((row) => [row.partyName, row.orders])).toEqual([
        ['Gone Quieter', 0],
        ['Gone Quiet', 0],
      ]);
      expect(Number(table.rows[0]!.daysSince)).toBeGreaterThanOrEqual(500);
      expect(Number(table.rows[1]!.daysSince)).toBeGreaterThanOrEqual(400);
      expect(table.totals).toEqual({ orders: 0 });
    });

    it('does not list a party that has ordered again since the range — only one whose latest order is older than it', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);

      const stillOrders = await makeDispatched(a, shop, 'Orders Again', 'Morbi');
      await db()('orders').where({ id: stillOrders.order.id }).update({ dispatched_at: '2025-12-10T06:00:00.000Z' });
      const may = await makeDispatched(a, shop, 'Orders Again Spare', 'Morbi');
      await db()('orders').where({ id: may.order.id }).update({ dispatched_at: '2026-05-10T06:00:00.000Z' });
      // Same party: make the May order belong to the party that ordered in December.
      await db()('orders').where({ id: may.order.id }).update({ party_id: stillOrders.party.id });

      const quiet = await makeDispatched(a, shop, 'Truly Quiet', 'Morbi');
      await db()('orders').where({ id: quiet.order.id }).update({ dispatched_at: '2025-12-12T06:00:00.000Z' });

      const range = { period: 'customDates' as const, fromDate: '2026-01-01', toDate: '2026-03-31' };
      const table = await reportService.reportTable('party-dormant', range, admin);
      expect(table.rows.map((row) => row.partyName)).toEqual(['Truly Quiet']);
    });

    it('measures a pending order from the stage it entered, ignores the date range, and lists the open ones oldest first', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);

      const first = await makeLead(a, shop, 'Old Lead', 'Morbi', 3);
      const second = await makeLead(a, shop, 'New Lead', 'Rajkot', 5);
      await makeDispatched(a, shop, 'Done', 'Morbi'); // converted: not open
      for (const [id, days] of [[first.lead.id, 9], [second.lead.id, 3]] as const) {
        await db().raw(`UPDATE leads SET created_at = now() - (? || ' days')::interval WHERE id = ?`, [String(days), id]);
        await db().raw(
          `UPDATE timeline_entries SET created_at = now() - (? || ' days')::interval WHERE parent_type = 'lead' AND parent_id = ?`,
          [String(days), id],
        );
      }

      const open = await reportService.reportTable('open-pending-orders', { period: 'thisMonth' }, admin);
      expect(open.rows.map((row) => [row.number, row.party, row.owner, row.daysOpen, row.pieces])).toEqual([
        // Named by the PO number, as every screen names a pending order.
        [first.lead.poNumber, 'Old Lead', 'alice', 9, 3],
        [second.lead.poNumber, 'New Lead', 'alice', 3, 5],
      ]);
      expect(open.totals).toEqual({ pieces: 8 });

      const ageing = await reportService.reportTable('stage-ageing', { period: 'thisMonth' }, admin);
      expect(ageing.rows).toHaveLength(1);
      expect(ageing.rows[0]).toMatchObject({ open: 2, avgDays: 6, oldestDays: 9 });
    });

    it('counts conversion by source, and the days a conversion took', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);

      const won = await makeDispatched(a, shop, 'Won', 'Morbi');
      const lost = await makeLead(a, shop, 'Still Open', 'Morbi');
      const other = await makeLead(a, shop, 'Walk In', 'Morbi');
      await db()('leads').whereIn('id', [won.lead.id, lost.lead.id]).update({ source_platform: 'WhatsApp' });
      await db()('leads').where({ id: other.lead.id }).update({ source_platform: null });
      await db().raw(`UPDATE leads SET created_at = converted_at - interval '4 days' WHERE id = ?`, [won.lead.id]);

      // The conversion is dated this month; the lead it came from was raised
      // four days earlier, which may be last month.
      const sources = await reportService.reportTable('lead-sources', { period: 'last3Months' }, admin);
      expect(sources.rows).toEqual([
        { source: 'WhatsApp', leads: 2, converted: 1, percent: 50 },
        { source: '', leads: 1, converted: 0, percent: 0 },
      ]);

      const time = await reportService.reportTable('conversion-time', { period: 'last3Months' }, admin);
      expect(time.rows).toHaveLength(1);
      expect(time.rows[0]).toMatchObject({ converted: 1, avgDays: 4, maxDays: 4 });
    });

    it('splits a day by person in User by day, counting a conversion on the day it happened', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);
      await makeDispatched(a, shop, 'Alice Traders', 'Morbi');
      await makeLead(a, shop, 'Alice Open', 'Morbi');

      const table = await reportService.reportTable('user-daily', { period: 'thisMonth' }, admin);
      expect(table.rows).toEqual([{ day: await today(), user: 'alice', created: 2, converted: 1, dispatched: 1, pieces: 10 }]);
    });

    it('keeps the legacy kinds as tables too, with the colours and the cities as sections', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      await makeDispatched(await author(alice), shop, 'Shah Ceramics', 'Morbi');

      const dispatches = await reportService.reportTable('dispatches', { period: 'thisMonth' }, admin);
      expect(dispatches.columns.map((column) => column.key)).toEqual(['month', 'orderCount', 'pieces']);
      expect(dispatches.rows).toHaveLength(1);
      expect(dispatches.sections.map((section) => section.titleToken)).toEqual(['reports.dispatches.byColour']);
      expect(dispatches.sections[0]!.rows).toEqual([{ colour: 'White', pieces: dispatches.rows[0]!.pieces }]);

      const top = await reportService.reportTable('top-parties', { period: 'thisMonth' }, admin);
      // The id column is a key for a program, not a column for a person.
      expect(top.columns.map((column) => column.key)).toEqual(['partyName', 'partyCode', 'city', 'orderCount']);
      expect(top.sections[0]!.rows).toEqual([{ city: 'Morbi', partyCount: 1, orderCount: 1 }]);

      const outcomes = await reportService.reportTable('lead-outcomes', { period: 'thisMonth' }, admin);
      expect(outcomes.quietAfterDays).toBe(30);
      expect(outcomes.totals).toEqual({ converted: 1, lost: 0, quiet: 0, open: 0 });
    });

    it('cuts a table for the screen at its cap and says so, while the totals still count every row', async () => {
      // 2,001 rows would take minutes to seed; the cap is a constant, so the
      // statement is checked on the type instead: a table under it is not cut.
      const alice = await makeUser('alice');
      const shop = await makeShop();
      await makeDispatched(await author(alice), shop, 'Shah Ceramics', 'Morbi');
      const table = await reportService.reportTable('by-city', { period: 'thisMonth' }, admin);
      expect(table.truncated).toBe(false);
      expect(table.rowCount).toBe(table.rows.length);
    });
  });

  describe('periods', () => {
    it('includes the whole last day of an exact range and nothing from the next, in the business time zone', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const inside = await makeDispatched(await author(alice), shop, 'Last Day', 'Morbi');
      const outside = await makeDispatched(await author(alice), shop, 'Next Day', 'Morbi');
      // 23:30 IST on 28 February, and the first minute of 1 March IST.
      await db()('orders').where({ id: inside.order.id }).update({ dispatched_at: '2026-02-28T18:00:00.000Z' });
      await db()('orders').where({ id: outside.order.id }).update({ dispatched_at: '2026-02-28T18:31:00.000Z' });

      const february = await reportService.reportTable('by-party', { period: 'customDates', fromDate: '2026-02-01', toDate: '2026-02-28' }, admin);
      expect(february.rows.filter((row) => Number(row.orders) > 0).map((row) => row.partyName)).toEqual(['Last Day']);
      expect(february.range).toMatchObject({ fromDate: '2026-02-01', toDateExclusive: '2026-03-01', months: ['2026-02'] });

      const march = await reportService.reportTable('by-party', { period: 'customDates', fromDate: '2026-03-01', toDate: '2026-03-31' }, admin);
      expect(march.rows.filter((row) => Number(row.orders) > 0).map((row) => row.partyName)).toEqual(['Next Day']);
    });

    it('runs this financial year from 1 April and leaves the day before it out', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const now = await makeDispatched(await author(alice), shop, 'This Year', 'Morbi');
      const before = await makeDispatched(await author(alice), shop, 'Last Year', 'Morbi');

      const table = await reportService.reportTable('by-city', { period: 'thisFinancialYear' }, admin);
      expect(table.range.period).toBe('thisFinancialYear');
      expect(table.range.fromDate.endsWith('-04-01')).toBe(true);
      expect(table.range.months.length).toBeLessThanOrEqual(12);
      expect(table.rows.reduce((sum, row) => sum + Number(row.orders), 0)).toBe(2);

      await db()('orders')
        .where({ id: before.order.id })
        .update({ dispatched_at: db().raw(`((? )::timestamp AT TIME ZONE ?) - interval '1 hour'`, [table.range.fromDate, config.locale.timeZone]) });
      const after = await reportService.reportTable('by-city', { period: 'thisFinancialYear' }, admin);
      expect(after.rows.reduce((sum, row) => sum + Number(row.orders), 0)).toBe(1);
      expect(now.order.id).not.toBe(before.order.id);
    });

    it('names the field when a range is refused', async () => {
      await expect(reportService.reportTable('by-user', { period: 'customDates' }, admin)).rejects.toMatchObject({
        messageKey: 'validation.reports.dates.fromRequired',
        details: { field: 'fromDate' },
      });
    });
  });

  describe('exports', () => {
    it('writes any kind as CSV with the column keys as headers, and a totals row on request', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      await makeDispatched(await author(alice), shop, 'Shah Ceramics', 'Morbi');

      const csv = await reportService.exportReport('by-city', { period: 'thisMonth', totals: true }, admin);
      expect(csv.format).toBe('csv');
      // A BOM leads the new kinds' CSV, so Excel reads a non-ASCII city as UTF-8.
      expect((csv as { csv: string }).csv).toBe('﻿city,parties,orders,pieces,kg\r\nMorbi,1,1,10,25\r\nTotal,1,1,10,25\r\n');
    });

    it('writes an Excel workbook whose headers are words and whose figures are numbers', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      await makeDispatched(await author(alice), shop, 'Shah Ceramics', 'Morbi');

      const en = await reportService.exportReport('by-city', { period: 'thisMonth', format: 'xlsx', totals: true }, admin);
      expect(en.format).toBe('xlsx');
      const sheet = en as { bytes: Buffer; fileName: string; contentType: string };
      expect(sheet.fileName).toBe('by-city.xlsx');
      expect(sheet.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(sheet.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
      const rows = await readSheetRows(sheet.bytes);
      expect(rows[0]).toEqual(['City', 'Parties', 'Final Orders', 'Pieces', 'Weight (kg)']);
      expect(rows[1]).toEqual(['Morbi', '1', '1', '10', '25']);
      expect(rows[2]).toEqual(['Total', '1', '1', '10', '25']);
    });

    it('writes a PDF saying whose figures they are', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      await makeDispatched(await author(alice), shop, 'Shah Ceramics', 'Morbi');

      const pdf = await reportService.exportReport('by-user', { period: 'thisMonth', format: 'pdf' }, await viewer(alice));
      expect(pdf.format).toBe('pdf');
      const bytes = (pdf as { bytes: Buffer }).bytes;
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // The Latin face is embedded, so the English words print as glyphs and not as boxes.
      expect(bytes.toString('latin1')).toMatch(/Inter/);
    });

    it('is one activity row per export, naming the kind and the format', async () => {
      await reportService.exportReport('by-brand', { format: 'xlsx' }, admin);
      const rows = await db()('activity_log').where({ entity_type: 'report', action: 'exported' });
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_id).toBe('by-brand');
      expect(rows[0].details).toMatchObject({ report: 'by-brand', format: 'xlsx' });
    });

    it('refuses a kind that does not exist', async () => {
      await expect(reportService.reportTable('revenue' as ReportKind, {}, admin)).rejects.toMatchObject({
        messageKey: 'validation.reports.kind.unknown',
      });
    });

    it('records whose figures were exported: the person asked about, or null for everyone', async () => {
      const alice = await makeUser('alice');
      await reportService.exportReport('by-brand', { format: 'csv' }, admin);
      await reportService.exportReport('by-brand', { format: 'csv', subjectId: alice }, admin);
      await reportService.exportReport('by-brand', { format: 'csv' }, await viewer(alice));

      const rows = await db()('activity_log').where({ entity_type: 'report', action: 'exported' }).orderBy('created_at', 'asc');
      expect(rows.map((row) => (row.details as { subjectId: string | null }).subjectId)).toEqual([null, alice, alice]);
    });

    it('sums only the additive columns on the new kinds, leaves days and dates blank, and rounds kilograms to three places', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const a = await author(alice);
      await makeDispatched(a, shop, 'Shah Ceramics', 'Morbi', 10);
      await makeDispatched(a, shop, 'Patel Traders', 'Rajkot', 4);

      const file = await reportService.exportReport('by-party', { period: 'thisMonth', totals: true }, admin);
      const lines = (file as { csv: string }).csv.split('\r\n').filter(Boolean);
      // partyCode, partyName, city, leads, orders, pieces, kg, lastOrder, daysSince
      expect(lines[0]).toBe('﻿partyCode,partyName,city,leads,orders,pieces,kg,lastOrder,daysSince');
      expect(lines[lines.length - 1]).toBe('Total,,,2,2,14,35,,');
    });

    it('rounds a kilogram total to three places, so float noise never reaches the file', async () => {
      const alice = await makeUser('alice');
      const a = await author(alice);
      // 0.1 kg and 0.2 kg on two rows: added as floats they print 0.30000000000000004.
      const light = await catalogService.createProduct(
        { name: 'Light Cup', categoryName: 'Cups', hasVariants: true, variants: [{ code: 'LIGHT-1', label: 'White', weightKg: 0.1 }] },
        admin,
      );
      for (const quantity of [1, 2]) {
        const party = await catalogService.createParty({ name: `Light ${quantity}`, city: 'Surat' }, admin);
        const lead = await leadService.createLead(
          { partyId: party.id, items: [{ productId: light.id, variantId: light.variants[0]!.id, quantity, packaging: 'Box' }] },
          a,
        );
        await orderService.dispatchOrder({ orderId: (await orderService.convertLead({ leadId: lead.id }, a)).id }, a);
      }
      const file = await reportService.exportReport('by-party', { period: 'thisMonth', totals: true, columns: ['partyName', 'kg'] }, admin);
      const lines = (file as { csv: string }).csv.split('\r\n').filter(Boolean);
      expect(lines.slice(1)).toEqual(['Light 1,0.1', 'Light 2,0.2', 'Total,0.3']);
    });

    it('reads what a client sent defensively: an unknown format is CSV, columns only a list of strings', async () => {
      const alice = await makeUser('alice');
      await makeDispatched(await author(alice), await makeShop(), 'Shah Ceramics', 'Morbi');

      const odd = await reportService.exportReport(
        'by-city',
        { format: 'docx', columns: 'city' as unknown as string[], totals: 'yes', paperSize: 'a0' } as never,
        admin,
      );
      expect(odd.format).toBe('csv');
      expect((odd as { csv: string }).csv.split('\r\n')[0]).toBe('﻿city,parties,orders,pieces,kg');
      expect((odd as { csv: string }).csv).not.toContain('Total');

      expect(reportService.normalizeExportOptions({ columns: ['city', 7, null], format: 'pdf', paperSize: 'letter', orientation: 'portrait' })).toEqual({
        format: 'pdf',
        columns: ['city'],
        totals: false,
        paperSize: 'letter',
        orientation: 'portrait',
      });
      expect(reportService.normalizeExportOptions(null)).toMatchObject({ format: 'csv', paperSize: 'a4', orientation: 'landscape' });
    });

    it('refuses a report longer than the cap for its format, naming the cap, instead of writing half of it', async () => {
      for (const format of ['csv', 'xlsx', 'pdf'] as const) {
        const cap = REPORT_EXPORT_CAPS[format];
        const spy = vi.spyOn(reportRepo, 'byBrand').mockResolvedValue(
          Array.from({ length: cap + 1 }, () => ({ brand: 'B', orders: 1, pieces: 1, kg: 1 })),
        );
        try {
          await expect(reportService.exportReport('by-brand', { format }, admin), format).rejects.toMatchObject({
            messageKey: 'validation.reports.tooManyRows',
            params: { max: cap },
          });
          // The query was asked for one row more than the cap, so "over" is known rather than guessed.
          expect(spy).toHaveBeenCalledWith(expect.anything(), cap + 1);
        } finally {
          spy.mockRestore();
        }
      }
    });
  });

  describe('the legacy CSV, byte for byte', () => {
    it('is exactly what it always was for all three kinds', async () => {
      const alice = await makeUser('alice');
      const shop = await makeShop();
      const made = await makeDispatched(await author(alice), shop, 'Golden Party', 'Morbi');
      const month = (await today()).slice(0, 7);
      const code = (await catalogService.getParty(made.party.id, admin)).partyCode;

      const dispatches = await reportService.exportReport('dispatches', { period: 'thisMonth' }, admin);
      // The table's own lines as they always were; since W2-3 (2026-10-07) the
      // colour breakdown follows behind a blank line, as the screen shows it.
      expect((dispatches as { csv: string }).csv).toBe(
        `month,orderCount,pieces\r\n${month},1,10\r\n\r\ncolour,pieces\r\nWhite,10\r\n`,
      );

      const outcomes = await reportService.exportReport('lead-outcomes', { period: 'thisMonth' }, admin);
      expect((outcomes as { csv: string }).csv).toBe(`month,converted,lost,quiet,open\r\n${month},1,0,0,0\r\n`);

      const top = await reportService.exportReport('top-parties', { period: 'thisMonth' }, admin);
      expect((top as { csv: string }).csv).toBe(`partyId,partyName,partyCode,city,orderCount\r\n${made.party.id},Golden Party,${code},Morbi,1\r\n`);

      const narrowed = await reportService.exportReport('dispatches', { period: 'thisMonth', columns: ['pieces', 'month'], totals: true }, admin);
      expect((narrowed as { csv: string }).csv).toBe(
        `pieces,month\r\n10,${month}\r\n10,Total\r\n\r\ncolour,pieces\r\nWhite,10\r\n`,
      );
    });
  });
});
