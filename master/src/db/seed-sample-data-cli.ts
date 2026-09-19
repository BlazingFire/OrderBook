/**
 * Standalone seeder: `npm run seed:sample` (root) or
 * `npm run seed:sample --workspace @orderbook/master`.
 *
 * The same `seedSampleData` the developer tab calls, reachable without a
 * browser: six months of a small tile trade — parties, products with photos,
 * stock, leads, orders, remarks — created through the ordinary services as
 * the three test users, which it seeds first. Starts the database the way the
 * Master does, migrates, seeds, prints what it made, and shuts down. It
 * refuses to run twice on the same Master; erase first (Settings →
 * Developer → Erase everything) to start over.
 */

import { createLogger } from '../lib/logger.js';
import { seedSampleData } from '../services/sample-data.service.js';
import { closeDatabase, initDatabase, runMigrations } from './knex.js';
import { startPostgres } from './postgres-server.js';

const log = createLogger('seed');

async function main(): Promise<void> {
  const handle = await startPostgres();
  initDatabase(handle.connectionUrl);

  try {
    await runMigrations();
    const result = await seedSampleData();

    for (const user of result.users) {
      log.info(
        `${user.username.padEnd(12)} ${user.password.padEnd(14)} ${user.tier.padEnd(11)} (${user.outcome})`,
      );
    }
    if (result.pairingPassword) {
      // Shown once, like the first-run screen would have: only its hash is stored.
      log.info(
        `First-time setup ran for "${result.companyName ?? ''}" — pairing password: ${result.pairingPassword}`,
      );
    }

    const { counts } = result;
    log.info(
      `Seeded ${result.from} → ${result.to}: ${counts.parties} parties, ${counts.products} products ` +
        `(${counts.images} photos), ${counts.stockMovements} stock movements, ${counts.leads} leads, ` +
        `${counts.orders} orders (${counts.dispatched} dispatched), ${counts.remarks} remarks, ` +
        `${counts.optionValues} option values, ${counts.customFields} custom fields, ` +
        `${counts.partyVariants} party-wise rates, ${counts.partyAssignments} party assignments, ` +
        `${counts.deleted} in the Recycle Bin`,
    );
  } finally {
    await closeDatabase();
    await handle.stop();
  }
}

main().catch((error) => {
  log.error('Seeding sample data failed', error);
  process.exitCode = 1;
});
