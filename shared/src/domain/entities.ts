/**
 * Domain entity shapes as they travel over the wire between Master and Office.
 * These mirror the tables documented in docs/schema/, with Postgres timestamps
 * serialized to ISO strings and numeric columns already coerced to `number`.
 *
 * Two id types appear here on purpose:
 *   `Uuid`     infrastructure only the Master can create — tenants, users,
 *              roles, panels. Never minted offline, so it needs no id mapping.
 *   `RecordId` syncable business records. Text, because an offline panel must
 *              mint an id before the Master has seen the record — see
 *              shared/src/sync/ids.ts and docs/LEAD_GENERATION_FLOW.md §7.
 */

export type Uuid = string;

/** A syncable record's id: 15-char temporary, or 12-char permanent. */
export type RecordId = string;

/** ISO 8601 timestamp string, e.g. "2026-08-20T10:15:00.000Z". */
export type IsoTimestamp = string;
/** ISO 8601 calendar date, e.g. "2026-08-20". No time component, no zone. */
export type IsoDate = string;

/**
 * Sync bookkeeping carried by every syncable record. `version` counts edits for
 * optimistic-concurrency checks; `hlc` orders them across disconnected panels;
 * `fieldHlc` records the last writer *per field*, which is what lets two people
 * editing different fields offline both keep their change.
 */
export interface SyncMeta {
  version: number;
  hlc: string;
  fieldHlc: Record<string, string>;
  /** Present while a record still carries the id its origin panel minted. */
  temporaryId: RecordId | null;
}

// --- Tenancy, identity & access -------------------------------------------

