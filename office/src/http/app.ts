/**
 * The Office Panel's local API, consumed only by its own browser UI.
 *
 * Everything here either reports connection state or forwards a command to the
 * Master. This server intentionally stores nothing itself beyond the pairing
 * credentials.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { hasNetworkLink, listLanInterfaces } from '../lib/network.js';
import { masterConnection } from '../realtime/master-connection.js';
import { loadCredentials } from '../services/credentials.store.js';
import { PairingError, pairAutomatically, pairManually, scanForMasters } from '../services/pairing.service.js';
import { nextTemporaryId, refreshAfterPairing } from '../sync/device.js';
import * as localStore from '../sync/local-store.js';
import * as outbox from '../sync/outbox.store.js';
import * as sync from '../sync/sync.service.js';

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
      await refreshAfterPairing();
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
      await refreshAfterPairing();
      await masterConnection.connect();
      res.status(201).json({ ok: true, companyName: credentials.companyName });
    } catch (error) {
      respondToPairingError(res, error);
    }
  });

  // --- Data, forwarded to the Master ---

  /**
   * The panel's own view, not the Master's.
   *
   * Served from the local store so it includes work saved here but not yet
   * acknowledged — which is the entire point of the offline path. A panel
   * that has never synced has nothing to show and says so.
   */
  app.get('/api/snapshot', async (_req, res) => {
    const view = await localStore.getView();
    if (!view) {
      res.status(503).json({
        error: 'not_synced',
        message: 'This panel has not synced with the Master Panel yet',
      });
      return;
    }
    res.json(view);
  });

  app.get('/api/sync', async (_req, res) => {
    res.json({
      pendingCount: await outbox.pendingCount(),
      rejections: sync.recentRejections(),
      ...masterConnection.getStatus(),
    });
  });

  app.post('/api/sync/flush', async (_req, res) => {
    res.json(await sync.flush());
  });

  /**
   * Every write below queues a mutation and answers immediately.
   *
   * The panel does not wait for the Master, because staff cannot wait for the
   * Master — a customer is at the counter. The record exists locally the
   * moment this responds, carries a temporary id, and is reconciled on the
   * next flush.
   */
  app.post('/api/parties', (req, res) =>
    queue(res, { kind: 'party.create', entity: 'party', payload: req.body }),
  );
  app.put('/api/parties/:id', (req, res) =>
    queue(res, {
      kind: 'party.update',
      entity: 'party',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );

  app.post('/api/products', (req, res) =>
    queue(res, { kind: 'product.create', entity: 'product', payload: req.body }),
  );
  app.put('/api/products/:id', (req, res) =>
    queue(res, {
      kind: 'product.update',
      entity: 'product',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );

  app.post('/api/party-variants', (req, res) =>
    queue(res, { kind: 'partyVariant.upsert', entity: 'party_variant', payload: req.body }),
  );

  app.post('/api/leads', (req, res) =>
    queue(res, { kind: 'lead.create', entity: 'lead', payload: req.body }),
  );
  app.put('/api/leads/:id', (req, res) =>
    queue(res, {
      kind: 'lead.update',
      entity: 'lead',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );
  app.post('/api/leads/:id/stage', (req, res) =>
    queue(res, {
      kind: 'lead.setStage',
      entity: 'lead',
      entityId: req.params.id,
      payload: { stageId: req.body?.stageId, remark: req.body?.remark ?? null },
    }),
  );
  app.post('/api/leads/:id/remarks', (req, res) =>
    queue(res, {
      kind: 'lead.addRemark',
      entity: 'lead',
      entityId: req.params.id,
      payload: { message: req.body?.message },
    }),
  );
  app.post('/api/leads/:id/convert', (req, res) =>
    queue(res, {
      kind: 'lead.convert',
      entity: 'lead',
      entityId: req.params.id,
      payload: req.body ?? {},
    }),
  );

  app.put('/api/orders/:id', (req, res) =>
    queue(res, {
      kind: 'order.update',
      entity: 'order',
      entityId: req.params.id,
      payload: req.body,
      baseFieldHlc: req.body?.baseFieldHlc,
    }),
  );
  app.post('/api/orders/:id/stage', (req, res) =>
    queue(res, {
      kind: 'order.setStage',
      entity: 'order',
      entityId: req.params.id,
      payload: { stageId: req.body?.stageId, remark: req.body?.remark ?? null },
    }),
  );
  app.post('/api/orders/:id/dispatch', (req, res) =>
    queue(res, {
      kind: 'order.dispatch',
      entity: 'order',
      entityId: req.params.id,
      payload: { note: req.body?.note ?? null },
    }),
  );

  // Stock stays online-only. An unconfirmed quantity shown as real stock
  // would be worse than the last figure the Master actually agreed to.
  app.post('/api/stock/inbound', (req, res) => forward(res, 'stock:inbound', req.body));
  app.post('/api/stock/adjust', (req, res) => forward(res, 'stock:adjust', req.body));
  app.post('/api/stock/reorder-level', (req, res) =>
    forward(res, 'stock:setReorderLevel', req.body),
  );

  app.get('/api/search', (req, res) =>
    forward(res, 'search:query', { term: String(req.query.q ?? ''), limit: 20 }),
  );

  app.get('/api/conflicts', (_req, res) => forward(res, 'conflict:list', undefined));
  app.post('/api/conflicts/:id/resolve', (req, res) =>
    forward(res, 'conflict:resolve', {
      conflictId: Number(req.params.id),
      action: req.body?.action,
    }),
  );

  // --- Live updates to this panel's browser ---
  app.get('/api/events', (req, res) => streamEvents(req, res));

  const webDist = path.join(config.packageRoot, 'web', 'dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res, next) => {
    // See master/src/http/app.ts — web/dist is gitignored, so a fresh checkout
    // has no UI and would otherwise answer with a confusing JSON 404.
    if (!existsSync(path.join(webDist, 'index.html'))) {
      res.status(503).type('html').send(missingUiPage());
      return;
    }

    res.sendFile(path.join(webDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  return app;
}

/**
 * Queue a write locally and answer at once.
 *
 * A create with no id yet gets a temporary one here, which is what the browser
 * then uses to address the record — including for follow-up edits made before
 * the Master has ever seen it.
 */
async function queue(
  res: Response,
  request: {
    kind: outbox.EnqueueRequest['kind'];
    entity: outbox.EnqueueRequest['entity'];
    entityId?: string;
    payload: unknown;
    baseFieldHlc?: Record<string, string>;
  },
): Promise<void> {
  try {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    const entityId = request.entityId ?? (await nextTemporaryId());

    const mutation = await sync.submit({
      kind: request.kind,
      entity: request.entity,
      entityId,
      payload,
      fields: Object.keys(payload),
      baseFieldHlc: request.baseFieldHlc,
    });

    res.status(202).json({
      queued: true,
      id: entityId,
      mutationId: mutation.mutationId,
      pendingCount: await outbox.pendingCount(),
    });
  } catch (error) {
    log.error('Could not queue the change', error);
    res.status(500).json({
      error: 'queue_failed',
      message: 'Could not save locally — check disk space and permissions',
    });
  }
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

  // Both a fresh snapshot and a local queue change alter what the browser
  // should render, so both re-send the merged view rather than the raw one.
  const pushView = (): void => {
    void localStore.getView().then((view) => {
      if (view) send('snapshot', view);
    });
  };

  pushView();

  const onStatus = (status: unknown): void => send('status', status);
  const onChange = (value: unknown): void => send('change', value);
  const onConflict = (value: unknown): void => send('conflict', value);

  masterConnection.on('status', onStatus);
  masterConnection.on('snapshot', pushView);
  masterConnection.on('change', onChange);
  masterConnection.on('conflict', onConflict);
  const offSync = sync.onSyncEvent(pushView);

  // Proxies and some browsers drop an idle event stream; a periodic comment
  // keeps it open without sending meaningful traffic.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    offSync();
    masterConnection.off('status', onStatus);
    masterConnection.off('snapshot', pushView);
    masterConnection.off('change', onChange);
    masterConnection.off('conflict', onConflict);
  });
}

/** Shown when the Office Panel server runs but its frontend was never built. */
function missingUiPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>OrderBook — UI not built</title></head>
  <body style="font-family: 'Segoe UI', Tahoma, Arial, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1c2530; line-height: 1.55;">
    <h1 style="font-size: 22px;">The Office Panel is running, but its screens have not been built yet</h1>
    <p>The server answered this request, so it is working. What is missing is the
       compiled browser interface.</p>
    <p>Stop the server and run:</p>
    <pre style="background:#f0f4f8; border:1px solid #d8dee4; border-radius:6px; padding:12px 14px; overflow-x:auto;">npm run build
npm run dev:office</pre>
  </body>
</html>`;
}
