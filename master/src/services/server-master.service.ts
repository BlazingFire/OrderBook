/**
 * Server Master accounts (docs/plans/1.3-BATCH.md, Phase 2).
 *
 * The owner's tier. Its users are created in exactly two ways: first-run setup
 * (the owner types both accounts) and, on an installation that has fewer than
 * two, the master-key setup flow on the Master PC. Both go through
 * `createServerMasters` here.
 *
 * Everything else in this file needs a live master-key token
 * (`master-key.service.ts`): listing the accounts before sign-in, setting up
 * the missing ones, recovering a forgotten password, and changing the pairing
 * password.
 */

import {
  SERVER_MASTER_MIN_ACTIVE,
  allPermissions,
  type ServerMasterAccount,
  type ServerMasterAccountInput,
} from '@orderbook/shared';
import bcrypt from 'bcryptjs';

import { db } from '../db/knex.js';
import { assertNameAvailable } from '../domain/access.js';
import { actorUserId, type ActorContext } from '../domain/actor.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { assertPasswordLongEnough, hashPassword } from '../lib/password.js';
import * as accessGuard from '../repositories/access-guard.repository.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { regeneratePairingPasswordHash } from '../repositories/backup.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import { findMasterConfig } from '../repositories/master-config.repository.js';
import * as roleRepo from '../repositories/role.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import * as userRepo from '../repositories/user.repository.js';
import { clearSignInFailures, invalidateSessionsForUser } from './auth.service.js';
import { publishChange } from './change-bus.js';
import { masterKeyGate, masterPcActor } from './master-key.service.js';
import { rememberPassword } from './password-vault.service.js';
import { generateReadableSecret } from './setup.service.js';

const ROLE_NAME = 'Server Master';
/** The migration's fallback, for a company that already has a role by that name. */
const FALLBACK_ROLE_NAME = 'Server Master (system)';

const USER_FIELDS = ['username', 'displayName', 'roleId', 'isActive'] as const;

/** An account that passed validation, hashed and ready to insert. */
export interface PreparedServerMaster {
  username: string;
  displayName: string;
  password: string;
  passwordHash: string;
}

/** Same as the pairing password setup generates (`setup.service.ts`). */
const BCRYPT_ROUNDS = 10;

/**
 * The live Server Master role's id, creating it if it is missing.
 *
 * The migration seeds it, but a restore from a backup older than the tier
 * brings back a roles table without it, so every path that is about to put a
 * Server Master somewhere calls this first.
 */
export async function ensureServerMasterRole(
  tenantId: string,
  trx: TransactionContext,
): Promise<string> {
  const existing = await userRepo.roleIdForTier(tenantId, 'server_master', trx);
  if (existing) return existing;

  const name = (await roleRepo.isNameTaken(tenantId, ROLE_NAME, null, trx))
    ? FALLBACK_ROLE_NAME
    : ROLE_NAME;

  return roleRepo.insertRole(
    {
      tenantId,
      name,
      tier: 'server_master',
      permissions: allPermissions(),
      isSystem: true,
      createdBy: null,
      hlc: await nextHlc(trx),
      fieldHlc: {},
    },
    trx,
  );
}

/**
 * Check what the owner typed and hash it, before any transaction opens.
 *
 * `expected` is how many accounts the caller needs: two at first run, the
 * missing number on an upgrade.
 */
export async function prepareServerMasters(
  inputs: unknown,
  expected: number,
): Promise<PreparedServerMaster[]> {
  if (!Array.isArray(inputs) || inputs.length !== expected) {
    throw new ValidationError('validation.serverMaster.accountCount', { count: expected });
  }

  const prepared: PreparedServerMaster[] = [];
  for (const raw of inputs as Array<Partial<ServerMasterAccountInput> | null>) {
    const username = typeof raw?.username === 'string' ? raw.username.trim().toLowerCase() : '';
    const displayName = typeof raw?.displayName === 'string' ? raw.displayName.trim() : '';
    const password = typeof raw?.password === 'string' ? raw.password : '';

    if (!username) throw new ValidationError('validation.user.username.required');
    if (!displayName) throw new ValidationError('validation.user.displayName.required');
    assertPasswordLongEnough(password);

    if (prepared.some((account) => account.username === username)) {
      throw new ValidationError('validation.serverMaster.usernamesDistinct');
    }

    prepared.push({ username, displayName, password, passwordHash: await hashPassword(password) });
  }

  return prepared;
}

