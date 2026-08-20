/**
 * Socket.IO hub. Authenticates every connection, serves Office Panel commands,
 * and fans out data changes so every open screen updates without polling.
 *
 * Commands run through the same services the Master's own HTTP API uses, so a
 * lead created from an Office Panel and one created on the Master are validated
 * identically.
 */

import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  ROOM_MASTER_ADMINS,
  ROOM_OFFICE_PANELS,
  type ClientToServerEvents,
  type CommandAck,
  type ServerToClientEvents,
  type SocketAuthPayload,
  type SocketData,
  type SyncSnapshot,
} from '@orderbook/shared';

import { toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { resolveSession } from '../services/auth.service.js';
import * as catalogService from '../services/catalog.service.js';
import { onChange } from '../services/change-bus.js';
import * as leadService from '../services/lead.service.js';
import * as panelService from '../services/panel.service.js';

const log = createLogger('realtime');

type PanelSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

export interface RealtimeHub {
  io: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
  stop(): Promise<void>;
}

export function createRealtimeHub(httpServer: HttpServer): RealtimeHub {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(httpServer, {
    // Same-origin for the Master's own UI; Office Panel servers connect from
    // another host on the LAN, so their origin is allowed explicitly.
    cors: { origin: true, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      await authenticate(socket as PanelSocket);
      next();
    } catch (error) {
      log.warn(`Rejected socket connection: ${toErrorMessage(error)}`);
      next(new Error(toErrorMessage(error)));
    }
  });

  io.on('connection', (socket) => {
    void handleConnection(io, socket as PanelSocket);
  });

  const unsubscribe = onChange((event) => {
    io.to(ROOM_OFFICE_PANELS).to(ROOM_MASTER_ADMINS).emit('data:changed', event);

    // Panel membership changes also change what the Master's panel screen and
    // dashboard should show, so those are refreshed as a pair.
    if (event.entity === 'office_panel') void broadcastPanels(io);
    if (event.entity === 'lead' || event.entity === 'party' || event.entity === 'product') {
      void broadcastDashboard(io);
    }
  });

  return {
    io,
    stop: async () => {
      unsubscribe();
      await io.close();
    },
  };
}

async function authenticate(socket: PanelSocket): Promise<void> {
  const auth = socket.handshake.auth as SocketAuthPayload | undefined;

  if (auth?.kind === 'office-panel') {
    const panel = await panelService.authenticatePanel(auth.panelId, auth.panelSecret);
    socket.data.kind = 'office-panel';
    socket.data.panelId = panel.id;
    return;
  }

  if (auth?.kind === 'master-admin') {
    if (!resolveSession(auth.sessionToken)) throw new Error('Session is not valid');
    socket.data.kind = 'master-admin';
    return;
  }

  throw new Error('Missing connection credentials');
}

async function handleConnection(
  io: RealtimeHub['io'],
  socket: PanelSocket,
): Promise<void> {
  if (socket.data.kind === 'master-admin') {
    await socket.join(ROOM_MASTER_ADMINS);
    socket.emit('panels:changed', await panelService.listPanelsWithPresence());
    socket.emit('dashboard:changed', await leadService.getDashboardSummary());
    return;
  }

  const panelId = socket.data.panelId;
  if (!panelId) return;

  await socket.join(ROOM_OFFICE_PANELS);
  await panelService.markPanelConnected(panelId, remoteAddress(socket));
  log.info(`Office panel connected: ${panelId}`);
  await broadcastPanels(io);

  registerCommands(socket, panelId);

  // A snapshot on connect means a panel that was offline catches up in one
  // round trip before incremental changes resume.
  socket.emit('sync:snapshot', await buildSnapshot());

  socket.on('disconnect', () => {
    void (async () => {
      await panelService.markPanelDisconnected(panelId);
      log.info(`Office panel disconnected: ${panelId}`);
      await broadcastPanels(io);
    })();
  });
}

function registerCommands(socket: PanelSocket, panelId: string): void {
  const actor: catalogService.ActorContext = { actorType: 'office_panel', actorId: panelId };

  socket.on('sync:request', (ack) => run(ack, () => buildSnapshot()));

  socket.on('party:list', (query, ack) => run(ack, () => catalogService.listParties(query)));
  socket.on('party:create', (input, ack) => run(ack, () => catalogService.createParty(input, actor)));
  socket.on('party:update', ({ id, input }, ack) =>
    run(ack, () => catalogService.updateParty(id, input, actor)),
  );

  socket.on('product:list', (query, ack) => run(ack, () => catalogService.listProducts(query)));
  socket.on('product:create', (input, ack) =>
    run(ack, () => catalogService.createProduct(input, actor)),
  );
  socket.on('product:update', ({ id, input }, ack) =>
    run(ack, () => catalogService.updateProduct(id, input, actor)),
  );

  socket.on('category:list', (ack) => run(ack, () => catalogService.listCategories()));

  socket.on('lead:list', (query, ack) => run(ack, () => leadService.listLeads(query)));
  socket.on('lead:get', (id, ack) => run(ack, () => leadService.getLead(id)));
  socket.on('lead:create', (input, ack) =>
    run(ack, () => leadService.createLead(input, { sourcePanelId: panelId, actor })),
  );
  socket.on('lead:setStatus', (input, ack) =>
    run(ack, () => leadService.changeLeadStatus(input.leadId, input.status, actor)),
  );
}

/**
 * Every command answers its ack exactly once — with data or with a readable
 * message. Throwing across the socket would leave the Office Panel's UI
 * waiting forever.
 */
function run<T>(ack: CommandAck<T>, operation: () => Promise<T>): void {
  if (typeof ack !== 'function') return;

  operation()
    .then((data) => ack({ ok: true, data }))
    .catch((error) => {
      log.warn(`Command failed: ${toErrorMessage(error)}`);
      ack({ ok: false, error: toErrorMessage(error) });
    });
}

async function buildSnapshot(): Promise<SyncSnapshot> {
  const [parties, products, categories, leads] = await Promise.all([
    catalogService.listParties({ limit: 500 }),
    catalogService.listProducts({ limit: 500 }),
    catalogService.listCategories(),
    leadService.listLeads({ limit: 500 }),
  ]);

  return {
    parties: parties.items,
    products: products.items,
    categories,
    leads: leads.items,
    serverTime: new Date().toISOString(),
  };
}

async function broadcastPanels(io: RealtimeHub['io']): Promise<void> {
  io.to(ROOM_MASTER_ADMINS).emit('panels:changed', await panelService.listPanelsWithPresence());
}

async function broadcastDashboard(io: RealtimeHub['io']): Promise<void> {
  io.to(ROOM_MASTER_ADMINS).emit('dashboard:changed', await leadService.getDashboardSummary());
}

function remoteAddress(socket: PanelSocket): string | null {
  const address = socket.handshake.address;
  if (!address) return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
