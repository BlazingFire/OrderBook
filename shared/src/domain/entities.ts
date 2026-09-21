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
/**
 * A person's profile picture, normalised to a square on upload.
 *
 * Square because every place it appears is a circle or a rounded square of a
 * fixed size — a roster row, a dialog header, the status footer — and cropping
 * per-render would mean four different crops of the same face.
 */
export interface UserAvatar {
  /** Directory key for the stored variants; minted per upload, never reused. */
  id: Uuid;
  /** Colour placeholder painted before any variant has loaded. */
  blurhash: string;
  /** Edge length of the stored `full` variant, in pixels. Square, so one number. */
  size: number;
  byteSize: number;
  uploadedAt: IsoTimestamp;
}

export const AVATAR_VARIANTS = ['full', 'thumb', 'micro'] as const;
export type AvatarVariant = (typeof AVATAR_VARIANTS)[number];

/** The longest edge kept. A face on a shop-floor screen never needs more. */
export const AVATAR_LONG_EDGE = 1080;

/** Refused above this, before any decode — a phone photo clears it comfortably. */
export const MAX_AVATAR_SOURCE_BYTES = 5 * 1024 * 1024;

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
  avatar: UserAvatar | null;
  deletedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

/** What a signed-in caller is told about themselves. */
/**
 * The company switches every screen reads — carried with the signed-in user
 * on the Master and with the snapshot on a panel, so both UIs draw the same
 * screen without a second request.
 */
export interface CompanyFeatures {
  /** `inventory.freeToSell`: whether stock is split into on hand / reserved / free. */
  freeToSell: boolean;
}

export interface SignedInUser extends User {
  /** Already intersected with the tier ceiling. */
  permissions: string[];
  /** Bumped when the role changes, so a stale session is detected per call. */
  roleVersion: number;
  /** The company switches the screens read (`domain/inventory-view.ts`). */
  features: CompanyFeatures;
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
  /** Free text an administrator keeps against the panel — which desk it is on. */
  notes: string | null;
  pairedAt: IsoTimestamp | null;
  lastSeenAt: IsoTimestamp | null;
  /** When this panel's secret was last reissued. Null means never since pairing. */
  secretRotatedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Last thing the panel said about the PC it runs on. Never null; all-null when it has never reported. */
  device: OfficePanelDevice;
}

/**
 * What an Office Panel says about the machine it is installed on.
 *
 * The Master cannot discover any of this: an Office Panel binds its HTTP server
 * to loopback, so nothing on the LAN can ask it a question — the panel has to
 * volunteer it over the socket it already holds. Every field is nullable
 * because a panel paired before this existed has reported nothing yet, and
 * "unknown" must stay distinguishable from "zero" for the disk figures in
 * particular.
 */
export interface OfficePanelDevice {
  /** The PC's own name, which is what staff call the machine. */
  hostname: string | null;
  /** `win32`, `darwin`, `linux` — Node's own token, rendered by the client. */
  platform: string | null;
  osVersion: string | null;
  appVersion: string | null;
  nodeVersion: string | null;
  /** Absolute path of this panel's data folder **on that PC**. */
  dataDir: string | null;
  /** Where it caches image variants it has viewed; under `dataDir` by default. */
  imagesDir: string | null;
  /** Bytes the data folder occupies. */
  storageBytes: number | null;
  /** Free and total bytes on the volume holding `dataDir`. */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** The loopback port its browser UI is served on. */
  localPort: number | null;
  /** When that panel process started — an uptime, not a pairing date. */
  startedAt: IsoTimestamp | null;
  /** When the Master last received a report. Stamped by the Master, not the panel. */
  reportedAt: IsoTimestamp | null;
}

/** An `OfficePanelDevice` with nothing known yet. */
export const UNREPORTED_PANEL_DEVICE: OfficePanelDevice = {
  hostname: null,
  platform: null,
  osVersion: null,
  appVersion: null,
  nodeVersion: null,
  dataDir: null,
  imagesDir: null,
  storageBytes: null,
  diskFreeBytes: null,
  diskTotalBytes: null,
  localPort: null,
  startedAt: null,
  reportedAt: null,
};