/**
 * Insert the accounts into the Server Master role, one `user.created` entry
 * each. Inside the caller's transaction; the caller seals the passwords into
 * the vault after it commits (`rememberServerMasters`).
 */
export async function createServerMasters(
  tenantId: string,
  accounts: readonly PreparedServerMaster[],
  actor: ActorContext,
  trx: TransactionContext,
): Promise<Array<{ id: string; username: string; displayName: string }>> {
  const roleId = await ensureServerMasterRole(tenantId, trx);
  const role = await roleRepo.findRoleById(tenantId, roleId, {}, trx);
  const created: Array<{ id: string; username: string; displayName: string }> = [];

  for (const account of accounts) {
    assertNameAvailable(
      await userRepo.isUsernameTaken(tenantId, account.username, null, trx),
      'user',
      account.username,
    );

    const hlc = await nextHlc(trx);
    const id = await userRepo.insertUser(
      {
        tenantId,
        username: account.username,
        displayName: account.displayName,
        passwordHash: account.passwordHash,
        roleId,
        createdBy: actorUserId(actor),
        hlc,
        fieldHlc: Object.fromEntries(USER_FIELDS.map((field) => [field, hlc])),
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId,
        entityType: 'user',
        entityId: id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          username: account.username,
          displayName: account.displayName,
          name: account.displayName,
          roleId,
          roleName: role?.name ?? ROLE_NAME,
        },
      },
      actor,
      trx,
    );

    created.push({ id, username: account.username, displayName: account.displayName });
  }

  return created;
}

/** After the commit: the vault (a no-op unless switched on) and the change feed. */
export async function rememberServerMasters(
  tenantId: string,
  created: ReadonlyArray<{ id: string; username: string }>,
  accounts: readonly PreparedServerMaster[],
  actor: ActorContext,
): Promise<void> {
  for (const row of created) {
    const account = accounts.find((candidate) => candidate.username === row.username);
    if (account) await rememberPassword(tenantId, row.id, account.password, actorUserId(actor));

    const user = await userRepo.findById(tenantId, row.id);
    if (user) publishChange({ entity: 'user', action: 'created', id: user.id, payload: user });
  }
}

/** How many more active Server Masters this installation needs. Zero before setup. */
export async function serverMastersNeeded(): Promise<number> {
  if (!(await findMasterConfig())) return 0;
  const active = await accessGuard.countActiveServerMasters(await resolveDefaultTenantId());
  return Math.max(0, SERVER_MASTER_MIN_ACTIVE - active);
}

/**
 * Every live Server Master, for the master-key screens (the recovery picker and
 * the setup flow's "already exists" list). No passwords, no hashes.
 */
export async function listServerMasters(
  token: string | undefined,
): Promise<{ accounts: ServerMasterAccount[]; needed: number }> {
  masterKeyGate.assertUnlocked(token);

  const tenantId = await resolveDefaultTenantId();
  const users = await userRepo.listUsers(tenantId);
  return {
    accounts: users
      .filter((user) => user.roleTier === 'server_master')
      .map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        isActive: user.isActive,
      })),
    needed: await serverMastersNeeded(),
  };
}

/**
 * The upgrade flow: an installation set up before the tier existed (or
 * restored from such a backup) has fewer than two Server Masters, and the
 * owner adds exactly the missing ones on the Master PC with the master key.
 */
