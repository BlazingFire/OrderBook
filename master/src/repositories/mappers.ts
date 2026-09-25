/**
 * Row → domain mapping. The database uses snake_case and returns NUMERIC /
 * BIGINT columns as strings (node-postgres does this to avoid silent precision
 * loss), so every value crossing out of a repository is normalised here rather
 * than in each caller.
 *
 * Mappers return the **complete** record.
 */

import type {
  CustomFieldDefinition,
  InventoryStockLevel,
  IsoTimestamp,
  Lead,
  LineItem,
  OfficePanel,
  OfficePanelDevice,
  OptionListItem,
  Order,
  Party,
  PartyProductVariant,
  Pipeline,
  PipelineStage,
  Product,
  ProductCategory,
  ProductImage,
  ProductVariant,
  Role,
  StockMovement,
  StockReservation,
  SyncConflict,
  SyncMeta,
  TimelineEntry,
  User,
  UserAvatar,
} from '@orderbook/shared';
import { isPermission } from '@orderbook/shared';

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  // Number('') and Number('   ') are both 0, which would turn a blank column
  // or an empty form field into a real zero quantity or weight. Blank means
  // "not set", so it must map to null.
  if (typeof value === 'string' && value.trim() === '') return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** For columns declared NOT NULL — a null here means a schema/query mistake. */
export function toRequiredNumber(value: unknown): number {
  return toNumber(value) ?? 0;
}

/** Knex count() returns a single-row array; Postgres returns the value as a string. */
export function firstCount(rows: Array<{ count: string | number }>): number {
  return Number(rows[0]?.count ?? 0);
}

export function toIso(value: unknown): IsoTimestamp | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toRequiredIso(value: unknown): IsoTimestamp {
  return toIso(value) ?? new Date(0).toISOString();
}

/**
 * DATE columns must not acquire a time or a timezone on the way out.
 *
 * node-postgres parses a DATE into a JS `Date` at **local** midnight, because
 * that is the only way to represent a calendar day as an instant. Reading it
 * back with `toISOString()` converts to UTC first, so anywhere east of
 * Greenwich a follow-up date of the 1st comes back as the 31st. Formatting from
 * the local components is what keeps the day the user typed.
 */
export function toIsoDate(value: unknown): string | null {
  if (!value) return null;

  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return String(value).slice(0, 10);
}

export function toJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type Row = Record<string, unknown>;

/** The sync bookkeeping every syncable record carries. */
function mapSyncMeta(row: Row): SyncMeta {
  return {
    version: toRequiredNumber(row.version),
    hlc: String(row.hlc ?? ''),
    fieldHlc: toJsonObject(row.field_hlc) as Record<string, string>,
    temporaryId: (row.temporary_id as string | null) ?? null,
  };
}

// --- Tenancy & access ------------------------------------------------------

export function mapRole(row: Row): Role {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    tier: row.tier as Role['tier'],
    // Stored as one JSONB array; sorted on write so the order is stable.
    // Filtered through the frozen catalogue, as `permissionSetFromRow` already
    // does: a key a migration granted and a later build removed must neither
    // keep granting nor surface — the grid would draw it checked-but-disabled,
    // resubmit it on save, and the save would be refused as unknown, leaving
    // every role that ever held it uneditable through the product.
    permissions: toStringArray(row.permissions).filter(isPermission),
    isSystem: Boolean(row.is_system),
    userCount: toRequiredNumber(row.user_count),
    deletedAt: toIso(row.deleted_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
  };
}

/**
 * The avatar columns, or null when this person has not set a picture.
 *
 * Keyed on `avatar_id` alone: the other four columns are written in the same
 * statement, so a row with an id and nothing else would be a torn write, not a
 * state worth rendering.
 */
export function mapUserAvatar(row: Row): UserAvatar | null {
  const id = row.avatar_id as string | null;
  if (!id) return null;

  return {
    id,
    blurhash: String(row.avatar_blurhash ?? ''),
    size: Number(row.avatar_size ?? 0),
    byteSize: Number(row.avatar_byte_size ?? 0),
    uploadedAt: toRequiredIso(row.avatar_uploaded_at),
  };
}

/**
 * Row to user, with `password_hash` structurally impossible to carry through:
 * it is destructured away here and the `User` type does not declare it, so a
 * later caller cannot even ask for it (docs/ROLES_AND_USERS.md §12).
 */
