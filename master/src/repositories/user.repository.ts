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

import type { AssignablePerson, Permission, RoleTier, User } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { allocatePermanentId } from './identity.repository.js';
import { mapUser } from './mappers.js';
import { permissionSetFromRow, type RolePermissionRow } from './role.repository.js';
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

/**
 * The people a pending order can be raised for or handed to (the Owner
 * picker): active and not deleted, by name. A deactivated account is left out,
 * because an order owned by somebody who cannot sign in is nobody's.
 */
export async function listOwnerChoices(
  tenantId: string,
  runner: Runner = db(),
): Promise<AssignablePerson[]> {
  const rows = await baseQuery(runner)
    .where({ 'u.tenant_id': tenantId, 'u.is_active': true })
    .whereNull('u.deleted_at')
    .orderBy([{ column: 'u.display_name' }, { column: 'u.id' }]);

  return rows.map(mapUser).map((user) => ({
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    roleName: user.roleName,
    roleTier: user.roleTier,
    avatar: user.avatar,
  }));
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
 * A user and the role row that decides what they may do, in **one** query.
 *
 * Three queries used to answer this on every HTTP request, every socket
 * connect, and once per admin socket per dashboard flush: the user, then the
 * role for its permissions, then the same role again for its version. Two of
 * the three read the same row.
 *
 * Written as its own query rather than by extending `baseQuery`, and both
 * halves of that matter. `baseQuery` joins `roles` on id alone; the tenant
 * predicate here is the one `permissionSetForRole` documents as mandatory
 * (matching on id alone is safety from a schema quirk, not from the query).
 * And adding these columns to `baseQuery` would put every role's full
 * permission array into every row of `listUsers` — exactly the blast radius
 * `USER_COLUMNS` exists to avoid.
 */
export async function findByIdWithRole(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<{ user: User; role: RolePermissionRow | null } | null> {
  const row = await runner(`${TABLE} as u`)
    .leftJoin('roles as r', function join() {
      this.on('r.id', '=', 'u.role_id').andOn('r.tenant_id', '=', 'u.tenant_id');
    })
    .where({ 'u.tenant_id': tenantId, 'u.id': id })
    .whereNull('u.deleted_at')
    .first(
      ...USER_COLUMNS,
      'r.name as role_name',
      'r.tier as role_tier',
      'r.permissions as role_permissions',
      'r.version as role_version',
      'r.deleted_at as role_deleted_at',
    );

  if (!row) return null;

  const raw = row as Record<string, unknown>;

  // `role: null` for a deleted role reproduces `permissionSetForRole`'s
  // `whereNull('deleted_at')` exactly — a user whose role is in the Recycle Bin
  // resolves to no permissions, and their session is dropped rather than
  // silently continuing on the old set.
  const role =
    raw.role_id && raw.role_deleted_at === null
      ? {
          id: String(raw.role_id),
          name: String(raw.role_name ?? ''),
          tier: (raw.role_tier as RolePermissionRow['tier']) ?? 'office',
          permissions: raw.role_permissions,
          version: Number(raw.role_version ?? 0),
        }
      : null;

  return { user: mapUser(row as never), role };
}

/**
 * The active, undeleted people whose role currently grants `permission`, for
 * addressing a notification ("everyone who manages panels"). Resolved through
 * `permissionSetFromRow`, so the tier ceiling applies exactly as at sign-in.
 */
export async function findActiveUserIdsWithPermission(
  tenantId: string,
  permission: Permission,
  runner: Runner = db(),
): Promise<string[]> {
  const rows = await runner(`${TABLE} as u`)
    .join('roles as r', function join() {
      this.on('r.id', '=', 'u.role_id').andOn('r.tenant_id', '=', 'u.tenant_id');
    })
    .where({ 'u.tenant_id': tenantId, 'u.is_active': true })
    .whereNull('u.deleted_at')
    .whereNull('r.deleted_at')
    .orderBy('u.id')
    .select<
      { id: string; role_id: string; name: string; tier: RoleTier; permissions: unknown; version: number }[]
    >('u.id', 'u.role_id', 'r.name', 'r.tier', 'r.permissions', 'r.version');

  return rows
    .filter((row) =>
      permissionSetFromRow(tenantId, {
        id: row.role_id,
        name: row.name,
        tier: row.tier,
        permissions: row.permissions,
        version: Number(row.version),
      }).permissions.includes(permission),
    )
    .map((row) => row.id);
}

/** Every active person in a tenant, for a notice that is for everybody. */
export async function findAllActiveUserIds(tenantId: string, runner: Runner = db()): Promise<string[]> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, is_active: true })
    .whereNull('deleted_at')
    .orderBy('id')
    .select<{ id: string }[]>('id');
  return rows.map((row) => row.id);
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