export interface Tenant {
  id: Uuid;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Kept as an alias so older call sites keep compiling; `RoleTier` is canonical. */
export type RoleTierName = 'admin' | 'management' | 'office';

export interface Role {
  id: RecordId;
  tenantId: Uuid;
  name: string;
  tier: RoleTierName;
  /**
   * The whole permission set, as one array.
   *
   * Deliberately not a join table: permission sets are approved as a whole, so
   * they must merge as a whole. A per-key merge of two offline edits produces a
   * union that grants a combination neither administrator reviewed
   * (docs/ROLES_AND_USERS.md §5).
   */
  permissions: string[];
  /** True on the seeded Administrator role: undeletable and tier-locked. */
  isSystem: boolean;
  /** Live users holding this role. Drives the "in use" guard and the list. */
  userCount: number;
  /** Soft delete. The row stays so a restore can reattach its users. */
  deletedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

/**
 * A person who signs in.
 *
 * There is deliberately no `passwordHash` property. The repository strips it,
 * and the type not declaring it means a future caller cannot even ask
 * (docs/ROLES_AND_USERS.md §12).
 */
export interface User {
  id: RecordId;
  tenantId: Uuid;
  username: string;
  displayName: string;
  roleId: RecordId | null;
  roleName: string;
  roleTier: RoleTierName;
  /** Deactivation. Distinct from deletion: history and records are untouched. */
  isActive: boolean;
  lastSignInAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

/** What a signed-in caller is told about themselves. */
export interface SignedInUser extends User {
  /** Already intersected with the tier ceiling. */
  permissions: string[];
  /** Bumped when the role changes, so a stale session is detected per call. */
  roleVersion: number;
}

export type OfficePanelStatus = 'pending' | 'active' | 'revoked';

export interface OfficePanel {
  id: Uuid;
  tenantId: Uuid;
  name: string;
  /** Which role this panel's own commands act under; null falls back to Office. */
  roleId: RecordId | null;
  /** The 6-char code this panel stamps into temporary ids and HLC timestamps. */
  deviceCode: string;
  lanIp: string | null;
  macAddress: string | null;
  status: OfficePanelStatus;
  pairedAt: IsoTimestamp | null;
  lastSeenAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Live connection state, derived at runtime — not a database column. */
export interface OfficePanelWithPresence extends OfficePanel {
  isConnected: boolean;
}

// --- Configurable pipelines (the Kanban columns) ---------------------------

export type PipelineKind = 'lead' | 'order';

export interface PipelineStage {
  id: Uuid;
  pipelineId: Uuid;
  name: string;
  sequence: number;
  /** Where new records land. Exactly one per pipeline. */
  isDefault: boolean;
  /** A record in a terminal stage is finished — won, lost, dispatched. */
  isTerminal: boolean;
  colour: string | null;
}

export interface Pipeline {
  id: Uuid;
  tenantId: Uuid;
  kind: PipelineKind;
  name: string;
  stages: PipelineStage[];
}

// --- Configurable option lists & custom fields ------------------------------

/** e.g. listKey "lead.sourcePlatform" → WhatsApp / Call / Website / Walk-in. */
export interface OptionListItem {
  id: Uuid;
  tenantId: Uuid;
  listKey: string;
  value: string;
  label: string;
  sequence: number;
  isActive: boolean;
}

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';
export type CustomFieldEntity = 'lead' | 'order' | 'party' | 'product';

export interface CustomFieldDefinition {
  id: Uuid;
  tenantId: Uuid;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  /** A required custom field flags the record incomplete — it never blocks a save. */
  isRequired: boolean;
  options: string[];
  sequence: number;
  isActive: boolean;
}

// --- Reference data --------------------------------------------------------

export interface Party {
  id: RecordId;
  tenantId: Uuid;
  partyCode: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstNumber: string | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  isActive: boolean;
  createdByUserId: Uuid | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

export interface ProductCategory {
  id: RecordId;
  tenantId: Uuid;
  name: string;
  createdAt: IsoTimestamp;
}

export interface Product {
  id: RecordId;
  tenantId: Uuid;
  /** The guide's `code`. Typing it into a line auto-fills the rest. */
  productCode: string;
  name: string;
  alias: string | null;
  categoryId: RecordId | null;
  categoryName: string | null;
  size: string | null;
  /** Stock-item number carried through from the catalogue. */
  sin: string | null;
  grade: string | null;
  productType: string | null;
  weightKg: number | null;
  finish: string | null;
  series: string | null;
  color: string | null;
  thicknessMm: number | null;
  piecesPerBox: number | null;
  boxCoverageSqft: number | null;
  /**
   * Sale rate in the smallest currency unit. Optional because it is gated by
   * `field.saleRate.view` — a caller without it receives the key *absent*.
   */
  rate?: number | null;
  pricePerSqft?: number | null;
  hsnCode: string | null;
  /** Free-form ceramic specs that have no dedicated column yet. */
  parameters: Record<string, unknown>;
  customFields: Record<string, unknown>;
  isActive: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

/**
 * A party's own version of a product — the rate and spec agreed with that
 * customer. Used when a lead is in `partyWiseMode`.
 *
 * `packaging` is recorded for reference but is deliberately **never** copied
 * onto a line automatically; the UI offers it as a suggestion the user must
 * accept (docs/LEAD_GENERATION_FLOW.md §3.2).
 */
export interface PartyProductVariant {
  id: RecordId;
  tenantId: Uuid;
  partyId: RecordId;
  productId: RecordId;
  productName: string | null;
  alias: string | null;
  rate?: number | null;
  size: string | null;
  sin: string | null;
  grade: string | null;
  productType: string | null;
  weightKg: number | null;
  /** Suggestion only — see the note above. */
  packaging: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

// --- Line items (shared unchanged by leads and orders) ---------------------

export type LineItemParentType = 'lead' | 'order';

export interface LineItemQuantity {
  id: Uuid;
  colour: string;
  quantity: number;
}

/**
 * One product on a lead or an order. The snapshot fields are frozen at add
 * time: editing the product afterwards must not rewrite what an order was
 * quoted at (docs/LEAD_GENERATION_FLOW.md §8.3).
 */
export interface LineItem {
  id: RecordId;
  tenantId: Uuid;
  parentType: LineItemParentType;
  parentId: RecordId;
  /** Live reference — kept for stock movement and traceability. */
  productId: RecordId;

