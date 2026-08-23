/**
 * Socket.IO hub. Authenticates every connection, serves Office Panel commands,
 * and fans out data changes so every open screen updates without polling.
 *
 * Commands run through the same services the Master's own HTTP API uses, so a
 * lead raised from an Office Panel and one progressed on the Master are
 * validated — and permission-checked — identically. The hub itself is pure
 * transport: it holds no business rules and assembles no payloads.
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
} from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { AppError, ForbiddenError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import { findById as findUserById } from '../repositories/user.repository.js';
import { resolveSession } from '../services/auth.service.js';
import * as catalogService from '../services/catalog.service.js';
import { onChange, onConflict } from '../services/change-bus.js';
import * as conflictService from '../services/conflict.service.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as inventoryService from '../services/inventory.service.js';
import * as leadService from '../services/lead.service.js';
import * as orderService from '../services/order.service.js';
import * as panelService from '../services/panel.service.js';
import * as searchService from '../services/search.service.js';
import { buildSnapshot } from '../services/snapshot.service.js';
import * as syncService from '../services/sync.service.js';

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

  const unsubscribeChanges = onChange((event) => {
    io.to(ROOM_OFFICE_PANELS).to(ROOM_MASTER_ADMINS).emit('data:changed', event);

    // Panel membership changes also change what the Master's panel screen and
    // dashboard should show, so those are refreshed as a pair.
    if (event.entity === 'office_panel') void broadcastPanels(io);

    if (DASHBOARD_ENTITIES.has(event.entity)) void broadcastDashboard(io);
  });

  const unsubscribeConflicts = onConflict((conflict) => {
    io.to(ROOM_OFFICE_PANELS).to(ROOM_MASTER_ADMINS).emit('sync:conflict', conflict);
    void broadcastDashboard(io);
  });

  return {
    io,
    stop: async () => {
      unsubscribeChanges();
      unsubscribeConflicts();
      await io.close();
    },
  };
}

/** Changes that move a number on the dashboard. */
const DASHBOARD_ENTITIES = new Set(['lead', 'order', 'party', 'product', 'stock', 'sync_conflict']);

async function authenticate(socket: PanelSocket): Promise<void> {
  const auth = socket.handshake.auth as SocketAuthPayload | undefined;

  if (auth?.kind === 'office-panel') {
    const panel = await panelService.authenticatePanel(auth.panelId, auth.panelSecret);
    socket.data.kind = 'office-panel';
    socket.data.panelId = panel.id;
    socket.data.tenantId = panel.tenantId;
    socket.data.deviceCode = panel.deviceCode;
    return;
  }

  if (auth?.kind === 'master-admin') {
    const user = await resolveSession(auth.sessionToken);
    if (!user) throw new Error('Session is not valid');

    socket.data.kind = 'master-admin';
    socket.data.tenantId = user.tenantId;
    socket.data.userId = user.id;
    return;
  }

  throw new Error('Missing connection credentials');
}

async function handleConnection(io: RealtimeHub['io'], socket: PanelSocket): Promise<void> {
  if (socket.data.kind === 'master-admin') {
    const actor = await adminActor(socket);
    await socket.join(ROOM_MASTER_ADMINS);
    socket.emit('panels:changed', await panelService.listPanelsWithPresence(actor.tenantId));
    socket.emit('dashboard:changed', await dashboardService.getDashboardSummary(actor));
    return;
  }

  const panelId = socket.data.panelId;
  if (!panelId) return;

  await socket.join(ROOM_OFFICE_PANELS);
  await panelService.markPanelConnected(panelId, remoteAddress(socket));
  log.info(`Office panel connected: ${panelId}`);
  await broadcastPanels(io);

  const actor = await panelActor(socket, panelId);
  registerCommands(socket, actor);

  // A snapshot on connect means a panel that was offline catches up in one
  // round trip before incremental changes resume.
  socket.emit('sync:snapshot', await buildSnapshot(actor));

  socket.on('disconnect', () => {
    void (async () => {
      await panelService.markPanelDisconnected(panelId);
      log.info(`Office panel disconnected: ${panelId}`);
      await broadcastPanels(io);
    })();
  });
}

