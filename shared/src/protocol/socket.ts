/**
 * Socket.IO event contract shared by the Master hub and every client.
 *
 * Two kinds of client connect to the Master:
 *  - **Office Panel servers**, authenticating with their paired panel id +
 *    secret. They issue data commands and receive live updates.
 *  - **Master Panel browsers**, authenticating with the admin session. They
 *    only listen — panel presence and data changes — and never issue commands
 *    over the socket (the Master's own UI uses its local HTTP API instead).
 *
 * Keeping this contract in `shared` is what stops the two sides drifting apart
 * on the wire format.
 */

import type {
  DashboardSummary,
  InventoryStockLevel,
  Lead,
  OfficePanelWithPresence,
  Party,
  Product,
  ProductCategory,
  StockMovement,
  Uuid,
} from '../domain/entities.js';
import type {
  LeadInput,
  LeadListQuery,
  LeadStatusChangeInput,
  ListQuery,
  Paginated,
  PartyInput,
  ProductInput,
  ReorderLevelInput,
  StockAdjustmentInput,
  StockInboundInput,
  StockListQuery,
} from '../domain/inputs.js';

export const SOCKET_PATH = '/socket.io';

/** Socket.IO rooms the Master uses to target broadcasts. */
export const ROOM_OFFICE_PANELS = 'office-panels';
export const ROOM_MASTER_ADMINS = 'master-admins';

/** Handshake `auth` payload sent by an Office Panel server. */
export interface PanelAuthPayload {
  kind: 'office-panel';
  panelId: Uuid;
  panelSecret: string;
}

/** Handshake `auth` payload sent by a Master Panel browser. */
export interface AdminAuthPayload {
  kind: 'master-admin';
  sessionToken: string;
}

export type SocketAuthPayload = PanelAuthPayload | AdminAuthPayload;

/**
 * Every command acknowledges with this instead of throwing across the wire, so
 * a validation failure on the Master surfaces as a message in the Office
 * Panel's UI rather than an unhandled socket error.
 */
export type CommandResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type CommandAck<T> = (result: CommandResult<T>) => void;

export type ChangedEntity =
  | 'lead'
  | 'party'
  | 'product'
  | 'product_category'
  | 'office_panel'
  | 'stock';
export type ChangeAction = 'created' | 'updated' | 'deleted';

export interface DataChangedEvent {
  entity: ChangedEntity;
  action: ChangeAction;
  id: Uuid;
  /** Full current row, so clients can update in place without a refetch. */
  payload: unknown;
}

/** Sent to an Office Panel the moment it connects or reconnects. */
export interface SyncSnapshot {
  parties: Party[];
  products: Product[];
  categories: ProductCategory[];
  leads: Lead[];
  /** Current stock, so the Add Lead screen can show availability offline-fast. */
  stock: InventoryStockLevel[];
  serverTime: string;
}

/** Office Panel → Master. Each carries an ack callback. */
export interface ClientToServerEvents {
  'party:list': (query: ListQuery, ack: CommandAck<Paginated<Party>>) => void;
  'party:create': (input: PartyInput, ack: CommandAck<Party>) => void;
  'party:update': (
    payload: { id: Uuid; input: PartyInput },
    ack: CommandAck<Party>,
  ) => void;

  'product:list': (query: ListQuery, ack: CommandAck<Paginated<Product>>) => void;
  'product:create': (input: ProductInput, ack: CommandAck<Product>) => void;
  'product:update': (
    payload: { id: Uuid; input: ProductInput },
    ack: CommandAck<Product>,
  ) => void;

  'category:list': (ack: CommandAck<ProductCategory[]>) => void;

  'lead:list': (query: LeadListQuery, ack: CommandAck<Paginated<Lead>>) => void;
  'lead:get': (id: Uuid, ack: CommandAck<Lead>) => void;
  'lead:create': (input: LeadInput, ack: CommandAck<Lead>) => void;
  'lead:setStatus': (input: LeadStatusChangeInput, ack: CommandAck<Lead>) => void;

  'stock:list': (query: StockListQuery, ack: CommandAck<InventoryStockLevel[]>) => void;
  'stock:movements': (
    query: { productId?: Uuid; limit?: number },
    ack: CommandAck<StockMovement[]>,
  ) => void;
  'stock:inbound': (input: StockInboundInput, ack: CommandAck<InventoryStockLevel>) => void;
  'stock:adjust': (input: StockAdjustmentInput, ack: CommandAck<InventoryStockLevel>) => void;
  'stock:setReorderLevel': (input: ReorderLevelInput, ack: CommandAck<InventoryStockLevel>) => void;

  'sync:request': (ack: CommandAck<SyncSnapshot>) => void;
}

/** Master → clients. */
export interface ServerToClientEvents {
  'sync:snapshot': (snapshot: SyncSnapshot) => void;
  'data:changed': (event: DataChangedEvent) => void;
  'panels:changed': (panels: OfficePanelWithPresence[]) => void;
  'dashboard:changed': (summary: DashboardSummary) => void;
  /** Master tells a panel its pairing was revoked; the panel must re-pair. */
  'panel:revoked': () => void;
}

/** Per-connection state the Master attaches after authenticating a socket. */
export interface SocketData {
  kind: 'office-panel' | 'master-admin';
  panelId?: Uuid;
}
