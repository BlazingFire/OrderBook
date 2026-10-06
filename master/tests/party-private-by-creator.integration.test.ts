/**
 * A party made by somebody who cannot see every party is theirs alone (party visibility, P2 P4 P5).
 *
 * The owner's scenario: three administrators and five office users. Each office user adds a party; nobody
 * else on the office desk may see it anywhere, and all three administrators see all of them. A party an
 * administrator adds stays open, and parties that already existed are not touched.
 *
 * The matrix is asserted on every read path (lists, one record, leads, orders, search, dashboard, reports,
 * the snapshot an Office is given, the live change feed) because each one discloses the same fact by a
 * different route.
 */

import type { Mutation, Product } from '@orderbook/shared';
import { formatTemporaryId, initialHlcState, tickHlc } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { NotFoundError } from '../src/lib/errors.js';
import { mayReceive } from '../src/realtime/fan-out.js';
import { onChange } from '../src/services/change-bus.js';
import * as catalog from '../src/services/catalog.service.js';
import * as dashboard from '../src/services/dashboard.service.js';
import * as leads from '../src/services/lead.service.js';
import * as orders from '../src/services/order.service.js';
import { importParties } from '../src/services/party-import.service.js';
import * as reports from '../src/services/report.service.js';
import * as roleService from '../src/services/role.service.js';
import * as search from '../src/services/search.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as sync from '../src/services/sync.service.js';
import * as userService from '../src/services/user.service.js';

const DESK_KEYS = [
  'leads.view',
  'leads.create',
  'leads.edit',
  'lead.convert',
  'orders.view',
  'orders.edit',
  'parties.view',
  'parties.create',
  'parties.edit',
  'products.view',
  'reports.view',
  'logs.view',
];

const PANEL = 'A3F9K2';

interface Person {
  userId: string;
  actor: ActorContext;
  partyName: string;
  partyId: string;
}

let setup: ActorContext;
let product: Product;
let admins: ActorContext[] = [];
let desks: Person[] = [];

async function makeUser(username: string, keys: string[], tier: 'office' | 'management' | 'admin'): Promise<string> {
  const role = await roleService.createRole({ name: `Role ${username}`, tier, permissions: keys }, setup);
  const { user } = await userService.createUser({ username, displayName: username, roleId: role.id }, setup);
  return user.id;
}

async function actorFor(userId: string, keys: string[]): Promise<ActorContext> {
  const actor = await actorWith(keys);
  return { ...actor, actorId: userId, userId };
}

async function lineFor(partyId: string, actor: ActorContext) {
  return leads.createLead(
    {
      partyId,
      items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 3, packaging: 'carton' }],
    },
    actor,
  );
}

function hlc(offset: number): string {
  return tickHlc(initialHlcState(PANEL), Date.now() + offset).hlc;
}

