/**
 * Every audited write commits with its entry, on the paths that used to write
 * the entry afterwards (docs/ROLES_AND_USERS.md §7).
 *
 * Parties, products, leads, orders, stock and panels recorded their entry
 * through `recordDetachedActivity`, on a second connection, after their own
 * transaction had already committed — and that function swallows a failed
 * insert into a warning. So a change could commit and leave no entry at all,
 * which is the hole `audit-trail.integration.test.ts` pins shut for roles and
 * users. The first block below forces the entry to fail and checks the change
 * failed with it, for every one of those paths and for the writes that used to
 * record nothing.
 *
 * The failure is forced by a trigger on `activity_log`, not by stubbing a
 * function: the property is about the database transaction, and a stub would
 * pass whichever connection the real insert went out on.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mutation } from '@orderbook/shared';
import { createTranslator, initialHlcState, renderActivity, tickHlc } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  createTestProduct,
  resetData,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { nextHlc } from '../src/repositories/identity.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as inventory from '../src/services/inventory.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as panels from '../src/services/panel.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as setup from '../src/services/setup.service.js';
import * as sync from '../src/services/sync.service.js';

const PANEL = 'A3F9K2';
const en = createTranslator('en');

let actor: ActorContext;

/** Every insert into `activity_log` fails from here until `acceptAuditEntries`. */
async function refuseAuditEntries(): Promise<void> {
  await db().raw(`
    CREATE OR REPLACE FUNCTION audit_probe_refuse() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit probe: refused';
    END $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_probe_refuse ON activity_log;
    CREATE TRIGGER audit_probe_refuse BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION audit_probe_refuse();
  `);
}

async function acceptAuditEntries(): Promise<void> {
  await db().raw('DROP TRIGGER IF EXISTS audit_probe_refuse ON activity_log');
}

/** A change to `table` that fails at COMMIT — after everything in its transaction, the entry included, ran. */
async function refuseAtCommit(table: string): Promise<void> {
  await db().raw(`
    CREATE OR REPLACE FUNCTION audit_probe_refuse() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit probe: refused';
    END $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_probe_commit ON ${table};
    CREATE CONSTRAINT TRIGGER audit_probe_commit AFTER INSERT ON ${table}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION audit_probe_refuse();
  `);
}

async function countRows(table: string, where: Record<string, unknown> = {}): Promise<number> {
  const rows = await db()(table).where(where).count<Array<{ count: string }>>('* as count');
  return Number(rows[0]?.count ?? 0);
}

async function entries(where: Record<string, unknown>) {
  return db()('activity_log')
    .where(where)
    .orderBy('id')
    .select<Array<{
      entity_type: string;
      entity_id: string;
      action: string;
      actor_name: string | null;
      details: Record<string, unknown> | null;
    }>>('entity_type', 'entity_id', 'action', 'actor_name', 'details');
}

/** What the Logs screen would print — with no `{placeholder}` left for want of a detail. */
function rendered(entry: Awaited<ReturnType<typeof entries>>[number]): string {
  return renderActivity(en, {
    entityType: entry.entity_type,
    action: entry.action,
    actorName: entry.actor_name,
    details: entry.details,
  });
}

function hlcFor(offsetMs: number): string {
  return tickHlc(initialHlcState(PANEL), Date.now() + offsetMs).hlc;
}

