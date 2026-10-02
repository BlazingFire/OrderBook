/**
 * The Server Master tier (docs/plans/1.3-BATCH.md, Phase 2, migration #1).
 *
 * Two changes:
 *
 * 1. `roles.tier` may now hold `'server_master'`, the owner's tier, ranked
 *    above `admin`.
 * 2. Every company gets one reserved system role, "Server Master", at that
 *    tier, holding every permission key. Nobody holds it yet: first-run setup
 *    (or, on an existing install, the master-key setup flow on the Master PC)
 *    creates the two Server Master users.
 *
 * This is the first migration of the 1.3 batch, so every later grant migration
 * in the batch sees the role and must grant to it as well
 * (`master/tests/server-master.integration.test.ts` checks the role still
 * equals `allPermissions()` after all of them).
 *
 * The key list and the tier list are frozen copies, never imported from
 * `@orderbook/shared`: a migration has to do tomorrow exactly what it did the
 * day it shipped. Additive and idempotent: a company that already has a live
 * Server Master role is skipped.
 */

import type { Knex } from 'knex';

/** `allPermissions()` as of 2026-10-01, sorted. */
const SERVER_MASTER_PERMISSIONS = [
  'api.manage',
  'fields.manage',
  'fields.view',
  'inventory.edit',
  'inventory.export',
  'inventory.view',
  'lead.convert',
  'leads.bulk',
  'leads.create',
  'leads.delete',
  'leads.edit',
  'leads.export',
  'leads.view',
  'logs.export',
  'logs.verifyChain',
  'logs.view',
  'orders.bulk',
  'orders.delete',
  'orders.dispatch',
  'orders.edit',
  'orders.export',
  'orders.view',
  'panels.manage',
  'parties.bulk',
  'parties.create',
  'parties.delete',
  'parties.edit',
  'parties.export',
  'parties.view',
  'party.accessAll',
  'party.assign',
  'products.bulk',
  'products.create',
  'products.delete',
  'products.edit',
  'products.export',
  'products.view',
  'record.reassignOwner',
  'recycleBin.view',
  'recycleBin.viewAll',
  'reports.export',
  'reports.view',
  'roles.assign',
  'roles.create',
  'roles.delete',
  'roles.edit',
  'roles.view',
  'settings.manage',
  'stock.adjust',
  'storage.manage',
  'sync.resolveConflicts',
  'users.manage',
  'users.viewPassword',
] as const;

const ROLE_NAME = 'Server Master';
/** Used only when a company already has a live role called "Server Master". */
const FALLBACK_ROLE_NAME = 'Server Master (system)';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_tier_check;
    ALTER TABLE roles ADD CONSTRAINT roles_tier_check
      CHECK (tier IN ('admin', 'management', 'office', 'server_master'));
  `);

  const tenants = await knex('tenants').select<Array<{ id: string }>>('id');

  for (const { id: tenantId } of tenants) {
    const existing = await knex('roles')
      .where({ tenant_id: tenantId, tier: 'server_master' })
      .whereNull('deleted_at')
      .first('id');
    if (existing) continue;

    const nameTaken = await knex('roles')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw('lower(name) = lower(?)', [ROLE_NAME])
      .first('id');

    await knex('roles').insert({
      id: await allocateRoleId(knex, tenantId),
      tenant_id: tenantId,
      name: nameTaken ? FALLBACK_ROLE_NAME : ROLE_NAME,
      tier: 'server_master',
      permissions: JSON.stringify(SERVER_MASTER_PERMISSIONS),
      is_system: true,
      created_by: null,
      hlc: null,
      field_hlc: JSON.stringify({}),
    });
  }
}

export async function down(): Promise<void> {
  // Deliberately empty. Narrowing the CHECK again would fail on the seeded
  // role, and removing a role users may hold is not a rollback anyone wants.
  // Restore from a backup instead.
}

/**
 * The next `RL` + ten digits id from `id_sequences`, the same format as
 * `allocatePermanentId`. A company with no counter row yet starts one past the
 * highest role id it already has, so the new id can never collide.
 */
async function allocateRoleId(knex: Knex, tenantId: string): Promise<string> {
  await knex.raw(
    `INSERT INTO id_sequences (tenant_id, entity, next_value)
       SELECT ?::uuid, 'role', COALESCE(MAX(substring(id from 3)::bigint), 0) + 1
         FROM roles WHERE tenant_id = ? AND id ~ '^RL[0-9]{10}$'
     ON CONFLICT (tenant_id, entity) DO NOTHING`,
    [tenantId, tenantId],
  );

  const { rows } = await knex.raw<{ rows: Array<{ value: string }> }>(
    `UPDATE id_sequences SET next_value = next_value + 1
      WHERE tenant_id = ? AND entity = 'role'
      RETURNING next_value - 1 AS value`,
    [tenantId],
  );

  return `RL${String(rows[0]?.value ?? '').padStart(10, '0')}`;
}