  // Snapshotted at add time
  productName: string;
  alias: string | null;
  /** Gated by `field.saleRate.view`; absent, not null, when not permitted. */
  rate?: number | null;
  code: string | null;
  sin: string | null;
  size: string | null;
  weightKg: number | null;
  grade: string | null;
  productType: string | null;

  /** Chosen manually on every line — never auto-filled. */
  packaging: string | null;
  sequence: number;
  fromPartyVariant: boolean;
  imagePath: string | null;
  notes: string | null;
  quantities: LineItemQuantity[];

  /** Sum of `quantities`, denormalized for list screens. */
  totalQuantity: number;
  /** `rate` × `totalQuantity`; absent alongside `rate` when not permitted. */
  lineTotal?: number | null;

  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// --- Timeline --------------------------------------------------------------

export type TimelineEntryKind = 'system' | 'remark';

export interface TimelineEntry {
  id: RecordId;
  tenantId: Uuid;
  parentType: LineItemParentType;
  parentId: RecordId;
  kind: TimelineEntryKind;
  message: string;
  fromStageId: Uuid | null;
  toStageId: Uuid | null;
  actorUserId: Uuid | null;
  actorName: string | null;
  createdAt: IsoTimestamp;
}

// --- Leads & orders --------------------------------------------------------

export interface Lead {
  id: RecordId;
  tenantId: Uuid;
  partyId: RecordId;
  partyName: string;
  ownerId: Uuid;
  ownerName: string | null;
  stageId: Uuid;
  stageName: string;
  stageSequence: number;
  sourcePlatform: string | null;
  followUpDate: IsoDate | null;
  partyWiseMode: boolean;
  notes: string | null;
  customFields: Record<string, unknown>;

  /** True when a required custom field is unanswered. Never blocks a save. */
  incomplete: boolean;
  missingFields: string[];

  /** Set on conversion. The lead is kept as history, never deleted. */
  convertedOrderId: RecordId | null;
  convertedAt: IsoTimestamp | null;

  /** Gated alongside line rates by `field.saleRate.view`. */
  totalAmount?: number;

  sourcePanelId: Uuid | null;
  createdByUserId: Uuid | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;

  items: LineItem[];
  timeline: TimelineEntry[];
}

export type WeightSource = 'computed' | 'manual';

export interface Order {
  id: RecordId;
  tenantId: Uuid;
  /** Back-reference to the lead this came from. */
  leadId: RecordId | null;
  partyId: RecordId;
  partyName: string;
  ownerId: Uuid;
  ownerName: string | null;
  stageId: Uuid;
  stageName: string;
  stageSequence: number;

  dispatchAddressLabel: string | null;
  expectedDispatchDate: IsoDate | null;
  /** Always populated: summed from line weights. */
  totalWeightKg: number;
  /** Set only when a human overrode the computed figure. */
  totalWeightKgOverride: number | null;
  /** Which of the two the UI should label — "computed" or "manual". */
  weightSource: WeightSource;

  notes: string | null;
  customFields: Record<string, unknown>;
  incomplete: boolean;
  missingFields: string[];

  totalAmount?: number;

  dispatchedAt: IsoTimestamp | null;
  sourcePanelId: Uuid | null;
  createdByUserId: Uuid | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;

