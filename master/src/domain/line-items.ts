/**
 * Line-item rules: what gets snapshotted, what each line weighs, and what a
 * line means for stock (docs/LEAD_GENERATION_FLOW.md §3.2, §8).
 *
 * A line is **one variant** of a product with one quantity — two colours of
 * the same model are two lines, each carrying its own code and its own
 * weight. Pure business rules — no database, no transport. The snapshot rule
 * in particular is the reason this is a module rather than a few lines inside
 * a repository: "frozen at add time" is a promise the conversion path has to
 * make too, and a promise implemented twice is a promise that gets broken
 * once.
 */

/** The catalogue values a line freezes from the product model. */
export interface ProductSnapshotSource {
  id: string;
  name: string;
  categoryName: string | null;
  alias: string | null;
  size: string | null;
  /** Whether the model is made in any colour of the company's list — see `colour` below. */
  multiColour: boolean;
}

/** The variant the line is for: where the code, the colour text and the weight come from. */
export interface ProductVariantSnapshotSource {
  id: string;
  code: string;
  label: string | null;
  weightKg: number | null;
}

/** A party's own version of the product, used when a lead is in `partyWiseMode`. */
export interface PartyVariantSnapshotSource {
  alias: string | null;
  size: string | null;
  productName: string | null;
}

/** A line as it exists on a lead or an order, independent of storage. */
export interface LineSnapshot {
  productId: string;
  variantId: string;
  productName: string;
  categoryName: string | null;
  alias: string | null;
  code: string | null;
  variantLabel: string | null;
  /** The colour chosen on the line; only ever on a multi-colour product. */
  colour: string | null;
  size: string | null;
  weightKg: number | null;
  packaging: string | null;
  /** The grade this line is sold as, from the company's `line.grade` list. */
  grade: string | null;
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
  categoryName?: string | null;
  alias?: string | null;
  code?: string | null;
  variantLabel?: string | null;
  colour?: string | null;
  size?: string | null;
  weightKg?: number | null;
  packaging?: string | null;
  grade?: string | null;
  sequence?: number;
  fromPartyVariant?: boolean;
  imagePath?: string | null;
  notes?: string | null;
}

/** Thrown for a colour on a product that is not made in colours; the caller translates. */
export class LineColourError extends Error {
  constructor() {
    super('validation.lead.colourUnexpected');
    this.name = 'LineColourError';
  }
}

/**
 * Build the stored line from what the panel sent plus the catalogue.
 *
 * Values the client supplied win. That looks backwards until you remember the
 * panel may have been offline for a day: the snapshot it captured is the spec
 * the customer was actually quoted, and re-deriving it from today's catalogue
 * would silently change an agreed line. The catalogue only fills blanks.
 *
 * The code, the colour text and the weight come from the **variant**, never
 * from the product or the party's record — a party has its own name for a
 * basin, not its own weight for it. `packaging`, `grade` and `colour` are never
 * filled from any source: they come from the person entering the line or they
 * stay empty (§3.2, §5.2). A colour is accepted only on a `multiColour`
 * product — anywhere else it would name a colour the factory does not make.
 */
export function buildLineSnapshot(
  draft: LineDraft,
  product: ProductSnapshotSource,
  variant: ProductVariantSnapshotSource,
  partyVariant: PartyVariantSnapshotSource | null,
  sequence: number,
): LineSnapshot {
  const fromPartyVariant = partyVariant !== null;
  const colour = typeof draft.colour === 'string' && draft.colour.trim() !== '' ? draft.colour.trim() : null;
  if (colour !== null && !product.multiColour) throw new LineColourError();

  return {
    productId: product.id,
    variantId: variant.id,
    productName: draft.productName ?? partyVariant?.productName ?? product.name,
    // The main product the line was sold under, frozen like the name (v1.1.0).
    categoryName: draft.categoryName ?? product.categoryName,
    alias: firstDefined(draft.alias, partyVariant?.alias, product.alias),
    code: draft.code ?? variant.code,
    variantLabel: draft.variantLabel ?? variant.label,
    colour,
    size: firstDefined(draft.size, partyVariant?.size, product.size),
    weightKg: firstDefined(draft.weightKg, variant.weightKg),
    // Deliberately only ever the caller's value.
    packaging: draft.packaging ?? null,
    // The same rule, and for the same reason: no product, variant or party
    // record carries a grade to fall back on. Blank is a legal answer.
    grade: draft.grade?.trim() || null,
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

/** Kilograms, three decimals; null when the variant's weight has not been entered. */
export function lineWeightKg(line: { weightKg: number | null; quantity: number }): number | null {
  if (line.weightKg === null || line.weightKg === undefined) return null;
  return Math.round(line.weightKg * line.quantity * 1000) / 1000;
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
