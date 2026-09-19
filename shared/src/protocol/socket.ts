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

import type { MessageKey, MessageParams } from '../i18n/keys.js';
import type { AiRun, AiStartInput, AiStatus, AiStreamEvent, Insight } from '../domain/ai.js';
import type {
  CustomFieldDefinition,
  DashboardSummary,
  InventoryStockLevel,
  IsoTimestamp,
  Lead,
  OfficePanelWithPresence,
  OptionListItem,
  Order,
  Party,
  PartyProductVariant,
  Pipeline,
  PipelineStage,
  Product,
  ProductCategory,
  RecordId,
  SearchHit,
  SignedInUser,
  StockMovement,
  SyncConflict,
  Uuid,
} from '../domain/entities.js';
import type { FieldCatalogue, FieldUsageBreakdown } from '../domain/fields.js';
import type {
  ActivityLogEntry,
  ActivityLogFacets,
  ActivityLogQuery,
  ChainVerification,
  ChainVerifyInput,
} from '../domain/activity.js';
import type {
  DispatchesReport,
  LeadOutcomesReport,
  ReportKind,
  ReportExportOptions,
  ReportRangeInput,
  TopPartiesReport,
} from '../domain/reports.js';
import type {
  AssignablePerson,
  ConflictResolutionInput,
  CursorPage,
  CustomFieldDefinitionInput,
  CustomFieldDefinitionUpdateInput,
  CustomFieldReorderInput,
  LeadConvertInput,
  LeadInput,
  LeadListQuery,
  LeadUpdateInput,
  ListQuery,
  OfficePanelReportInput,
  OptionListItemInput,
  OptionListItemUpdateInput,
  OptionListReorderInput,
  OrderDispatchInput,
  OrderListQuery,
  OrderUpdateInput,
  Paginated,
  PanelStoragePathInput,
  PanelStoragePathResult,
  PartyAccessInput,
  PartyAccessLevel,
  PartyAccessQuery,
  PartyAccessRow,
  PartyInput,
  PartyProductVariantInput,
  PipelineStageInput,
  ProductImageReorderInput,
  ProductImageUpdateInput,
  ProductInput,
  ProductListPage,
  ProductListQuery,
  RecycleBinQuery,
  RemarkInput,
  ReorderLevelInput,
  RestoreInput,
  SearchQuery,
  StageChangeInput,
  StageReorderInput,
  StockAdjustmentInput,
  StockInboundInput,
  StockListQuery,
} from '../domain/inputs.js';
import type {
  PartyPickPage,
  PickKind,
  PickQuery,
  ProductPickPage,
  VariantPickPage,
} from '../domain/pick.js';
import type { BinCounts, BinEntry, BinRestoreResult } from '../domain/recycle-bin.js';
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
  /**
   * What this panel already has, so the Master can answer a reconnect with the
   * handful of changes it missed instead of the whole snapshot.
   *
   * In the **handshake** rather than as a command sent afterwards, and that is
   * not a stylistic choice: the Master pushes a snapshot the moment a panel
   * connects, so a cursor that arrives one round trip later arrives after the
   * work it was meant to avoid. Absent means "send me everything", which is
   * every first connection and every panel built before this field.
   */
  syncCursor?: SyncDeltaCursor;
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
      /**
       * Structured facts about the failure — a `ConflictError`'s `storedVersion`
       * and `diff`, the Recycle Bin's `blockedBy`, and so on. Without this the
       * HTTP transport and the socket transport disagreed about what a refusal
       * contains: `details` already reached the browser over HTTP
       * (`error-handler.ts`) and died at the socket.
       */
      details?: Record<string, unknown>;
      /** The stable message key a client renders in the reader's own language. */
      messageKey?: MessageKey;
      /** Named params for `messageKey`, substituted by `t()` — never pre-formatted. */
      params?: MessageParams;
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
  | 'user'
  /**
   * The whole catalogue moved at once — a bulk import. There is no single row
   * to upsert, and publishing one `product` event per imported row would push
   * a five-thousand-row file straight through the change ring and force every
   * other panel into a full snapshot anyway. One event, one refresh.
   */
  | 'catalog';

/**
 * `'restored'` is the Recycle Bin's — never minted as a `MutationKind`, since
 * deletes and restores are Master-online-only; it travels only over this
 * existing `publishChange`/`ChangedEntity` path.
 */
export type ChangeAction = 'created' | 'updated' | 'deleted' | 'restored';

