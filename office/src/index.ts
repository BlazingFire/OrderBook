/**
 * Office Panel entrypoint.
 *
 * Starts the local UI server immediately — even unpaired, because the
 * connection screen is what the operator needs first — then tries to restore
 * the link to the Master in the background.
 */

import { createServer } from 'node:http';

import { config } from './config/index.js';
import { createApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { hasNetworkLink } from './lib/network.js';
import { masterConnection } from './realtime/master-connection.js';
import { loadCredentials } from './services/credentials.store.js';
import * as userSession from './services/user-session.service.js';

const log = createLogger('office');

/*
 * At module scope, and registered before `main()` runs, so a panel killed
 * while it is still loading credentials still closes its port and its link
 * rather than dying where it stands. The mirror of `master/src/index.ts`.
 */
let httpServer: ReturnType<typeof createServer> | null = null;
let shuttingDown = false;

/** Extra teardown a subsystem registers for itself. See the master's copy. */
export const disposables: Array<() => void | Promise<void>> = [];

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${reason}, shutting down`);

  for (const dispose of disposables) {
    await Promise.resolve()
      .then(dispose)
      .catch(() => {});
  }

  masterConnection.disconnect();
  if (httpServer) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));

  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/*
 * Windows has no signals — `child.kill('SIGTERM')` there is `TerminateProcess`,
 * which the process cannot observe — so the desktop shell asks over IPC
 * instead, and `disconnect` stops this panel outliving a shell that died.
 * Both only fire when an IPC channel exists, so `npm run dev:office` is
 * unaffected.
 */
process.on('message', (message: unknown) => {
  if ((message as { type?: string } | null)?.type === 'orderbook:shutdown') {
    void shutdown('shutdown request');
  }
});
process.on('disconnect', () => void shutdown('parent gone'));

async function main(): Promise<void> {
  const app = createApp();
  const server = createServer(app);
  httpServer = server;

  // The link re-establishes the acting user on every reconnect; these two
  // events are how the outcome reaches the session. Wired here rather than
  // inside the connection so the transport keeps knowing nothing about sessions.
  masterConnection.on('user', (user) => {
    void userSession.refreshFrom(user as Parameters<typeof userSession.refreshFrom>[0]);
  });
  masterConnection.on('session:rejected', (reason) => {
    void userSession.rejectCurrent(reason as Parameters<typeof userSession.rejectCurrent>[0]);
  });
  masterConnection.on('reconcile', () => {
    void userSession.reconcileKnownUsers();
  });

  await new Promise<void>((resolve) => {
    server.listen(config.http.port, config.http.host, resolve);
  });

  log.info(`Office Panel ready at http://localhost:${config.http.port}`);
  if (!hasNetworkLink()) {
    log.warn('This PC does not appear to be on a network — the connection screen will say so');
  }

  const credentials = await loadCredentials();
  if (credentials) {
    log.info(`Reconnecting to Master at ${credentials.masterHost}:${credentials.masterPort}`);
    // Not awaited: a Master that is switched off must not block this panel
    // from serving its own connection screen.
    void masterConnection.connect();
  } else {
    log.info('Not paired yet — open the panel in a browser to connect to a Master');
  }

}

main().catch((error) => {
  log.error('Failed to start', error);
  process.exit(1);
});
