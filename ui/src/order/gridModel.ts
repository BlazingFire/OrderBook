/**
 * The data side of the new pending order's product card, pure and shared by both panels.
 *
 * Choosing a product (a `ProductCategory`: OPT, One piece toilet) opens a card with every one of
 * its sub products at once, a row for each active variant (a row for each colour of a multicolour
 * sub product). A row carries its OWN product facts, because one card spans many sub products: the
 * live deleted-product check, the party's own names and packaging, and the colour rule are all per
 * product id.
 *
 * Nothing here knows about React, the transport or the Enter walk; those stay in the screens.
 */

import { colourRuleOf, type ColourRule, type Product, type ProductImage } from '@orderbook/shared';

/** What every line and every grid row knows about its variant. */
export interface VariantFacts {
  variantId: string;
  /** The colour or pattern; null on a product that comes in one form. */
  variantLabel: string | null;
  code: string;
  /** Per piece, or null while the master has no figure for it yet. */
  weightKg: number | null;
}

/** What is decided per sub product, and copied onto every line the row makes. */
export interface ProductFacts {
  productId: string;
  productName: string;
  categoryName: string;
  /** Snapshots of the product's code and brand, sent with each line (§3). */
  categoryCode: string | null;
  brand: string | null;
  alias: string | null;
  size: string | null;
  /** Decides what the colour cell is (§2). */
  rule: ColourRule;
  fromPartyVariant: boolean;
  notes: string;
  /** The sub product's primary photo, when the catalogue has one. */
  image?: ProductImage;
}

/** One line on the lead: one variant, one colour, one quantity. */
export interface GridLine extends ProductFacts, VariantFacts {
  key: string;
  colour: string;
  packaging: string;
  grade: string;
  quantity: number;
}

/** One row of the card: a sub product's variant, in one colour, with the quantity as typed. */
export interface GridRow extends ProductFacts, VariantFacts {
  /** The row's own identity (React key, patch target). Never the saved line's. */
  key: string;
  /** When the row was lifted from a saved line: that line's key, kept so the line stays itself. */
  lineKey?: string;
  /** Only ever chosen on a `selectable` sub product; blank everywhere else. */
  colour: string;
  /** Kept as text so a half-typed number stays half-typed. */
  qty: string;
  packaging: string;
  grade: string;
}

/** The party's own record of a product, when it has one (names and sizes agreed with the party). */
export interface PartyProductFacts {
  productName?: string | null;
  alias?: string | null;
  size?: string | null;
}

export interface BuildRowsOptions {
  partyRecordFor?: (productId: string) => PartyProductFacts | null | undefined;
  nextKey: () => string;
}

/** Catalogue order (`sortOrder`), stable; a sub product without one comes after those with. */
export function inCatalogueOrder<T extends { sortOrder?: number | null }>(rows: readonly T[]): T[] {
  const last = Number.MAX_SAFE_INTEGER;
  return rows.slice().sort((a, b) => (a.sortOrder ?? last) - (b.sortOrder ?? last));
}

/** The product facts of a catalogue sub product (the party's own names when it has any). */
export function factsOfProduct(
  product: Product,
  partyRecord: PartyProductFacts | null | undefined,
): ProductFacts {
  return {
    productId: product.id,
    productName: partyRecord?.productName ?? product.name,
    image: product.images?.[0],
    categoryName: product.categoryName,
    categoryCode: product.categoryCode,
    brand: product.brand,
    alias: partyRecord?.alias ?? product.alias,
    size: partyRecord?.size ?? product.size,
    rule: colourRuleOf(product),
    fromPartyVariant: Boolean(partyRecord),
    notes: '',
  };
}

/**
 * The card's rows for a chosen product: every sub product, in catalogue order, a row for each
 * variant still on sale. Packaging starts empty on purpose (§3.2): the party's saved packaging is
 * offered, never applied. A variant taken off the form stays sellable on old lines, not new ones.
 */
export function buildRows(subProducts: readonly Product[], options: BuildRowsOptions): GridRow[] {
  const rows: GridRow[] = [];
  for (const product of subProducts) {
    const facts = factsOfProduct(product, options.partyRecordFor?.(product.id));
    for (const variant of product.variants.filter((candidate) => candidate.isActive)) {
      rows.push({
        ...facts,
        key: options.nextKey(),
        variantId: variant.id,
        variantLabel: variant.label,
        code: variant.code,
        weightKg: variant.weightKg,
        colour: '',
        qty: '',
        packaging: '',
        grade: '',
      });
    }
  }
  return rows;
}

/** "+ Same sub product, another colour": a blank copy of the row, right under it. */
export function addColourRow(
  rows: readonly GridRow[],
  key: string,
  nextKey: () => string,
): GridRow[] {
  const at = rows.findIndex((row) => row.key === key);
  if (at < 0) return rows.slice();
  const source = rows[at]!;
  const copy: GridRow = {
    ...source,
    key: nextKey(),
    lineKey: undefined,
    colour: '',
    qty: '',
    packaging: '',
    grade: '',
  };
  return [...rows.slice(0, at + 1), copy, ...rows.slice(at + 1)];
}

