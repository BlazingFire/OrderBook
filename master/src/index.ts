/**
 * Master Panel entrypoint.
 *
 * Startup order matters: the database must be up and migrated before anything
 * can serve requests, and discovery must not advertise this Master until it
 * can actually accept a pairing request.
 */

import { createServer } from 'node:http';
import fs from 'node:fs/promises';

import { config } from './config/index.js';
import { startPostgres, type PostgresServerHandle } from './db/postgres-server.js';
import { closeDatabase, initDatabase, runMigrations } from './db/knex.js';
import { startDiscoveryResponder, type DiscoveryResponder } from './discovery/responder.js';
import { createApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { listLanAddresses } from './lib/network.js';
import { createRealtimeHub, type RealtimeHub } from './realtime/hub.js';
import { purgeExpiredSessions } from './services/auth.service.js';
import { isSetupComplete, refreshStoredLanIp } from './services/setup.service.js';

const log = createLogger('master');

const SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  await fs.mkdir(config.uploadsDir, { recursive: true });

  const postgres = await startPostgres();
  initDatabase(postgres.connectionUrl);
  await runMigrations();

  if (await isSetupComplete()) {
    await refreshStoredLanIp();
  } else {
    log.info('No configuration found — the browser will show the first-run setup screen');
  }

  const app = createApp();
  const httpServer = createServer(app);
  const hub = createRealtimeHub(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(config.http.port, config.http.host, resolve);
  });

  const discovery = await startDiscoveryResponder();
  const sessionSweep = setInterval(purgeExpiredSessions, SESSION_SWEEP_INTERVAL_MS);

  for (const address of listLanAddresses()) {
    log.info(`Master Panel ready at http://${address}:${config.http.port}`);
  }
  log.info(`Master Panel ready at http://localhost:${config.http.port}`);

  installShutdownHandlers({ postgres, hub, discovery, httpServer, sessionSweep });
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

main().catch((error) => {
  log.error('Failed to start', error);
  process.exit(1);
});
