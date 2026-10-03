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
import { Server, type ExtendedError, type Socket } from 'socket.io';
import {
  ROOM_MASTER_ADMINS,
  PARTY_BULK_MIN_PROTOCOL,
  ROOM_OFFICE_PANELS,
  type ClientToServerEvents,
  type CommandAck,
  type CommandResult,
  type DashboardSummary,
  type MessageKey,
  type SyncDeltaCursor,
  type DataChangedEvent,
  type PanelAuthPayload,
  type ServerToClientEvents,
  type SocketAuthPayload,
  type SocketData,
  type SyncConflict,
  isServerMasterTier,
  t,
} from '@orderbook/shared';

import { actorCan, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import {
  DASHBOARD_ENTITIES,
  DIRECTORY_ENTITIES,
  PARTY_SCOPED_ENTITIES,
  REQUIRED_PERMISSION,
  mayReceive,
  partyIdOfChange,
} from './fan-out.js';
import * as partyAccessRepo from '../repositories/party-access.repository.js';
import {
  AppError,
  ForbiddenError,
  toErrorMessage,
  UnauthorizedError,
  ValidationError,
} from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { masterPcAddress } from '../lib/network.js';
import { setPanelLink, type PanelRequest } from './panel-link.js';
import { isAllowedSocketOrigin } from './socket-origin.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as authService from '../services/auth.service.js';
import { isMaintenance, maintenanceError } from '../services/backup-job.js';
import { resolveSession } from '../services/auth.service.js';
import * as catalogService from '../services/catalog.service.js';
import { onChange, onConflict, onNotification } from '../services/change-bus.js';
import * as conflictService from '../services/conflict.service.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as fieldsService from '../services/fields.service.js';
import * as inventoryService from '../services/inventory.service.js';
import * as leadService from '../services/lead.service.js';
import * as panelCredentialRepo from '../repositories/panel-credential.repository.js';
import { findMasterConfig } from '../repositories/master-config.repository.js';
import * as notificationService from '../services/notification.service.js';
import * as orderService from '../services/order.service.js';
import {
  RefusedActingTokenError,
  resolvePanelActor,
  resolvePanelActorAllowingRefusal,
} from '../services/panel-actor.service.js';
import * as logService from '../services/log.service.js';
import * as reportService from '../services/report.service.js';
import * as imageService from '../services/image.service.js';
import * as panelService from '../services/panel.service.js';
import * as partyAccessService from '../services/party-access.service.js';
import * as presenceService from '../services/presence.service.js';
import type { PresenceChange } from './presence-store.js';
import * as recycleBinService from '../services/recycle-bin.service.js';
import * as searchService from '../services/search.service.js';
import * as settingsService from '../services/settings.service.js';
import { buildDelta } from '../services/delta.service.js';
import { buildSnapshot } from '../services/snapshot.service.js';
import * as syncService from '../services/sync.service.js';

const log = createLogger('realtime');

type PanelSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

/**
 * Module-level reference, set once by `createRealtimeHub`.  `disconnectEverySocket`
 * needs it without threading the hub instance through every service.
 */
let ioInstance: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData> | null = null;

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

/**
 * Admin browser sockets currently joined, counted here rather than asked of
 * Socket.IO: `fetchSockets()` is async and the health route answers
 * synchronously, and a figure a person reads while a panel feels slow is not
 * worth an await.
 */
let adminSocketCount = 0;

/**
 * The admin socket on file for each Master browser tab's presence key. A tab
 * that reconnects replaces its entry, and only the socket still on file may
 * take the tab off its record when it disconnects, as with `panelSockets`.
 */
const adminPresenceSockets = new Map<string, PanelSocket>();

/** For the health route. Zero before the hub starts, which is honest. */
export function socketCounts(): { panelSockets: number; adminSockets: number } {
  return { panelSockets: panelSockets.size, adminSockets: adminSocketCount };
}

/**
 * Disconnect every connected socket — panel and admin alike.
 *
 * Called by `developer.service.ts` before a full reset so no client is
 * mid-write when the schema is dropped.  The server itself keeps running;
 * clients may reconnect after the reset completes.
 */
export function disconnectEverySocket(): void {
  if (!ioInstance) return;
  for (const socket of panelSockets.values()) {
    socket.disconnect(true);
  }
  panelSockets.clear();
  ioInstance.in(ROOM_MASTER_ADMINS).disconnectSockets(true);
}

/** How long the Master waits for a panel to answer an administrative request. */
const PANEL_REQUEST_TIMEOUT_MS = 20_000;

export interface RealtimeHub {
  io: Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
  stop(): Promise<void>;
}

export function createRealtimeHub(httpServer: HttpServer): RealtimeHub {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>(httpServer, {
    /*
     * Who may open a socket at all, judged by the handshake's `Origin`
     * (`socket-origin.ts` has the rule and every client it admits).
     *
     * This used to be `cors: { origin: true, credentials: true }`, which
     * reflected any origin back with credentials allowed — and CORS was never
     * the control that mattered anyway: both clients connect with
     * `transports: ['websocket']`, and a browser applies no CORS to a
     * WebSocket, so a page from any site could open one and present whatever
     * it held. `allowRequest` runs on the handshake of either transport.
     *
     * No `cors` option at all now, so nothing is reflected: the Master's own
     * UI is same-origin and needs no CORS header, and an Office Panel's server
     * is not a browser.
     */
    allowRequest: (req, callback) => {
      const { origin, host } = req.headers;
      const allowed = isAllowedSocketOrigin(origin, host);
      if (!allowed) log.warn(`Refused a socket handshake from ${origin} to ${host}`);
      callback(null, allowed);
    },
    /*
     * This is a ceiling on **every inbound frame**, so it used to be set by the
     * largest photo anybody might drag in: image bytes rode this same channel
     * as binary attachments, which meant every sync push and every command was
     * budgeted for 60 MB.
     *
     * Image traffic moved to `/api/panel/...` over HTTP, so this can be what
     * the command channel actually needs. `flush` batches at
     * `config.sync.batchSize` mutations, comfortably inside 4 MB.
     *
     * Acks travel server→client and are **not** capped by this, so the
     * report export is unaffected.
     */
    maxHttpBufferSize: 4 * 1024 * 1024,
    // Snapshots and command acks are JSON and compress well; below a kilobyte
    // the framing costs more than it saves.
    perMessageDeflate: { threshold: 1024 },
    /*
     * A link that dies without a word (a pulled switch, a sleeping laptop) is
     * noticed within about ten seconds rather than the default forty-five. Not
     * tighter: a snapshot or PDF build can stall this event loop for a few
     * seconds, and a 5 s / 5 s pair would then drop every panel at once.
     */
    pingInterval: 4000,
    pingTimeout: 6000,
  });
  ioInstance = io;

  io.use(async (socket, next) => {
    // A restore is replacing the database: nothing may connect until it is
    // done. Refused as `maintenance`, so an Office retries rather than unpairs.
    if (isMaintenance()) {
      next(authRefusal(maintenanceError()));
      return;
    }
    try {
      await authenticate(socket as PanelSocket);
      next();
    } catch (error) {
      log.warn(`Rejected socket connection: ${toErrorMessage(error)}`);
      const refusal = authRefusal(error);
      // An Office forgets its pairing on `panelRevoked` only when the Master
      // saying so is the one it paired with, so say which Master this is: a
      // different Master install answering at the saved address keeps it.
      // A backup restored elsewhere brings back this same id, and since a
      // restore revokes every panel, those panels are rightly unpaired.
      if (refusal.data?.code === 'panelRevoked') {
        const masterConfig = await findMasterConfig().catch(() => null);
        if (masterConfig) refusal.data.masterUniqueId = masterConfig.master_unique_id;
      }
      next(refusal);
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
    request: (panelId, event, payload) =>
      requestFromPanel(panelSockets.get(panelId), event, payload),
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
    sessionsEnded: (tokens, reason) => {
      for (const socket of panelSockets.values()) {
        const token = socket.data.actingUserToken;
        if (!token || !tokens.has(token)) continue;
        // The same two steps `panelActor` takes on the command path.
        socket.data.actingUserToken = undefined;
        socket.data.actingUserId = undefined;
        socket.emit('session:rejected', reason);
      }
    },
    resnapshotAll: () => {
      for (const socket of panelSockets.values()) void resnapshot(socket);
    },
  });

  const unsubscribeChanges = onChange((event) => {
    // Whoever else has this record open is told who saved it.
    presenceService.noteWrite(event);

    // A lead, order, party or party-variant row belongs to exactly one party,
    // and a broadcast is a read like any other. Without this, every panel and
    // every Master browser was handed the full record of a party its signed-in
    // user cannot open — the request path would have refused the same row.
    if (PARTY_SCOPED_ENTITIES.has(event.entity)) {
      void emitPartyScopedChange(io, event);
      if (DASHBOARD_ENTITIES.has(event.entity)) scheduleDashboard(io);
      return;
    }

    if (DIRECTORY_ENTITIES.has(event.entity)) {
      // The Master's own screens are the only ones that manage roles and users,
      // and the only ones entitled to the payload. Broadcasting a `user` row to
      // every paired panel handed each of them the whole staff list — username,
      // display name, role, tier, active flag, last sign-in — and every role's
      // complete permission array, with no per-recipient check, while the
      // equivalent *request* path correctly requires `users.manage`. No panel
      // consumes these events, so withholding them costs nothing. Still sent to
      // the admin room unconditionally — every Master browser session is
      // already trusted with this, and narrowing that is a separate question
      // from what this fix is about.
      io.to(ROOM_MASTER_ADMINS).emit('data:changed', event);
    } else if (REQUIRED_PERMISSION[event.entity]) {
      // A module gate applies (`product`/`product_category`/`stock`/
      // `sync_conflict`) and this entity is not party-scoped, so
      // `emitPartyScopedChange` never runs for it — this is the only place
      // that would otherwise have broadcast it unconditionally.
      void emitGatedChange(io, event);
    } else {
      // Shared reference data with no module gate of its own (pipelines,
      // option lists, custom field definitions, panel presence).
      io.to(ROOM_OFFICE_PANELS).emit('data:changed', event);
      io.to(ROOM_MASTER_ADMINS).emit('data:changed', event);
    }

    // Panel membership changes also change what the Master's panel screen and
    // dashboard should show, so those are refreshed as a pair.
    if (event.entity === 'office_panel') {
      void broadcastPanels(io);

      // A revoked panel is told while it is still connected, so it clears its
      // stored credentials and drops to the pairing screen immediately. Without
      // this it keeps running on a dead pairing until it next reconnects — which
      // for an idle panel can be hours, and looks to the operator like the panel
      // still being trusted.
      //
      // Emitted synchronously, from the panel's socket on file, because
      // `revokePanel` closes that socket straight after publishing. An emit
      // after an await (it used to wait on `fetchSockets()`) landed on a
      // closed socket and the notice was lost.
      if ((event.payload as { status?: string } | null)?.status === 'revoked') {
        panelSockets.get(event.id)?.emit('panel:revoked');
      }
    }

    if (DASHBOARD_ENTITIES.has(event.entity)) scheduleDashboard(io);
  });

  const unsubscribeConflicts = onConflict((conflict) => {
    void emitGatedConflict(io, conflict);
    scheduleDashboard(io);
  });

  // A notification is the addressee's own, so the only gate is that the socket
  // is acting as them right now.
  const unsubscribeNotifications = onNotification(({ tenantId, userId, ...notification }) => {
    void emitToActors(io, tenantId, 'notification:new', notification, () => true, [userId]).catch(
      (error: unknown) => log.warn(`Could not deliver a notification: ${toErrorMessage(error)}`),
    );
  });

  // Presence goes only to the people on the record, each re-checked as a
  // reader of it. Never through `publishChange`: it is not a change to log or
  // replay.
  const unsubscribePresence = presenceService.onPresenceChange((change) => {
    void emitPresence(io, change).catch((error: unknown) =>
      log.warn(`Could not deliver presence: ${toErrorMessage(error)}`),
    );
  });

  // Panels that were away when this Master stopped still get their notice.
  void panelService
    .scheduleLongOfflineNoticesAtBoot()
    .catch((error: unknown) =>
      log.warn(`Could not schedule the long-offline notices: ${toErrorMessage(error)}`),
    );

  return {
    io,
    stop: async () => {
      cancelScheduledDashboard();
      unsubscribeChanges();
      unsubscribeConflicts();
      unsubscribeNotifications();
      unsubscribePresence();
      presenceService.resetPresence();
      adminPresenceSockets.clear();
      setPanelLink(null);
      // Cleared before the close, so the closing sockets' own handlers leave
      // presence alone; the last-seen time is written here instead, awaited
      // while the database is still up, so the "offline for" times after a
      // restart start from this stop and not from when each panel connected.
      const connectedPanels = [...panelSockets.keys()];
      panelSockets.clear();
      await Promise.all(
        connectedPanels.map((panelId) =>
          panelService.markPanelDisconnected(panelId).catch((error: unknown) =>
            log.warn(`Could not record a panel disconnect: ${toErrorMessage(error)}`),
          ),
        ),
      );
      await io.close();
      panelService.cancelLongOfflineNotices();
      if (ioInstance === io) ioInstance = null;
    },
  };
}

async function authenticate(socket: PanelSocket): Promise<void> {
  const auth = socket.handshake.auth as SocketAuthPayload | undefined;

  if (auth?.kind === 'office-panel') {
    const panel = await panelService.authenticatePanel(auth.panelId, auth.panelSecret);
    socket.data.kind = 'office-panel';
    socket.data.panelId = panel.id;
    socket.data.tenantId = panel.tenantId;
    socket.data.deviceCode = panel.deviceCode;
    // Whatever the panel says, kept only if it is a plausible number; an Office
    // built before the handshake sends none and is taken to speak protocol 1.
    socket.data.protocol =
      Number.isInteger(auth.protocol) && (auth.protocol as number) > 0 ? auth.protocol : undefined;
    return;
  }

  if (auth?.kind === 'master-admin') {
    // A Master browser on the Master PC may hold a Server Master session; one
    // on another PC may not, so the address goes with every resolution.
    const user = await resolveSession(auth.sessionToken, sessionAddress(socket));
    if (!user) throw new UnauthorizedError();

    socket.data.kind = 'master-admin';
    socket.data.tenantId = user.tenantId;
    socket.data.userId = user.id;
    socket.data.sessionToken = auth.sessionToken;
    if (presenceService.isPresenceTabId(auth.tabId)) socket.data.tabId = auth.tabId;
    return;
  }

  throw new UnauthorizedError();
}

/**
 * The error a refused handshake hands the client, with `data` it can branch on.
 *
 * `code` is the last part of the message key for a refusal (`panelNotPaired`,
 * `panelRevoked`, `panelCredentialsInvalid`, `unauthorized`), so an Office can
 * tell "this Master revoked me" from "this Master does not know me". Anything
 * else is the Master failing rather than refusing, a database still starting
 * or a reset under way, and reads as `maintenance`: transient, retry. Its own
 * text is logged above and not sent, since it may name internals.
 */
function authRefusal(error: unknown): ExtendedError {
  const messageKey: MessageKey =
    error instanceof AppError ? error.messageKey : 'error.unavailable.maintenance';
  const code =
    error instanceof AppError ? messageKey.slice(messageKey.lastIndexOf('.') + 1) : 'maintenance';
  const refusal: ExtendedError = new Error(
    error instanceof AppError ? error.message : t('en', 'error.unavailable.maintenance'),
  );
  refusal.data = { code, messageKey };
  return refusal;
}

async function handleConnection(io: RealtimeHub['io'], socket: PanelSocket): Promise<void> {
  if (socket.data.kind === 'master-admin') {
    const actor = await adminActor(socket);
    if (!actor) {
      socket.disconnect(true);
      return;
    }

    await socket.join(ROOM_MASTER_ADMINS);
    adminSocketCount += 1;

    // The Master browser beats over HTTP under the same key, so closing the
    // tab takes it off its record now rather than after the TTL.
    const presenceKey = socket.data.tabId ? `admin:${actor.userId}:${socket.data.tabId}` : null;
    if (presenceKey) adminPresenceSockets.set(presenceKey, socket);

    socket.on('disconnect', () => {
      adminSocketCount = Math.max(0, adminSocketCount - 1);
      if (presenceKey && adminPresenceSockets.get(presenceKey) === socket) {
        adminPresenceSockets.delete(presenceKey);
        presenceService.leaveConnection(presenceKey);
      }
    });

    socket.emit('panels:changed', await panelService.listPanelsWithPresence(actor.tenantId));
    socket.emit('dashboard:changed', await dashboardService.getDashboardSummary(actor));
    return;
  }

  const panelId = socket.data.panelId;
  if (!panelId) return;

  /*
   * Everything up to the first `await` below runs before any packet from this
   * socket is read, and the order matters.
   *
   * The socket goes on file first, and a previous socket for the same panel
   * (one the panel gave up on, which the heartbeat has not yet noticed) is
   * closed after it: its `disconnect` then finds itself no longer on file and
   * leaves presence alone. The `disconnect` handler is registered before any
   * await, so a drop during the awaits is never missed, and only the socket
   * still on file may clear presence — otherwise a slow teardown of the old
   * socket marked a live panel offline. `markPanelConnected` sets presence
   * synchronously, before its own first await, for the same reason.
   */
  const previous = panelSockets.get(panelId);
  panelSockets.set(panelId, socket);
  if (previous && previous !== socket) {
    // The same PC reconnecting comes from the same address. A live socket from
    // another one means two PCs hold this panel's pairing and keep replacing
    // each other (the Office backs off after a few).
    const from = remoteAddress(socket);
    if (previous.connected && remoteAddress(previous) !== from) {
      log.warn(`Office panel ${panelId} connected from ${from ?? 'an unknown address'} while still connected from ${remoteAddress(previous) ?? 'an unknown address'}; two PCs may share its pairing`);
    }
    previous.disconnect(true);
  }

  socket.on('disconnect', () => {
    if (panelSockets.get(panelId) !== socket) return;
    panelSockets.delete(panelId);
    presenceService.dropConnections(`panel:${panelId}:`);
    void (async () => {
      await panelService.markPanelDisconnected(panelId);
      log.info(`Office panel disconnected: ${panelId}`);
      await broadcastPanels(io);
    })().catch((error: unknown) =>
      log.warn(`Could not record a panel disconnect: ${toErrorMessage(error)}`),
    );
  });

  const connected = panelService.markPanelConnected(
    panelId,
    remoteAddress(socket),
    socket.data.protocol,
  );

  // Who is signed in on the panel, from the handshake, settled before anything
  // is built for it or any command runs. Without it the first snapshot was the
  // panel's own view and `auth:assume` sent the person's straight after it.
  const ready = adoptHandshakeToken(socket);
  const actorFor = async (): Promise<ActorContext> => {
    await ready;
    return panelActor(socket, panelId);
  };

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
  // A different person on the panel is not on the records the last one had open.
  registerAuthCommands(
    socket,
    () => {
      presenceService.dropConnections(`panel:${panelId}:`);
      sendSnapshot();
    },
    ready,
  );

  await socket.join(ROOM_OFFICE_PANELS);
  await connected;
  log.info(`Office panel connected: ${panelId}`);
  await broadcastPanels(io);

  /*
   * Catch the panel up in one round trip before incremental changes resume.
   *
   * A cursor in the handshake — rather than a command the panel sends after
   * connecting — is what lets this be a delta at all: a command arrives one
   * round trip later, by which time the snapshot it was meant to avoid has
   * already been built and emitted. Without a usable cursor this is exactly the
   * unconditional snapshot it always was.
   */
  const actor = await actorFor();
  const cursor = socket.handshake.auth?.syncCursor as SyncDeltaCursor | undefined;
  const delta = cursor ? await buildDelta(cursor, actor) : null;

  if (delta) {
    socket.emit('sync:delta', delta);
    log.info(`Office panel ${panelId} caught up with ${delta.events.length} change(s)`);
  } else {
    socket.emit('sync:snapshot', await buildSnapshot(actor));
  }
}

/**
 * Act as the person whose token the panel sent in its handshake, if the
 * Master still honours it. Anything else leaves the panel acting as itself,
 * exactly as before the field existed; the panel's own `auth:assume` then
 * learns why. Never throws: a failure here must not stop the connection.
 */
async function adoptHandshakeToken(socket: PanelSocket): Promise<void> {
  const token = (socket.handshake.auth as Partial<PanelAuthPayload> | undefined)?.actingUserToken;
  if (typeof token !== 'string' || !token) return;

  try {
    // As on `auth:assume`: never a Server Master on a panel.
    const resolution = await authService.resolveSessionDetailed(token);
    if (resolution.status === 'active' && !isServerMasterTier(resolution.user.roleTier)) {
      socket.data.actingUserToken = token;
      socket.data.actingUserId = resolution.user.id;
    }
  } catch (error: unknown) {
    log.warn(`Could not resolve a handshake session: ${toErrorMessage(error)}`);
  }
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
    run(ack, (actor) =>
      syncService.applyPush(request, actor, socket.handshake.issued, socket.data.protocol ?? 1),
    ),
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
  socket.on('party:delete', (id, ack) =>
    run(ack, (actor) => catalogService.deleteParty(id, actor)),
  );

  socket.on('product:list', (query, ack) =>
    run(ack, (actor) => catalogService.listProducts(query, actor)),
  );
  socket.on('product:create', (input, ack) =>
    run(ack, (actor) => catalogService.createProduct(input, actor)),
  );
  socket.on('product:update', ({ id, input }, ack) =>
    run(ack, (actor) => catalogService.updateProduct(id, input, actor)),
  );
  socket.on('product:delete', (id, ack) =>
    run(ack, (actor) => catalogService.deleteProduct(id, actor)),
  );

  socket.on('product:image:update', ({ id, input }, ack) =>
    run(ack, (actor) => imageService.updateImageCaption(id, input, actor)),
  );
  socket.on('product:image:reorder', (input, ack) =>
    run(ack, (actor) => imageService.reorderImages(input, actor)),
  );
  socket.on('product:image:delete', (id, ack) =>
    run(ack, (actor) => imageService.deleteImage(id, actor)),
  );

  socket.on('pick', ({ kind, query }, ack) =>
    run(ack, (actor) => searchService.pick(kind, query, actor)),
  );

  socket.on('category:list', (query, ack) =>
    run(ack, (actor) => catalogService.listCategories(actor, query ?? {})),
  );
  socket.on('category:create', (input, ack) =>
    run(ack, (actor) => catalogService.createCategory(input, actor)),
  );
  socket.on('category:update', ({ id, input }, ack) =>
    run(ack, (actor) => catalogService.updateCategory(id, input, actor)),
  );
  socket.on('category:delete', (id, ack) =>
    run(ack, (actor) => catalogService.deleteCategory(id, actor)),
  );

  // The acting person's own `settings.manage` is checked by the service, as on
  // the Master's own screen; the answer is the list, as `PUT /api/settings` gives.
  socket.on('settings:save', ({ key, value }, ack) =>
    run(ack, async (actor) => {
      assertPanelSettingWrite(actor, key);
      await settingsService.writeSetting(actor, key, value);
      return settingsService.readSettings(actor);
    }),
  );

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
  socket.on('lead:pdf', (id, ack) => run(ack, (actor) => leadService.leadPdf(id, actor)));

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

  socket.on('partyAccess:list', (query, ack) =>
    run(ack, (actor) => partyAccessService.listAssignments(query, actor)),
  );
  socket.on('partyAccess:forParty', (partyId, ack) =>
    run(ack, (actor) => partyAccessService.assignmentsForParty(partyId, actor)),
  );
  socket.on('partyAccess:people', (ack) =>
    run(ack, (actor) => partyAccessService.assignablePeople(actor)),
  );
  socket.on('partyAccess:export', (ack) =>
    run(ack, (actor) => partyAccessService.exportRows(actor)),
  );
  socket.on('partyAccess:replace', ({ partyId, input }, ack) =>
    run(ack, (actor) => partyAccessService.replaceAssignments(partyId, input, actor)),
  );

  socket.on('fields:catalogue', (ack) =>
    run(ack, (actor) => Promise.resolve(fieldsService.fieldsCatalogue(actor))),
  );
  socket.on('fields:values', (query, ack) =>
    run(ack, (actor) => fieldsService.listValues(query, actor)),
  );
  socket.on('fields:usage', (query, ack) =>
    run(ack, (actor) => fieldsService.fieldUsage(query, actor)),
  );
  socket.on('fields:createValue', (input, ack) =>
    run(ack, (actor) => fieldsService.createValue(input, actor)),
  );
  socket.on('fields:updateValue', ({ id, input }, ack) =>
    run(ack, (actor) => fieldsService.updateValue(id, input, actor)),
  );
  socket.on('fields:deleteValue', (id, ack) =>
    run(ack, (actor) => fieldsService.deleteValue(id, actor)),
  );
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
  socket.on('fields:archiveStage', (id, ack) =>
    run(ack, (actor) => fieldsService.archiveStage(id, actor)),
  );
  socket.on('fields:restoreStage', (id, ack) =>
    run(ack, (actor) => fieldsService.restoreStage(id, actor)),
  );

  socket.on('log:list', (query, ack) => run(ack, (actor) => logService.listLogs(query, actor)));
  socket.on('log:facets', (query, ack) =>
    run(ack, (actor) => logService.listLogFacets(query, actor)),
  );
  socket.on('log:verifyChain', (input, ack) =>
    run(ack, (actor) => logService.verifyLogChain(input, actor)),
  );
  socket.on('log:export', (query, ack) => run(ack, (actor) => logService.exportLogs(query, actor, logService.SOCKET_EXPORT_LIMITS)));

  socket.on('report:dispatches', (query, ack) =>
    run(ack, (actor) => reportService.dispatchReport(query, actor)),
  );
  socket.on('report:leadOutcomes', (query, ack) =>
    run(ack, (actor) => reportService.leadOutcomeReport(query, actor)),
  );
  socket.on('report:topParties', (query, ack) =>
    run(ack, (actor) => reportService.topPartiesReport(query, actor)),
  );
  socket.on('report:export', (payload, ack) =>
    run(ack, (actor) => reportService.exportReport(payload.report, payload.query, actor)),
  );
  socket.on('report:table', (payload, ack) =>
    run(ack, (actor) => reportService.reportTable(payload.report, payload.query, actor)),
  );
  socket.on('report:options', (ack) => run(ack, (actor) => reportService.reportOptions(actor)));

  // The bell: only ever the acting person's own notices; nobody signed in, none.
  socket.on('notification:list', (input, ack) =>
    run(ack, (actor) => notificationService.listNotifications(input, actor)),
  );
  socket.on('notification:markRead', (input, ack) =>
    run(ack, (actor) => notificationService.markRead(input, actor)),
  );

  // Who is acting comes from this socket, and the tab lives under this panel;
  // the beat itself names only the tab and the record.
  socket.on('presence:beat', (beat, ack) =>
    run(ack, (actor) =>
      presenceService.beat(actor, `panel:${socket.data.panelId ?? ''}:`, beat),
    ),
  );

  // The one live pull; everything else rides on `SyncSnapshot.dashboard` and
  // the `dashboard:changed` push both extended below.
  socket.on('dashboard:get', (ack) =>
    run(ack, (actor) => dashboardService.getDashboardSummary(actor)),
  );
}

/**
 * Sign-in commands, which deliberately sit outside `registerCommands`.
 *
 * These are the one group a panel may issue while holding no user identity at
 * all — a person cannot sign in if signing in already required being signed in.
 * They are authorised by the panel's own pairing secret, checked at handshake.
 *
 * `onActorChanged` re-sends the snapshot, and only when the person acted as
 * really changes. A reconnecting panel sends its handshake token and then
 * `auth:assume` with the same token; re-sending there was a second full
 * snapshot on every reconnect. Each command waits for `ready`, the handshake
 * token's resolution, so it compares against what the handshake settled.
 */
function registerAuthCommands(
  socket: PanelSocket,
  onActorChanged: () => void,
  ready: Promise<void>,
): void {
  const actAs = (token: string | undefined, userId: string | undefined): void => {
    const changed = socket.data.actingUserToken !== token;
    socket.data.actingUserToken = token;
    socket.data.actingUserId = token ? userId : undefined;
    if (changed) onActorChanged();
  };

  socket.on('auth:signIn', (input, ack) =>
    respond(ack, async () => {
      await ready;
      const session = await authService.signIn(
        input?.username ?? '',
        input?.password ?? '',
        // The handshake has always known which machine this is; the audit trail
        // simply never got told. §9 asks for the source device on every entry.
        socket.data.deviceCode ?? socket.data.panelId,
        // Never on the Master PC, whatever address this socket came from: an
        // Office running on the Master PC itself, or a port proxied to look
        // local, is still an Office, and a Server Master signs in only at the
        // Master's own screen.
        { onMasterPc: false },
      );

      // Deliberately one signed-in person per panel: an Office Panel is one PC
      // at one counter. Replacing the previous session keeps "who is acting"
      // unambiguous for every command that follows on this socket.
      actAs(session.token, session.user.id);

      return session;
    }),
  );

  socket.on('auth:assume', (token, ack) =>
    respond(ack, async () => {
      await ready;
      if (!token) {
        actAs(undefined, undefined);
        return { status: 'released' as const };
      }

      // No address on purpose: a panel socket never carries a Server Master's
      // session, so one resolves here as `expired` wherever the panel is. The
      // tier check below says the same thing a second time, so passing an
      // address here later cannot quietly undo it.
      const resolution = await authService.resolveSessionDetailed(token);

      if (resolution.status === 'active' && !isServerMasterTier(resolution.user.roleTier)) {
        actAs(token, resolution.user.id);
        return {
          status: 'active' as const,
          user: await authService.decorate(resolution.user, token),
        };
      }

      // A dead token drops the panel back to its own role rather than leaving it
      // acting as someone the Master no longer recognises. The *reason* travels
      // with it, because only `revoked` justifies the panel destroying the
      // offline verifier it holds for that person.
      actAs(undefined, undefined);

      return {
        status: 'rejected' as const,
        reason: resolution.status === 'rejected' ? resolution.reason : ('expired' as const),
      };
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

  // Sign-ins this panel checked while the Master was unreachable, for the
  // audit trail. Filed under the panel's device code, which the handshake
  // established; nothing in the payload can name another machine.
  socket.on('auth:offlineEvents', (events, ack) =>
    respond(ack, async () => {
      const tenantId = socket.data.tenantId;
      if (!tenantId) return { recorded: 0 };
      return authService.recordOfflineAuthEvents(
        tenantId,
        socket.data.deviceCode ?? socket.data.panelId ?? 'panel',
        events,
      );
    }),
  );

  socket.on('auth:signOut', (token, ack) =>
    respond(ack, async () => {
      await ready;
      await authService.signOut(token);
      if (socket.data.actingUserToken === token) actAs(undefined, undefined);
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

  // A socket that raced the disconnect at the start of a restore still sends
  // commands for a moment; none of them may touch the database being replaced.
  (isMaintenance() ? Promise.reject(maintenanceError()) : operation())
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

/** The settings an Office panel may write — its Settings → Leads tab, one number. */
const PANEL_WRITABLE_SETTINGS: ReadonlySet<string> = new Set(['leads.followUpDefaultDays']);

/**
 * `settings:save` from an Office panel (`docs/catalogue/CATALOGUE_MODEL.md` §5):
 * a signed-in person, and a listed key only.
 *
 * The panel actor falls back to the panel's own role when no person's token is
 * accepted, so a panel holding an admin-tier role would otherwise lend
 * `settings.manage` to whoever sits at it. And every other setting is the
 * Master screen's alone — `security.passwordRevealEnabled` off purges the
 * vault, `externalApi.enabled` opens the public API. Listed by key, not by the
 * `leads.` prefix: that would also hand over packaging-on-convert and the
 * quiet-after window, which the Office has no screen for. The value is still
 * validated in full by `writeSetting`, which checks `settings.manage` itself.
 */
export function assertPanelSettingWrite(actor: ActorContext, key: unknown): void {
  if (actor.actorType !== 'user' || !actor.userId) throw new ForbiddenError('settings.manage');
  if (typeof key !== 'string' || !PANEL_WRITABLE_SETTINGS.has(key)) {
    throw new ValidationError('validation.setting.invalid', { key: String(key) });
  }
}

/**
 * The actor for an Office Panel command, resolved by the service that owns the
 * policy. The hub's only job here is to stop presenting a token the Master has
 * just refused.
 */
async function panelActor(socket: PanelSocket, panelId: string): Promise<ActorContext> {
  const tenantId = socket.data.tenantId;
  if (!tenantId) throw new AppError('error.internal.panelNoTenant', {}, 500, 'internal');

  try {
    const { actor } = await resolvePanelActor({
      tenantId,
      panelId,
      deviceCode: socket.data.deviceCode ?? null,
      actingUserToken: socket.data.actingUserToken,
    });

    return actor;
  } catch (error) {
    if (!(error instanceof RefusedActingTokenError)) throw error;

    socket.data.actingUserToken = undefined;
    socket.data.actingUserId = undefined;

    // Told, not left to be discovered. Clearing the token silently meant the
    // panel carried on showing somebody as signed in — and kept their offline
    // verifier — until it happened to issue another command. An idle panel
    // issues none, so "until it happens to" could be all evening.
    socket.emit('session:rejected', error.rejection);

    // Rethrown, not swallowed. This used to return the panel's own machine
    // actor and let the command run — the socket path's silent downgrade, on a
    // boundary the HTTP middleware refuses outright. `respond()` turns this
    // into a proper ack with a code and a `messageKey`.
    throw error;
  }
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

  const resolved = await authService.resolveSessionWithPermissions(
    socket.data.sessionToken,
    sessionAddress(socket),
  );
  if (!resolved || resolved.user.tenantId !== tenantId) return null;

  return {
    tenantId,
    actorType: 'user',
    actorId: resolved.user.id,
    userId: resolved.user.id,
    permissions: resolved.permissions,
    deviceCode: null,
    actorName: resolved.user.displayName,
  };
}

/** The party a change event is about, or `null` if it cannot be told. */
/**
 * Deliver a party-scoped change to the sockets entitled to it.
 *
 * An unrestricted party takes the old broadcast path unchanged — that is the
 * common case and it costs one indexed query. A restricted party fans out per
 * socket, re-resolving each one's acting user, because the person signed in on
 * a panel changes while the socket stays up (the same reason commands resolve
 * their actor per call rather than at connection time).
 */
async function emitPartyScopedChange(
  io: RealtimeHub['io'],
  event: DataChangedEvent,
): Promise<void> {
  const tenantId = (event.payload as { tenantId?: unknown } | null)?.tenantId;
  const partyId = partyIdOfChange(event);

  if (typeof tenantId !== 'string' || !partyId) {
    // Fail closed, and say so. Withholding a live update is a stale screen
    // until the next refresh; guessing the other way is a disclosure.
    log.warn(`Withholding ${event.entity} change ${event.id}: no party could be resolved`);
    return;
  }

  const grants = await partyAccessRepo.grantsForParty(tenantId, partyId);

  // No fast path for an unrestricted party (`grants.length === 0`) anymore:
  // `levelFor` already reads that as `manage` for everybody inside
  // `mayReceive`, but the flat broadcast this used to take skipped
  // `mayReceive` — and with it the module permission check — entirely. A
  // role without `leads.view`/`parties.view`/etc. must still be refused the
  // row even when nobody has restricted the party it belongs to.
  const recipients = [
    ...panelSockets.values(),
    ...(await io.in(ROOM_MASTER_ADMINS).fetchSockets()),
  ];

  await Promise.all(
    recipients.map(async (socket) => {
      try {
        const actor = await actorForRecipient(socket);
        if (!actor) return;
        if (!mayReceive(actor, event, grants)) return;

        socket.emit('data:changed', event);
      } catch (error: unknown) {
        log.warn(`Could not scope a change for a socket: ${toErrorMessage(error)}`);
      }
    }),
  );
}

/**
 * A change gated purely by module permission — no party to scope it by, but
 * still not everyone's to see (`product`, `product_category`, `stock`,
 * `sync_conflict`; see `REQUIRED_PERMISSION`). Every connected panel and
 * admin socket is resolved to its current actor and checked individually,
 * the same as `emitPartyScopedChange` already does for party-scoped rows —
 * a flat room broadcast has no way to ask "may *this* recipient see it".
 */
async function emitGatedChange(io: RealtimeHub['io'], event: DataChangedEvent): Promise<void> {
  const recipients = [
    ...panelSockets.values(),
    ...(await io.in(ROOM_MASTER_ADMINS).fetchSockets()),
  ];

  await Promise.all(
    recipients.map(async (socket) => {
      try {
        const actor = await actorForRecipient(socket);
        if (!actor) return;
        if (!mayReceive(actor, event, [])) return;

        // A panel that predates `party_bulk` cannot fold the event in, and an
        // unknown entity would be dropped, leaving it on the old party book:
        // it is sent the snapshot instead. A panel whose handshake sent no
        // protocol reads as the oldest.
        if (event.entity === 'party_bulk' && socket.data.kind === 'office-panel') {
          const protocol = socket.data.protocol ?? 0;
          if (protocol < PARTY_BULK_MIN_PROTOCOL) {
            const own = socket.data.panelId ? panelSockets.get(socket.data.panelId) : undefined;
            if (own) await resnapshot(own);
            return;
          }
        }

        socket.emit('data:changed', event);
      } catch (error: unknown) {
        log.warn(`Could not gate a change for a socket: ${toErrorMessage(error)}`);
      }
    }),
  );
}

/** Master → client events addressed to one person: their payload names them in `forUserId`. */
type PerUserEvent = {
  [K in keyof ServerToClientEvents]: Parameters<ServerToClientEvents[K]>[0] extends {
    forUserId: string;
  }
    ? K
    : never;
}[keyof ServerToClientEvents];

type RecipientSocket =
  | PanelSocket
  | Awaited<ReturnType<RealtimeHub['io']['fetchSockets']>>[number];

/**
 * Send a per-person push to every socket acting as a person it may reach.
 *
 * The one fan-out for notifications, and later presence, chat and print. It
 * walks the panel sockets and the Master browsers of one company; with
 * `userIds` it first keeps only sockets whose person (`userId` on a Master
 * browser, `actingUserId` on a panel) is named, which saves resolving the
 * rest. Each survivor is resolved to its actor now, through
 * `actorForRecipient` rather than `panelActor`, so a background push can never
 * sign anybody out; a socket with no person behind it gets nothing. `accept`
 * makes the domain's own check, and the payload is stamped with `forUserId`
 * so a panel can drop it if the person has changed by the time it lands.
 */
async function emitToActors<E extends PerUserEvent>(
  io: RealtimeHub['io'],
  tenantId: string,
  event: E,
  payload: Omit<Parameters<ServerToClientEvents[E]>[0], 'forUserId'>,
  accept: (actor: ActorContext, socket: RecipientSocket) => boolean,
  userIds?: readonly string[],
): Promise<void> {
  const wanted = userIds ? new Set(userIds) : null;
  const personOf = (socket: RecipientSocket): string | undefined =>
    socket.data.kind === 'master-admin' ? socket.data.userId : socket.data.actingUserId;

  const recipients: RecipientSocket[] = [
    ...panelSockets.values(),
    ...(await io.in(ROOM_MASTER_ADMINS).fetchSockets()),
  ].filter(
    (socket) =>
      socket.data.tenantId === tenantId && (!wanted || wanted.has(personOf(socket) ?? '')),
  );

  await Promise.all(
    recipients.map(async (socket) => {
      try {
        const actor = await actorForRecipient(socket);
        if (!actor?.userId || (wanted && !wanted.has(actor.userId))) return;
        if (!accept(actor, socket)) return;

        (socket.emit as (name: string, body: unknown) => void)(event, {
          ...payload,
          forUserId: actor.userId,
        });
      } catch (error: unknown) {
        log.warn(`Could not deliver ${event} to a socket: ${toErrorMessage(error)}`);
      }
    }),
  );
}

/**
 * Who is on a record, sent to the people on it. Each recipient is checked as
 * a reader of the record by `mayReceive`, the gate a `data:changed` for it
 * would pass, so a person whose party access was taken away since they opened
 * it learns nothing more about who is there.
 */
async function emitPresence(io: RealtimeHub['io'], change: PresenceChange): Promise<void> {
  const grants = await partyAccessRepo.grantsForParty(change.tenantId, change.partyId);
  const probe: DataChangedEvent = {
    entity: change.recordKind,
    action: 'updated',
    id: change.recordId,
    payload: { tenantId: change.tenantId, partyId: change.partyId },
  };
  await emitToActors(
    io,
    change.tenantId,
    'presence:changed',
    change.presence,
    (actor) => mayReceive(actor, probe, grants),
    change.userIds,
  );
}

/**
 * A resolved conflict, gated by `sync.resolveConflicts` — the same
 * permission `listConflicts`/`resolveConflict` already require on the
 * request path. The unconditional room broadcast this replaced handed every
 * paired panel and every admin socket the conflict's losing and winning
 * values regardless of whether that recipient's role could ever open the
 * Conflicts screen.
 */
async function emitGatedConflict(io: RealtimeHub['io'], conflict: SyncConflict): Promise<void> {
  const recipients = [
    ...panelSockets.values(),
    ...(await io.in(ROOM_MASTER_ADMINS).fetchSockets()),
  ];

  await Promise.all(
    recipients.map(async (socket) => {
      try {
        const actor = await actorForRecipient(socket);
        if (!actor || !actorCan(actor, 'sync.resolveConflicts')) return;

        socket.emit('sync:conflict', conflict);
      } catch (error: unknown) {
        log.warn(`Could not gate a conflict for a socket: ${toErrorMessage(error)}`);
      }
    }),
  );
}

/**
 * Send one panel a fresh snapshot for whoever it is acting as, without ever
 * signing anybody out. A socket whose token is now refused is skipped: sending
 * it the panel-role view would replace a still-signed-in person's data, and the
 * next command on that socket goes through `panelActor`, which ends the session
 * properly.
 */
async function resnapshot(socket: PanelSocket): Promise<void> {
  const { tenantId, panelId } = socket.data;
  if (!tenantId || !panelId) return;
  try {
    const resolution = await resolvePanelActorAllowingRefusal({
      tenantId,
      panelId,
      deviceCode: socket.data.deviceCode ?? null,
      actingUserToken: socket.data.actingUserToken,
    });
    if (!resolution.tokenAccepted) return;
    socket.emit('sync:snapshot', await buildSnapshot(resolution.actor));
  } catch (error: unknown) {
    log.warn(`Could not re-send a snapshot: ${toErrorMessage(error)}`);
  }
}

/**
 * Whoever a socket is currently acting as, with no side effects.
 *
 * Deliberately not `panelActor`: that one clears a refused token and emits
 * `session:rejected`, which is right on a command and wrong on a broadcast —
 * a background fan-out should not be able to sign somebody out.
 */
async function actorForRecipient(socket: {
  data: SocketData;
  handshake: SocketHandshake;
}): Promise<ActorContext | null> {
  const tenantId = socket.data.tenantId;
  if (!tenantId) return null;

  if (socket.data.kind === 'master-admin') {
    /*
     * One query, and deliberately still a query.
     *
     * An in-memory read of the session's permissions would be zero queries and
     * wrong: `sessionPermissions` answers `[]` for a token that is absent or
     * expired, and nothing can tell that apart from a real empty permission
     * set. A signed-out, deactivated or post-restart admin socket would keep
     * receiving `data:changed` for every restricted party it holds a grant on —
     * a disclosure on the exact path party scoping exists to protect.
     */
    const resolved = await authService.resolveSessionWithPermissions(
      socket.data.sessionToken,
      sessionAddress(socket),
    );
    if (!resolved || resolved.user.tenantId !== tenantId) return null;

    return {
      tenantId,
      actorType: 'user',
      actorId: resolved.user.id,
      userId: resolved.user.id,
      permissions: resolved.permissions,
      deviceCode: null,
      actorName: resolved.user.displayName,
    };
  }

  const panelId = socket.data.panelId;
  if (!panelId) return null;

  /*
   * Reported, not thrown: this decides what a socket *receives*, and a refused
   * token here means nobody is signed in on that panel — which is the panel's
   * own tokenless actor, not a failure to raise at somebody who is not asking
   * for anything. Clearing the token and signing the person out belongs on the
   * command path (`panelActor`), so a background fan-out cannot do it.
   */
  // On a refusal the resolution's `actor` is already the panel's own tokenless
  // one, which is exactly what this path wants — so there is nothing to branch
  // on here beyond not throwing.
  const { actor } = await resolvePanelActorAllowingRefusal({
    tenantId,
    panelId,
    deviceCode: socket.data.deviceCode ?? null,
    actingUserToken: socket.data.actingUserToken,
  });

  return actor;
}

async function broadcastPanels(io: RealtimeHub['io']): Promise<void> {
  const sockets = await io.in(ROOM_MASTER_ADMINS).fetchSockets();
  const tenants = new Set(sockets.map((socket) => socket.data.tenantId).filter(Boolean));

  for (const tenantId of tenants) {
    io.to(ROOM_MASTER_ADMINS).emit(
      'panels:changed',
      await panelService.listPanelsWithPresence(tenantId),
    );
  }
}

/**
 * Coalesce dashboard broadcasts onto one trailing 250 ms edge.
 *
 * `broadcastDashboard` is the hottest thing in the process: ten aggregates per
 * admin socket, and it used to run once per changed row. A sync flush of a
 * hundred leads ran it a hundred times. A dashboard is a *sampled summary* —
 * trailing-edge sampling is not an approximation of what it means, it is what
 * it means — so the last change in a burst is the only one whose figures anyone
 * was ever going to read.
 *
 * `unref`'d so a pending flush never holds the process open at shutdown, and
 * `.catch`'d so a failed broadcast says which broadcast failed. The process's
 * own `unhandledRejection` handler (`src/index.ts`) only logs a bare reason.
 */
const DASHBOARD_DEBOUNCE_MS = 250;
let dashboardTimer: NodeJS.Timeout | null = null;

function scheduleDashboard(io: RealtimeHub['io']): void {
  if (dashboardTimer) return;

  dashboardTimer = setTimeout(() => {
    dashboardTimer = null;
    void broadcastDashboard(io).catch((error: unknown) => {
      log.warn(`Dashboard broadcast failed: ${toErrorMessage(error)}`);
    });
  }, DASHBOARD_DEBOUNCE_MS);

  dashboardTimer.unref?.();
}

/** Test seam: drop a pending flush so a suite does not leak a timer. */
function cancelScheduledDashboard(): void {
  if (dashboardTimer) clearTimeout(dashboardTimer);
  dashboardTimer = null;
}

async function broadcastDashboard(io: RealtimeHub['io']): Promise<void> {
  const adminSockets = await io.in(ROOM_MASTER_ADMINS).fetchSockets();

  /** One set of aggregates per distinct scope, for the length of this flush. */
  const summaries = new Map<string, DashboardSummary>();

  for (const socket of adminSockets) {
    const tenantId = socket.data.tenantId;
    if (!tenantId) continue;

    // Re-resolved per broadcast rather than rebuilt from the handshake's user
    // id: a dashboard is permission-filtered, so pushing one to somebody whose
    // account or role has since changed would show them figures their current
    // role does not entitle them to.
    const resolved = await authService.resolveSessionWithPermissions(
      socket.data.sessionToken,
      sessionAddress(socket),
    );
    if (!resolved || resolved.user.tenantId !== tenantId) {
      socket.disconnect(true);
      continue;
    }

    const actor: ActorContext = {
      tenantId,
      actorType: 'user',
      actorId: resolved.user.id,
      userId: resolved.user.id,
      permissions: resolved.permissions,
      deviceCode: null,
      actorName: resolved.user.displayName,
    };

    /*
     * Memoised for the length of this flush.
     *
     * The aggregate is permission- and party-scoped, so two sockets that
     * resolve to the same scope get the same ten aggregates — which is the
     * common case: one administrator with the app open in two tabs, or two
     * people on the same role. Keyed on everything the summary actually varies
     * by, with the null guard because `permissions` can be null.
     */
    const scope = resolvePartyScope(actor);
    const key = `${tenantId}|${scope.seesAll}|${scope.userId ?? ''}|${
      actor.permissions?.permissions.join(',') ?? ''
    }`;

    let summary = summaries.get(key);
    if (!summary) {
      summary = await dashboardService.getDashboardSummary(actor);
      summaries.set(key, summary);
    }

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

type SocketHandshake = { address: string; headers: Record<string, string | string[] | undefined> };

/** The address a Master browser's session is resolved against (`masterPcAddress`). */
function sessionAddress(socket: { handshake: SocketHandshake }): string | null {
  return masterPcAddress(socket.handshake.address, socket.handshake.headers);
}

function remoteAddress(socket: PanelSocket): string | null {
  const address = socket.handshake.address;
  if (!address) return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