export interface DataChangedEvent {
  entity: ChangedEntity;
  action: ChangeAction;
  id: string;
  /** Full current row, so clients can update in place without a refetch. */
  payload: unknown;
  /**
   * Where this change sits in the Master's change ring, so a panel that was
   * offline can ask for everything after the last one it saw.
   *
   * Optional because a panel built against this field must still read events
   * from a Master that predates it — and because the number only means anything
   * paired with the Master's `bootId`. The ring is in memory: a Master restart
   * mints a new boot id and every cursor from before it is worthless, which is
   * correct rather than unfortunate.
   */
  seq?: number;
}

/**
 * What a reconnecting panel says it already has.
 *
 * The pair is inseparable: a sequence number from a previous boot of the Master
 * names a position in a ring that no longer exists, and acting on it would
 * replay the wrong events. Persisted in the same disk write as the snapshot it
 * describes, so the two can never disagree.
 */
export interface SyncDeltaCursor {
  bootId: string;
  lastSeq: number;
}

/**
 * The Master's answer to a cursor: either the changes since it, or — whenever
 * the delta cannot be trusted — the whole snapshot, exactly as before.
 */
export interface SyncDelta {
  bootId: string;
  /** The cursor to store after applying these. */
  seq: number;
  events: DataChangedEvent[];
  /** A role can be edited while a panel is off; these ride along. */
  permissions: string[];
  partyGrants?: Array<{ partyId: string; level: PartyAccessLevel }>;
  dashboard: DashboardSummary;
  serverHlc: string;
  serverTime: string;
  serverVersion?: string;
}

/**
 * The entities a panel can apply from a replayed event — exactly the ones
 * `master-connection.ts#applyChange` has a case for.
 *
 * Kept here, in the shared protocol, rather than beside `applyChange`: the
 * Master decides whether a delta is safe and the panel decides what to do with
 * one, and two lists that had to agree would eventually not.
 */
export const REPLAYABLE_ENTITIES: readonly ChangedEntity[] = [
  'lead',
  'order',
  'party',
  'product',
  'product_category',
  'stock',
];

/**
 * In the snapshot, but not as a flat id-keyed list a single event can upsert.
 *
 * A replayed change to one of these would be dropped on the floor and never
 * covered by anything — `partyVariants` is the sharp one, because those are
 * per-party negotiated rates and staff would quote from stale prices with no
 * error anywhere. So the presence of any of these in a buffered range forces
 * the full snapshot instead.
 */
export const SNAPSHOT_FORCING_ENTITIES: readonly ChangedEntity[] = [
  'party_variant',
  'sync_conflict',
  'reservation',
  'pipeline',
  'option_list',
  'custom_field',
  // A bulk import: many rows, one event, and the only honest answer is to
  // fetch the catalogue page again.
  'catalog',
];

/**
 * Not in a panel's snapshot at all, so nothing about them can go stale on one.
 *
 * `role` and `user` are additionally withheld from panels outright
 * (`DIRECTORY_ENTITIES` in the hub). `office_panel` is the one that
 * makes this third bucket worth having rather than folding into the one above:
 * every panel's periodic self-report publishes one, so treating it as
 * snapshot-forcing would mean a reconnecting panel almost always found a
 * non-replayable event and the delta would never be used.
 */
