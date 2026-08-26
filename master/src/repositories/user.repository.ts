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
/**
 * Every user column except the credential, named explicitly.
 *
 * `u.*` worked — `mapUser` strips `password_hash` and the `User` type does not
 * declare it, so nothing leaked — but it read the column out of Postgres and
 * into this process on every list and every lookup, which breaks §11's rule that
 * the credential read is the *only* place the column is selected. That rule is
 * worth keeping literally true: it is greppable, and blast radius you have not
 * spent is the cheapest kind.
 */
const USER_COLUMNS = [
  'u.tenant_id',
  'u.id',
  'u.username',
  'u.display_name',
  'u.role_id',
  'u.is_active',
  'u.last_sign_in_at',
  'u.avatar_id',
  'u.avatar_blurhash',
  'u.avatar_size',
  'u.avatar_byte_size',
  'u.avatar_uploaded_at',
  'u.created_by',
  'u.created_at',
  'u.updated_by',
  'u.updated_at',
  'u.deleted_at',
  'u.deleted_by',
  'u.version',
  'u.hlc',
  'u.field_hlc',
  'u.temporary_id',
] as const;

function baseQuery(runner: Runner = db()) {
  return runner(`${TABLE} as u`)
    .leftJoin('roles as r', 'r.id', 'u.role_id')
    .select(...USER_COLUMNS, 'r.name as role_name', 'r.tier as role_tier');
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

export interface CredentialRow {
  id: string;
  tenantId: string;
  passwordHash: string;
  isActive: boolean;
  roleId: string | null;
}

/**
 * The **only** place `password_hash` is selected.
 *
 * A grep for this function name must return exactly one call site, forever. If
 * it ever returns two, one of them is a leak.
 *
 * It briefly returned two: `changeOwnPassword` used it to re-read by username
 * when it already held the person's id. Neither call leaked — both fed
 * `verifyPassword` and nothing escaped the auth service — but a rule that is
 * stated as greppable and is not actually true stops being a check at all, and
 * the *next* addition would have been just as quiet. Verifying by id goes
 * through `readCredentialById` below, which shares this one query.
 */
export async function readCredentialForVerification(
  username: string,
  runner: Runner = db(),
): Promise<CredentialRow | null> {
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

/**
 * Verify-by-id, for somebody changing their *own* password.
 *
 * Routed through the one credential query above rather than adding a second
 * `password_hash` select, so the greppable invariant stays literally true. The
 * username lookup is not a second read of the column: it is the same read.
 */
export async function readCredentialById(
  tenantId: string,
  userId: string,
  runner: Runner = db(),
): Promise<CredentialRow | null> {
  const user = await findById(tenantId, userId, {}, runner);
  if (!user) return null;

  const credential = await readCredentialForVerification(user.username, runner);

  // Guards against a same-username row in another company answering for this
  // one, which the missing tenant predicate on the lookup would otherwise allow.
  return credential && credential.id === userId ? credential : null;
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
  renameTo?: string,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      deleted_at: null,
      deleted_by: null,
      ...(renameTo ? { username: renameTo } : {}),
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

// Guard G4's read lives in `access-guard.repository.ts`. It used to be a
// `countOtherActiveAdmins` here, which was insufficient twice over: it took no
// lock, so two deactivations of two different administrators both passed; and it
// counted administrators without asking whether they could still *do* anything,
// so stripping `users.manage` from the only admin role walked straight past it.

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
