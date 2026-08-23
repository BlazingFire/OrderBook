/**
 * Users (docs/ROLES_AND_USERS.md §4, §11, §12).
 *
 * Two rules this file exists to enforce structurally rather than by discipline:
 *
 *  - **`password_hash` leaves through exactly one function.** `mapUser` strips
 *    it and the `User` type does not declare it, so no other read path can
 *    return it even by accident.
 *  - **`role_id` is not a SQL foreign key.** A mutation creating a user can
 *    arrive before the one creating its role, and a hard FK would reject the
 *    write and break idempotent replay. A restored role must also reattach to
 *    the users still pointing at it, which `ON DELETE` semantics fight.
 *    Referential integrity lives in the service guards instead (§4.1).
 */

import type { RoleTier, User } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { allocatePermanentId } from './identity.repository.js';
import { mapUser } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'users';

type Runner = Knex | Knex.Transaction;

/** Joined to the role so a user always carries the tier and name it holds. */
function baseQuery(runner: Runner = db()) {
  return runner(`${TABLE} as u`)
    .leftJoin('roles as r', 'r.id', 'u.role_id')
    .select('u.*', 'r.name as role_name', 'r.tier as role_tier');
}

export async function listUsers(
  tenantId: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<User[]> {
  const query = baseQuery(runner).where('u.tenant_id', tenantId);
  if (!options.includeDeleted) query.whereNull('u.deleted_at');

  // Creation order, from the monotonic id — see the role repository.
  const rows = await query.orderBy('u.id');
  return rows.map(mapUser);
}

export async function listDeletedUsers(
  tenantId: string,
  runner: Runner = db(),
): Promise<User[]> {
  const rows = await baseQuery(runner)
    .where('u.tenant_id', tenantId)
    .whereNotNull('u.deleted_at')
    .orderBy('u.deleted_at', 'desc');

  return rows.map(mapUser);
}

export async function findById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<User | null> {
  const query = baseQuery(runner).where({ 'u.tenant_id': tenantId, 'u.id': id });
  if (!options.includeDeleted) query.whereNull('u.deleted_at');

  const row = await query.first();
  return row ? mapUser(row) : null;
}

/**
 * The **only** place `password_hash` is selected.
 *
 * A grep for this function name must return exactly one call site, forever. If
 * it ever returns two, one of them is a leak.
 */
export async function readCredentialForVerification(
  username: string,
  runner: Runner = db(),
): Promise<{
  id: string;
  tenantId: string;
  passwordHash: string;
  isActive: boolean;
  roleId: string | null;
} | null> {
  const row = await runner(TABLE)
    .whereRaw('lower(username) = lower(?)', [username])
    .whereNull('deleted_at')
    .first<
      | {
          id: string;
          tenant_id: string;
          password_hash: string;
          is_active: boolean;
          role_id: string | null;
        }
      | undefined
    >('id', 'tenant_id', 'password_hash', 'is_active', 'role_id');

  if (!row) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    passwordHash: row.password_hash,
    isActive: Boolean(row.is_active),
    roleId: row.role_id,
  };
}

export interface NewUser {
  tenantId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  roleId: string | null;
  createdBy: string | null;
  hlc: string;
  fieldHlc: Record<string, string>;
  temporaryId?: string | null;
  id?: string;
}

export async function insertUser(user: NewUser, trx: TransactionContext): Promise<string> {
  const id = user.id ?? (await allocatePermanentId(user.tenantId, 'user', trx));

  await trx(TABLE).insert({
    id,
    tenant_id: user.tenantId,
    username: user.username,
    display_name: user.displayName,
    password_hash: user.passwordHash,
    role_id: user.roleId,
    is_active: true,
    created_by: user.createdBy,
    hlc: user.hlc,
    field_hlc: JSON.stringify(user.fieldHlc),
    temporary_id: user.temporaryId ?? null,
  });

  return id;
}

export async function updateUserColumns(
  tenantId: string,
  id: string,
  patch: Record<string, unknown>,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...patch,
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
}

export async function softDeleteUser(
  tenantId: string,
  id: string,
  actorId: string | null,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id }).update({
    deleted_at: trx.fn.now(),
    deleted_by: actorId,
    version: trx.raw('version + 1'),
    updated_at: trx.fn.now(),
  });
}

export async function restoreUser(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id }).update({
    deleted_at: null,
    deleted_by: null,
    version: trx.raw('version + 1'),
    updated_at: trx.fn.now(),
  });
}

/** Guard G7 — username availability among live rows. */
export async function isUsernameTaken(
  tenantId: string,
  username: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<boolean> {
  const query = runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw('lower(username) = lower(?)', [username]);

  if (excludeId) query.whereNot({ id: excludeId });

  return (await query.first('id')) !== undefined;
}

/**
 * Guard G4 — how many active administrators would remain.
 *
 * Must be called with the transaction that is performing the change, never
 * before it. Checked outside, two concurrent deactivations each see one
 * remaining admin and both succeed — and the company is locked out of its own
 * software, which is unrecoverable without vendor intervention.
 */
export async function countOtherActiveAdmins(
  tenantId: string,
  excludeUserId: string,
  trx: TransactionContext,
): Promise<number> {
  const rows = await trx('users as u')
    .join('roles as r', function join() {
      this.on('r.id', '=', 'u.role_id').andOn('r.tenant_id', '=', 'u.tenant_id');
    })
    .where('u.tenant_id', tenantId)
    .whereNull('u.deleted_at')
    .andWhere('u.is_active', true)
    .whereNull('r.deleted_at')
    .andWhere('r.tier', 'admin')
    .whereNot('u.id', excludeUserId)
    .count<Array<{ count: string }>>('u.id as count');

  return Number(rows[0]?.count ?? 0);
}

export async function touchLastSignIn(userId: string, trx: TransactionContext): Promise<void> {
  await trx(TABLE).where({ id: userId }).update({ last_sign_in_at: trx.fn.now() });
}

export async function roleIdForTier(
  tenantId: string,
  tier: RoleTier,
  runner: Runner = db(),
): Promise<string | null> {
  const row = await runner('roles')
    .where({ tenant_id: tenantId, tier })
    .whereNull('deleted_at')
    .orderBy('id')
    .first<{ id: string } | undefined>('id');

  return row?.id ?? null;
}

export async function countUsers(tenantId: string, runner: Runner = db()): Promise<number> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .count<Array<{ count: string }>>('id as count');

  return Number(rows[0]?.count ?? 0);
}