export const PANEL_IRRELEVANT_ENTITIES: readonly ChangedEntity[] = [
  'office_panel',
  'role',
  'user',
];

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
  /** Computed per-actor by the Master. Absent figures mean "not yours", never zero. */
  dashboard: DashboardSummary;
  /** What this panel's signed-in user may do, so the UI can hide what it must. */
  permissions: string[];
  /**
   * The signed-in person's own Party Access grants, for the parties in this
   * snapshot. One field rather than two derived lists, because both things the
   * UI needs fall out of it: which parties are theirs (the "My parties"
   * toggle), and which of those they may read but not change (the Add Lead
   * picker leaves those out).
   *
   * Optional, so a panel built against this field still reads a snapshot from
   * an older Master. Absence means "no grants known", which fails in the
   * *permissive* direction on purpose: the picker offers the party, the Master
   * refuses if it must, and the person sees a reason — rather than an option
   * they were entitled to disappearing with no explanation.
   */
  partyGrants?: Array<{ partyId: string; level: PartyAccessLevel }>;
  /**
   * The user this snapshot was scoped for, so a panel can tell whether the
   * copy on its disk is still the right one for whoever is signed in now.
   *
   * It matters only offline. Online, signing in re-fetches the snapshot; with
   * no Master to ask, a second person signing in on the same panel would
   * otherwise be shown the first person's restricted parties — the easiest
   * bypass of the whole feature there is. `null` for an unattended panel.
   */
  builtForUserId?: string | null;
  /**
   * Which run of the Master built this, and where its change ring stood.
   *
   * The pair is what lets the *next* reconnect be a delta rather than another
   * snapshot. Optional, because a panel reading a snapshot from an older Master
   * simply has no cursor to offer and gets the full snapshot it always got.
   */
  bootId?: string;
  seq?: number;
  /** The Master's current HLC, folded into the panel's clock on receipt. */
  serverHlc: string;
  serverTime: string;
  /**
   * What the Master is running, so a panel can tell whether it is behind
   * without a second round trip. Optional so a panel built against this field
   * still reads a snapshot from an older Master.
   */
  serverVersion?: string;
  /**
   * Whether `products` above is the whole catalogue, not one clamped page.
   * The Office image cache sweep needs this: `products` is capped at the
   * snapshot's page limit, and a truncated or permission-emptied list is not
   * a trustworthy "what should still be on disk" answer. Optional so a panel
   * reading a snapshot from an older Master treats it as unknown and skips
   * the sweep rather than trusting an absent flag.
   */
  productsComplete?: boolean;
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
  'auth:reconcile': (users: KnownPanelUser[], ack: CommandAck<{ forget: string[] }>) => void;

  'party:list': (query: ListQuery, ack: CommandAck<Paginated<Party>>) => void;
  'party:create': (input: PartyInput, ack: CommandAck<Party>) => void;
  'party:update': (payload: { id: RecordId; input: PartyInput }, ack: CommandAck<Party>) => void;

  'product:list': (query: ProductListQuery, ack: CommandAck<ProductListPage>) => void;
  'product:create': (input: ProductInput, ack: CommandAck<Product>) => void;
  'product:update': (
    payload: { id: RecordId; input: ProductInput },
    ack: CommandAck<Product>,
  ) => void;

  /*
   * Image **bytes** deliberately do not travel here.
   *
   * They used to: `product:image:upload` and `image:fetch` carried them as
   * Socket.IO binary attachments, which meant `maxHttpBufferSize` had to be
   * `MAX_SOURCE_BYTES` — a per-frame ceiling set by the largest photo anybody
   * might drag in, applied to every sync push and every command on the
   * connection. They are now `POST /api/panel/products/:id/images` and
   * `GET /api/panel/images/:id/:variant`, authenticated by the panel's pairing
   * credentials plus the acting user's token so the permission checks and the
   * audit trail are unchanged. Metadata still travels here, because it is
   * small and it is a mutation like any other.
   */
  'product:image:update': (
    payload: { id: Uuid; input: ProductImageUpdateInput },
    ack: CommandAck<Product>,
  ) => void;
  'product:image:reorder': (input: ProductImageReorderInput, ack: CommandAck<Product>) => void;
  'product:image:delete': (id: Uuid, ack: CommandAck<Product>) => void;

  /**
   * Rows for a searchable dropdown.
   *
   * A different question from `search`: that one says where a word appears
   * across four indexes, this one says which record you mean for one kind and
   * hands back whole rows, because what is chosen goes straight into a line or
   * a form. The Office panel answers it from its own cached snapshot when the
   * link is down — see `offline-pick.ts` — so the shape has to be the same
   * either way.
   */
  pick: (
    payload: { kind: PickKind; query: PickQuery },
    ack: CommandAck<ProductPickPage | PartyPickPage | VariantPickPage>,
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
  'lead:update': (payload: { id: RecordId; input: LeadUpdateInput }, ack: CommandAck<Lead>) => void;
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

  // --- Recycle Bin (docs/backend-modules/04-API-CONTRACT.md §4) ------------
  // Deletes are Master-online-only — no MutationKind, nothing queued into the
  // outbox. A panel that cannot reach the Master cannot delete or restore.
  'party:delete': (id: RecordId, ack: CommandAck<{ id: RecordId; deletedAt: string }>) => void;
  'product:delete': (id: RecordId, ack: CommandAck<{ id: RecordId; deletedAt: string }>) => void;
  'lead:delete': (id: RecordId, ack: CommandAck<{ id: RecordId; deletedAt: string }>) => void;
  'order:delete': (id: RecordId, ack: CommandAck<{ id: RecordId; deletedAt: string }>) => void;

  'recycleBin:list': (query: RecycleBinQuery, ack: CommandAck<CursorPage<BinEntry>>) => void;
  'recycleBin:counts': (ack: CommandAck<BinCounts>) => void;
  'recycleBin:restore': (input: RestoreInput, ack: CommandAck<BinRestoreResult>) => void;

  // --- Party Access ---------------------------------------------------------
  // Reading needs `party.assign` or `party.accessAll`; writing needs
  // `party.assign` (admin tier). Nothing here is queued offline, for the same
  // reason as Fields below: a whole-set grant has no field-level merge, and
  // merging two administrators' offline edits would produce a union neither
  // approved.
  'partyAccess:list': (query: PartyAccessQuery, ack: CommandAck<Paginated<PartyAccessRow>>) => void;
  'partyAccess:forParty': (partyId: RecordId, ack: CommandAck<PartyAccessRow>) => void;
  'partyAccess:people': (ack: CommandAck<AssignablePerson[]>) => void;
  'partyAccess:export': (ack: CommandAck<{ csv: string; rowCount: number }>) => void;
  'partyAccess:replace': (
    payload: { partyId: RecordId; input: PartyAccessInput },
    ack: CommandAck<PartyAccessRow>,
  ) => void;

  // --- Fields (docs/backend-modules/04-API-CONTRACT.md §5) ------------------
  // Reading is `fields.view` (every tier); editing is `fields.manage`
  // (management+). Nothing here is queued offline — see fields.service.ts.
  'fields:catalogue': (ack: CommandAck<FieldCatalogue>) => void;
  'fields:values': (
    query: { listKey: string; includeDeleted?: boolean; includeUnlisted?: boolean },
    ack: CommandAck<{ items: OptionListItem[]; unlisted?: string[] }>,
  ) => void;
  'fields:usage': (query: { listKey: string }, ack: CommandAck<FieldUsageBreakdown>) => void;
  'fields:createValue': (input: OptionListItemInput, ack: CommandAck<OptionListItem>) => void;
  'fields:updateValue': (
    payload: { id: Uuid; input: OptionListItemUpdateInput },
    ack: CommandAck<OptionListItem>,
  ) => void;
  'fields:deleteValue': (id: Uuid, ack: CommandAck<{ id: Uuid; deletedAt: IsoTimestamp }>) => void;
  'fields:reorderValues': (
    input: OptionListReorderInput,
    ack: CommandAck<OptionListItem[]>,
  ) => void;

  'fields:definitions': (
    query: { entity?: string; includeDeleted?: boolean },
    ack: CommandAck<CustomFieldDefinition[]>,
  ) => void;
  'fields:createDefinition': (
    input: CustomFieldDefinitionInput,
    ack: CommandAck<CustomFieldDefinition>,
  ) => void;
  'fields:updateDefinition': (
    payload: { id: Uuid; input: CustomFieldDefinitionUpdateInput },
    ack: CommandAck<CustomFieldDefinition>,
  ) => void;
  'fields:deleteDefinition': (
    id: Uuid,
    ack: CommandAck<{ id: Uuid; deletedAt: IsoTimestamp }>,
  ) => void;
  'fields:reorderDefinitions': (
    input: CustomFieldReorderInput,
    ack: CommandAck<CustomFieldDefinition[]>,
  ) => void;

  'fields:stages': (ack: CommandAck<Pipeline[]>) => void;
  'fields:updateStage': (
    payload: { id: Uuid; input: PipelineStageInput },
    ack: CommandAck<PipelineStage>,
  ) => void;
  'fields:reorderStages': (input: StageReorderInput, ack: CommandAck<PipelineStage[]>) => void;
  'fields:archiveStage': (id: Uuid, ack: CommandAck<PipelineStage>) => void;
  'fields:restoreStage': (id: Uuid, ack: CommandAck<PipelineStage>) => void;

  // --- Logs (docs/backend-modules/04-API-CONTRACT.md §2) --------------------
  'log:list': (query: ActivityLogQuery, ack: CommandAck<CursorPage<ActivityLogEntry>>) => void;
  'log:facets': (query: { from?: string; to?: string }, ack: CommandAck<ActivityLogFacets>) => void;
  'log:verifyChain': (input: ChainVerifyInput, ack: CommandAck<ChainVerification>) => void;
  /** CSV as a string in the ack — the Office server has no streaming transport to its own browser for this call. */
  'log:export': (
    query: ActivityLogQuery,
    ack: CommandAck<{ csv: string; rowCount: number }>,
  ) => void;

  // --- Reports (docs/backend-modules/04-API-CONTRACT.md §3) -----------------
  'report:dispatches': (query: ReportRangeInput, ack: CommandAck<DispatchesReport>) => void;
  'report:leadOutcomes': (query: ReportRangeInput, ack: CommandAck<LeadOutcomesReport>) => void;
  'report:topParties': (
    query: ReportRangeInput & { limit?: number },
    ack: CommandAck<TopPartiesReport>,
  ) => void;
  /**
   * A report as a file.
   *
   * The ack is a **discriminated union**, not an optional `bytes`: the Office
   * panel forwards this and has to know which door to send it out of. It used
   * to cast the ack to `{ csv: string }` and always set `text/csv`, so the
   * moment a second format existed a PDF would have arrived as a corrupt CSV.
   */
  'report:export': (
    payload: {
      report: ReportKind;
      query: ReportRangeInput & { limit?: number } & ReportExportOptions;
    },
    ack: CommandAck<
      | { format: 'csv'; csv: string; rowCount: number }
      | {
          format: 'pdf';
          fileName: string;
          contentType: string;
          bytes: Uint8Array;
          rowCount: number;
        }
    >,
  ) => void;

  /*
   * --- The assistant ------------------------------------------------------
   *
   * `ai:start` acks the moment the run row exists and the request is away,
   * **never** on completion: `MasterConnection.command` hard-fails after
   * fifteen seconds and would report the Master unreachable while the model was
   * still typing. Every token afterwards arrives on `ai:event`.
   */
  'ai:start': (input: AiStartInput, ack: CommandAck<{ runId: Uuid }>) => void;
  'ai:cancel': (runId: Uuid, ack: CommandAck<null>) => void;
  'ai:listRuns': (ack: CommandAck<AiRun[]>) => void;
  'ai:status': (ack: CommandAck<AiStatus>) => void;
  'ai:insights': (ack: CommandAck<Insight[]>) => void;
  'ai:apply': (payload: { runId: Uuid; fields: string[] }, ack: CommandAck<null>) => void;

  // --- Dashboard (docs/backend-modules/04-API-CONTRACT.md §7) ---------------
  /** The one live pull — everything else rides on `SyncSnapshot.dashboard` and the `dashboard:changed` push. */
  'dashboard:get': (ack: CommandAck<DashboardSummary>) => void;

  // --- Panel administration -------------------------------------------------
  /**
   * What this panel is, and where it keeps its files.
   *
   * Volunteered, because it cannot be asked for on the panel's own terms: an
   * Office Panel serves its HTTP API on loopback only, so the Master has no way
   * to reach into it. Sent on every connect and on a slow timer thereafter, and
   * answerable on demand through `panel:describe`.
   */
  'panel:report': (report: OfficePanelReportInput, ack: CommandAck<null>) => void;
}

