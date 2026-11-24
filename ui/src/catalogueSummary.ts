/**
 * The catalogue summaries and the shape of what the shared catalogue screens
 * are allowed to reach.
 *
 * Port of `office/web/src/productSummary.ts`; keep in step (until the Office
 * switches to this copy the code exists twice). The summary functions are
 * verbatim. The two types at the foot are this port's own: the catalogue
 * screens in `ui/` read their data from a `CatalogueView` and write through a
 * `CatalogueTransport`, one object each, so the Master can hand them HTTP
 * calls and the data it loaded itself.
 *
 * Original header follows.
 *
 * The one-line answers the catalogue gives about a sub product: its code,
 * what it weighs, the product it sits under and the colour it shows. All
 * are the sub product's own fields; there is no variant layer under it.
 *
 * They live here rather than in `CatalogScreen` because the list row and the
 * detail card have to agree.
 */

import type {
  CategoryInput,
  CategoryUpdateInput,
  OptionListItem,
  Product,
  ProductCategory,
  ProductCategoryListRow,
  ProductImageUpdateInput,
  ProductInput,
  ProductListPage,
  ProductListQuery,
} from '@orderbook/shared';
import { shownColour } from '@orderbook/shared';

import { formatKg } from './format.js';

/**
 * A product (a category) the way staff read it: its name, then its brand when
 * the caller has one, `One Piece Toilet · Swisware+`. The category's software
 * code (`OPT`) is never part of the name: it has its own column and field, and a
 * name that carried it read as `OPT · One Piece Toilet` to the owner's eye.
 * Every list, picker and detail says it this way (`docs/catalogue/CATALOGUE_MODEL.md` §1).
 */
export function productLabel(name: string | null | undefined, brand?: string | null): string {
  return [name, brand].filter(Boolean).join(' · ');
}

/**
 * Catalogue order, for products and sub products alike: `sortOrder` first,
 * a row without one after every numbered row, then the name. The snapshot
 * appends upserts, so nothing arrives in this order by itself.
 */
export function byCatalogueOrder(
  a: { sortOrder: number | null; name: string },
  b: { sortOrder: number | null; name: string },
): number {
  const unordered = Number.MAX_SAFE_INTEGER;
  return (a.sortOrder ?? unordered) - (b.sortOrder ?? unordered) || a.name.localeCompare(b.name);
}

/**
 * The colour worth printing beside a sub product (§2): its one colour when
 * it offers exactly one, less one that only repeats the name (`MAGENTA` in
 * Magenta). Nothing when it offers none — its design is its colour — and
 * nothing when it offers several, which the caller shows as "Multicolour"
 * because the counter picks the colour per line.
 */
export function shownColours(product: Product): string[] {
  if (product.colours.length !== 1) return [];
  return shownColour(product.colours[0], product.name) ? [product.colours[0] as string] : [];
}

/** The code column: the sub product's own software code. */
export function codesOf(product: Product): string {
  return product.code || '—';
}

/**
 * What the sub product weighs, or `null` when nobody has measured it yet.
 *
 * `null` rather than `'0 kg'` on purpose: the caller renders it as the "weight
 * missing" pill, because a lead loaded off a zero weight is a lorry loaded
 * wrong.
 */
export function weightLabel(product: Product): string | null {
  return product.weightKg === null ? null : formatKg(product.weightKg);
}

/** What the catalogue screens read: the Master's data, loaded by the host screen. */
export interface CatalogueView {
  permissions: readonly string[];
  optionLists: OptionListItem[];
  categories: ProductCategory[];
  /** Every sub product, loaded once (the snapshot's cap); the detail screens list from it. */
  products: Product[];
}

/** What the catalogue screens write through, and how they page the list. */
export interface CatalogueTransport {
  listProducts(query: ProductListQuery, signal?: AbortSignal): Promise<ProductListPage>;
  /** 1.4 D3: the chosen products as a four-to-a-page PDF with photographs. */
  productSharePdf(ids: string[]): Promise<{ blob: Blob; fileName: string }>;
  categories(query?: { search?: string; brand?: string }): Promise<ProductCategoryListRow[]>;
  createCategory(input: CategoryInput): Promise<unknown>;
  updateCategory(id: string, input: CategoryUpdateInput): Promise<unknown>;
  deleteCategory(id: string): Promise<unknown>;
  /** A sub product into the Recycle Bin (`products.delete`); refused while a live order line quotes it. */
  deleteProduct(id: string): Promise<unknown>;
  createProduct(input: ProductInput): Promise<{ id: string }>;
  updateProduct(id: string, input: Partial<ProductInput> & { baseFieldHlc?: Record<string, string> }): Promise<unknown>;
  uploadProductImage(
    productId: string,
    file: Blob,
    crop: {
      cropX: number;
      cropY: number;
      cropWidth: number;
      cropHeight: number;
      rotationDeg: number;
      caption?: string | null;
    },
  ): Promise<Product>;
  updateProductImage(
    productId: string,
    imageId: string,
    input: ProductImageUpdateInput,
  ): Promise<Product>;
  reorderProductImages(productId: string, ids: string[]): Promise<Product>;
  deleteProductImage(productId: string, imageId: string): Promise<Product>;
}
