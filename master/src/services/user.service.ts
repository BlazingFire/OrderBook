/**
 * Users (docs/ROLES_AND_USERS.md §9–§11).
 *
 * The rule that costs the most to get wrong lives here: **guard G4 runs inside
 * the transaction**. Counting remaining administrators before the transaction
 * lets two concurrent deactivations each see one admin left and both succeed,
 * locking the company out of its own software — a failure that needs vendor
 * intervention to undo, and therefore the most expensive bug this module can
 * ship.
 */

import { fieldFor, USER_COLUMNS } from '@orderbook/shared';
import type {
  OneTimeSecret,
  PasswordResetInput,
  User,
  UserInput,
  UserUpdateInput,
} from '@orderbook/shared';

import {
  fieldDiff,
  assertAdministrativeCapabilityRetained,
  assertNameAvailable,
  assertTierWithinActor,
  assertVersionMatches,
} from '../domain/access.js';
import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { assertParentsLive, suggestRestoredName } from '../domain/recycle-bin.js';
import { db } from '../db/knex.js';
import {
  assertPasswordLongEnough,
  generateTemporaryPassword,
  hashPassword,
} from '../lib/password.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as accessGuard from '../repositories/access-guard.repository.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as recycleBinRepo from '../repositories/recycle-bin.repository.js';
import * as roleRepo from '../repositories/role.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import { publishChange } from './change-bus.js';
import { invalidateSessionsForUser } from './auth.service.js';
import { rememberPassword } from './password-vault.service.js';

const USER_FIELDS = ['username', 'displayName', 'roleId', 'isActive'] as const;

export async function listUsers(actor: ActorContext): Promise<User[]> {
  requirePermission(actor, 'users.manage');
  return userRepo.listUsers(actor.tenantId);
}

export async function listDeletedUsers(actor: ActorContext): Promise<User[]> {
  requirePermission(actor, 'users.manage');
  return userRepo.listDeletedUsers(actor.tenantId);
}

export async function getUser(id: string, actor: ActorContext): Promise<User> {
  requirePermission(actor, 'users.manage');

  const user = await userRepo.findById(actor.tenantId, id);
  if (!user) throw new NotFoundError('User');
  return user;
}

/**
 * Create a user and hand back the temporary password **once**.
 *
 * The plaintext exists in one local variable, is hashed immediately, and is
 * returned exactly once. It is never logged, never stored, and never recorded in
 * the audit trail — the trail records *that* a user was created, not what their
 * password was.
 */
export async function createUser(
  input: UserInput,
  actor: ActorContext,
): Promise<{ user: User; secret: OneTimeSecret }> {
  requirePermission(actor, 'users.manage');

  const username = input.username?.trim().toLowerCase();
  const displayName = input.displayName?.trim();

  if (!username) throw new ValidationError('validation.user.username.required');
  if (!displayName) throw new ValidationError('validation.user.displayName.required');

  const role = await roleRepo.findRoleById(actor.tenantId, input.roleId);
  if (!role) throw new ValidationError('validation.user.role.mustExist');

  // G3 — you cannot mint someone above yourself.
  assertTierWithinActor(actor, role.tier);
  assertNameAvailable(
    await userRepo.isUsernameTaken(actor.tenantId, username, null),
    'user',
    username,
  );

  // Checked on the supplied value, before the fallback: a generated password
  // always clears the minimum, so checking `password` would enforce nothing.
  const supplied = input.password?.trim();
  if (supplied) assertPasswordLongEnough(supplied);

  const password = supplied || generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  const id = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    const userId = await userRepo.insertUser(
      {
        tenantId: actor.tenantId,
        username,
        displayName,
        passwordHash,
        roleId: role.id,
        createdBy: actorUserId(actor),
        hlc,
        fieldHlc: Object.fromEntries(USER_FIELDS.map((field) => [field, hlc])),
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: userId,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // Username, display name and role. Never the password or its hash.
        details: { username, displayName, roleId: role.id, roleName: role.name },
      },
      actor,
      trx,
    );

    return userId;
  });

  const user = await userRepo.findById(actor.tenantId, id);
  if (!user) throw new Error('User disappeared immediately after insert');

  // Sealed after the transaction, so the fingerprint is taken from the hash
  // that is actually on disk. A no-op unless the company switched the password
  // vault on.
  await rememberPassword(actor.tenantId, user.id, password, actorUserId(actor));

  publishChange({ entity: 'user', action: 'created', id: user.id, payload: user });

  return { user, secret: { userId: user.id, username, password } };
}

