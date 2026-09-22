/**
 * The one-line answers the catalogue gives about a product: its code, and what
 * it weighs.
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

import type { Product } from '@orderbook/shared';

import { formatKg, t } from '@orderbook/ui';

/** Active variants — the only ones any of these figures counts. */
function active(product: Product) {
  return product.variants.filter((variant) => variant.isActive);
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
export function missingWeight(product: Product): boolean {
  return product.variants.some((variant) => variant.isActive && variant.weightKg === null);
}

/**
 * What the product weighs, or `null` when nobody has measured it yet.
 *
 * `null` rather than `'0 kg'` on purpose: the caller renders it as the "weight
 * missing" pill, because a lead priced off a zero weight is a lorry loaded
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
