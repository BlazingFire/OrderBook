/**
 * The Office Panel's live link to the Master.
 *
 * Holds one Socket.IO connection, keeps the most recent snapshot in memory —
 * and on disk, through `sync/local-store.ts` — and applies incremental changes
 * to it. That copy exists so this panel's browser has something to render
 * instantly on load or after a blip, and something to work from while the
 * Master is off. The Master remains the only durable store of the company's
 * records: a write made here is either forwarded live as a command or queued in
 * the outbox (`sync/outbox.store.ts`) and pushed through this link once it is
 * up.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  CommandAck,
  CommandResult,
  DataChangedEvent,
  MessageKey,
  MessageParams,
  OfficePanelReportInput,
  KnownPanelUser,
  MasterProofRequest,
  MasterProofResponse,
  PanelAuthPayload,
  PanelSessionResolution,
  PanelStoragePathInput,
  PanelStoragePathResult,
  ServerToClientEvents,
  SessionRejection,
  SyncDeltaCursor,
  SyncSnapshot,
} from '@orderbook/shared';
import {
  applyChangeToSnapshot,
  COMMAND_MIN_PROTOCOL,
  MASTER_PROOF_CONTEXT,
  masterProofMessage,
  PANEL_PROTOCOL_VERSION,
} from '@orderbook/shared';

import { discoverMasters } from '../discovery/client.js';
import { appVersion } from '../lib/app-version.js';
import { timeoutSignal } from '../lib/legacy-globals.js';
import { createLogger } from '../lib/logger.js';
import { hasNetworkLink } from '../lib/network.js';
import {
  clearCredentials,
  loadCredentials,
  masterBaseUrl,
  saveCredentials,
  type StoredCredentials,
} from '../services/credentials.store.js';
import { noteCacheMaster, recordRemoved } from '../services/master-binding.js';
import * as offlineAuthEvents from '../services/offline-auth-events.store.js';
import { buildReport, moveStorage } from '../services/panel-report.service.js';
import { observe } from '../sync/clock.js';
import * as localStore from '../sync/local-store.js';
import { flush, setTransport, stopSync } from '../sync/sync.service.js';

const log = createLogger('master-link');

/** How often a connected panel repeats its self-description. */
const REPORT_INTERVAL_MS = 5 * 60 * 1000;

type ConnectionState = 'unpaired' | 'connecting' | 'connected' | 'disconnected';

/*
 * Reconnect timing. socket.io-client retries a transport failure on its own,
 * between 1 s and 5 s with half the delay randomised so a room of panels does
 * not knock on a returning Master all at once. It gives up on a socket the
 * Master closed or refused, so those two are retried here.
 */
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 5_000;
const RECONNECT_JITTER = 0.5;
/** How long one connection attempt may take before it counts as failed. */
const CONNECT_TIMEOUT_MS = 5_000;
/** A refused handshake is retried after 5 s, doubling to at most a minute. */
const REFUSAL_RETRY_MIN_MS = 5_000;
const REFUSAL_RETRY_MAX_MS = 60_000;
/**
 * The Master closing this panel's socket three times inside this window means
 * something keeps replacing it, most likely a second PC holding this panel's
 * pairing (a cloned disk or a copied data folder). It is then retried on the
 * refusal backoff, so the two PCs do not knock each other off every second.
 */
const SERVER_CLOSE_WINDOW_MS = 30_000;
const SERVER_CLOSES_BEFORE_BACKOFF = 3;

/** "Catching up" ends by itself after this, whatever is still outstanding. */
const CATCH_UP_CAP_MS = 30_000;

/** How often the network cable is checked; a pulled one shows within this. */
const LINK_POLL_MS = 2_000;

/*
 * Looking for the Master at a new address: only after three failed attempts in
 * a row, at most once a minute, and only with a network to look on.
 */
const REDISCOVER_AFTER_FAILURES = 3;
const REDISCOVER_EVERY_MS = 60_000;
const REDISCOVERY_TIMEOUT_MS = 3_000;
const PROOF_TIMEOUT_MS = 5_000;
/** The proof answer is under 100 bytes; an address sending more is not the Master. */
const PROOF_BODY_LIMIT = 1024;

/** What a refused handshake carries (`authRefusal` in the Master's `hub.ts`). */
interface RefusalData {
  code?: string;
  messageKey?: string;
  /** Present on `panelRevoked`, so a panel can tell its own Master from another. */
  masterUniqueId?: string;
}

/**
 * A command the Master answered with a refusal, or that never reached it.
 *
 * The distinction is the whole reason this class exists. Sign-in is allowed to
 * fall back to this panel's own offline verifier when the Master could not be
 * *asked*, and must never do so when the Master was asked and said no — and the
 * previous version decided which by substring-matching the message text, so a
 * Postgres "canceling statement due to statement timeout" read as silence.
 */
export class MasterCommandError extends Error {
  constructor(
    message: string,
    /** Stable code from the Master, absent when the Master never answered. */
    readonly code: string | undefined,
    readonly missingPermission: string | undefined,
    /** True when this panel could not reach the Master at all. */
    readonly unreachable: boolean,
    /** Structured facts about the refusal — a stale version, a blocked restore, and so on. */
    readonly details?: Record<string, unknown>,
    /** The stable message key a client renders in the reader's own language. */
    readonly messageKey?: MessageKey,
    readonly params?: MessageParams,
  ) {
    super(message);
    this.name = 'MasterCommandError';
  }
}

interface ConnectionStatus {
  state: ConnectionState;
  masterHost: string | null;
  masterPort: number | null;
  companyName: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  /** What the Master reported in its last snapshot; null until one arrives. */
  masterVersion: string | null;
  /** The protocol the Master announced on this connection; null when not known. */
  masterProtocol: number | null;
  /**
   * When this running panel lost the link, or first failed to make it. Not
   * kept across a restart: a PC switched off overnight was not offline.
   */
  disconnectedSince: string | null;
  /** Connected, but what was missed is not yet in and the outbox not yet sent. */
  catchingUp: boolean;
  /** Whether this PC has a network at all, checked every two seconds. */
  hasNetworkLink: boolean;
  /** This PC's clock minus the Master's, at the last snapshot or delta. */
  clockSkewMs: number | null;
  /** The address the Master was found to have moved from, once it has. */
  rediscoveredFrom: string | null;
  /** The Master at this address does not know this panel; the pairing is kept. */
  notRecognised: boolean;
  /**
   * An address that answered as this panel's Master on the network and was
   * not trusted (it could not prove it, or two addresses claimed the same id).
   */
  rediscoveryRefused: string | null;
}

type MasterSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** How long the Master has to acknowledge a command before it counts as silence. */
const ACK_TIMEOUT_MS = 15_000;

/** The same for `sync:push`, which waits its turn in the Master's push gate. */
const SYNC_PUSH_ACK_MS = 60_000;

/** How long a burst of non-upsertable changes is allowed to coalesce. */
const REFRESH_DEBOUNCE_MS = 500;

/** How long the in-memory snapshot may run ahead of the disk copy. */
const PERSIST_DEBOUNCE_MS = 2_000;

class MasterConnection extends EventEmitter {
  private socket: MasterSocket | null = null;
  private snapshot: SyncSnapshot | null = null;
  private state: ConnectionState = 'unpaired';
  private lastError: string | null = null;
  private lastSyncedAt: string | null = null;
  private masterVersion: string | null = null;
  /**
   * The protocol the Master announced in its last snapshot or delta. Null
   * until one arrives on this connection; an older Master sends none, which
   * counts as protocol 1.
   */
  private masterProtocol: number | null = null;
  /** True while offline sign-ins are on their way up, so two snapshots do not send them twice. */
  private uploadingAuthEvents = false;
  /** One upload attempt per connection, not one per delta, so a failing one does not repeat on every change. */
  private authEventsTried = false;
  private masterHost: string | null = null;
  private masterPort: number | null = null;
  private companyName: string | null = null;
  /** The Master-issued token of whoever is signed in on this panel. */
  private actingToken: string | null = null;
  /** Repeats the self-description while the link is up. Cleared on disconnect. */
  private reportTimer: NodeJS.Timeout | null = null;
  /**
   * Which run of the Master the sequence numbers on `data:changed` belong to.
   *
   * Null until a snapshot or a delta says. A `seq` with no boot id is a
   * position in a ring nobody can name, so it is not stored as a cursor.
   */
  private bootId: string | null = null;
  /** Trailing write of the in-memory snapshot; see `schedulePersist`. */
  private persistTimer: NodeJS.Timeout | null = null;
  /** Coalesces the pull that non-upsertable entities trigger. */
  private refreshTimer: NodeJS.Timeout | null = null;
  private disconnectedSince: string | null = null;
  private catchingUp = false;
  /** Which halves of catching up are done on the current connection. */
  private caughtUp = new Set<'synced' | 'flushed'>();
  private catchUpTimer: NodeJS.Timeout | null = null;
  /** Counts connections, so work begun on an earlier one cannot end this one's catch-up. */
  private connectEpoch = 0;
  private clockSkewMs: number | null = null;
  private hasLink = true;
  private linkTimer: NodeJS.Timeout | null = null;
  private notRecognised = false;
  private rediscoveryRefused: string | null = null;
  /** Set the moment the Master revokes this panel, so nothing reconnects after it. */
  private revoked = false;
  /** Failed attempts in a row that might mean the Master moved. */
  private connectFailures = 0;
  /** Refused handshakes in a row, for the retry backoff. */
  private refusals = 0;
  /** Closes by the Master in a row, each within `SERVER_CLOSE_WINDOW_MS` of the last. */
  private serverCloses = 0;
  private lastServerCloseAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastRediscoveryAt = 0;
  private rediscovering = false;
  /**
   * A new address the Master proved itself at, tried but not yet saved. It is
   * written to the credentials only once a connection there authenticates.
   */
  private candidate: { host: string; port: number } | null = null;
  private rediscoveredFrom: string | null = null;
  /** The last status emitted, so `emitStatus` only speaks on a change. */
  private lastStatus = '';

  /** Connect to the Master this panel is paired with, at its saved address. */
  async connect(): Promise<void> {
    this.candidate = null;
    await this.open();
  }

