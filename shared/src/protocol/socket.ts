/**
 * Socket.IO event contract shared by the Master hub and every client.
 *
 * Two kinds of client connect to the Master:
 *  - **Office Panel servers**, authenticating with their paired panel id +
 *    secret. They issue data commands, push their offline outbox, and receive
 *    live updates.
 *  - **Master Panel browsers**, authenticating with the admin session. They
 *    only listen — panel presence and data changes — and never issue commands
 *    over the socket (the Master's own UI uses its local HTTP API instead).
 *
 * Keeping this contract in `shared` is what stops the two sides drifting apart
 * on the wire format.
 */

import type {
  CustomFieldDefinition,
  DashboardSummary,
  InventoryStockLevel,
  Lead,
  OfficePanelWithPresence,
  OptionListItem,
  Order,
  Party,
  PartyProductVariant,
  Pipeline,
  Product,
  ProductCategory,
  RecordId,
  SearchHit,
  SignedInUser,
  StockMovement,
  SyncConflict,
  Uuid,
} from '../domain/entities.js';
import type {
  ConflictResolutionInput,
  LeadConvertInput,
  LeadInput,
  LeadListQuery,
  LeadUpdateInput,
  ListQuery,
  OrderDispatchInput,
  OrderListQuery,
  OrderUpdateInput,
  Paginated,
  PartyInput,
  PartyProductVariantInput,
  ProductInput,
  RemarkInput,
  ReorderLevelInput,
  SearchQuery,
  StageChangeInput,
  StockAdjustmentInput,
  StockInboundInput,
  StockListQuery,
} from '../domain/inputs.js';
import type { SyncPushRequest, SyncPushResponse } from '../sync/mutations.js';

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

/** Credentials a person types into an Office Panel's sign-in screen. */
export interface PanelSignInInput {
  username: string;
  password: string;
}

/**
 * What the Master hands back when a person signs in through an Office Panel.
 *
 * The token is opaque and issued by the Master, which is the point: a panel can
 * ask "is this person who they say they are", but it cannot *assert* an
 * identity. A modified panel claiming to be an administrator gets nowhere,
 * because the permissions attached to a command are re-read from the Master's
 * own `roles` row every time (docs/ROLES_AND_USERS.md §13).
 */
export interface PanelUserSession {
  token: string;
  user: SignedInUser;
  /**
   * Opaque marker that changes when this person's password changes.
   *
   * The panel stores it beside the verifier it minted, and on reconnect asks the
   * Master whether it still matches. That is what closes the door where an
   * administrator resets somebody's password, the person pulls the network
   * cable, and signs in offline against the verifier the old password made.
   *
   * Derived from the stored hash, never the hash itself and never the password —
   * it is a change marker, not a credential.
   */
  credentialFingerprint: string;
}

/** Why the Master will not act as the holder of a panel's session token. */
export type SessionRejection =
  /** The account is gone, deactivated, or its role was removed. Forget the verifier. */
  | 'revoked'
  /**
   * The token is simply not known — a 12-hour expiry, or a Master restart, which
   * empties an in-memory session map. Deliberately distinct from `revoked`: a
   * panel that destroyed its offline verifier every time the Master rebooted
   * would strip offline sign-in from whoever happened to be signed in.
   */
  | 'expired';

export type PanelSessionResolution =
  | { status: 'active'; user: SignedInUser }
  | { status: 'rejected'; reason: SessionRejection }
  /** The panel asked to stop acting as anybody. */
  | { status: 'released' };

/** One person an Office Panel can sign in offline, offered up for revalidation. */
export interface KnownPanelUser {
  userId: string;
  credentialFingerprint: string;
}

/**
 * Every command acknowledges with this instead of throwing across the wire, so
 * a validation failure on the Master surfaces as a message in the Office
 * Panel's UI rather than an unhandled socket error.
 */
export type CommandResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      /**
       * The stable error code (`docs/ROLES_AND_USERS.md` §13), so a caller can
       * branch on what happened instead of reading the message.
       *
       * Its absence was load-bearing in a real defect: with only a message to go
       * on, the Office Panel decided whether the Master had *refused* it or
       * merely not *answered* by substring-matching English, so a Postgres
       * "canceling statement due to statement timeout" read as silence — and
       * silence is the one case allowed to fall back to the local verifier.
       */
      code?: string;
      missingPermission?: string;
    };