export function mapUser(row: Row): User {
  const { password_hash: _passwordHash, ...safe } = row;

  return {
    id: String(safe.id),
    tenantId: String(safe.tenant_id),
    username: String(safe.username),
    displayName: String(safe.display_name ?? safe.username),
    roleId: (safe.role_id as string | null) ?? null,
    roleName: String(safe.role_name ?? ''),
    roleTier: (safe.role_tier as User['roleTier']) ?? 'office',
    isActive: Boolean(safe.is_active),
    lastSignInAt: toIso(safe.last_sign_in_at),
    avatar: mapUserAvatar(safe),
    deletedAt: toIso(safe.deleted_at),
    createdAt: toRequiredIso(safe.created_at),
    updatedAt: toRequiredIso(safe.updated_at),
    sync: mapSyncMeta(safe),
  };
}

export function mapOfficePanel(row: Row): OfficePanel {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    roleId: (row.role_id as string | null) ?? null,
    deviceCode: String(row.device_code ?? ''),
    lanIp: (row.lan_ip as string | null) ?? null,
    status: row.status as OfficePanel['status'],
    notes: (row.notes as string | null) ?? null,
    pairedAt: toIso(row.paired_at),
    lastSeenAt: toIso(row.last_seen_at),
    secretRotatedAt: toIso(row.secret_rotated_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    device: mapOfficePanelDevice(row),
  };
}

/**
 * The panel's own account of the PC it runs on.
 *
 * `toNumber` rather than `toRequiredNumber` throughout: these are BIGINT
 * columns that are genuinely NULL until the panel first reports, and a disk
 * figure coerced to 0 would render as a full disk on every panel paired before
 * this existed.
 */
function mapOfficePanelDevice(row: Row): OfficePanelDevice {
  return {
    hostname: (row.hostname as string | null) ?? null,
    platform: (row.platform as string | null) ?? null,
    osVersion: (row.os_version as string | null) ?? null,
    appVersion: (row.app_version as string | null) ?? null,
    nodeVersion: (row.node_version as string | null) ?? null,
    dataDir: (row.data_dir as string | null) ?? null,
    imagesDir: (row.images_dir as string | null) ?? null,
    storageBytes: toNumber(row.storage_bytes),
    diskFreeBytes: toNumber(row.disk_free_bytes),
    diskTotalBytes: toNumber(row.disk_total_bytes),
    localPort: toNumber(row.local_port),
    startedAt: toIso(row.panel_started_at),
    reportedAt: toIso(row.device_reported_at),
  };
}

// --- Pipelines, options & custom fields ------------------------------------

export function mapPipelineStage(row: Row): PipelineStage {
  return {
    id: String(row.id),
    pipelineId: String(row.pipeline_id),
    name: String(row.name),
    sequence: toRequiredNumber(row.sequence),
    isDefault: Boolean(row.is_default),
    isTerminal: Boolean(row.is_terminal),
    colour: (row.colour as string | null) ?? null,
    isArchived: Boolean(row.is_archived),
  };
}

export function mapPipeline(row: Row, stages: PipelineStage[]): Pipeline {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    kind: row.kind as Pipeline['kind'],
    name: String(row.name),
    stages,
  };
}

export function mapOptionListItem(row: Row): OptionListItem {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    listKey: String(row.list_key),
    value: String(row.value),
    label: String(row.label),
    sequence: toRequiredNumber(row.sequence),
    isActive: Boolean(row.is_active),
    hex: (row.hex as string | null) ?? null,
    deletedAt: toIso(row.deleted_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    version: toRequiredNumber(row.version),
  };
}

export function mapCustomFieldDefinition(row: Row): CustomFieldDefinition {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    entity: row.entity as CustomFieldDefinition['entity'],
    key: String(row.key),
    label: String(row.label),
    fieldType: row.field_type as CustomFieldDefinition['fieldType'],
    isRequired: Boolean(row.is_required),
    options: toStringArray(row.options),
    sequence: toRequiredNumber(row.sequence),
    isActive: Boolean(row.is_active),
    deletedAt: toIso(row.deleted_at),
    version: toRequiredNumber(row.version),
  };
}

// --- Reference data --------------------------------------------------------

export function mapParty(row: Row): Party {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    partyCode: String(row.party_code),
    name: String(row.name),
    phone: (row.phone as string | null) ?? null,
    altPhone: (row.alt_phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    addressLine1: (row.address_line1 as string | null) ?? null,
    addressLine2: (row.address_line2 as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    state: (row.state as string | null) ?? null,
    pincode: (row.pincode as string | null) ?? null,
    gstNumber: (row.gst_number as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    customFields: toJsonObject(row.custom_fields),
    isActive: Boolean(row.is_active),
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
  };
}

export function mapProductCategory(row: Row): ProductCategory {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    createdAt: toRequiredIso(row.created_at),
  };
}

export function mapProductImage(row: Row): ProductImage {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    caption: (row.caption as string | null) ?? null,
    isPrimary: Boolean(row.is_primary),
    sequence: toRequiredNumber(row.sequence),
    width: toRequiredNumber(row.width),
    height: toRequiredNumber(row.height),
    checksum: String(row.checksum ?? ''),
    blurhash: String(row.blurhash ?? ''),
    byteSize: toRequiredNumber(row.byte_size),
    uploadedAt: toRequiredIso(row.uploaded_at),
  };
}

