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
  DocumentAssetKind,
  DocumentLayout,
  DocumentSubjectKind,
  DocumentType,
  PageOrientation,
  PaperSize,
} from './documents.js';
import type { CustomFieldEntity, CustomFieldType, IsoDate, RecordId, Uuid } from './entities.js';
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

export interface ReorderLevelInput {
  productId: RecordId;
  colour: string;
  reorderLevel: number | null;
}

export interface ListQuery {
  search?: string;
  limit?: number;
  offset?: number;
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
 * A newly created user or a reset, carrying the plaintext **once**.
 *
 * There is no "show again" anywhere in the product; recovery is another reset,
 * which is itself audited.
 */
export interface OneTimeSecret {
  userId: RecordId;
  username: string;
  password: string;
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

// --- Fields (docs/backend-modules/04-API-CONTRACT.md §5) -------------------

export interface OptionListItemInput {
  listKey: FieldListKey;
  value: string;
  label: string;
  hex?: string | null;
  sequence?: number;
}

/** `value` is deliberately absent — editing it is refused; rename `label` instead. */
export interface OptionListItemUpdateInput {
  label?: string;
  hex?: string | null;
  isActive?: boolean;
  expectedVersion: number;
}

export interface OptionListReorderInput {
  listKey: FieldListKey;
  ids: Uuid[];
}

export interface CustomFieldDefinitionInput {
  entity: CustomFieldEntity;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  isRequired?: boolean;
  options?: string[];
  sequence?: number;
}

/** `key` and `entity` are deliberately absent — both are immutable once set. */
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

export interface PipelineStageInput {
  name?: string;
  colourHex?: string | null;
  isTerminal?: boolean;
  isDefault?: boolean;
}

export interface StageReorderInput {
  pipelineId: RecordId;
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

  layout?: DocumentLayout;
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