function registerCommands(socket: PanelSocket, actor: ActorContext): void {
  socket.on('sync:request', (ack) => run(ack, () => buildSnapshot(actor)));
  socket.on('sync:push', (request, ack) => run(ack, () => syncService.applyPush(request, actor)));

  socket.on('party:list', (query, ack) => run(ack, () => catalogService.listParties(query, actor)));
  socket.on('party:create', (input, ack) =>
    run(ack, () => catalogService.createParty(input, actor)),
  );
  socket.on('party:update', ({ id, input }, ack) =>
    run(ack, () => catalogService.updateParty(id, input, actor)),
  );

  socket.on('product:list', (query, ack) =>
    run(ack, () => catalogService.listProducts(query, actor)),
  );
  socket.on('product:create', (input, ack) =>
    run(ack, () => catalogService.createProduct(input, actor)),
  );
  socket.on('product:update', ({ id, input }, ack) =>
    run(ack, () => catalogService.updateProduct(id, input, actor)),
  );

  socket.on('category:list', (ack) => run(ack, () => catalogService.listCategories(actor)));

  socket.on('partyVariant:list', (partyId, ack) =>
    run(ack, () => catalogService.listVariantsForParty(partyId, actor)),
  );
  socket.on('partyVariant:upsert', (input, ack) =>
    run(ack, () => catalogService.upsertVariant(input, actor)),
  );

  socket.on('lead:list', (query, ack) => run(ack, () => leadService.listLeads(query, actor)));
  socket.on('lead:get', (id, ack) => run(ack, () => leadService.getLead(id, actor)));
  socket.on('lead:create', (input, ack) => run(ack, () => leadService.createLead(input, actor)));
  socket.on('lead:update', ({ id, input }, ack) =>
    run(ack, () => leadService.updateLead(id, input, actor)),
  );
  socket.on('lead:setStage', (input, ack) => run(ack, () => leadService.setStage(input, actor)));
  socket.on('lead:addRemark', (input, ack) => run(ack, () => leadService.addRemark(input, actor)));
  socket.on('lead:convert', (input, ack) => run(ack, () => orderService.convertLead(input, actor)));

  socket.on('order:list', (query, ack) => run(ack, () => orderService.listOrders(query, actor)));
  socket.on('order:get', (id, ack) => run(ack, () => orderService.getOrder(id, actor)));
  socket.on('order:update', ({ id, input }, ack) =>
    run(ack, () => orderService.updateOrder(id, input, actor)),
  );
  socket.on('order:setStage', (input, ack) => run(ack, () => orderService.setStage(input, actor)));
  socket.on('order:dispatch', (input, ack) =>
    run(ack, () => orderService.dispatchOrder(input, actor)),
  );

  socket.on('stock:list', (query, ack) => run(ack, () => inventoryService.listStock(query, actor)));
  socket.on('stock:movements', (query, ack) =>
    run(ack, () => inventoryService.listMovements(query, actor)),
  );
  socket.on('stock:inbound', (input, ack) =>
    run(ack, () => inventoryService.recordInbound(input, actor)),
  );
  socket.on('stock:adjust', (input, ack) =>
    run(ack, () => inventoryService.recordAdjustment(input, actor)),
  );
  socket.on('stock:setReorderLevel', (input, ack) =>
    run(ack, () => inventoryService.setReorderLevel(input, actor)),
  );

  socket.on('search:query', (query, ack) => run(ack, () => searchService.search(query, actor)));

  socket.on('pipeline:list', (ack) => run(ack, () => pipelineRepo.listPipelines(actor.tenantId)));

  socket.on('conflict:list', (ack) => run(ack, () => conflictService.listConflicts(actor)));
  socket.on('conflict:resolve', (input, ack) =>
    run(ack, () => conflictService.resolveConflict(input, actor)),
  );
}

/**
 * Every command answers its ack exactly once — with data or with a readable
 * message. Throwing across the socket would leave the Office Panel's UI
 * waiting forever.
 *
 * A refused permission carries its key alongside the message, so the panel can
 * hide the control rather than only showing the failure.
 */
function run<T>(ack: CommandAck<T>, operation: () => Promise<T>): void {
  if (typeof ack !== 'function') return;

  operation()
    .then((data) => ack({ ok: true, data }))
    .catch((error: unknown) => {
      log.warn(`Command failed: ${toErrorMessage(error)}`);

      if (error instanceof ForbiddenError) {
        ack({ ok: false, error: error.message, missingPermission: error.permission });
        return;
      }

      ack({ ok: false, error: toErrorMessage(error) });
    });
}

/**
 * The actor for an Office Panel command.
 *
 * A panel acts on behalf of the user the Master associated with it. Where none
 * is set, the panel gets the seeded Office role — a panel with no permissions
 * at all could not raise a lead, which is the one thing it exists to do.
 */
async function panelActor(socket: PanelSocket, panelId: string): Promise<ActorContext> {
  const tenantId = socket.data.tenantId;
  if (!tenantId) throw new AppError('Panel has no tenant', 500, 'internal');

  const permissions = await panelService.permissionsForPanel(tenantId, panelId);

  return {
    tenantId,
    actorType: 'office_panel',
    actorId: panelId,
    userId: null,
    permissions,
    deviceCode: socket.data.deviceCode ?? null,
  };
}

async function adminActor(socket: PanelSocket): Promise<ActorContext> {
  const tenantId = socket.data.tenantId;
  const userId = socket.data.userId ?? null;
  if (!tenantId) throw new AppError('Session has no tenant', 500, 'internal');

  const user = userId ? await findUserById(tenantId, userId) : null;

  return {
    tenantId,
    actorType: 'user',
    actorId: userId,
    userId,
    permissions: await permissionSetForRole(user?.roleId ?? null),
    deviceCode: null,
  };
}

async function broadcastPanels(io: RealtimeHub['io']): Promise<void> {
  const sockets = await io.in(ROOM_MASTER_ADMINS).fetchSockets();
  const tenants = new Set(sockets.map((socket) => socket.data.tenantId).filter(Boolean));

  for (const tenantId of tenants) {
    io.to(ROOM_MASTER_ADMINS).emit('panels:changed', await panelService.listPanelsWithPresence(tenantId));
  }
}

async function broadcastDashboard(io: RealtimeHub['io']): Promise<void> {
  const sockets = await io.in(ROOM_MASTER_ADMINS).fetchSockets();

  for (const socket of sockets) {
    const tenantId = socket.data.tenantId;
    const userId = socket.data.userId ?? null;
    if (!tenantId) continue;

    const user = userId ? await findUserById(tenantId, userId) : null;
    const summary = await dashboardService.getDashboardSummary({
      tenantId,
      actorType: 'user',
      actorId: userId,
      userId,
      permissions: await permissionSetForRole(user?.roleId ?? null),
      deviceCode: null,
    });

    socket.emit('dashboard:changed', summary);
  }
}

function remoteAddress(socket: PanelSocket): string | null {
  const address = socket.handshake.address;
  if (!address) return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