  private async open(): Promise<void> {
    const credentials = await loadCredentials();
    if (!credentials) {
      this.setState('unpaired');
      return;
    }

    this.disconnect();
    this.revoked = false;
    this.serverCloses = 0;
    // The cached data below is this Master's; say so if nothing yet does.
    await noteCacheMaster(credentials.masterUniqueId).catch((error: unknown) =>
      log.warn(`Could not note whose data is cached: ${describeError(error)}`),
    );

    const target = this.candidate ?? {
      host: credentials.masterHost,
      port: credentials.masterPort,
    };
    this.masterHost = target.host;
    this.masterPort = target.port;
    this.companyName = credentials.companyName;
    this.setState('connecting');
    this.startLinkPoll();

    /*
     * Hydrate before connecting, not after.
     *
     * `applyChange` returns early when there is no snapshot in memory, so a
     * panel that has just restarted would take a delta and discard every event
     * in it, then serve a disk snapshot missing all of them. Reading the disk
     * copy first is also what produces the cursor — and the cursor is only
     * offered when both halves are present, because a position with nothing to
     * apply it to is worse than no position at all.
     */
    this.snapshot ??= await localStore.restore();
    const cursor = this.snapshot ? localStore.getCursor() : null;
    if (cursor) this.bootId = cursor.bootId;

    const socket: MasterSocket = io(
      masterBaseUrl({ ...credentials, masterHost: target.host, masterPort: target.port }),
      {
        /*
         * A function, so every reconnect sends what is true *then*: the cursor
         * has moved on since the first connect, somebody may have signed in,
         * and the secret may have been reissued.
         */
        auth: (send) => {
          void loadCredentials()
            .catch(() => null)
            .then((current) => send(this.handshake(current ?? credentials)));
        },
        transports: ['websocket'],
        // Retry forever: the Master PC may simply be switched off overnight, and
        // this panel should come back on its own when it returns.
        reconnection: true,
        reconnectionDelay: RECONNECT_DELAY_MS,
        reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
        randomizationFactor: RECONNECT_JITTER,
        timeout: CONNECT_TIMEOUT_MS,
      },
    );

    socket.on('connect', () => {
      this.lastError = null;
      this.authEventsTried = false;
      this.connectFailures = 0;
      this.refusals = 0;
      this.notRecognised = false;
      this.rediscoveryRefused = null;
      this.clearRetry();
      const epoch = this.beginCatchUp();
      this.setState('connected');
      log.info('Connected to Master');

      void this.adoptCandidate();

      void (async () => {
        // Re-declare who is acting *before* the outbox can drain. The Master
        // keys the acting user to the socket, so a reconnect starts as the bare
        // panel again — and work somebody queued offline must be applied as
        // them, not as the machine they typed it into.
        await this.reassume();

        // Then revalidate every offline verifier this panel holds. The push
        // above only reaches a panel that was switched on when the revocation
        // happened; this covers the one that was not.
        this.emit('reconcile');

        // The outbox only knows how to hand mutations to *something*; wiring the
        // socket in here is what keeps the sync service free of transport.
        // A push may wait in the Master's push gate (up to 6 s for an offline
        // backlog) before it is applied, so it gets a longer ack than the 15 s
        // a plain command has.
        setTransport((mutations) =>
          this.commandWithin(SYNC_PUSH_ACK_MS)('sync:push', { mutations }),
        );

        // Say what this PC is. Nothing depends on it succeeding — a Master too
        // old to know the event simply never acknowledges — so it must not be
        // allowed to fail the rest of a reconnect.
        this.startReporting();

        // Flush here as well as after the snapshot: the snapshot usually lands
        // before the transport above is set, and that flush finds nothing to
        // send through, which left queued work waiting for the next change.
        await flush().catch((error: unknown) => {
          log.warn(`Could not send queued changes: ${describeError(error)}`);
        });
        this.caughtUpPart(epoch, 'flushed');
      })();
    });

    socket.on('disconnect', (reason) => {
      // The Master may come back as a different build, so its protocol is
      // learned again from the next snapshot rather than assumed.
      this.masterProtocol = null;
      this.endCatchUp();
      this.setState('disconnected');
      setTransport(null);
      this.stopReporting();
      log.warn(`Disconnected from Master: ${reason}`);

      // The Master closed this socket on purpose: a restart, a reset, or a
      // newer socket for this panel. socket.io-client does not come back from
      // that by itself. A revoke is not retried; its `panel:revoked` comes first.
      if (reason === 'io server disconnect' && !this.revoked) {
        const now = Date.now();
        this.serverCloses =
          now - this.lastServerCloseAt < SERVER_CLOSE_WINDOW_MS ? this.serverCloses + 1 : 1;
        this.lastServerCloseAt = now;
        const extra = this.serverCloses - SERVER_CLOSES_BEFORE_BACKOFF;
        if (extra < 0) {
          this.scheduleRetry(socket, RECONNECT_DELAY_MS * (1 + Math.random()));
        } else {
          log.warn(
            "The Master keeps closing this connection; another PC may be using this panel's pairing.",
          );
          const backoff = Math.min(REFUSAL_RETRY_MAX_MS, REFUSAL_RETRY_MIN_MS * 2 ** extra);
          this.scheduleRetry(socket, backoff * (1 + RECONNECT_JITTER * (Math.random() * 2 - 1)));
        }
      }
    });

    socket.on('connect_error', (error: Error & { data?: RefusalData }) => {
      this.lastError = error.message;
      this.setState('disconnected');
      log.debug(`Connection attempt failed: ${error.message}`);

      // Still active: the transport failed and socket.io-client is retrying.
      // The Master may be off, or may have moved to another address.
      if (socket.active) {
        this.connectFailures += 1;
        void this.maybeRediscover();
        return;
      }

      void this.refused(socket, error.data);
    });

    socket.on('sync:snapshot', (snapshot) => {
      // A snapshot is built for whoever the link is acting as. If that is not the person signed in
      // here (an earlier person's token was left on the link), it is theirs, not this person's:
      // never shown, never written to this PC's disk. An offline session is ended (it gets the
      // token released and signs in again); an online one gets its own snapshot once it is attached.
      const viewer = localStore.currentViewer();
      if (snapshot.builtForUserId && viewer && snapshot.builtForUserId !== viewer) {
        log.warn('Ignoring a snapshot built for somebody other than the person signed in here');
        this.emit('session:unattached');
        return;
      }

      const epoch = this.connectEpoch;
      this.snapshot = snapshot;
      this.lastSyncedAt = snapshot.serverTime;
      this.masterVersion = snapshot.serverVersion ?? this.masterVersion;
      this.masterProtocol = snapshot.protocol ?? 1;
      this.bootId = snapshot.bootId ?? null;
      this.clockSkewMs = skewFrom(snapshot.serverTime);
      this.emit('snapshot', snapshot);
      this.emitStatus();
      log.info(
        `Synced: ${snapshot.parties.length} parties, ${snapshot.products.length} products, ${snapshot.leads.length} leads`,
      );

      void (async () => {
        // Persist before flushing: if the push crashes the process, the panel
        // still restarts holding what the Master last told it.
        await localStore.setSnapshot(snapshot, this.cursorFrom(snapshot.seq));
        if (snapshot.serverHlc) await observe(snapshot.serverHlc);

        // Anything saved while the link was down goes up now. This is the
        // moment the panel stops being behind.
        await flush();
        this.caughtUpPart(epoch, 'synced');
        await this.uploadOfflineAuthEvents();
      })();
    });

    /*
     * The cheap answer to a reconnect: the handful of changes this panel
     * missed, instead of the whole snapshot.
     *
     * Arrives in `sync:snapshot`'s place, never as well as it, and only when
     * the Master could prove the range was complete — the fallback is the
     * snapshot, so there is no case here where the panel ends up short.
     */
    socket.on('sync:delta', (delta) => {
      if (!this.snapshot) return;

      // Never fold a delta onto a cache built for somebody else: take the full snapshot for
      // whoever is signed in instead. The cached one stays withheld (the offline filter fails
      // closed) until it arrives.
      if (!this.cacheIsForViewer(this.snapshot)) {
        log.info(
          'Ignoring a delta for a cache built for somebody else; asking for a full snapshot',
        );
        this.requestFreshSnapshot();
        return;
      }

      const epoch = this.connectEpoch;
      this.bootId = delta.bootId;
      this.lastSyncedAt = delta.serverTime;
      this.masterVersion = delta.serverVersion ?? this.masterVersion;
      this.masterProtocol = delta.protocol ?? 1;
      this.clockSkewMs = skewFrom(delta.serverTime);

      for (const event of delta.events) this.applyChange(event);

      // A role edit and a grant change do not arrive as replayable events —
      // `role` and `user` are withheld from panels outright — so the delta
      // carries them and they are folded in here.
      this.snapshot.permissions = delta.permissions;
      this.snapshot.partyGrants = delta.partyGrants;
      this.snapshot.dashboard = delta.dashboard;
      this.snapshot.serverHlc = delta.serverHlc;
      this.snapshot.serverTime = delta.serverTime;

      this.emit('snapshot', this.snapshot);
      this.emitStatus();
      log.info(`Caught up with ${delta.events.length} change(s) from the Master`);

      void (async () => {
        await localStore.setSnapshot(this.snapshot as SyncSnapshot, {
          bootId: delta.bootId,
          lastSeq: delta.seq,
        });
        if (delta.serverHlc) await observe(delta.serverHlc);
        await flush();
        this.caughtUpPart(epoch, 'synced');
        await this.uploadOfflineAuthEvents();
      })();
    });

    socket.on('sync:conflict', (conflict) => {
      log.warn(
        `A value was overwritten during sync: ${conflict.entity} ${conflict.entityId} field "${conflict.field}"`,
      );
      this.emit('conflict', conflict);
    });

    socket.on('data:changed', (event) => {
      this.applyChange(event);
      this.emit('change', event);
    });

    // A role or user changed on the Master: ask again who this panel's person is
    // and what they may do. `reassume` emits `user`, which refreshes the session.
    socket.on('session:refresh', () => void this.reassume());

    // Pushed by the Master when it stops honouring this panel's session, so an
    // idle panel does not keep somebody on screen as signed in until it happens
    // to issue another command.
    socket.on('session:rejected', (reason) => {
      log.warn(`The Master rejected this panel’s signed-in user: ${reason}`);
      this.actingToken = null;
      this.emit('session:rejected', reason);
    });

    // Addressed to one person (`forUserId`); the HTTP layer decides whether the
    // person signed in here is still that one before passing it on.
    socket.on('notification:new', (notification) => {
      this.emit('notification', notification);
    });

    // Addressed to one person like a notification; the HTTP layer checks that
    // person is still the one signed in before it reaches the browser.
    socket.on('chat:event', (push) => {
      this.emit('chat', push);
    });

    // A Printroom job, addressed the same way.
    socket.on('print:changed', (job) => {
      this.emit('print', job);
    });

    // Who else has a record open. Addressed the same way (`forUserId`) and
    // filtered by the HTTP layer in the same place.
    socket.on('presence:changed', (presence) => {
      this.emit('presence', presence);
    });

    // Who is on each card of a board (protocol 7), addressed the same way.
    socket.on('presence:board', (board) => {
      this.emit('presenceBoard', board);
    });

    // --- Administered from the Master (docs/UI_REDESIGN.md — Office Panels) ---

    // A pull, for when somebody opens this panel's screen on the Master and
    // wants figures that are current rather than however stale the timer left
    // them.
    socket.on('panel:describe', (ack: CommandAck<OfficePanelReportInput>) => {
      void buildReport().then(
        (report) => ack({ ok: true, data: report }),
        (error: unknown) => ack({ ok: false, error: describeError(error) }),
      );
    });

    // A reissued secret. Persisted *before* acknowledging: the Master replaces
    // its stored hash only once this ack arrives, so an ack sent before the
    // write completed would be a promise this panel had not yet kept — and the
    // panel would be locked out on its next reconnect.
    socket.on('panel:credentials', ({ panelSecret }, ack: CommandAck<null>) => {
      void (async () => {
        try {
          const credentials = await loadCredentials();
          if (!credentials) throw new Error('This panel is not paired');

          await saveCredentials({ ...credentials, panelSecret });
          log.info('Stored a reissued panel secret from the Master');
          ack({ ok: true, data: null });
        } catch (error) {
          ack({ ok: false, error: describeError(error) });
        }
      })();
    });

    socket.on(
      'panel:setStoragePath',
      (input: PanelStoragePathInput, ack: CommandAck<PanelStoragePathResult>) => {
        void moveStorage(input).then(
          (result) => ack({ ok: true, data: result }),
          (error: unknown) => ack({ ok: false, error: describeError(error) }),
        );
      },
    );

    // Sent on this authenticated socket, so it can only come from the Master
    // this panel paired with.
    socket.on('panel:revoked', () => this.forgetPairing());

    this.socket = socket;
  }

