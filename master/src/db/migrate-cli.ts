/**
 * Standalone migration runner: `npm run migrate --workspace @orderbook/master`.
 *
 * Starts the database the same way the Master server does, applies pending
 * migrations, then shuts down — useful for preparing or inspecting an
 * installation without launching the full application.
 *
 * Pass `--status` (`npm run migrate -- --status`) to list applied and pending
 * migrations, by name and in run order, instead of applying them —
 * `migration-status.ts` formats the answer.
 */

import { startPostgres } from './postgres-server.js';
import { closeDatabase, db, initDatabase, runMigrations } from './knex.js';
import { formatMigrationStatus, type MigrationList } from './migration-status.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('migrate');

async function main(): Promise<void> {
  const handle = await startPostgres();
  initDatabase(handle.connectionUrl);

  try {
    if (process.argv.includes('--status')) {
      const list = (await db().migrate.list()) as MigrationList;
      for (const line of formatMigrationStatus(list)) log.info(line);
    } else {
      await runMigrations();
    }
  } finally {
    await closeDatabase();
    await handle.stop();
  }
}

main().catch((error) => {
  log.error('Migration failed', error);
  process.exitCode = 1;
});
