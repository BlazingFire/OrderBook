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

/**
 * Same idea as `seededRoleIds`, for `option_lists` and
 * `custom_field_definitions` (Stage 3): both are configuration that survives
 * the truncate, so a value or definition a *test* creates must not leak into
 * the next one — otherwise the second test to add "Sea Green" to
 * `stock.colour` fails on a duplicate it never made.
 */
let seededOptionListIds: string[] = [];
let seededCustomFieldDefinitionIds: string[] = [];

interface StageSnapshotRow {
  id: string;
  sequence: number;
  is_default: boolean;
  is_terminal: boolean;
  is_archived: boolean;
  colour: string | null;
  name: string;
}

/**
 * `pipeline_stages` rows as the migrations seeded them. Stages cannot be
 * created or deleted by a test (there is no `POST /api/fields/stages`) —
 * only reordered, renamed, defaulted or archived — so a test exercising any
 * of those necessarily mutates the *shared* seeded rows. Restoring this
 * snapshot on every `resetData()` is what keeps one test's reorder or
 * archive from leaking into the next.
 */
let seededStageSnapshot: StageSnapshotRow[] = [];

/**
 * The `LEAD_STAGES`/`ORDER_STAGES` literals from `20260301000000_tenancy_access_and_sync.ts`,
 * copied rather than imported (a migration is a fixed historical fact, not a
 * live import — the same rule `HANDOFF.md` states for migration authors
 * applies here). Capturing "whatever `pipeline_stages` currently holds" as
 * the seeded baseline is not safe on this test helper's *reused* cluster: an
 * earlier, since-fixed bug in a stage-mutating test left `is_default` on the
 * wrong row, and a plain capture would have enshrined that corruption as the
 * new "seed" forever. `setupDatabase()` force-corrects to this literal shape
 * before ever taking the snapshot above.
 */
const KNOWN_SEEDED_STAGES: Record<
  'lead' | 'order',
  ReadonlyArray<{ name: string; sequence: number; isDefault: boolean; isTerminal: boolean; colour: string }>
