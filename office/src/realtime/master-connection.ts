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
  CommandResult,
  DataChangedEvent,
  InventoryStockLevel,
  Lead,
  MessageKey,
  MessageParams,
  Order,
  Party,
  Product,
  KnownPanelUser,
  PanelSessionResolution,
  ProductCategory,
  ServerToClientEvents,
  SessionRejection,
  SyncSnapshot,
} from '@orderbook/shared';

import { createLogger } from '../lib/logger.js';
import { clearCredentials, loadCredentials, masterBaseUrl } from '../services/credentials.store.js';
import { observe } from '../sync/clock.js';
import * as localStore from '../sync/local-store.js';
import { flush, setTransport, stopSync } from '../sync/sync.service.js';

const log = createLogger('master-link');

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
}

type MasterSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

class MasterConnection extends EventEmitter {
  private socket: MasterSocket | null = null;
  private snapshot: SyncSnapshot | null = null;
  private state: ConnectionState = 'unpaired';
  private lastError: string | null = null;
  private lastSyncedAt: string | null = null;
  private masterHost: string | null = null;
  private masterPort: number | null = null;
  private companyName: string | null = null;
  /** The Master-issued token of whoever is signed in on this panel. */
  private actingToken: string | null = null;

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

    const socket: MasterSocket = io(masterBaseUrl(credentials), {
      auth: {
        kind: 'office-panel',
        panelId: credentials.panelId,
        panelSecret: credentials.panelSecret,
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
      })();
    });

    socket.on('disconnect', (reason) => {
      this.setState('disconnected');
      setTransport(null);
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
      this.emit('snapshot', snapshot);
      log.info(
        `Synced: ${snapshot.parties.length} parties, ${snapshot.products.length} products, ${snapshot.leads.length} leads`,
      );

      void (async () => {
        // Persist before flushing: if the push crashes the process, the panel
        // still restarts holding what the Master last told it.
        await localStore.setSnapshot(snapshot);
        if (snapshot.serverHlc) await observe(snapshot.serverHlc);

        // Anything saved while the link was down goes up now. This is the
        // moment the panel stops being behind.
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
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  getStatus(): ConnectionStatus {
    return {
      state: this.state,
      masterHost: this.masterHost,
      masterPort: this.masterPort,
      companyName: this.companyName,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
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

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new MasterCommandError('The Master Panel did not respond', undefined, undefined, true),
          ),
        15_000,
      );

      const ack = (result: CommandResult<T>): void => {
        clearTimeout(timeout);
        if (result.ok) {
          resolve(result.data);
          return;
        }

        // The Master answered. Whatever it said, it was reachable — so this is a
        // refusal, never silence, and callers must not treat it as an outage.
        reject(
          new MasterCommandError(
            result.error,
            result.code,
            result.missingPermission,
            false,
            result.details,
            result.messageKey,
            result.params,
          ),
        );
      };

      (socket.emit as (event: string, ...args: unknown[]) => void)(event as string, ...args, ack);
    });
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
   * Keeps the cached snapshot current without a refetch. Unknown entity types
   * are ignored rather than invalidating everything — a Master running a newer
   * version may broadcast entities this panel does not track yet.
   *
   * Switches on `action` BEFORE entity — the Recycle Bin is the first module
   * to ever emit `'deleted'` for `lead`/`order`/`party`/`product`, entities
   * that reach a panel. Every earlier `'deleted'` emission was for `role` or
   * `user`, both withheld from panels by `DIRECTORY_ENTITIES`, so nothing
   * before this ever exercised the branch. Left as a blind upsert, a
   * soft-deleted lead would reappear on the panel's board seconds after
   * somebody removed it and stay until the next full reconnect.
   */
  private applyChange(event: DataChangedEvent): void {
    if (!this.snapshot) return;

    if (event.action === 'deleted') {
      this.removeFromSnapshot(event);
      return;
    }

    // `option_list`, `custom_field` and `pipeline` are not stored as flat
    // id-keyed lists in the snapshot, so there is no single row to upsert —
    // a fresh pull is simpler and no more expensive than a bespoke merge for
    // data this small and this rarely changed.
    if (event.entity === 'option_list' || event.entity === 'custom_field' || event.entity === 'pipeline') {
      this.requestFreshSnapshot();
      return;
    }

    // 'created', 'updated' and 'restored' all converge on the same upsert.
    switch (event.entity) {
      case 'lead':
        this.snapshot.leads = upsert(this.snapshot.leads, event.payload as Lead);
        break;
      case 'party':
        this.snapshot.parties = upsert(this.snapshot.parties, event.payload as Party);
        break;
      case 'product':
        this.snapshot.products = upsert(this.snapshot.products, event.payload as Product);
        break;
      case 'product_category':
        this.snapshot.categories = upsert(this.snapshot.categories, event.payload as ProductCategory);
        break;
      case 'order':
        this.snapshot.orders = upsert(this.snapshot.orders, event.payload as Order);
        break;
      case 'stock':
        // Keyed by the (product, colour) pair now that stock is per colour —
        // matching on productId alone would collapse every colour into one row.
        this.snapshot.stock = upsertStock(
          this.snapshot.stock,
          event.payload as InventoryStockLevel,
        );
        break;
      default:
        break;
    }
  }

  private removeFromSnapshot(event: DataChangedEvent): void {
    if (!this.snapshot) return;

    const { id } = event;

    switch (event.entity) {
      case 'lead':
        this.snapshot.leads = this.snapshot.leads.filter((row) => row.id !== id);
        break;
      case 'party':
        this.snapshot.parties = this.snapshot.parties.filter((row) => row.id !== id);
        break;
      case 'product':
        this.snapshot.products = this.snapshot.products.filter((row) => row.id !== id);
        break;
      case 'order':
        this.snapshot.orders = this.snapshot.orders.filter((row) => row.id !== id);
        break;
      default:
        break;
    }
  }

  /** Pulled on demand for the entities the snapshot does not hold as a flat, upsertable list. */
  private requestFreshSnapshot(): void {
    void this.command<'sync:request', SyncSnapshot>('sync:request')
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.lastSyncedAt = snapshot.serverTime;
        this.emit('snapshot', snapshot);
        void localStore.setSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        log.warn(`Could not refresh the snapshot: ${(error as Error).message}`);
      });
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return upsertBy(list, item, 'id');
}

function upsertBy<T, K extends keyof T>(list: T[], item: T, key: K): T[] {
  const index = list.findIndex((entry) => entry[key] === item[key]);
  if (index === -1) return [item, ...list];

  const next = [...list];
  next[index] = item;
  return next;
}

/** Stock rows have no id of their own — a row is one (product, colour) pair. */
function upsertStock(list: InventoryStockLevel[], item: InventoryStockLevel): InventoryStockLevel[] {
  const index = list.findIndex(
    (entry) => entry.productId === item.productId && entry.colour === item.colour,
  );
  if (index === -1) return [item, ...list];

  const next = [...list];
  next[index] = item;
  return next;
}

export const masterConnection = new MasterConnection();