  items: LineItem[];
  timeline: TimelineEntry[];
  reservations: StockReservation[];
}

// --- Inventory -------------------------------------------------------------

export type ReservationStatus = 'active' | 'released' | 'consumed';

/**
 * Stock held for an order, per (product, colour) — a white basin in stock does
 * not satisfy a reservation for a blue one (docs/LEAD_GENERATION_FLOW.md §5.1).
 */
export interface StockReservation {
  id: RecordId;
  tenantId: Uuid;
  orderId: RecordId;
  lineItemId: RecordId;
  productId: RecordId;
  productName: string;
  colour: string;
  quantity: number;
  status: ReservationStatus;
  createdAt: IsoTimestamp;
  settledAt: IsoTimestamp | null;
}

/**
 * Current stock for one (product, colour). `quantityBoxes` is what is on the
 * floor; `reservedBoxes` is committed to orders not yet dispatched; the
 * difference is what a new order can actually draw on. All three may go
 * negative — selling against an undelivered factory order is routine, so the
 * shortfall is surfaced rather than blocked.
 */
export interface InventoryStockLevel {
  productId: RecordId;
  productCode: string;
  productName: string;
  categoryName: string | null;
  size: string | null;
  colour: string;
  quantityBoxes: number;
  reservedBoxes: number;
  availableBoxes: number;
  quantitySqft: number;
  reorderLevel: number | null;
  /** True when available stock is at or below the reorder level. */
  isLow: boolean;
  updatedAt: IsoTimestamp | null;
}

export type StockMovementType = 'inbound' | 'outbound' | 'adjustment';

export interface StockMovement {
  id: number;
  tenantId: Uuid;
  productId: RecordId;
  productCode: string;
  productName: string;
  colour: string;
  movementType: StockMovementType;
  /** Signed delta, never an absolute value. */
  quantityBoxes: number;
  referenceType: string | null;
  referenceId: RecordId | null;
  note: string | null;
  createdAt: IsoTimestamp;
}

// --- Sync ------------------------------------------------------------------

/**
 * A field-level edit that lost to a higher-HLC write. Kept visible rather than
 * discarded so a human can see what was overwritten and put it back if the
 * losing value was the correct one.
 */
export interface SyncConflict {
  id: number;
  tenantId: Uuid;
  entity: string;
  entityId: RecordId;
  field: string;
  losingValue: unknown;
  losingHlc: string;
  losingDeviceCode: string;
  winningValue: unknown;
  winningHlc: string;
  winningDeviceCode: string;
  resolvedAt: IsoTimestamp | null;
  resolvedByUserId: Uuid | null;
  createdAt: IsoTimestamp;
}

/** One temporary id and the permanent id it was promoted to. */
export interface IdMapping {
  tenantId: Uuid;
  entity: string;
  temporaryId: RecordId;
  permanentId: RecordId;
  deviceCode: string;
  createdAt: IsoTimestamp;
}

// --- Search ----------------------------------------------------------------

export type SearchHitKind = 'product' | 'party' | 'lead_line' | 'order_line';

/** One universal-search result, already routed to the screen that owns it. */
export interface SearchHit {
  kind: SearchHitKind;
  /** The record to open — the parent lead/order for a line hit. */
  id: RecordId;
  title: string;
  subtitle: string | null;
  /** Postgres `ts_rank` score; higher is a better match. */
  rank: number;
}

// --- Master identity & dashboards -----------------------------------------

export interface MasterIdentity {
  masterUniqueId: Uuid;
  tenantId: Uuid;
  companyName: string | null;
  lanIps: string[];
  port: number;
  setupCompletedAt: IsoTimestamp;
}

export interface StorageUsage {
  databaseBytes: number;
  uploadsBytes: number;
  totalBytes: number;
  diskFreeBytes: number | null;
}

export interface DashboardSummary {
  leadCount: number;
  orderCount: number;
  partyCount: number;
  productCount: number;
  /** Products at or below their reorder level. */
  lowStockCount: number;
  /** Leads whose follow-up date has arrived. */
  followUpsDueCount: number;
  /** Unresolved rows in `sync_conflicts`. */
  openConflictCount: number;
  /** Mutations queued on panels that have not reached the Master yet. */
  pendingSyncCount: number;
}