> = {
  lead: [
    { name: 'New', sequence: 1, isDefault: true, isTerminal: false, colour: '#5B8DEF' },
    { name: 'Quoted', sequence: 2, isDefault: false, isTerminal: false, colour: '#9B7BEF' },
    { name: 'Negotiating', sequence: 3, isDefault: false, isTerminal: false, colour: '#EFA65B' },
    { name: 'Won', sequence: 4, isDefault: false, isTerminal: true, colour: '#4CAF7D' },
    { name: 'Lost', sequence: 5, isDefault: false, isTerminal: true, colour: '#C7576B' },
  ],
  order: [
    { name: 'In Progress', sequence: 1, isDefault: true, isTerminal: false, colour: '#5B8DEF' },
    { name: 'Postpone', sequence: 2, isDefault: false, isTerminal: false, colour: '#EFA65B' },
    { name: 'Dispatched', sequence: 3, isDefault: false, isTerminal: true, colour: '#4CAF7D' },
    { name: 'Cancelled', sequence: 4, isDefault: false, isTerminal: true, colour: '#C7576B' },
  ],
};

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

  // Same self-healing for Fields: `20260301` seeds exactly the six
  // `lead.sourcePlatform` rows unconditionally, and — on a cluster this test
  // helper controls, where nothing exists yet when `20260306` runs — its
  // `stock.colour` / `product.productType` / `line.packaging` seed queries
  // find no data to read and insert nothing. Anything beyond those six rows,
  // and every `custom_field_definitions` row (none is ever seeded), is debris
  // a previous crashed run left behind.
  await db()('option_lists').whereNot({ list_key: 'lead.sourcePlatform' }).delete();
  await db()('custom_field_definitions').delete();

  const optionRows = await db()('option_lists').select<Array<{ id: string }>>('id');
  seededOptionListIds = optionRows.map((row) => row.id);

  const definitionRows = await db()('custom_field_definitions').select<Array<{ id: string }>>('id');
  seededCustomFieldDefinitionIds = definitionRows.map((row) => row.id);

  // Force-correct every pipeline's stages back to `KNOWN_SEEDED_STAGES` before
  // trusting the table's current contents as "the seed" — see that constant's
  // comment for why a plain capture here is not safe on a reused cluster.
  await db().transaction(async (trx) => {
    await trx.raw('SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED');
    await trx('pipeline_stages').update({ is_default: false });

    for (const kind of ['lead', 'order'] as const) {
      for (const stage of KNOWN_SEEDED_STAGES[kind]) {
        const row = await trx('pipeline_stages as s')
          .join('pipelines as p', 'p.id', 's.pipeline_id')
          .where({ 'p.kind': kind, 's.name': stage.name })
          .first<{ id: string }>('s.id');
        if (!row) continue;

        await trx('pipeline_stages').where({ id: row.id }).update({
          sequence: stage.sequence,
          is_terminal: stage.isTerminal,
          is_archived: false,
          colour: stage.colour,
        });
      }
    }

    for (const kind of ['lead', 'order'] as const) {
      const defaultStage = KNOWN_SEEDED_STAGES[kind].find((stage) => stage.isDefault);
      if (!defaultStage) continue;

      const row = await trx('pipeline_stages as s')
        .join('pipelines as p', 'p.id', 's.pipeline_id')
        .where({ 'p.kind': kind, 's.name': defaultStage.name })
        .first<{ id: string }>('s.id');
      if (row) await trx('pipeline_stages').where({ id: row.id }).update({ is_default: true });
    }
  });

  seededStageSnapshot = await db()('pipeline_stages').select<StageSnapshotRow[]>(
    'id',
    'sequence',
    'is_default',
    'is_terminal',
    'is_archived',
    'colour',
    'name',
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

  // Same for the seeded option-list values and custom-field definitions —
  // Fields configuration survives the truncate for the same reason roles do.
  if (seededOptionListIds.length > 0) {
    await db()('option_lists').whereNotIn('id', seededOptionListIds).delete();
    // A seeded row a test soft-deleted, updated or re-labelled must also come
    // back to its original shape, or the *next* test inherits that edit.
    await db().raw(`
      UPDATE option_lists SET deleted_at = NULL, deleted_by = NULL, is_active = true, version = 1
       WHERE id = ANY(?) AND (deleted_at IS NOT NULL OR is_active = false OR version <> 1)
    `, [seededOptionListIds]);
  }
  if (seededCustomFieldDefinitionIds.length > 0) {
    await db()('custom_field_definitions').whereNotIn('id', seededCustomFieldDefinitionIds).delete();
  }

  // `pipeline_stages` cannot be created or deleted by a test — only reordered,
  // renamed, defaulted or archived — so restoring the seeded snapshot is what
  // keeps one stage-mutating test from leaking into the next.
  //
  // Deferred and clear-then-set for the same reason the write path is: the
  // sequence uniqueness is a deferrable constraint that a one-row-at-a-time
  // restore can transiently collide with, and the one-default partial index
  // cannot be deferred at all, so every row is cleared to `is_default: false`
  // before any row is set back to `true`.
  if (seededStageSnapshot.length > 0) {
    await db().transaction(async (trx) => {
      await trx.raw('SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED');

      await trx('pipeline_stages')
        .whereIn('id', seededStageSnapshot.map((stage) => stage.id))
        .update({ is_default: false });

      for (const stage of seededStageSnapshot) {
        await trx('pipeline_stages').where({ id: stage.id }).update({
          sequence: stage.sequence,
          is_terminal: stage.is_terminal,
          is_archived: stage.is_archived,
          colour: stage.colour,
          name: stage.name,
        });
      }

      for (const stage of seededStageSnapshot) {
        if (stage.is_default) {
          await trx('pipeline_stages').where({ id: stage.id }).update({ is_default: true });
        }
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
