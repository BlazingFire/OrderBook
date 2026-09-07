/**
 * Grant `products.bulk` to administrator-tier roles.
 *
 * `products.bulk` was declared in the frozen permission catalogue and given a
 * tier ceiling (`20260304000000_role_tier_ceiling_repair.ts:52`, management)
 * from the start, but no migration ever *granted* it to a stored role — the
 * `20260303` remap that turned `parties.manage`/`inventory.manage` into their
 * split successors had no entry for it, and `20260309`'s grant list predates
 * the bulk-import feature that finally enforces it
 * (`master/src/services/product-import.service.ts`). The result: every
 * existing installation's Administrator role has no `products.bulk` in its
 * stored `permissions` array, so the Import button never renders
 * (`office/web/src/App.tsx`'s `can('products.bulk')`) even though the feature
 * behind it now exists and enforces the key correctly.
 *
 * Union, not replace, and administrator tier only — same shape and same
 * reasoning as `20260309000000_new_module_permission_grant.ts`: handing every
 * existing role a new capability is exactly what the no-wildcard rule in
 * `shared/src/domain/permissions.ts` exists to prevent. A management-tier
 * role that wants to run imports receives the key from an administrator who
 * ticks it in the grid, deliberately.
 *
 * No tenant filter and no `deleted_at` filter, for the same reason
 * `20260309` has none: every administrator role, including soft-deleted ones
 * that can be restored later, should come back holding this key.
 */

import type { Knex } from 'knex';

const NEW_KEYS = ['products.bulk'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const roles = await knex('roles')
    .where('tier', 'admin')
    .select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // The no-op test is "already holds every new key", never a length
    // comparison — see `20260309`'s comment for why a length test is unsafe
    // against a JSONB array that duplicate-sync can pad.
    if (NEW_KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...NEW_KEYS])].sort();

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(): Promise<void> {
  // Deliberately empty — see `20260309`'s `down` for why revoking is not the
  // inverse of granting: an administrator may since have handed this key to
  // other roles through the grid, and this migration cannot tell its own
  // grant from theirs.
}