export function mapProductVariant(row: Row): ProductVariant {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    code: String(row.code),
    label: (row.label as string | null) ?? null,
    weightKg: toNumber(row.weight_kg),
    sequence: toRequiredNumber(row.sequence),
    isActive: Boolean(row.is_active),
  };
}

export function mapProduct(row: Row, images: ProductImage[] = [], variants: ProductVariant[] = []): Product {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    alias: (row.alias as string | null) ?? null,
    categoryId: String(row.category_id ?? ''),
    categoryName: String(row.category_name ?? ''),
    size: (row.size as string | null) ?? null,
    hasVariants: Boolean(row.has_variants),
    variants,
    multiColour: Boolean(row.multi_colour),
    customFields: toJsonObject(row.custom_fields),
    isActive: Boolean(row.is_active),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
    images,
  };
}

export function mapPartyProductVariant(row: Row): PartyProductVariant {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    partyId: String(row.party_id),
    productId: String(row.product_id),
    productName: (row.product_name as string | null) ?? null,
    alias: (row.alias as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    weightKg: toNumber(row.weight_kg),
    packaging: (row.packaging as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
  };
}

// --- Lines, leads & orders -------------------------------------------------

export function mapLineItem(row: Row): LineItem {
  const quantity = toRequiredNumber(row.quantity);
  const weightKg = toNumber(row.weight_kg);

  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    parentType: row.parent_type as LineItem['parentType'],
    parentId: String(row.parent_id),
    productId: String(row.product_id),
    variantId: String(row.variant_id),
    productName: String(row.product_name ?? ''),
    categoryName: (row.category_name as string | null) ?? null,
    alias: (row.alias as string | null) ?? null,
    code: (row.code as string | null) ?? null,
    variantLabel: (row.variant_label as string | null) ?? null,
    colour: (row.colour as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    weightKg,
    packaging: (row.packaging as string | null) ?? null,
    grade: (row.grade as string | null) ?? null,
    sequence: toRequiredNumber(row.sequence),
    fromPartyVariant: Boolean(row.from_party_variant),
    imagePath: (row.image_path as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    quantity,
    lineWeightKg: weightKg === null ? null : Math.round(weightKg * quantity * 1000) / 1000,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

/**
 * The weight figure a lead or order shows: the lines that have a weight,
 * summed, plus how many were left out. Three decimals, like the column and
 * `computeTotalWeightKg` — float drift would otherwise print as
 * 12.000000000000002 kg on a dispatch note.
 */
function summariseWeight(items: readonly LineItem[]): {
  totalWeightKg: number;
  linesWithoutWeight: number;
} {
  let total = 0;
  let missing = 0;
  for (const item of items) {
    if (item.lineWeightKg === null) missing += 1;
    else total += item.lineWeightKg;
  }
  return { totalWeightKg: Math.round(total * 1000) / 1000, linesWithoutWeight: missing };
}

export function mapTimelineEntry(row: Row): TimelineEntry {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    parentType: row.parent_type as TimelineEntry['parentType'],
    parentId: String(row.parent_id),
    kind: row.kind as TimelineEntry['kind'],
    message: String(row.message),
    fromStageId: (row.from_stage_id as string | null) ?? null,
    toStageId: (row.to_stage_id as string | null) ?? null,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    actorName: (row.actor_name as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
  };
}

export function mapLead(
  row: Row,
  items: LineItem[],
  timeline: TimelineEntry[],
  completeness: { incomplete: boolean; missingFields: string[] },
): Lead {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    partyId: String(row.party_id),
    partyName: String(row.party_name ?? ''),
    ownerId: String(row.owner_id ?? ''),
    ownerName: (row.owner_name as string | null) ?? null,
    stageId: String(row.stage_id),
    stageName: String(row.stage_name ?? ''),
    stageSequence: toRequiredNumber(row.stage_sequence),
    sourcePlatform: (row.source_platform as string | null) ?? null,
    followUpDate: toIsoDate(row.follow_up_date),
    partyWiseMode: Boolean(row.party_wise_mode),
    notes: (row.notes as string | null) ?? null,
    customFields: toJsonObject(row.custom_fields),
    incomplete: completeness.incomplete,
    missingFields: completeness.missingFields,
    convertedOrderId: (row.converted_order_id as string | null) ?? null,
    convertedAt: toIso(row.converted_at),
    ...summariseWeight(items),
    sourcePanelId: (row.source_panel_id as string | null) ?? null,
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
    items,
    timeline,
  };
}

export function mapOrder(
  row: Row,
  items: LineItem[],
  timeline: TimelineEntry[],
  reservations: StockReservation[],
  completeness: { incomplete: boolean; missingFields: string[] },
): Order {
  const override = toNumber(row.total_weight_kg_override);

  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    leadId: (row.lead_id as string | null) ?? null,
    partyId: String(row.party_id),
    partyName: String(row.party_name ?? ''),
    ownerId: String(row.owner_id ?? ''),
    ownerName: (row.owner_name as string | null) ?? null,
    stageId: String(row.stage_id),
    stageName: String(row.stage_name ?? ''),
    stageSequence: toRequiredNumber(row.stage_sequence),
    dispatchAddressLabel: (row.dispatch_address_label as string | null) ?? null,
    expectedDispatchDate: toIsoDate(row.expected_dispatch_date),
    totalWeightKg: toRequiredNumber(row.total_weight_kg),
    linesWithoutWeight: summariseWeight(items).linesWithoutWeight,
    totalWeightKgOverride: override,
    // The override does not replace the computed figure, it relabels which one
    // the UI shows — so both travel and the source says which is authoritative.
    weightSource: override === null ? 'computed' : 'manual',
    notes: (row.notes as string | null) ?? null,
    customFields: toJsonObject(row.custom_fields),
    incomplete: completeness.incomplete,
    missingFields: completeness.missingFields,
    dispatchedAt: toIso(row.dispatched_at),
    sourcePanelId: (row.source_panel_id as string | null) ?? null,
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
    items,
    timeline,
    reservations,
  };
}

// --- Inventory -------------------------------------------------------------

export function mapStockReservation(row: Row): StockReservation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    orderId: String(row.order_id),
    lineItemId: String(row.line_item_id),
    productId: String(row.product_id),
    productName: String(row.product_name ?? ''),
    variantId: String(row.variant_id),
    variantCode: String(row.variant_code ?? ''),
    variantLabel: (row.variant_label as string | null) ?? null,
    quantity: toRequiredNumber(row.quantity),
    status: row.status as StockReservation['status'],
    createdAt: toRequiredIso(row.created_at),
    settledAt: toIso(row.settled_at),
  };
}

