/**
 * Row → domain mapping. The database uses snake_case and returns NUMERIC /
 * BIGINT columns as strings (node-postgres does this to avoid silent precision
 * loss), so every value crossing out of a repository is normalised here rather
 * than in each caller.
 */

import type {
  IsoTimestamp,
  Lead,
  LeadItem,
  OfficePanel,
  Party,
  Product,
  ProductCategory,
  User,
} from '@orderbook/shared';

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
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

type Row = Record<string, unknown>;

export function mapUser(row: Row): User {
  return {
    id: String(row.id),
    username: String(row.username),
    fullName: (row.full_name as string | null) ?? null,
    role: row.role === 'staff' ? 'staff' : 'admin',
    isActive: Boolean(row.is_active),
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

export function mapOfficePanel(row: Row): OfficePanel {
  return {
    id: String(row.id),
    name: String(row.name),
    lanIp: (row.lan_ip as string | null) ?? null,
    macAddress: (row.mac_address as string | null) ?? null,
    status: row.status as OfficePanel['status'],
    pairedAt: toIso(row.paired_at),
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

export function mapParty(row: Row): Party {
  return {
    id: String(row.id),
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
    isActive: Boolean(row.is_active),
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

export function mapProductCategory(row: Row): ProductCategory {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: toRequiredIso(row.created_at),
  };
}

export function mapProduct(row: Row): Product {
  return {
    id: String(row.id),
    productCode: String(row.product_code),
    name: String(row.name),
    categoryId: (row.category_id as string | null) ?? null,
    categoryName: (row.category_name as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    finish: (row.finish as string | null) ?? null,
    series: (row.series as string | null) ?? null,
    color: (row.color as string | null) ?? null,
    thicknessMm: toNumber(row.thickness_mm),
    piecesPerBox: toNumber(row.pieces_per_box),
    boxCoverageSqft: toNumber(row.box_coverage_sqft),
    pricePerBox: toNumber(row.price_per_box),
    pricePerSqft: toNumber(row.price_per_sqft),
    hsnCode: (row.hsn_code as string | null) ?? null,
    parameters: (row.parameters as Record<string, unknown> | null) ?? {},
    isActive: Boolean(row.is_active),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

export function mapLeadItem(row: Row): LeadItem {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    productId: String(row.product_id),
    productCode: String(row.product_code ?? ''),
    productName: String(row.product_name ?? ''),
    quantityBoxes: toNumber(row.quantity_boxes),
    quantitySqft: toNumber(row.quantity_sqft),
    unitPrice: toNumber(row.unit_price),
    lineTotal: toNumber(row.line_total),
    parameters: (row.parameters as Record<string, unknown> | null) ?? {},
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
  };
}

export function mapLead(row: Row, items: LeadItem[]): Lead {
  return {
    id: String(row.id),
    leadNumber: String(row.lead_number),
    partyId: String(row.party_id),
    partyName: String(row.party_name ?? ''),
    status: row.status as Lead['status'],
    sourcePanelId: (row.source_panel_id as string | null) ?? null,
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    totalAmount: toRequiredNumber(row.total_amount),
    orderDate: toIso(row.order_date),
    createdAt: toRequiredIso(row.created_at),
    updatedAt: toRequiredIso(row.updated_at),
    items,
  };
}
