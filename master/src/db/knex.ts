import knexFactory, { type Knex } from 'knex';

import { createLogger } from '../lib/logger.js';
import { RegistryMigrationSource } from './migrations/index.js';
import { attachQueryCounter } from './query-counter.js';

const log = createLogger('db');

let instance: Knex | null = null;

/** The pool's ceiling. PostgreSQL's `max_connections` is sized above it (`postgres-server.ts`). */
export const POOL_MAX = 10;

function buildKnexConfig(connectionUrl: string): Knex.Config {
  return {
    client: 'pg',
    connection: connectionUrl,
    /*
     * A small fixed pool: one application process, but concurrent socket
     * commands still benefit from more than a single connection.
     *
     * `acquireTimeoutMillis` is the one that changes what an operator sees. A
     * pool with no acquire timeout answers a leak or a deadlock by hanging
     * forever, which reaches the shop floor as "the panel froze" and reaches
     * the log as nothing at all. Ten seconds turns it into a
     * `TimeoutAcquiringConnection` with a stack.
     *
     * The idle/reap pair returns connections the Master is not using — it sits
     * open all day between bursts — without churning them mid-burst.
     */
    pool: {
      min: 2,
      max: POOL_MAX,
      acquireTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      reapIntervalMillis: 5_000,
    },
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
  attachQueryCounter(instance);
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
