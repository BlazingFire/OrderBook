/**
 * Shared setup for integration suites: migrate once, then truncate between
 * tests so each starts from a known-empty database without paying for a fresh
 * migration run every time.
 *
 * Truncating now has to preserve the rows the migrations *seeded* — the tenant,
 * its roles and permissions, the pipelines, the option lists and the id
 * counters. Those are configuration, not test data; wiping them would leave a
 * database no code path can write to, since every record needs a tenant and a
 * stage.
 */

import type { PermissionSet } from '@orderbook/shared';
import { PERMISSIONS } from '@orderbook/shared';

import { closeDatabase, db, initDatabase, runMigrations } from '../../src/db/knex.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { invalidateFieldCache } from '../../src/repositories/custom-field.repository.js';
import { invalidatePipelineCache } from '../../src/repositories/pipeline.repository.js';
import { invalidateRoleCache } from '../../src/repositories/role.repository.js';
import { resetAuthState } from '../../src/services/auth.service.js';
import { startTestPostgres, stopTestPostgres, testConnectionUrl } from './db.js';

/** Business tables, safe to empty between tests. */
const DATA_TABLES = [
  'activity_log',
  'sync_conflicts',
  'applied_mutations',
  'id_map',
  'stock_reservations',
  'stock_movements',
  'inventory_stock',
  'line_item_quantities',
  'line_items',
  'timeline_entries',
  'orders',
  'leads',
  'party_product_variants',
  'product_images',
  'products',
  'product_categories',
  'parties',
  'office_panels',
  'users',
  'master_config',
];

/**
 * The roles the migrations seeded, captured once.
 *
 * Roles are configuration and survive the truncate — but a role a *test*
 * created is test data and must not leak into the next one, or the second test
 * to create a "Dispatch" role fails on a duplicate name it never made.
 */
let seededRoleIds: string[] = [];

export async function setupDatabase(): Promise<void> {
  await startTestPostgres();
  initDatabase(testConnectionUrl());
  await runMigrations();

  // Self-healing: a previous crashed run can leave test-created roles behind,
  // and capturing those as "seeded" would make them immortal. The migration
  // seeds exactly three, named for their tiers, so anything else is debris.
  await db()('roles').whereNotIn('name', ['Admin', 'Management', 'Office']).delete();

  const rows = await db()('roles').select<Array<{ id: string }>>('id');
  seededRoleIds = rows.map((row) => row.id);
}

export async function teardownDatabase(): Promise<void> {
  await closeDatabase();
  await stopTestPostgres();
}

export async function resetData(): Promise<void> {
  await db().raw(`TRUNCATE TABLE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  await db().raw(`
    ALTER SEQUENCE party_code_seq RESTART WITH 1;
    ALTER SEQUENCE product_code_seq RESTART WITH 1;
  `);

  // Permanent ids are handed out from a table, not a sequence, so RESTART
  // IDENTITY does not touch them — every suite would otherwise start numbering
  // wherever the previous one stopped.
  await db()('id_sequences').update({ next_value: 1 });

  // Anything a test created goes; the seeded roles stay.
  if (seededRoleIds.length > 0) {
    await db()('roles').whereNotIn('id', seededRoleIds).delete();
  }

  // Roles are seeded configuration and survive the truncate, so their counter
  // must resume *past* them. Resetting it to 1 would hand a test-created role
  // the id an existing seeded role already holds.
  await db().raw(`
    UPDATE id_sequences s
       SET next_value = COALESCE((
             SELECT MAX(substring(r.id from 3)::bigint) + 1
               FROM roles r
              WHERE r.tenant_id = s.tenant_id
                AND r.id ~ '^RL[0-9]{10}$'
           ), 1)
     WHERE s.entity = 'role';
  `);
  await db()('master_clock').update({ physical: 0, counter: 0 });

  // These caches outlive a truncate; a stale role would let a later test pass
  // with permissions the database no longer grants.
  invalidateRoleCache();
  invalidatePipelineCache();
  invalidateFieldCache();
  resetAuthState();
}

/** The tenant the migrations seeded. Every test acts inside it. */
export async function testTenantId(): Promise<string> {
  const row = await db()('tenants').orderBy('created_at').first<{ id: string }>('id');
  if (!row) throw new Error('No seeded tenant — the tenancy migration did not run');
  return row.id;
}

export async function stageIdByName(kind: 'lead' | 'order', name: string): Promise<string> {
  const row = await db()('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where({ 'p.kind': kind, 's.name': name })
    .first<{ id: string }>('s.id');

  if (!row) throw new Error(`No ${kind} stage named "${name}"`);
  return row.id;
}

/** Everything granted — the default for tests not about permissions. */
export const ALL_PERMISSIONS: PermissionSet = {
  roleId: null,
  roleName: 'Test',
  tier: 'admin',
  permissions: PERMISSIONS,
};

export async function testActor(
  overrides: Partial<ActorContext> = {},
): Promise<ActorContext> {
  return {
    tenantId: await testTenantId(),
    actorType: 'user',
    actorId: null,
    userId: null,
    permissions: ALL_PERMISSIONS,
    deviceCode: null,
    actorName: 'Test Actor',
    ...overrides,
  };
}

/** An actor holding only the named permissions, for the access-control tests. */
export async function actorWith(
  permissions: PermissionSet['permissions'],
): Promise<ActorContext> {
  return testActor({
    permissions: { roleId: null, roleName: 'Limited', tier: 'office', permissions },
  });
}
