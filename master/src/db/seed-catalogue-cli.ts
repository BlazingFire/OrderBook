/**
 * Standalone catalogue loader: `npm run seed:catalogue` (root) or
 * `npm run seed:catalogue --workspace @orderbook/master`.
 *
 * The same `seedCatalogue` the developer tab calls, reachable without a
 * browser: the Swisware master catalogue — categories, models and every
 * variant code, weights left blank — created through the ordinary catalogue
 * service as the installation's first administrator. Starts the database the
 * way the Master does, migrates, loads, prints what it made, and shuts down.
 * Idempotent: a second run reports every model as already present.
 */

import { createLogger } from '../lib/logger.js';
import { seedCatalogue } from '../services/catalogue-seed.service.js';
import { closeDatabase, initDatabase, runMigrations } from './knex.js';
import { startPostgres } from './postgres-server.js';

const log = createLogger('seed');

async function main(): Promise<void> {
  const handle = await startPostgres();
  initDatabase(handle.connectionUrl);

  try {
    await runMigrations();
    const result = await seedCatalogue();
    log.info(
      `Swisware catalogue: ${result.categories} new categories, ${result.products} products ` +
        `(${result.variants} variants) loaded, ${result.skipped} models already present`,
    );
  } finally {
    await closeDatabase();
    await handle.stop();
  }
}

main().catch((error) => {
  log.error('Loading the catalogue failed', error);
  process.exitCode = 1;
});
