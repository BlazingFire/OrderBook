import knexFactory, { type Knex } from 'knex';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../lib/logger.js';

const log = createLogger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

let instance: Knex | null = null;

export function buildKnexConfig(connectionUrl: string): Knex.Config {
  return {
    client: 'pg',
    connection: connectionUrl,
    // A small fixed pool: one application process, but concurrent socket
    // commands still benefit from more than a single connection.
    pool: { min: 2, max: 10 },
    migrations: {
      directory: path.join(here, 'migrations'),
      tableName: 'knex_migrations',
      extension: 'ts',
      loadExtensions: ['.ts', '.js'],
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