/** Master → clients. */
export interface ServerToClientEvents {
  'sync:snapshot': (snapshot: SyncSnapshot) => void;
  /**
   * The answer to a reconnecting panel's cursor: the changes it missed, rather
   * than the whole snapshot. Sent in `sync:snapshot`'s place, never as well.
   */
  'sync:delta': (delta: SyncDelta) => void;
  'data:changed': (event: DataChangedEvent) => void;
  /** One fragment of an answer, one tool step, or the finished run. */
  'ai:event': (event: AiStreamEvent & { runId: Uuid }) => void;
  'panels:changed': (panels: OfficePanelWithPresence[]) => void;
  'dashboard:changed': (summary: DashboardSummary) => void;
  /** Raised when a merge shadowed somebody's value, so panels can surface it. */
  'sync:conflict': (conflict: SyncConflict) => void;
  /** Master tells a panel its pairing was revoked; the panel must re-pair. */
  'panel:revoked': () => void;
  /**
   * Master asks a panel to describe itself right now.
   *
   * Sent when an administrator opens that panel's screen, so the figures on it
   * are current rather than however stale the last timed report left them.
   */
  'panel:describe': (ack: CommandAck<OfficePanelReportInput>) => void;
  /**
   * Master hands a panel a freshly issued secret, which it must persist before
   * acknowledging. The old secret stops working the moment the Master stores
   * the new hash, so an ack that never arrives means somebody has to re-pair
   * that PC by hand — which is exactly what `PanelSecretRotation.delivered`
   * reports back to the operator.
   */
  'panel:credentials': (payload: { panelSecret: string }, ack: CommandAck<null>) => void;
  /** Master asks a panel to move its data folder to another path on its own disk. */
  'panel:setStoragePath': (
    input: PanelStoragePathInput,
    ack: CommandAck<PanelStoragePathResult>,
  ) => void;
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
   * Assistant runs this socket started, so its `ai:event` listener can filter
   * on set membership rather than resolving an actor per streamed token.
   */
  aiRuns?: Set<Uuid>;
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
