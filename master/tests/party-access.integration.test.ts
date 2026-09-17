/**
 * Party Access — per-party visibility and management scoping.
 *
 * The rule under test, stated once: **a party with no grant is open to
 * everyone; a party with grants is reachable only by the people named on it.**
 * Almost every assertion below is one half of that, and the two halves fail in
 * opposite directions — forget the first and the product empties on upgrade
 * day, forget the second and the feature does nothing.
 *
 * The scope is asserted on every read path rather than only on the lists,
 * because a count, a search hit, a report row and a log entry each disclose the
 * same fact by a different route.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { resolvePartyScope } from '../src/domain/party-scope.js';
import { applyPartyScope, partyScopeSql } from '../src/repositories/party-access.repository.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import * as dashboard from '../src/services/dashboard.service.js';
import * as leads from '../src/services/lead.service.js';
import * as logs from '../src/services/log.service.js';
import * as orders from '../src/services/order.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as reports from '../src/services/report.service.js';
import * as roleService from '../src/services/role.service.js';
import * as search from '../src/services/search.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

/**
 * Everything an office desk holds, plus the reads the scope is asserted over.
 * Deliberately **without** `party.accessAll` — that key is the bypass, and a
 * test actor holding it would pass every assertion below for the wrong reason.
 */
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
  'inventory.view',
  'reports.view',
  'logs.view',
  'field.saleRate.view',
];

/** A signed-in desk user. The `userId` is what a grant is written against. */
async function desk(userId: string): Promise<ActorContext> {
  const actor = await actorWith(DESK_KEYS);
  return { ...actor, actorId: userId, userId };
}

async function makePerson(username: string): Promise<string> {
  const role = await roleService.createRole(
    { name: `Desk ${username}`, tier: 'office', permissions: DESK_KEYS },
    admin,
  );
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id },
    admin,
  );
  return user.id;
}

async function seedProduct() {
  return catalog.createProduct({ productCode: 'PA-01', name: 'Glazed Tile', rate: 42_000 }, admin);
}

async function seedLead(partyId: string, productId: string, actor: ActorContext) {
  return leads.createLead(
    {
      partyId,
      items: [
        {
          productId,
          packaging: 'carton',
          quantities: [{ colour: 'Ivory', quantity: 3 }],
        },
      ],
    },
    actor,
  );
}

