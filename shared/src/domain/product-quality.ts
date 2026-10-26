/**
 * Product data-quality suspects (docs/PRODUCT_CONFLICTS.md §D, §F).
 *
 * Pure: a product row plus its catalogue neighbours in, a list of suspect
 * findings out. Nothing here deletes or patches — the conflicts tab shows
 * each finding with the rows it names, and a human fixes the data.
 */

export type QualitySuspectKind =
  | 'weight-swing'
  | 'orphan-colour'
  | 'size-drift'
  | 'alias-collision'
  | 'fixed-without-colour'
  | 'dedicated-with-colour'
  | 'import-rename'
  | 'import-move';

export interface QualitySuspect {
  kind: QualitySuspectKind;
  productId: string;
  productName: string;
  detail: string;
}

export interface QualityProduct {
  id: string;
  name: string;
  size: string | null;
  alias: string | null;
  categoryId: string;
  brand: string | null;
  colourRule: string | null;
  variants: Array<{
    id: string;
    code: string | null;
    label: string | null;
    weightKg: number | null;
  }>;
}

export interface QualityNeighbour {
  id: string;
  name: string;
  categoryId: string;
  brand: string | null;
  codes: string[];
}

const lc = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

// A8/A9 detectors live in duplicate-products.ts (the finder uses them); re-exported
// here so quality callers import from one module.
export { isCodeVariant, isNearName, levenshtein } from './duplicate-products.js';

/** D3: a variant weight that moved > 50% (or to/from null is not a swing — it is unknown, not wrong). */
export function weightSwing(
  before: number | null,
  after: number | null,
): boolean {
  if (before === null || after === null || before <= 0 || after <= 0) return false;
  if (before === after) return false;
  return Math.abs(after - before) / before > 0.5;
}

/** D4: a variant label naming a colour the catalogue list does not hold. */
export function orphanColour(
  label: string | null,
  colours: ReadonlySet<string> | ReadonlyArray<string>,
): boolean {
  if (!label || !label.trim()) return false;
  const set = colours instanceof Set ? colours : new Set([...colours].map((colour) => colour.trim().toLowerCase()));
  return !set.has(label.trim().toLowerCase());
}

/** D5: sizes in one Product that normalize the same but print differently. */
export function normalizeSize(size: string | null | undefined): string {
  return (size ?? '').trim().replace(/\s+/g, '').replace(/x/gi, 'x').toLowerCase();
}

export function sizeDriftVariants(products: ReadonlyArray<{ id: string; size: string | null }>): string[][] {
  const byNorm = new Map<string, string[]>();
  for (const product of products) {
    if (!product.size || !product.size.trim()) continue;
    const norm = normalizeSize(product.size);
    const list = byNorm.get(norm) ?? [];
    list.push(product.size);
    byNorm.set(norm, list);
  }
  return [...byNorm.values()]
    .map((forms) => [...new Set(forms)])
    .filter((forms) => forms.length > 1);
}

/** D6: an alias that equals another product's name or code in the same brand. */
export function aliasCollision(
  alias: string | null,
  neighbours: ReadonlyArray<{ name: string; codes: string[]; brand: string | null }>,
  ownBrand: string | null,
): boolean {
  if (!alias || !alias.trim()) return false;
  const key = lc(alias);
  return neighbours.some(
    (neighbour) =>
      lc(neighbour.brand) === lc(ownBrand) &&
      (lc(neighbour.name) === key || neighbour.codes.some((code) => lc(code) === key)),
  );
}

/**
 * D7/D8: colour-rule contradictions against the rows the rule governs.
 * fixed needs ≥1 named variant colour; dedicated must name none.
 */
export function colourRuleContradiction(
  colourRule: string | null,
  variants: ReadonlyArray<{ label: string | null }>,
): 'fixed-without-colour' | 'dedicated-with-colour' | null {
  const named = variants.filter((variant) => variant.label && variant.label.trim()).length;
  if (colourRule === 'fixed' && named === 0) return 'fixed-without-colour';
  if ((colourRule === 'dedicated' || !colourRule) && named > 0) {
    // Blank rule reads the Colour column the old way: a named colour is fine.
    // Only an explicit `dedicated` contradicts a named colour.
    if (colourRule === 'dedicated') return 'dedicated-with-colour';
  }
  return null;
}

/**
 * F4: an import row whose (brand, name) matches a live product but whose code
 * is not among its variant codes — rename, or a new product reusing a name?
 */
export function importRenameSuspect(
  rowName: string,
  rowBrand: string | null,
  rowCode: string | null,
  stored: { name: string; brand: string | null; codes: string[] },
): boolean {
  if (lc(rowName) !== lc(stored.name)) return false;
  if (lc(rowBrand) !== lc(stored.brand)) return false;
  if (!rowCode || !rowCode.trim()) return false;
  return !stored.codes.some((code) => lc(code) === lc(rowCode));
}

/**
 * F5: an import row whose sub product name matches a live sub product but
 * under a different Product — move, or a new sub product reusing a name?
 */
export function importMoveSuspect(
  rowName: string,
  rowCategoryId: string,
  stored: { name: string; categoryId: string },
): boolean {
  return lc(rowName) === lc(stored.name) && rowCategoryId !== stored.categoryId && rowName.trim() !== '';
}

/** Run every row-level check over one product against its neighbours. */
export function qualitySuspects(
  product: QualityProduct,
  neighbours: QualityNeighbour[],
  colours: ReadonlySet<string> | ReadonlyArray<string>,
): QualitySuspect[] {
  const suspects: QualitySuspect[] = [];
  const found = (kind: QualitySuspectKind, detail: string): void => {
    suspects.push({ kind, productId: product.id, productName: product.name, detail });
  };

  for (const variant of product.variants) {
    if (orphanColour(variant.label, colours)) {
      found('orphan-colour', `${variant.code ?? variant.id}: colour "${variant.label}" is not on the colour list`);
    }
  }

  if (aliasCollision(product.alias, neighbours, product.brand)) {
    found('alias-collision', `alias "${product.alias}" equals another product's name or code`);
  }

  const contradiction = colourRuleContradiction(product.colourRule, product.variants);
  if (contradiction === 'fixed-without-colour') {
    found('fixed-without-colour', 'colour rule is fixed but no variant names a colour');
  } else if (contradiction === 'dedicated-with-colour') {
    found('dedicated-with-colour', 'colour rule is dedicated but a variant names a colour');
  }

  return suspects;
}
