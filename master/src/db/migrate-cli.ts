/**
 * Standalone migration runner: `npm run migrate --workspace @orderbook/master`.
 *
 * Starts the database the same way the Master server does, applies pending
 * migrations, then shuts down — useful for preparing or inspecting an
 * installation without launching the full application.
 *
 * Pass `--status` to list applied/pending migrations instead of applying them.
 */

import { startPostgres } from './postgres-server.js';
import { closeDatabase, db, initDatabase, runMigrations } from './knex.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('migrate');

async function main(): Promise<void> {
  const handle = await startPostgres();
  initDatabase(handle.connectionUrl);

  try {
    if (process.argv.includes('--status')) {
      const [applied, pending] = await Promise.all([
        db().migrate.list(),
        Promise.resolve(null),
      ]).then(([list]) => list as [Array<{ name: string }>, Array<{ file: string }>]);

      log.info(`Applied: ${applied.map((m) => m.name).join(', ') || 'none'}`);
      log.info(`Pending: ${pending.map((m) => m.file).join(', ') || 'none'}`);
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
