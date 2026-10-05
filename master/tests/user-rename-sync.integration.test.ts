/**
 * A user renamed on the Master reaches the Offices.
 *
 * Every lead and order an Office holds carries the owner's name, which the Master reads
 * live. Users are withheld from panels, so a rename used to reach no Office at all until
 * the next full snapshot. It now asks for one, with no payload, and does so only when the
 * name really changed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { allPermissions, effectivePermissions } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

describe.skipIf(!canRunIntegrationTests)('a user rename (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    resetChangeRing();
  });

  async function makeUser() {
    const actor = await testActor();
    const role = await roleService.createRole(
      {
        name: 'Owner',
        tier: 'admin',
        permissions: effectivePermissions(allPermissions(), 'admin'),
      },
      actor,
    );
    const { user } = await userService.createUser(
      { username: 'meera', displayName: 'Meera Rao', roleId: role.id },
      actor,
    );
    return { actor, user };
  }

  it('asks every panel for a fresh snapshot, carrying nothing about the user', async () => {
    const { actor, user } = await makeUser();
    resetChangeRing();

    await userService.updateUser(
      user.id,
      { displayName: 'Meera Rao-Shah', expectedVersion: user.sync.version },
      actor,
    );

    const events = since(0) ?? [];
    expect(events.map((event) => event.entity)).toEqual(['user', 'setting']);
    expect(events[1]).toMatchObject({ action: 'updated', id: 'user.displayName', payload: null });
  });

  it('says nothing extra when the name did not change', async () => {
    const { actor, user } = await makeUser();
    resetChangeRing();

    await userService.updateUser(
      user.id,
      { displayName: 'Meera Rao', isActive: true, expectedVersion: user.sync.version },
      actor,
    );

    expect((since(0) ?? []).map((event) => event.entity)).toEqual(['user']);
  });
});
