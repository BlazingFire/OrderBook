/**
 * Developer mode on the Master (`shared/src/domain/developer.ts` says why it
 * exists and why a password rather than a permission guards it).
 *
 * Three things live here. The **gate** — password check, lockout, and the
 * short-lived tokens the routes hand out — is a factory with an injectable
 * clock so the lockout window can be tested without waiting a minute of wall
 * time; the module exports one live instance for the routes. **`resetAllData`**
 * takes the installation back to first run. **`seedDummyUsers`** creates the
 * documented throwaway accounts.
 *
 * Nothing here is reachable without a signed-in session *and* a developer
 * token: the routes enforce the first, the gate the second.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEVELOPER_PASSWORD_HASH,
  DEVELOPER_TOKEN_TTL_MS,
  DEVELOPER_UNLOCK_LOCKOUT_MS,
  DEVELOPER_UNLOCK_MAX_FAILURES,
  DUMMY_USERS,
  type DeveloperStatus,
  type DeveloperUnlock,
  type DummyUserCredential,
  type ResetAllResult,
  type SeedDummyUsersResult,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db, runMigrations } from '../db/knex.js';
import { resetRateLimits } from '../http/middleware/api-key-rate-limit.js';
import { resetApiKeyFailures } from '../http/middleware/require-api-key.js';
import { resetPublicApiTenantCache } from '../http/routes/public-api.routes.js';
import { ensureDocumentDirectories } from '../lib/document-files.js';
import { TooManyRequestsError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { resetSecretBox } from '../lib/secret-box.js';
import { resetChangeRing } from '../realtime/change-ring.js';
import { disconnectEverySocket } from '../realtime/hub.js';
import { invalidateFieldCache } from '../repositories/custom-field.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import { invalidatePipelineCache } from '../repositories/pipeline.repository.js';
import { invalidateRoleCache } from '../repositories/role.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import { insertUser, roleIdForTier } from '../repositories/user.repository.js';
import { invalidateSessionsForUser, resetAuthState } from './auth.service.js';
import { rememberPassword } from './password-vault.service.js';
import { invalidateSettingsCache } from './settings.service.js';
import { getIdentity, isSetupComplete, runFirstTimeSetup } from './setup.service.js';

const log = createLogger('developer');

export interface DeveloperGate {
  unlock(password: unknown): Promise<DeveloperUnlock>;
  status(token: string | undefined): DeveloperStatus;
  lock(token: string | undefined): void;
  /** Throws 401 `error.unauthorized.developerMode` unless `token` is live. */
  assertUnlocked(token: string | undefined): void;
}

export interface DeveloperGateOptions {
  /** Milliseconds since the epoch. Tests hand in a fake. */
  now?: () => number;
  /** The `.env` override, read per call so a test can set and unset it. */
  overridePassword?: () => string | undefined;
}

export function createDeveloperGate(options: DeveloperGateOptions = {}): DeveloperGate {
  const now = options.now ?? Date.now;
  const overridePassword =
    options.overridePassword ?? (() => process.env.ORDERBOOK_DEVELOPER_PASSWORD);

  const tokens = new Map<string, number>();

  // One counter for the whole process rather than per address: the Master is
  // on a LAN where every caller shares a handful of addresses, and a guesser
  // who could reset the count by changing address would have no limit at all.
  let failures = 0;
  let lockedUntil = 0;

  function prune(): void {
    const at = now();
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= at) tokens.delete(token);
    }
  }

  async function matches(password: string): Promise<boolean> {
    const override = overridePassword();
    if (override !== undefined && override !== '') {
      const a = Buffer.from(password, 'utf8');
      const b = Buffer.from(override, 'utf8');
      // `timingSafeEqual` throws on unequal lengths rather than answering
      // false, and a thrown error would surface as a 500.
      return a.length === b.length && timingSafeEqual(a, b);
    }
    return (await verifyPassword(password, DEVELOPER_PASSWORD_HASH)).matches;
  }

  return {
    async unlock(password) {
      prune();
      const at = now();
      if (lockedUntil > at) {
        throw new TooManyRequestsError(Math.ceil((lockedUntil - at) / 1000));
      }
      if (typeof password !== 'string' || password.length === 0) {
        throw new ValidationError('validation.developer.passwordRequired');
      }

      if (!(await matches(password))) {
        failures += 1;
        if (failures >= DEVELOPER_UNLOCK_MAX_FAILURES) {
          failures = 0;
          lockedUntil = now() + DEVELOPER_UNLOCK_LOCKOUT_MS;
        }
        throw new UnauthorizedError('error.unauthorized.developerPassword');
      }

      failures = 0;
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + DEVELOPER_TOKEN_TTL_MS;
      tokens.set(token, expiresAt);
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    status(token) {
      prune();
      const expiresAt = token ? tokens.get(token) : undefined;
      const override = overridePassword();
      return {
        unlocked: expiresAt !== undefined,
        expiresAt: expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
        passwordOverridden: override !== undefined && override !== '',
      };
    },

    lock(token) {
      prune();
      if (token) tokens.delete(token);
    },

    assertUnlocked(token) {
      prune();
      if (!token || !tokens.has(token)) {
        throw new UnauthorizedError('error.unauthorized.developerMode');
      }
    },
  };
}

/** The one gate the routes use. */
export const developerGate: DeveloperGate = createDeveloperGate();

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
export async function resetAllData(): Promise<ResetAllResult> {
  resetAuthState();
  disconnectEverySocket();

  await db().raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();

  // The cluster directory, its socket, the postgres password file and `logs`
  // are deliberately not on this list: the database server is still running
  // out of the first, and the last is where somebody reads what happened.
  for (const dir of [
    config.uploadsDir,
    config.documents.dir,
    path.join(config.dataDir, 'secrets'),
    path.join(config.dataDir, 'tmp'),
  ]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.mkdir(config.uploadsDir, { recursive: true });
  await ensureDocumentDirectories();
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
  return { ok: true, state: 'first-run' };
}

/**
 * Create (or re-arm) the documented test accounts, one per tier.
 *
 * Runs first-time setup itself when nobody has, because a user row needs a
 * tenant and `master_config` to mean anything; the pairing password that
 * setup generated is returned so it is shown exactly once, as the setup
 * screen would have.
 */
export async function seedDummyUsers(): Promise<SeedDummyUsersResult> {
  const pairingPassword = (await isSetupComplete())
    ? null
    : (await runFirstTimeSetup('OrderBook Test Company')).pairingPassword;

  const tenantId = await resolveDefaultTenantId();
  const users: DummyUserCredential[] = [];
  const resetUserIds: string[] = [];

  for (const spec of DUMMY_USERS) {
    const passwordHash = await hashPassword(spec.password);
    const roleId = await roleIdForTier(tenantId, spec.tier);

    const outcome = await db().transaction(async (trx) => {
      const existing = await trx('users')
        .where({ tenant_id: tenantId })
        .whereNull('deleted_at')
        .whereRaw('lower(username) = lower(?)', [spec.username])
        .first<{ id: string } | undefined>('id');

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

    // After the transaction, for the reason `setup.service.ts` gives: the
    // vault fingerprints the live hash, which must be committed first.
    await rememberPassword(tenantId, outcome.userId, spec.password, null);
    users.push({ ...spec, outcome: outcome.outcome });
  }

  // A session signed in under the old password must not outlive it.
  for (const userId of resetUserIds) invalidateSessionsForUser(userId, { reason: 'expired' });

  return { users, pairingPassword, companyName: (await getIdentity())?.companyName ?? null };
}
