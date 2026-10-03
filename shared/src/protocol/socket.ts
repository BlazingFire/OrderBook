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
import type {
  CompanyFeatures,
  CustomFieldDefinition,
  DashboardSummary,
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
  ProductCategoryListRow,
  RecordId,
  SearchHit,
  SignedInUser,
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
  ReportOptions,
  ReportQuery,
  ReportRangeInput,
  ReportTable,
  TopPartiesReport,
} from '../domain/reports.js';
import type {
  AssignablePerson,
  CategoryInput,
  CategoryUpdateInput,
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
  RestoreInput,
  SearchQuery,
  StageChangeInput,
  StageReorderInput,
} from '../domain/inputs.js';
import type {
  CategoryPickPage,
  PartyPickPage,
  PickKind,
  PickQuery,
  ProductPickPage,
} from '../domain/pick.js';
import type { BinCounts, BinEntry, BinRestoreResult } from '../domain/recycle-bin.js';
import type { SettingKey, SettingView } from '../domain/settings.js';
import { CHAT_MIN_PROTOCOL } from '../domain/chat.js';
import { PRINTROOM_MIN_PROTOCOL } from '../domain/printroom.js';
import type {
  PrintJob,
  PrintJobInput,
  PrintJobPage,
  PrintJobQuery,
  PrintJobSummary,
  PrintStation,
  PrintStationInput,
} from '../domain/printroom.js';
import type {
  ChatAccessRequest,
  ChatMemberRole,
  ChatMessage,
  ChatPush,
  ChatRoomDetail,
  ChatRoomInput,
  ChatRoomPatch,
  ChatRoomSummary,
  ChatPerson,
  ChatSearchHit,
  ChatTaskRow,
} from '../domain/chat.js';
import type { UserNotification } from '../domain/notifications.js';
import type { SyncPushRequest, SyncPushResponse } from '../sync/mutations.js';
import type { BoardPresence, PresenceBeat, PresenceRecordKind, RecordPresence } from './presence.js';
import { BOARD_PRESENCE_MIN_PROTOCOL } from './presence.js';

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
  /**
   * The panel protocol this Office speaks (`PANEL_PROTOCOL_VERSION` at its
   * build). Absent from an Office built before the handshake, which the Master
   * reads as protocol 1.
   */
  protocol?: number;
  /** The Office's own version, for the Master's Panels screen. */
  appVersion?: string;
  /**
   * The session token of whoever is signed in on the panel, so the Master acts
   * as them from the first message instead of sending a panel-scoped snapshot
   * and a second one after `auth:assume`. An older Master ignores it.
   */
  actingUserToken?: string;
}

/**
 * The protocol this build speaks. It rises by one in each release that adds a
 * socket command, so either side can tell the other is too old for one before
 * sending it, instead of waiting out a timeout.
 */
export const PANEL_PROTOCOL_VERSION = 7;

/**
 * The lowest Master protocol each command needs. A command not listed has
 * existed since protocol 1, which is what a Master that sends no protocol is
 * taken to speak.
 */
