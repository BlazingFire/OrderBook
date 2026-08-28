/**
 * Roles (docs/ROLES_AND_USERS.md §3, §11).
 *
 * The permission set is one JSONB array on the row, not a join table. That is a
 * deliberate trade: reads become a single seek, an edit becomes one field-level
 * mutation, and — the reason that actually decides it — two concurrent offline
 * edits merge as whole sets rather than being unioned key by key. A union grants
 * a combination neither administrator approved (§5).
 *
 * Every query leads with `tenant_id`, so one that forgets the tenant filter
 * degrades into a visibly wrong full scan rather than a silent cross-company leak.
 */

import type { Permission, PermissionSet, Role, RoleTier } from '@orderbook/shared';
import { effectivePermissions, isPermission } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { allocatePermanentId } from './identity.repository.js';
import { mapRole } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'roles';

type Runner = Knex | Knex.Transaction;

/**
 * Cached per role and invalidated on write.
 *
 * Deliberately **not** time-based. A TTL means a permission revoked by an
 * administrator keeps working for the length of the TTL, which is precisely the
 * failure the "takes effect on the next call" rule exists to prevent. The cache
 * is keyed on the role's `version`, so a version change is an eviction.
 */
const cache = new Map<string, { version: number; set: PermissionSet }>();

export function invalidateRoleCache(roleId?: string): void {
  if (roleId) cache.delete(roleId);
  else cache.clear();
}

/** Live roles with the number of live users holding each. */
export async function listRoles(tenantId: string, runner: Runner = db()): Promise<Role[]> {
  const rows = await runner(`${TABLE} as r`)
    .where('r.tenant_id', tenantId)
    .whereNull('r.deleted_at')
    .select(
      'r.*',
      runner.raw(
        `(SELECT COUNT(*) FROM users u
           WHERE u.tenant_id = r.tenant_id
             AND u.role_id   = r.id
             AND u.deleted_at IS NULL) AS user_count`,
      ),
    )
    // Zero-padded ids are lexicographically monotonic, so this *is* creation
    // order — no separate sort key and no ORDER BY created_at.
    .orderBy('r.id');

  return rows.map(mapRole);
}

export async function findRoleById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<Role | null> {
  const query = runner(`${TABLE} as r`).where({ 'r.tenant_id': tenantId, 'r.id': id });
  if (!options.includeDeleted) query.whereNull('r.deleted_at');

  const row = await query
    .select(
      'r.*',
      runner.raw(
        `(SELECT COUNT(*) FROM users u
           WHERE u.tenant_id = r.tenant_id
             AND u.role_id   = r.id
             AND u.deleted_at IS NULL) AS user_count`,
      ),
    )
    .first();

  return row ? mapRole(row) : null;
}

export async function listDeletedRoles(
  tenantId: string,
  runner: Runner = db(),
): Promise<Role[]> {
  const rows = await runner(`${TABLE} as r`)
    .where('r.tenant_id', tenantId)
    .whereNotNull('r.deleted_at')
    .select('r.*', runner.raw('0 AS user_count'))
    .orderBy('r.deleted_at', 'desc');

  return rows.map(mapRole);
}

/**
 * The hot path: resolve what a role may exercise, once per request.
 *
 * One primary-key seek. The tier intersection happens here as well as on save,
 * so a role row that arrived over sync from a tampered replica carrying an
 * admin key on an office tier is stripped before it can reach a session.
 */
export async function permissionSetForRole(
  tenantId: string,
  roleId: string | null,
  runner: Runner = db(),
): Promise<PermissionSet | null> {
  if (!roleId) return null;

  // Tenant-scoped, like every other query in this file claims to be. It used to
  // match on `id` alone, which is safe only by accident: the primary key is a
  // single column and per-tenant id sequences make a second company
  // uncreatable, so no two rows can collide *today*. That is safety from a
  // schema quirk rather than from the query, and the quirk is itself an open
  // question (`docs/ROLES_AND_USERS.md` §16).
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, id: roleId })
    .whereNull('deleted_at')
    .first<
      { id: string; name: string; tier: RoleTier; permissions: string[]; version: number } | undefined
    >('id', 'name', 'tier', 'permissions', 'version');

  if (!row) {
    cache.delete(`${tenantId}:${roleId}`);
    return null;
  }

  return permissionSetFromRow(tenantId, row);
}