export async function updateUser(
  id: string,
  input: UserUpdateInput,
  actor: ActorContext,
): Promise<User> {
  requirePermission(actor, 'users.manage');

  const existing = await userRepo.findById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('User');

  assertVersionMatches(
    existing.sync.version,
    input.expectedVersion,
    fieldDiff(
      {
        username: existing.username,
        displayName: existing.displayName,
        roleId: existing.roleId,
        isActive: existing.isActive,
      },
      {
        username: input.username?.trim().toLowerCase(),
        displayName: input.displayName?.trim(),
        roleId: input.roleId,
        isActive: input.isActive,
      },
    ),
  );

  const patch: Record<string, unknown> = {};
  /*
   * Seeded with the person's name, because that is what the sentence renders:
   * "{actor} updated {name}". Everything added below is the *diff* — a
   * from/to per changed field — and a diff alone left the placeholder to reach
   * the Activity log verbatim.
   */
  const details: Record<string, unknown> = { name: existing.displayName };

  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    if (!displayName) throw new ValidationError('validation.user.displayName.required');
    patch.display_name = displayName;
    details.displayName = { from: existing.displayName, to: displayName };
  }

  if (input.username !== undefined) {
    const username = input.username.trim().toLowerCase();
    if (!username) throw new ValidationError('validation.user.username.required');
    assertNameAvailable(
      await userRepo.isUsernameTaken(actor.tenantId, username, id),
      'user',
      username,
    );
    patch.username = username;
    details.username = { from: existing.username, to: username };
  }

  if (input.roleId !== undefined && input.roleId !== existing.roleId) {
    requirePermission(actor, 'roles.assign');

    const role = await roleRepo.findRoleById(actor.tenantId, input.roleId);
    if (!role) throw new ValidationError('validation.user.role.mustExist');
    assertTierWithinActor(actor, role.tier);

    patch.role_id = role.id;
    details.role = {
      from: { id: existing.roleId, name: existing.roleName },
      to: { id: role.id, name: role.name },
    };
  }

  if (input.isActive !== undefined) {
    patch.is_active = input.isActive;
    details.isActive = { from: existing.isActive, to: input.isActive };
  }

  if (Object.keys(patch).length === 0) return existing;

  await db().transaction(async (trx) => {
    // G4. The lock comes first: two transactions deactivating two *different*
    // administrators touch disjoint rows, so at READ COMMITTED neither blocks
    // the other and both would see one admin remaining.
    await accessGuard.lockTenantAccessGuards(actor.tenantId, trx);
    const adminsBefore = await accessGuard.readAdministrativeCapability(actor.tenantId, trx);

    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const column of Object.keys(patch)) fieldHlc[columnToField(column)] = hlc;

    await userRepo.updateUserColumns(
      actor.tenantId,
      id,
      { ...patch, updated_by: actorUserId(actor) },
      { hlc, fieldHlc },
      trx,
    );

    // Applied, then asserted. The previous version predicted which edits could
    // remove an administrator and only checked those — but "moved onto a role
    // that has since been re-tiered" is not on that list, and neither is any
    // future field. Asking the database is one indexed read and cannot be
    // out-thought.
    assertAdministrativeCapabilityRetained(
      adminsBefore,
      await accessGuard.readAdministrativeCapability(actor.tenantId, trx),
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: id,
        action: input.isActive === false ? 'deactivated' : 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details,
      },
      actor,
      trx,
    );
  });

  // A changed role or a deactivation must not survive in an open session — and
  // those two are revocations, which is what tells an Office panel to destroy
  // the offline verifier it holds. A rename is not: the person still works
  // here, so their panel keeps them.
  invalidateSessionsForUser(id, {
    reason: patch.is_active === false || patch.role_id !== undefined ? 'revoked' : 'expired',
  });

  const user = await userRepo.findById(actor.tenantId, id);
  if (!user) throw new NotFoundError('User');

  publishChange({ entity: 'user', action: 'updated', id, payload: user });
  return user;
}

