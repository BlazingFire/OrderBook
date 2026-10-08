/**
 * Where a notice shows besides the board (2026-10-08): `notices.show_on_home` (the band at the
 * top of Basic Home) and `notices.show_at_sign_in` (the pop-up right after somebody signs in).
 *
 * Both default to true, so every notice already up keeps showing where it would have, and a
 * notice written by an older panel that sends neither field is shown in both places. The rule
 * that at least one stays true is the Master's (`notice.service.ts`), not a constraint here.
 *
 * Additive only (`migration-data-safety.test.ts`), and safe to run twice. `down()` drops the
 * columns: allowed there, never in `up()`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE notices
      ADD COLUMN IF NOT EXISTS show_on_home BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS show_at_sign_in BOOLEAN NOT NULL DEFAULT true
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE notices
      DROP COLUMN IF EXISTS show_on_home,
      DROP COLUMN IF EXISTS show_at_sign_in
  `);
}