  /**
   * Whether this cached snapshot was built for the person signed in at this PC now (or by a
   * Master too old to say). A snapshot is scoped to one person's Party Access; nothing may be
   * folded onto it for anybody else, and a delta for somebody else must not be.
   */
  private cacheIsForViewer(snapshot: SyncSnapshot): boolean {
    return (
      snapshot.builtForUserId === undefined ||
      snapshot.builtForUserId === localStore.currentViewer()
    );
  }

  /** The socket auth for one handshake. */
  private handshake(credentials: StoredCredentials): PanelAuthPayload {
    // A position in the Master's change ring only means something to the snapshot it came from,
    // and a delta is scoped to whoever is acting now. Offered for somebody else's cache it would
    // be folded onto it: the previous person's parties stay, the new person's never arrive.
    const cursor =
      this.snapshot && this.cacheIsForViewer(this.snapshot) ? localStore.getCursor() : null;
    return {
      kind: 'office-panel',
      panelId: credentials.panelId,
      panelSecret: credentials.panelSecret,
      ...(cursor ? { syncCursor: cursor } : {}),
      ...(this.actingToken ? { actingUserToken: this.actingToken } : {}),
      protocol: PANEL_PROTOCOL_VERSION,
      appVersion: appVersion(),
    };
  }

  /**
   * The Master revoked this panel. The flag and the disconnect come first and
   * synchronously, because the Master closes the socket straight after, and
   * that close must not be taken as one to reconnect after.
   */
  private forgetPairing(): void {
    this.revoked = true;
    this.candidate = null;
    this.disconnect();
    log.warn('This panel was removed by the Master');
    // Remember why before the pairing goes: the screen that replaces this one has
    // to be able to say it, now and after a restart.
    void loadCredentials()
      .then((saved) => recordRemoved(saved))
      .catch((error: unknown) => log.warn(`Could not note the removal: ${describeError(error)}`))
      .then(() => clearCredentials())
      .catch((error: unknown) => log.warn(`Could not clear the pairing: ${describeError(error)}`))
      .then(() => this.setState('unpaired'));
  }

