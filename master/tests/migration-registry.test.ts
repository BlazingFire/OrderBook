/**
 * The migration registry guard, landed before the first of five new
 * migrations in `docs/backend-modules/`.
 *
 * `master/src/db/migrations/index.ts` is a hand-maintained array, not a
 * directory scan (its own header explains why). That means a migration file
 * that is written but never added to the array is a silent no-op: nothing
 * turns red, the schema simply is not there, and the first symptom is a query
 * failing against a missing column at runtime — probably on the shop PC. With
 * five files landing across this batch against one hand-maintained array,
 * this is the single most likely way to lose a day.
 *
 * Reads the source, in the `credential-invariants.test.ts` style, rather than
 * importing the registry — importing would prove the array is *syntactically*
 * a list of migrations, not that it matches the directory on disk.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

function filesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

function registrySource(): string {
  return readFileSync(path.join(MIGRATIONS_DIR, 'index.ts'), 'utf8');
}

/** Every `name: '...'` entry in the `migrations` array, in the order written. */
function namesInArray(source: string): string[] {
  const arrayBody = source.slice(source.indexOf('export const migrations'));
  return [...arrayBody.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1] as string);
}

describe('the migration registry matches the directory', () => {
  it('lists every migration file on disk, and nothing else', () => {
    const onDisk = filesOnDisk();
    const listed = namesInArray(registrySource()).sort();

    expect(listed).toEqual(onDisk);
  });

  it('imports every file it lists — a name with no matching import is not really registered', () => {
    const source = registrySource();
    for (const name of namesInArray(source)) {
      expect(source.includes(`./${name}.js`)).toBe(true);
    }
  });

  /**
   * `20260309` was given its slot before `20260310`/`20260311` were claimed by
   * concurrent work, but it grants permissions for keys those modules mint, so
   * it has to run after them. It has already been applied in the last position
   * on a real installation, which is what makes this permanent: renaming the
   * file to restore ascending order would make Knex see an unrun migration and
   * apply it a second time.
   */
  const DELIBERATELY_LAST = [
    '20260309000000_new_module_permission_grant',
    // Strips keys the grant above still hands out, so it has to run after it
    // — on a fresh database as much as on an upgraded one.
    '20260322000000_drop_document_designer',
    // Strips the four rate keys that `20260303`, `20260309` and `20260315`
    // still grant, for the same reason.
    '20260324000000_product_master_trim',
    // Restores `line_items.grade`, which the trim above drops. Its timestamp
    // is already the highest, so this is not a reordering so much as a pin:
    // it has to stay behind a migration that is itself pinned out of order.
    '20260325000000_line_item_grade',
    // Catalogue v2's columns and indexes, pinned behind the trim for the same
    // reason. Idempotent, because the stale-branch database already has them.
    '20260326000000_catalogue_brands_and_codes_port',
    // `option_lists` brought level for databases that ran `20260306`'s older
    // body. Behind everything pinned above, so it runs last everywhere.
    '20260327000000_option_lists_repair',
    // Seeds the packaging list into that table, so it stays behind the repair.
    '20260328000000_line_packaging_defaults',
    // Highest timestamp, but the pinned block above already sits at the tail of
    // the array, so a new migration goes behind it and joins the pin.
    '20260401000000_order_vehicle_number',
    // 1.3 batch, migration #1: the Server Master tier. Every later migration of
    // the batch goes behind it, so their grants see the role.
    '20261001000000_server_master_tier',
    // 1.3 Phase 3: the notification table (#2) and the panel proof key (#2a).
    '20261002000000_user_notifications',
    '20261002000001_office_panel_master_proof',
    // 1.3 Phase 4: pending order numbers (#3).
    '20261003000000_pending_order_numbers',
    // Reports indexes and the office / management grant (1.3 H2). Pinned in the
    // order the 1.3 batch lands its migrations.
    '20261004000000_report_indexes_and_grants',
    // 1.3 Phase 8: `storage.backupAll` for the Server Master tier (#7).
    '20261007000000_backup_all_permission_grant',
  ];

  it('is in ascending timestamp order — the array is read start to end, and Knex applies in that order', () => {
    const names = namesInArray(registrySource());
    const timestamps = names.filter((name) => !DELIBERATELY_LAST.includes(name)).map((name) => name.slice(0, 14));
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);
  });

  it('keeps the deliberately-reordered migrations pinned to the end, where they have already run', () => {
    const names = namesInArray(registrySource());
    expect(names.slice(-DELIBERATELY_LAST.length)).toEqual(DELIBERATELY_LAST);
  });

  /**
   * The one that actually bit, on 2026-08-27.
   *
   * `dev` shipped `20260313000000_panel_app_version`; `origin/main`
   * independently added the same `office_panels.app_version` column inside
   * `20260312000000_office_panel_administration`. The merge resolved the
   * duplicate by **deleting the file** — which is right for a database created
   * afterwards, and locks out every database created before it. Knex validates
   * completed-against-source before it runs anything, so the Master would not
   * boot at all:
   *
   *     The migration directory is corrupt, the following files are missing:
   *     20260313000000_panel_app_version
   *
   * The shop's data was intact and unreachable. There is no automated way to
   * know which migrations a *stranger's* database has already run, so this
   * pins the names that are known to have shipped: deleting one of these files
   * again turns this test red instead of turning somebody's Master into an
   * error page.
   *
   * Add to this list when a migration reaches a real installation. Never
   * remove from it.
   */
  const SHIPPED = [
    '20260101000000_initial_schema',
    '20260201000000_stock_movement_notes',
    '20260301000000_tenancy_access_and_sync',
    '20260302000000_lead_order_rebuild',
    '20260303000000_roles_and_users',
    '20260304000000_role_tier_ceiling_repair',
    '20260305000000_soft_delete_columns',
    '20260306000000_field_values_and_stage_ordering',
    '20260307000000_product_images_pipeline',
    '20260308000000_document_templates_and_exports',
    '20260309000000_new_module_permission_grant',
    '20260310000000_activity_log_actor_name',
    '20260311000000_storage_permission_grant',
    '20260312000000_office_panel_administration',
    '20260312000000_user_avatars',
    '20260313000000_panel_app_version',
    '20260313000000_party_access',
    // Run on the owner's live database by 2026-09-28, and shipped to
    // customers with the 1.1 and 1.2 lines.
    '20260314000000_settings_and_password_vault',
    '20260315000000_product_trade_and_ceramic_attributes',
    '20260316000000_public_api_and_connectors',
    '20260317000000_ai_assistant',
    '20260318000000_document_layout_v2',
    '20260319000000_products_bulk_permission_grant',
    '20260320000000_product_variant_codes',
    '20260321000000_line_item_variant_codes',
    '20260322000000_product_colour_policy_and_line_category',
    '20260322000000_drop_document_designer',
    '20260323000000_product_variants',
    '20260324000000_product_master_trim',
    '20260325000000_line_item_grade',
    // The stale branch's real body ran under this name on the owner's PC; it
    // lives on as a no-op so that database still boots.
    '20260323000000_catalogue_brands_and_codes',
    '20260326000000_catalogue_brands_and_codes_port',
    '20260327000000_option_lists_repair',
  ];

  it('still lists every migration that has ever run on a real installation', () => {
    const listed = new Set(namesInArray(registrySource()));

    for (const name of SHIPPED) {
      expect(listed.has(name), `${name} has shipped and must stay in the registry`).toBe(true);
    }
  });

  /**
   * Two files sharing a timestamp is survivable — Knex keys on the name, and
   * this repo already carries two `20260312000000_*`. What is not survivable is
   * two of them trying to create the same thing, which is how the pair above
   * came to exist. A guard against the *timestamp* would be noise; this one
   * checks the property that actually matters when a collision happens.
   */
  it('lets a duplicate timestamp coexist, since Knex keys on the whole name', () => {
    const names = namesInArray(registrySource());
    const timestamps = names.map((name) => name.slice(0, 14));

    expect(new Set(timestamps).size).toBeLessThan(timestamps.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every filename on disk starts with a 14-digit timestamp', () => {
    for (const name of filesOnDisk()) {
      expect(name.slice(0, 14)).toMatch(/^\d{14}$/);
    }
  });
});
