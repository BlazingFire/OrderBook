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
  type CommandResult,
  type ServerToClientEvents,
  type SocketAuthPayload,
  type SocketData,
} from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { MAX_SOURCE_BYTES } from '../domain/images.js';
import { AppError, ForbiddenError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { setPanelLink, type PanelRequest } from './panel-link.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as authService from '../services/auth.service.js';
import { resolveSession } from '../services/auth.service.js';
import * as catalogService from '../services/catalog.service.js';
import { onChange, onConflict } from '../services/change-bus.js';
import * as conflictService from '../services/conflict.service.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as documentService from '../services/document.service.js';
import * as documentRenderService from '../services/document-render.service.js';
import * as fieldsService from '../services/fields.service.js';
import * as inventoryService from '../services/inventory.service.js';
import * as leadService from '../services/lead.service.js';
import * as panelCredentialRepo from '../repositories/panel-credential.repository.js';
import * as orderService from '../services/order.service.js';
import { resolvePanelActor } from '../services/panel-actor.service.js';
import * as logService from '../services/log.service.js';
import * as reportService from '../services/report.service.js';
import * as imageService from '../services/image.service.js';
import * as panelService from '../services/panel.service.js';
import * as recycleBinService from '../services/recycle-bin.service.js';
import * as searchService from '../services/search.service.js';
import { buildSnapshot } from '../services/snapshot.service.js';
import * as syncService from '../services/sync.service.js';

const log = createLogger('realtime');

type PanelSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

/**
 * Live Office Panel sockets by panel id.
 *
 * Kept beside the `office-panels` room rather than as a room-per-panel: the
 * administration path has to *await an acknowledgement* from one specific
 * panel, and `fetchSockets()` hands back remote-socket handles that cannot
 * carry one. A panel that reconnects replaces its entry, and `disconnect`
 * removes it only when the socket leaving is the one on file — otherwise a
 * slow teardown of the old socket would evict the new one.
 */
const panelSockets = new Map<string, PanelSocket>();

/** How long the Master waits for a panel to answer an administrative request. */
const PANEL_REQUEST_TIMEOUT_MS = 20_000;

export interface RealtimeHub {
  io: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
  stop(): Promise<void>;
}

export function createRealtimeHub(httpServer: HttpServer): RealtimeHub {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(httpServer, {
    // Same-origin for the Master's own UI; Office Panel servers connect from
    // another host on the LAN, so their origin is allowed explicitly.
    cors: { origin: true, credentials: true },
    // Default is 1 MB, far below a source photo (`domain/images.ts`'s
    // `MAX_SOURCE_BYTES`) — `product:image:upload`/`image:fetch` carry raw
    // image bytes as binary attachments over this same command channel.
    maxHttpBufferSize: MAX_SOURCE_BYTES,
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

  // Panel administration runs the other way to everything else here: the
  // Master asks a panel to do something. `panel-link.ts` is the seam that lets
  // `panel.service.ts` do that without importing this file back — see its
  // header. Registered on creation, cleared on `stop()`, so a service holding
  // it can always tell a closed hub from an unreachable panel.
  setPanelLink({
    isConnected: (panelId) => panelSockets.has(panelId),
    request: (panelId, event, payload) => requestFromPanel(panelSockets.get(panelId), event, payload),
    disconnect: (panelId) => {
      const socket = panelSockets.get(panelId);
      if (!socket) return false;
      socket.disconnect(true);
      return true;
    },
    notify: (panelId, event) => {
      const socket = panelSockets.get(panelId);
      if (!socket) return false;
      (socket.emit as (name: string) => void)(event);
      return true;
    },
  });

  const unsubscribeChanges = onChange((event) => {
    // The Master's own screens are the only ones that manage roles and users, and
    // the only ones entitled to the payload. Broadcasting a `user` row to every
    // paired panel handed each of them the whole staff list — username, display
    // name, role, tier, active flag, last sign-in — and every role's complete
    // permission array, with no per-recipient check, while the equivalent
    // *request* path correctly requires `users.manage`. No panel consumes these
    // events, so withholding them costs nothing.
    if (!DIRECTORY_ENTITIES.has(event.entity)) {
      io.to(ROOM_OFFICE_PANELS).emit('data:changed', event);
    }

    io.to(ROOM_MASTER_ADMINS).emit('data:changed', event);

    // Panel membership changes also change what the Master's panel screen and
    // dashboard should show, so those are refreshed as a pair.
    if (event.entity === 'office_panel') {
      void broadcastPanels(io);

      // A revoked panel is told while it is still connected, so it clears its
      // stored credentials and drops to the pairing screen immediately. Without
      // this it keeps running on a dead pairing until it next reconnects — which
      // for an idle panel can be hours, and looks to the operator like the panel
      // still being trusted.
      if ((event.payload as { status?: string } | null)?.status === 'revoked') {
        void notifyPanelRevoked(io, event.id);
      }
    }

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
      setPanelLink(null);
      panelSockets.clear();
      await io.close();
    },
  };
}

/**
 * Company directory data, which an Office Panel has no business receiving
 * unsolicited. It can still *ask*, and the service checks `users.manage` then.
 *
 * `document_export` is here because an export row names the lead or order it
 * was rendered for, and a panel may hold `documents.view` without holding
 * `leads.view` — broadcasting the row would hand it a subject id and label it
 * is not entitled to. `document_template` is deliberately **not** here: a
 * template is configuration gated by `documents.view` and carries no record
 * data at all.
 */
const DIRECTORY_ENTITIES = new Set<string>(['role', 'user', 'document_export']);

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
    socket.data.sessionToken = auth.sessionToken;
    return;
  }

  throw new Error('Missing connection credentials');
}

async function handleConnection(io: RealtimeHub['io'], socket: PanelSocket): Promise<void> {
  if (socket.data.kind === 'master-admin') {
    const actor = await adminActor(socket);
    if (!actor) {
      socket.disconnect(true);
      return;
    }

    await socket.join(ROOM_MASTER_ADMINS);
    socket.emit('panels:changed', await panelService.listPanelsWithPresence(actor.tenantId));
    socket.emit('dashboard:changed', await dashboardService.getDashboardSummary(actor));
    return;
  }

  const panelId = socket.data.panelId;
  if (!panelId) return;

  await socket.join(ROOM_OFFICE_PANELS);
  panelSockets.set(panelId, socket);
  await panelService.markPanelConnected(panelId, remoteAddress(socket));
  log.info(`Office panel connected: ${panelId}`);
  await broadcastPanels(io);

  const actorFor = (): Promise<ActorContext> => panelActor(socket, panelId);

  // Whose snapshot this is depends on who is signed in, and the snapshot carries
  // the permission set the panel's UI renders from — so signing in or out has to
  // re-send it, or the screens would keep showing the previous person's view.
  const sendSnapshot = (): void => {
    void actorFor()
      .then(buildSnapshot)
      .then((snapshot) => socket.emit('sync:snapshot', snapshot))
      .catch((error: unknown) => log.warn(`Could not build snapshot: ${toErrorMessage(error)}`));
  };

  registerCommands(socket, actorFor);
  registerAuthCommands(socket, sendSnapshot);

  // A snapshot on connect means a panel that was offline catches up in one
  // round trip before incremental changes resume.
  socket.emit('sync:snapshot', await buildSnapshot(await actorFor()));

  socket.on('disconnect', () => {
    void (async () => {
      // Only if this socket is still the one on file: a panel that reconnected
      // before its old socket finished tearing down has already replaced the
      // entry, and evicting it here would make a live panel look offline.
      if (panelSockets.get(panelId) === socket) panelSockets.delete(panelId);
      await panelService.markPanelDisconnected(panelId);
      log.info(`Office panel disconnected: ${panelId}`);
      await broadcastPanels(io);
    })();
  });
}

/**
 * Wire every command on a panel socket.
 *
 * The actor is resolved **per command**, not captured once, because a person can
 * sign in and out on this panel while the socket stays up — and because their
 * role can be edited on the Master mid-session. Capturing it at connection time
 * is how a revoked permission survives until the next reconnect
 * (docs/ROLES_AND_USERS.md §13).
 */
function registerCommands(socket: PanelSocket, actorFor: () => Promise<ActorContext>): void {
  const run = <T>(ack: CommandAck<T>, operation: (actor: ActorContext) => Promise<T>): void =>
    respond(ack, async () => operation(await actorFor()));

  // Not `run`: this is the panel describing *itself*, so it needs no actor and
  // no permission — a panel may always say what it is. Everything it reports is
  // about its own machine and nothing else's.
  socket.on('panel:report', (report, ack) =>
    respond(ack, async () => {
      const panelId = socket.data.panelId;
      if (panelId) await panelService.recordPanelReport(panelId, report);
      return null;
    }),
  );

  socket.on('sync:request', (ack) => run(ack, (actor) => buildSnapshot(actor)));
  socket.on('sync:push', (request, ack) =>
    run(ack, (actor) => syncService.applyPush(request, actor)),
  );

  socket.on('party:list', (query, ack) =>
    run(ack, (actor) => catalogService.listParties(query, actor)),
  );
  socket.on('party:create', (input, ack) =>
    run(ack, (actor) => catalogService.createParty(input, actor)),
  );
  socket.on('party:update', ({ id, input }, ack) =>
    run(ack, (actor) => catalogService.updateParty(id, input, actor)),
  );
  socket.on('party:delete', (id, ack) => run(ack, (actor) => catalogService.deleteParty(id, actor)));

  socket.on('product:list', (query, ack) =>
    run(ack, (actor) => catalogService.listProducts(query, actor)),
  );
  socket.on('product:create', (input, ack) =>
    run(ack, (actor) => catalogService.createProduct(input, actor)),
  );
  socket.on('product:update', ({ id, input }, ack) =>
    run(ack, (actor) => catalogService.updateProduct(id, input, actor)),
  );
  socket.on('product:delete', (id, ack) => run(ack, (actor) => catalogService.deleteProduct(id, actor)));

  socket.on('product:image:upload', ({ productId, file, crop }, ack) =>
    run(ack, (actor) =>
      imageService.uploadImage({ productId, fileBuffer: Buffer.from(file), crop }, actor),
    ),
  );
  socket.on('product:image:update', ({ id, input }, ack) =>
    run(ack, (actor) => imageService.updateImageCaption(id, input, actor)),
  );
  socket.on('product:image:reorder', (input, ack) =>
    run(ack, (actor) => imageService.reorderImages(input, actor)),
  );
  socket.on('product:image:delete', (id, ack) => run(ack, (actor) => imageService.deleteImage(id, actor)));
  socket.on('image:fetch', ({ imageId, variant }, ack) =>
    run(ack, (actor) => imageService.imageFileBytes(imageId, variant, actor)),
  );

  socket.on('category:list', (ack) => run(ack, (actor) => catalogService.listCategories(actor)));

  socket.on('partyVariant:list', (partyId, ack) =>
    run(ack, (actor) => catalogService.listVariantsForParty(partyId, actor)),
  );
  socket.on('partyVariant:upsert', (input, ack) =>
    run(ack, (actor) => catalogService.upsertVariant(input, actor)),
  );

  socket.on('lead:list', (query, ack) => run(ack, (actor) => leadService.listLeads(query, actor)));
  socket.on('lead:get', (id, ack) => run(ack, (actor) => leadService.getLead(id, actor)));
  socket.on('lead:create', (input, ack) =>
    run(ack, (actor) => leadService.createLead(input, actor)),
  );
  socket.on('lead:update', ({ id, input }, ack) =>
    run(ack, (actor) => leadService.updateLead(id, input, actor)),
  );
  socket.on('lead:setStage', (input, ack) =>
    run(ack, (actor) => leadService.setStage(input, actor)),
  );
  socket.on('lead:addRemark', (input, ack) =>
    run(ack, (actor) => leadService.addRemark(input, actor)),
  );
  socket.on('lead:convert', (input, ack) =>
    run(ack, (actor) => orderService.convertLead(input, actor)),
  );
  socket.on('lead:delete', (id, ack) => run(ack, (actor) => leadService.deleteLead(id, actor)));

  socket.on('order:list', (query, ack) =>
    run(ack, (actor) => orderService.listOrders(query, actor)),
  );
  socket.on('order:get', (id, ack) => run(ack, (actor) => orderService.getOrder(id, actor)));
  socket.on('order:update', ({ id, input }, ack) =>
    run(ack, (actor) => orderService.updateOrder(id, input, actor)),
  );
  socket.on('order:setStage', (input, ack) =>
    run(ack, (actor) => orderService.setStage(input, actor)),
  );
  socket.on('order:dispatch', (input, ack) =>
    run(ack, (actor) => orderService.dispatchOrder(input, actor)),
  );
  socket.on('order:delete', (id, ack) => run(ack, (actor) => orderService.deleteOrder(id, actor)));

  socket.on('stock:list', (query, ack) =>
    run(ack, (actor) => inventoryService.listStock(query, actor)),
  );
  socket.on('stock:movements', (query, ack) =>
    run(ack, (actor) => inventoryService.listMovements(query, actor)),
  );
  socket.on('stock:inbound', (input, ack) =>
    run(ack, (actor) => inventoryService.recordInbound(input, actor)),
  );
  socket.on('stock:adjust', (input, ack) =>
    run(ack, (actor) => inventoryService.recordAdjustment(input, actor)),
  );
  socket.on('stock:setReorderLevel', (input, ack) =>
    run(ack, (actor) => inventoryService.setReorderLevel(input, actor)),
  );

  socket.on('search:query', (query, ack) =>
    run(ack, (actor) => searchService.search(query, actor)),
  );

  socket.on('pipeline:list', (ack) =>
    run(ack, (actor) => pipelineRepo.listPipelines(actor.tenantId)),
  );

  socket.on('conflict:list', (ack) => run(ack, (actor) => conflictService.listConflicts(actor)));
  socket.on('conflict:resolve', (input, ack) =>
    run(ack, (actor) => conflictService.resolveConflict(input, actor)),
  );

  socket.on('recycleBin:list', (query, ack) =>
    run(ack, (actor) => recycleBinService.listBin(query, actor)),
  );
  socket.on('recycleBin:counts', (ack) => run(ack, (actor) => recycleBinService.binCounts(actor)));
  socket.on('recycleBin:restore', (input, ack) =>
    run(ack, (actor) => recycleBinService.restoreEntity(input, actor)),
  );

  socket.on('fields:catalogue', (ack) => run(ack, (actor) => Promise.resolve(fieldsService.fieldsCatalogue(actor))));
  socket.on('fields:values', (query, ack) => run(ack, (actor) => fieldsService.listValues(query, actor)));
  socket.on('fields:usage', (query, ack) => run(ack, (actor) => fieldsService.fieldUsage(query, actor)));
  socket.on('fields:createValue', (input, ack) =>
    run(ack, (actor) => fieldsService.createValue(input, actor)),
  );
  socket.on('fields:updateValue', ({ id, input }, ack) =>
    run(ack, (actor) => fieldsService.updateValue(id, input, actor)),
  );
  socket.on('fields:deleteValue', (id, ack) => run(ack, (actor) => fieldsService.deleteValue(id, actor)));
  socket.on('fields:reorderValues', (input, ack) =>
    run(ack, (actor) => fieldsService.reorderValues(input, actor)),
  );

  socket.on('fields:definitions', (query, ack) =>
    run(ack, (actor) => fieldsService.listDefinitions(query, actor)),
  );
  socket.on('fields:createDefinition', (input, ack) =>
    run(ack, (actor) => fieldsService.createDefinition(input, actor)),
  );
  socket.on('fields:updateDefinition', ({ id, input }, ack) =>
    run(ack, (actor) => fieldsService.updateDefinition(id, input, actor)),
  );
  socket.on('fields:deleteDefinition', (id, ack) =>
    run(ack, (actor) => fieldsService.deleteDefinition(id, actor)),
  );
  socket.on('fields:reorderDefinitions', (input, ack) =>
    run(ack, (actor) => fieldsService.reorderDefinitions(input, actor)),
  );

  socket.on('fields:stages', (ack) => run(ack, (actor) => fieldsService.listStages(actor)));
  socket.on('fields:updateStage', ({ id, input }, ack) =>
    run(ack, (actor) => fieldsService.updateStage(id, input, actor)),
  );
  socket.on('fields:reorderStages', (input, ack) =>
    run(ack, (actor) => fieldsService.reorderStages(input, actor)),
  );
  socket.on('fields:archiveStage', (id, ack) => run(ack, (actor) => fieldsService.archiveStage(id, actor)));
  socket.on('fields:restoreStage', (id, ack) => run(ack, (actor) => fieldsService.restoreStage(id, actor)));

  socket.on('log:list', (query, ack) => run(ack, (actor) => logService.listLogs(query, actor)));
  socket.on('log:facets', (query, ack) => run(ack, (actor) => logService.listLogFacets(query, actor)));
  socket.on('log:verifyChain', (input, ack) => run(ack, (actor) => logService.verifyLogChain(input, actor)));
  socket.on('log:export', (query, ack) => run(ack, (actor) => logService.exportLogs(query, actor)));

  socket.on('report:dispatches', (query, ack) => run(ack, (actor) => reportService.dispatchReport(query, actor)));
  socket.on('report:leadOutcomes', (query, ack) =>
    run(ack, (actor) => reportService.leadOutcomeReport(query, actor)),
  );
  socket.on('report:topParties', (query, ack) => run(ack, (actor) => reportService.topPartiesReport(query, actor)));
  socket.on('report:export', (payload, ack) =>
    run(ack, (actor) => reportService.exportReport(payload.report, payload.query, actor)),
  );

  // PDF Designer. Every one delegates to the identical service function the
  // HTTP route calls — the service's own `requirePermission` is the only gate
  // on this path, because no Express middleware runs here.
  socket.on('document:listTemplates', (query, ack) =>
    run(ack, (actor) => documentService.listTemplates(query, actor)),
  );
  socket.on('document:getTemplate', (id, ack) =>
    run(ack, (actor) => documentService.getTemplate(id, actor)),
  );
  socket.on('document:createTemplate', (input, ack) =>
    run(ack, (actor) => documentService.createTemplate(input, actor)),
  );
  socket.on('document:updateTemplate', (payload, ack) =>
    run(ack, (actor) => documentService.updateTemplate(payload.id, payload.input, actor)),
  );
  socket.on('document:deleteTemplate', (payload, ack) =>
    run(ack, (actor) => documentService.deleteTemplate(payload.id, payload.expectedVersion, actor)),
  );
  socket.on('document:restoreTemplate', (id, ack) =>
    run(ack, (actor) => documentService.restoreTemplate(id, actor)),
  );
  socket.on('document:uploadAsset', (input, ack) =>
    run(ack, (actor) => documentService.uploadAsset(input, actor)),
  );
  socket.on('document:listAssets', (ack) =>
    run(ack, (actor) => documentService.listAssets(actor)),
  );
  socket.on('document:assetFile', (id, ack) =>
    run(ack, (actor) => documentRenderService.fetchAssetFile(id, actor)),
  );
  socket.on('document:render', (input, ack) =>
    run(ack, (actor) => documentRenderService.renderDocument(input, actor)),
  );
  socket.on('document:preview', (input, ack) =>
    run(ack, (actor) => documentRenderService.previewDocument(input, actor)),
  );
  socket.on('document:listExports', (query, ack) =>
    run(ack, (actor) => documentRenderService.listExports(query, actor)),
  );
  socket.on('document:getExport', (id, ack) =>
    run(ack, (actor) => documentRenderService.getExport(id, actor)),
  );
  socket.on('document:exportFile', (id, ack) =>
    run(ack, (actor) => documentRenderService.fetchExportFile(id, actor)),
  );

  // The one live pull; everything else rides on `SyncSnapshot.dashboard` and
  // the `dashboard:changed` push both extended below.
  socket.on('dashboard:get', (ack) => run(ack, (actor) => dashboardService.getDashboardSummary(actor)));
}

/**
 * Sign-in commands, which deliberately sit outside `registerCommands`.
 *
 * These are the one group a panel may issue while holding no user identity at
 * all — a person cannot sign in if signing in already required being signed in.
 * They are authorised by the panel's own pairing secret, checked at handshake.
 */
function registerAuthCommands(socket: PanelSocket, onActorChanged: () => void): void {
  socket.on('auth:signIn', (input, ack) =>
    respond(ack, async () => {
      const session = await authService.signIn(
        input?.username ?? '',
        input?.password ?? '',
        // The handshake has always known which machine this is; the audit trail
        // simply never got told. §9 asks for the source device on every entry.
        socket.data.deviceCode ?? socket.data.panelId,
      );

      // Deliberately one signed-in person per panel: an Office Panel is one PC
      // at one counter. Replacing the previous session keeps "who is acting"
      // unambiguous for every command that follows on this socket.
      socket.data.actingUserToken = session.token;
      onActorChanged();

      return session;
    }),
  );

  socket.on('auth:assume', (token, ack) =>
    respond(ack, async () => {
      if (!token) {
        socket.data.actingUserToken = undefined;
        onActorChanged();
        return { status: 'released' as const };
      }

      const resolution = await authService.resolveSessionDetailed(token);

      if (resolution.status === 'active') {
        socket.data.actingUserToken = token;
        onActorChanged();
        return { status: 'active' as const, user: await authService.decorate(resolution.user, token) };
      }

      // A dead token drops the panel back to its own role rather than leaving it
      // acting as someone the Master no longer recognises. The *reason* travels
      // with it, because only `revoked` justifies the panel destroying the
      // offline verifier it holds for that person.
      socket.data.actingUserToken = undefined;
      onActorChanged();

      return { status: 'rejected' as const, reason: resolution.reason };
    }),
  );

  socket.on('auth:reconcile', (users, ack) =>
    respond(ack, async () => {
      const tenantId = socket.data.tenantId;
      if (!tenantId) return { forget: [] };

      return {
        forget: await panelCredentialRepo.findRevokedOfflineCredentials(
          tenantId,
          Array.isArray(users) ? users : [],
        ),
      };
    }),
  );

  socket.on('auth:signOut', (token, ack) =>
    respond(ack, async () => {
      authService.signOut(token);
      if (socket.data.actingUserToken === token) socket.data.actingUserToken = undefined;
      onActorChanged();
      return null;
    }),
  );
}

/**
 * Every command answers its ack exactly once — with data or with a readable
 * message. Throwing across the socket would leave the Office Panel's UI
 * waiting forever.
 *
 * Any `AppError` carries its `code`, `details`, `messageKey` and `params`
 * through to the ack — not only a `ForbiddenError`'s `missingPermission`, as
 * this once did. Without `code` and `details`, `office/src/http/app.ts`'s
 * `forward()` could not tell a refusal from an outage, and a `ConflictError`'s
 * `storedVersion`/`diff` and the Recycle Bin's `blockedBy` never reached the
 * Office Panel at all — they arrived over HTTP and died at the socket.
 */
function respond<T>(ack: CommandAck<T>, operation: () => Promise<T>): void {
  if (typeof ack !== 'function') return;

  operation()
    .then((data) => ack({ ok: true, data }))
    .catch((error: unknown) => {
      log.warn(`Command failed: ${toErrorMessage(error)}`);

      if (error instanceof AppError) {
        ack({
          ok: false,
          error: error.message,
          code: error.code,
          messageKey: error.messageKey,
          params: error.params,
          ...(error.details ? { details: error.details } : {}),
          ...(error instanceof ForbiddenError ? { missingPermission: error.permission } : {}),
        });
        return;
      }

      ack({ ok: false, error: toErrorMessage(error) });
    });
}

/**
 * The actor for an Office Panel command, resolved by the service that owns the
 * policy. The hub's only job here is to stop presenting a token the Master has
 * just refused.
 */
async function panelActor(socket: PanelSocket, panelId: string): Promise<ActorContext> {
  const tenantId = socket.data.tenantId;
  if (!tenantId) throw new AppError('error.internal.panelNoTenant', {}, 500, 'internal');

  const token = socket.data.actingUserToken;

  const { actor, tokenAccepted, rejection } = await resolvePanelActor({
    tenantId,
    panelId,
    deviceCode: socket.data.deviceCode ?? null,
    actingUserToken: token,
  });

  if (!tokenAccepted && token) {
    socket.data.actingUserToken = undefined;

    // Told, not left to be discovered. Clearing the token silently meant the
    // panel carried on showing somebody as signed in — and kept their offline
    // verifier — until it happened to issue another command. An idle panel
    // issues none, so "until it happens to" could be all evening.
    socket.emit('session:rejected', rejection ?? 'expired');
  }

  return actor;
}

/**
 * The actor for a Master Panel browser socket.
 *
 * Resolves through the session rather than reading the user row directly.
 * `findUserById` filters `deleted_at` only, never `is_active`, so an
 * administrator deactivated after connecting kept an open socket streaming
 * `data:changed`, `dashboard:changed` and `panels:changed` at them —
 * `invalidateSessionsForUser` cleared the map entry and disconnected nothing.
 *
 * Returns null when the session no longer resolves, and the caller disconnects.
 */
async function adminActor(socket: PanelSocket): Promise<ActorContext | null> {
  const tenantId = socket.data.tenantId;
  if (!tenantId) throw new AppError('error.internal.sessionNoTenant', {}, 500, 'internal');

  const user = await authService.resolveSession(socket.data.sessionToken);
  if (!user || user.tenantId !== tenantId) return null;

  return {
    tenantId,
    actorType: 'user',
    actorId: user.id,
    userId: user.id,
    permissions: await permissionSetForRole(tenantId, user.roleId),
    deviceCode: null,
    actorName: user.displayName,
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
  const adminSockets = await io.in(ROOM_MASTER_ADMINS).fetchSockets();

  for (const socket of adminSockets) {
    const tenantId = socket.data.tenantId;
    if (!tenantId) continue;

    // Re-resolved per broadcast rather than rebuilt from the handshake's user
    // id: a dashboard is permission-filtered, so pushing one to somebody whose
    // account or role has since changed would show them figures their current
    // role does not entitle them to.
    const user = await authService.resolveSession(socket.data.sessionToken);
    if (!user || user.tenantId !== tenantId) {
      socket.disconnect(true);
      continue;
    }

    const summary = await dashboardService.getDashboardSummary({
      tenantId,
      actorType: 'user',
      actorId: user.id,
      userId: user.id,
      permissions: await permissionSetForRole(tenantId, user.roleId),
      deviceCode: null,
      actorName: user.displayName,
    });

    socket.emit('dashboard:changed', summary);
  }

  // Deliberately **not** fanned out to Office Panels, though
  // `docs/backend-modules/04-API-CONTRACT.md` §9.5 once planned to. The Office
  // Dashboard that actually got built derives every figure from the panel's own
  // already-synced `LocalView` (see `office/web/src/screens/DashboardScreen.tsx`),
  // so it registers no `dashboard:changed` handler and Socket.IO drops the event
  // on arrival. Sending it anyway cost a `panelActor` resolution plus a full
  // dashboard aggregate **per connected panel, per lead/order/party/product/
  // stock/conflict change**, for a payload nothing read. If a panel ever needs a
  // figure `LocalView` cannot produce, restore the fan-out and add the handler in
  // the same change — one without the other is what this comment exists to stop.
}

/**
 * Push `panel:revoked` to whichever live sockets belong to one panel.
 *
 * Matched by `socket.data.panelId` rather than a per-panel Socket.IO room,
 * because revocation is rare and a room would be a second piece of membership
 * bookkeeping to keep in step with the one that already exists.
 */
async function notifyPanelRevoked(io: RealtimeHub['io'], panelId: string): Promise<void> {
  for (const socket of await io.in(ROOM_OFFICE_PANELS).fetchSockets()) {
    if (socket.data.panelId === panelId) socket.emit('panel:revoked');
  }
}

/**
 * Send one request to a panel and unwrap its acknowledgement.
 *
 * Every failure mode is turned into a thrown `Error` with a usable message,
 * because `panel.service.ts` is what decides how each reads on screen and it
 * cannot decide from a silence. The timeout matters: without one, a panel whose
 * process is wedged (rather than disconnected) would leave the administrator's
 * request hanging until the HTTP client gave up.
 */
async function requestFromPanel<T>(
  socket: PanelSocket | undefined,
  event: PanelRequest,
  payload: unknown,
): Promise<T> {
  if (!socket) throw new Error('That office panel is not connected');

  const args = payload === undefined ? [] : [payload];
  const result = (await (
    socket.timeout(PANEL_REQUEST_TIMEOUT_MS) as unknown as {
      emitWithAck: (name: string, ...rest: unknown[]) => Promise<CommandResult<T>>;
    }
  ).emitWithAck(event, ...args)) as CommandResult<T>;

  if (!result?.ok) throw new Error(result?.error || 'That office panel refused');
  return result.data;
}

function remoteAddress(socket: PanelSocket): string | null {
  const address = socket.handshake.address;
  if (!address) return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
