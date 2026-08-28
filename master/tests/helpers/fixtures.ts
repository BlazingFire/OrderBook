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
import { invalidateSettingsCache } from '../../src/services/settings.service.js';
import { resetAuthState } from '../../src/services/auth.service.js';
import { startTestPostgres, stopTestPostgres, testConnectionUrl } from './db.js';

/** Business tables, safe to empty between tests. */
const DATA_TABLES = [
  'activity_log',
  'sync_conflicts',
  'applied_mutations',
  'id_map',
  // The integration tables, children first: every one has a cascading FK, but
  // truncating in dependency order keeps the intent readable.
  'api_connector_runs',
  'api_connector_links',
  'api_connector_field_maps',
  'api_connector_resources',
  'api_connectors',
  'api_key_scopes',
  'api_keys',
  // The PDF Designer's three tables are pure test data — `20260308` seeds
  // nothing, and the renderer's fallback is the in-memory `TEMPLATE_DEFAULTS`.
  // Listed exports-first so the FKs into templates and assets are gone before
  // the tables they point at, rather than relying on CASCADE to sort it out.
  'document_exports',
  'document_templates',
  'document_assets',
  'stock_reservations',
  'stock_movements',
  'inventory_stock',
  'line_item_quantities',
  'line_items',
  'timeline_entries',
  'orders',
  'leads',
  'party_product_variants',
  // Listed before `parties` so the FK is gone first, rather than relying on
  // CASCADE. It is test data in every suite: no migration seeds a grant.
  'party_access',
  'product_images',
  'products',
  'product_categories',
  'parties',
  'office_panels',
  // Before `users` for readability only — the vault carries no foreign key to
  // it, deliberately, so a restored person comes back with their row intact.
  // Both this and `settings` must be listed or every integration suite leaks
  // rows into the next; no migration seeds either, so every row is test data.
  'user_password_vault',
  'users',
  'settings',
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

/**
 * The same treatment for `option_lists` (Stage 3 — Fields): seeded
 * configuration, not `DATA_TABLES`, for the same reason roles are not — a
 * lead needs a source-platform option to exist, and truncating it leaves a
 * database no test can write to.
 *
 * `custom_field_definitions` needs no equivalent set: no migration ever
 * inserts a row into it, so its seeded set is always empty and every row is
 * unconditionally test data — see the self-heal below.
 */
let seededOptionListIds: string[] = [];

/**
 * `pipeline_stages` is never created or deleted by Fields — only renamed,
 * recoloured, reordered, archived and restored — so its "seeded" set is every
 * row, and what must be undone between tests is not row *existence* but the
 * writable columns a Fields test can touch. Captured once, whatever the seed
 * migration currently sets them to, rather than duplicating `LEAD_STAGES`/
 * `ORDER_STAGES` here as a second source of truth.
 */
interface StageSnapshot {
  id: string;
  name: string;
  sequence: number;
  is_default: boolean;
  is_terminal: boolean;
  colour: string | null;
}
let seededStages: StageSnapshot[] = [];

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

  // Self-heal the same way, and for the same reason: `option_lists` and
  // `custom_field_definitions` are not in `DATA_TABLES` and nothing wipes
  // them between test *files* sharing this cluster, so a row a previous
  // file's test created — and never got to clean up past its own last test —
  // would otherwise be captured as "seeded" here and survive every
  // `resetData()` in this file forever. The only rows every migration run
  // against a fresh test database is guaranteed to create are the six
  // `lead.sourcePlatform` values (`20260301`); the other three
  // `FIELD_LIST_KEYS` backfill from tables that are always empty at
  // migration time here, and `custom_field_definitions` seeds nothing at
  // all. Duplicated from the migration deliberately, the same way
  // `['Admin', 'Management', 'Office']` is duplicated just above — a test
  // helper's self-heal list is not the "migration imports a live constant"
  // trap that rule warns about.
  await db().raw(
    `DELETE FROM option_lists
      WHERE NOT (list_key = 'lead.sourcePlatform' AND value = ANY(?))`,
    [['whatsapp', 'call', 'website', 'walk_in', 'referral', 'other']],
  );
  await db()('custom_field_definitions').delete();

  const optionRows = await db()('option_lists').select<Array<{ id: string }>>('id');
  seededOptionListIds = optionRows.map((row) => row.id);

  seededStages = await db()('pipeline_stages').select<StageSnapshot[]>(
    'id',
    'name',
    'sequence',
    'is_default',
    'is_terminal',
    'colour',
  );
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

  // Same rule for the Fields seed: delete what a test created, keep the
  // seeded rows, and clear any soft-delete a Bin test left on a seeded row —
  // otherwise a later test's Bin gate sees a tombstone nothing in that test
  // ever deleted.
  if (seededOptionListIds.length > 0) {
    await db()('option_lists').whereNotIn('id', seededOptionListIds).delete();
    await db()('option_lists')
      .whereIn('id', seededOptionListIds)
      .update({ deleted_at: null, deleted_by: null });
  }
  // Always empty — see the self-heal in `setupDatabase()` above — so every
  // row here is unconditionally test data.
  await db()('custom_field_definitions').delete();

  // Every writable stage column back to its seeded snapshot. `is_default` is
  // cleared for every row first, in the same transaction as the deferred
  // sequence constraint — `idx_pipeline_stages_one_default` is a plain partial
  // index and cannot be deferred, so restoring two swapped defaults with a
  // naive per-row UPDATE would collide exactly like a real reorder would.
  if (seededStages.length > 0) {
    await db().transaction(async (trx) => {
      await trx.raw('SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED');
      await trx('pipeline_stages').update({ is_default: false, is_archived: false });

      for (const stage of seededStages) {
        await trx('pipeline_stages').where({ id: stage.id }).update({
          name: stage.name,
          sequence: stage.sequence,
          is_default: stage.is_default,
          is_terminal: stage.is_terminal,
          colour: stage.colour,
        });
      }
    });
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
  // Joins the other three for the same reason: an in-process cache survives a
  // TRUNCATE, and with `fileParallelism: false` a leaked `true` on the password
  // vault's switch surfaces in an unrelated suite.
  invalidateSettingsCache();
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
