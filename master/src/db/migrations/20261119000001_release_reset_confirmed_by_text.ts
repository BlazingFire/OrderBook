/**
 * `release_resets.confirmed_by` holds a user id, and user ids here are text (`US0000000003`), not
 * UUIDs. `20261119000000_release_reset_1_5_9` typed it UUID; it had already run on a development
 * database before the reset was first exercised against PostgreSQL, so it is corrected here
 * rather than rewritten (a migration that may have run anywhere is never changed).
 *
 * Structure only: the column has only ever held NULL (it is written once, at the confirmation,
 * which failed on this very type), so nothing is converted. `USING` makes it safe either way.
 * Idempotent: TEXT to TEXT is a no-op.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE release_resets ALTER COLUMN confirmed_by TYPE TEXT USING confirmed_by::text');
}

export async function down(): Promise<void> {
  // Left as TEXT: going back to UUID would fail on the text ids this column is meant for.
}
