/**
 * Developer mode on the Master (`shared/src/domain/developer.ts` says why it
 * exists and why a password rather than a permission guards it).
 *
 * Three things live here. The **gate** — password check, lockout, and the
 * short-lived tokens the routes hand out — is built by `developer-gate.ts`;
 * this module exports one live instance for the routes. **`resetAllData`**
 * takes the installation back to first run. **`seedDummyUsers`** creates the
 * documented throwaway accounts.
 *
 * Nothing here is reachable without a signed-in session *and* a developer
 * token: the routes enforce the first, the gate the second.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DUMMY_SERVER_MASTERS,
  DUMMY_USERS,
  type DeveloperUnlock,
  type DummyUserCredential,
  type ResetAllResult,
  type SeedDummyUsersResult,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db, runMigrations } from '../db/knex.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import { resetRateLimits } from '../http/middleware/api-key-rate-limit.js';
import { resetApiKeyFailures } from '../http/middleware/require-api-key.js';
import { resetPublicApiTenantCache } from '../http/routes/public-api.routes.js';
import { UnauthorizedError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { hashPassword } from '../lib/password.js';
import { resetSecretBox } from '../lib/secret-box.js';
import { resetChangeRing } from '../realtime/change-ring.js';
import { disconnectEverySocket } from '../realtime/hub.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import { invalidateFieldCache } from '../repositories/custom-field.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import { invalidatePipelineCache } from '../repositories/pipeline.repository.js';
import { invalidateRoleCache } from '../repositories/role.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import { insertUser, roleIdForTier } from '../repositories/user.repository.js';
import { invalidateSessionsForUser, resetAuthState } from './auth.service.js';
import { createDeveloperGate, type DeveloperGate } from './developer-gate.js';
import { rememberPassword } from './password-vault.service.js';
import { invalidateSettingsCache } from './settings.service.js';
import { getIdentity, isSetupComplete, runFirstTimeSetup } from './setup.service.js';

const log = createLogger('developer');

export { createDeveloperGate, type DeveloperGate, type DeveloperGateOptions } from './developer-gate.js';

/** The one gate the routes use. */
export const developerGate: DeveloperGate = createDeveloperGate();

/**
 * The trail's entry for a developer-mode event. Detached: an unlock is an
 * attempt and a lock changes nothing in the database (see
 * `recordDetachedActivity`). The gate itself stays free of the database, so
 * `developer-service.test.ts` can build one with no PostgreSQL.
 */
function recordDeveloperEvent(
  actor: ActorContext,
  action: 'unlocked' | 'unlock_failed' | 'locked' | 'data_erased' | 'dummy_users_seeded',
  details?: Record<string, unknown>,
): Promise<void> {
  return recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'developer',
      entityId: actor.tenantId,
      action,
      actorType: actor.actorType,
      actorId: actor.actorId,
      details,
    },
    actor,
    db(),
  );
}

/** `developerGate.unlock`, with a wrong password and a success both on the trail. */
export async function unlockDeveloper(
  password: unknown,
  actor: ActorContext,
  gate: DeveloperGate = developerGate,
): Promise<DeveloperUnlock> {
  let unlock: DeveloperUnlock;
  try {
    unlock = await gate.unlock(password);
  } catch (error) {
    // Only a wrong password. A blank field or a lockout refusal checked nothing.
    if (error instanceof UnauthorizedError) await recordDeveloperEvent(actor, 'unlock_failed');
    throw error;
  }
  await recordDeveloperEvent(actor, 'unlocked');
  return unlock;
}

/** `developerGate.lock`, logged only when the token was a live one. */
export async function lockDeveloper(
  token: string | undefined,
  actor: ActorContext,
  gate: DeveloperGate = developerGate,
): Promise<void> {
  const wasUnlocked = gate.status(token).unlocked;
  gate.lock(token);
  if (wasUnlocked) await recordDeveloperEvent(actor, 'locked');
}

/**
 * Erase this Master back to first run.
 *
 * The order is the point. Sessions and sockets go first so nothing is
 * mid-write when the schema vanishes. The schema is dropped and the migrations
 * re-run rather than tables truncated and re-seeded by hand: that is the same
 * code path a fresh install takes, so what comes back is by construction what
 * a fresh install has. Files go after the database so a crash between the two
 * leaves an installation that says "set up" with no data, which the setup
 * screen handles, rather than one that says "not set up" with a live vault key.
 */
