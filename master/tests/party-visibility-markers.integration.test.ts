/**
 * What the party lists and the Party Access screen need to say "Private" /
 * "Shared with N" and "Created by …": the grant count on each list row, and
 * the creator on each Party Access row. Both are hints for the reader; the
 * scope itself is asserted in `party-access.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

async function makePerson(username: string, displayName: string): Promise<string> {
  const role = await roleService.createRole(
    { name: `Desk ${username}`, tier: 'office', permissions: ['parties.view'] },
    admin,
  );
  const { user } = await userService.createUser({ username, displayName, roleId: role.id }, admin);
  return user.id;
}

describe.skipIf(!canRunIntegrationTests)('party visibility markers (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('counts the grants on each party in the list: none is open, one is private, more is shared', async () => {
    const open = await catalog.createParty({ name: 'Open Traders' }, admin);
    const alone = await catalog.createParty({ name: 'Private Traders' }, admin);
    const shared = await catalog.createParty({ name: 'Shared Traders' }, admin);
    const meera = await makePerson('meera', 'Meera');
    const imran = await makePerson('imran', 'Imran');

    await partyAccess.replaceAssignments(
      alone.id,
      { entries: [{ userId: meera, level: 'manage' }], expectedVersion: alone.sync.version },
      admin,
    );
    await partyAccess.replaceAssignments(
      shared.id,
      {
        entries: [
          { userId: meera, level: 'manage' },
          { userId: imran, level: 'view' },
        ],
        expectedVersion: shared.sync.version,
      },
      admin,
    );

    const page = await catalog.listPartiesWithMeta({}, admin);
    const counts = new Map(page.items.map((row) => [row.id, row.accessCount]));
    expect(counts.get(open.id)).toBe(0);
    expect(counts.get(alone.id)).toBe(1);
    expect(counts.get(shared.id)).toBe(2);
  });

  it('names the creator on a Party Access row, in the list and for one party, and null when unknown', async () => {
    const party = await catalog.createParty({ name: 'Made By Meera' }, admin);
    const orphan = await catalog.createParty({ name: 'Made By Nobody' }, admin);
    const meera = await makePerson('meera', 'Meera Shah');

    await db()('parties').where({ id: party.id }).update({ created_by_user_id: meera });
    await db()('parties').where({ id: orphan.id }).update({ created_by_user_id: null });

    const page = await partyAccess.listAssignments({}, admin);
    const byId = new Map(page.items.map((row) => [row.partyId, row]));
    expect(byId.get(party.id)).toMatchObject({ createdByUserId: meera, createdByName: 'Meera Shah' });
    expect(byId.get(orphan.id)).toMatchObject({ createdByUserId: null, createdByName: null });

    const single = await partyAccess.assignmentsForParty(party.id, admin);
    expect(single).toMatchObject({ createdByUserId: meera, createdByName: 'Meera Shah' });
  });
});
