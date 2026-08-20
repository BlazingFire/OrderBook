/**
 * Domain entity shapes as they travel over the wire between Master and Office.
 * These mirror the tables documented in docs/schema/, with Postgres timestamps
 * serialized to ISO strings and numeric columns already coerced to `number`.
 */

export type Uuid = string;
/** ISO 8601 timestamp string, e.g. "2026-08-20T10:15:00.000Z". */
export type IsoTimestamp = string;

export type UserRole = 'admin' | 'staff';

export interface User {
  id: Uuid;
  username: string;
  fullName: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type OfficePanelStatus = 'pending' | 'active' | 'revoked';

export interface OfficePanel {
  id: Uuid;
  name: string;
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

export interface Party {
  id: Uuid;
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
  isActive: boolean;
  createdByUserId: Uuid | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ProductCategory {
  id: Uuid;
  name: string;
  createdAt: IsoTimestamp;
}

export interface Product {
  id: Uuid;
  productCode: string;
  name: string;
  categoryId: Uuid | null;
  categoryName: string | null;
  size: string | null;
  finish: string | null;
  series: string | null;
  color: string | null;
  thicknessMm: number | null;
  piecesPerBox: number | null;
  boxCoverageSqft: number | null;
  /** Smallest currency unit (paise), never a float. */
  pricePerBox: number | null;
  /** Smallest currency unit (paise), never a float. */
  pricePerSqft: number | null;
  hsnCode: string | null;
  parameters: Record<string, unknown>;
  isActive: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type LeadStatus = 'new' | 'verified' | 'order' | 'cancelled';

export interface LeadItem {
  id: Uuid;
  leadId: Uuid;
  productId: Uuid;
  productCode: string;
  productName: string;
  quantityBoxes: number | null;
  quantitySqft: number | null;
  /** Smallest currency unit, snapshot of the price when the line was added. */
  unitPrice: number | null;
  /** Smallest currency unit. */
  lineTotal: number | null;
  parameters: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Lead {
  id: Uuid;
  leadNumber: string;
  partyId: Uuid;
  partyName: string;
  status: LeadStatus;
  sourcePanelId: Uuid | null;
  createdByUserId: Uuid | null;
  notes: string | null;
  /** Smallest currency unit. */
  totalAmount: number;
  orderDate: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  items: LeadItem[];
}

/**
 * Current stock for one product, joined with enough product identity to be
 * shown on its own. `quantityBoxes` is the authoritative figure; `quantitySqft`
 * mirrors it using the product's box coverage for staff who quote in sqft.
 */
export interface InventoryStockLevel {
  productId: Uuid;
  productCode: string;
  productName: string;
  categoryName: string | null;
  size: string | null;
  quantityBoxes: number;
  quantitySqft: number;
  reorderLevel: number | null;
  /** True when stock is at or below the reorder level the operator set. */
  isLow: boolean;
  updatedAt: IsoTimestamp | null;
}

export type StockMovementType = 'inbound' | 'outbound' | 'adjustment';

export interface StockMovement {
  id: number;
  productId: Uuid;
  productCode: string;
  productName: string;
  movementType: StockMovementType;
  /** Signed: positive adds stock, negative removes it. */
  quantityBoxes: number;
  referenceType: string | null;
  referenceId: Uuid | null;
  note: string | null;
  createdAt: IsoTimestamp;
}

export interface MasterIdentity {
  masterUniqueId: Uuid;
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
}
