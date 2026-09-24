/**
 * What `npm run migrate -- --status` prints, as a pure function of Knex's
 * `migrate.list()` answer — kept out of `migrate-cli.ts` because importing
 * that file starts the database.
 *
 * `list()` resolves to `[applied, pending]`, and the two halves are not the
 * same shape. `applied` is the rows read back from `knex_migrations`, so each
 * is `{ name }`. `pending` is whatever the migration *source* handed Knex:
 * with Knex's own directory scan that is `{ file, directory }`, but this
 * Master uses `RegistryMigrationSource` (`migrations/index.ts`), so each
 * pending entry is the registry's own `Migration` — `{ name, up, down }`, no
 * `file`. The CLI used to read `file`: every pending name printed blank, and a
 * single pending migration joined to an empty string and came out as
 * `Pending: none`, the one wrong answer an operator checking before an update
 * must never be given.
 */

import type { Migration } from './migrations/index.js';

/** `db().migrate.list()`'s answer under `RegistryMigrationSource` (Knex types it `any`). */
export type MigrationList = [applied: Array<{ name: string }>, pending: Migration[]];

/** Two lines, applied then pending, each with its count and names in run order. */
export function formatMigrationStatus([applied, pending]: MigrationList): string[] {
  return [
    `Applied (${applied.length}): ${applied.map((row) => row.name).join(', ') || 'none'}`,
    `Pending (${pending.length}): ${pending.map((migration) => migration.name).join(', ') || 'none'}`,
  ];
}
