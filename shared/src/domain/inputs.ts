/**
 * Write-side payloads. These are what an Office Panel sends to the Master to
 * change data; the Master validates them before they reach a repository.
 *
 * Note what is *absent* by design: no `id` on any create input (the system
 * mints it — docs/LEAD_GENERATION_FLOW.md §3.3), no `createdByUserId` (stamped
 * server-side from the session), and no `tenantId` (taken from the caller's
 * identity, never from the body — a client must not be able to name a tenant).
 */

import type {
  CustomFieldEntity,
  CustomFieldType,
  IsoDate,
  IsoTimestamp,
  Product,
  RecordId,
  UserAvatar,
  Uuid,
} from './entities.js';
import type { FieldListKey } from './fields.js';
import type { RecycleBinEntityType } from './recycle-bin.js';

export interface PartyInput {
  name: string;
  phone?: string | null;
  altPhone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstNumber?: string | null;
  notes?: string | null;
  customFields?: Record<string, unknown>;
}

/**
 * One variant as the product form sends it. `id` names an existing row on an
 * edit — it must be preserved, because stock rows, reservations and lines are
 * keyed by it; a row without one (or with an id the product does not have) is
 * matched by label, and otherwise inserted.
 */
export interface ProductVariantInput {
  id?: RecordId;
  code: string;
  /** Colour or pattern text; omitted or null on a no-variant product. */
  label?: string | null;
  /** Kilograms; omitted or null while unknown. Must be greater than zero when given. */
  weightKg?: number | null;
  /** Form order; defaults to the array position. */
  sequence?: number;
}

export interface ProductInput {
  name: string;
  alias?: string | null;
  /**
   * One of the three is required on create, resolved in this order: the id,
   * then the code, then the name. A name creates the category when it is new.
   */
  categoryId?: RecordId | null;
  /**
   * The category by its code (`OPT`), for callers that know the code but not
   * the id — the catalogue loader, an import file. Never creates a category:
   * a code that names nothing is refused rather than turned into a new
   * product from a typo.
   */
  categoryCode?: string | null;
  categoryName?: string | null;
  /**
   * Read only beside `categoryName`: the brand that name is sold under, so the
   * name resolves as the (brand, name) pair (`docs/catalogue/CATALOGUE_MODEL.md`
   * §5) — two brands may both sell a One Piece Toilet — and a category it
   * creates carries the brand. Absent, the name takes a brandless category
   * first. Never stored on the product: brand lives on the category.
   */
  categoryBrand?: string | null;
  /**
   * The variant set. Required on create (at least one). On an update, absent
   * means "leave the variants alone" and present replaces the whole set.
   */
  variants?: ProductVariantInput[];
  /** Defaults on create to whether any variant carries a label. */
  hasVariants?: boolean;
  size?: string | null;
  /** Made in any colour of the company's colour list — a lead line may then name one. */
  multiColour?: boolean;
  /** Catalogue order inside the category; null sorts last. */
  sortOrder?: number | null;
  customFields?: Record<string, unknown>;
}

/**
 * Creating a category — a Product in the owner's words
 * (`docs/catalogue/CATALOGUE_MODEL.md` §5).
 *
 * `code` is required: it is what the product bar matches first, and a
 * category without one could only ever be found by name. `brand` is optional
 * only because a company with one brand should not have to say so.
 */
export interface CategoryInput {
  name: string;
  code: string;
  brand?: string | null;
  sortOrder?: number | null;
}

/** A partial patch: absent leaves the field alone, the same rule as every other update. */
export type CategoryUpdateInput = Partial<CategoryInput>;

/**
 * What the crop/rotate editor sends alongside the original file bytes.
 * Coordinates are in the *decoded source image's* pixel space — the server
 * applies rotation then crop and derives every size from that, once, so a
 * client never re-encodes or resizes anything itself.
 */
export interface ImageCropInput {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  /** Total rotation in degrees, 90°-increment plus fine adjustment combined. */
  rotationDeg: number;
  caption?: string | null;
}

export interface ProductImageUpdateInput {
  caption?: string | null;
  isPrimary?: boolean;
}

export interface ProductImageReorderInput {
  productId: RecordId;
  /** Every live image id for the product, in the desired order. */
  ids: Uuid[];
}

export interface PartyProductVariantInput {
  partyId: RecordId;
  productId: RecordId;
  alias?: string | null;
  size?: string | null;
  weightKg?: number | null;
  /** Recorded as a suggestion; never auto-filled onto a line. */
  packaging?: string | null;
}