export async function deleteUser(id: string, actor: ActorContext): Promise<User> {
  requirePermission(actor, 'users.manage');

  const existing = await userRepo.findById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('User');

  await db().transaction(async (trx) => {
    // This path previously held no lock at all — it does not call `nextHlc`, so
    // it never even took the clock row's lock that the update path incidentally
    // had.
    await accessGuard.lockTenantAccessGuards(actor.tenantId, trx);
    const adminsBefore = await accessGuard.readAdministrativeCapability(actor.tenantId, trx);

    await userRepo.softDeleteUser(actor.tenantId, id, actorUserId(actor), trx);

    assertAdministrativeCapabilityRetained(
      adminsBefore,
      await accessGuard.readAdministrativeCapability(actor.tenantId, trx),
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: existing.displayName, username: existing.username },
      },
      actor,
      trx,
    );
  });

  invalidateSessionsForUser(id, { reason: 'revoked' });

  const user = await userRepo.findById(actor.tenantId, id, { includeDeleted: true });
  if (!user) throw new NotFoundError('User');

  publishChange({ entity: 'user', action: 'deleted', id, payload: user });
  return user;
}

export async function restoreUser(
  id: string,
  actor: ActorContext,
  renameTo?: string,
): Promise<User> {
  requirePermission(actor, 'users.manage');

  const existing = await userRepo.findById(actor.tenantId, id, { includeDeleted: true });
  if (!existing) throw new NotFoundError('User');
  if (!existing.deletedAt) return existing;

  // A user whose role is still in the Bin would come back unable to sign in
  // meaningfully — restoring the account must not silently produce that.
  if (existing.roleId) {
    const role = await recycleBinRepo.findParentStatus(actor.tenantId, 'role', existing.roleId);
    assertParentsLive([
      {
        entityType: 'role',
        id: existing.roleId,
        label: role?.label ?? existing.roleId,
        isLive: role?.isLive ?? false,
      },
    ]);
  }

  const desiredUsername = renameTo ?? existing.username;
  if (await userRepo.isUsernameTaken(actor.tenantId, desiredUsername, id)) {
    const suggestion = await suggestRestoredName(existing.username, (candidate) =>
      userRepo.isUsernameTaken(actor.tenantId, candidate, id),
    );
    throw new ConflictError(
      'error.conflict.restoreCollision',
      { field: 'username' },
      { field: 'username', value: desiredUsername, suggestion },
    );
  }

  await db().transaction(async (trx) => {
    await userRepo.restoreUser(actor.tenantId, id, trx, renameTo);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          name: existing.displayName,
          username: existing.username,
          ...(renameTo ? { renamedTo: renameTo } : {}),
        },
      },
      actor,
      trx,
    );
  });

  const user = await userRepo.findById(actor.tenantId, id);
  if (!user) throw new NotFoundError('User');

  publishChange({ entity: 'user', action: 'restored', id, payload: user });
  return user;
}

/** Reset somebody else's password. Returns the plaintext once. */
export async function resetPassword(
  input: PasswordResetInput,
  actor: ActorContext,
): Promise<OneTimeSecret> {
  requirePermission(actor, 'users.manage');

  const existing = await userRepo.findById(actor.tenantId, input.userId);
  if (!existing) throw new NotFoundError('User');

  // Same rule as `createUser`, and the same reason it is on the supplied value.
  const supplied = input.password?.trim();
  if (supplied) assertPasswordLongEnough(supplied);

  const password = supplied || generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    await userRepo.updateUserColumns(
      actor.tenantId,
      input.userId,
      { password_hash: passwordHash, updated_by: actorUserId(actor) },
      { hlc, fieldHlc: { ...existing.sync.fieldHlc, passwordHash: hlc } },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'user',
        entityId: input.userId,
        action: 'password_reset',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // That a reset happened, by whom, for whom. No password material, no hash.
        details: { name: existing.displayName, username: existing.username },
      },
      actor,
      trx,
    );
  });

  await rememberPassword(actor.tenantId, input.userId, password, actorUserId(actor));

  // Whoever was signed in as them is signed out; the old password is gone.
  //
  // Not a revocation: the person still works here, so their Office panels keep
  // the record that lets them sign in offline. What that record now holds is a
  // verifier for the old password, and `auth:reconcile` retires it on the next
  // reconnect by credential fingerprint — the mechanism built for this.
  invalidateSessionsForUser(input.userId, { reason: 'expired' });

  return { userId: input.userId, username: existing.username, password };
}

// G4 used to live here as `assertAnotherAdminRemains`, whose comment claimed the
// count and the change it guarded were "serialised by the same lock". They were
// not: the count took no lock, the connection runs at READ COMMITTED, and two
// deactivations of two different administrators never met. It now lives in
// `access-guard.repository.ts` behind a real per-tenant lock, and every caller
// asserts after applying its change rather than predicting the effect.

function columnToField(column: string): string {
  return fieldFor(USER_COLUMNS, column);
}
