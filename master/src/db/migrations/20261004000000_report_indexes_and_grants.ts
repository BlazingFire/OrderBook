/**
 * Reports for the Office and Management tiers (1.3 H2).
 *
 * Two things, both additive and both safe to run twice.
 *
 * **Indexes.** The reports now ask for one person's records, so each of the
 * three tables they read by owner gets the index that serves it. The two on
 * `leads` and `orders` close an old gap: `20260303000000_roles_and_users`
 * re-created every `users(id)` column as TEXT and took `idx_leads_owner` and
 * `idx_orders_owner` with it (`docs/schema/03-leads-orders-inventory.md`); the
 * ones here carry the date as their second column, because that is how a
 * report filters.
 *
 * **The grant.** `reports.view` and `reports.export` go to every role of the
 * office and management tiers, so Reports works out of the box for the people
 * the owner asked it for. Union, never replace, and idempotent — the same
 * shape and reasoning as `20260309000000_new_module_permission_grant.ts`. A
 * company that does not want them has two switches for it
 * (`reports.visibleToOffice` / `reports.visibleToManagement`, enforced by the
 * Master on every request) and an administrator can still untick the keys on
 * one role. No tenant filter and no `deleted_at` filter, for the reason that
 * migration gives: a soft-deleted role that is restored later should come back
 * holding what its siblings hold.
 *
 * The key list and the tier names are inline, never read from
 * `@orderbook/shared`: a migration must not change meaning when a shared
 * constant does.
 */

import type { Knex } from 'knex';

const NEW_KEYS = ['reports.view', 'reports.export'] as const;

const TIERS = ['office', 'management'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_leads_owner_created ON leads (tenant_id, owner_id, created_at) WHERE deleted_at IS NULL`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_orders_owner_dispatched ON orders (tenant_id, owner_id, dispatched_at)
       WHERE dispatched_at IS NOT NULL AND deleted_at IS NULL`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_activity_log_actor_created ON activity_log (tenant_id, actor_id, created_at)`,
  );

  const roles = await knex('roles')
    .whereIn('tier', [...TIERS])
    .select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // "Already holds every new key", never a length comparison — see
    // `20260309`'s comment for why a length test is unsafe against a JSONB
    // array that duplicate-sync can pad.
    if (NEW_KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...NEW_KEYS])].sort();

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(knex: Knex): Promise<void> {
  // The indexes only. Revoking the keys is not the inverse of granting them:
  // an administrator may since have handed them to other roles through the
  // grid, and this migration cannot tell its own grant from theirs.
  await knex.raw('DROP INDEX IF EXISTS idx_leads_owner_created');
  await knex.raw('DROP INDEX IF EXISTS idx_orders_owner_dispatched');
  await knex.raw('DROP INDEX IF EXISTS idx_activity_log_actor_created');
}