export type CommandAck<T> = (result: CommandResult<T>) => void;

export type ChangedEntity =
  | 'lead'
  | 'order'
  | 'party'
  | 'product'
  | 'product_category'
  | 'party_variant'
  | 'office_panel'
  | 'stock'
  | 'reservation'
  | 'pipeline'
  | 'option_list'
  | 'custom_field'
  | 'sync_conflict'
  | 'role'
  | 'user';

export type ChangeAction = 'created' | 'updated' | 'deleted';

export interface DataChangedEvent {
  entity: ChangedEntity;
  action: ChangeAction;
  id: string;
  /** Full current row, so clients can update in place without a refetch. */
  payload: unknown;
}

/**
 * Sent to an Office Panel the moment it connects or reconnects.
 *
 * Deliberately fat: this is also the panel's offline working set, so everything
 * the Add Lead screen needs to build a line item without the network — the
 * catalogue, the party variants, the pipelines, the option lists and the custom
 * field definitions — has to be in here.
 */
export interface SyncSnapshot {
  parties: Party[];
  products: Product[];
  categories: ProductCategory[];
  partyVariants: PartyProductVariant[];
  leads: Lead[];
  orders: Order[];
  stock: InventoryStockLevel[];
  pipelines: Pipeline[];
  optionLists: OptionListItem[];
  customFields: CustomFieldDefinition[];
  conflicts: SyncConflict[];
  /** What this panel's signed-in user may do, so the UI can hide what it must. */
  permissions: string[];
  /** The Master's current HLC, folded into the panel's clock on receipt. */
  serverHlc: string;
  serverTime: string;
}

/** Office Panel → Master. Each carries an ack callback. */
export interface ClientToServerEvents {
  /** Verify a person's credentials against the Master, which holds the hash. */
  'auth:signIn': (input: PanelSignInInput, ack: CommandAck<PanelUserSession>) => void;
  /**
   * Act as the holder of this token for every subsequent command on this socket,
   * or as the panel itself when passed null.
   *
   * Sent again after a reconnect, since the Master's session map is keyed by
   * socket. A token whose session has since been revoked resolves to null, which
   * is the panel's cue to sign the person out rather than silently downgrade
   * them to the panel's own role.
   */
  'auth:assume': (token: string | null, ack: CommandAck<PanelSessionResolution>) => void;
  'auth:signOut': (token: string, ack: CommandAck<null>) => void;
  /**
   * Revalidate every person this panel can sign in offline.
   *
   * Sent on reconnect, and answered from the database rather than the session
   * map — so a revocation that landed while the panel was switched off is still
   * caught. Without it a panel that restarted at the wrong moment would keep a
   * verifier the Master had already invalidated, forever.
   */
  'auth:reconcile': (
    users: KnownPanelUser[],
    ack: CommandAck<{ forget: string[] }>,
  ) => void;

  'party:list': (query: ListQuery, ack: CommandAck<Paginated<Party>>) => void;
  'party:create': (input: PartyInput, ack: CommandAck<Party>) => void;
  'party:update': (payload: { id: RecordId; input: PartyInput }, ack: CommandAck<Party>) => void;

  'product:list': (query: ListQuery, ack: CommandAck<Paginated<Product>>) => void;
  'product:create': (input: ProductInput, ack: CommandAck<Product>) => void;
  'product:update': (
    payload: { id: RecordId; input: ProductInput },
    ack: CommandAck<Product>,
  ) => void;

  'category:list': (ack: CommandAck<ProductCategory[]>) => void;

  'partyVariant:list': (partyId: RecordId, ack: CommandAck<PartyProductVariant[]>) => void;
  'partyVariant:upsert': (
    input: PartyProductVariantInput,
    ack: CommandAck<PartyProductVariant>,
  ) => void;

