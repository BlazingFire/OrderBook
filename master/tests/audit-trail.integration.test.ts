/**
 * The audit trail commits with what it records (docs/ROLES_AND_USERS.md §7).
 *
 * Both directions matter and both were broken, because the insert used to go out
 * on the root pool — a different connection from the caller's transaction — and
 * then swallowed its own errors into a warning:
 *
 *   · a failed audit insert left the change committed and unrecorded;
 *   · a change that rolled back left its audit entry behind, describing
 *     something that never happened.
 *
 * A trail with holes cannot answer the question it exists to answer, and the
 * holes appear exactly when something is going wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { allPermissions } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import * as activityLog from '../src/repositories/activity-log.repository.js';
import * as authService from '../src/services/auth.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';

let tenantId: string;
let actor: ActorContext;

const ENTITY_ID = 'RL9999999999';

function entry(tenant: string) {
  return {
    tenantId: tenant,
    entityType: 'role',
    entityId: ENTITY_ID,
    action: 'updated',
    actorType: 'user' as const,
    actorId: null,
    details: { note: 'atomicity probe' },
  };
}

async function auditRowCount(): Promise<number> {
  const rows = await db()('activity_log')
    .where({ entity_id: ENTITY_ID })
    .count<Array<{ count: string }>>('id as count');

  return Number(rows[0]?.count ?? 0);
}

describe.skipIf(!canRunIntegrationTests)('the audit trail', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    tenantId = await testTenantId();
    actor = await testActor();
  });

  it('writes the entry when its transaction commits', async () => {
    await db().transaction(async (trx) => {
      await activityLog.recordActivity(entry(tenantId), actor, trx);
    });

    expect(await auditRowCount()).toBe(1);
  });

  it('takes the entry back when its transaction rolls back', async () => {
    await expect(
      db().transaction(async (trx) => {
        await activityLog.recordActivity(entry(tenantId), actor, trx);
        // Something later in the same unit of work fails — a guard refusing the
        // change, say. The entry describes a change that is about to un-happen.
        throw new Error('forced failure after the audit append');
      }),
    ).rejects.toThrow(/forced failure/);

    expect(await auditRowCount()).toBe(0);
  });

  it('fails the whole change when the entry cannot be written', async () => {
    // `tenant_id` is NOT NULL, so this insert cannot succeed. Previously the
    // repository caught exactly this, logged a warning, and let the caller
    // commit — which is how the trail silently emptied itself when the tenancy
    // migration made the column NOT NULL.
    await expect(
      db().transaction(async (trx) => {
        await trx('roles').where({ tenant_id: tenantId }).update({ name: 'Should Not Persist' });
        await activityLog.recordActivity(
          { ...entry(tenantId), tenantId: null as unknown as string },
          actor,
          trx,
        );
      }),
    ).rejects.toThrow();

    const renamed = await db()('roles').where({ name: 'Should Not Persist' }).first();
    expect(renamed).toBeUndefined();
  });

  describe('sign-in attempts', () => {
    async function signInEntries(): Promise<Array<Record<string, unknown>>> {
      return db()('activity_log')
        .whereIn('action', ['sign_in', 'sign_in_failed'])
        .orderBy('id')
        .select('*');
    }

    it('records a failure against a username that does not exist', async () => {
      await authService.signIn('nobody-at-all', 'guess').catch(() => undefined);

      // The population an auditor most needs. Password spraying and username
      // enumeration produce *only* unknown-username failures, and this used to
      // return early with no tenant to file under — so the trail was silent for
      // the whole attack and spoke up only for the guess that landed.
      const entries = await signInEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: 'sign_in_failed' });
      expect(entries[0]?.details).toMatchObject({
        username: 'nobody-at-all',
        unknownUsername: true,
      });
    });

    it('records an attempt on a deactivated account', async () => {
      const role = await roleService.createRole(
        { name: 'Owner', tier: 'admin', permissions: allPermissions() },
        actor,
      );
      await userService.createUser(
        { username: 'keeper', displayName: 'Keeper', roleId: role.id },
        actor,
      );
      const { user, secret } = await userService.createUser(
        { username: 'imran', displayName: 'Imran Qureshi', roleId: role.id },
        actor,
      );

      await userService.updateUser(
        user.id,
        { isActive: false, expectedVersion: user.sync.version },
        actor,
      );

      await authService.signIn('imran', secret.password).catch(() => undefined);

      // This branch threw before reaching either the trail or the failure
      // counter, so somebody using credentials that should already have stopped
      // working left no trace at all.
      const entries = await signInEntries();
      expect(entries.some((entry) => entry.action === 'sign_in_failed')).toBe(true);
    });

    it('tells a wrong password on a real account apart from an unknown name', async () => {
      const role = await roleService.createRole(
        { name: 'Owner', tier: 'admin', permissions: allPermissions() },
        actor,
      );
      const { user } = await userService.createUser(
        { username: 'meera', displayName: 'Meera Rao', roleId: role.id },
        actor,
      );

      await authService.signIn('meera', 'not-her-password').catch(() => undefined);

      // The whole point of the flag, and it had never once been right: the
      // failure branch passed no user id, so every wrong password against a
      // real account was filed as an unknown username, with a null actor and
      // the typed name as the entity. Password spraying and one person
      // mistyping their own password looked identical in the trail.
      const failure = (await signInEntries()).find((row) => row.action === 'sign_in_failed');
      expect(failure).toMatchObject({ entity_id: user.id, actor_id: user.id });
      expect(failure?.details).toMatchObject({ username: 'meera' });
      expect(failure?.details).not.toHaveProperty('unknownUsername');
    });

    it('names the machine an attempt came from', async () => {
      await authService.signIn('nobody-at-all', 'guess', 'K7M2QX').catch(() => undefined);

      const entries = await signInEntries();
      expect(entries[0]?.details).toMatchObject({ source: 'K7M2QX' });
    });
  });

  describe('the end of a session', () => {
    async function signedIn(): Promise<{ token: string; userId: string }> {
      const role = await roleService.createRole(
        { name: 'Owner', tier: 'admin', permissions: allPermissions() },
        actor,
      );
      const { user } = await userService.createUser(
        { username: 'leela', displayName: 'Leela Shah', roleId: role.id, password: 'correct-horse' },
        actor,
      );
      const { token } = await authService.signIn('leela', 'correct-horse', 'K7M2QX');
      return { token, userId: user.id };
    }

    it('records a sign-out, naming the machine the session began on', async () => {
      const { token, userId } = await signedIn();

      await authService.signOut(token);

      const row = await db()('activity_log').where({ action: 'signed_out' }).first();
      expect(row).toMatchObject({ entity_id: userId, actor_id: userId, actor_name: 'Leela Shah' });
      expect(row.details).toMatchObject({ name: 'Leela Shah', username: 'leela', source: 'K7M2QX' });
    });

    it('records an expiry when the sweep finds the session out of time', async () => {
      const { token, userId } = await signedIn();

      // Only `Date` is faked, so the database driver's own timers run as usual.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
        authService.purgeExpiredSessions();
      } finally {
        vi.useRealTimers();
      }

      expect(await authService.resolveSession(token)).toBeNull();
      await vi.waitFor(async () => {
        const row = await db()('activity_log').where({ action: 'session_expired' }).first();
        expect(row).toMatchObject({ entity_id: userId });
      });
    });
  });

  it('refuses to be edited after the fact', async () => {
    await db().transaction(async (trx) => {
      await activityLog.recordActivity(entry(tenantId), actor, trx);
    });

    // Append-only, enforced by trigger rather than by convention — an audit
    // trail an administrator can quietly rewrite is not evidence of anything.
    await expect(
      db()('activity_log').where({ entity_id: ENTITY_ID }).update({ action: 'something_else' }),
    ).rejects.toThrow();

    await expect(
      db()('activity_log').where({ entity_id: ENTITY_ID }).delete(),
    ).rejects.toThrow();
  });
});
