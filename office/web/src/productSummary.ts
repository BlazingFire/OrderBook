/**
 * The one-line answers the catalogue gives about a sub product: its code,
 * what it weighs, the product it sits under and the colour it shows. All
 * are the sub product's own fields; there is no variant layer under it.
 *
 * They live here rather than in `CatalogScreen` because the list row and the
 * detail card have to agree.
 */

import type { Product } from '@orderbook/shared';
import { shownColour } from '@orderbook/shared';

import { formatKg } from '@orderbook/ui';

/** One copy, in the ui kit: a product's name never carries its main-product code. */
export { productLabel } from '@orderbook/ui';

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
 * Magenta). Nothing when it offers none or several — several is shown as
 * "Multicolour" by the caller, because the counter picks the colour.
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
