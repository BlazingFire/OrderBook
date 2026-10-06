/**
 * What the snapshot says about who holds each party, for the Office's offline user switch
 * and its Private / Shared markers. `openPartyIds` is every party in the snapshot with no
 * grant row; `partyAccessCounts` has an entry, the number of people holding it, for every
 * restricted one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as catalog from '../src/services/catalog.service.js';
import * as partyAccess from '../src/services/party-access.service.js';
import * as roleService from '../src/services/role.service.js';
import { buildSnapshot } from '../src/services/snapshot.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

describe.skipIf(!canRunIntegrationTests)('the snapshot’s party access facts (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  async function makePerson(username: string): Promise<string> {
    const role = await roleService.createRole(
      { name: `Desk ${username}`, tier: 'office', permissions: ['parties.view'] },
      admin,
    );
    const { user } = await userService.createUser(
      { username, displayName: username, roleId: role.id },
      admin,
    );
    return user.id;
  }

  it('lists the open parties, and counts the people holding each restricted one', async () => {
    const open = await catalog.createParty({ name: 'Open Traders' }, admin);
    const closed = await catalog.createParty({ name: 'Closed Traders' }, admin);
    const shared = await catalog.createParty({ name: 'Shared Traders' }, admin);
    const [one, two] = [await makePerson('one'), await makePerson('two')];

    await partyAccess.replaceAssignments(
      closed.id,
      { entries: [{ userId: one, level: 'manage' }], expectedVersion: closed.sync.version },
      admin,
    );
    await partyAccess.replaceAssignments(
      shared.id,
      {
        entries: [
          { userId: one, level: 'manage' },
          { userId: two, level: 'view' },
        ],
        expectedVersion: shared.sync.version,
      },
      admin,
    );

    // An administrator sees all three, holds no grant on any, and the snapshot still says
    // which two are not open: this is what the Office's offline user switch relies on.
    const snapshot = await buildSnapshot(admin);

    expect(snapshot.parties.map((party) => party.id).sort()).toEqual(
      [open.id, closed.id, shared.id].sort(),
    );
    expect(snapshot.partyGrants).toEqual([]);
    expect(snapshot.openPartyIds).toEqual([open.id]);
    expect(snapshot.partyAccessCounts).toEqual({ [closed.id]: 1, [shared.id]: 2 });
  });
});
