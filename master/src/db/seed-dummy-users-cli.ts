/**
 * Standalone seeder: `npm run seed:dummy` (root) or
 * `npm run seed:dummy --workspace @orderbook/master`.
 *
 * The same `seedDummyUsers` the developer tab calls, reachable without a
 * browser — for a machine that has just been installed and has nobody to sign
 * in as yet. Starts the database the way the Master does, migrates, seeds,
 * prints the credentials, and shuts down. Re-running resets the passwords.
 */

import { seedDummyUsers } from '../services/developer.service.js';
import { createLogger } from '../lib/logger.js';
import { closeDatabase, initDatabase, runMigrations } from './knex.js';
import { startPostgres } from './postgres-server.js';

const log = createLogger('seed');

async function main(): Promise<void> {
  const handle = await startPostgres();
  initDatabase(handle.connectionUrl);

  try {
    await runMigrations();
    const result = await seedDummyUsers();

    for (const user of result.users) {
      log.info(`${user.username.padEnd(12)} ${user.password.padEnd(14)} ${user.tier.padEnd(11)} (${user.outcome})`);
    }
    if (result.pairingPassword) {
      // Shown once, like the first-run screen would have: only its hash is stored.
      log.info(`First-time setup ran for "${result.companyName ?? ''}" — pairing password: ${result.pairingPassword}`);
    }
  } finally {
    await closeDatabase();
    await handle.stop();
  }
}

main().catch((error) => {
  log.error('Seeding dummy users failed', error);
  process.exitCode = 1;
});
