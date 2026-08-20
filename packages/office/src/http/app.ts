/**
 * The Office Panel's local API, consumed only by its own browser UI.
 *
 * Everything here either reports connection state or forwards a command to the
 * Master. This server intentionally stores nothing itself beyond the pairing
 * credentials.
 */

import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { hasNetworkLink, listLanInterfaces } from '../lib/network.js';
import { masterConnection } from '../realtime/master-connection.js';
import { loadCredentials } from '../services/credentials.store.js';
import { PairingError, pairAutomatically, pairManually, scanForMasters } from '../services/pairing.service.js';

const log = createLogger('http');

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // --- Connection screen ---

  app.get('/api/connection', async (_req, res) => {
    const credentials = await loadCredentials();
    res.json({
      // Two separate signals, because "no network" and "network but no Master"
      // need different advice on screen.
      hasNetworkLink: hasNetworkLink(),
      interfaces: listLanInterfaces(),
      isPaired: credentials !== null,
      panelName: config.panelName,
      ...masterConnection.getStatus(),
    });
  });

  app.post('/api/connection/scan', async (_req, res) => {
    try {
      res.json({ masters: await scanForMasters() });
    } catch (error) {
      log.warn('Scan failed', error);
      res.status(500).json({ error: 'scan_failed', message: 'Could not search the network' });
    }
  });

  app.post('/api/connection/pair/auto', async (req, res) => {
    try {
      const credentials = await pairAutomatically(req.body?.panelName);
      await masterConnection.connect();
      res.status(201).json({ ok: true, companyName: credentials.companyName });
    } catch (error) {
      respondToPairingError(res, error);
    }
  });

  app.post('/api/connection/pair/manual', async (req, res) => {
    const { host, port, pairingPassword, masterUniqueId, panelName } = req.body ?? {};

    if (typeof host !== 'string' || !host || typeof pairingPassword !== 'string' || !pairingPassword) {
      res.status(400).json({ error: 'invalid_request', message: 'Enter the Master address and pairing password' });
      return;
    }

    try {
      const credentials = await pairManually({
        host,
        port: Number(port) || 4100,
        pairingPassword,
        masterUniqueId: typeof masterUniqueId === 'string' && masterUniqueId ? masterUniqueId : undefined,
        panelName: typeof panelName === 'string' && panelName ? panelName : undefined,
      });
      await masterConnection.connect();
      res.status(201).json({ ok: true, companyName: credentials.companyName });
    } catch (error) {
      respondToPairingError(res, error);
    }
  });

  // --- Data, forwarded to the Master ---

  app.get('/api/snapshot', (_req, res) => {
    const snapshot = masterConnection.getSnapshot();
    if (!snapshot) {
      res.status(503).json({ error: 'not_synced', message: 'Not connected to the Master Panel yet' });
      return;
    }
    res.json(snapshot);
  });

  app.post('/api/parties', (req, res) => forward(res, 'party:create', req.body));
  app.put('/api/parties/:id', (req, res) =>
    forward(res, 'party:update', { id: req.params.id, input: req.body }),
  );

  app.post('/api/products', (req, res) => forward(res, 'product:create', req.body));
  app.put('/api/products/:id', (req, res) =>
    forward(res, 'product:update', { id: req.params.id, input: req.body }),
  );

  app.post('/api/leads', (req, res) => forward(res, 'lead:create', req.body));
  app.post('/api/leads/:id/status', (req, res) =>
    forward(res, 'lead:setStatus', { leadId: req.params.id, status: req.body?.status }),
  );

  // --- Live updates to this panel's browser ---
  app.get('/api/events', (req, res) => streamEvents(req, res));

  const webDist = path.join(config.packageRoot, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res, next) => {
    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  return app;
}

async function forward(res: Response, event: string, payload: unknown): Promise<void> {
  try {
    const data = await masterConnection.command(event as never, payload);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    // 502: this panel is fine, the Master rejected or could not be reached.
    res.status(502).json({ error: 'master_command_failed', message });
  }
}

function respondToPairingError(res: Response, error: unknown): void {
  if (error instanceof PairingError) {
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  log.error('Pairing failed', error);
  res.status(500).json({ error: 'pairing_failed', message: 'Pairing failed unexpectedly' });
}

/**
 * Server-sent events rather than another Socket.IO hop: the browser only ever
 * listens here, and SSE reconnects on its own with no extra client library.
 */
function streamEvents(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (type: string, data: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', masterConnection.getStatus());
  const snapshot = masterConnection.getSnapshot();
  if (snapshot) send('snapshot', snapshot);

  const onStatus = (status: unknown): void => send('status', status);
  const onSnapshot = (value: unknown): void => send('snapshot', value);
  const onChange = (value: unknown): void => send('change', value);

  masterConnection.on('status', onStatus);
  masterConnection.on('snapshot', onSnapshot);
  masterConnection.on('change', onChange);

  // Proxies and some browsers drop an idle event stream; a periodic comment
  // keeps it open without sending meaningful traffic.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    masterConnection.off('status', onStatus);
    masterConnection.off('snapshot', onSnapshot);
    masterConnection.off('change', onChange);
  });
}