describe.skipIf(!canRunIntegrationTests)('party access (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  describe('the open-by-default rule', () => {
    it('PA-1: a party nobody is assigned to stays visible to everyone', async () => {
      const party = await catalog.createParty({ name: 'Open Traders' }, admin);
      const anyone = await desk(await makePerson('anyone'));

      const page = await catalog.listParties({}, anyone);
      expect(page.items.map((row) => row.id)).toContain(party.id);
    });

    it('PA-1b: and it can still be worked on — open means open, not read-only', async () => {
      const party = await catalog.createParty({ name: 'Open Traders' }, admin);
      const product = await seedProduct();
      const anyone = await desk(await makePerson('anyone'));

      const lead = await seedLead(party.id, product.id, anyone);
      expect(lead.partyId).toBe(party.id);
    });
  });

  describe('a restricted party', () => {
    it('PA-2: is invisible to somebody it was not assigned to', async () => {
      const party = await catalog.createParty({ name: 'Closed Traders' }, admin);
      const mine = await makePerson('mine');
      const theirs = await makePerson('theirs');

      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: mine, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );

      const outsider = await desk(theirs);
      const page = await catalog.listParties({}, outsider);
      expect(page.items.map((row) => row.id)).not.toContain(party.id);

      const assignee = await desk(mine);
      const theirPage = await catalog.listParties({}, assignee);
      expect(theirPage.items.map((row) => row.id)).toContain(party.id);
    });

    it('PA-2b: takes its leads and orders with it', async () => {
      const party = await catalog.createParty({ name: 'Closed Traders' }, admin);
      const product = await seedProduct();
      const lead = await seedLead(party.id, product.id, admin);
      const order = await orders.convertLead({ leadId: lead.id }, admin);

      const mine = await makePerson('mine');
      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: mine, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );

      const outsider = await desk(await makePerson('theirs'));

      expect((await leads.listLeads({ includeConverted: true }, outsider)).items).toHaveLength(0);
      expect((await orders.listOrders({}, outsider)).items).toHaveLength(0);
      await expect(leads.getLead(lead.id, outsider)).rejects.toThrow(/not found/i);
      await expect(orders.getOrder(order.id, outsider)).rejects.toThrow(/not found/i);
    });
  });

  describe('the two levels', () => {
    it('PA-3: a view assignee reads the party but is refused a lead on it', async () => {
      const party = await catalog.createParty({ name: 'Read Only Traders' }, admin);
      const product = await seedProduct();
      const reader = await makePerson('reader');

      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: reader, level: 'view' }], expectedVersion: party.sync.version },
        admin,
      );

      const actor = await desk(reader);
      expect((await catalog.listParties({}, actor)).items.map((row) => row.id)).toContain(party.id);

      const failure = await seedLead(party.id, product.id, actor).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenError);
      // Names `party.accessAll`, not `leads.create` — the caller *holds*
      // `leads.create`, and sending an administrator to that box would send
      // them to one that is already ticked.
      expect((failure as ForbiddenError).permission).toBe('party.accessAll');
      expect((failure as ForbiddenError).message).toBe(
        'You may view that party but not change its records',
      );
    });

    it('PA-4: a manage assignee can raise a lead and convert it', async () => {
      const party = await catalog.createParty({ name: 'Managed Traders' }, admin);
      const product = await seedProduct();
      const owner = await makePerson('owner');

      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: owner, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );

      const actor = await desk(owner);
      const lead = await seedLead(party.id, product.id, actor);
      const order = await orders.convertLead({ leadId: lead.id }, actor);

      expect(order.partyId).toBe(party.id);
    });

    it('PA-5: somebody else’s party refuses a lead with "not assigned to you"', async () => {
      const party = await catalog.createParty({ name: 'Their Traders' }, admin);
      const product = await seedProduct();

      await partyAccess.replaceAssignments(
        party.id,
        {
          entries: [{ userId: await makePerson('owner'), level: 'manage' }],
          expectedVersion: party.sync.version,
        },
        admin,
      );

      const outsider = await desk(await makePerson('outsider'));
      const failure = await seedLead(party.id, product.id, outsider).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ForbiddenError);
      expect((failure as ForbiddenError).message).toBe('That party is not assigned to you');
    });
  });

  describe('the bypass', () => {
    it('PA-6: a party.accessAll holder sees every party and every assignment', async () => {
      const party = await catalog.createParty({ name: 'Closed Traders' }, admin);
      const owner = await makePerson('owner');

      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: owner, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );

      const supervisor = await actorWith([...DESK_KEYS, 'party.accessAll']);
      expect((await catalog.listParties({}, supervisor)).items.map((row) => row.id)).toContain(
        party.id,
      );

      const rows = await partyAccess.listAssignments({}, supervisor);
      const row = rows.items.find((item) => item.partyId === party.id);
      expect(row?.isRestricted).toBe(true);
      expect(row?.assignees.map((person) => person.userId)).toEqual([owner]);
    });

    it('PA-12: party.assign is above the management tier ceiling', async () => {
      await expect(
        roleService.createRole(
          { name: 'Senior', tier: 'management', permissions: ['party.assign'] },
          admin,
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      // …while `party.accessAll` is not, so a supervisor can be given the whole
      // book without also being given the power to redraw it.
      const role = await roleService.createRole(
        { name: 'Supervisor', tier: 'management', permissions: ['party.accessAll'] },
        admin,
      );
      expect(role.permissions).toContain('party.accessAll');
    });
  });

  describe('every other read path', () => {
    it('PA-7: search returns nothing from a party out of scope', async () => {
      const party = await catalog.createParty({ name: 'Zephyr Ceramics' }, admin);
      await partyAccess.replaceAssignments(
        party.id,
        {
          entries: [{ userId: await makePerson('owner'), level: 'manage' }],
          expectedVersion: party.sync.version,
        },
        admin,
      );

      const outsider = await desk(await makePerson('outsider'));
      const hits = await search.search({ term: 'Zephyr' }, outsider);
      expect(hits).toHaveLength(0);

      const supervisor = await actorWith([...DESK_KEYS, 'party.accessAll']);
      expect(await search.search({ term: 'Zephyr' }, supervisor)).not.toHaveLength(0);
    });

    it('PA-8: dashboard counts and reports are scoped, and complete for a holder', async () => {
      const party = await catalog.createParty({ name: 'Counted Traders' }, admin);
      const product = await seedProduct();
      await seedLead(party.id, product.id, admin);

      await partyAccess.replaceAssignments(
        party.id,
        {
          entries: [{ userId: await makePerson('owner'), level: 'manage' }],
          expectedVersion: party.sync.version,
        },
        admin,
      );

      const outsider = await desk(await makePerson('outsider'));
      const theirs = await dashboard.getDashboardSummary(outsider);
      expect(theirs.leadCount).toBe(0);
      expect(theirs.partyCount).toBe(0);

      const supervisor = await actorWith([...DESK_KEYS, 'party.accessAll']);
      const all = await dashboard.getDashboardSummary(supervisor);
      expect(all.leadCount).toBe(1);
      expect(all.partyCount).toBe(1);

      const outcomes = await reports.leadOutcomeReport({ period: 'last12Months' }, outsider);
      const theirTotal = outcomes.months.reduce(
        (sum, month) => sum + month.converted + month.lost + month.quiet + month.open,
        0,
      );
      expect(theirTotal).toBe(0);
    });

    it('PA-9: the snapshot carries only in-scope parties, records and variants', async () => {
      const mine = await catalog.createParty({ name: 'Mine' }, admin);
      const theirs = await catalog.createParty({ name: 'Theirs' }, admin);
      const product = await seedProduct();
      await seedLead(theirs.id, product.id, admin);

      await catalog.upsertVariant({ partyId: theirs.id, productId: product.id, rate: 1 }, admin);

      const owner = await makePerson('owner');
      await partyAccess.replaceAssignments(
        mine.id,
        { entries: [{ userId: owner, level: 'manage' }], expectedVersion: mine.sync.version },
        admin,
      );
      await partyAccess.replaceAssignments(
        theirs.id,
        {
          entries: [{ userId: await makePerson('other'), level: 'manage' }],
          expectedVersion: theirs.sync.version,
        },
        admin,
      );

      const snapshot = await buildSnapshot(await desk(owner));

      expect(snapshot.parties.map((party) => party.id)).toEqual([mine.id]);
      expect(snapshot.leads).toHaveLength(0);
      // The one a service call would never have covered: `partyVariants` is
      // read straight from its repository by `buildSnapshot`, so it leaks
      // another party's negotiated rate unless scoped explicitly.
      expect(snapshot.partyVariants).toHaveLength(0);
      expect(snapshot.partyGrants).toEqual([{ partyId: mine.id, level: 'manage' }]);
    });

    it('PA-9b: an activity-log entry about an out-of-scope party is hidden', async () => {
      const party = await catalog.createParty({ name: 'Logged Traders' }, admin);
      await partyAccess.replaceAssignments(
        party.id,
        {
          entries: [{ userId: await makePerson('owner'), level: 'manage' }],
          expectedVersion: party.sync.version,
        },
        admin,
      );

      const outsider = await desk(await makePerson('outsider'));
      const page = await logs.listLogs({}, outsider);
      expect(page.items.some((entry) => entry.entityId === party.id)).toBe(false);

      const supervisor = await actorWith([...DESK_KEYS, 'party.accessAll']);
      const all = await logs.listLogs({}, supervisor);
      expect(all.items.some((entry) => entry.entityId === party.id)).toBe(true);
    });

    it('PA-14: an unattended panel sees the unassigned parties and nothing else', async () => {
      const open = await catalog.createParty({ name: 'Open' }, admin);
      const closed = await catalog.createParty({ name: 'Closed' }, admin);

      await partyAccess.replaceAssignments(
        closed.id,
        {
          entries: [{ userId: await makePerson('owner'), level: 'manage' }],
          expectedVersion: closed.sync.version,
        },
        admin,
      );

      // Nobody signed in: the panel acts as itself, with no `userId` at all.
      const panel = await actorWith(DESK_KEYS);
      const page = await catalog.listParties({}, { ...panel, actorType: 'office_panel' });

      expect(page.items.map((party) => party.id)).toEqual([open.id]);
    });
  });

  /**
   * The rule is written twice — once as a query-builder fragment for the
   * repositories that use Knex, once as raw SQL for search, the dashboard, the
   * reports and the recycle bin, which are hand-written SQL. Two spellings of
   * one rule is a standing invitation for them to disagree, and the disagreement
   * would be invisible: each is only ever exercised by its own callers, so a
   * divergence shows up as "search finds a party the list does not" months later.
   */
  describe('the two spellings of the predicate agree', () => {
    it('PA-15: builder and raw SQL return the same parties for the same actor', async () => {
      const open = await catalog.createParty({ name: 'Open' }, admin);
      const mine = await catalog.createParty({ name: 'Mine' }, admin);
      const theirs = await catalog.createParty({ name: 'Theirs' }, admin);
      const viewOnly = await catalog.createParty({ name: 'View only' }, admin);

      const me = await makePerson('me');
      await partyAccess.replaceAssignments(
        mine.id,
        { entries: [{ userId: me, level: 'manage' }], expectedVersion: mine.sync.version },
        admin,
      );
      await partyAccess.replaceAssignments(
        viewOnly.id,
        { entries: [{ userId: me, level: 'view' }], expectedVersion: viewOnly.sync.version },
        admin,
      );
      await partyAccess.replaceAssignments(
        theirs.id,
        {
          entries: [{ userId: await makePerson('other'), level: 'manage' }],
          expectedVersion: theirs.sync.version,
        },
        admin,
      );

      const actor = await desk(me);
      const scope = resolvePartyScope(actor);
      const tenantId = actor.tenantId;

      for (const level of ['view', 'manage'] as const) {
        const builder = db()('parties').whereNull('deleted_at');
        applyPartyScope(builder, tenantId, 'parties.id', scope, { level });
        const viaBuilder = (await builder.select<Array<{ id: string }>>('id')).map((r) => r.id).sort();

        const raw = partyScopeSql('parties.id', tenantId, scope, level);
        const { rows } = await db().raw<{ rows: Array<{ id: string }> }>(
          `SELECT id FROM parties WHERE deleted_at IS NULL${raw.sql}`,
          raw.bindings,
        );
        const viaRaw = rows.map((r) => r.id).sort();

        expect(viaRaw).toEqual(viaBuilder);
      }

      // And the answers are the ones the rule actually promises, so a pair that
      // agreed on the *wrong* set could not pass this test quietly.
      const viewBuilder = db()('parties').whereNull('deleted_at');
      applyPartyScope(viewBuilder, tenantId, 'parties.id', scope, { level: 'view' });
      expect((await viewBuilder.select<Array<{ id: string }>>('id')).map((r) => r.id).sort()).toEqual(
        [open.id, mine.id, viewOnly.id].sort(),
      );

      const manageBuilder = db()('parties').whereNull('deleted_at');
      applyPartyScope(manageBuilder, tenantId, 'parties.id', scope, { level: 'manage' });
      expect((await manageBuilder.select<Array<{ id: string }>>('id')).map((r) => r.id).sort()).toEqual(
        [open.id, mine.id].sort(),
      );
    });
  });

  describe('editing the grant set', () => {
    it('PA-10: replaces the whole set, so a removal takes effect', async () => {
      const party = await catalog.createParty({ name: 'Shifting Traders' }, admin);
      const first = await makePerson('first');
      const second = await makePerson('second');

      const afterFirst = await partyAccess.replaceAssignments(
        party.id,
        {
          entries: [
            { userId: first, level: 'manage' },
            { userId: second, level: 'view' },
          ],
          expectedVersion: party.sync.version,
        },
        admin,
      );
      expect(afterFirst.assignees).toHaveLength(2);

      const afterSecond = await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: second, level: 'manage' }], expectedVersion: afterFirst.version },
        admin,
      );

      expect(afterSecond.assignees.map((person) => person.userId)).toEqual([second]);
      expect(afterSecond.assignees[0]?.level).toBe('manage');

      // The removed person is out immediately, with no re-login.
      expect((await catalog.listParties({}, await desk(first))).items).toHaveLength(0);
    });

    it('PA-10b: refuses a stale expectedVersion rather than overwriting', async () => {
      const party = await catalog.createParty({ name: 'Contested Traders' }, admin);
      const first = await makePerson('first');

      await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: first, level: 'view' }], expectedVersion: party.sync.version },
        admin,
      );

      await expect(
        partyAccess.replaceAssignments(
          party.id,
          // The version the *first* caller read — now stale.
          { entries: [], expectedVersion: party.sync.version },
          admin,
        ),
      ).rejects.toThrow(/saved this first/i);
    });

    it('PA-10c: records one audit entry, atomically with the change', async () => {
      const party = await catalog.createParty({ name: 'Audited Traders' }, admin);

      await partyAccess.replaceAssignments(
        party.id,
        {
          entries: [{ userId: await makePerson('owner'), level: 'view' }],
          expectedVersion: party.sync.version,
        },
        admin,
      );

      const entries = await db()('activity_log')
        .where({ entity_type: 'party', entity_id: party.id, action: 'access_changed' })
        .select<Array<{ action: string }>>('action');

      expect(entries).toHaveLength(1);
    });

    it('PA-10d: refuses a grant naming somebody who is not a live account', async () => {
      const party = await catalog.createParty({ name: 'Ghost Traders' }, admin);

      await expect(
        partyAccess.replaceAssignments(
          party.id,
          { entries: [{ userId: 'US0000009999', level: 'view' }], expectedVersion: party.sync.version },
          admin,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('PA-11: a revoked grant applies on the next call, with no re-login', async () => {
      const party = await catalog.createParty({ name: 'Revoked Traders' }, admin);
      const product = await seedProduct();
      const owner = await makePerson('owner');

      const granted = await partyAccess.replaceAssignments(
        party.id,
        { entries: [{ userId: owner, level: 'manage' }], expectedVersion: party.sync.version },
        admin,
      );

      const actor = await desk(owner);
      await seedLead(party.id, product.id, actor);

      await partyAccess.replaceAssignments(
        party.id,
        { entries: [], expectedVersion: granted.version },
        admin,
      );

      // The same `actor` object — nothing about the caller changed, and the
      // very next call must already reflect the revocation. Note the party is
      // now *unassigned*, so it is open again: the removal restores the
      // open-by-default rule rather than locking everyone out.
      expect((await catalog.listParties({}, actor)).items.map((row) => row.id)).toContain(party.id);
    });

    it('PA-13: only party.assign may write the grant set', async () => {
      const party = await catalog.createParty({ name: 'Guarded Traders' }, admin);
      const desk1 = await desk(await makePerson('desk1'));

      const failure = await partyAccess
        .replaceAssignments(
          party.id,
          {
            entries: [{ userId: await makePerson('other'), level: 'view' }],
            expectedVersion: party.sync.version,
          },
          desk1,
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenError);
      expect((failure as ForbiddenError).permission).toBe('party.assign');
    });

    it('PA-14: the CSV export carries every party, not the first page of them', async () => {
      /*
       * `exportRows` asked for `PAGING.maxLimit` — 200 — exactly once, with no
       * loop, while its own doc comment promised "the whole book". A shop with
       * more than 200 parties got a silently truncated file, and `rowCount`
       * counted the truncated rows, so nothing downstream could notice. An
       * export that is wrong *and says it is complete* is the worst shape
       * available.
       */
      const count = 205;
      for (let i = 0; i < count; i += 1) {
        await catalog.createParty({ name: `Bulk Traders ${String(i).padStart(3, '0')}` }, admin);
      }

      const { csv, rowCount } = await partyAccess.exportRows(admin);

      expect(rowCount).toBeGreaterThanOrEqual(count);
      // Not the page size dressed up as a total.
      expect(rowCount).not.toBe(200);

      // The last party created is the one a single first page would drop.
      expect(csv).toContain(`Bulk Traders ${String(count - 1).padStart(3, '0')}`);
      // Header plus one line per row, and no blank tail.
      expect(csv.trim().split('\n')).toHaveLength(rowCount + 1);
    });

    it('PA-15: the export needs parties.export on every transport, not just the HTTP route', async () => {
      // The Master's own route guards this with `needs('parties.export')`; the
      // socket command an Office panel uses called the service directly and
      // inherited nothing, leaving a whole-company map of who can see which
      // customer one transport away from ungated.
      //
      // `party.accessAll` and no `parties.export`, deliberately: an actor
      // lacking *both* would be refused by `requireCanRead` one line earlier
      // and this test would pass without ever reaching the guard it is about.
      const reader = await actorWith(['parties.view', 'party.accessAll']);

      const failure = await partyAccess.exportRows(reader).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenError);
      expect((failure as ForbiddenError).permission).toBe('parties.export');

      // And the same call succeeds for somebody who holds it, so the assertion
      // above is about the permission rather than about the export being broken.
      const exporter = await actorWith(['parties.view', 'party.accessAll', 'parties.export']);
      await expect(partyAccess.exportRows(exporter)).resolves.toHaveProperty('csv');
    });
  });
});
