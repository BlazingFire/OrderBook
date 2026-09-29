/**
 * Catalogue brands and codes — the stale branch's name, kept so its databases
 * still boot.
 *
 * **This file exists to keep a promise Knex makes, not to change a schema.**
 * Same shape of problem as `20260313000000_panel_app_version`, and the same
 * answer.
 *
 * A checkout of this repository that had not taken 1.2.0 (the
 * `catalogue-v2-stale` line, commit `6549018`) ran a real migration under this
 * name on the owner's PC database on 2026-09-28. Knex keys completed
 * migrations by **name** and validates the list before it runs anything, so a
 * database whose `knex_migrations` holds a name this registry lacks refuses to
 * start at all:
 *
 *     The migration directory is corrupt, the following files are missing:
 *     20260323000000_catalogue_brands_and_codes
 *
 * Its real body cannot come across. It widens a CHECK on
 * `products.colour_policy`, a column `20260323000000_product_variants` drops —
 * so on every 1.2.0 installation it would be pending, run last, and fail with
 * `column "colour_policy" does not exist`, stopping the Master instead.
 *
 * So the name comes back with nothing in it, and
 * `20260326000000_catalogue_brands_and_codes_port` does the real work,
 * idempotently, for every history:
 *
 *  - **Ran the stale body** (the owner's database): already recorded, so this
 *    never runs; the port migration then finds everything it adds already
 *    there.
 *  - **A 1.2.0 installation, or a fresh database**: this runs and does
 *    nothing; the port migration adds the columns and indexes.
 *
 * Registered in timestamp order beside `20260323000000_product_variants`: a
 * no-op has no ordering dependency on anything. Do not "tidy" this away —
 * deleting it re-breaks exactly the database with the owner's data on it.
 */

import type { Knex } from 'knex';

export async function up(_knex: Knex): Promise<void> {
  // Deliberately empty — see the header.
}

export async function down(_knex: Knex): Promise<void> {
  // Deliberately empty: `up` created nothing, so there is nothing to take back.
}