/**
 * Figures that are only true while the panel is connected, so they are held in
 * memory on the Master and never written to a column: a stored `pendingCount`
 * would keep asserting a backlog for a panel that has been switched off for a
 * week.
 */
export interface OfficePanelRuntime {
  /** Mutations queued on the panel that the Master has not accepted yet. */
  pendingMutations: number | null;
  /** Image variants the panel holds in its own cache. */
  cachedImages: number | null;
  /** How old the panel's copy of the data is. */
  lastSnapshotAt: IsoTimestamp | null;
  /** Who is signed in on that panel right now, if anybody. */
  signedInUsername: string | null;
  /** When the current connection was established. */
  connectedSince: IsoTimestamp | null;
}

/** Live connection state, derived at runtime — not a database column. */
export interface OfficePanelWithPresence extends OfficePanel {
  isConnected: boolean;
  /** Present only while connected — see `OfficePanelRuntime`. */
  runtime: OfficePanelRuntime | null;
}

/**
 * Everything the Master's panel-detail screen shows for one panel: the row, its
 * presence, and the answers it would otherwise have to make five more requests
 * for.
 */
export interface OfficePanelDetail extends OfficePanelWithPresence {
  /** The role this panel's own unattended commands act under. */
  role: {
    id: RecordId | null;
    name: string;
    tier: RoleTierName;
    permissions: string[];
    /** True when no role is assigned and the seeded Office tier is standing in. */
    isFallback: boolean;
  };
  /** What this panel has actually produced, so a quiet panel is visible as quiet. */
  work: {
    leads: number;
    orders: number;
    lastActionAt: IsoTimestamp | null;
  };
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
  /**
   * Stops new records landing in this stage; every record already in it keeps
   * rendering. Not a soft delete — `pipeline_stages` is referenced by a real
   * foreign key (`leads.stage_id`, `orders.stage_id`), so it cannot be one, and
   * it is not a Recycle Bin entity.
   */
  isArchived: boolean;
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
  /** The record-facing identity. Immutable once created — rename `label` instead. */
  value: string;
  label: string;
  sequence: number;
  /** Hidden from pickers but still renders on records that hold it; switchable back in place. */
  isActive: boolean;
  /** `#RRGGBB`, or null for a set with no colour to render — see `FieldSetDefinition.hasHex`. */
  hex: string | null;
  /** Removed. Goes to the Recycle Bin; the string stays on every record that holds it. */
  deletedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Optimistic concurrency — mandatory on `PUT /api/fields/values/:id`. */
  version: number;
}

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';
export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  'text',
  'number',
  'date',
  'select',
  'boolean',
];

export type CustomFieldEntity = 'lead' | 'order' | 'party' | 'product';
export const CUSTOM_FIELD_ENTITIES: readonly CustomFieldEntity[] = [
  'lead',
  'order',
  'party',
  'product',
];

export function isCustomFieldEntity(value: unknown): value is CustomFieldEntity {
  return (CUSTOM_FIELD_ENTITIES as readonly unknown[]).includes(value);
}

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly unknown[]).includes(value);
}

