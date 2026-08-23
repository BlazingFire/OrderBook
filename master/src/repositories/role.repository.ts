/**
 * Roles and the permission sets they grant (docs/LEAD_GENERATION_FLOW.md §1).
 *
 * The check reads `role_permissions` rather than the role's tier name, so an
 * admin who re-grants a role gets the behaviour they asked for instead of the
 * behaviour the seed happened to give it.
 *
 * Cached per role and invalidated on write. Every authenticated request resolves
 * a permission set, so an uncached read would put two queries in front of every
 * single call.
 */

import type { Permission, PermissionSet, Role } from '@orderbook/shared';
import { isPermission } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapRole } from './mappers.js';

type Runner = Knex | Knex.Transaction;

const cache = new Map<string, PermissionSet>();

export function invalidateRoleCache(roleId?: string): void {
  if (roleId) cache.delete(roleId);
  else cache.clear();
}

export async function listRoles(tenantId: string, runner: Runner = db()): Promise<Role[]> {
  const roleRows = await runner('roles').where({ tenant_id: tenantId }).orderBy('name').select('*');

  const permissionRows = await runner('role_permissions as rp')
    .join('roles as r', 'r.id', 'rp.role_id')
    .where('r.tenant_id', tenantId)
    .select<Array<{ role_id: string; permission: string }>>('rp.role_id', 'rp.permission');

  const byRole = new Map<string, string[]>();
  for (const row of permissionRows) {
    const bucket = byRole.get(row.role_id);
    if (bucket) bucket.push(row.permission);
    else byRole.set(row.role_id, [row.permission]);
  }

  return roleRows.map((row) => mapRole(row, byRole.get(String(row.id)) ?? []));
}

export async function permissionSetForRole(
  roleId: string | null,
  runner: Runner = db(),
): Promise<PermissionSet | null> {
  if (!roleId) return null;

  const cached = cache.get(roleId);
  if (cached) return cached;

  const role = await runner('roles').where({ id: roleId }).first();
  if (!role) return null;

  const rows = await runner('role_permissions')
    .where({ role_id: roleId })
    .select<Array<{ permission: string }>>('permission');

  const set: PermissionSet = {
    roleId,
    roleName: String(role.name),
    tier: role.tier as PermissionSet['tier'],
    // Filtered through the shared catalogue: a permission left in the database
    // after being removed from the code must not keep granting access.
    permissions: rows.map((row) => row.permission).filter(isPermission) as Permission[],
  };

  cache.set(roleId, set);
  return set;
}

export async function setRolePermissions(
  roleId: string,
  permissions: Permission[],
  trx: Knex.Transaction,
): Promise<void> {
  await trx('role_permissions').where({ role_id: roleId }).delete();

  if (permissions.length > 0) {
    await trx('role_permissions').insert(
      permissions.map((permission) => ({ role_id: roleId, permission })),
    );
  }

  invalidateRoleCache(roleId);
}