/**
 * One line on a lead or order — one variant, one quantity.
 *
 * The snapshot fields are accepted from the client rather than re-derived on the
 * server, because an offline panel builds the line from its cached catalogue and
 * that snapshot *is* the agreed spec. The server validates that the variant
 * exists on the product and fills any snapshot field the client left out — it
 * never overwrites one the client sent, which is what keeps a line taken
 * offline intact.
 */
export interface LineItemInput {
  productId: RecordId;
  /** Which variant of the product — the code and weight resolve from it. */
  variantId: RecordId;
  quantity: number;
  productName?: string | null;
  categoryName?: string | null;
  /** Snapshot of the category's code, as the panel's catalogue had it. */
  categoryCode?: string | null;
  /** Snapshot of the brand, as the panel's catalogue had it. */
  brandName?: string | null;
  alias?: string | null;
  code?: string | null;
  variantLabel?: string | null;
  /**
   * A colour from the company's colour list, meaningful only on a
   * `multiColour` product; null means the variant's own. Sent for any other
   * product it is dropped, not refused — a lead queued offline must not
   * bounce on it (`docs/catalogue/CATALOGUE_MODEL.md` §2).
   */
  colour?: string | null;
  size?: string | null;
  weightKg?: number | null;
  /**
   * Chosen by hand on every line, never auto-filled (§3.2).
   *
   * Not rejected on create: a lead half-built offline is never lost to
   * validation (§3.1). Conversion is where it becomes mandatory —
   * `validation.lead.packagingMissing`.
   */
  packaging?: string | null;
  /**
   * A grade from the company's `line.grade` list, or null.
   *
   * Not checked against the list on the way in, for the same reason packaging
   * is not: the panel that sent it may have been offline for a day, and a
   * grade an administrator has since retired is still what the customer asked
   * for. The *picker* is what keeps new lines on the list.
   */
  grade?: string | null;
  sequence?: number;
  fromPartyVariant?: boolean;
  imagePath?: string | null;
  notes?: string | null;
}

export interface LeadInput {
  partyId: RecordId;
  /** Defaults to the calling user. Setting someone else needs `record.reassignOwner`. */
  ownerId?: Uuid | null;
  sourcePlatform?: string | null;
  followUpDate?: IsoDate | null;
  partyWiseMode?: boolean;
  notes?: string | null;
  customFields?: Record<string, unknown>;
  items: LineItemInput[];
}

export interface LeadUpdateInput {
  partyId?: RecordId;
  ownerId?: Uuid;
  sourcePlatform?: string | null;
  followUpDate?: IsoDate | null;
  partyWiseMode?: boolean;
  notes?: string | null;
  customFields?: Record<string, unknown>;
  /** When present, replaces the whole line set — lines have no stable client id. */
  items?: LineItemInput[];
}

export interface StageChangeInput {
  id: RecordId;
  stageId: Uuid;
  /** Optional remark stored alongside the automatic system timeline entry. */
  remark?: string | null;
}

export interface RemarkInput {
  id: RecordId;
  message: string;
}

export interface LeadConvertInput {
  leadId: RecordId;
  dispatchAddressLabel?: string | null;
  expectedDispatchDate?: IsoDate | null;
}

export interface OrderUpdateInput {
  dispatchAddressLabel?: string | null;
  expectedDispatchDate?: IsoDate | null;
  /** Null clears the override and returns the UI to the computed weight. */
  totalWeightKgOverride?: number | null;
  notes?: string | null;
  customFields?: Record<string, unknown>;
}

export interface OrderDispatchInput {
  orderId: RecordId;
  note?: string | null;
}

/** Stock arriving from the factory or a purchase, for one variant. */
export interface StockInboundInput {
  variantId: RecordId;
  quantityBoxes: number;
  note?: string | null;
}

/**
 * A correction after a physical count. `quantityBoxes` is the counted total,
 * not a delta — staff count what is on the floor, they do not compute
 * differences. The service turns it into a signed movement.
 */
export interface StockAdjustmentInput {
  variantId: RecordId;
  quantityBoxes: number;
  note?: string | null;
}

/**
 * The stock band for one variant.
 *
 * Every level is optional and **absent means untouched** — the same partial
 * patch rule the product columns follow. That is what stops the existing
 * "set the reorder level" screen, which knows nothing about min and max, from
 * clearing them every time somebody uses it.
 */
