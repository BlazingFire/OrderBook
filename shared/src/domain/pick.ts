/**
 * The searchable picker's wire contract.
 *
 * A picker is not a search box and not a `<select>`. It answers on the third
 * keystroke, it keeps whatever is already selected visible even when the search
 * term excludes it, and it tells the reader when it has stopped counting.
 *
 * Three kinds. Leads and orders are served by their own list endpoints,
 * which already page and filter; and a `user` kind was deliberately dropped —
 * `listUsers` requires `users.manage` while the Recycle Bin's "deleted by"
 * filter is gated on `recycleBin.viewAll`, so routing that filter through a
 * pick would 403 people who have a working filter today.
 */

import type { Party, Product, ProductCategory, RecordId } from './entities.js';

export type PickKind = 'product' | 'party' | 'variant' | 'category';

/**
 * One product in one colour, as the new-lead screen reaches it.
 *
 * A flattened join rather than a `Product` because that is the unit the
 * counter works in: a code, a colour, what is free to sell in that colour, and
 * enough of the product to fill a line. `product` search answers with the
 * product across all its colours; this answers with one row per colour.
 */
export interface ProductVariantPick {
  /** The short code somebody types, when the pair has been given one. */
  variantCode: string | null;
  productId: RecordId;
  productCode: string;
  productName: string;
  alias: string | null;
  sin: string | null;
  size: string | null;
  grade: string | null;
  productType: string | null;
  weightKg: number | null;
  colour: string;
  /** Boxes that may be sold now — on hand less what orders already hold. */
  availableBoxes: number;
  /** Absent, not null, without `field.saleRate.view` — never zero. */
  rate?: number | null;
}

export interface PickQuery {
  term?: string;
  limit?: number;
  /**
   * Ids that must come back whatever the term matches.
   *
   * Two jobs, and both are about the picker not lying. The row that is already
   * selected must not vanish when somebody types a term it does not match, and
   * pinned rows have to be present in the idle state before any term exists.
   */
  include?: string[];
  /**
   * Main-product filter for `product` picks: only models of this category.
   *
   * The new-lead flow picks the main product first, then searches models
   * inside it — an unfiltered model search over the whole catalogue is what
   * the category-then-model walk replaces.
   */
  categoryId?: string;
}

export interface PickPage<T> {
  items: T[];
  /**
   * True when the underlying set had more rows than `limit`.
   *
   * The listbox says so out loud. A picker that silently shows the first twenty
   * of two hundred teaches people that the thing they are looking for is not
   * there.
   */
  truncated: boolean;
}

export type ProductPickPage = PickPage<Product>;
export type PartyPickPage = PickPage<Party>;
export type VariantPickPage = PickPage<ProductVariantPick>;
export type CategoryPickPage = PickPage<ProductCategory>;

/** How many rows a picker asks for when the caller does not say. */
export const PICK_DEFAULT_LIMIT = 20;
export const PICK_MAX_LIMIT = 50;

export function isPickKind(value: unknown): value is PickKind {
  return value === 'product' || value === 'party' || value === 'variant' || value === 'category';
}
