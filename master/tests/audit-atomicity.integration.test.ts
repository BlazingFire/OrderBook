/**
 * Every audited write commits with its entry, on the paths that used to write
 * the entry afterwards (docs/ROLES_AND_USERS.md §7).
 *
 * Parties, products, leads, orders and panels recorded their entry
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

import { acceptAuditEntries, refuseAuditEntries } from './helpers/audit-probe.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  createTestProduct,
  resetData,
  setUpFirstRun,
  setupDatabase,
  stageIdByName,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { nextHlc } from '../src/repositories/identity.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as conflicts from '../src/services/conflict.service.js';
import * as fields from '../src/services/fields.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import * as panels from '../src/services/panel.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as sync from '../src/services/sync.service.js';

const PANEL = 'A3F9K2';
const en = createTranslator('en');

let actor: ActorContext;

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
      expect((await db()('leads').where({ id: lead.id }).first())?.converted_order_id).toBeNull();
    });

    it('adding a remark to a lead', async () => {
      const { lead } = await seedLead();
      const before = await countRows('timeline_entries', { parent_id: lead.id });
      await refuseAuditEntries();

      await expect(leads.addRemark({ id: lead.id, message: 'never saved' }, actor)).rejects.toThrow(/audit probe/);
      expect(await countRows('timeline_entries', { parent_id: lead.id })).toBe(before);
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

    it('first-run setup, whose closing entry is the last statement', async () => {
      const users = await countRows('users');
      await refuseAuditEntries('set_up');

      await expect(setUpFirstRun('Shree Ceramics')).rejects.toThrow(/audit probe/);
      expect(await countRows('master_config')).toBe(0);
      expect(await countRows('users')).toBe(users);
    });

    it('opening the pairing window', async () => {
      await refuseAuditEntries();

      await expect(panels.openPairingWindowBy(actor)).rejects.toThrow(/audit probe/);
      expect(panels.isAcceptingPairing()).toBe(false);
    });

    it('closing the pairing window', async () => {
      panels.openPairingWindow();
      await refuseAuditEntries();

      await expect(panels.closePairingWindowBy(actor)).rejects.toThrow(/audit probe/);
      expect(panels.isAcceptingPairing()).toBe(true);
    });

    describe('resolving a sync conflict', () => {
      async function seedConflict() {
        const { lead, product, variant } = await seedLead();
        await leads.updateLead(
          lead.id,
          { items: [{ productId: product.id, variantId: variant.id, quantity: 9, packaging: 'carton' }] },
          actor,
        );
        await sync.applyPush(
          {
            mutations: [
              mergeMutation({
                kind: 'lead.update',
                entity: 'lead',
                entityId: lead.id,
                hlc: hlcFor(-600_000),
                fields: ['items'],
                payload: { items: [{ productId: product.id, variantId: variant.id, quantity: 1, packaging: 'carton' }] },
              }),
            ],
          },
          await testActor({ deviceCode: PANEL, actorType: 'office_panel' }),
        );
        const [conflict] = await conflicts.listConflicts(actor);
        if (!conflict) throw new Error('The stale push raised no conflict');
        return { lead, conflict };
      }

      for (const action of ['keepWinner', 'restoreLoser'] as const) {
        it(action, async () => {
          const { lead, conflict } = await seedConflict();
          await refuseAuditEntries();

          await expect(conflicts.resolveConflict({ conflictId: conflict.id, action }, actor)).rejects.toThrow(
            /audit probe/,
          );
          expect((await db()('sync_conflicts').where({ id: conflict.id }).first())?.resolved_at).toBeNull();
          expect((await leads.getLead(lead.id, actor)).items[0]?.quantity).toBe(9);
        });
      }
    });

    describe('office panels', () => {
      beforeEach(async () => {
        await setUpFirstRun('Shree Ceramics');
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

    it('an order edit and an order stage move', async () => {
      const { order } = await seedOrder();

      await orders.updateOrder(order.id, { notes: 'Deliver after Diwali' }, actor);
      await orders.setStage({ id: order.id, stageId: await stageIdByName('order', 'Postpone') }, actor);

      const trail = await entries({ entity_type: 'order', entity_id: order.id });
      expect(trail.map((entry) => entry.action)).toEqual(['created', 'updated', 'stage_changed']);
      expect(trail.map(rendered)).toEqual([
        'Test Actor created this final order',
        'Test Actor updated this final order',
        'Test Actor moved this final order to Postpone',
      ]);
    });

    it('an offline edit, merged, for each kind of record the merge writes', async () => {
      const { party, product, order } = await seedOrder();
      const panelActor = await testActor({ deviceCode: PANEL, actorType: 'office_panel', actorName: 'Front Desk' });

      // The push gate applies in HLC order, as a panel's outbox stamps it; equal
      // stamps would fall back to the random mutation ids.
      const response = await sync.applyPush(
        {
          mutations: [
            mergeMutation({ hlc: hlcFor(60_000), kind: 'party.update', entity: 'party', entityId: party.id, fields: ['city'], payload: { city: 'Morbi' } }),
            mergeMutation({ hlc: hlcFor(60_001), kind: 'product.update', entity: 'product', entityId: product.id, fields: ['alias'], payload: { alias: 'AB' } }),
            mergeMutation({ hlc: hlcFor(60_002), kind: 'order.update', entity: 'order', entityId: order.id, fields: ['notes'], payload: { notes: 'Call first' } }),
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
        'Front Desk updated this final order',
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

    it('a lead edit whose lines lose changes nothing and records nothing but the conflict', async () => {
      const { lead, product, variant } = await seedLead();
      // The Master's own edit of the lines lands first and stamps `items`.
      await leads.updateLead(
        lead.id,
        { items: [{ productId: product.id, variantId: variant.id, quantity: 9, packaging: 'carton' }] },
        actor,
      );
      const activityBefore = await countRows('activity_log');
      const conflictsBefore = await countRows('sync_conflicts');

      const response = await sync.applyPush(
        {
          mutations: [
            mergeMutation({
              kind: 'lead.update',
              entity: 'lead',
              entityId: lead.id,
              hlc: hlcFor(-600_000),
              fields: ['items'],
              payload: {
                items: [{ productId: product.id, variantId: variant.id, quantity: 1, packaging: 'carton' }],
              },
            }),
          ],
        },
        await testActor({ deviceCode: PANEL, actorType: 'office_panel' }),
      );

      expect(response.results[0]?.conflicts.map((conflict) => conflict.field)).toEqual(['items']);
      expect(await countRows('sync_conflicts')).toBe(conflictsBefore + 1);
      expect((await leads.getLead(lead.id, actor)).items[0]?.quantity).toBe(9);
      expect(await countRows('activity_log')).toBe(activityBefore);
    });

    it('pairing a panel names it', async () => {
      await setUpFirstRun('Shree Ceramics');
      panels.openPairingWindow();
      const paired = await panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);

      // The catalogue reads "paired the office panel {name}", and the entry
      // used to carry only the mode and the hostname.
      const [entry] = await entries({ entity_type: 'office_panel', entity_id: paired.panelId });
      expect(rendered(entry!)).toBe('System paired the office panel Front Desk');
    });
  });

  describe('lock order', () => {
    type Holder = (trx: Parameters<typeof nextHlc>[0]) => Promise<unknown>;

    /**
     * Starts `write` and waits until it is queued behind a row lock. Throws if
     * it finished or never queued: a test that goes on as if it had would pass
     * without having tested anything. Wrapped in an object because an async
     * function returning the promise itself would wait for it.
     */
    async function startQueued<T>(write: () => Promise<T>): Promise<{ pending: Promise<T> }> {
      let settled = false;
      const pending = write().finally(() => {
        settled = true;
      });
      // Swallowed here, surfaced when the caller awaits `pending`.
      pending.catch(() => undefined);

      for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
        const { rows } = await db().raw<{ rows: Array<{ waiting: number }> }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')`,
        );
        if ((rows[0]?.waiting ?? 0) > 0) return { pending };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await pending;
      throw new Error('The write never queued behind the held lock, so the test proved nothing');
    }

    /**
     * Runs `write` while another transaction holds `master_clock`'s lock, then
     * has that transaction take `rowLock` too. Every write stamps the clock
     * before it locks the row it changes; a write that took them the other way
     * round would be holding the row here while it waited for the clock, and
     * the two transactions would deadlock (`40P01`).
     */
    async function whileTheClockIsHeld<T>(write: () => Promise<T>, rowLock: Holder): Promise<T> {
      const trx = await db().transaction();
      try {
        await nextHlc(trx);
        const { pending } = await startQueued(write);

        await trx.raw(`SET LOCAL lock_timeout = '5s'`);
        await rowLock(trx);
        await trx.commit();
        return await pending;
      } catch (error) {
        if (!trx.isCompleted()) await trx.rollback().catch(() => undefined);
        throw error;
      }
    }

    /**
     * Runs `write` while another transaction holds a row it has to lock (`hold`),
     * and once `write` is queued behind that row, has the holder take the audit
     * chain's lock — the per-tenant advisory lock `activity_log`'s trigger takes
     * for every entry. It is free only while `write` has not written its entry.
     *
     * That is the rule `activity-log.repository.ts` states: the entry is the
     * last statement of its transaction, after every row the change locks. A
     * write whose entry came first would be holding the chain lock here while it
     * waited for the row — every other audited write for the company queued
     * behind a transaction that is itself waiting, and a deadlock with any of
     * them that holds the row. The holder's short `lock_timeout` turns that into
     * a failure here rather than a test that waits for the deadlock detector.
     */
    async function whileTheRowIsHeld<T>(write: () => Promise<T>, hold: Holder): Promise<T> {
      const trx = await db().transaction();
      try {
        await hold(trx);
        const { pending } = await startQueued(write);

        await trx.raw(`SET LOCAL lock_timeout = '500ms'`);
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [actor.tenantId]);
        await trx.commit();
        return await pending;
      } catch (error) {
        if (!trx.isCompleted()) await trx.rollback().catch(() => undefined);
        throw error;
      }
    }

    function holdRow(table: string, where: Record<string, unknown>): Holder {
      return (trx) => trx(table).where(where).forUpdate().first();
    }

    it('changing who may reach a party stamps the clock before it locks the party', async () => {
      const party = await catalog.createParty({ name: 'Locked Traders' }, actor);

      const row = await whileTheClockIsHeld(
        () => partyAccess.replaceAssignments(party.id, { entries: [], expectedVersion: party.sync.version }, actor),
        holdRow('parties', { id: party.id }),
      );

      expect(row.partyId).toBe(party.id);
    });

    it('a dispatch stamps the clock before it locks the order', async () => {
      const { order } = await seedOrder();

      const dispatched = await whileTheClockIsHeld(
        () => orders.dispatchOrder({ orderId: order.id }, actor),
        holdRow('orders', { id: order.id }),
      );

      expect(dispatched.dispatchedAt).not.toBeNull();
    });

    // Each arranges a record, then names the write and a row that write has to
    // lock before it can finish — the row it changes, or for a new record the
    // parent its foreign key checks.
    const lastInItsTransaction: Array<[string, () => Promise<{ write: () => Promise<unknown>; hold: Holder }>]> = [
      ['creating a party', async () => ({
        write: () => catalog.createParty({ name: 'Queued Traders' }, actor),
        hold: holdRow('tenants', { id: actor.tenantId }),
      })],
      ['editing a party', async () => {
        const party = await catalog.createParty({ name: 'Before' }, actor);
        return {
          write: () => catalog.updateParty(party.id, { name: 'After' }, actor),
          hold: holdRow('parties', { id: party.id }),
        };
      }],
      ['changing who may reach a party', async () => {
        const party = await catalog.createParty({ name: 'Locked Traders' }, actor);
        return {
          write: () => partyAccess.replaceAssignments(party.id, { entries: [], expectedVersion: party.sync.version }, actor),
          hold: holdRow('parties', { id: party.id }),
        };
      }],
      ['recording a party-wise record of a product', async () => {
        const party = await catalog.createParty({ name: 'Own Names' }, actor);
        const { product } = await createTestProduct(actor, { name: 'Wash Basin' });
        await catalog.upsertVariant({ partyId: party.id, productId: product.id, alias: 'WB-1' }, actor);
        return {
          write: () => catalog.upsertVariant({ partyId: party.id, productId: product.id, alias: 'WB-2' }, actor),
          hold: holdRow('party_product_variants', { party_id: party.id, product_id: product.id }),
        };
      }],
      ['creating a product', async () => ({
        write: () => createTestProduct(actor, { name: 'Queued Basin' }),
        hold: holdRow('tenants', { id: actor.tenantId }),
      })],
      ['editing a product', async () => {
        const { product } = await createTestProduct(actor, { name: 'Before' });
        return {
          write: () => catalog.updateProduct(product.id, { name: 'After' }, actor),
          hold: holdRow('products', { id: product.id }),
        };
      }],
      ['creating a lead', async () => {
        const party = await catalog.createParty({ name: 'Audit Traders' }, actor);
        const { product, variant } = await createTestProduct(actor, { name: 'Audit Basin' });
        return {
          write: () => leads.createLead(
            { partyId: party.id, items: [{ productId: product.id, variantId: variant.id, quantity: 1 }] },
            actor,
          ),
          hold: holdRow('parties', { id: party.id }),
        };
      }],
      ['editing a lead', async () => {
        const { lead } = await seedLead();
        return {
          write: () => leads.updateLead(lead.id, { notes: 'queued' }, actor),
          hold: holdRow('leads', { id: lead.id }),
        };
      }],
      ['moving a lead to another stage', async () => {
        const { lead } = await seedLead();
        const quoted = await stageIdByName('lead', 'Quoted');
        return {
          write: () => leads.setStage({ id: lead.id, stageId: quoted }, actor),
          hold: holdRow('leads', { id: lead.id }),
        };
      }],
      ['converting a lead to an order', async () => {
        const { lead } = await seedLead();
        return {
          write: () => orders.convertLead({ leadId: lead.id }, actor),
          hold: holdRow('leads', { id: lead.id }),
        };
      }],
      ['editing an order', async () => {
        const { order } = await seedOrder();
        return {
          write: () => orders.updateOrder(order.id, { notes: 'queued' }, actor),
          hold: holdRow('orders', { id: order.id }),
        };
      }],
      ['moving an order to another stage', async () => {
        const { order } = await seedOrder();
        const postpone = await stageIdByName('order', 'Postpone');
        return {
          write: () => orders.setStage({ id: order.id, stageId: postpone }, actor),
          hold: holdRow('orders', { id: order.id }),
        };
      }],
      ['dispatching an order', async () => {
        const { order } = await seedOrder();
        return {
          write: () => orders.dispatchOrder({ orderId: order.id }, actor),
          hold: holdRow('orders', { id: order.id }),
        };
      }],
      ['merging an offline edit', async () => {
        const { order } = await seedOrder();
        const panelActor = await testActor({ deviceCode: PANEL, actorType: 'office_panel' });
        return {
          write: () => sync.applyPush(
            {
              mutations: [
                mergeMutation({ kind: 'order.update', entity: 'order', entityId: order.id, fields: ['notes'], payload: { notes: 'queued' } }),
              ],
            },
            panelActor,
          ),
          hold: holdRow('orders', { id: order.id }),
        };
      }],
      ['pairing a panel', async () => {
        await setUpFirstRun('Shree Ceramics');
        panels.openPairingWindow();
        return {
          write: () => panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null),
          hold: holdRow('tenants', { id: actor.tenantId }),
        };
      }],
      ['revoking a panel', async () => {
        await setUpFirstRun('Shree Ceramics');
        panels.openPairingWindow();
        const paired = await panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);
        return {
          write: () => panels.revokePanel(paired.panelId, actor),
          hold: holdRow('office_panels', { id: paired.panelId }),
        };
      }],
      ['editing a panel', async () => {
        await setUpFirstRun('Shree Ceramics');
        panels.openPairingWindow();
        const paired = await panels.pairPanel({ mode: 'auto', panelName: 'Front Desk', hostname: 'pc1' }, null);
        return {
          write: () => panels.updatePanel(paired.panelId, { name: 'Counter PC' }, actor),
          hold: holdRow('office_panels', { id: paired.panelId }),
        };
      }],
    ];

    it.each(lastInItsTransaction)('%s writes its entry after every row it locks', async (_path, arrange) => {
      const { write, hold } = await arrange();
      const before = await countRows('activity_log');

      await whileTheRowIsHeld(write, hold);

      // And the entry was written once the row was free — the write did happen.
      expect(await countRows('activity_log')).toBeGreaterThan(before);
    });

    it('a dispatch moves the order from the stage it is on under the lock, not before', async () => {
      const { order } = await seedOrder();
      const postpone = await stageIdByName('order', 'Postpone');
      const dispatchedStage = await stageIdByName('order', 'Dispatched');
      // With no stage of that name, a dispatch leaves the order on its own stage.
      await fields.updateStage(dispatchedStage, { name: 'Sent' }, actor);

      try {
        // A stage move that commits after the dispatch read the order and before
        // it locked the row. The dispatch used to take its stage from that read,
        // so it wrote the old stage back over the move and named it in the
        // timeline as the stage the order was dispatched from.
        const dispatched = await whileTheRowIsHeld(
          () => orders.dispatchOrder({ orderId: order.id }, actor),
          (trx) => trx('orders').where({ id: order.id }).update({ stage_id: postpone }),
        );

        expect(dispatched.stageId).toBe(postpone);
        const entry = await db()('timeline_entries')
          .where({ parent_id: order.id })
          .whereLike('message', 'Dispatched%')
          .first<{ from_stage_id: string; to_stage_id: string }>('from_stage_id', 'to_stage_id');
        expect(entry).toEqual({ from_stage_id: postpone, to_stage_id: postpone });
      } finally {
        // Named back here, not left to the next `resetData`: the stage snapshot
        // that restores from is taken when a test file starts, on the cluster
        // every file shares, so a rename still standing when this file ends
        // would become the next file's "seeded" name.
        await fields.updateStage(dispatchedStage, { name: 'Dispatched' }, actor);
      }
    });
  });
});
