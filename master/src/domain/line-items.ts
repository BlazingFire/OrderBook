/**
 * Line-item rules: what gets snapshotted, what each line totals, and what a
 * line means for stock (docs/LEAD_GENERATION_FLOW.md §3.2, §8).
 *
 * Pure business rules — no database, no transport. The snapshot rule in
 * particular is the reason this is a module rather than a few lines inside a
 * repository: "frozen at add time" is a promise the conversion path has to
 * make too, and a promise implemented twice is a promise that gets broken once.
 */

/** The catalogue values a line freezes when the product is picked. */
export interface ProductSnapshotSource {
  id: string;
  name: string;
  alias: string | null;
  rate: number | null;
  productCode: string | null;
  sin: string | null;
  size: string | null;
  weightKg: number | null;
  grade: string | null;
  productType: string | null;
}

/** A party's negotiated overrides, used when a lead is in `partyWiseMode`. */
export interface VariantSnapshotSource {
  alias: string | null;
  rate: number | null;
  size: string | null;
  sin: string | null;
  grade: string | null;
  productType: string | null;
  weightKg: number | null;
  productName: string | null;
}

export interface ColourQuantity {
  colour: string;
  quantity: number;
}

/** A line as it exists on a lead or an order, independent of storage. */
export interface LineSnapshot {
  productId: string;
  productName: string;
  alias: string | null;
  rate: number | null;
  code: string | null;
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
  quantities: ColourQuantity[];
}

/** What the client asserted about a line, before the server fills the gaps. */
export interface LineDraft {
  productId: string;
  productName?: string | null;
  alias?: string | null;
  rate?: number | null;
  code?: string | null;
  sin?: string | null;
  size?: string | null;
  weightKg?: number | null;
  grade?: string | null;
  productType?: string | null;
  packaging?: string | null;
  sequence?: number;
  fromPartyVariant?: boolean;
  imagePath?: string | null;
  notes?: string | null;
  quantities: ColourQuantity[];
}

/**
 * Build the stored line from what the panel sent plus the catalogue.
 *
 * Values the client supplied win. That looks backwards until you remember the
 * panel may have been offline for a day: the snapshot it captured is the spec
 * the customer was actually quoted, and re-deriving it from today's catalogue
 * would silently change an agreed price. The catalogue only fills blanks.
 *
 * `packaging` is never filled from either source — not from the product, and
 * not from the party variant. It comes from the person entering the line or it
 * stays empty (§3.2, §5.2).
 */
export function buildLineSnapshot(
  draft: LineDraft,
  product: ProductSnapshotSource,
  variant: VariantSnapshotSource | null,
  sequence: number,
): LineSnapshot {
  const fromVariant = variant !== null;

  return {
    productId: product.id,
    productName: draft.productName ?? variant?.productName ?? product.name,
    alias: firstDefined(draft.alias, variant?.alias, product.alias),
    rate: firstDefined(draft.rate, variant?.rate, product.rate),
    code: draft.code ?? product.productCode,
    sin: firstDefined(draft.sin, variant?.sin, product.sin),
    size: firstDefined(draft.size, variant?.size, product.size),
    weightKg: firstDefined(draft.weightKg, variant?.weightKg, product.weightKg),
    grade: firstDefined(draft.grade, variant?.grade, product.grade),
    productType: firstDefined(draft.productType, variant?.productType, product.productType),
    // Deliberately only ever the caller's value.
    packaging: draft.packaging ?? null,
    sequence: draft.sequence ?? sequence,
    fromPartyVariant: draft.fromPartyVariant ?? fromVariant,
    imagePath: draft.imagePath ?? null,
    notes: draft.notes ?? null,
    quantities: normalizeQuantities(draft.quantities),
  };
}

/**
 * Collapse duplicate colours and drop empty ones.
 *
 * Two rows for the same colour on one line would each reserve stock separately
 * and each show as a row in the UI — a data shape nothing downstream expects.
 */
export function normalizeQuantities(quantities: ColourQuantity[]): ColourQuantity[] {
  const totals = new Map<string, number>();

  for (const entry of quantities) {
    const colour = entry.colour.trim();
    if (!colour) continue;
    const quantity = Number(entry.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    totals.set(colour, (totals.get(colour) ?? 0) + quantity);
  }

  return [...totals.entries()].map(([colour, quantity]) => ({ colour, quantity }));
}

export function totalQuantity(line: { quantities: ColourQuantity[] }): number {
  return line.quantities.reduce((sum, entry) => sum + entry.quantity, 0);
}

/** Smallest currency unit; null when the rate is unknown rather than zero. */
export function lineTotal(line: LineSnapshot): number | null {
  if (line.rate === null || line.rate === undefined) return null;
  return Math.round(line.rate * totalQuantity(line));
}

export function orderTotalAmount(lines: LineSnapshot[]): number {
  return lines.reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0);
}

/**
 * Total shipping weight. Always computed, even when a human overrides it —
 * the override is displayed instead of this figure, never in place of knowing it.
 */
export function computeTotalWeightKg(lines: LineSnapshot[]): number {
  const total = lines.reduce(
    (sum, line) => sum + (line.weightKg ?? 0) * totalQuantity(line),
    0,
  );
  // Three decimals matches the column; float drift otherwise shows up as
  // 12.000000000000002 kg on a dispatch note.
  return Math.round(total * 1000) / 1000;
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}
