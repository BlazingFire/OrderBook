/**
 * Standalone catalogue loader: `npm run seed:catalogue` (root) or
 * `npm run seed:catalogue --workspace @orderbook/master`.
 *
 * The same additive `seedCatalogue` the /api/developer/load-catalogue route (no screen since 5a32106) calls, reachable
 * without a browser: the shipped SWISWARE catalogue file
 * (`master/assets/catalogue/swisware-plus-2026.md`, `docs/catalogue/CATALOGUE_MODEL.md`
 * §4) — brands, colours, products and sub products, weights left blank —
 * loaded as the installation's first administrator. Deletes nothing. Starts
 * the database the way the Master does, migrates, loads, prints what it made,
 * and shuts down. Idempotent: a second run reports every sub product as
 * already present. To replace the catalogue instead, `reload:catalog`.
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
      `SWISWARE catalogue: ${result.products} products and ${result.subProducts} sub products ` +
        `created, ${result.colours} colours added, ${result.skipped} sub products already present`,
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