  /**
   * The Master answered the handshake and said no. socket.io-client leaves a
   * refused socket alone for good, so it is retried here, backing off.
   *
   * Only a revoke from the Master this panel paired with forgets the pairing.
   * `panelNotPaired` keeps it: the address may now belong to another Master, or
   * this one may have been restored from an older backup, and wiping a good
   * pairing would mean walking to the PC to pair it again. Anything else
   * (`maintenance`, a secret mid-reissue) is transient.
   */
  private async refused(socket: MasterSocket, data: RefusalData | undefined): Promise<void> {
    if (data?.code === 'panelRevoked' && data.masterUniqueId) {
      const credentials = await loadCredentials();
      if (credentials && credentials.masterUniqueId === data.masterUniqueId) {
        this.forgetPairing();
        return;
      }
    }

    if (data?.code === 'panelNotPaired' || data?.code === 'panelRevoked') {
      this.notRecognised = true;
      this.connectFailures += 1;
      this.emitStatus();
      void this.maybeRediscover();
    }

    this.refusals += 1;
    const backoff = Math.min(REFUSAL_RETRY_MAX_MS, REFUSAL_RETRY_MIN_MS * 2 ** (this.refusals - 1));
    this.scheduleRetry(socket, backoff * (1 + RECONNECT_JITTER * (Math.random() * 2 - 1)));
  }

