/**
 * Product alteration: pending-only patch of line snapshots with frozen history.
 *
 * Editing a product must not rewrite history: dispatched orders and converted
 * leads keep the snapshot taken on the day. Pending leads and undispatched
 * orders take the new snapshot columns while ids stay unchanged. Dispatched
 * and final lines are listed as read only conflicts. The product update itself
 * goes through catalog.service updateProduct with products.edit permission and
 * the productChanges activity shape. This module carries only the shapes for
 * preview, apply and the before after PDF.
 */

import type { ProductInput } from './inputs.js';

export interface AlterationLineRef {
  parentType: 'lead' | 'order';
  parentId: string;
  poNumber: string | null;
  partyName: string | null;
  /** The line's own variant, so the review can show that variant's new code. */
  variantId: string;
  code: string | null;
  variantLabel: string | null;
  /** The line's snapshot product name and size: the "before" of the review. */
  productName: string | null;
  size: string | null;
}

export interface ProductAlterationPreview {
  productId: string;
  productName: string;
  pendingLeads: number;
  pendingOrders: number;
  /** Frozen history totals: converted leads and dispatched orders. */
  frozenLeads: number;
  frozenOrders: number;
  pending: AlterationLineRef[];
  frozen: AlterationLineRef[];
}

export interface ProductAlterationApplyInput {
  product: ProductInput;
  /**
   * The product clocks the conflicts screen opened the record at. When given,
   * a product someone else saved since is refused with 409
   * `error.conflict.staleEdit` instead of patched underneath.
   */
  baseFieldHlc?: Record<string, string>;
}

export interface ProductAlterationAffected {
  parentType: 'lead' | 'order';
  parentId: string;
  poNumber: string | null;
  before: Record<string, string>;
  after: Record<string, string>;
}

export interface ProductAlterationApplyResult {
  productId: string;
  updated: boolean;
  pendingLeadsPatched: number;
  pendingOrdersPatched: number;
  frozenSkipped: number;
  affected: ProductAlterationAffected[];
}
