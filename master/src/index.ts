/**
 * Master Panel entrypoint.
 *
 * Startup order matters, and it has two halves that pull in opposite
 * directions.
 *
 * The database must be up and migrated before anything can serve *requests*,
 * and discovery must not advertise this Master until it can actually accept a
 * pairing request. But the HTTP port must open **before** any of that, because
 * everything that can go wrong goes wrong first: a cluster that will not
 * start, a port already taken, a major-version mismatch, a missing font. This
 * used to exit the process with the explanation in a console window nobody
 * looks at, while the browser sat on its starting screen for ever waiting for
 * a port that was never going to open.
 *
 * So the port opens immediately serving `createBootApp()`, which answers every
 * API call with the boot status, and the real app replaces it once the boot
 * sequence finishes. A failure now has a screen to appear on.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';

import { bootFailed, bootReady, bootStep } from './boot-status.js';
import { config } from './config/index.js';
import { startPostgres, type PostgresServerHandle } from './db/postgres-server.js';
import { closeDatabase, db, initDatabase, runMigrations } from './db/knex.js';
import { startDiscoveryResponder, type DiscoveryResponder } from './discovery/responder.js';
import { createApp } from './http/app.js';
import { createBootApp } from './http/boot-app.js';
import {
  ensureDocumentDirectories,
  sweepOrphanTemporaries,
} from './lib/document-files.js';
import { createLogger } from './lib/logger.js';
import { assertFontsPresent } from './pdf/fonts.js';
import { listLanAddresses } from './lib/network.js';
import { createRealtimeHub, type RealtimeHub } from './realtime/hub.js';
import { purgeExpiredSessions } from './services/auth.service.js';
import { isSetupComplete, refreshStoredLanIp } from './services/setup.service.js';

const log = createLogger('master');

const SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Proves `config.locale.timeZone` at boot rather than letting a typo surface
 * later as a quietly-wrong report bucket. Nothing pins a timezone otherwise —
 * `buildKnexConfig` passes only client/connection/pool/migrations, and there
 * is no `SET TIME ZONE` anywhere — so a mistyped zone would otherwise reach
 * Postgres invisibly on the first date computation instead of failing loudly
 * here, on every boot, naming the variable to fix.
 *
 * Run AFTER `runMigrations()`: it needs a live, migrated connection, and a
 * fresh install must fail on a missing schema with a migration error, not a
 * timezone one.
 */
async function assertTimeZoneValid(): Promise<void> {
  try {
    await db().raw('SELECT now() AT TIME ZONE ?', [config.locale.timeZone]);
  } catch {
    throw new Error(
      `ORDERBOOK_TIMEZONE is set to "${config.locale.timeZone}", which PostgreSQL does not ` +
        'recognise. Set it to a valid IANA zone name (for example "Asia/Kolkata") and restart.',
    );
  }
}

async function main(): Promise<void> {
  /*
   * The live request handler. Starts as the boot app and is swapped for the
   * real one when the boot sequence completes, rather than creating a second
   * server: the port is already open and listening by then, and re-binding it
   * would reintroduce the very window this exists to close.
   */
  let handler: (req: IncomingMessage, res: ServerResponse) => void = createBootApp();
  const httpServer = createServer((req, res) => handler(req, res));

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.http.port, config.http.host, resolve);
  });

  log.info(`Master Panel starting — open http://localhost:${config.http.port} to watch its progress`);

  let postgres: PostgresServerHandle | null = null;

  try {
    bootStep('Preparing folders');
    await fs.mkdir(config.uploadsDir, { recursive: true });

    // A missing document font must stop startup here, naming the file. PDFKit's
    // fallback for an unregistered face is Helvetica, which has no Devanagari
    // glyphs — so the alternative to failing now is silently printing every
    // Hindi name as blank boxes on a document already sent to a customer.
    bootStep('Checking document fonts');
    assertFontsPresent();
    await ensureDocumentDirectories();
    await sweepOrphanTemporaries();

    bootStep('Starting the database');
    postgres = await startPostgres();
    initDatabase(postgres.connectionUrl);

    bootStep('Updating the database');
    await runMigrations();
    await assertTimeZoneValid();

    if (await isSetupComplete()) {
      await refreshStoredLanIp();
    } else {
      log.info('No configuration found — the browser will show the first-run setup screen');
    }

    bootStep('Starting the panel');
    handler = createApp();
    const hub = createRealtimeHub(httpServer);

    const discovery = await startDiscoveryResponder();
    const sessionSweep = setInterval(purgeExpiredSessions, SESSION_SWEEP_INTERVAL_MS);

    bootReady();

    for (const address of listLanAddresses()) {
      log.info(`Master Panel ready at http://${address}:${config.http.port}`);
    }
    log.info(`Master Panel ready at http://localhost:${config.http.port}`);

    installShutdownHandlers({ postgres, hub, discovery, httpServer, sessionSweep });
  } catch (error) {
    /*
     * Deliberately no `process.exit`. The HTTP server stays up serving the boot
     * app, which now reports this failure — so the operator sees it on the
     * screen they are already looking at instead of in a console window behind
     * it. Exiting here is what made this class of failure invisible.
     */
    bootFailed(error);
    log.error('Failed to start', error);
    log.error(`The Master Panel is not usable. Open http://localhost:${config.http.port} to see why.`);

    installFailedShutdownHandlers(httpServer, postgres);
  }
}

function installShutdownHandlers(resources: {
  postgres: PostgresServerHandle;
  hub: RealtimeHub;
  discovery: DiscoveryResponder;
  httpServer: ReturnType<typeof createServer>;
  sessionSweep: NodeJS.Timeout;
}): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);

    clearInterval(resources.sessionSweep);
    await resources.discovery.stop().catch(() => {});
    await resources.hub.stop().catch(() => {});
    await new Promise<void>((resolve) => resources.httpServer.close(() => resolve()));
    await closeDatabase().catch(() => {});
    // Postgres is stopped last so nothing is mid-query when it goes down.
    await resources.postgres.stop().catch(() => {});

    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Ctrl-C has to work even when startup failed, and it has to stop a PostgreSQL
 * that got half-way up — otherwise the next launch meets its own leftover
 * cluster and fails differently.
 */
function installFailedShutdownHandlers(
  httpServer: ReturnType<typeof createServer>,
  postgres: PostgresServerHandle | null,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeDatabase().catch(() => {});
    await postgres?.stop().catch(() => {});
    process.exit(1);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Only reached if `main` itself could not open the port — there is no server
 * to report through, so the console is genuinely all there is.
 */
main().catch((error) => {
  bootFailed(error);
  log.error('Failed to start, and could not open a port to say so', error);
  process.exit(1);
});