  'lead:list': (query: LeadListQuery, ack: CommandAck<Paginated<Lead>>) => void;
  'lead:get': (id: RecordId, ack: CommandAck<Lead>) => void;
  'lead:create': (input: LeadInput, ack: CommandAck<Lead>) => void;
  'lead:update': (
    payload: { id: RecordId; input: LeadUpdateInput },
    ack: CommandAck<Lead>,
  ) => void;
  'lead:setStage': (input: StageChangeInput, ack: CommandAck<Lead>) => void;
  'lead:addRemark': (input: RemarkInput, ack: CommandAck<Lead>) => void;
  'lead:convert': (input: LeadConvertInput, ack: CommandAck<Order>) => void;

  'order:list': (query: OrderListQuery, ack: CommandAck<Paginated<Order>>) => void;
  'order:get': (id: RecordId, ack: CommandAck<Order>) => void;
  'order:update': (
    payload: { id: RecordId; input: OrderUpdateInput },
    ack: CommandAck<Order>,
  ) => void;
  'order:setStage': (input: StageChangeInput, ack: CommandAck<Order>) => void;
  'order:dispatch': (input: OrderDispatchInput, ack: CommandAck<Order>) => void;

  'stock:list': (query: StockListQuery, ack: CommandAck<InventoryStockLevel[]>) => void;
  'stock:movements': (
    query: { productId?: RecordId; limit?: number },
    ack: CommandAck<StockMovement[]>,
  ) => void;
  'stock:inbound': (input: StockInboundInput, ack: CommandAck<InventoryStockLevel>) => void;
  'stock:adjust': (input: StockAdjustmentInput, ack: CommandAck<InventoryStockLevel>) => void;
  'stock:setReorderLevel': (input: ReorderLevelInput, ack: CommandAck<InventoryStockLevel>) => void;

  'search:query': (query: SearchQuery, ack: CommandAck<SearchHit[]>) => void;

  'pipeline:list': (ack: CommandAck<Pipeline[]>) => void;

  'conflict:list': (ack: CommandAck<SyncConflict[]>) => void;
  'conflict:resolve': (input: ConflictResolutionInput, ack: CommandAck<SyncConflict>) => void;

  'sync:request': (ack: CommandAck<SyncSnapshot>) => void;
  /** Drains the panel's offline outbox. The only write path that can conflict. */
  'sync:push': (request: SyncPushRequest, ack: CommandAck<SyncPushResponse>) => void;
}

/** Master → clients. */
export interface ServerToClientEvents {
  'sync:snapshot': (snapshot: SyncSnapshot) => void;
  'data:changed': (event: DataChangedEvent) => void;
  'panels:changed': (panels: OfficePanelWithPresence[]) => void;
  'dashboard:changed': (summary: DashboardSummary) => void;
  /** Raised when a merge shadowed somebody's value, so panels can surface it. */
  'sync:conflict': (conflict: SyncConflict) => void;
  /** Master tells a panel its pairing was revoked; the panel must re-pair. */
  'panel:revoked': () => void;
  /**
   * Master tells a panel it has stopped acting as the signed-in person.
   *
   * Pushed rather than waiting to be asked, because the panel would otherwise
   * discover this only on its next command — and a panel whose operator is idle
   * issues no commands. `revoked` additionally means the panel must destroy the
   * offline verifier it holds for them.
   */
  'session:rejected': (reason: SessionRejection) => void;
}

/** Per-connection state the Master attaches after authenticating a socket. */
export interface SocketData {
  kind: 'office-panel' | 'master-admin';
  tenantId: Uuid;
  panelId?: Uuid;
  deviceCode?: string;
  userId?: Uuid;
  permissions?: string[];
  /**
   * Set by `auth:assume` when a person is signed in on this panel. Stored as the
   * token rather than the resolved permissions so every command re-resolves it —
   * caching the permissions here would let a revoked one survive until the
   * socket reconnected.
   */
  actingUserToken?: string;
  /**
   * A Master Panel browser's own session token, kept so the socket can
   * re-resolve it rather than trusting the handshake forever. Without it a
   * deactivated administrator's open socket keeps streaming.
   */
  sessionToken?: string;
}
