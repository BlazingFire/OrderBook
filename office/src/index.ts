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

const log = createLogger('office');

async function main(): Promise<void> {
  const app = createApp();
  const httpServer = createServer(app);

  await new Promise<void>((resolve) => {
    httpServer.listen(config.http.port, config.http.host, resolve);
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

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Received ${signal}, shutting down`);
    masterConnection.disconnect();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error('Failed to start', error);
  process.exit(1);
});
