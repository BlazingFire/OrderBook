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
import * as tenancyAccessAndSync from './20260301000000_tenancy_access_and_sync.js';
import * as leadOrderRebuild from './20260302000000_lead_order_rebuild.js';
import * as rolesAndUsers from './20260303000000_roles_and_users.js';
import * as roleTierCeilingRepair from './20260304000000_role_tier_ceiling_repair.js';
import * as softDeleteColumns from './20260305000000_soft_delete_columns.js';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

export const migrations: Migration[] = [
  { name: '20260101000000_initial_schema', ...initialSchema },
  { name: '20260201000000_stock_movement_notes', ...stockMovementNotes },
  { name: '20260301000000_tenancy_access_and_sync', ...tenancyAccessAndSync },
  { name: '20260302000000_lead_order_rebuild', ...leadOrderRebuild },
  { name: '20260303000000_roles_and_users', ...rolesAndUsers },
  { name: '20260304000000_role_tier_ceiling_repair', ...roleTierCeilingRepair },
  { name: '20260305000000_soft_delete_columns', ...softDeleteColumns },
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
