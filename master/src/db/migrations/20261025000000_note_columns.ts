/**
 * The Dispatch note saved tick boxes (docs/ORDER_NOTES_PLAN.md).
 *
 * One nullable JSON column on each of the two records a note is printed from:
 * which of packing, grade and colour the Dispatch note prints. The note screen
 * saves the current ticks here; every renderer (preview, print, PDF and the
 * printroom) reads them, so an unticked column vanishes everywhere.
 *
 * Additive only (migration-data-safety.test.ts): nullable columns, no backfill,
 * no data rewrite in up(). An absent value reads as all three ticked. down()
 * drops them - allowed there, never in up().
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS note_columns JSONB NULL',
  );
  await knex.raw(
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS note_columns JSONB NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE leads DROP COLUMN IF EXISTS note_columns');
  await knex.raw('ALTER TABLE orders DROP COLUMN IF EXISTS note_columns');
}