export const COMMAND_MIN_PROTOCOL: Partial<Record<keyof ClientToServerEvents, number>> = {
  'auth:offlineEvents': 2,
  'report:table': 2,
  'report:options': 2,
  'notification:list': 3,
  'notification:markRead': 3,
  // The Chatroom (1.3 Phase 6). Phase 4 takes the protocol to 4; chat is 5.
  'chat:people': CHAT_MIN_PROTOCOL,
  'chat:rooms': CHAT_MIN_PROTOCOL,
  'chat:room': CHAT_MIN_PROTOCOL,
  'chat:messages': CHAT_MIN_PROTOCOL,
  'chat:search': CHAT_MIN_PROTOCOL,
  'chat:tasks': CHAT_MIN_PROTOCOL,
  'chat:roomCreate': CHAT_MIN_PROTOCOL,
  'chat:roomUpdate': CHAT_MIN_PROTOCOL,
  'chat:memberSet': CHAT_MIN_PROTOCOL,
  'chat:direct': CHAT_MIN_PROTOCOL,
  'chat:edit': CHAT_MIN_PROTOCOL,
  'chat:delete': CHAT_MIN_PROTOCOL,
  'chat:pin': CHAT_MIN_PROTOCOL,
  'chat:taskDone': CHAT_MIN_PROTOCOL,
  'chat:read': CHAT_MIN_PROTOCOL,
  'chat:mute': CHAT_MIN_PROTOCOL,
  'chat:requestAccess': CHAT_MIN_PROTOCOL,
  // The Printroom (1.3 Phase 7): chat took 5, so this is 6.
  'print:list': PRINTROOM_MIN_PROTOCOL,
  'print:get': PRINTROOM_MIN_PROTOCOL,
  'print:send': PRINTROOM_MIN_PROTOCOL,
  'print:mark': PRINTROOM_MIN_PROTOCOL,
  'print:cancel': PRINTROOM_MIN_PROTOCOL,
  'print:claim': PRINTROOM_MIN_PROTOCOL,
  'print:stations': PRINTROOM_MIN_PROTOCOL,
  'print:station': PRINTROOM_MIN_PROTOCOL,
  'presence:beat': 4,
  // Who is on each card of a board (1.4 R22).
  'presence:board': BOARD_PRESENCE_MIN_PROTOCOL,
};

/**
 * One sign-in an Office checked against its own offline verifier while the
 * Master was unreachable, uploaded on reconnect so the audit trail has it.
 * `at` is when it happened on the Office, not when the Master heard of it.
 */
export interface OfflineAuthEvent {
  username: string;
  /** Known when the Office holds a verifier for this person. */
  userId?: string;
  success: boolean;
  at: IsoTimestamp;
  /**
   * Made by the Office when it records the event (1.3), so the Master can skip
   * one it already logged when an upload is sent again. Optional: an older
   * Office sends none, and its events are logged as they come.
   */
  id?: string;
}

/** Handshake `auth` payload sent by a Master Panel browser. */
export interface AdminAuthPayload {
  kind: 'master-admin';
  sessionToken: string;
  /**
   * The browser tab's presence id (at most 64 characters), so closing the tab
   * takes it off the records it had open at once rather than after the TTL.
   */
  tabId?: string;
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
  | 'catalog'
  /**
   * The party book moved at once — a bulk party import. Like `catalog`: no
   * single row to upsert, one event, one refresh. `id` is the tenant and
   * `payload` the counts. A panel older than `PARTY_BULK_MIN_PROTOCOL` does not
   * know the name, so the Master sends it a snapshot instead.
   */
  | 'party_bulk'
  /**
   * A company switch was written.
   *
   * Not a row a panel upserts — a field of the snapshot itself. `id` is the
   * setting key and `payload` is deliberately `null`: a sealed setting's value
   * must never ride the change ring, and nothing needs it, because this entity
   * forces a fresh snapshot rather than being folded in.
   *
   * It had no event at all until 2026-09-18, which meant `inventory.freeToSell`
   * reached a panel exactly once, on its first snapshot, and every later flip
   * was invisible to a panel that stayed connected *and* to one that
   * reconnected with a usable cursor.
   */
  | 'setting';

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
  /**
   * Who made the change, for "Ravi saved this at 10:42" on a record somebody
   * else has open. Set on lead and order changes; optional, because a Master
   * before 1.3 sends neither, and null when no person made it.
   */
  actorUserId?: string | null;
  actorName?: string | null;
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
  /** The Master's `PANEL_PROTOCOL_VERSION`. Absent from an older Master, which means 1. */
  protocol?: number;
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
];

/**
 * In the snapshot, but not as a flat id-keyed list a single event can upsert.
 *
 * A replayed change to one of these would be dropped on the floor and never
 * covered by anything — `partyVariants` is the sharp one, because those are
 * the name, size and packaging agreed with each party, and staff would build
 * that party's lead lines from a superseded one with no error anywhere. So the
 * presence of any of these in a buffered range forces the full snapshot
 * instead.
 */