export interface StockLevelsInput {
  variantId: RecordId;
  reorderLevel?: number | null;
  minStockLevel?: number | null;
  maxStockLevel?: number | null;
}

/**
 * The old name, kept so `MUTATION_PERMISSIONS` and the `stock.setReorderLevel`
 * mutation kind need no rename — the wire contract has not changed, only what
 * a caller is allowed to leave out.
 */
export type ReorderLevelInput = StockLevelsInput;

/**
 * Which slice of the party book a list is asking for.
 *
 * `'all'` is *everything the caller may see* — which for somebody without
 * `party.accessAll` already excludes parties assigned to other people, so it is
 * never a way around the scope. `'assigned'` narrows further, to the parties
 * explicitly assigned to the caller: it hides the unclaimed ones, which is the
 * whole point of the toggle for a person who works a fixed set of accounts.
 */
export type PartyScopeFilter = 'all' | 'assigned';

export interface ListQuery {
  search?: string;
  limit?: number;
  offset?: number;
  scope?: PartyScopeFilter;
}

export interface LeadListQuery extends ListQuery {
  stageIds?: Uuid[];
  ownerId?: Uuid;
  /** Leads already converted are excluded unless this is set. */
  includeConverted?: boolean;
  followUpDueOnly?: boolean;
}

export interface OrderListQuery extends ListQuery {
  stageIds?: Uuid[];
  ownerId?: Uuid;
}

export interface StockListQuery extends ListQuery {
  /** Restrict to variant rows at or below their reorder level. */
  lowOnly?: boolean;
  /** Only rows of this brand (a `product.brand` value), case-insensitively. */
  brand?: string;
  /** Only rows of this category (the owner's Product). */
  categoryId?: RecordId;
}

export interface SearchQuery {
  term: string;
  kinds?: Array<'product' | 'party' | 'lead_line' | 'order_line'>;
  limit?: number;
}

// --- Roles & users ---------------------------------------------------------

export interface RoleInput {
  name: string;
  tier: 'office' | 'management' | 'admin';
  /** The whole set. Sorted server-side, so a reorder is not an edit. */
  permissions: string[];
  /** Optimistic concurrency; omit to skip the check (creates only). */
  expectedVersion?: number;
}

export interface UserInput {
  username: string;
  displayName: string;
  roleId: RecordId;
  /** Optional: one is generated and shown once if omitted. */
  password?: string;
}

export interface UserUpdateInput {
  username?: string;
  displayName?: string;
  roleId?: RecordId;
  isActive?: boolean;
  expectedVersion?: number;
}

export interface PasswordResetInput {
  userId: RecordId;
  /** Optional: one is generated and shown once if omitted. */
  password?: string;
}

export interface ChangeOwnPasswordInput {
  currentPassword: string;
  newPassword: string;
}

/**
 * A newly created user, a reset, or a reveal — carrying the plaintext once.
 *
 * It used to be true that there was no "show again" anywhere in the product and
 * that recovery was another reset. The password vault changed that on
 * installations that deliberately switch it on: `security.passwordRevealEnabled`
 * makes `POST /api/access/users/:id/reveal-password` answer with this same
 * shape, gated on `users.viewPassword`, a re-typed password, and an audit row
 * written before the response. On an installation that leaves the setting alone
 * — the default — the old sentence still holds exactly.
 */
export interface OneTimeSecret {
  userId: RecordId;
  username: string;
  password: string;
}

/**
 * How much of the company the vault actually covers.
 *
 * `stored` trails `total` by design rather than by accident: nothing is sealed
 * until somebody signs in **online** after the toggle went on, so a clerk who
 * works offline for a fortnight is a gap the Settings screen shows as a number
 * instead of a surprise at the moment somebody needs their password.
 */
export interface VaultStatus {
  enabled: boolean;
  stored: number;
  total: number;
}

