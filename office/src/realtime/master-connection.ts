/**
 * The Office Panel's live link to the Master.
 *
 * Holds one Socket.IO connection, keeps the most recent snapshot in memory,
 * and applies incremental changes to it. The cache exists purely so this
 * panel's browser has something to render instantly on load or after a blip —
 * the Master remains the only durable store, and every write still goes to it.
 */

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
  PanelSessionResolution,
  PanelStoragePathInput,
  PanelStoragePathResult,
  ServerToClientEvents,
  SessionRejection,
  SyncDeltaCursor,
  SyncSnapshot,
} from '@orderbook/shared';
import { applyChangeToSnapshot } from '@orderbook/shared';

import { createLogger } from '../lib/logger.js';
import {
  clearCredentials,
  loadCredentials,
  masterBaseUrl,
  saveCredentials,
} from '../services/credentials.store.js';
import { buildReport, moveStorage } from '../services/panel-report.service.js';
import { observe } from '../sync/clock.js';
import * as localStore from '../sync/local-store.js';
import { flush, setTransport, stopSync } from '../sync/sync.service.js';

const log = createLogger('master-link');

/** How often a connected panel repeats its self-description. */
const REPORT_INTERVAL_MS = 5 * 60 * 1000;

export type ConnectionState = 'unpaired' | 'connecting' | 'connected' | 'disconnected';

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

export interface ConnectionStatus {
  state: ConnectionState;
  masterHost: string | null;
  masterPort: number | null;
  companyName: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
  /** What the Master reported in its last snapshot; null until one arrives. */
  masterVersion: string | null;
}

type MasterSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** How long the Master has to acknowledge a command before it counts as silence. */
const ACK_TIMEOUT_MS = 15_000;

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

  async connect(): Promise<void> {
    const credentials = await loadCredentials();
    if (!credentials) {
      this.setState('unpaired');
      return;
    }

    this.disconnect();

    this.masterHost = credentials.masterHost;
    this.masterPort = credentials.masterPort;
    this.companyName = credentials.companyName;
    this.setState('connecting');

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

    const socket: MasterSocket = io(masterBaseUrl(credentials), {
      auth: {
        kind: 'office-panel',
        panelId: credentials.panelId,
        panelSecret: credentials.panelSecret,
        ...(cursor ? { syncCursor: cursor } : {}),
      },
      transports: ['websocket'],
      // Retry forever: the Master PC may simply be switched off overnight, and
      // this panel should come back on its own when it returns.
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });

    socket.on('connect', () => {
      this.lastError = null;
      this.setState('connected');
      log.info('Connected to Master');

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
        setTransport((mutations) => this.command('sync:push', { mutations }));

        // Say what this PC is. Nothing depends on it succeeding — a Master too
        // old to know the event simply never acknowledges — so it must not be
        // allowed to fail the rest of a reconnect.
        this.startReporting();
      })();
    });

    socket.on('disconnect', (reason) => {
      this.setState('disconnected');
      setTransport(null);
      this.stopReporting();
      log.warn(`Disconnected from Master: ${reason}`);
    });

    socket.on('connect_error', (error) => {
      this.lastError = error.message;
      this.setState('disconnected');
      log.debug(`Connection attempt failed: ${error.message}`);
    });

    socket.on('sync:snapshot', (snapshot) => {
      this.snapshot = snapshot;
      this.lastSyncedAt = snapshot.serverTime;
      this.masterVersion = snapshot.serverVersion ?? this.masterVersion;
      this.bootId = snapshot.bootId ?? null;
      this.emit('snapshot', snapshot);
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

      this.bootId = delta.bootId;
      this.lastSyncedAt = delta.serverTime;
      this.masterVersion = delta.serverVersion ?? this.masterVersion;

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
      log.info(`Caught up with ${delta.events.length} change(s) from the Master`);

      void (async () => {
        await localStore.setSnapshot(this.snapshot as SyncSnapshot, {
          bootId: delta.bootId,
          lastSeq: delta.seq,
        });
        if (delta.serverHlc) await observe(delta.serverHlc);
        await flush();
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

    // Pushed by the Master when it stops honouring this panel's session, so an
    // idle panel does not keep somebody on screen as signed in until it happens
    // to issue another command.
    socket.on('session:rejected', (reason) => {
      log.warn(`The Master rejected this panel’s signed-in user: ${reason}`);
      this.actingToken = null;
      this.emit('session:rejected', reason);
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

    socket.on('panel:revoked', () => {
      void (async () => {
        log.warn('This panel was removed by the Master');
        await clearCredentials();
        this.disconnect();
        this.setState('unpaired');
      })();
    });

    this.socket = socket;
  }

  disconnect(): void {
    stopSync();
    this.stopReporting();

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
    };
  }

  getSnapshot(): SyncSnapshot | null {
    return this.snapshot;
  }

  /**
   * Issues a command to the Master and unwraps its acknowledgement. Rejects
   * with the Master's own message so the UI can show a real explanation rather
   * than a generic failure.
   */
  async command<E extends keyof ClientToServerEvents, T>(
    event: E,
    ...args: unknown[]
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || this.state !== 'connected') {
      throw new MasterCommandError('Not connected to the Master Panel', undefined, undefined, true);
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
          timeout: (ms: number) => { emitWithAck: (event: string, ...args: unknown[]) => Promise<CommandResult<T>> };
        }
      )
        .timeout(ACK_TIMEOUT_MS)
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
    if (!token) return;

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

    const reason: SessionRejection = resolution.status === 'rejected' ? resolution.reason : 'expired';
    log.warn(`The Master would not re-establish this panel’s signed-in user: ${reason}`);
    this.actingToken = null;
    this.emit('session:rejected', reason);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', this.getStatus());
  }

  /**
   * Keep the cached snapshot current without a refetch.
   *
   * The merge itself lives in `sync/apply-change.ts`, pure and free of this
   * class, so a test can drive the exact code a reconnect replay runs rather
   * than a lookalike written beside it. What stays here is the part that is
   * about *this connection*: the cursor, the trailing write, and the pull that
   * covers the entities a single event cannot merge.
   */
  private applyChange(event: DataChangedEvent): void {
    if (!this.snapshot) return;

    // Recorded even for the entities handled by a fresh pull below: the cursor
    // is about what this panel has *seen*, not about what it managed to merge
    // in place.
    this.schedulePersist(event.seq);

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
          this.bootId = snapshot.bootId ?? this.bootId;
          this.emit('snapshot', snapshot);
          void localStore.setSnapshot(snapshot, this.cursorFrom(snapshot.seq));
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

/** A sentence for whoever is standing at the Master, never a stack trace. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'That office panel could not do that';
}

export const masterConnection = new MasterConnection();
