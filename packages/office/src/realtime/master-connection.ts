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
  Lead,
  Party,
  Product,
  ProductCategory,
  ServerToClientEvents,
  SyncSnapshot,
} from '@orderbook/shared';

import { createLogger } from '../lib/logger.js';
import { clearCredentials, loadCredentials, masterBaseUrl } from '../services/credentials.store.js';

const log = createLogger('master-link');

export type ConnectionState = 'unpaired' | 'connecting' | 'connected' | 'disconnected';

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
    });

    socket.on('disconnect', (reason) => {
      this.setState('disconnected');
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
    });

    socket.on('data:changed', (event) => {
      this.applyChange(event);
      this.emit('change', event);
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
      throw new Error('Not connected to the Master Panel');
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The Master Panel did not respond')), 15_000);

      const ack = (result: CommandResult<T>): void => {
        clearTimeout(timeout);
        if (result.ok) resolve(result.data);
        else reject(new Error(result.error));
      };

      (socket.emit as (event: string, ...args: unknown[]) => void)(event as string, ...args, ack);
    });
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
   */
  private applyChange(event: DataChangedEvent): void {
    if (!this.snapshot) return;

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
      default:
        break;
    }
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [item, ...list];

  const next = [...list];
  next[index] = item;
  return next;
}

export const masterConnection = new MasterConnection();