  /** Try `socket` again after `ms`, unless it was replaced, connected or revoked meanwhile. */
  private scheduleRetry(socket: MasterSocket, ms: number): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.socket !== socket || this.revoked || this.state === 'connected') return;
      socket.connect();
    }, ms);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Try the Master again now rather than when the backoff says: the network
   * came back, or somebody pressed Sync. Restarting the socket also resets
   * socket.io-client's own backoff.
   */
  retryNow(): void {
    const socket = this.socket;
    if (!socket || this.revoked || this.state === 'connected') return;
    this.clearRetry();
    socket.disconnect();
    socket.connect();
  }

  /**
   * Look for the Master at another address, for when it has been given a new
   * one (a router handing out a fresh IP is the usual cause).
   *
   * Strict on purpose, since what follows sends this panel's secret there:
   *  · the reply must carry the Master id this panel paired with, from one
   *    address only (the id is broadcast in the clear, so anything can repeat
   *    it; two claimants means trust neither);
   *  · that address must then prove it holds the key derived from this panel's
   *    secret (`POST /api/panel/prove`), without the secret being sent;
   *  · and the address is saved only after a connection there authenticates
   *    (`adoptCandidate`). Until then the saved address stays as it was.
   */
  private async maybeRediscover(): Promise<void> {
    if (this.connectFailures < REDISCOVER_AFTER_FAILURES) return;
    if (this.rediscovering || this.revoked || !this.socket) return;
    if (Date.now() - this.lastRediscoveryAt < REDISCOVER_EVERY_MS) return;
    if (!hasNetworkLink()) return;

    this.lastRediscoveryAt = Date.now();
    this.rediscovering = true;
    const current = `${this.masterHost}:${this.masterPort}`;

    try {
      const credentials = await loadCredentials();
      if (!credentials) return;

      const found = await discoverMasters({ timeoutMs: REDISCOVERY_TIMEOUT_MS });
      const master = found.find((entry) => entry.masterUniqueId === credentials.masterUniqueId);
      if (!master) return;

      // Where it answered from comes before where it says it is: a PC with several
      // adapters can advertise one this panel cannot reach.
      const candidates = master.addresses.length > 0 ? master.addresses : [master.lanIp];
      const address = `${candidates[0]}:${master.httpPort}`;
      if (master.conflictingAddress) {
        log.warn(`More than one address answered as this panel's Master; staying with ${current}`);
        this.refuseRediscovery(address);
        return;
      }
      // Back at the saved address needs no proof: the secret already goes there.
      const saved =
        candidates.includes(credentials.masterHost) && master.httpPort === credentials.masterPort;
      if (saved) return;

      let chosen: string | null = null;
      for (const candidate of candidates) {
        if (await masterProves(candidate, master.httpPort, credentials)) {
          chosen = candidate;
          break;
        }
      }
      if (!chosen) {
        log.warn(
          `The Master found at ${address} could not prove it is this panel's Master; staying with ${current}`,
        );
        this.refuseRediscovery(address);
        return;
      }

      // Connected or stopped while the search ran: nothing to move.
      if (this.state === 'connected' || this.revoked || !this.socket) return;

      log.info(`Trying the Master at ${chosen}:${master.httpPort}`);
      this.candidate = { host: chosen, port: master.httpPort };
      await this.open();
    } catch (error) {
      log.warn(`Could not look for the Master on the network: ${describeError(error)}`);
    } finally {
      this.rediscovering = false;
    }
  }

  /** Say on screen that `address` was not trusted, until the next connect. */
  private refuseRediscovery(address: string): void {
    this.rediscoveryRefused = address;
    this.emitStatus();
  }

  /** A connection at a proven new address authenticated: save the address. */
  private async adoptCandidate(): Promise<void> {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = null;

    try {
      const credentials = await loadCredentials();
      if (!credentials) return;
      const from = `${credentials.masterHost}:${credentials.masterPort}`;
      await saveCredentials({
        ...credentials,
        masterHost: candidate.host,
        masterPort: candidate.port,
      });
      this.rediscoveredFrom = from;
      log.info(
        `The Master moved from ${from} to ${candidate.host}:${candidate.port}; saved the new address`,
      );
      this.emitStatus();
    } catch (error) {
      log.warn(`Could not save the Master's new address: ${describeError(error)}`);
    }
  }

  /** Start "catching up" for a new connection, with its 30 s cap. */
  private beginCatchUp(): number {
    this.connectEpoch += 1;
    this.catchingUp = true;
    this.caughtUp.clear();
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = setTimeout(() => this.endCatchUp(), CATCH_UP_CAP_MS);
    this.catchUpTimer.unref?.();
    return this.connectEpoch;
  }

  /** One half done: the missed changes are stored, or the outbox was sent. */
  private caughtUpPart(epoch: number, part: 'synced' | 'flushed'): void {
    if (epoch !== this.connectEpoch || !this.catchingUp) return;
    this.caughtUp.add(part);
    if (this.caughtUp.size === 2) this.endCatchUp();
  }

  private endCatchUp(): void {
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    if (!this.catchingUp) return;
    this.catchingUp = false;
    this.emitStatus();
  }

  /** Watch the network cable while there is a Master to reach. */
  private startLinkPoll(): void {
    if (this.linkTimer) return;
    this.hasLink = hasNetworkLink();
    this.linkTimer = setInterval(() => this.checkLink(), LINK_POLL_MS);
    this.linkTimer.unref?.();
  }

  private stopLinkPoll(): void {
    if (this.linkTimer) clearInterval(this.linkTimer);
    this.linkTimer = null;
  }

  private checkLink(): void {
    const link = hasNetworkLink();
    if (link === this.hasLink) return;
    this.hasLink = link;
    this.emitStatus();
    // The cable is back: no reason to wait out the backoff.
    if (link) this.retryNow();
  }

  /**
   * This PC was unpaired here (the other way a pairing ends is `forgetPairing`, when
   * the Master removes it). Called after `disconnect()` and after the credentials are
   * gone: only the state and the flags a connection screen reads change.
   */
  markUnpaired(): void {
    this.revoked = true;
    this.candidate = null;
    this.connectFailures = 0;
    this.refusals = 0;
    this.notRecognised = false;
    this.rediscoveryRefused = null;
    this.rediscoveredFrom = null;
    this.lastError = null;
    this.masterProtocol = null;
    this.setState('unpaired');
  }

  disconnect(): void {
    stopSync();
    this.stopReporting();
    this.stopLinkPoll();
    this.clearRetry();
    this.endCatchUp();

    // A pending refresh would ask a socket that is about to be replaced. A
    // pending persist is different and is flushed rather than dropped: the
    // whole point of it is that the disk copy is behind memory.
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void localStore.persistCurrent().catch(() => {
        // Already logged where it matters; a failed write here costs one
        // reconnect's worth of replay, not data.
      });
    }

    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  /**
   * Describe this PC now, then keep saying so on a slow timer.
   *
   * Slow on purpose: the figures that move — pending changes, disk free — move
   * over hours, and this runs on a shop PC that also has to stay responsive.
   * When an administrator needs them fresh, the Master asks directly through
   * `panel:describe` rather than waiting for the next tick.
   */
  private startReporting(): void {
    this.stopReporting();
    void this.sendReport();

    this.reportTimer = setInterval(() => void this.sendReport(), REPORT_INTERVAL_MS);
    // Never hold the process open for a status update.
    this.reportTimer.unref?.();
  }

  private stopReporting(): void {
    if (!this.reportTimer) return;
    clearInterval(this.reportTimer);
    this.reportTimer = null;
  }

  /**
   * Hand the Master the sign-ins this panel checked offline, for its audit
   * trail. Runs once the Master has said which protocol it speaks, which is
   * why it follows a snapshot or delta rather than the bare connect.
   *
   * Dropped only on the Master's acknowledgement. Any failure, including a
   * Master too old for the command, keeps them for the next connect.
   */
  private async uploadOfflineAuthEvents(): Promise<void> {
    if (this.uploadingAuthEvents || this.authEventsTried) return;
    this.uploadingAuthEvents = true;
    this.authEventsTried = true;

    try {
      const events = await offlineAuthEvents.peek();
      if (events.length === 0) return;

      await this.command<'auth:offlineEvents', { recorded: number }>('auth:offlineEvents', events);
      await offlineAuthEvents.drop(events);
      log.info(`Uploaded ${events.length} offline sign-in record(s) to the Master`);
    } catch (error) {
      log.debug(`Could not upload offline sign-ins yet: ${describeError(error)}`);
    } finally {
      this.uploadingAuthEvents = false;
    }
  }

  private async sendReport(): Promise<void> {
    try {
      await this.command<'panel:report', null>('panel:report', await buildReport());
    } catch (error) {
      // Reporting is housekeeping. A Master that refuses it, or a link that
      // drops mid-report, must not disturb anything a person is doing here.
      log.debug(`Could not report this panel's details: ${describeError(error)}`);
    }
  }

  getStatus(): ConnectionStatus {
    return {
      state: this.state,
      masterHost: this.masterHost,
      masterPort: this.masterPort,
      companyName: this.companyName,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
      masterVersion: this.masterVersion,
      masterProtocol: this.masterProtocol,
      disconnectedSince: this.disconnectedSince,
      catchingUp: this.catchingUp,
      // Polled only while there is a Master to reach; read fresh otherwise.
      hasNetworkLink: this.linkTimer ? this.hasLink : hasNetworkLink(),
      clockSkewMs: this.clockSkewMs,
      rediscoveredFrom: this.rediscoveredFrom,
      notRecognised: this.notRecognised,
      rediscoveryRefused: this.rediscoveryRefused,
    };
  }

  getSnapshot(): SyncSnapshot | null {
    return this.snapshot;
  }

  /**
   * The signed-in person's Master token, for the HTTP routes that carry image
   * bytes instead of the command socket.
   *
   * Exposed rather than duplicated: those routes have to run as the *person*,
   * not as the panel, or an upload changes who may do it and lands the
   * machine's name in the audit trail instead of theirs.
   */
  getActingToken(): string | null {
    return this.actingToken;
  }

  /**
   * Issues a command to the Master and unwraps its acknowledgement. Rejects
   * with the Master's own message so the UI can show a real explanation rather
   * than a generic failure.
   */
  async command<E extends keyof ClientToServerEvents, T>(event: E, ...args: unknown[]): Promise<T> {
    return this.commandWithin(ACK_TIMEOUT_MS)<E, T>(event, ...args);
  }

  /**
   * Installed by the session: true for a user-level command that must not be sent right now
   * (a person signed in offline and is not yet re-attached). Panel-level traffic is never asked.
   */
  private userCommandBlocked: ((event: string) => boolean) | null = null;

  setUserCommandGuard(guard: ((event: string) => boolean) | null): void {
    this.userCommandBlocked = guard;
  }

  /** `command`, with `ackMs` to acknowledge instead of the usual 15 s. */
  commandWithin(ackMs: number) {
    return <E extends keyof ClientToServerEvents, T>(event: E, ...args: unknown[]): Promise<T> =>
      this.send<E, T>(ackMs, event, args);
  }

  private async send<E extends keyof ClientToServerEvents, T>(
    ackMs: number,
    event: E,
    args: unknown[],
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || this.state !== 'connected') {
      throw new MasterCommandError('Not connected to the Master Panel', undefined, undefined, true);
    }

    // Somebody who signed in offline and has not been re-attached on the Master is nobody to it: a
    // command now would run as the panel itself, with the panel's role and audience, not theirs.
    if (this.userCommandBlocked?.(event)) {
      throw new MasterCommandError(
        'Sign in again to continue',
        'sign_in_again',
        undefined,
        false,
        undefined,
        'error.unauthorized.signInAgain',
      );
    }

    /*
     * A Master too old for this command would never acknowledge it, and the
     * caller would wait out the full ack timeout to learn nothing. The Master
     * says which protocol it speaks in every snapshot and delta, so refuse at
     * once and say why. Not `unreachable`: the Master is there, and nothing may
     * fall back to an offline path over this.
     */
    const needs = COMMAND_MIN_PROTOCOL[event] ?? 1;
    if (needs > (this.masterProtocol ?? 1)) {
      throw new MasterCommandError(
        'The Master Panel needs an update before it can do this',
        'updateNeeded',
        undefined,
        false,
        undefined,
        'error.updateNeeded.master',
      );
    }

    /*
     * Socket.IO's own ack timeout, not a hand-rolled one.
     *
     * The library already cancels the pending ack, drops the callback and
     * rejects — a `setTimeout` beside it had to keep those three things in step
     * by hand, and the same call is what `requestFromPanel` uses on the Master.
     * Silence still has to be told apart from a refusal: a timeout means the
     * Master may not be reachable and callers may retry, while an ack carrying
     * an error means it answered and they must not.
     */
    let result: CommandResult<T>;
    try {
      result = (await (
        socket as unknown as {
          timeout: (ms: number) => {
            emitWithAck: (event: string, ...args: unknown[]) => Promise<CommandResult<T>>;
          };
        }
      )
        .timeout(ackMs)
        .emitWithAck(event as string, ...args)) as CommandResult<T>;
    } catch {
      throw new MasterCommandError('The Master Panel did not respond', undefined, undefined, true);
    }

    if (result.ok) return result.data;

    // The Master answered. Whatever it said, it was reachable — so this is a
    // refusal, never silence, and callers must not treat it as an outage.
    throw new MasterCommandError(
      result.error,
      result.code,
      result.missingPermission,
      false,
      result.details,
      result.messageKey,
      result.params,
    );
  }

  /**
   * Tell the Master which person's authority this panel's commands carry.
   *
   * Remembered locally so a reconnect can re-declare it. Passing null returns
   * the panel to acting as itself, which is what a sign-out means.
   */
  async assume(token: string | null): Promise<PanelSessionResolution> {
    this.actingToken = token;

    if (!this.socket || this.state !== 'connected') {
      // Offline, so nobody has refused anything. Reporting an expiry here would
      // be a statement the panel is in no position to make.
      return { status: 'released' };
    }

    return this.command<'auth:assume', PanelSessionResolution>('auth:assume', token);
  }

  /**
   * Ask the Master which stored offline verifiers are no longer valid.
   *
   * Answered from its database rather than its session map, so a revocation that
   * landed while this panel was switched off is still caught — the case a purely
   * push-based signal can never cover.
   */
  async reconcile(users: KnownPanelUser[]): Promise<string[]> {
    if (users.length === 0 || this.state !== 'connected') return [];

    const result = await this.command<'auth:reconcile', { forget: string[] }>(
      'auth:reconcile',
      users,
    );

    return result.forget;
  }

  /**
   * Re-declare the acting user after a reconnect.
   *
   * Three outcomes, and conflating any two of them is a bug:
   *  · active    — carry on.
   *  · revoked   — the account is gone or deactivated. Sign them out here *and*
   *                destroy the offline verifier, or pulling the network cable
   *                would restore the access the company just removed.
   *  · expired   — the token is merely unknown, which includes a Master restart
   *                emptying an in-memory session map. Sign them out, but keep
   *                the verifier: rebooting the Master must not cost everybody
   *                their ability to work offline.
   */
  private async reassume(): Promise<void> {
    const token = this.actingToken;
    if (!token) {
      // Nobody can be re-attached: there is no token to present. Anybody who signed in here while
      // the link was down (a verifier with no stored token) is told so by the session, which ends
      // them, instead of leaving them on screen as signed in while every command runs as the panel.
      this.emit('session:unattached');
      return;
    }

    let resolution: PanelSessionResolution;

    try {
      resolution = await this.command<'auth:assume', PanelSessionResolution>('auth:assume', token);
    } catch (error) {
      // A failed round trip is not a revocation. Leave the session alone and let
      // the next reconnect try again — signing someone out because the network
      // hiccuped would be worse than briefly acting on a stale set the Master
      // re-checks anyway.
      log.warn(`Could not re-establish the signed-in user: ${(error as Error).message}`);
      return;
    }

    if (resolution.status === 'active') {
      this.emit('user', resolution.user);
      return;
    }

    const reason: SessionRejection =
      resolution.status === 'rejected' ? resolution.reason : 'expired';
    log.warn(`The Master would not re-establish this panel’s signed-in user: ${reason}`);
    this.actingToken = null;
    this.emit('session:rejected', reason);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    if (state === 'connected' || state === 'unpaired') this.disconnectedSince = null;
    else if (state === 'disconnected') this.disconnectedSince ??= new Date().toISOString();
    this.emitStatus();
  }

  /** Emit `status` when anything in it has changed since the last one. */
  private emitStatus(): void {
    const status = this.getStatus();
    const text = JSON.stringify(status);
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.emit('status', status);
  }

  /**
   * Keep the cached snapshot current without a refetch.
   *
   * The merge itself lives in `shared/src/sync/apply-change.ts`
   * (`applyChangeToSnapshot`), pure and free of this class, so a test can drive
   * the exact code a reconnect replay runs rather than a lookalike written
   * beside it. What stays here is the part that is about *this connection*:
   * the cursor, the trailing write, and the pull that covers the entities a
   * single event cannot merge.
   */
  private applyChange(event: DataChangedEvent): void {
    if (!this.snapshot) return;

    // Recorded even for the entities handled by a fresh pull below: the cursor
    // is about what this panel has *seen*, not about what it managed to merge
    // in place.
    this.schedulePersist(event.seq);

    // Fold the row's clock into this one, so a move made after seeing this
    // change sorts after it even when this PC's clock is behind the Master's.
    // Otherwise the Master would take that move for a stale one (rule 6).
    const hlc = (event.payload as { sync?: { hlc?: unknown } } | null)?.sync?.hlc;
    if (typeof hlc === 'string') {
      observe(hlc).catch((error: unknown) =>
        log.debug(`Ignored a change's clock: ${(error as Error).message}`),
      );
    }

    if (applyChangeToSnapshot(this.snapshot, event) === 'refresh') {
      this.requestFreshSnapshot();
    }
  }

  /**
   * Pulled on demand for the entities the snapshot does not hold as a flat,
   * upsertable list — and debounced, because they arrive in bursts.
   *
   * Editing a twenty-value option list publishes twenty changes, and this used
   * to pull a full snapshot for each one. Per panel.
   */
  private requestFreshSnapshot(): void {
    if (this.refreshTimer) return;

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;

      void this.command<'sync:request', SyncSnapshot>('sync:request')
        .then((snapshot) => {
          this.snapshot = snapshot;
          this.lastSyncedAt = snapshot.serverTime;
          this.masterVersion = snapshot.serverVersion ?? this.masterVersion;
          this.masterProtocol = snapshot.protocol ?? 1;
          this.bootId = snapshot.bootId ?? this.bootId;
          this.clockSkewMs = skewFrom(snapshot.serverTime);
          this.emit('snapshot', snapshot);
          this.emitStatus();
          void localStore.setSnapshot(snapshot, this.cursorFrom(snapshot.seq));
          if (snapshot.serverHlc) void observe(snapshot.serverHlc);
        })
        .catch((error: unknown) => {
          log.warn(`Could not refresh the snapshot: ${(error as Error).message}`);
        });
    }, REFRESH_DEBOUNCE_MS);

    this.refreshTimer.unref?.();
  }

  /** A cursor, or null when there is no boot id to pair the sequence with. */
  private cursorFrom(seq: number | undefined): SyncDeltaCursor | null {
    if (!this.bootId || seq === undefined) return null;
    return { bootId: this.bootId, lastSeq: seq };
  }

  /**
   * Note that the snapshot moved on, and write it out shortly.
   *
   * Trailing rather than per event: `setSnapshot` stores the object it is
   * handed and `applyChange` mutates that same object, so memory is current
   * while disk is stale — which is fine for two seconds and not fine across a
   * restart. `unref`'d, so a pending write never holds the process open.
   */
  private schedulePersist(seq: number | undefined): void {
    localStore.noteApplied(seq, this.bootId);
    if (this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void localStore.persistCurrent().catch((error: unknown) => {
        log.warn(`Could not persist the snapshot: ${(error as Error).message}`);
      });
    }, PERSIST_DEBOUNCE_MS);

    this.persistTimer.unref?.();
  }
}

