/**
 * The recoverable password vault, end to end.
 *
 * The two assertions that matter most are the negative ones: nothing is stored
 * while the company's switch is off, and a stored password that no longer
 * matches the live hash is reported as stale rather than shown. Everything else
 * here is a feature; those two are the reason the feature is shippable.
 */

import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../src/lib/errors.js';
import { roleIdForTier } from '../src/repositories/user.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as passwordVaultService from '../src/services/password-vault.service.js';
import * as settingsService from '../src/services/settings.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

/** The administrator doing the revealing, and the password they re-type. */
const ADMIN_PASSWORD = 'admin-password-1';
const STAFF_PASSWORD = 'staff-password-1';

let admin: ActorContext;
let adminId: string;
let staffId: string;

async function makeUser(username: string, password: string): Promise<string> {
  const { user } = await userService.createUser(
    {
      username,
      displayName: username,
      roleId: (await roleIdForTier(admin.tenantId, 'admin')) ?? '',
      password,
    },
    admin,
  );
  return user.id;
}

async function vaultCount(): Promise<number> {
  const row = await db()('user_password_vault').count<{ count: string }>({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

/** An actor that is a real signed-in administrator, plus their session token. */
async function signedInAdmin(): Promise<{ actor: ActorContext; token: string }> {
  const session = await authService.signIn('vault-admin', ADMIN_PASSWORD);
  return {
    actor: { ...admin, actorId: adminId, userId: adminId },
    token: session.token,
  };
}

describe.skipIf(!canRunIntegrationTests)('password vault (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    adminId = await makeUser('vault-admin', ADMIN_PASSWORD);
    staffId = await makeUser('vault-staff', STAFF_PASSWORD);
  });

  describe('while the company has not switched it on', () => {
    it('writes nothing, even on a successful sign-in', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      expect(await vaultCount()).toBe(0);
    });

    it('refuses the reveal outright, even for a holder of the key', async () => {
      const { actor, token } = await signedInAdmin();

      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('once it is switched on', () => {
    beforeEach(async () => {
      await settingsService.writeSetting(admin, 'security.passwordRevealEnabled', true);
    });

    it('back-fills an existing account the next time they sign in', async () => {
      expect(await vaultCount()).toBe(0);

      await authService.signIn('vault-staff', STAFF_PASSWORD);
      expect(await vaultCount()).toBe(1);

      const { actor, token } = await signedInAdmin();
      const secret = await passwordVaultService.revealPassword(
        staffId,
        ADMIN_PASSWORD,
        actor,
        token,
      );

      expect(secret).toEqual({
        userId: staffId,
        username: 'vault-staff',
        password: STAFF_PASSWORD,
      });
    });

    it('seals a bcrypt account correctly on its FIRST sign-in, not stale', async () => {
      // The shop's own administrator: hashed with bcrypt by `setup.service.ts`,
      // rewritten to scrypt inside `signIn`'s transaction. Sealing the hash the
      // caller was holding would store a pre-upgrade fingerprint that never
      // matches again.
      await db()('users')
        .where({ id: staffId })
        .update({ password_hash: await bcrypt.hash(STAFF_PASSWORD, 10) });

      await authService.signIn('vault-staff', STAFF_PASSWORD);

      const { actor, token } = await signedInAdmin();
      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).resolves.toMatchObject({ password: STAFF_PASSWORD });
    });

    it('re-seals after an administrative reset', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      await userService.resetPassword({ userId: staffId, password: 'staff-password-2' }, admin);

      const { actor, token } = await signedInAdmin();
      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).resolves.toMatchObject({ password: 'staff-password-2' });
    });

    it('re-seals after somebody changes their own password', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      await authService.changeOwnPassword(
        { currentPassword: STAFF_PASSWORD, newPassword: 'staff-password-3' },
        staffId,
        admin.tenantId,
      );

      const { actor, token } = await signedInAdmin();
      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).resolves.toMatchObject({ password: 'staff-password-3' });
    });

    it('reports stale rather than showing a password that no longer works', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);

      // The hash moves without the vault hearing about it — a replica, a
      // hand-edit, a path this code does not yet know about.
      await db()('users')
        .where({ id: staffId })
        .update({ password_hash: await bcrypt.hash('something-else', 10) });

      const { actor, token } = await signedInAdmin();
      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('reports "not stored" for somebody who has not signed in since', async () => {
      const { actor, token } = await signedInAdmin();

      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses a wrong re-typed password', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      const { actor, token } = await signedInAdmin();

      await expect(
        passwordVaultService.revealPassword(staffId, 'not-my-password', actor, token),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('refuses a caller holding users.manage but not users.viewPassword', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      const { token } = await signedInAdmin();
      const clerk = { ...(await actorWith(['users.manage'])), actorId: adminId, userId: adminId };

      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, clerk, token),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('writes exactly one audit row per reveal, carrying only the username', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      const { actor, token } = await signedInAdmin();

      await passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token);
      // The second one rides the five-minute re-authentication window, so it
      // passes no password — and must still be audited.
      await passwordVaultService.revealPassword(staffId, '', actor, token);

      const rows = await db()('activity_log')
        .where({ tenant_id: admin.tenantId, action: 'password_revealed' })
        .select<Array<{ entity_id: string; details: Record<string, unknown> }>>(
          'entity_id',
          'details',
        );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.entity_id).toBe(staffId);
        expect(row.details).toEqual({ name: 'vault-staff' });
      }
    });

    it('reports coverage as a number, so the offline gap is visible', async () => {
      // Signing in *is* what fills a row, so the administrator asking the
      // question has already filled their own — the gap being reported is
      // everybody who has not been online since the switch went on.
      const { actor } = await signedInAdmin();
      expect(await passwordVaultService.vaultStatus(actor)).toEqual({
        enabled: true,
        stored: 1,
        total: 2,
      });

      await authService.signIn('vault-staff', STAFF_PASSWORD);
      expect(await passwordVaultService.vaultStatus(actor)).toEqual({
        enabled: true,
        stored: 2,
        total: 2,
      });
    });

    it('purges everything when it is switched back off', async () => {
      await authService.signIn('vault-staff', STAFF_PASSWORD);
      expect(await vaultCount()).toBe(1);

      await settingsService.writeSetting(admin, 'security.passwordRevealEnabled', false);
      expect(await vaultCount()).toBe(0);

      const { actor, token } = await signedInAdmin();
      await expect(
        passwordVaultService.revealPassword(staffId, ADMIN_PASSWORD, actor, token),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