export function mapStockLevel(row: Row): InventoryStockLevel {
  const quantityBoxes = toRequiredNumber(row.quantity_boxes);
  const reservedBoxes = toRequiredNumber(row.reserved_boxes);
  const available = quantityBoxes - reservedBoxes;
  const reorderLevel = toNumber(row.reorder_level);

  return {
    productId: String(row.product_id),
    productName: String(row.product_name ?? ''),
    categoryName: (row.category_name as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    variantId: String(row.variant_id),
    variantCode: String(row.variant_code ?? ''),
    variantLabel: (row.variant_label as string | null) ?? null,
    weightKg: toNumber(row.weight_kg),
    quantityBoxes,
    reservedBoxes,
    availableBoxes: available,
    reorderLevel,
    minStockLevel: toNumber(row.min_stock_level),
    maxStockLevel: toNumber(row.max_stock_level),
    // Judged on what is actually free to sell, not on what is on the floor —
    // stock already committed to an order cannot answer the next one. And on
    // the reorder level *alone*: a second low-stock rule would make the
    // dashboard's figure ambiguous.
    isLow: reorderLevel !== null && available <= reorderLevel,
    updatedAt: toIso(row.updated_at),
  };
}

export function mapStockMovement(row: Row): StockMovement {
  return {
    id: Number(row.id),
    tenantId: String(row.tenant_id),
    productId: String(row.product_id),
    productName: String(row.product_name ?? ''),
    variantId: String(row.variant_id),
    variantCode: String(row.variant_code ?? ''),
    variantLabel: (row.variant_label as string | null) ?? null,
    movementType: row.movement_type as StockMovement['movementType'],
    quantityBoxes: toRequiredNumber(row.quantity_boxes),
    referenceType: (row.reference_type as string | null) ?? null,
    referenceId: (row.reference_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    batchNo: (row.batch_no as string | null) ?? null,
    shade: (row.shade as string | null) ?? null,
    calibre: (row.calibre as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
  };
}

// --- Sync ------------------------------------------------------------------

export function mapSyncConflict(row: Row): SyncConflict {
  return {
    id: Number(row.id),
    tenantId: String(row.tenant_id),
    entity: String(row.entity),
    entityId: String(row.entity_id),
    field: String(row.field),
    losingValue: row.losing_value ?? null,
    losingHlc: String(row.losing_hlc),
    losingDeviceCode: String(row.losing_device_code),
    winningValue: row.winning_value ?? null,
    winningHlc: String(row.winning_hlc),
    winningDeviceCode: String(row.winning_device_code),
    resolvedAt: toIso(row.resolved_at),
    resolvedByUserId: (row.resolved_by_user_id as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
  };
}