/** A row that would become a line: it has a quantity. */
export function isCounted(row: GridRow): boolean {
  return Number(row.qty) > 0;
}

export interface ReadyOptions {
  /** `leads.packagingRequiredOnConvert`: every counted row needs a packaging. */
  packagingRequired: boolean;
  /**
   * The company has a colour list. A `selectable` row needs a colour once it has a quantity; with
   * no list there is nothing to choose from, so it is a plain row (the fallback of the old card).
   */
  colourListNonEmpty: boolean;
}

/** Why a counted row cannot be added yet, or null when it can. */
export function rowProblem(row: GridRow, options: ReadyOptions): 'colour' | 'packaging' | null {
  if (!isCounted(row)) return null;
  if (row.rule === 'selectable' && options.colourListNonEmpty && !row.colour.trim())
    return 'colour';
  if (options.packagingRequired && !row.packaging.trim()) return 'packaging';
  return null;
}

/** True when the row, counted or not, is fine as it stands (an uncounted row is always fine). */
export function rowReady(row: GridRow, options: ReadyOptions): boolean {
  return rowProblem(row, options) === null;
}

/** True when the card can be added: at least one counted row, and every counted row is complete. */
export function cardReady(rows: readonly GridRow[], options: ReadyOptions): boolean {
  const counted = rows.filter(isCounted);
  return counted.length > 0 && counted.every((row) => rowReady(row, options));
}

/** The pieces on the card, for its footer. */
export function cardPieces(rows: readonly GridRow[]): number {
  return rows.filter(isCounted).reduce((sum, row) => sum + Number(row.qty), 0);
}

/**
 * The lines a card adds, in the card's order: one for each counted row. A row lifted from a saved
 * line keeps that line's key; every other row gets a new one.
 */
export function rowsToLines(rows: readonly GridRow[], nextKey: () => string): GridLine[] {
  return rows.filter(isCounted).map((row) => {
    const { qty, key: _rowKey, lineKey, ...rest } = row;
    return { ...rest, key: lineKey ?? nextKey(), quantity: Number(qty) };
  });
}

/** Saved lines as card rows, for an edit: each row remembers its line's key, in the same order. */
export function linesToRows(lines: readonly GridLine[], nextKey: () => string): GridRow[] {
  return lines.map((line) => {
    const { key, quantity, ...rest } = line;
    return { ...rest, key: nextKey(), lineKey: key, qty: String(quantity) };
  });
}

/** A product on the Added products list: its lines, in the order they were added. */
export interface LineGroup<L extends GridLine = GridLine> {
  /** Stable for the group's life: the product's code, else its name. */
  key: string;
  code: string | null;
  name: string;
  brand: string | null;
  lines: L[];
  /** Total pieces across the group. */
  pieces: number;
}

/**
 * The lines grouped by the product (category) they belong to, groups in the order first seen and
 * lines inside a group in their original order. Nothing is reordered: lines are saved in order.
 */
export function groupLines<L extends GridLine>(lines: readonly L[]): Array<LineGroup<L>> {
  const groups = new Map<string, LineGroup<L>>();
  for (const line of lines) {
    const key = `${line.categoryCode ?? ''}|${line.categoryName}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        code: line.categoryCode,
        name: line.categoryName,
        brand: line.brand,
        lines: [],
        pieces: 0,
      };
      groups.set(key, group);
    }
    group.lines.push(line);
    group.pieces += line.quantity;
  }
  return [...groups.values()];
}

/**
 * Where Enter goes from a field of the row walk. A row's fields in order are colour (selectable
 * only), quantity, packaging, grade. From the quantity of a row with no quantity the walk skips that
 * row's packaging and grade and goes on to the next row, so a card of thirty sub products is not
 * thirty rows of three Enters.
 *
 * `stops` is the DOM order of every field of the card followed by the Add button; each stop says
 * which row it belongs to and what kind of field it is. Returns the index of the stop to focus, or
 * null when there is none after `from`.
 */
export interface WalkStop {
  /** Row key, or null for the Add button. */
  rowKey: string | null;
  field: 'colour' | 'qty' | 'packaging' | 'grade' | 'add';
}

export function nextWalkStop(
  stops: readonly WalkStop[],
  from: number,
  qtyOf: (rowKey: string) => number,
): number | null {
  const here = stops[from];
  if (!here) return null;
  if (here.field === 'qty' && here.rowKey && qtyOf(here.rowKey) <= 0) {
    // An empty row: on to the next row's first field (or the Add button).
    for (let index = from + 1; index < stops.length; index += 1) {
      if (stops[index]!.rowKey !== here.rowKey) return index;
    }
    return null;
  }
  return from + 1 < stops.length ? from + 1 : null;
}