export interface CustomFieldDefinition {
  id: Uuid;
  tenantId: Uuid;
  entity: CustomFieldEntity;
  /** What the value is stored under in the record's `custom_fields` JSONB. Immutable once created. */
  key: string;
  label: string;
  fieldType: CustomFieldType;
  /** A required custom field flags the record incomplete — it never blocks a save. */
  isRequired: boolean;
  options: string[];
  sequence: number;
  isActive: boolean;
  /** Removed. Stored JSONB values keep the key; re-adding it recovers them. */
  deletedAt: IsoTimestamp | null;
  /** Optimistic concurrency — mandatory on `PUT /api/fields/definitions/:id`. */
  version: number;
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

/**
 * One sellable variant of a product model — a colour, a pattern, or the
 * product itself when it comes in only one form.
 *
 * Every product code and every weight lives here, never on the product: a
 * model like DAMRU is sold as `41`, `42`, … each with its own code and weight,
 * and a one-form product is simply a model with exactly one variant whose
 * `label` is null. That uniformity is what lets a lead line, a stock row and
 * a reservation all point at a variant id whatever kind of product it is.
 */
export interface ProductVariant {
  id: RecordId;
  productId: RecordId;
  /** The business code the counter quotes. Unique across the whole catalogue. */
  code: string;
  /** Colour or pattern text ("Blue", "Vitrosa 41", "White + Blue"); null on a no-variant product. */
  label: string | null;
  /** Kilograms, or null while nobody has entered it — flagged, never guessed. */
  weightKg: number | null;
  /** Form order. */
  sequence: number;
  /**
   * False once an administrator removed the variant from the form while a
   * line, a stock row or a reservation still pointed at it: the history keeps
   * its row, the pickers stop offering it.
   */
  isActive: boolean;
}

export interface Product {
  id: RecordId;
  tenantId: Uuid;
  /** The model's name — "DAMRU", "102", "Golden Set". Codes live on the variants. */
  name: string;
  alias: string | null;
  /** Every product belongs to a category; the category-first search depends on it. */
  categoryId: RecordId;
  categoryName: string;
  size: string | null;
  /**
   * True when the administrator said the model comes in colours or patterns.
   * Stored rather than derived so a model with one variant *so far* still
   * shows the variant selector instead of silently behaving as a plain product.
   */
  hasVariants: boolean;
  /** At least one, in form order; exactly one with a null label when `hasVariants` is false. */
  variants: ProductVariant[];
  /**
   * True when the model is made in any colour of the company's colour list
   * ("all colours available in all items" in the catalogue), so a lead line
   * may name a colour on top of the variant it quotes. The colour is a line
   * attribute, not a stock key: stock stays per variant.
   */
  multiColour: boolean;
  customFields: Record<string, unknown>;
  isActive: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
  /**
   * Ordered gallery, primary first then upload order. Always present as an
   * array (possibly empty) for anyone who can see the product at all — there
   * is no separate `images.view` permission (`docs/schema/02-parties-and-products.md`).
   */
  images: ProductImage[];
}

/** One of the four sizes every uploaded image is normalized into at import time. */
export type ImageVariant = 'master' | 'large' | 'thumb' | 'micro';

/** Fetch priority order — cheap/most-needed first (`7-IMAGE-PIPELINE.md` §4.3). */
export const IMAGE_VARIANTS: readonly ImageVariant[] = ['thumb', 'micro', 'large', 'master'];

/**
 * The long edge each variant is generated at, in pixels.
 *
 * Here rather than in `master/src/domain/images.ts` because a browser has to
 * answer "which of these is the right file for a 28-pixel slot on a retina
 * screen", and that module is a **server** module `office/web` cannot import.
 * The Master's `IMAGE_VARIANT_SPECS` builds its `longEdge` from this table, so
 * there is one set of numbers rather than two that can drift.
 */
export const IMAGE_VARIANT_LONG_EDGES: Record<ImageVariant, number> = {
  micro: 64,
  thumb: 240,
  large: 800,
  master: 2048,
};

/**
 * The variant to request for a slot of `slotCssPx`, on a screen with this
 * device pixel ratio.
 *
 * **Deliberately not `srcset`.** The Office Panel serves images from a local
 * cache and forwards a miss to the Master, answering **503 while offline** —
 * and a 503 on the candidate the browser picked does not fall back to `src`.
 * `srcset` would also have the browser choose among four files rather than the
 * one that normal browsing has already warmed. Choosing here keeps the request
 * count exactly what it was.
 *
 * `master` is never chosen: it is the archival original, kept so a crop can be
 * re-derived, not a file to put in a list.
 */
export function variantForSlot(slotCssPx: number, devicePixelRatio = 1): ImageVariant {
  const needed = slotCssPx * (devicePixelRatio > 0 ? devicePixelRatio : 1);

  for (const variant of ['micro', 'thumb', 'large'] as const) {
    if (IMAGE_VARIANT_LONG_EDGES[variant] >= needed) return variant;
  }

  return 'large';
}

/** No file-size limit at import (§2.1); this is a sanity ceiling against a bad drag-drop, shared so Office's own upload multipart parser rejects the same oversized file the Master would. */
export const MAX_IMAGE_SOURCE_BYTES = 60 * 1024 * 1024;

/**
 * One entry in a product's photo gallery. Image *bytes* live on disk as
 * `master.webp`/`large.webp`/`thumb.webp`/`micro.webp` under
 * `<uploads>/images/<tenantId>/<id>/`, fetched through `GET /api/images/:id/:variant`
 * — this row is only ever the metadata that rides the normal product read path.
 *
 * `blurhash` is inlined here (not a separate fetch) so a card can paint an
 * instant colour-accurate placeholder before any variant file has arrived.
 */
export interface ProductImage {
  id: Uuid;
  productId: RecordId;
  caption: string | null;
  isPrimary: boolean;
  /** Gallery order; the primary image is always sorted first regardless of this. */
  sequence: number;
  /** Pixel size of the `master` variant, for aspect-ratio-correct placeholders. */
  width: number;
  height: number;
  /** SHA-256 of `master.webp`, so a replica can verify its local copy without asking the Master. */
  checksum: string;
  /** Compact colour-placeholder string, painted before any variant has loaded. */
  blurhash: string;
  byteSize: number;
  uploadedAt: IsoTimestamp;
}

/**
 * A party's own version of a product — the name, size and packaging agreed
 * with that customer. Used when a lead is in `partyWiseMode`.
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
  size: string | null;
  weightKg: number | null;
  /** Suggestion only — see the note above. */
  packaging: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  sync: SyncMeta;
}

