/**
 * Guard G4, the lockout guard (docs/ROLES_AND_USERS.md §8).
 *
 * The guides call this the most expensive bug this module can ship, and they are
 * right: `setup.service.ts` refuses to re-bootstrap once `master_config` exists,
 * so a company with no working administrator cannot be repaired from inside the
 * product at all. Recovery means somebody with direct database access.
 *
 * The obvious route — deactivating the last administrator — was already guarded.
 * These tests cover the route that was not: editing a *role* until nobody can
 * administer anything, without touching a single user row. Removing `users.manage`
 * from the only admin-tier role leaves every administrator in place and every one
 * of them unable to appoint anyone.
 *
 * The last test is the one that keeps the guard honest. G4 is a rule about what a
 * change may *remove*, not an assertion that an administrator exists — a fresh
 * install before first-run setup has no users at all, and a guard that cannot
 * tell those apart makes the seeded roles uneditable on a brand-new machine.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allPermissions, isServerMasterTier, keysAboveTier } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  createServerMasterUser,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as roleRepo from '../src/repositories/role.repository.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

/** One admin-tier role, held by one active person. The minimum viable company. */
async function soleAdministrator(roleName = 'Owner', username = 'ramesh') {
  const role = await roleService.createRole(
    { name: roleName, tier: 'admin', permissions: allPermissions() },
    admin,
  );

  const { user } = await userService.createUser(
    { username, displayName: 'Ramesh Patel', roleId: role.id },
    admin,
  );

  return { role, user };
}

/** The whole catalogue minus one key, which is how the grid saves an untick. */
function everythingExcept(...removed: string[]): string[] {
  return allPermissions().filter((permission) => !removed.includes(permission));
}