/** This PC's clock minus the Master's, or null when the Master's time does not parse. */
function skewFrom(serverTime: string): number | null {
  const master = Date.parse(serverTime);
  return Number.isNaN(master) ? null : Date.now() - master;
}

/**
 * Ask the Master at a newly found address to prove it is the one this panel
 * paired with, before the panel sends it the secret
 * (`shared/src/protocol/discovery.ts`, `MASTER_PROOF_CONTEXT`). It answers
 * HMAC(HMAC(secret, context), nonce and this address), which only a Master
 * that has seen this panel's secret can work out, and only for an address it
 * was reached at. Any failure is a no. The address is not trusted yet, so the
 * answer is read only up to `PROOF_BODY_LIMIT` and redirects are refused.
 */
export async function masterProves(
  host: string,
  port: number,
  credentials: Pick<StoredCredentials, 'panelId' | 'panelSecret'>,
): Promise<boolean> {
  const nonce = randomBytes(32).toString('hex');
  const request: MasterProofRequest = { panelId: credentials.panelId, nonce };

  try {
    const response = await fetch(`http://${host}:${port}/api/panel/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: timeoutSignal(PROOF_TIMEOUT_MS),
    });
    if (!response.ok) return false;

    const text = await readCapped(response, PROOF_BODY_LIMIT);
    if (text === null) return false;
    const body = JSON.parse(text) as Partial<MasterProofResponse> | null;
    if (typeof body?.proof !== 'string') return false;

    const key = createHmac('sha256', credentials.panelSecret).update(MASTER_PROOF_CONTEXT).digest();
    const expected = createHmac('sha256', key)
      .update(masterProofMessage(nonce, host, port))
      .digest();
    const given = Buffer.from(body.proof, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

/** A response body as text, or null once it passes `limit` bytes (the rest is not read). */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A sentence for whoever is standing at the Master, never a stack trace. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'That office panel could not do that';
}

export const masterConnection = new MasterConnection();