// --- Line items (shared unchanged by leads and orders) ---------------------

export type LineItemParentType = 'lead' | 'order';

/**
 * One variant on a lead or an order: one code, one weight, one quantity.
 *
 * Two colours of the same model are two lines, each with its own weight — the
 * snapshot fields are frozen at add time, so editing the product afterwards
 * must not rewrite what an order was quoted at
 * (docs/LEAD_GENERATION_FLOW.md §8.3).
 */
export interface LineItem {
  id: RecordId;
  tenantId: Uuid;
  parentType: LineItemParentType;
  parentId: RecordId;
  /** Live references — kept for stock movement and traceability. */
  productId: RecordId;
  variantId: RecordId;

  // Snapshotted at add time
  productName: string;
  /** The main product (category) the line was entered under — snapshot like `productName`. */
  categoryName: string | null;
  alias: string | null;
  /** The variant's code as it was when the line was added. */
  code: string | null;
  /** The variant's colour or pattern text; null for a no-variant product. */
  variantLabel: string | null;
  /**
   * The colour chosen on the line, from the company's colour list — only on a
   * `multiColour` product, and null when the variant's own colour was meant.
   */
  colour: string | null;
  size: string | null;
  /** The variant's weight in kilograms, or null when it had not been entered. */
  weightKg: number | null;

  /** Chosen manually on every line — never auto-filled. */
  packaging: string | null;
  sequence: number;
  fromPartyVariant: boolean;
  imagePath: string | null;
  notes: string | null;
  quantity: number;

  /** `weightKg` × `quantity`, or null when the weight is missing. */
  lineWeightKg: number | null;

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

  /** Sum of the lines' `lineWeightKg`, over the lines that have a weight. */
  totalWeightKg: number;
  /** How many lines carry no weight yet — when non-zero, `totalWeightKg` is a partial figure. */
  linesWithoutWeight: number;

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
  /** Always populated: summed from line weights, over the lines that have one. */
  totalWeightKg: number;
  /** How many lines carry no weight — when non-zero, the computed figure is partial. */
  linesWithoutWeight: number;
  /** Set only when a human overrode the computed figure. */
  totalWeightKgOverride: number | null;
  /** Which of the two the UI should label — "computed" or "manual". */
  weightSource: WeightSource;

