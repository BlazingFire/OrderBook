/**
 * Roles & Users (docs/ROLES_AND_USERS.md §15 — the gate list, near-verbatim).
 *
 * Several of these guard failures that are unrecoverable in production rather
 * than merely annoying: deactivating the last administrator locks a company out
 * of its own software, and a permission that survives its own revocation is a
 * security hole that no screenshot would reveal.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allPermissions, minimumTierFor, PERMISSIONS } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import * as roleRepo from '../src/repositories/role.repository.js';
import * as userRepo from '../src/repositories/user.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let admin: ActorContext;

async function officeRole(name = 'Dispatch') {
  return roleService.createRole(
    {
      name,
      tier: 'office',
      permissions: ['orders.view', 'orders.edit', 'inventory.view', 'stock.adjust'],
    },
    admin,
  );
}

async function adminRole(name = 'Second Admin') {
  return roleService.createRole({ name, tier: 'admin', permissions: allPermissions() }, admin);
}

describe.skipIf(!canRunIntegrationTests)('roles & users (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
  });

  describe('the permission catalogue', () => {
    it('offers every key exactly once, with a tier for each', () => {
      const catalogue = roleService.permissionCatalogue();

      const fromGrid = catalogue.modules.flatMap((module) =>
        module.actions.map((action) => `${module.key}.${action}`),
      );
      const fromCapabilities = catalogue.capabilities.map((capability) => capability.key);
      const all = [...fromGrid, ...fromCapabilities];

      expect(new Set(all).size).toBe(all.length);
      expect(new Set(all)).toEqual(new Set(PERMISSIONS));
      for (const key of all) expect(catalogue.minimumTier[key]).toBeDefined();
    });

    it('does not offer an action a module never declares', () => {
      const catalogue = roleService.permissionCatalogue();
      const orders = catalogue.modules.find((module) => module.key === 'orders');

      // An order is only ever created by converting a lead, so there is no such
      // thing as `orders.create` and the grid must not offer a cell for it.
      expect(orders?.actions).not.toContain('create');
      expect(PERMISSIONS).not.toContain('orders.create');
    });
  });

  describe('creating roles', () => {
    it('assigns RL-tagged ids in creation order', async () => {
      const first = await officeRole('Dispatch');
      const second = await officeRole('Packing');

      expect(first.id).toMatch(/^RL\d{10}$/);
      expect(second.id > first.id).toBe(true);
    });

    it('stores the permission set sorted, so a reorder is not an edit', async () => {
      const role = await roleService.createRole(
        { name: 'Shuffled', tier: 'office', permissions: ['orders.view', 'inventory.view'] },
        admin,
      );

      expect(role.permissions).toEqual(['inventory.view', 'orders.view']);
    });

    it('rejects the whole save on an unknown key rather than dropping it', async () => {
      await expect(
        roleService.createRole(
          { name: 'Typo', tier: 'office', permissions: ['orders.view', 'orders.viwe'] },
          admin,
        ),
      ).rejects.toThrow(/Unknown permission/);

      expect(await roleRepo.listRoles(admin.tenantId)).not.toContainEqual(
        expect.objectContaining({ name: 'Typo' }),
      );
    });

    it('refuses a key the tier may not hold', async () => {
      // `users.manage` is admin-only; an office role asking for it is a
      // mistake worth naming, not something to silently strip.
      expect(minimumTierFor('users.manage')).toBe('admin');

      await expect(
        roleService.createRole(
          { name: 'Overreach', tier: 'office', permissions: ['users.manage'] },
          admin,
        ),
      ).rejects.toThrow(/cannot hold/);
    });

    it('refuses a duplicate name, case-insensitively', async () => {
      await officeRole('Dispatch');

      await expect(officeRole('dispatch')).rejects.toThrow(/already exists/);
    });

    it('fields.manage is management+ (Stage 3 lowered it from admin) — office still cannot hold it, management now can', () => {
      expect(minimumTierFor('fields.manage')).toBe('management');
      expect(minimumTierFor('fields.view')).toBe('office');
    });

    it('a management-tier role can now be saved holding fields.manage', async () => {
      const role = await roleService.createRole(
        {
          name: 'Field Curator',
          tier: 'management',
          permissions: ['fields.view', 'fields.manage'],
        },
        admin,
      );
      expect(role.permissions).toContain('fields.manage');
    });

    it('an office-tier role is still refused fields.manage', async () => {
      await expect(
        roleService.createRole(
          { name: 'Overreaching Office', tier: 'office', permissions: ['fields.manage'] },
          admin,
        ),
      ).rejects.toThrow(/cannot hold/);
    });
  });

  describe('editing roles', () => {
    it('records the whole before and after permission arrays, not a diff', async () => {
      const role = await officeRole();

      await roleService.updateRole(
        role.id,
        {
          name: role.name,
          tier: 'office',
          permissions: ['orders.view', 'inventory.view'],
          expectedVersion: role.sync.version,
        },
        admin,
      );

      const entry = await db()('activity_log')
        .where({ entity_type: 'role', entity_id: role.id, action: 'updated' })
        .first();

      // An auditor asks "what could this role do on 14 March"; a chain of diffs
      // makes that a replay instead of a lookup.
      expect(entry?.details.permissions.from).toEqual(role.permissions);
      expect(entry?.details.permissions.to).toEqual(['inventory.view', 'orders.view']);
    });

    it('refuses a stale save rather than silently overwriting the other edit', async () => {
      const role = await officeRole();
      const staleVersion = role.sync.version;

      // Somebody else saves first, moving the version on.
      await roleService.updateRole(
        role.id,
        {
          name: role.name,
          tier: 'office',
          permissions: ['orders.view'],
          expectedVersion: staleVersion,
        },
        admin,
      );

      // The second administrator is still holding the version they loaded.
      await expect(
        roleService.updateRole(
          role.id,
          {
            name: role.name,
            tier: 'office',
            permissions: ['inventory.view'],
            expectedVersion: staleVersion,
          },
          admin,
        ),
      ).rejects.toThrow(/saved this first/i);

      // And the first edit survives untouched — never auto-overwritten.
      const current = await roleService.getRole(role.id, admin);
      expect(current.permissions).toEqual(['orders.view']);
    });

    it('cannot delete or re-tier the seeded Administrator role', async () => {
      const roles = await roleRepo.listRoles(admin.tenantId);
      const administrator = roles.find((role) => role.isSystem);
      expect(administrator).toBeDefined();

      await expect(roleService.deleteRole(administrator!.id, admin)).rejects.toThrow(/system role/);
      await expect(
        roleService.updateRole(
          administrator!.id,
          {
            name: administrator!.name,
            tier: 'office',
            permissions: [],
            expectedVersion: administrator!.sync.version,
          },
          admin,
        ),
      ).rejects.toThrow(/system role/);
    });
  });

  describe('deleting and restoring roles', () => {
    it('refuses to delete a role somebody still holds, then allows it after reassignment', async () => {
      const dispatch = await officeRole();
      const packing = await officeRole('Packing');

      const { user } = await userService.createUser(
        { username: 'imran', displayName: 'Imran Qureshi', roleId: dispatch.id },
        admin,
      );

      await expect(roleService.deleteRole(dispatch.id, admin)).rejects.toThrow(/still assigned/);

      await userService.updateUser(
        user.id,
        { roleId: packing.id, expectedVersion: user.sync.version },
        admin,
      );
      await expect(roleService.deleteRole(dispatch.id, admin)).resolves.toBeDefined();
    });

    it('restores a deleted role and reattaches the users still pointing at it', async () => {
      const dispatch = await officeRole();
      const { user } = await userService.createUser(
        { username: 'imran', displayName: 'Imran Qureshi', roleId: dispatch.id },
        admin,
      );

      // Soft-delete it out from under the user, which only the absence of a SQL
      // foreign key makes possible.
      await db()('roles').where({ id: dispatch.id }).update({ deleted_at: db().fn.now() });
      roleRepo.invalidateRoleCache();

      await roleService.restoreRole(dispatch.id, admin);

      const restored = await userRepo.findById(admin.tenantId, user.id);
      expect(restored?.roleId).toBe(dispatch.id);
      expect(restored?.roleName).toBe('Dispatch');
    });

    it("frees a deleted role's name for reuse", async () => {
      const role = await officeRole('Dispatch');
      await roleService.deleteRole(role.id, admin);

      await expect(officeRole('Dispatch')).resolves.toBeDefined();
    });
  });

  describe('users', () => {
    it('hands back the temporary password exactly once', async () => {
      const { user, secret } = await userService.createUser(
        { username: 'sunita', displayName: 'Sunita Shah', roleId: (await officeRole()).id },
        admin,
      );

      expect(secret.password).toHaveLength(12);
      expect(secret.userId).toBe(user.id);

      // Nothing anywhere can return it again.
      const fetched = await userService.getUser(user.id, admin);
      expect(JSON.stringify(fetched)).not.toContain(secret.password);
    });

    it('never lets a password hash out through a read path', async () => {
      const { user } = await userService.createUser(
        { username: 'sunita', displayName: 'Sunita Shah', roleId: (await officeRole()).id },
        admin,
      );

      const fetched = await userService.getUser(user.id, admin);
      const listed = await userService.listUsers(admin);

      // Absence, not null: `passwordHash === null` passes against a broken
      // implementation that simply blanked the field.
      expect('passwordHash' in fetched).toBe(false);
      expect('password_hash' in (fetched as unknown as Record<string, unknown>)).toBe(false);
      expect(listed.every((entry) => !('passwordHash' in entry))).toBe(true);
    });

    it('never records password material in the audit trail', async () => {
      const { user, secret } = await userService.createUser(
        { username: 'sunita', displayName: 'Sunita Shah', roleId: (await officeRole()).id },
        admin,
      );

      await userService.resetPassword({ userId: user.id }, admin);

      const entries = await db()('activity_log').where({ entity_type: 'user' }).select('details');
      const serialised = JSON.stringify(entries);

      expect(serialised).not.toContain(secret.password);
      expect(serialised).not.toContain('scrypt$');
      expect(serialised).not.toContain('password_hash');
    });

    it('refuses a duplicate username but frees a deleted one', async () => {
      const role = await officeRole();
      const { user } = await userService.createUser(
        { username: 'imran', displayName: 'Imran Q', roleId: role.id },
        admin,
      );

      await expect(
        userService.createUser({ username: 'IMRAN', displayName: 'Other', roleId: role.id }, admin),
      ).rejects.toThrow(/already taken/);

      await userService.deleteUser(user.id, admin);

      // Somebody who left and came back must be re-creatable.
      await expect(
        userService.createUser(
          { username: 'imran', displayName: 'Imran Q', roleId: role.id },
          admin,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('the last administrator', () => {
    async function seedSecondAdmin() {
      const role = await adminRole();
      return userService.createUser(
        { username: 'ramesh', displayName: 'Ramesh Patel', roleId: role.id },
        admin,
      );
    }

    it('cannot be deactivated', async () => {
      const { user } = await seedSecondAdmin();

      await expect(
        userService.updateUser(
          user.id,
          { isActive: false, expectedVersion: user.sync.version },
          admin,
        ),
      ).rejects.toThrow(/at least one active administrator/i);
    });

    it('cannot be deleted', async () => {
      const { user } = await seedSecondAdmin();

      await expect(userService.deleteUser(user.id, admin)).rejects.toThrow(
        /at least one active administrator/i,
      );
    });

    it('cannot be moved off the admin role', async () => {
      const { user } = await seedSecondAdmin();
      const office = await officeRole();

      await expect(
        userService.updateUser(
          user.id,
          { roleId: office.id, expectedVersion: user.sync.version },
          admin,
        ),
      ).rejects.toThrow(/at least one active administrator/i);
    });

    it('allows deactivation once a second administrator exists', async () => {
      const { user: first } = await seedSecondAdmin();
      const role = await adminRole('Third Admin');
      await userService.createUser(
        { username: 'sunita', displayName: 'Sunita Shah', roleId: role.id },
        admin,
      );

      await expect(
        userService.updateUser(
          first.id,
          { isActive: false, expectedVersion: first.sync.version },
          admin,
        ),
      ).resolves.toMatchObject({ isActive: false });
    });

    it('does not let two concurrent deactivations both succeed', async () => {
      const roleA = await adminRole('Admin A');
      const roleB = await adminRole('Admin B');
      const { user: a } = await userService.createUser(
        { username: 'admina', displayName: 'Admin A', roleId: roleA.id },
        admin,
      );
      const { user: b } = await userService.createUser(
        { username: 'adminb', displayName: 'Admin B', roleId: roleB.id },
        admin,
      );

      // Both see one other admin remaining when they start. Only one may win:
      // the count runs inside the transaction, so the second serialises behind
      // the first and then sees zero.
      const results = await Promise.allSettled([
        userService.updateUser(a.id, { isActive: false, expectedVersion: a.sync.version }, admin),
        userService.updateUser(b.id, { isActive: false, expectedVersion: b.sync.version }, admin),
      ]);

      const succeeded = results.filter((result) => result.status === 'fulfilled');
      expect(succeeded).toHaveLength(1);
    });
  });

  describe('sign-in', () => {
    async function seedSignIn() {
      const role = await adminRole('Sign In Admin');
      const { user, secret } = await userService.createUser(
        { username: 'ramesh', displayName: 'Ramesh Patel', roleId: role.id },
        admin,
      );
      return { user, password: secret.password, role };
    }

    it('signs in and resolves the tier-filtered permission set', async () => {
      const { password } = await seedSignIn();

      const { token, user } = await authService.signIn('ramesh', password);

      expect(user.username).toBe('ramesh');
      expect(user.permissions).toContain('users.manage');
      expect(await authService.resolveSession(token)).not.toBeNull();
    });

    it('answers a wrong password and an unknown user identically', async () => {
      await seedSignIn();

      const wrongPassword = await authService
        .signIn('ramesh', 'nope')
        .catch((e: Error) => e.message);
      const unknownUser = await authService.signIn('nobody', 'nope').catch((e: Error) => e.message);

      // Anything else is a username oracle.
      expect(wrongPassword).toBe(unknownUser);
    });

    it('refuses a deactivated account with a distinct, actionable message', async () => {
      const { user, password } = await seedSignIn();
      await adminRole('Spare Admin');
      await userService.createUser(
        { username: 'spare', displayName: 'Spare', roleId: (await adminRole('Spare 2')).id },
        admin,
      );
      await userService.updateUser(
        user.id,
        { isActive: false, expectedVersion: user.sync.version },
        admin,
      );

      await expect(authService.signIn('ramesh', password)).rejects.toThrow(/deactivated/i);
    });

    it('applies a permission change on the very next call, with no re-login', async () => {
      const { password, role } = await seedSignIn();
      const { token } = await authService.signIn('ramesh', password);

      expect(authService.sessionPermissions(token)).toContain('orders.export');

      await roleService.updateRole(
        role.id,
        {
          name: role.name,
          tier: 'admin',
          permissions: allPermissions().filter((key) => key !== 'orders.export'),
          expectedVersion: role.sync.version,
        },
        admin,
      );

      // Resolving is what the next request does; no sign-out, no restart, no TTL.
      await authService.resolveSession(token);
      expect(authService.sessionPermissions(token)).not.toContain('orders.export');
    });

    it('signs out a user whose role was deleted rather than falling back', async () => {
      const { password, role } = await seedSignIn();
      const { token } = await authService.signIn('ramesh', password);

      await db()('roles').where({ id: role.id }).update({ deleted_at: db().fn.now() });
      roleRepo.invalidateRoleCache();

      expect(await authService.resolveSession(token)).toBeNull();
    });

    it('says a deactivation was a revocation, not an expiry', async () => {
      const { user, password } = await seedSignIn();
      await userService.createUser(
        { username: 'spare', displayName: 'Spare', roleId: (await adminRole('Spare 2')).id },
        admin,
      );
      const { token } = await authService.signIn('ramesh', password);

      await userService.updateUser(
        user.id,
        { isActive: false, expectedVersion: user.sync.version },
        admin,
      );

      // This answer leaves the machine. Only `revoked` tells an Office panel to
      // destroy the offline verifier it holds, and the reason was read from the
      // session map *after* the deactivation had emptied it — so it always said
      // `expired`, and a panel kept letting the deactivated person in whenever
      // the network was down.
      const resolution = await authService.resolveSessionDetailed(token);
      expect(resolution).toEqual({ status: 'rejected', reason: 'revoked' });
    });

    it('says a password reset was an expiry, so the panel keeps the person', async () => {
      const { user, password } = await seedSignIn();
      const { token } = await authService.signIn('ramesh', password);

      await userService.resetPassword({ userId: user.id, password: 'a-new-password' }, admin);

      // The person still works here. Their panel's record is stale rather than
      // illegitimate, and `auth:reconcile` retires it by credential fingerprint
      // — telling the panel to destroy it here would take offline sign-in away
      // from somebody who simply changed their password.
      const resolution = await authService.resolveSessionDetailed(token);
      expect(resolution).toEqual({ status: 'rejected', reason: 'expired' });
    });

    it('says an unknown token expired rather than accusing the account', async () => {
      // A Master restart empties the map, so every live token reads as unknown.
      const resolution = await authService.resolveSessionDetailed('never-issued-by-anyone');
      expect(resolution).toEqual({ status: 'rejected', reason: 'expired' });
    });

    it('upgrades a legacy bcrypt hash to scrypt on the next successful sign-in', async () => {
      const { user, password } = await seedSignIn();

      // Put the account back on the old format, as an existing installation is.
      const bcryptHash = (await import('bcryptjs')).default.hashSync(password, 10);
      await db()('users').where({ id: user.id }).update({ password_hash: bcryptHash });

      await authService.signIn('ramesh', password);

      const stored = await db()('users').where({ id: user.id }).first('password_hash');
      expect(String(stored?.password_hash)).toMatch(/^scrypt\$/);

      // And the same password still works against the rewritten hash.
      await expect(authService.signIn('ramesh', password)).resolves.toBeDefined();
    });
  });

  describe('password hashing', () => {
    it('produces a distinct hash per call and verifies both', async () => {
      const first = await hashPassword('correct horse');
      const second = await hashPassword('correct horse');

      expect(first).not.toBe(second);
      expect((await verifyPassword('correct horse', first)).matches).toBe(true);
      expect((await verifyPassword('correct horse', second)).matches).toBe(true);
      expect((await verifyPassword('wrong', first)).matches).toBe(false);
    });

    it('reports a missing hash as a non-match without throwing', async () => {
      await expect(verifyPassword('anything', null)).resolves.toMatchObject({ matches: false });
    });
  });

  describe('the audit trail', () => {
    it('chains each entry to its predecessor', async () => {
      await officeRole('One');
      await officeRole('Two');

      const entries = await db()('activity_log').orderBy('sequence').select('*');
      expect(entries.length).toBeGreaterThan(1);

      for (let index = 1; index < entries.length; index += 1) {
        expect(entries[index].prev_hash).toBe(entries[index - 1].hash);
        expect(entries[index].sequence).toBe(String(Number(entries[index - 1].sequence) + 1));
      }
    });

    it('refuses an update or a delete on an audit row', async () => {
      await officeRole();
      const entry = await db()('activity_log').first('id');

      await expect(
        db()('activity_log').where({ id: entry!.id }).update({ action: 'tampered' }),
      ).rejects.toThrow(/append-only/);

      await expect(db()('activity_log').where({ id: entry!.id }).delete()).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
