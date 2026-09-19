/**
 * Line-item rules: what gets snapshotted, what each line totals, and what a
 * line means for stock (docs/LEAD_GENERATION_FLOW.md §3.2, §8).
 *
 * A line is **one variant** of a product with one quantity — two colours of
 * the same model are two lines, each carrying its own code, its own weight
 * and its own totals. Pure business rules — no database, no transport. The
 * snapshot rule in particular is the reason this is a module rather than a
 * few lines inside a repository: "frozen at add time" is a promise the
 * conversion path has to make too, and a promise implemented twice is a
 * promise that gets broken once.
 */

/** The catalogue values a line freezes from the product model. */
export interface ProductSnapshotSource {
  id: string;
  name: string;
  alias: string | null;
  rate: number | null;
  sin: string | null;
  size: string | null;
  grade: string | null;
  productType: string | null;
}

/** The variant the line is for: where the code, the colour text and the weight come from. */
export interface ProductVariantSnapshotSource {
  id: string;
  code: string;
  label: string | null;
  weightKg: number | null;
}

/** A party's negotiated overrides, used when a lead is in `partyWiseMode`. */
export interface PartyVariantSnapshotSource {
  alias: string | null;
  rate: number | null;
  size: string | null;
  sin: string | null;
  grade: string | null;
  productType: string | null;
  productName: string | null;
}

/** A line as it exists on a lead or an order, independent of storage. */
export interface LineSnapshot {
  productId: string;
  variantId: string;
  productName: string;
  alias: string | null;
  rate: number | null;
  code: string | null;
  variantLabel: string | null;
  sin: string | null;
  size: string | null;
  weightKg: number | null;
  grade: string | null;
  productType: string | null;
  packaging: string | null;
  sequence: number;
  fromPartyVariant: boolean;
  imagePath: string | null;
  notes: string | null;
  quantity: number;
}

/** What the client asserted about a line, before the server fills the gaps. */
export interface LineDraft {
  productId: string;
  variantId: string;
  quantity: number;
  productName?: string | null;
  alias?: string | null;
  rate?: number | null;
  code?: string | null;
  variantLabel?: string | null;
  sin?: string | null;
  size?: string | null;
  weightKg?: number | null;
  grade?: string | null;
  productType?: string | null;
  packaging?: string | null;
  /** "No rate on this line" — see `LineItemInput.rateUnset`. */
  rateUnset?: boolean;
  sequence?: number;
  fromPartyVariant?: boolean;
  imagePath?: string | null;
  notes?: string | null;
}

/**
 * Build the stored line from what the panel sent plus the catalogue.
 *
 * Values the client supplied win. That looks backwards until you remember the
 * panel may have been offline for a day: the snapshot it captured is the spec
 * the customer was actually quoted, and re-deriving it from today's catalogue
 * would silently change an agreed price. The catalogue only fills blanks.
 *
 * The code, the colour text and the weight come from the **variant**, never
 * from the product or the party's rates — a party negotiates a price, not
 * what a basin weighs. `packaging` is never filled from any source: it comes
 * from the person entering the line or it stays empty (§3.2, §5.2).
 */
export function buildLineSnapshot(
  draft: LineDraft,
  product: ProductSnapshotSource,
  variant: ProductVariantSnapshotSource,
  partyVariant: PartyVariantSnapshotSource | null,
  sequence: number,
): LineSnapshot {
  const fromPartyVariant = partyVariant !== null;

  return {
    productId: product.id,
    variantId: variant.id,
    productName: draft.productName ?? partyVariant?.productName ?? product.name,
    alias: firstDefined(draft.alias, partyVariant?.alias, product.alias),
    // `rateUnset` is a decision, not a gap, so it stops the fallback dead. A
    // plain `null` rate still falls through to the party's rate and the
    // catalogue, which is what makes a line meant to carry no price save at one.
    rate: draft.rateUnset ? null : firstDefined(draft.rate, partyVariant?.rate, product.rate),
    code: draft.code ?? variant.code,
    variantLabel: draft.variantLabel ?? variant.label,
    sin: firstDefined(draft.sin, partyVariant?.sin, product.sin),
    size: firstDefined(draft.size, partyVariant?.size, product.size),
    weightKg: firstDefined(draft.weightKg, variant.weightKg),
    grade: firstDefined(draft.grade, partyVariant?.grade, product.grade),
    productType: firstDefined(draft.productType, partyVariant?.productType, product.productType),
    // Deliberately only ever the caller's value.
    packaging: draft.packaging ?? null,
    sequence: draft.sequence ?? sequence,
    fromPartyVariant: draft.fromPartyVariant ?? fromPartyVariant,
    imagePath: draft.imagePath ?? null,
    notes: draft.notes ?? null,
    quantity: normaliseQuantity(draft.quantity),
  };
}

/** A finite, non-negative number; anything else counts as nothing entered. */
export function normaliseQuantity(value: unknown): number {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return quantity;
}

/** Smallest currency unit; null when the rate is unknown rather than zero. */
export function lineTotal(line: { rate: number | null; quantity: number }): number | null {
  if (line.rate === null || line.rate === undefined) return null;
  return Math.round(line.rate * line.quantity);
}

/** Kilograms, three decimals; null when the variant's weight has not been entered. */
export function lineWeightKg(line: { weightKg: number | null; quantity: number }): number | null {
  if (line.weightKg === null || line.weightKg === undefined) return null;
  return Math.round(line.weightKg * line.quantity * 1000) / 1000;
}

export function orderTotalAmount(lines: readonly LineSnapshot[]): number {
  return lines.reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0);
}

/**
 * Total shipping weight over the lines that have a weight. Always computed,
 * even when a human overrides it — the override is displayed instead of this
 * figure, never in place of knowing it. Lines whose variant has no weight yet
 * contribute nothing; `linesWithoutWeight` says how many were left out.
 */
export function computeTotalWeightKg(lines: readonly LineSnapshot[]): number {
  const total = lines.reduce((sum, line) => sum + (lineWeightKg(line) ?? 0), 0);
  // Three decimals matches the column; float drift otherwise shows up as
  // 12.000000000000002 kg on a dispatch note.
  return Math.round(total * 1000) / 1000;
}

export function linesWithoutWeight(lines: readonly LineSnapshot[]): number {
  return lines.filter((line) => line.weightKg === null).length;
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}