export async function setUpMissingServerMasters(
  inputs: unknown,
  token: string | undefined,
  actor: ActorContext | null = null,
): Promise<Array<{ id: string; username: string; displayName: string }>> {
  masterKeyGate.assertUnlocked(token);

  if (!(await findMasterConfig())) throw new ConflictError('error.conflict.notSetUp');

  const needed = await serverMastersNeeded();
  if (needed === 0) throw new ConflictError('error.conflict.serverMastersComplete');

  const accounts = await prepareServerMasters(inputs, needed);
  const tenantId = await resolveDefaultTenantId();
  const who = actor ?? masterPcActor(tenantId);

  const created = await db().transaction(async (trx) => {
    // Counted again under the lock: two Master-PC windows finishing the flow
    // at once must not create four.
    await accessGuard.lockTenantAccessGuards(tenantId, trx);
    const active = await accessGuard.countActiveServerMasters(tenantId, trx);
    if (SERVER_MASTER_MIN_ACTIVE - active !== needed) {
      throw new ConflictError('error.conflict.serverMastersComplete');
    }

    const rows = await createServerMasters(tenantId, accounts, who, trx);

    await activityLog.recordActivity(
      {
        tenantId,
        entityType: 'user',
        entityId: rows[0]?.id ?? 'server_master',
        action: 'server_masters_set_up',
        actorType: who.actorType,
        actorId: who.actorId,
        details: { names: rows.map((row) => row.displayName).join(', ') },
      },
      who,
      trx,
    );

    return rows;
  });

  await rememberServerMasters(tenantId, created, accounts, who);
  return created;
}

/**
 * Reset a Server Master's password with the master key — the "Forgot Server
 * Master password?" link on the Master PC sign-in screen. The password only,
 * never the username. Also lifts that username's sign-in lockout and ends its
 * sessions, so the person can sign in straight away with the new one.
 */
export async function recoverServerMasterPassword(
  userId: unknown,
  newPassword: unknown,
  token: string | undefined,
  actor: ActorContext | null = null,
): Promise<void> {
  masterKeyGate.assertUnlocked(token);

  const tenantId = await resolveDefaultTenantId();
  const existing =
    typeof userId === 'string' ? await userRepo.findById(tenantId, userId) : null;
  if (!existing || existing.roleTier !== 'server_master') throw new NotFoundError('User');

  const password = typeof newPassword === 'string' ? newPassword : '';
  assertPasswordLongEnough(password);
  const passwordHash = await hashPassword(password);
  const who = actor ?? masterPcActor(tenantId);

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    await userRepo.updateUserColumns(
      tenantId,
      existing.id,
      { password_hash: passwordHash, updated_by: actorUserId(who) },
      { hlc, fieldHlc: { ...existing.sync.fieldHlc, passwordHash: hlc } },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId,
        entityType: 'user',
        entityId: existing.id,
        action: 'password_recovered',
        actorType: who.actorType,
        actorId: who.actorId,
        details: { name: existing.displayName, username: existing.username },
      },
      who,
      trx,
    );
  });

  await rememberPassword(tenantId, existing.id, password, actorUserId(who));
  invalidateSessionsForUser(existing.id, { reason: 'expired' });
  clearSignInFailures(existing.username);
}

/**
 * A new pairing password, shown once. Only a Server Master may, with the
 * master key; the route also keeps it to the Master PC.
 *
 * Already-paired panels are unaffected: they hold their own secrets. The Master
 * ID is deliberately not changeable here, because that would orphan every
 * pairing.
 */
export async function changePairingPassword(
  actor: ActorContext,
  token: string | undefined,
): Promise<{ pairingPassword: string }> {
  if (actor.permissions?.tier !== 'server_master') {
    throw new ForbiddenError('settings.manage', 'error.forbidden.serverMasterOnly');
  }
  masterKeyGate.assertUnlocked(token);

  const config = await findMasterConfig();
  if (!config) throw new ConflictError('error.conflict.notSetUp');

  const pairingPassword = generateReadableSecret();
  const hash = await bcrypt.hash(pairingPassword, BCRYPT_ROUNDS);

  await db().transaction(async (trx) => {
    await regeneratePairingPasswordHash(trx, hash);
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'master_config',
        entityId: config.master_unique_id,
        action: 'pairing_password_changed',
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
      actor,
      trx,
    );
  });

  return { pairingPassword };
}
