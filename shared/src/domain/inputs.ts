/**
 * Write-side payloads. These are what an Office Panel sends to the Master to
 * change data; the Master validates them before they reach a repository.
 */

import type { LeadStatus, Uuid } from './entities.js';

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
}

export interface ProductInput {
  productCode: string;
  name: string;
  categoryId?: Uuid | null;
  categoryName?: string | null;
  size?: string | null;
  finish?: string | null;
  series?: string | null;
  color?: string | null;
  thicknessMm?: number | null;
  piecesPerBox?: number | null;
  boxCoverageSqft?: number | null;
  pricePerBox?: number | null;
  pricePerSqft?: number | null;
  hsnCode?: string | null;
  parameters?: Record<string, unknown>;
}

export interface LeadItemInput {
  productId: Uuid;
  quantityBoxes?: number | null;
  quantitySqft?: number | null;
  unitPrice?: number | null;
  parameters?: Record<string, unknown>;
}

export interface LeadInput {
  partyId: Uuid;
  notes?: string | null;
  items: LeadItemInput[];
}

export interface LeadStatusChangeInput {
  leadId: Uuid;
  status: LeadStatus;
}

/** Stock arriving from the factory or a purchase. */
export interface StockInboundInput {
  productId: Uuid;
  quantityBoxes: number;
  note?: string | null;
}

/**
 * A correction after a physical count. `quantityBoxes` is the counted total,
 * not a delta — staff count what is on the floor, they do not compute
 * differences.
 */
export interface StockAdjustmentInput {
  productId: Uuid;
  quantityBoxes: number;
  note?: string | null;
}

export interface ReorderLevelInput {
  productId: Uuid;
  reorderLevel: number | null;
}

export interface StockListQuery extends ListQuery {
  /** Restrict to products at or below their reorder level. */
  lowOnly?: boolean;
}

export interface ListQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LeadListQuery extends ListQuery {
  statuses?: LeadStatus[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
