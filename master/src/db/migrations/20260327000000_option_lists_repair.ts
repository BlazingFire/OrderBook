/**
 * Brings `option_lists` to one shape on every database, whichever body of
 * `20260306000000_field_values_and_stage_ordering` it ran.
 *
 * That migration has two bodies in this repository's history. The one on the
 * August line that `main` later merged (`c9091c7`) added `created_at`,
 * `updated_at`, `deleted_at`, `deleted_by`, `version` and `hex`, with a hex
 * check that accepts lowercase only (`^#[0-9a-f]{6}$`). The one that won
 * (`227494e`) also adds `created_by` and `updated_by`, and its check accepts
 * either case. Both are registered under the same name, so a database created
 * from the first never runs the second: the owner's PC database is one, and a
 * catalogue reload on it failed with `column "created_by" of relation
 * "option_lists" does not exist`. Every option-list write the Fields screen,
 * Settings → Leads and the catalogue loader make names those two columns, and
 * the catalogue's colour range is written in uppercase hex (`#FEFEFE`), which
 * the old check refuses.
 *
 * The old body cannot be rewritten — it ran — so this closes the gap forward,
 * idempotently: every column the current body adds is added if missing, and
 * the check is replaced by the current one. The new check only widens the old
 * one (uppercase is now allowed too), so no stored value can fail it. Nothing
 * is dropped but the constraint being replaced.
 *
 * Pinned after `20260326000000_catalogue_brands_and_codes_port`, at the end of
 * the registry, because the migrations before it are pinned out of order.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE option_lists
      ADD COLUMN IF NOT EXISTS hex        TEXT,
      ADD COLUMN IF NOT EXISTS created_by TEXT,
      ADD COLUMN IF NOT EXISTS updated_by TEXT,
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by TEXT,
      ADD COLUMN IF NOT EXISTS version    INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    ALTER TABLE option_lists DROP CONSTRAINT IF EXISTS option_lists_hex_format;
    ALTER TABLE option_lists
      ADD CONSTRAINT option_lists_hex_format
      CHECK (hex IS NULL OR hex ~ '^#[0-9A-Fa-f]{6}$');
  `);
}

/**
 * Nothing to undo: every column it adds belongs to `20260306`'s current body,
 * and the check it leaves is that body's check.
 */
export async function down(): Promise<void> {}
