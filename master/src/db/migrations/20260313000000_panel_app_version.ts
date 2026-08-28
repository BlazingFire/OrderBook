/**
 * What version each Office Panel is running.
 *
 * **This file exists to keep a promise Knex makes, not to change a schema.**
 *
 * It was added by `1c33b52` ("Add an App update screen to both panels") on the
 * `dev` branch, and `origin/main` independently added the same
 * `office_panels.app_version` column inside
 * `20260312000000_office_panel_administration`. The merge in `cb92a02` resolved
 * that by deleting this file — correct for a database created *after* the
 * merge, and wrong for every database created before it, because Knex keys
 * completed migrations by **name**. A database that had already run
 * `20260313000000_panel_app_version` then found it missing from the registry
 * and refused to start at all:
 *
 *     The migration directory is corrupt, the following files are missing:
 *     20260313000000_panel_app_version
 *
 * That is not a warning. `validateMigrationList` runs before anything else, so
 * the Master would not boot — with the shop's data sitting there, intact and
 * unreachable. HANDOFF.md's own trap entry describes the timestamp collision
 * and says the merge deleted the duplicate; what nobody did was reconcile the
 * databases that had already run it.
 *
 * So the file comes back, and its `up` becomes idempotent. Three cases, all
 * ending in the same place:
 *
 *  - **Ran this before the merge** (the owner's `order_book`): already
 *    recorded, so it never runs again. Its only job is to exist.
 *  - **Created after the merge**: `20260312` added the column moments ago, so
 *    `IF NOT EXISTS` makes this a no-op.
 *  - **Created from scratch today**: same as above.
 *
 * Do not "tidy" this away again. Deleting it re-breaks every installation that
 * ran it, and those are exactly the installations with real data on them.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // `IF NOT EXISTS` because `20260312000000_office_panel_administration` adds
  // the same column. Which of the two actually creates it depends only on which
  // order a given database met them in, and both orders exist in the wild.
  await knex.raw(`ALTER TABLE office_panels ADD COLUMN IF NOT EXISTS app_version TEXT`);
}

export async function down(): Promise<void> {
  /*
   * Deliberately empty. `20260312000000_office_panel_administration` also
   * declares this column and drops it in its own `down`; dropping it here as
   * well would mean whichever rollback ran second failed on a column that was
   * already gone. The column has one owner going down, and it is not this file.
   */
}
