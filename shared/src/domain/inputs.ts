/**
 * Write-side payloads. These are what an Office Panel sends to the Master to
 * change data; the Master validates them before they reach a repository.
 *
 * Note what is *absent* by design: no `id` on any create input (the system
 * mints it — docs/LEAD_GENERATION_FLOW.md §3.3), no `createdByUserId` (stamped
 * server-side from the session), and no `tenantId` (taken from the caller's
 * identity, never from the body — a client must not be able to name a tenant).
 */

import type { StoredDocumentLayout } from './document-layout.js';
import type {
  DocumentAssetKind,
  DocumentSubjectKind,
  DocumentType,
  PageOrientation,
  PaperSize,
} from './documents.js';
import type {
  CustomFieldEntity,
  CustomFieldType,
  IsoDate,
  IsoTimestamp,
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

export interface ProductInput {
  productCode: string;
  name: string;
  alias?: string | null;
  categoryId?: RecordId | null;
  categoryName?: string | null;
  size?: string | null;
  sin?: string | null;
  grade?: string | null;
  productType?: string | null;
  weightKg?: number | null;
  finish?: string | null;
  series?: string | null;
  color?: string | null;
  thicknessMm?: number | null;
  piecesPerBox?: number | null;
  boxCoverageSqft?: number | null;
  rate?: number | null;
  pricePerSqft?: number | null;
  hsnCode?: string | null;

  // Trade and ceramic attributes. Every one optional, because an update is a
  // **partial patch**: an absent key means "leave it alone", and a present
  // `null` means "clear it". A client that sends only what it changed cannot
  // wipe a column it never showed the person.
  mrp?: number | null;
  purchaseRate?: number | null;
  gstRatePct?: number | null;
  uom?: string | null;
  barcode?: string | null;
  brand?: string | null;
  shade?: string | null;
  calibre?: string | null;
  waterAbsorptionPct?: number | null;
  peiRating?: number | null;
  edgeType?: string | null;
  surfaceTexture?: string | null;
  application?: string | null;
  originPlant?: string | null;

  parameters?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

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
  rate?: number | null;
  size?: string | null;
  sin?: string | null;
  grade?: string | null;
  productType?: string | null;
  weightKg?: number | null;
  /** Recorded as a suggestion; never auto-filled onto a line. */
  packaging?: string | null;
}

export interface LineItemQuantityInput {
  colour: string;
  quantity: number;
}

/**
 * One line on a lead or order.
 *
 * The snapshot fields are accepted from the client rather than re-derived on the
 * server, because an offline panel builds the line from its cached catalogue and
 * that snapshot *is* the agreed spec. The server validates the product exists
 * and fills any snapshot field the client left out — it never overwrites one the
 * client sent, which is what keeps an offline quote intact.
 */
export interface LineItemInput {
  productId: RecordId;
  productName?: string | null;
  alias?: string | null;
  rate?: number | null;
  code?: string | null;
  sin?: string | null;
  size?: string | null;
  weightKg?: number | null;
  grade?: string | null;
  productType?: string | null;
  /** Required by policy: a line with no packaging is rejected. */
  packaging?: string | null;
  sequence?: number;
  fromPartyVariant?: boolean;
  imagePath?: string | null;
  notes?: string | null;
  quantities: LineItemQuantityInput[];
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

/** Stock arriving from the factory or a purchase. */
export interface StockInboundInput {
  productId: RecordId;
  colour: string;
  quantityBoxes: number;
  note?: string | null;
}

/**
 * A correction after a physical count. `quantityBoxes` is the counted total,
 * not a delta — staff count what is on the floor, they do not compute
 * differences. The service turns it into a signed movement.
 */
export interface StockAdjustmentInput {
  productId: RecordId;
  colour: string;
  quantityBoxes: number;
  note?: string | null;
}

/**
 * The stock band for one (product, colour).
 *
 * Every level is optional and **absent means untouched** — the same partial
 * patch rule the product columns follow. That is what stops the existing
 * "set the reorder level" screen, which knows nothing about min and max, from
 * clearing them every time somebody uses it.
 */
export interface StockLevelsInput {
  productId: RecordId;
  colour: string;
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
  /** Restrict to (product, colour) rows at or below their reorder level. */
  lowOnly?: boolean;
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

/**
 * The one cursor-paged query/response shape, minted once so four independent
 * modules cannot each declare a structurally different `CursorPage<T>` and
 * break the build for everyone (`shared/src/index.ts` is a flat `export *`
 * barrel — a duplicate exported name is a compile error across all four
 * packages at once, not a merge conflict for one).
 *
 * A sibling of `Paginated<T>`, not a replacement: existing offset-based list
 * endpoints keep `Paginated<T>`, and every new keyset-paged surface in this
 * batch (Recycle Bin, Logs, document exports, …) uses this instead. There are
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

// --- PDF Designer (docs/backend-modules/04-API-CONTRACT.md §6) -------------

export interface DocumentTemplateInput {
  name: string;
  documentType: DocumentType;
  paperSize?: PaperSize;
  orientation?: PageOrientation;
  margins?: { top: number; right: number; bottom: number; left: number };

  showRates?: boolean;
  showColourChips?: boolean;
  showTerms?: boolean;
  showLogo?: boolean;
  showSignature?: boolean;
  showPageNumbers?: boolean;
  showWatermark?: boolean;
  showPartyBlock?: boolean;

  watermarkText?: string | null;
  termsText?: string | null;
  footerText?: string | null;
  accentColour?: string | null;
  locale?: string | null;

  /**
   * Either shape.
   *
   * The designer sends placed elements; an older client — or an Office panel
   * that has not been updated — sends the ordered blocks it has always sent.
   * `normaliseLayout` converts on the way in, so both are accepted and only one
   * is ever stored.
   */
  layout?: StoredDocumentLayout;
  logoAssetId?: Uuid | null;
  signatureAssetId?: Uuid | null;
  isDefault?: boolean;
}

/**
 * A base64 data URL rather than multipart, deliberately: `express.json`
 * already parses at both ends, so the asset upload needs no `multer` and no
 * second parser sitting on untrusted input in the global chain.
 */
export interface DocumentAssetInput {
  kind: DocumentAssetKind;
  dataUrl: string;
}

export interface RenderDocumentInput {
  templateId: Uuid;
  subjectKind: DocumentSubjectKind;
  subjectId: RecordId;
}

/**
 * Takes a whole template rather than an id, so the designer can preview edits
 * it has not saved. Nothing is persisted either way.
 */
export interface PreviewDocumentInput {
  template: DocumentTemplateInput;
  subjectKind: DocumentSubjectKind;
  subjectId: RecordId;
}

export interface DocumentTemplateQuery extends CursorQuery {
  documentType?: DocumentType;
}

export interface DocumentExportQuery extends CursorQuery {
  subjectKind?: DocumentSubjectKind;
  subjectId?: RecordId;
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
