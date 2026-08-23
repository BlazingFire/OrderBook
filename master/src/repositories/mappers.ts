/**
 * Row → domain mapping. The database uses snake_case and returns NUMERIC /
 * BIGINT columns as strings (node-postgres does this to avoid silent precision
 * loss), so every value crossing out of a repository is normalised here rather
 * than in each caller.
 *
 * Mappers return the **complete** record, rate included. Field-level masking is
 * a service-layer concern: a repository that already stripped `rate` could not
 * be used by the code that has to compute a total.
 */

import type {
  CustomFieldDefinition,
  InventoryStockLevel,
  IsoTimestamp,
  Lead,
  LineItem,
  LineItemQuantity,
  OfficePanel,
  OptionListItem,
  Order,
  Party,
  PartyProductVariant,
  Pipeline,
  PipelineStage,
  Product,
  ProductCategory,
  Role,
  StockMovement,
  StockReservation,
  SyncConflict,
  SyncMeta,
  Tenant,
  TimelineEntry,
  User,
} from '@orderbook/shared';

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  // Number('') and Number('   ') are both 0, which would turn a blank column
  // or an empty form field into a real zero price/quantity. Blank means "not
  // set", so it must map to null.
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
export function mapSyncMeta(row: Row): SyncMeta {
  return {
    version: toRequiredNumber(row.version),
    hlc: String(row.hlc ?? ''),
    fieldHlc: toJsonObject(row.field_hlc) as Record<string, string>,
    temporaryId: (row.temporary_id as string | null) ?? null,
  };
}

// --- Tenancy & access ------------------------------------------------------

export function mapTenant(row: Row): Tenant {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    isActive: Boolean(row.is_active),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

export function mapRole(row: Row): Role {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    tier: row.tier as Role['tier'],
    // Stored as one JSONB array; sorted on write so the order is stable.
    permissions: toStringArray(row.permissions),
    isSystem: Boolean(row.is_system),
    userCount: toRequiredNumber(row.user_count),
    deletedAt: toIso(row.deleted_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
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
    macAddress: (row.mac_address as string | null) ?? null,
    status: row.status as OfficePanel['status'],
    pairedAt: toIso(row.paired_at),
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
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

export function mapProduct(row: Row): Product {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    productCode: String(row.product_code),
    name: String(row.name),
    alias: (row.alias as string | null) ?? null,
    categoryId: (row.category_id as string | null) ?? null,
    categoryName: (row.category_name as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    sin: (row.sin as string | null) ?? null,
    grade: (row.grade as string | null) ?? null,
    productType: (row.product_type as string | null) ?? null,
    weightKg: toNumber(row.weight_kg),
    finish: (row.finish as string | null) ?? null,
    series: (row.series as string | null) ?? null,
    color: (row.color as string | null) ?? null,
    thicknessMm: toNumber(row.thickness_mm),
    piecesPerBox: toNumber(row.pieces_per_box),
    boxCoverageSqft: toNumber(row.box_coverage_sqft),
    rate: toNumber(row.rate),
    pricePerSqft: toNumber(row.price_per_sqft),
    hsnCode: (row.hsn_code as string | null) ?? null,
    parameters: toJsonObject(row.parameters),
    customFields: toJsonObject(row.custom_fields),
    isActive: Boolean(row.is_active),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
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
    rate: toNumber(row.rate),
    size: (row.size as string | null) ?? null,
    sin: (row.sin as string | null) ?? null,
    grade: (row.grade as string | null) ?? null,
    productType: (row.product_type as string | null) ?? null,
    weightKg: toNumber(row.weight_kg),
    packaging: (row.packaging as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    sync: mapSyncMeta(row),
  };
}

// --- Lines, leads & orders -------------------------------------------------

export function mapLineItemQuantity(row: Row): LineItemQuantity {
  return {
    id: String(row.id),
    colour: String(row.colour),
    quantity: toRequiredNumber(row.quantity),
  };
}

export function mapLineItem(row: Row, quantities: LineItemQuantity[]): LineItem {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    parentType: row.parent_type as LineItem['parentType'],
    parentId: String(row.parent_id),
    productId: String(row.product_id),
    productName: String(row.product_name ?? ''),
    alias: (row.alias as string | null) ?? null,
    rate: toNumber(row.rate),
    code: (row.code as string | null) ?? null,
    sin: (row.sin as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    weightKg: toNumber(row.weight_kg),
    grade: (row.grade as string | null) ?? null,
    productType: (row.product_type as string | null) ?? null,
    packaging: (row.packaging as string | null) ?? null,
    sequence: toRequiredNumber(row.sequence),
    fromPartyVariant: Boolean(row.from_party_variant),
    imagePath: (row.image_path as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    quantities,
    totalQuantity: toRequiredNumber(row.total_quantity),
    lineTotal: toNumber(row.line_total),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
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
    totalAmount: toRequiredNumber(row.total_amount),
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
    totalWeightKgOverride: override,
    // The override does not replace the computed figure, it relabels which one
    // the UI shows — so both travel and the source says which is authoritative.
    weightSource: override === null ? 'computed' : 'manual',
    notes: (row.notes as string | null) ?? null,
    customFields: toJsonObject(row.custom_fields),
    incomplete: completeness.incomplete,
    missingFields: completeness.missingFields,
    totalAmount: toRequiredNumber(row.total_amount),
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
    colour: String(row.colour),
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
  const coverage = toNumber(row.box_coverage_sqft);

  return {
    productId: String(row.product_id),
    productCode: String(row.product_code ?? ''),
    productName: String(row.product_name ?? ''),
    categoryName: (row.category_name as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    colour: String(row.colour),
    quantityBoxes,
    reservedBoxes,
    availableBoxes: available,
    quantitySqft: coverage === null ? 0 : Math.round(quantityBoxes * coverage * 100) / 100,
    reorderLevel,
    // Judged on what is actually free to sell, not on what is on the floor —
    // stock already committed to an order cannot answer the next one.
    isLow: reorderLevel !== null && available <= reorderLevel,
    updatedAt: toIso(row.updated_at),
  };
}

export function mapStockMovement(row: Row): StockMovement {
  return {
    id: Number(row.id),
    tenantId: String(row.tenant_id),
    productId: String(row.product_id),
    productCode: String(row.product_code ?? ''),
    productName: String(row.product_name ?? ''),
    colour: String(row.colour ?? ''),
    movementType: row.movement_type as StockMovement['movementType'],
    quantityBoxes: toRequiredNumber(row.quantity_boxes),
    referenceType: (row.reference_type as string | null) ?? null,
    referenceId: (row.reference_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
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
