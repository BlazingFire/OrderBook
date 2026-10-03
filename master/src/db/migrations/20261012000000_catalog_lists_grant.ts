/**
 * `catalog.lists.manage` (1.4 D3): the right to add, rename, reorder and retire
 * the brands, packaging types and grades.
 *
 * Until now those three lists were edited under `fields.manage`. The new key
 * takes over for them, so it is granted to every role that could do it before:
 * the admin and Server Master tiers, plus any role that already holds
 * `fields.manage`. Union, never replace, and idempotent. UPDATE only; no tenant
 * or `deleted_at` filter, for the reason `20260309000000` gives.
 *
 * Key and tiers are inline, never read from `@orderbook/shared`: a migration
 * must not change meaning when a shared constant does.
 */

import type { Knex } from 'knex';

const KEY = 'catalog.lists.manage';
const OLD_KEY = 'fields.manage';
const TIERS = ['admin', 'server_master'];

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

    if (stored.includes(KEY)) continue;
    if (!TIERS.includes(role.tier) && !stored.includes(OLD_KEY)) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify([...stored, KEY].sort()) });
  }
}

export async function down(): Promise<void> {
  // Nothing. Revoking is not the inverse of granting: this migration cannot
  // tell its own grant from one an owner made through the grid.
}
