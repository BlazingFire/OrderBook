/**
 * `storage.backupAll` for the Server Master tier (1.3 Phase 8, migration #7).
 *
 * The key gates the plain-zip backup of everything, its restore, and the daily
 * automatic backup. Its tier ceiling is `server_master`, so only that tier is
 * granted it here. Union, never replace, and idempotent: the same shape and
 * reasoning as `20261004000000_report_indexes_and_grants.ts`, with no tenant or
 * `deleted_at` filter for the reason `20260309000000` gives. UPDATE only.
 *
 * It is also taken off every other role. `20260303000000` seeds Administrator
 * with the live catalogue, so on a fresh install the admin-tier role arrives
 * holding this key above its ceiling: it never takes effect there, but the role
 * editor refuses to save the role back. No other tier can be given the key
 * through the grid, so whatever holds it here came from that seed.
 *
 * The key and the tier are inline, never read from `@orderbook/shared`: a
 * migration must not change meaning when a shared constant does.
 */

import type { Knex } from 'knex';

const NEW_KEYS = ['storage.backupAll'] as const;

const TIER = 'server_master';

interface RoleRow {
  id: string;
  tenant_id: string;
  tier: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const roles = await knex('roles').select<RoleRow[]>('id', 'tenant_id', 'tier', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    let next: string[];
    if (role.tier === TIER) {
      if (NEW_KEYS.every((key) => stored.includes(key))) continue;
      next = [...new Set([...stored, ...NEW_KEYS])].sort();
    } else {
      if (!NEW_KEYS.some((key) => stored.includes(key))) continue;
      next = stored.filter((key) => !(NEW_KEYS as readonly string[]).includes(key)).sort();
    }

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(next) });
  }
}

export async function down(): Promise<void> {
  // Nothing. Revoking is not the inverse of granting: this migration cannot
  // tell its own grant from one an owner made through the grid.
}
