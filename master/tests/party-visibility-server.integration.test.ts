/**
 * Party visibility, server side, from D7's audit (2026-10-06): a person who
 * cannot see a restricted party must not read it through sync conflicts, the
 * snapshot, a panel's activity, a merged lead update or a delta replay.
 */

import type { Mutation } from '@orderbook/shared';
import { initialHlcState, tickHlc } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { resolvePartyScope } from '../src/domain/party-scope.js';
import { BOOT_ID, currentSeq } from '../src/realtime/change-ring.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import * as syncRepo from '../src/repositories/sync.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import { publishChange } from '../src/services/change-bus.js';
import * as conflicts from '../src/services/conflict.service.js';
import { buildDelta } from '../src/services/delta.service.js';
import * as leads from '../src/services/lead.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as sync from '../src/services/sync.service.js';
import * as userService from '../src/services/user.service.js';

const PANEL = 'A3F9K2';

let admin: ActorContext;

const KEYS = [
  'leads.view', 'leads.create', 'leads.edit', 'orders.view',
  'parties.view', 'parties.create', 'parties.edit', 'products.view', 'logs.view',
];

async function person(username: string, extra: string[] = []): Promise<ActorContext> {
  const permissions = [...KEYS, ...extra];
  // sync.resolveConflicts is an admin-tier key; party.accessAll is not among the extras.
  const tier = extra.length > 0 ? 'admin' : 'office';
  const role = await roleService.createRole({ name: `Desk ${username}`, tier, permissions }, admin);
  const { user } = await userService.createUser(
    { username, displayName: username, roleId: role.id },
    admin,
  );
  const actor = await actorWith(permissions);
  return { ...actor, actorId: user.id, userId: user.id };
}

/** A party only `owner` may see. */
async function restrictedParty(name: string, owner: ActorContext) {
  const party = await catalog.createParty({ name }, admin);
  await partyAccess.replaceAssignments(
    party.id,
    { entries: [{ userId: owner.userId as string, level: 'manage' }], expectedVersion: party.sync.version },
    admin,
  );
  return party;
}

async function conflictOn(entity: string, entityId: string) {
  await db().transaction((trx) =>
    syncRepo.recordConflicts(
      [
        {
          tenantId: admin.tenantId,
          entity,
          entityId,
          field: 'name',
          losingValue: 'Secret Old Name',
          losingHlc: '1',
          losingDeviceCode: PANEL,
          winningValue: 'Secret New Name',
          winningHlc: '2',
          winningDeviceCode: PANEL,
        },
      ],
      trx,
    ),
  );
}

describe.skipIf(!canRunIntegrationTests)('party visibility, server (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('PV-F3: a party conflict is listed, counted and snapshotted only for those who can see the party', async () => {
    const a = await person('a-user', ['sync.resolveConflicts']);
    const b = await person('b-user', ['sync.resolveConflicts']);
    const party = await restrictedParty('Secret Traders', a);
    await conflictOn('party', party.id);

    expect((await conflicts.listConflicts(a)).map((c) => c.entityId)).toEqual([party.id]);
    expect(await conflicts.listConflicts(b)).toEqual([]);
    expect(await conflicts.countOpen(admin.tenantId, resolvePartyScope(a))).toBe(1);
    expect(await conflicts.countOpen(admin.tenantId, resolvePartyScope(b))).toBe(0);

    expect((await buildSnapshot(a)).conflicts).toHaveLength(1);
    expect((await buildSnapshot(b)).conflicts).toEqual([]);
  });

  it('PV-F3: a snapshot carries no conflicts for someone without sync.resolveConflicts, even on an open party', async () => {
    const reader = await person('reader');
    const party = await catalog.createParty({ name: 'Open Traders' }, admin);
    await conflictOn('party', party.id);

    expect((await buildSnapshot(reader)).conflicts).toEqual([]);
    expect((await buildSnapshot({ ...admin })).conflicts).toHaveLength(1);
  });

  it('PV-F5: a panel\'s activity leaves out parties the caller cannot see', async () => {
    const a = await person('a-user');
    const b = await person('b-user');
    const party = await restrictedParty('Secret Traders', a);
    const panelId = 'panel-under-test';
    await db().transaction((trx) =>
      activityLog.recordActivity(
      {
        tenantId: admin.tenantId,
        entityType: 'party',
        entityId: party.id,
        action: 'created',
        actorType: 'office_panel',
        actorId: panelId,
        details: { name: 'Secret Traders' },
      },
      admin,
      trx,
    ),
    );

    const seenByA = await activityLog.listPanelActivity(admin.tenantId, panelId, 50, resolvePartyScope(a));
    const seenByB = await activityLog.listPanelActivity(admin.tenantId, panelId, 50, resolvePartyScope(b));

    expect(seenByA.map((entry) => entry.entityId)).toContain(party.id);
    expect(seenByB.map((entry) => entry.entityId)).not.toContain(party.id);
  });

  it('PV-F6: a merged lead update naming a party the caller cannot manage is refused before its lines are read', async () => {
    const a = await person('a-user');
    const b = await person('b-user');
    const product = await catalog.createProduct(
      { categoryName: 'Tiles', variants: [{ code: 'PV-01' }], name: 'Glazed Secret Tile' },
      admin,
    );
    const open = await catalog.createParty({ name: 'Open Traders' }, admin);
    const secret = await restrictedParty('Secret Traders', a);
    const lead = await leads.createLead(
      {
        partyId: open.id,
        items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 2, packaging: 'Box' }],
      },
      b,
    );

    const hlc = tickHlc(initialHlcState(PANEL), Date.now() + 1000).hlc;
    const mutation: Mutation = {
      mutationId: 'm-f6',
      kind: 'lead.update',
      entity: 'lead',
      entityId: lead.id,
      hlc,
      deviceCode: PANEL,
      payload: {
        partyId: secret.id,
        partyWiseMode: true,
        items: [{ productId: product.id, variantId: product.variants[0]!.id, quantity: 0 }],
      },
      fields: ['partyId', 'items', 'partyWiseMode'],
      baseFieldHlc: {},
      actorUserId: b.userId,
      createdAt: new Date().toISOString(),
    };

    const response = await sync.applyPush(
      { mutations: [mutation] },
      { ...b, deviceCode: PANEL, actorType: 'office_panel' },
    );

    const result = response.results[0];
    expect(result?.status).toBe('rejected');
    expect(JSON.stringify(result)).not.toContain('Glazed Secret Tile');
  });

  it('PV-F7: a delta replay fails closed on a party-scoped change that names no party', async () => {
    const reader = await person('reader');
    const cursor = { bootId: BOOT_ID, lastSeq: currentSeq() };

    publishChange({ entity: 'lead', action: 'updated', id: 'LD0000000001', payload: null });
    expect(await buildDelta(cursor, reader)).toBeNull();
  });

  it('PV-F7: the same replay is a delta when the change names its party', async () => {
    const reader = await person('reader');
    const party = await catalog.createParty({ name: 'Open Traders' }, admin);
    const cursor = { bootId: BOOT_ID, lastSeq: currentSeq() };

    publishChange({ entity: 'lead', action: 'updated', id: 'LD0000000001', payload: { partyId: party.id } });
    const delta = await buildDelta(cursor, reader);

    expect(delta).not.toBeNull();
    expect(delta?.events).toHaveLength(1);
  });
});