function mergeMutation(overrides: Partial<Mutation> & Pick<Mutation, 'kind' | 'entity' | 'entityId'>): Mutation {
  return {
    mutationId: `m-${Math.random().toString(36).slice(2)}`,
    hlc: hlcFor(60_000),
    deviceCode: PANEL,
    payload: {},
    fields: [],
    baseFieldHlc: {},
    actorUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function seedLead() {
  const party = await catalog.createParty({ name: 'Audit Traders' }, actor);
  const { product, variant } = await createTestProduct(actor, { name: 'Audit Basin', code: 'AUD-1' });
  const lead = await leads.createLead(
    {
      partyId: party.id,
      items: [{ productId: product.id, variantId: variant.id, quantity: 4, packaging: 'carton' }],
    },
    actor,
  );
  return { party, product, variant, lead };
}

async function seedOrder() {
  const seeded = await seedLead();
  const order = await orders.convertLead({ leadId: seeded.lead.id }, actor);
  return { ...seeded, order };
}

describe.skipIf(!canRunIntegrationTests)('audited writes commit with their entry (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(async () => {
    await acceptAuditEntries();
    await db().raw('DROP FUNCTION IF EXISTS audit_probe_refuse() CASCADE');
    await teardownDatabase();
  });

  beforeEach(async () => {
    await acceptAuditEntries();
    await resetData();
    panels.closePairingWindow();
    actor = await testActor();
  });

  afterEach(async () => {
    await acceptAuditEntries();
    await db().raw('DROP TRIGGER IF EXISTS audit_probe_commit ON parties');
    await db().raw('DROP TRIGGER IF EXISTS audit_probe_commit ON stock_movements');
  });

  describe('when the entry cannot be written, the change does not happen', () => {
    it('creating a party', async () => {
      await refuseAuditEntries();
      await expect(catalog.createParty({ name: 'Never Here' }, actor)).rejects.toThrow(/audit probe/);
      expect(await countRows('parties')).toBe(0);
    });

    it('editing a party', async () => {
      const party = await catalog.createParty({ name: 'Before' }, actor);
      await refuseAuditEntries();

      await expect(catalog.updateParty(party.id, { name: 'After' }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('parties').where({ id: party.id }).first())?.name).toBe('Before');
    });

    it('recording a party-wise record of a product', async () => {
      const party = await catalog.createParty({ name: 'Own Names' }, actor);
      const { product } = await createTestProduct(actor, { name: 'Wash Basin' });
      await refuseAuditEntries();

      await expect(
        catalog.upsertVariant({ partyId: party.id, productId: product.id, alias: 'WB-OWN' }, actor),
      ).rejects.toThrow(/audit probe/);
      expect(await countRows('party_product_variants')).toBe(0);
    });

    it('creating a product', async () => {
      await refuseAuditEntries();
      await expect(createTestProduct(actor, { name: 'Never Here' })).rejects.toThrow(/audit probe/);
      expect(await countRows('products')).toBe(0);
    });

    it('editing a product', async () => {
      const { product } = await createTestProduct(actor, { name: 'Before' });
      await refuseAuditEntries();

      await expect(catalog.updateProduct(product.id, { name: 'After' }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('products').where({ id: product.id }).first())?.name).toBe('Before');
    });

    it('creating a lead', async () => {
      const party = await catalog.createParty({ name: 'Audit Traders' }, actor);
      const { product, variant } = await createTestProduct(actor, { name: 'Audit Basin' });
      await refuseAuditEntries();

      await expect(
        leads.createLead(
          { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 1 }] },
          actor,
        ),
      ).rejects.toThrow(/audit probe/);
      expect(await countRows('leads')).toBe(0);
      expect(await countRows('line_items')).toBe(0);
    });

    it('editing a lead', async () => {
      const { lead } = await seedLead();
      await refuseAuditEntries();

      await expect(leads.updateLead(lead.id, { notes: 'never saved' }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('leads').where({ id: lead.id }).first())?.notes).toBeNull();
    });

    it('moving a lead to another stage', async () => {
      const { lead } = await seedLead();
      const quoted = await stageIdByName('lead', 'Quoted');
      await refuseAuditEntries();

      await expect(leads.setStage({ id: lead.id, stageId: quoted }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('leads').where({ id: lead.id }).first())?.stage_id).toBe(lead.stageId);
      expect(await countRows('timeline_entries', { parent_id: lead.id })).toBe(1);
    });

    it('converting a lead to an order', async () => {
      const { lead } = await seedLead();
      await refuseAuditEntries();

      await expect(orders.convertLead({ leadId: lead.id }, actor)).rejects.toThrow(/audit probe/);
      expect(await countRows('orders')).toBe(0);
      expect(await countRows('stock_reservations')).toBe(0);
      expect((await db()('leads').where({ id: lead.id }).first())?.converted_order_id).toBeNull();
    });

    it('editing an order', async () => {
      const { order } = await seedOrder();
      await refuseAuditEntries();

      await expect(orders.updateOrder(order.id, { notes: 'never saved' }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('orders').where({ id: order.id }).first())?.notes).toBeNull();
    });

    it('moving an order to another stage', async () => {
      const { order } = await seedOrder();
      const postpone = await stageIdByName('order', 'Postpone');
      await refuseAuditEntries();

      await expect(orders.setStage({ id: order.id, stageId: postpone }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('orders').where({ id: order.id }).first())?.stage_id).toBe(order.stageId);
    });

    it('dispatching an order', async () => {
      const { order } = await seedOrder();
      await refuseAuditEntries();

      await expect(orders.dispatchOrder({ orderId: order.id }, actor)).rejects.toThrow(/audit probe/);
      expect((await db()('orders').where({ id: order.id }).first())?.dispatched_at).toBeNull();
      expect(await countRows('stock_movements', { movement_type: 'outbound' })).toBe(0);
      expect(await countRows('stock_reservations', { status: 'consumed' })).toBe(0);
    });

    it('recording stock in', async () => {
      const { variant } = await createTestProduct(actor, { name: 'Audit Basin' });
      await refuseAuditEntries();

      await expect(
        inventory.recordInbound({ variantId: variant.id, quantityBoxes: 10 }, actor),
      ).rejects.toThrow(/audit probe/);
      expect(await countRows('stock_movements')).toBe(0);
      expect(await countRows('inventory_stock')).toBe(0);
    });

    it('correcting a count', async () => {
      const { variant } = await createTestProduct(actor, { name: 'Audit Basin' });
      await inventory.recordInbound({ variantId: variant.id, quantityBoxes: 10 }, actor);
      await refuseAuditEntries();

      await expect(
        inventory.recordAdjustment({ variantId: variant.id, quantityBoxes: 7, note: 'recount' }, actor),
      ).rejects.toThrow(/audit probe/);
      expect(Number((await db()('inventory_stock').where({ variant_id: variant.id }).first())?.quantity_boxes)).toBe(10);
      expect(await countRows('stock_movements')).toBe(1);
    });

    it('setting stock levels', async () => {
      const { variant } = await createTestProduct(actor, { name: 'Audit Basin' });
      await refuseAuditEntries();

      await expect(
        inventory.setReorderLevel({ variantId: variant.id, reorderLevel: 5 }, actor),
      ).rejects.toThrow(/audit probe/);
      expect(await countRows('inventory_stock')).toBe(0);
    });

    it('merging an offline edit', async () => {
      const { lead } = await seedLead();
      await refuseAuditEntries();

      const response = await sync.applyPush(
        {
          mutations: [
            mergeMutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              fields: ['notes'],
              payload: { notes: 'typed offline' },
            }),
          ],
        },
        await testActor({ deviceCode: PANEL, actorType: 'office_panel' }),
      );

      expect(response.results[0]?.status).toBe('rejected');
      expect((await db()('leads').where({ id: lead.id }).first())?.notes).toBeNull();
    });

    describe('office panels', () => {
      beforeEach(async () => {
        await setup.runFirstTimeSetup('Shree Ceramics');
      });

      async function pairOne() {
        panels.openPairingWindow();
        return panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);
      }

      it('pairing a panel', async () => {
        panels.openPairingWindow();
        await refuseAuditEntries();

        await expect(
          panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null),
        ).rejects.toThrow(/audit probe/);
        expect(await countRows('office_panels')).toBe(0);
      });

      it('revoking a panel', async () => {
        const paired = await pairOne();
        await refuseAuditEntries();

        await expect(panels.revokePanel(paired.panelId, actor)).rejects.toThrow(/audit probe/);
        expect((await db()('office_panels').where({ id: paired.panelId }).first())?.status).toBe('active');
      });

      it('editing a panel — every field of the form, or none of them', async () => {
        const paired = await pairOne();
        await refuseAuditEntries();

        await expect(
          panels.updatePanel(paired.panelId, { name: 'Counter PC', notes: 'By the printer' }, actor),
        ).rejects.toThrow(/audit probe/);
        const row = await db()('office_panels').where({ id: paired.panelId }).first();
        expect(row?.name).toBe('Front Desk');
        expect(row?.notes).toBeNull();
      });

      it('does not half-apply an edit whose role is refused', async () => {
        const paired = await pairOne();

        // The name comes first on the form and used to be written before the
        // role was even looked at — so a refused role left a renamed panel.
        await expect(
          panels.updatePanel(
            paired.panelId,
            { name: 'Counter PC', roleId: '00000000-0000-4000-8000-000000000000' },
            actor,
          ),
        ).rejects.toThrow(/not found/i);
        expect((await db()('office_panels').where({ id: paired.panelId }).first())?.name).toBe('Front Desk');
      });
    });
  });

  describe('a change that rolls back at commit leaves no entry', () => {
    // The direction the detached writes already got right, by accident of
    // ordering — they only ran once the commit had succeeded. Pinned now that
    // the entry is written inside the transaction, where a commit that fails
    // after it has to take it back.
    it('a party', async () => {
      await refuseAtCommit('parties');

      await expect(catalog.createParty({ name: 'Never Here' }, actor)).rejects.toThrow(/audit probe/);
      expect(await countRows('parties')).toBe(0);
      expect(await countRows('activity_log')).toBe(0);
    });

    it('a stock movement', async () => {
      const { variant } = await createTestProduct(actor, { name: 'Audit Basin' });
      const before = await countRows('activity_log');
      await refuseAtCommit('stock_movements');

      await expect(
        inventory.recordInbound({ variantId: variant.id, quantityBoxes: 10 }, actor),
      ).rejects.toThrow(/audit probe/);
      expect(await countRows('stock_movements')).toBe(0);
      expect(await countRows('activity_log')).toBe(before);
    });
  });

  describe('the writes that used to record nothing', () => {
    it('a party-wise record names the party and the product', async () => {
      const party = await catalog.createParty({ name: 'Own Names' }, actor);
      const { product } = await createTestProduct(actor, { name: 'Wash Basin' });

      await catalog.upsertVariant({ partyId: party.id, productId: product.id, alias: 'WB-OWN' }, actor);

      // Filed under the party, so the Logs screen's party scope hides it from
      // exactly the people who may not see that party.
      const [entry] = await entries({ entity_type: 'party', entity_id: party.id, action: 'variant_saved' });
      expect(entry).toBeDefined();
      expect(rendered(entry!)).toBe('Test Actor saved the party-wise record of Wash Basin for the party Own Names');
    });

    it('stock levels name the product, and a form that asserts nothing records nothing', async () => {
      const { product, variant } = await createTestProduct(actor, { name: 'Audit Basin' });

      await inventory.setReorderLevel({ variantId: variant.id, reorderLevel: 5, maxStockLevel: 40 }, actor);

      const [entry] = await entries({ entity_type: 'stock', entity_id: product.id });
      expect(entry?.action).toBe('levels_changed');
      expect(entry?.details).toMatchObject({ reorderLevel: 5, maxStockLevel: 40, code: variant.code });
      expect(entry?.details).not.toHaveProperty('minStockLevel');
      expect(rendered(entry!)).toBe('Test Actor changed the stock levels for Audit Basin');

      // Nothing asserted is a read in the repository, so it is not an event here.
      await inventory.setReorderLevel({ variantId: variant.id }, actor);
      expect(await entries({ entity_type: 'stock' })).toHaveLength(1);
    });

    it('an order edit and an order stage move', async () => {
      const { order } = await seedOrder();

      await orders.updateOrder(order.id, { notes: 'Deliver after Diwali' }, actor);
      await orders.setStage({ id: order.id, stageId: await stageIdByName('order', 'Postpone') }, actor);

      const trail = await entries({ entity_type: 'order', entity_id: order.id });
      expect(trail.map((entry) => entry.action)).toEqual(['created', 'updated', 'stage_changed']);
      expect(trail.map(rendered)).toEqual([
        'Test Actor created this order',
        'Test Actor updated this order',
        'Test Actor moved this order to Postpone',
      ]);
    });

    it('an offline edit, merged, for each kind of record the merge writes', async () => {
      const { party, product, order } = await seedOrder();
      const panelActor = await testActor({ deviceCode: PANEL, actorType: 'office_panel', actorName: 'Front Desk' });

      const response = await sync.applyPush(
        {
          mutations: [
            mergeMutation({ kind: 'party.update', entity: 'party', entityId: party.id, fields: ['city'], payload: { city: 'Morbi' } }),
            mergeMutation({ kind: 'product.update', entity: 'product', entityId: product.id, fields: ['alias'], payload: { alias: 'AB' } }),
            mergeMutation({ kind: 'order.update', entity: 'order', entityId: order.id, fields: ['notes'], payload: { notes: 'Call first' } }),
          ],
        },
        panelActor,
      );
      expect(response.results.map((result) => result.status)).toEqual(['applied', 'applied', 'applied']);

      const merged = await entries({ actor_name: 'Front Desk' });
      expect(merged.map((entry) => `${entry.entity_type}.${entry.action}`)).toEqual([
        'party.updated',
        'product.updated',
        'order.updated',
      ]);
      expect(merged.map(rendered)).toEqual([
        'Front Desk updated the party Audit Traders',
        'Front Desk updated the product Audit Basin',
        'Front Desk updated this order',
      ]);
      expect(merged[0]?.details).toMatchObject({ fields: ['city'] });
    });

    it('a merge that loses every field changes nothing and records nothing', async () => {
      const { lead } = await seedLead();
      await leads.updateLead(lead.id, { notes: 'Master wrote this' }, actor);
      const before = await countRows('activity_log');

      // Stamped before the Master's edit and naming no base clock: a clash the
      // Master's newer value wins, so nothing is written.
      await sync.applyPush(
        {
          mutations: [
            mergeMutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              hlc: hlcFor(-600_000),
              fields: ['notes'],
              payload: { notes: 'stale offline note' },
            }),
          ],
        },
        await testActor({ deviceCode: PANEL, actorType: 'office_panel' }),
      );

      expect((await db()('leads').where({ id: lead.id }).first())?.notes).toBe('Master wrote this');
      expect(await countRows('activity_log')).toBe(before);
    });

    it('pairing a panel names it', async () => {
      await setup.runFirstTimeSetup('Shree Ceramics');
      panels.openPairingWindow();
      const paired = await panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);

      // The catalogue reads "paired the office panel {name}", and the entry
      // used to carry only the mode and the hostname.
      const [entry] = await entries({ entity_type: 'office_panel', entity_id: paired.panelId });
      expect(rendered(entry!)).toBe('System paired the office panel Front Desk');
    });
  });

  describe('lock order', () => {
    /**
     * Runs `write` while another transaction holds `master_clock`'s lock, then
     * has that transaction take `rowLock` too. Every write stamps the clock
     * before it locks the row it changes; a write that took them the other way
     * round would be holding the row here while it waited for the clock, and
     * the two transactions would deadlock (`40P01`).
     */
    async function whileTheClockIsHeld<T>(
      write: () => Promise<T>,
      rowLock: (trx: Parameters<typeof nextHlc>[0]) => Promise<unknown>,
    ): Promise<T> {
      const trx = await db().transaction();
      try {
        await nextHlc(trx);

        let settled = false;
        const pending = write().finally(() => {
          settled = true;
        });
        // Swallowed here, surfaced by the `await pending` below.
        pending.catch(() => undefined);

        for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
          const { rows } = await db().raw<{ rows: Array<{ waiting: number }> }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          if ((rows[0]?.waiting ?? 0) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        await trx.raw(`SET LOCAL lock_timeout = '5s'`);
        await rowLock(trx);
        await trx.commit();
        return await pending;
      } catch (error) {
        if (!trx.isCompleted()) await trx.rollback().catch(() => undefined);
        throw error;
      }
    }

    it('changing who may reach a party stamps the clock before it locks the party', async () => {
      const party = await catalog.createParty({ name: 'Locked Traders' }, actor);

      const row = await whileTheClockIsHeld(
        () => partyAccess.replaceAssignments(party.id, { entries: [], expectedVersion: party.sync.version }, actor),
        (trx) => trx('parties').where({ id: party.id }).forUpdate().first(),
      );

      expect(row.partyId).toBe(party.id);
    });

    it('a dispatch stamps the clock before it locks the order', async () => {
      const { order } = await seedOrder();

      const dispatched = await whileTheClockIsHeld(
        () => orders.dispatchOrder({ orderId: order.id }, actor),
        (trx) => trx('orders').where({ id: order.id }).forUpdate().first(),
      );

      expect(dispatched.dispatchedAt).not.toBeNull();
    });
  });
});
