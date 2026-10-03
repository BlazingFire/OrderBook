/**
 * `print.send` for Office and Management roles (1.4 D4, R9).
 *
 * `20261006000000_printroom` granted the print keys to the `admin` and
 * `server_master` tiers only, so an Office or Management user never saw the
 * Printroom in the sidebar or on Basic Home. Sending a note to the printer PC
 * is everyday office work; running a printroom (`print.station`) stays an
 * explicit grant.
 *
 * Union, never replace, and idempotent: the shape of
 * `20261004000000_report_indexes_and_grants.ts`, with no tenant or
 * `deleted_at` filter for the reason `20260309000000` gives. UPDATE only. The
 * key and the tiers are inline, never read from `@orderbook/shared`: a
 * migration must not change meaning when a shared constant does.
 */

import type { Knex } from 'knex';

const KEYS = ['print.send'] as const;
const TIERS = ['office', 'management'] as const;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const roles = await knex('roles').whereIn('tier', [...TIERS]).select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    // "Already holds every key", never a length comparison: see `20260309`.
    if (KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...KEYS])].sort();
    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(): Promise<void> {
  // Nothing. Revoking is not the inverse of granting: this migration cannot
  // tell its own grant from one an owner made through the grid.
}
