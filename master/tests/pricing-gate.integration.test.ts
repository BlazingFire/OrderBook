/**
 * The company's pricing switch, end to end.
 *
 * Off strips the four `field.*Rate.*` keys from every resolved permission set
 * and the Pricing group from the catalogue the grid renders — so a company
 * without pricing behaves exactly like a role never granted those keys, and
 * an administrator is never offered a cell that would change nothing. On, the
 * role's own grant stands. The fixture seeds the switch **on** for every other
 * suite; this is the one that turns it off.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIELD_PERMISSIONS } from '@orderbook/shared';

import type { ActorContext } from '../src/domain/actor.js';
import { roleIdForTier } from '../src/repositories/user.repository.js';
import { permissionSetForRole } from '../src/services/pricing-gate.js';
import * as roleService from '../src/services/role.service.js';
import * as settingsService from '../src/services/settings.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let admin: ActorContext;

describe.skipIf(!canRunIntegrationTests)('the pricing switch (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  it('leaves the rate keys on a role while pricing is on', async () => {
    const set = await permissionSetForRole(admin.tenantId, await roleIdForTier(admin.tenantId, 'admin'));
    for (const key of FIELD_PERMISSIONS) expect(set?.permissions).toContain(key);
  });

  it('strips the rate keys from every resolved set while pricing is off, and puts them back', async () => {
    const roleId = await roleIdForTier(admin.tenantId, 'admin');

    await settingsService.writeSetting(admin, 'pricing.enabled', false);
    const off = await permissionSetForRole(admin.tenantId, roleId);
    for (const key of FIELD_PERMISSIONS) expect(off?.permissions).not.toContain(key);
    // Only those four: everything else the role holds is untouched.
    expect(off?.permissions).toContain('users.manage');

    await settingsService.writeSetting(admin, 'pricing.enabled', true);
    const on = await permissionSetForRole(admin.tenantId, roleId);
    for (const key of FIELD_PERMISSIONS) expect(on?.permissions).toContain(key);
  });

  it('drops the Pricing group from the catalogue while pricing is off', async () => {
    await settingsService.writeSetting(admin, 'pricing.enabled', false);
    const catalogue = await roleService.permissionCatalogue(admin.tenantId);

    expect(catalogue.groups.map((group) => group.key)).not.toContain('pricing');
    expect(catalogue.capabilities.some((capability) => capability.group === 'pricing')).toBe(false);
    for (const key of FIELD_PERMISSIONS) {
      expect(catalogue.capabilities.map((capability) => capability.key)).not.toContain(key);
    }
  });
});