export const SNAPSHOT_FORCING_ENTITIES: readonly ChangedEntity[] = [
  'party_variant',
  'sync_conflict',
  'pipeline',
  'option_list',
  'custom_field',
  // A bulk import: many rows, one event, and the only honest answer is to
  // fetch the catalogue page again.
  'catalog',
  // A bulk party import, for the same reason.
  'party_bulk',
  // A company switch. It is not in any id-keyed list, so there is nothing to
  // upsert — `features` is a field of the snapshot. Listing it here buys both
  // halves from one place: the live path refreshes, and a reconnecting panel's
  // delta is refused so it takes the full snapshot. Listing it as REPLAYABLE
  // instead would drop it on the floor, and listing it as PANEL_IRRELEVANT
  // would drop it *before* the replayability test in `delta.service.ts`.
  'setting',
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
  /**
   * Always empty. Stock was removed in 1.4; the Master still sends the key so an
   * Office built before then, which reads `snapshot.stock` without a guard, keeps
   * working until it is updated. Nothing in 1.4 reads it.
   */
  stock?: never[];
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
  /**
   * The company switches the panel's screens read (`domain/entities.ts`).
   * Optional so a panel built against this field still reads a snapshot from
   * an older Master; absent means "as before", every figure shown.
   */
  features?: CompanyFeatures;
  /** The Master's `PANEL_PROTOCOL_VERSION`. Absent from an older Master, which means 1. */
  protocol?: number;
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
  /**
   * Hand over the sign-ins this panel checked offline, oldest first. At most
   * 500 per call; the Master logs each one and answers how many it accepted, and
   * the panel drops them only on that answer.
   */
  'auth:offlineEvents': (
    events: OfflineAuthEvent[],
    ack: CommandAck<{ recorded: number }>,
  ) => void;

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
    ack: CommandAck<CategoryPickPage | ProductPickPage | PartyPickPage>,
  ) => void;

  /*
   * Categories — the owner's Products (`docs/catalogue/CATALOGUE_MODEL.md`
   * §5). Online-only like the Recycle Bin: a category carries no hlc to merge,
   * so nothing here is queued. The Office answers `category:list` from its
   * snapshot when the link is down; the writes fail 503 instead.
   */
  'category:list': (
    query: { search?: string; brand?: string },
    ack: CommandAck<ProductCategoryListRow[]>,
  ) => void;
  'category:create': (input: CategoryInput, ack: CommandAck<ProductCategory>) => void;
  'category:update': (
    payload: { id: RecordId; input: CategoryUpdateInput },
    ack: CommandAck<ProductCategory>,
  ) => void;
  'category:delete': (id: RecordId, ack: CommandAck<{ id: RecordId; deletedAt: string }>) => void;

  /**
   * A company setting written from an Office panel's Settings → Leads tab.
   * Only `leads.followUpDefaultDays`, and only as a signed-in person — the
   * Master refuses the panel's own role (`assertPanelSettingWrite` in the hub)
   * and still checks `settings.manage`. Answers with the list, as
   * `PUT /api/settings/:key` does.
   */
  'settings:save': (
    payload: { key: SettingKey; value: unknown },
    ack: CommandAck<SettingView[]>,
  ) => void;

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
  /**
   * The fixed-layout lead PDF (`docs/catalogue/CATALOGUE_MODEL.md` §8), bytes
   * in the ack like `report:export`'s PDF. `leads.export`; online-only.
   */
  'lead:pdf': (id: RecordId, ack: CommandAck<{ fileName: string; bytes: Uint8Array }>) => void;

  'order:list': (query: OrderListQuery, ack: CommandAck<Paginated<Order>>) => void;
  'order:get': (id: RecordId, ack: CommandAck<Order>) => void;
  'order:update': (
    payload: { id: RecordId; input: OrderUpdateInput },
    ack: CommandAck<Order>,
  ) => void;
  'order:setStage': (input: StageChangeInput, ack: CommandAck<Order>) => void;
  'order:dispatch': (input: OrderDispatchInput, ack: CommandAck<Order>) => void;

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
      query: ReportQuery & ReportExportOptions;
    },
    ack: CommandAck<
      | { format: 'csv'; csv: string; rowCount: number }
      | {
          format: 'pdf' | 'xlsx';
          fileName: string;
          contentType: string;
          bytes: Uint8Array;
          rowCount: number;
        }
    >,
  ) => void;
  /**
   * Any of the fifteen reports as one table — the shape both panels' Reports
   * screen draws and an export writes. The legacy `report:dispatches` /
   * `leadOutcomes` / `topParties` events stay for Offices that predate it.
   */
  'report:table': (payload: { report: ReportKind; query: ReportQuery }, ack: CommandAck<ReportTable>) => void;
  /** The kinds on offer to this person, who they may pick as a subject (null: only themselves), and whether to offer an export. */
  'report:options': (ack: CommandAck<ReportOptions>) => void;


  // --- Notifications (the bell) --------------------------------------------
  /** The acting person's newest notifications. With nobody signed in: none. */
  'notification:list': (
    input: { limit?: number; before?: IsoTimestamp },
    ack: CommandAck<{ items: UserNotification[]; unreadCount: number }>,
  ) => void;
  /** Mark some (`ids`) or all of the acting person's notifications read. */
  'notification:markRead': (
    input: { ids?: string[]; all?: boolean },
    ack: CommandAck<{ unreadCount: number }>,
  ) => void;

  // --- Chatroom (1.3 Phase 6) ----------------------------------------------
  /*
   * Twinned with the Master's `/api/chat` REST routes: the Master's own browser
   * uses those, an Office Panel uses these. There is deliberately no
   * `chat:post`: an Office posts through `sync:push` as a `chat.post` mutation,
   * which gives it the outbox, idempotency and a resend on reconnect.
   */
  /** Everyone the acting person may chat with. */
  'chat:people': (ack: CommandAck<ChatPerson[]>) => void;
  /** The acting person's rooms (all groups, for `chat.manage`, with `all`). */
  'chat:rooms': (
    input: { all?: boolean; includeArchived?: boolean },
    ack: CommandAck<ChatRoomSummary[]>,
  ) => void;
  'chat:room': (roomId: Uuid, ack: CommandAck<ChatRoomDetail>) => void;
  'chat:messages': (
    input: { roomId: Uuid; beforeSeq?: number; limit?: number },
    ack: CommandAck<ChatMessage[]>,
  ) => void;
  'chat:search': (input: { q: string; roomId?: Uuid }, ack: CommandAck<ChatSearchHit[]>) => void;
  'chat:tasks': (
    input: { scope: 'mine' | 'created'; includeDone?: boolean },
    ack: CommandAck<ChatTaskRow[]>,
  ) => void;
  'chat:roomCreate': (input: ChatRoomInput, ack: CommandAck<ChatRoomSummary>) => void;
  'chat:roomUpdate': (
    input: { roomId: Uuid; input: ChatRoomPatch },
    ack: CommandAck<ChatRoomSummary>,
  ) => void;
  /** Add, re-role or remove (`role: null`) one member. */
  'chat:memberSet': (
    input: { roomId: Uuid; userId: string; role: ChatMemberRole | null },
    ack: CommandAck<ChatRoomDetail | null>,
  ) => void;
  'chat:direct': (input: { userId: string }, ack: CommandAck<ChatRoomSummary>) => void;
  'chat:edit': (
    input: { messageId: string; body: string; mentions?: string[] },
    ack: CommandAck<ChatMessage>,
  ) => void;
  'chat:delete': (messageId: string, ack: CommandAck<ChatMessage>) => void;
  'chat:pin': (input: { messageId: string; pinned: boolean }, ack: CommandAck<ChatMessage>) => void;
  'chat:taskDone': (
    input: { messageId: string; done: boolean },
    ack: CommandAck<ChatMessage>,
  ) => void;
  'chat:read': (input: { roomId: Uuid; seq: number }, ack: CommandAck<{ lastReadSeq: number }>) => void;
  'chat:mute': (input: { roomId: Uuid; muted: boolean }, ack: CommandAck<null>) => void;
  /** Ask the people who edit roles for a chat capability the acting person lacks. */
  'chat:requestAccess': (input: ChatAccessRequest, ack: CommandAck<{ notified: number }>) => void;
  // --- Presence -------------------------------------------------------------
  /**
   * The acting person has a record open in one tab (or left it, with no
   * record named). Answers with everyone on that record; never stored or
   * logged. Refused with nobody signed in, or for a record they may not see.
   */
  'presence:beat': (beat: PresenceBeat, ack: CommandAck<RecordPresence | null>) => void;
  /**
   * Everyone on every record of one board, for the avatars on its cards and rows;
   * limited to records the acting person may read. The same answer is pushed as
   * `presence:board` whenever it changes (1.4 R22, protocol 7).
   */
  'presence:board': (kind: PresenceRecordKind, ack: CommandAck<BoardPresence>) => void;

  // --- Printroom (1.3 Phase 7) ----------------------------------------------
  /*
   * Twinned with the Master's `/api/print-jobs` and `/api/print-stations` REST
   * routes: the Master's own browser uses those (and, for its claim, this
   * command over its own socket), an Office Panel uses these. The station a
   * `print:claim` or `print:station` speaks for comes from the connection
   * (`socket.data.panelId`), never from the payload.
   */
  'print:list': (input: PrintJobQuery, ack: CommandAck<PrintJobPage>) => void;
  'print:get': (id: Uuid, ack: CommandAck<PrintJob>) => void;
  'print:send': (input: PrintJobInput, ack: CommandAck<PrintJob>) => void;
  /** Mark a job printed, or (`printed: false`) put a printed one back in the queue. */
  'print:mark': (
    input: { id: Uuid; printed: boolean; printerName?: string | null },
    ack: CommandAck<PrintJobSummary>,
  ) => void;
  'print:cancel': (id: Uuid, ack: CommandAck<PrintJobSummary>) => void;
  /** Take a job for this connection's station; `null` when somebody else holds it or it is gone. */
  'print:claim': (id: Uuid, ack: CommandAck<PrintJob | null>) => void;
  'print:stations': (ack: CommandAck<PrintStation[]>) => void;
  /** Register this PC as a station, or say it is still alive. */
  'print:station': (input: PrintStationInput, ack: CommandAck<PrintStation>) => void;

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
  /**
   * A notification for one person. `forUserId` names them, and a panel drops it
   * unless that person is still the one signed in there.
   */
  'notification:new': (notification: UserNotification & { forUserId: Uuid }) => void;
  /**
   * Something changed in a chat room the acting person is in. Addressed like a
   * notification, and like one it never enters the change ring: a panel that
   * missed it reads the room again.
   */
  'chat:event': (push: ChatPush & { forUserId: Uuid }) => void;
  /**
   * A print job was sent or changed. Addressed to the sender and to every
   * holder of `print.station`; live only (no change ring), so a panel that
   * missed one reads the list again.
   */
  'print:changed': (job: PrintJobSummary & { forUserId: Uuid }) => void;
  /**
   * Who is on a record changed. Sent only to people on that record who may
   * still see it, each addressed by `forUserId` like a notification.
   */
  'presence:changed': (presence: RecordPresence & { forUserId: Uuid }) => void;
  /**
   * Who is on each card of a board changed (protocol 7). The whole board for this
   * person, throttled by the Master; an Office older than 7 is not sent it.
   */
  'presence:board': (board: BoardPresence & { forUserId: Uuid }) => void;
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
  /** The person `actingUserToken` resolved to, for addressing per-user pushes. */
  actingUserId?: Uuid;
  /**
   * A Master Panel browser's own session token, kept so the socket can
   * re-resolve it rather than trusting the handshake forever. Without it a
   * deactivated administrator's open socket keeps streaming.
   */
  sessionToken?: string;
  /** The protocol an Office Panel announced in its handshake; absent means 1. */
  protocol?: number;
  /** A Master Panel browser tab's presence id, from its handshake. */
  tabId?: string;
}