describe.skipIf(!canRunIntegrationTests)('a party is private to its creator (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    setup = await testActor();
    product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'PV-01' }], name: 'Glazed Tile' },
      setup,
    );

    // Three administrators: they hold `party.accessAll`.
    admins = [];
    for (const name of ['admin1', 'admin2', 'admin3']) {
      const keys = [...DESK_KEYS, 'party.accessAll'];
      const userId = await makeUser(name, keys, 'admin');
      // The admin tier, as the real role has it: reports answer "everyone" only to an administrator.
      admins.push({ ...(await testActor()), actorId: userId, userId });
    }

    // Five office users, each of whom adds one party and one lead on it.
    desks = [];
    for (const name of ['asha', 'bela', 'chirag', 'dev', 'esha']) {
      const userId = await makeUser(name, DESK_KEYS, 'office');
      const actor = await actorFor(userId, DESK_KEYS);
      const partyName = `Party of ${name}`;
      const party = await catalog.createParty({ name: partyName }, actor);
      await lineFor(party.id, actor);
      desks.push({ userId, actor, partyName, partyId: party.id });
    }
  });

  const others = (person: Person) => desks.filter((other) => other.userId !== person.userId);

  describe('the grant', () => {
    it('writes the creator’s manage row with the party, in the same transaction', async () => {
      for (const person of desks) {
        const rows = await db()('party_access').where({ party_id: person.partyId });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: person.userId, access_level: 'manage', granted_by: person.userId });
      }
    });

    it('leaves a party an administrator makes open to everyone, and writes no row', async () => {
      const open = await catalog.createParty({ name: 'Made by an administrator' }, admins[0]!);
      expect(await db()('party_access').where({ party_id: open.id })).toHaveLength(0);
      for (const person of desks) {
        expect((await catalog.getParty(open.id, person.actor)).name).toBe('Made by an administrator');
      }
    });

    it('does not touch parties that already existed', async () => {
      const before = await db()('party_access').count<Array<{ count: string }>>('id as count');
      expect(Number(before[0]!.count)).toBe(desks.length);
      const names = (await catalog.listParties({}, setup)).items.map((party) => party.name);
      expect(names).toHaveLength(desks.length);
    });

    it('gives no grant to an actor that is not a person (a panel with nobody signed in, the system)', async () => {
      const panel = await actorWith(DESK_KEYS);
      const party = await catalog.createParty({ name: 'Made by a bare panel' }, { ...panel, actorType: 'office_panel', userId: null, actorId: null });
      expect(await db()('party_access').where({ party_id: party.id })).toHaveLength(0);
    });
  });

  describe('what each person sees', () => {
    it('lists only their own party to an office user, and all five to each administrator', async () => {
      for (const person of desks) {
        const page = await catalog.listParties({}, person.actor);
        expect(page.items.map((party) => party.name)).toEqual([person.partyName]);
        expect(page.total).toBe(1);
      }
      for (const admin of admins) {
        const page = await catalog.listParties({}, admin);
        expect(page.items.map((party) => party.name).sort()).toEqual(desks.map((person) => person.partyName).sort());
      }
    });

    it('answers a single party that is somebody else’s with not found, never forbidden', async () => {
      for (const person of desks) {
        for (const other of others(person)) {
          await expect(catalog.getParty(other.partyId, person.actor)).rejects.toBeInstanceOf(NotFoundError);
        }
        expect((await catalog.getParty(person.partyId, person.actor)).name).toBe(person.partyName);
      }
      for (const admin of admins) {
        for (const person of desks) {
          expect((await catalog.getParty(person.partyId, admin)).name).toBe(person.partyName);
        }
      }
    });

    it('scopes leads and orders the same way', async () => {
      for (const person of desks) {
        const own = await leads.listLeads({}, person.actor);
        expect(own.items.map((lead) => lead.partyId)).toEqual([person.partyId]);
        expect(own.total).toBe(1);
      }
      for (const admin of admins) expect((await leads.listLeads({}, admin)).total).toBe(desks.length);

      const first = desks[0]!;
      const lead = (await leads.listLeads({}, first.actor)).items[0]!;
      const order = await orders.convertLead({ leadId: lead.id }, first.actor);
      expect((await orders.listOrders({}, first.actor)).total).toBe(1);
      for (const other of others(first)) {
        expect((await orders.listOrders({}, other.actor)).total).toBe(0);
        await expect(orders.getOrder(order.id, other.actor)).rejects.toBeInstanceOf(NotFoundError);
        await expect(leads.getLead(lead.id, other.actor)).rejects.toBeInstanceOf(NotFoundError);
      }
      for (const admin of admins) expect((await orders.listOrders({}, admin)).total).toBe(1);
    });

    it('keeps another user’s party out of search, and finds it for its creator and the administrators', async () => {
      for (const person of desks) {
        for (const other of others(person)) {
          expect(await search.search({ term: other.partyName }, person.actor)).toHaveLength(0);
        }
        expect(await search.search({ term: person.partyName }, person.actor)).not.toHaveLength(0);
      }
      for (const admin of admins) {
        for (const person of desks) {
          expect(await search.search({ term: person.partyName }, admin)).not.toHaveLength(0);
        }
      }
    });

    it('counts only their own on the dashboard, and everything for an administrator', async () => {
      for (const person of desks) {
        const summary = await dashboard.getDashboardSummary(person.actor);
        expect(summary.partyCount).toBe(1);
        expect(summary.leadCount).toBe(1);
      }
      for (const admin of admins) {
        const summary = await dashboard.getDashboardSummary(admin);
        expect(summary.partyCount).toBe(desks.length);
        expect(summary.leadCount).toBe(desks.length);
      }
    });

    it('reports only their own figures', async () => {
      const total = (outcomes: Awaited<ReturnType<typeof reports.leadOutcomeReport>>) =>
        outcomes.months.reduce((sum, month) => sum + month.converted + month.lost + month.quiet + month.open, 0);
      for (const person of desks) {
        expect(total(await reports.leadOutcomeReport({ period: 'last12Months' }, person.actor))).toBe(1);
      }
      for (const admin of admins) {
        expect(total(await reports.leadOutcomeReport({ period: 'last12Months' }, admin))).toBe(desks.length);
      }
    });

    it('builds an Office snapshot that holds only their own party and its records', async () => {
      for (const person of desks) {
        const snapshot = await buildSnapshot(person.actor);
        expect(snapshot.parties.map((party) => party.name)).toEqual([person.partyName]);
        expect(snapshot.leads.every((lead) => lead.partyId === person.partyId)).toBe(true);
        expect(snapshot.leads).toHaveLength(1);
      }
      for (const admin of admins) {
        expect((await buildSnapshot(admin)).parties).toHaveLength(desks.length);
      }
    });
  });

  describe('every way a party is created', () => {
    it('an Office outbox create (temporary id) gives the grant to the real id', async () => {
      const person = desks[0]!;
      const temporaryId = formatTemporaryId(PANEL, 31);
      const response = await sync.applyPush(
        {
          mutations: [
            {
              mutationId: 'm-party-1',
              kind: 'party.create',
              entity: 'party',
              entityId: temporaryId,
              hlc: hlc(60_000),
              deviceCode: PANEL,
              payload: { name: 'Offline Traders' },
              fields: [],
              baseFieldHlc: {},
              actorUserId: person.userId,
              createdAt: new Date().toISOString(),
            } as Mutation,
          ],
        },
        { ...person.actor, deviceCode: PANEL, actorType: 'office_panel' },
      );
      expect(response.results[0]?.status).toBe('applied');
      const realId = response.results[0]!.entityId as string;
      expect(realId).not.toBe(temporaryId);

      const rows = await db()('party_access').where({ party_id: realId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: person.userId, access_level: 'manage' });

      // The creator keeps it; the others on the desk never get it.
      expect((await catalog.getParty(realId, person.actor)).name).toBe('Offline Traders');
      for (const other of others(person)) {
        await expect(catalog.getParty(realId, other.actor)).rejects.toBeInstanceOf(NotFoundError);
      }
      const mapped = await db()('id_map').where({ temporary_id: temporaryId }).first();
      expect(mapped?.permanent_id).toBe(realId);
    });

    it('a bulk party import gives each created party to the importer alone', async () => {
      const importer = await actorFor(await makeUser('importer', [...DESK_KEYS, 'parties.bulk'], 'management'), [
        ...DESK_KEYS,
        'parties.bulk',
      ]);
      const template = await (await import('../src/services/party-import.service.js')).partyImportTemplate('csv', importer);
      const lines = template.bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
      const headers = lines[0]!.split(',');
      const nameAt = headers.findIndex((header) => /name/i.test(header) && !/alt|contact/i.test(header));
      expect(nameAt).toBeGreaterThanOrEqual(0);
      const row = (name: string) => headers.map((_, at) => (at === nameAt ? name : '')).join(',');
      const csv = [lines[0], row('Imported One'), row('Imported Two')].join('\n');

      const result = await importParties({ buffer: Buffer.from(csv, 'utf8'), fileName: 'parties.csv' }, { dryRun: false, mode: 'create' }, importer);
      expect(result.created).toBe(2);

      const made = await db()('parties').whereIn('name', ['Imported One', 'Imported Two']);
      expect(made).toHaveLength(2);
      for (const party of made) {
        const rows = await db()('party_access').where({ party_id: party.id });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: importer.userId, access_level: 'manage' });
      }
      for (const person of desks) {
        expect((await catalog.listParties({ search: 'Imported' }, person.actor)).total).toBe(0);
      }
      expect((await catalog.listParties({ search: 'Imported' }, admins[0]!)).total).toBe(2);
    });
  });

  describe('the second wall: what an Office may push, and what a hidden party answers', () => {
    const mutationFor = (kind: string, entity: string, entityId: string, payload: Record<string, unknown>, actorUserId: string | null): Mutation =>
      ({
        mutationId: `m-${Math.random().toString(36).slice(2)}`,
        kind,
        entity,
        entityId,
        hlc: hlc(60_000),
        deviceCode: PANEL,
        payload,
        fields: Object.keys(payload),
        baseFieldHlc: {},
        actorUserId,
        createdAt: new Date().toISOString(),
      }) as Mutation;

    /** The panel acting under its own role, which does not see every party, with nobody signed in. */
    const barePanel = async () => ({
      ...(await actorWith(DESK_KEYS)),
      deviceCode: PANEL,
      actorType: 'office_panel' as const,
      userId: null,
      actorId: null,
    });

    it('holds a party-scoped push (retryably, 503) when nobody is signed in, and creates nothing', async () => {
      const panel = await barePanel();
      const push = sync.applyPush(
        { mutations: [mutationFor('party.create', 'party', formatTemporaryId(PANEL, 41), { name: 'Orphan Traders' }, null)] },
        panel,
      );
      await expect(push).rejects.toMatchObject({ statusCode: 503, messageKey: 'error.unavailable.signInToSync' });
      expect(await db()('parties').where({ name: 'Orphan Traders' })).toHaveLength(0);
    });

    it('holds a push whose work was done by somebody other than the person signed in now', async () => {
      const [a, b] = desks;
      const push = sync.applyPush(
        { mutations: [mutationFor('party.create', 'party', formatTemporaryId(PANEL, 42), { name: 'Wrong Hands' }, a!.userId)] },
        { ...b!.actor, deviceCode: PANEL, actorType: 'office_panel' },
      );
      await expect(push).rejects.toMatchObject({ statusCode: 503, code: 'unavailable' });
      expect(await db()('parties').where({ name: 'Wrong Hands' })).toHaveLength(0);
    });

    it('holds A’s queued work pushed under B’s session (a signed-in panel acts as a user, not as the bare panel)', async () => {
      const [a, b] = desks;
      // Exactly the actor a socket gives a panel with B signed in: a user, with the device code.
      const asB = { ...b!.actor, deviceCode: PANEL, actorType: 'user' as const };
      const push = sync.applyPush(
        { mutations: [mutationFor('party.create', 'party', formatTemporaryId(PANEL, 45), { name: 'A made this' }, a!.userId)] },
        asB,
      );
      await expect(push).rejects.toMatchObject({ statusCode: 503, messageKey: 'error.unavailable.signInToSync' });
      expect(await db()('parties').where({ name: 'A made this' })).toHaveLength(0);

      // Work that is B's own goes through.
      const own = await sync.applyPush(
        { mutations: [mutationFor('party.create', 'party', formatTemporaryId(PANEL, 46), { name: 'B made this' }, b!.userId)] },
        asB,
      );
      expect(own.results[0]?.status).toBe('applied');
    });

    it('lets a person without party.accessAll restore an open deleted party from the Recycle Bin, and still hides a hidden one', async () => {
      const open = await catalog.createParty({ name: 'Open and deleted' }, admins[0]!);
      await catalog.deleteParty(open.id, admins[0]!);
      const manager = await actorFor(await makeUser('mgr', [...DESK_KEYS, 'parties.delete', 'recycleBin.view'], 'management'), [
        ...DESK_KEYS,
        'parties.delete',
        'recycleBin.view',
      ]);
      await catalog.restoreParty(open.id, manager, undefined);
      expect((await db()('parties').where({ id: open.id }).first())?.deleted_at).toBeNull();

      // A party that was never there answers like a hidden one.
      await expect(catalog.getParty(desks[0]!.partyId, manager)).rejects.toBeInstanceOf(NotFoundError);
      await expect(catalog.getParty('PT9999999999', manager)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lets the signed-in person push their own work, and other writers keep their behaviour', async () => {
      const a = desks[0]!;
      const response = await sync.applyPush(
        { mutations: [mutationFor('party.create', 'party', formatTemporaryId(PANEL, 43), { name: 'Own Work' }, a.userId)] },
        { ...a.actor, deviceCode: PANEL, actorType: 'office_panel' },
      );
      expect(response.results[0]?.status).toBe('applied');

      // A push that carries no party-scoped work is never held for want of a user.
      const bare = { ...(await barePanel()), ...(await actorWith([...DESK_KEYS, 'products.create'])), deviceCode: PANEL, actorType: 'office_panel' as const, userId: null, actorId: null };
      const product = await sync.applyPush(
        { mutations: [mutationFor('product.create', 'product', formatTemporaryId(PANEL, 44), { name: 'Plain', categoryName: 'Tiles', variants: [{ code: 'PX-1' }] }, null)] },
        bare,
      );
      expect(product.results[0]?.status).toBe('applied');

      // The connector and any other non-panel writer is not a panel push: no grant, as before.
      const connector = { ...(await actorWith(DESK_KEYS)), actorType: 'system' as const, userId: null, actorId: null };
      const open = await catalog.createParty({ name: 'By a connector' }, connector);
      expect(await db()('party_access').where({ party_id: open.id })).toHaveLength(0);
    });

    it('answers a write to a party the caller cannot see exactly as it answers a missing one', async () => {
      const [a, b] = desks;
      const answer = async (partyId: string) => {
        const response = await sync.applyPush(
          { mutations: [mutationFor('party.update', 'party', partyId, { name: 'Renamed' }, b!.userId)] },
          { ...b!.actor, deviceCode: PANEL, actorType: 'office_panel' },
        );
        return response.results[0]!;
      };
      const hidden = await answer(a!.partyId);
      const missing = await answer('PT9999999999');
      expect(hidden.status).toBe('rejected');
      expect(hidden.status).toBe(missing.status);
      expect(JSON.stringify(hidden)).not.toMatch(/assigned/i);
      expect(String((hidden as { message?: string }).message ?? '')).toBe(String((missing as { message?: string }).message ?? ''));
      expect((await db()('parties').where({ id: a!.partyId }).first())?.name).toBe(a!.partyName);
    });

    it('answers a lead raised against a hidden party exactly as against a missing one, on create and on move', async () => {
      const [a, b] = desks;
      const failure = async (run: () => Promise<unknown>) => (await run().catch((error: unknown) => error)) as Error;
      const hidden = await failure(() => lineFor(a!.partyId, b!.actor));
      const missing = await failure(() => lineFor('PT9999999999', b!.actor));
      expect(hidden).toBeInstanceOf(NotFoundError);
      expect(missing).toBeInstanceOf(NotFoundError);
      expect(hidden.message).toBe(missing.message);

      const own = (await leads.listLeads({}, b!.actor)).items[0]!;
      const move = (to: string) => leads.updateLead(own.id, { partyId: to }, b!.actor);
      const hiddenMove = await failure(() => move(a!.partyId));
      const missingMove = await failure(() => move('PT9999999999'));
      expect(hiddenMove.message).toBe(missingMove.message);

      await expect(catalog.upsertVariant({ partyId: a!.partyId, productId: product.id }, b!.actor)).rejects.toBeInstanceOf(NotFoundError);
      await expect(catalog.listVariantsForParty(a!.partyId, b!.actor)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('says "not assigned" only to somebody who can see the party but not change it', async () => {
      const [a, b] = desks;
      await db()('party_access').insert({ tenant_id: a!.actor.tenantId, party_id: a!.partyId, user_id: b!.userId, access_level: 'view', granted_by: a!.userId });
      await expect(lineFor(a!.partyId, b!.actor)).rejects.toMatchObject({ message: 'You may view that party but not change its records' });
    });
  });

  describe('the live change feed', () => {
    it('has the creator’s grant in place before the change is published (a late grant would broadcast the party to every panel)', async () => {
      const person = desks[0]!;
      let seen: { grants: number; event: string } | null = null;
      const stop = onChange((event) => {
        if (event.entity === 'party' && event.action === 'created') {
          void db()('party_access').where({ party_id: event.id }).count<Array<{ count: string }>>('id as count').then((rows) => {
            seen = { grants: Number(rows[0]!.count), event: event.id };
          });
        }
      });
      try {
        await catalog.createParty({ name: 'Published Late?' }, person.actor);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        stop();
      }
      expect(seen).toMatchObject({ grants: 1 });
    });

    it('hands the new party to its creator and the administrators, and to nobody else on the desk', async () => {
      const person = desks[0]!;
      const grants = await db()('party_access').where({ party_id: person.partyId });
      const mapped = grants.map((row) => ({ userId: String(row.user_id), level: row.access_level as 'manage' }));
      const event = { entity: 'party' as const, action: 'created' as const, id: person.partyId, payload: { id: person.partyId } };

      expect(mayReceive(person.actor, event, mapped)).toBe(true);
      for (const admin of admins) expect(mayReceive(admin, event, mapped)).toBe(true);
      for (const other of others(person)) expect(mayReceive(other.actor, event, mapped)).toBe(false);

      // The lead made on it travels the same way.
      const leadEvent = { entity: 'lead' as const, action: 'created' as const, id: 'L1', payload: { partyId: person.partyId } };
      for (const other of others(person)) expect(mayReceive(other.actor, leadEvent, mapped)).toBe(false);
      expect(mayReceive(person.actor, leadEvent, mapped)).toBe(true);
    });
  });
});