  notes: string | null;
  customFields: Record<string, unknown>;
  incomplete: boolean;
  missingFields: string[];

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
 * Stock held for an order, per variant — a white basin in stock does not
 * satisfy a reservation for a blue one (docs/LEAD_GENERATION_FLOW.md §5.1).
 */
export interface StockReservation {
  id: RecordId;
  tenantId: Uuid;
  orderId: RecordId;
  lineItemId: RecordId;
  productId: RecordId;
  productName: string;
  variantId: RecordId;
  variantCode: string;
  variantLabel: string | null;
  quantity: number;
  status: ReservationStatus;
  createdAt: IsoTimestamp;
  settledAt: IsoTimestamp | null;
}

/**
 * Current stock for one variant. `quantityBoxes` is what is on the floor;
 * `reservedBoxes` is committed to orders not yet dispatched; the difference
 * is what a new order can actually draw on. All three may go negative —
 * selling against an undelivered factory order is routine, so the shortfall
 * is surfaced rather than blocked.
 */
export interface InventoryStockLevel {
  productId: RecordId;
  productName: string;
  categoryName: string | null;
  size: string | null;
  variantId: RecordId;
  /** The variant's own code — the number somebody types at the counter. */
  variantCode: string;
  /** Colour or pattern text; null on a no-variant product. */
  variantLabel: string | null;
  weightKg: number | null;
  quantityBoxes: number;
  reservedBoxes: number;
  availableBoxes: number;
  reorderLevel: number | null;
  /**
   * The band a buyer works to. Advisory: nothing refuses a movement for
   * crossing them, and `isLow` is still driven by `reorderLevel` alone — a
   * second low-stock rule would make the dashboard's figure ambiguous.
   */
  minStockLevel: number | null;
  maxStockLevel: number | null;
  /** True when available stock is at or below the reorder level. */
  isLow: boolean;
  updatedAt: IsoTimestamp | null;
}

export type StockMovementType = 'inbound' | 'outbound' | 'adjustment';

export interface StockMovement {
  id: number;
  tenantId: Uuid;
  productId: RecordId;
  productName: string;
  variantId: RecordId;
  variantCode: string;
  variantLabel: string | null;
  movementType: StockMovementType;
  /** Signed delta, never an absolute value. */
  quantityBoxes: number;
  referenceType: string | null;
  referenceId: RecordId | null;
  note: string | null;
  /**
   * Which lot this quantity came from.
   *
   * On the movement, not on the product, and that is the whole design: one
   * product receives many lots, so a `batch_no` column on `products` would be
   * false the second time stock arrives. "Which lot is this" is a question
   * about a movement, and the ledger is where the answer lives.
   */
  batchNo: string | null;
  shade: string | null;
  calibre: string | null;
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

/**
 * Every counter is optional and **absent**, never `0`, when the actor does
 * not hold the key governing the data behind it
 * (`docs/backend-modules/04-API-CONTRACT.md` §7.1) — a `0` is a claim about
 * the business, "you may not see this" is a claim about the reader. `asOf`
 * is the one exception: it describes the response itself, so it is always
 * present, which is what lets a panel label a cached figure as stale.
 */
export interface DashboardSummary {
  leadCount?: number;
  orderCount?: number;
  partyCount?: number;
  productCount?: number;
  /** Products at or below their reorder level. */
  lowStockCount?: number;
  /** Leads whose follow-up date has arrived. */
  followUpsDueCount?: number;
  /** Unresolved rows in `sync_conflicts`. */
  openConflictCount?: number;
  /** Mutations queued on panels that have not reached the Master yet. */
  pendingSyncCount?: number;
  /** Orders not yet dispatched. */
  openOrderCount?: number;
  /** Dispatched since the start of the current business week. */
  dispatchedThisWeekCount?: number;
  pipelineBreakdown?: Array<{
    stageId: Uuid;
    stageName: string;
    /** The stage's position in its pipeline, so the client orders without re-deriving it. */
    sequence: number;
    colourHex: string | null;
    leadCount: number;
  }>;
  /** When these figures were computed. Always present — an offline panel labels its staleness from it. */
  asOf: IsoTimestamp;
}