export interface ConflictResolutionInput {
  conflictId: number;
  /** `keepWinner` simply marks it reviewed; `restoreLoser` writes the old value back. */
  action: 'keepWinner' | 'restoreLoser';
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** The catalogue's list query: the common shape plus the category chip and the weight gap. */
export interface ProductListQuery extends ListQuery {
  categoryId?: string;
  /** Only sub products whose category carries this brand (a `product.brand` value). */
  brand?: string;
  /** Only products with at least one variant whose weight has not been entered. */
  missingWeight?: boolean;
}

/**
 * One page of the catalogue, with the facet the category chips are drawn from.
 *
 * The facet is counted over the *search-filtered* set without the category
 * filter applied, so every chip stays clickable while one is selected.
 * Optional on the wire: a 1.0.3 Master answers `product:list` with a plain
 * `Paginated`.
 */
export interface ProductListPage extends Paginated<Product> {
  categories?: Array<{ id: string; name: string; count: number }>;
}

/**
 * The one cursor-paged query/response shape, minted once so four independent
 * modules cannot each declare a structurally different `CursorPage<T>` and
 * break the build for everyone (`shared/src/index.ts` is a flat `export *`
 * barrel — a duplicate exported name is a compile error across all four
 * packages at once, not a merge conflict for one).
 *
 * A sibling of `Paginated<T>`, not a replacement: existing offset-based list
 * endpoints keep `Paginated<T>`, and every new keyset-paged surface in this
 * batch (Recycle Bin, Logs, …) uses this instead. There are
 * no page numbers anywhere in the new surface.
 */
export interface CursorQuery {
  cursor?: string;
  direction?: 'older' | 'newer';
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  /** Required and nullable, not optional — every consumer gets one shape even for a one-directional feed. */
  prevCursor: string | null;
  limit: number;
}

// --- Recycle Bin -------------------------------------------------------

export interface RecycleBinQuery extends CursorQuery {
  /** Repeatable; an empty array means "every type the caller may see". */
  types?: RecycleBinEntityType[];
  search?: string;
  deletedBy?: RecordId;
}

export interface RestoreInput {
  entityType: RecycleBinEntityType;
  id: RecordId;
  /** Only spent when the name/code collided; deliberately optional (a restore writes no field values). */
  renameTo?: string;
  /** Restore every still-deleted parent named by PARENT_LINKS in the same call, rather than refusing. */
  cascadeParents?: boolean;
  expectedVersion?: number;
}

// --- Fields --------------------------------------------------------------

export interface OptionListItemInput {
  listKey: FieldListKey;
  /** The record-facing identity. Trimmed, never case-folded, immutable after create. */
  value: string;
  label: string;
  /** `#RRGGBB`, or omitted/null for a set with no colour to render. */
  hex?: string | null;
  sequence?: number;
}

/** `value` and `listKey` are deliberately absent — both are immutable once created. */
export interface OptionListItemUpdateInput {
  label?: string;
  hex?: string | null;
  isActive?: boolean;
  /** Mandatory: a save with no version is refused, never treated as "I checked and I am current". */
  expectedVersion: number;
}

/** The complete ordered id list for one set — a reorder is never expressed as a delta. */
export interface OptionListReorderInput {
  listKey: FieldListKey;
  ids: Uuid[];
}

export interface CustomFieldDefinitionInput {
  entity: CustomFieldEntity;
  /** What the value is stored under in the record's `custom_fields` JSONB. Immutable after create. */
  key: string;
  label: string;
  fieldType: CustomFieldType;
  isRequired?: boolean;
  /** Required, non-empty when `fieldType === 'select'`. */
  options?: string[];
  sequence?: number;
}

/** `key` and `entity` are deliberately absent — both are immutable once created. */
export interface CustomFieldDefinitionUpdateInput {
  label?: string;
  isRequired?: boolean;
  options?: string[];
  isActive?: boolean;
  expectedVersion: number;
}

export interface CustomFieldReorderInput {
  entity: CustomFieldEntity;
  ids: Uuid[];
}

/**
 * `pipeline_stages` carries no `version` column — it is not a screen two people
 * curate concurrently the way option lists and custom fields are, so this input
 * carries no `expectedVersion`.
 */
export interface PipelineStageInput {
  name?: string;
  colourHex?: string | null;
  isTerminal?: boolean;
  /** Demotes the previous default in the same transaction, clear-then-set. */
  isDefault?: boolean;
}

/** The complete ordered id list for one pipeline's stages. */
export interface StageReorderInput {
  pipelineId: Uuid;
  ids: Uuid[];
}

// --- Office Panel administration -------------------------------------------

/**
 * What an Office Panel volunteers about itself over the socket.
 *
 * Deliberately not `OfficePanelDevice`: `reportedAt` is stamped by the Master
 * on receipt, because a panel with a wrong clock must not be able to claim its
 * figures are newer than they are.
 */
export interface OfficePanelReportInput {
  hostname: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  nodeVersion: string;
  dataDir: string;
  imagesDir: string;
  storageBytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  localPort: number;
  startedAt: IsoTimestamp;
  /** Runtime figures, true only while this connection lasts. */
  pendingMutations: number | null;
  cachedImages: number | null;
  lastSnapshotAt: IsoTimestamp | null;
  signedInUsername: string | null;
}

/** The fields an administrator may edit on a paired panel. */
export interface OfficePanelUpdateInput {
  name?: string;
  notes?: string | null;
  /** `null` puts the panel back on the seeded Office role. */
  roleId?: RecordId | null;
}

/** A request to move an Office Panel's data folder to another path on its own PC. */
export interface PanelStoragePathInput {
  /** Absolute path on the panel's machine. */
  path: string;
  /**
   * Copy what is already there. Off means "start clean at the new path", which
   * loses queued offline work — so the Master asks for it explicitly rather
   * than inferring it.
   */
  moveExisting: boolean;
}

/** What the panel reports back after moving (or refusing to move) its data folder. */
export interface PanelStoragePathResult {
  dataDir: string;
  previousDataDir: string;
  filesMoved: number;
  bytesMoved: number;
  diskFreeBytes: number | null;
}

/**
 * A reissued panel secret, shown to the operator exactly once.
 *
 * `delivered` is the whole point: a connected panel is handed the new secret
 * over its live socket and simply carries on, while a panel that was switched
 * off cannot be told — somebody has to walk to that PC and pair it again. The
 * two outcomes need different advice on screen, so they travel as data.
 */
export interface PanelSecretRotation {
  panelId: Uuid;
  /** Plaintext, shown once and never stored — only its hash is kept. */
  panelSecret: string;
  delivered: boolean;
  rotatedAt: IsoTimestamp;
}

// --- Party Access ----------------------------------------------------------

/**
 * How much of a party one person may do.
 *
 * `view` is a window: the party, its leads and its orders are visible, and
 * nothing about them can be changed. `manage` adds the ability to raise a lead
 * against the party, edit its records, convert and dispatch. There is
 * deliberately no third level — "may see the party but not its orders" would
 * mean scoping the same record two ways, and nobody asked for it.
 */
export type PartyAccessLevel = 'view' | 'manage';

/** One person's grant on one party. */
export interface PartyAccessEntry {
  userId: RecordId;
  level: PartyAccessLevel;
}

/** The same grant, with enough of the person attached to render a row. */
export interface PartyAccessAssignee extends PartyAccessEntry {
  displayName: string;
  username: string;
  roleName: string;
  roleTier: 'office' | 'management' | 'admin';
  isActive: boolean;
  avatar?: UserAvatar | null;
}

/**
 * A party as the Party Access screen sees it.
 *
 * `isRestricted` is derived, not stored: a party with no assignees is open to
 * everyone, so "restricted" means precisely `assignees.length > 0`. Sending it
 * anyway keeps the renderer from re-deriving the product's central rule in a
 * template, where it would quietly drift.
 */
export interface PartyAccessRow {
  partyId: RecordId;
  partyCode: string;
  partyName: string;
  city: string | null;
  version: number;
  isRestricted: boolean;
  assignees: PartyAccessAssignee[];
}

/**
 * Replace a party's whole assignment set.
 *
 * The whole set, never a single add or remove: a permission set is approved as
 * a whole (`docs/ROLES_AND_USERS.md` §5), and merging two administrators'
 * partial edits produces a union neither of them approved.
 */
export interface PartyAccessInput {
  entries: PartyAccessEntry[];
  /** Against `parties.version`. Mandatory — an absent one is a disabled guard. */
  expectedVersion: number;
}

/**
 * Somebody who can be assigned to a party.
 *
 * A deliberately narrow shape rather than the full `User`: this list exists to
 * populate one picker, and it is served to `party.assign` holders — who are
 * administrators, but should still not receive the staff directory through a
 * screen that is about parties.
 */
export interface AssignablePerson {
  id: RecordId;
  displayName: string;
  username: string;
  roleName: string;
  roleTier: 'office' | 'management' | 'admin';
  /**
   * `null` when the person has no picture, `undefined` from a Master too old
   * to send the field — and the `Avatar` component takes both, deliberately
   * (an absent key once threw inside a component every screen renders and
   * blanked the whole panel).
   */
  avatar?: UserAvatar | null;
}

export interface PartyAccessQuery extends ListQuery {
  /** Only parties this person is assigned to. */
  userId?: RecordId;
  /** `open` — nobody is assigned; `restricted` — somebody is. */
  restriction?: 'open' | 'restricted';
}
