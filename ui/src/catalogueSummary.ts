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
 * The one-line answers the catalogue gives about a product: its code, what it
 * weighs, the product it sits under and the colour it shows.
 *
 * Both are summaries of the **variants**, not fields on the product — a model
 * made in four colours has four codes and four weights — and both have a wrong
 * answer that looks right. A model's code is not its first variant's code, and
 * a model's weight is not the average of its variants'.
 *
 * They live here rather than in `CatalogScreen` because the list row and the
 * detail card have to agree: a row reading "3 variants · 102-W" beside a detail
 * card reading "102-W" is a bug report waiting to be filed.
 */

import type {
  CategoryInput,
  CategoryUpdateInput,
  OptionListItem,
  Product,
  ProductCategory,
  ProductCategoryListRow,
  ProductImageUpdateInput,
  ProductImportFormat,
  ProductImportMode,
  ProductImportResult,
  ProductInput,
  ProductListPage,
  ProductListQuery,
} from '@orderbook/shared';
import { colourRuleOf, shownColour } from '@orderbook/shared';

import { formatKg } from './format.js';
import { t } from './i18n.js';

/** Active variants — the only ones any of these figures counts. */
function active(product: Product) {
  return product.variants.filter((variant) => variant.isActive);
}

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
 * The colours worth printing beside a sub product under its rule (§2): the
 * variant's own colour for `fixed`, less one that only repeats the name
 * (`MAGENTA` in Magenta); nothing for `dedicated`, whose design is its colour;
 * and nothing for `selectable`, which the caller shows as "Multicolour"
 * because the counter picks its colour. A model from before catalogue v2 with
 * several colour variants lists each.
 */
export function shownColours(product: Product): string[] {
  if (colourRuleOf(product) !== 'fixed') return [];
  return active(product).flatMap((variant) => shownColour(variant.label, product.name) ?? []);
}

/** The code column: the one code, or how many there are and the first of them. */
export function codesOf(product: Product): string {
  const variants = active(product);
  if (variants.length <= 1) return variants[0]?.code ?? product.variants[0]?.code ?? '—';
  return t('catalog.products.variantCount', {
    count: variants.length,
    first: variants[0]!.code,
  });
}

/** A variant whose weight nobody has entered yet — flagged, never treated as zero. */
function missingWeight(product: Product): boolean {
  return product.variants.some((variant) => variant.isActive && variant.weightKg === null);
}

/**
 * What the product weighs, or `null` when nobody has measured it yet.
 *
 * `null` rather than `'0 kg'` on purpose: the caller renders it as the "weight
 * missing" pill, because a lead loaded off a zero weight is a lorry loaded
 * wrong. One figure for a one-form product; a range for a model, because one
 * number for "each of its variants weighs something different" lies.
 */
export function weightLabel(product: Product): string | null {
  if (missingWeight(product)) return null;
  const variants = active(product);
  if (variants.length === 0) return null;
  if (variants.length === 1) return formatKg(variants[0]!.weightKg);

  const weights = variants.map((variant) => variant.weightKg ?? 0);
  const low = Math.min(...weights);
  const high = Math.max(...weights);
  return low === high
    ? formatKg(low)
    : t('product.weight.range', { low: formatKg(low), high: formatKg(high) });
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
  categories(query?: { search?: string; brand?: string }): Promise<ProductCategoryListRow[]>;
  createCategory(input: CategoryInput): Promise<unknown>;
  updateCategory(id: string, input: CategoryUpdateInput): Promise<unknown>;
  deleteCategory(id: string): Promise<unknown>;
  createProduct(input: ProductInput): Promise<{ id: string }>;
  updateProduct(id: string, input: ProductInput): Promise<unknown>;
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
  productImportTemplate(format: ProductImportFormat): Promise<{ blob: Blob; fileName: string }>;
  /** `level` `main` exports the main products; the default is every sub product. */
  exportProducts(
    format: ProductImportFormat,
    level?: 'sub' | 'main',
  ): Promise<{ blob: Blob; fileName: string }>;
  importProducts(
    file: File,
    options: { dryRun: boolean; mode: ProductImportMode },
  ): Promise<ProductImportResult>;
}
