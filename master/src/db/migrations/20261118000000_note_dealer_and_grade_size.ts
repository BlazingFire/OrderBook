/**
 * What the Filling and Dispatch note prints beyond its lines (2026-11-18).
 *
 * - `leads.dealer_code` / `orders.dealer_code`: the dealer code printed in a
 *   note's header. Today the note prints the party's own `partyCode`; this
 *   column overrides it for **one order only**, so a note can be corrected
 *   without renaming the party everywhere (the owner's answer). NULL prints the
 *   party's code, which is what every existing note already does.
 * - `leads.note_grade_size` / `orders.note_grade_size`: the grade's text size on
 *   the note, in pixels. NULL is the sheet's own size (`--note-grade`), so an
 *   installation that never touches it prints exactly what it printed before.
 * - `products.default_packaging`: the packaging a sub product is entered with,
 *   so lead entry stops asking for the same choice on every line. NULL offers
 *   none; a line still lets the person pick a different one.
 *
 * The company-wide default for the note's two lives in `settings`
 * (`notes.gradeSize`), not here: a row with NULL follows that setting.
 *
 * Additive only (`migration-data-safety.test.ts`): nullable columns, no
 * backfill, no data rewrite in `up()`. `down()` drops them — allowed there,
 * never in `up()`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE leads ADD COLUMN IF NOT EXISTS dealer_code TEXT NULL');
  await knex.raw('ALTER TABLE orders ADD COLUMN IF NOT EXISTS dealer_code TEXT NULL');
  await knex.raw('ALTER TABLE leads ADD COLUMN IF NOT EXISTS note_grade_size INTEGER NULL');
  await knex.raw('ALTER TABLE orders ADD COLUMN IF NOT EXISTS note_grade_size INTEGER NULL');
  await knex.raw('ALTER TABLE products ADD COLUMN IF NOT EXISTS default_packaging TEXT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE leads DROP COLUMN IF EXISTS dealer_code');
  await knex.raw('ALTER TABLE orders DROP COLUMN IF EXISTS dealer_code');
  await knex.raw('ALTER TABLE leads DROP COLUMN IF EXISTS note_grade_size');
  await knex.raw('ALTER TABLE orders DROP COLUMN IF EXISTS note_grade_size');
  await knex.raw('ALTER TABLE products DROP COLUMN IF EXISTS default_packaging');
}