export async function resetAllData(actor?: ActorContext): Promise<ResetAllResult> {
  resetAuthState();
  disconnectEverySocket();

  await db().raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();

  // The cluster directory, its socket, the postgres password file and `logs`
  // are deliberately not on this list: the database server is still running
  // out of the first, and the last is where somebody reads what happened.
  for (const dir of [
    config.uploadsDir,
    // The removed PDF Designer's folder. Nothing writes it any more, but an
    // installation upgraded from before `20260322` still carries it, and a
    // reset that promises the pre-setup state should not leave it behind.
    path.join(config.dataDir, 'documents'),
    path.join(config.dataDir, 'secrets'),
    path.join(config.dataDir, 'tmp'),
  ]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.mkdir(config.uploadsDir, { recursive: true });
  // The next `loadOrCreateKey()` mints a fresh `vault.key`; the old one would
  // only ever have unsealed rows that no longer exist.
  resetSecretBox();

  // Every in-process cache that holds tenant data. Each survives the schema
  // drop, and a stale entry here is a role nobody granted, a setting nobody
  // set, or a tenant id that no longer exists.
  invalidateSettingsCache();
  invalidateRoleCache();
  invalidatePipelineCache();
  invalidateFieldCache();
  resetPublicApiTenantCache();
  resetRateLimits();
  resetApiKeyFailures();
  // The change ring's sequence would otherwise carry on from where the old
  // data left off, and a panel re-paired later could ask for a delta since a
  // seq that describes records this database never held.
  resetChangeRing();

  log.warn('Developer reset: every record on this Master has been erased');

  // The first entry of the fresh trail. The person who pressed the button no
  // longer exists as a user row, so the entry keeps only their name.
  const tenantId = await resolveDefaultTenantId();
  await recordDeveloperEvent({ ...systemActor(tenantId), actorName: actor?.actorName ?? 'System' }, 'data_erased');

  return { ok: true, state: 'first-run' };
}

/**
 * Create (or re-arm) the documented test accounts, one per tier.
 *
 * Runs first-time setup itself when nobody has, because a user row needs a
 * tenant and `master_config` to mean anything; the pairing password that
 * setup generated is returned so it is shown exactly once, as the setup
 * screen would have. Setup then creates the two documented dummy Server
 * Masters (`DUMMY_SERVER_MASTERS`), since it no longer creates an `admin`.
 *
 * A Server Master is never touched: a dummy account whose username already
 * belongs to one is skipped rather than demoted.
 */
export async function seedDummyUsers(actor?: ActorContext): Promise<SeedDummyUsersResult> {
  const users: DummyUserCredential[] = [];
  let pairingPassword: string | null = null;
  if (!(await isSetupComplete())) {
    pairingPassword = (await runFirstTimeSetup('OrderBook Test Company', DUMMY_SERVER_MASTERS))
      .pairingPassword;
    for (const spec of DUMMY_SERVER_MASTERS) users.push({ ...spec, outcome: 'created' });
  }

  const tenantId = await resolveDefaultTenantId();
  const resetUserIds: string[] = [];

  for (const spec of DUMMY_USERS) {
    const passwordHash = await hashPassword(spec.password);
    const roleId = await roleIdForTier(tenantId, spec.tier);

    const outcome = await db().transaction(async (trx) => {
      const existing = await trx('users as u')
        .leftJoin('roles as r', 'r.id', 'u.role_id')
        .where({ 'u.tenant_id': tenantId })
        .whereNull('u.deleted_at')
        .whereRaw('lower(u.username) = lower(?)', [spec.username])
        .first<{ id: string; tier: string | null } | undefined>('u.id', 'r.tier');

      if (existing?.tier === 'server_master') return null;

      if (existing) {
        // A direct column write, not `user.service.ts`'s guarded update: this
        // is a developer tool re-arming a known test account, and the guards
        // there (last-admin, self-deactivation, audit trail) are about people.
        await trx('users')
          .where({ id: existing.id })
          .update({
            password_hash: passwordHash,
            role_id: roleId,
            display_name: spec.displayName,
            is_active: true,
            hlc: await nextHlc(trx),
            version: trx.raw('version + 1'),
            updated_at: trx.fn.now(),
          });
        resetUserIds.push(existing.id);
        return { userId: existing.id, outcome: 'reset' as const };
      }

      const userId = await insertUser(
        {
          tenantId,
          username: spec.username,
          displayName: spec.displayName,
          passwordHash,
          roleId,
          createdBy: null,
          hlc: await nextHlc(trx),
          fieldHlc: {},
        },
        trx,
      );
      return { userId, outcome: 'created' as const };
    });

    if (!outcome) continue;

    // After the transaction, for the reason `setup.service.ts` gives: the
    // vault fingerprints the live hash, which must be committed first.
    await rememberPassword(tenantId, outcome.userId, spec.password, null);
    users.push({ ...spec, outcome: outcome.outcome });
  }

  // A session signed in under the old password must not outlive it.
  for (const userId of resetUserIds) invalidateSessionsForUser(userId, { reason: 'expired' });

  // One entry for the whole run, written after its last transaction.
  await recordDeveloperEvent(actor ?? systemActor(tenantId), 'dummy_users_seeded', { count: users.length });

  return { users, pairingPassword, companyName: (await getIdentity())?.companyName ?? null };
}