/** The row shape `permissionSetFromRow` needs, whoever selected it. */
export interface RolePermissionRow {
  id: string;
  name: string;
  tier: RoleTier;
  permissions: unknown;
  version: number;
}

/**
 * Turn an already-read role row into a permission set, through the same cache.
 *
 * Extracted so a caller that has *already* joined the role — `findByIdWithRole`,
 * which collapses a request's three auth queries into one — does not have to
 * re-read the row just to get the tier intersection applied. This is the single
 * place that intersection happens, and it must stay that way: it is what strips
 * an admin key off an office-tier role that arrived over sync from a tampered
 * replica.
 */
export function permissionSetFromRow(tenantId: string, row: RolePermissionRow): PermissionSet {
  const cacheKey = `${tenantId}:${row.id}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.version === row.version) return cached.set;

  const stored = Array.isArray(row.permissions) ? (row.permissions as unknown[]) : [];
  const set: PermissionSet = {
    roleId: row.id,
    roleName: row.name,
    tier: row.tier,
    // Filtered through the frozen catalogue *and* the tier ceiling: a key left
    // in the database after being removed from the code must not keep granting.
    permissions: effectivePermissions(stored.filter(isPermission), row.tier),
  };

  cache.set(cacheKey, { version: row.version, set });
  return set;
}

/** The role's version, for the per-call staleness check. */
export async function roleVersion(
  tenantId: string,
  roleId: string,
  runner: Runner = db(),
): Promise<number | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, id: roleId })
    .whereNull('deleted_at')
    .first<{ version: number } | undefined>('version');

  return row?.version ?? null;
}

export interface NewRole {
  tenantId: string;
  name: string;
  tier: RoleTier;
  permissions: Permission[];
  isSystem?: boolean;
  createdBy: string | null;
  hlc: string;
  fieldHlc: Record<string, string>;
  temporaryId?: string | null;
  id?: string;
}

export async function insertRole(role: NewRole, trx: TransactionContext): Promise<string> {
  const id = role.id ?? (await allocatePermanentId(role.tenantId, 'role', trx));

  await trx(TABLE).insert({
    id,
    tenant_id: role.tenantId,
    name: role.name,
    tier: role.tier,
    permissions: JSON.stringify([...role.permissions].sort()),
    is_system: role.isSystem ?? false,
    created_by: role.createdBy,
    hlc: role.hlc,
    field_hlc: JSON.stringify(role.fieldHlc),
    temporary_id: role.temporaryId ?? null,
  });

  return id;
}

export async function updateRoleColumns(
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

  invalidateRoleCache(id);
}

export async function softDeleteRole(
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

  invalidateRoleCache(id);
}

export async function restoreRole(
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
      ...(renameTo ? { name: renameTo } : {}),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });

  invalidateRoleCache(id);
}

/** Guard G5 — is this role held by anyone live? */
export async function isRoleInUse(
  tenantId: string,
  roleId: string,
  runner: Runner = db(),
): Promise<boolean> {
  const row = await runner('users')
    .where({ tenant_id: tenantId, role_id: roleId })
    .whereNull('deleted_at')
    .first('id');

  return row !== undefined;
}

/** Name availability among live rows, case-insensitively. */
export async function isNameTaken(
  tenantId: string,
  name: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<boolean> {
  const query = runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw('lower(name) = lower(?)', [name]);

  if (excludeId) query.whereNot({ id: excludeId });

  return (await query.first('id')) !== undefined;
}
