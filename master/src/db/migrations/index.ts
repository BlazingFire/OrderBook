/**
 * Explicit migration registry.
 *
 * Knex can discover migrations by scanning a directory, but that requires the
 * runtime to load the files itself — which means the extension has to be `.ts`
 * under tsx, `.js` after a build, and the directory path has to resolve in both
 * layouts. Importing them here instead makes the set of migrations, and their
 * order, a compile-time fact: a migration that is not in this list does not
 * exist, and the bundler/compiler follows the imports like any other code.
 *
 * Add new migrations to the end of the array. Never reorder or edit an entry
 * that has already run on a real installation.
 */

import type { Knex } from 'knex';

import * as initialSchema from './20260101000000_initial_schema.js';
import * as stockMovementNotes from './20260201000000_stock_movement_notes.js';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

export const migrations: Migration[] = [
  { name: '20260101000000_initial_schema', ...initialSchema },
  { name: '20260201000000_stock_movement_notes', ...stockMovementNotes },
];

/** Adapts the registry to the interface Knex's migrator expects. */
export class RegistryMigrationSource implements Knex.MigrationSource<Migration> {
  async getMigrations(): Promise<Migration[]> {
    return migrations;
  }

  getMigrationName(migration: Migration): string {
    return migration.name;
  }

  async getMigration(migration: Migration): Promise<Knex.Migration> {
    return { up: migration.up, down: migration.down };
  }
}
