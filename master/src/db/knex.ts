import knexFactory, { type Knex } from 'knex';

import { createLogger } from '../lib/logger.js';
import { RegistryMigrationSource } from './migrations/index.js';

const log = createLogger('db');

let instance: Knex | null = null;

export function buildKnexConfig(connectionUrl: string): Knex.Config {
  return {
    client: 'pg',
    connection: connectionUrl,
    // A small fixed pool: one application process, but concurrent socket
    // commands still benefit from more than a single connection.
    pool: { min: 2, max: 10 },
    migrations: {
      // Migrations come from an explicit registry rather than a directory scan
      // — see migrations/index.ts for why.
      migrationSource: new RegistryMigrationSource(),
      tableName: 'knex_migrations',
    },
  };
}

export function initDatabase(connectionUrl: string): Knex {
  if (instance) return instance;
  instance = knexFactory(buildKnexConfig(connectionUrl));
  return instance;
}

export function db(): Knex {
  if (!instance) throw new Error('Database accessed before initDatabase() was called');
  return instance;
}

export async function runMigrations(): Promise<void> {
  const [, applied] = (await db().migrate.latest()) as [number, string[]];
  if (applied.length === 0) {
    log.info('Schema already up to date');
  } else {
    log.info(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}

export async function closeDatabase(): Promise<void> {
  if (!instance) return;
  await instance.destroy();
  instance = null;
}