describe.skipIf(!canRunIntegrationTests)('the last-administrator guard', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  describe('by editing the only admin role', () => {
    it('refuses to remove users.manage, which would leave nobody able to appoint anyone', async () => {
      const { role } = await soleAdministrator();

      await expect(
        roleService.updateRole(
          role.id,
          {
            name: role.name,
            tier: 'admin',
            permissions: everythingExcept('users.manage'),
            expectedVersion: role.sync.version,
          },
          admin,
        ),
      ).rejects.toThrow(/manage people/i);
    });

    it('refuses to remove roles.edit, which would leave nobody able to repair a role', async () => {
      const { role } = await soleAdministrator();

      await expect(
        roleService.updateRole(
          role.id,
          {
            name: role.name,
            tier: 'admin',
            permissions: everythingExcept('roles.edit'),
            expectedVersion: role.sync.version,
          },
          admin,
        ),
      ).rejects.toThrow(/edit roles/i);
    });

    it('rolls the edit back rather than leaving it half-applied', async () => {
      const { role } = await soleAdministrator();

      await roleService
        .updateRole(
          role.id,
          {
            name: 'Renamed',
            tier: 'admin',
            permissions: everythingExcept('users.manage'),
            expectedVersion: role.sync.version,
          },
          admin,
        )
        .catch(() => undefined);

      // The guard runs after the write, inside the transaction. If the rollback
      // did not happen, the rename would have survived the refusal.
      const stored = await roleRepo.findRoleById(admin.tenantId, role.id);
      expect(stored?.name).toBe('Owner');
      expect(stored?.permissions).toContain('users.manage');
      expect(stored?.sync.version).toBe(role.sync.version);
    });

    it('refuses to drop the tier off admin', async () => {
      const { role } = await soleAdministrator();

      await expect(
        roleService.updateRole(
          role.id,
          {
            name: role.name,
            // Every admin-only key has to go too, or G2 rejects first and this
            // would pass for the wrong reason.
            tier: 'management',
            permissions: [],
            expectedVersion: role.sync.version,
          },
          admin,
        ),
      ).rejects.toThrow(/administrator must remain/i);
    });

    it('allows the same edit once a second admin role carries the capability', async () => {
      const { role } = await soleAdministrator();
      await soleAdministrator('Second Owner', 'sunita');

      // Now somebody else can appoint people, so this is no longer a lockout —
      // just an ordinary permission change.
      const updated = await roleService.updateRole(
        role.id,
        {
          name: role.name,
          tier: 'admin',
          permissions: everythingExcept('users.manage'),
          expectedVersion: role.sync.version,
        },
        admin,
      );

      expect(updated.permissions).not.toContain('users.manage');
    });

    it('leaves edits to a non-admin role alone', async () => {
      await soleAdministrator();

      const dispatch = await roleService.createRole(
        { name: 'Dispatch', tier: 'office', permissions: ['orders.view'] },
        admin,
      );

      const updated = await roleService.updateRole(
        dispatch.id,
        {
          name: 'Dispatch',
          tier: 'office',
          permissions: [],
          expectedVersion: dispatch.sync.version,
        },
        admin,
      );

      expect(updated.permissions).toEqual([]);
    });
  });

  describe('by removing the only administrator', () => {
    it('refuses to deactivate them', async () => {
      const { user } = await soleAdministrator();

      await expect(
        userService.updateUser(user.id, { isActive: false, expectedVersion: user.sync.version }, admin),
      ).rejects.toThrow(/administrator must remain/i);
    });

    it('refuses to delete them', async () => {
      const { user } = await soleAdministrator();

      await expect(userService.deleteUser(user.id, admin)).rejects.toThrow(
        /administrator must remain/i,
      );
    });

    it('refuses to move them onto a role that cannot administer', async () => {
      const { user } = await soleAdministrator();

      const dispatch = await roleService.createRole(
        { name: 'Dispatch', tier: 'office', permissions: ['orders.view'] },
        admin,
      );

      await expect(
        userService.updateUser(user.id, { roleId: dispatch.id, expectedVersion: user.sync.version }, admin),
      ).rejects.toThrow(/administrator must remain/i);
    });

    it('lets the last admin-tier user go when Server Masters still administer the company', async () => {
      // G4 counts the Server Master tier with admin: two of them are still able
      // to appoint anyone and repair any role, so nobody is locked out.
      await createServerMasterUser('owner-one');
      await createServerMasterUser('owner-two');
      const { user } = await soleAdministrator();

      await expect(
        userService.updateUser(user.id, { isActive: false, expectedVersion: user.sync.version }, admin),
      ).resolves.toMatchObject({ isActive: false });
    });
  });

  describe('the error a refusal actually carries', () => {
    it('names the missing permission as data, not only in the message', async () => {
      const nobody = { ...admin, permissions: { ...admin.permissions!, permissions: [] } };

      // `ForbiddenError.permission` exists so a client need not parse prose. It
      // was reaching the socket path and being dropped by the HTTP one.
      const error = await roleService.listRoles(nobody).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        statusCode: 403,
        code: 'forbidden',
        details: { permission: 'roles.view' },
      });
    });

    it('reports a stale save as a conflict, with the stored version and a field diff', async () => {
      const role = await roleService.createRole(
        { name: 'Sales', tier: 'management', permissions: ['leads.view'] },
        admin,
      );

      const error = await roleService
        .updateRole(
          role.id,
          {
            name: 'Renamed',
            tier: 'management',
            permissions: ['leads.view', 'leads.create'],
            // Somebody else already saved; this caller is a version behind.
            expectedVersion: role.sync.version - 1,
          },
          admin,
        )
        .catch((caught: unknown) => caught);

      // Without the diff, a 409 leaves Cancel as the only exit and the draft is
      // lost — the UI cannot offer Reload versus Overwrite if it cannot say what
      // would change either way.
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'conflict',
        details: {
          storedVersion: role.sync.version,
          diff: { name: { stored: 'Sales', incoming: 'Renamed' } },
        },
      });
    });

    it('reports a duplicate name as a conflict rather than a validation failure', async () => {
      await roleService.createRole({ name: 'Sales', tier: 'management', permissions: [] }, admin);

      // §13 wants CONFLICT here. As a 400 it was indistinguishable from a tier
      // ceiling rejection, so "rename or discard" could not be offered.
      const error = await roleService
        .createRole({ name: 'sales', tier: 'management', permissions: [] }, admin)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ statusCode: 409, code: 'conflict' });
    });

    it('refuses an update that does not say which version it is based on', async () => {
      const role = await roleService.createRole(
        { name: 'Sales', tier: 'management', permissions: [] },
        admin,
      );

      // Optional `expectedVersion` meant any caller could turn the stale-save
      // guard off by omission — and every user mutation in the shipped product
      // did exactly that.
      await expect(
        roleService.updateRole(
          role.id,
          { name: 'Sales', tier: 'management', permissions: ['leads.view'] },
          admin,
        ),
      ).rejects.toThrow(/which version/i);
    });
  });

  describe('the roles this installation shipped with', () => {
    it('holds no permission above its own tier ceiling', async () => {
      const roles = await roleService.listRoles(admin);
      expect(roles.length).toBeGreaterThan(0);

      for (const role of roles) {
        // `20260303` expanded the coarse keys forward — parties.manage became
        // create + edit + delete — without re-checking the ceiling, so the
        // office-tier role came out holding `parties.delete`.
        expect({ role: role.name, above: keysAboveTier(role.permissions, role.tier) }).toEqual({
          role: role.name,
          above: [],
        });
      }
    });

    it('can be opened in the editor and saved back unchanged', async () => {
      // The symptom that made this worth a migration rather than a shrug: the
      // grid renders an above-tier key as checked-but-disabled, so it cannot be
      // unticked, it is resubmitted on save, and G2 then rejects the whole save.
      // Both shipped non-admin roles were uneditable through the product.
      // The Server Master role is the exception on purpose: it is frozen whole.
      const roles = await roleService.listRoles(admin);
      for (const role of roles.filter((r) => !isServerMasterTier(r.tier))) {
        await expect(
          roleService.updateRole(
            role.id,
            {
              name: role.name,
              tier: role.tier,
              permissions: role.permissions,
              expectedVersion: role.sync.version,
            },
            admin,
          ),
        ).resolves.toMatchObject({ id: role.id });
      }
    });

    it('keeps the Server Master role frozen, even saved back unchanged', async () => {
      const serverMaster = (await roleService.listRoles(admin)).find((r) => isServerMasterTier(r.tier));
      expect(serverMaster).toBeDefined();

      await expect(
        roleService.updateRole(
          serverMaster!.id,
          {
            name: serverMaster!.name,
            tier: serverMaster!.tier,
            permissions: serverMaster!.permissions,
            expectedVersion: serverMaster!.sync.version,
          },
          await testActor({
            permissions: { roleId: null, roleName: 'SM', tier: 'server_master', permissions: allPermissions() },
          }),
        ),
      ).rejects.toThrow(/cannot be renamed, edited or deleted/i);
    });
  });

  describe('a company that has no administrator yet', () => {
    it('can still edit its seeded roles', async () => {
      // No users at all — a fresh install between the migrations and first-run
      // setup. G4 has nothing to preserve here, and asserting "an administrator
      // must exist" instead of "this change must not remove one" would make
      // every seeded role uneditable on a brand-new machine.
      const seeded = await roleService.createRole(
        { name: 'Sales', tier: 'management', permissions: ['leads.view'] },
        admin,
      );

      const updated = await roleService.updateRole(
        seeded.id,
        {
          name: 'Sales',
          tier: 'management',
          permissions: ['leads.view', 'leads.create'],
          expectedVersion: seeded.sync.version,
        },
        admin,
      );

      expect(updated.permissions).toContain('leads.create');
    });
  });
});
