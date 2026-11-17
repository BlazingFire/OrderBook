/**
 * Line-item rules: what gets snapshotted and what each line weighs
 * (docs/LEAD_GENERATION_FLOW.md §3.2, §8).
 *
 * A line is **one sub product** with one quantity — two colours of the same
 * sub product are two lines, each carrying its own quantity. Pure business
 * rules — no database, no transport. The snapshot rule in particular is the
 * reason this is a module rather than a few lines inside a repository:
 * "frozen at add time" is a promise the conversion path has to make too,
 * and a promise implemented twice is a promise that gets broken once.
 */

import { printSideOf, resolveLineColour } from '@orderbook/shared';
import type { PrintSide, PrintSideSetting } from '@orderbook/shared';

/** The catalogue values a line freezes from the sub product. */
export interface ProductSnapshotSource {
  id: string;
  name: string;
  categoryName: string | null;
  /** The category's code (`OPT`), frozen beside its name. */
  categoryCode: string | null;
  /** The category's brand — brand lives on the category, not the model. */
  brand: string | null;
  alias: string | null;
  size: string | null;
  /** The sub product's software code (`OPT-0001`). */
  code: string;
  weightKg: number | null;
  /** The colours it is offered in — what bounds a line's `colour`. */
  colours: string[];
  /** Its print-side setting; the line freezes the side it resolves to. */
  printSide: PrintSideSetting;
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
  /** Legacy variant reference from a panel built before variants went; null since. */
  variantId: string | null;
  productName: string;
  categoryName: string | null;
  categoryCode: string | null;
  brandName: string | null;
  alias: string | null;
  code: string | null;
  variantLabel: string | null;
  /** The colour on the line — one the sub product offers, or none. */
  colour: string | null;
  /** The resolved side this line prints on, frozen at add time. */
  printSide: PrintSide;
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
  /** The stored line this one continues, when a client sends it on an edit. */
  id?: string | null;
  productId: string;
  variantId?: string | null;
  quantity: number;
  productName?: string | null;
  categoryName?: string | null;
  categoryCode?: string | null;
  brandName?: string | null;
  alias?: string | null;
  code?: string | null;
  variantLabel?: string | null;
  colour?: string | null;
  printSide?: PrintSide | null;
  size?: string | null;
  weightKg?: number | null;
  packaging?: string | null;
  grade?: string | null;
  sequence?: number;
  fromPartyVariant?: boolean;
  imagePath?: string | null;
  notes?: string | null;
}

/** The part of a stored line an edit must carry over unchanged. */
export interface KeptLine {
  id: string;
  productId: string;
  variantId: string | null;
  colour: string | null;
  variantLabel: string | null;
}

const colourKey = (colour: string | null | undefined): string =>
  typeof colour === 'string' ? colour.trim().toLowerCase() : '';

/**
 * Pair each draft with the stored line it continues, or null for a new line.
 *
 * By the line id when the client sent one, else by sub product and colour
 * (the panels resend a line's own colour, not its id) — a legacy variant id,
 * when both sides carry one, must also agree, so lines of two old variants
 * of one sub product do not cross. Each stored line is used once, so two
 * drafts of one sub product and colour do not both claim it.
 *
 * This is what stops an edit rewriting history: a line taken as Ivory on a
 * sub product that offered every colour then, and offers one now, is still
 * Ivory after somebody adds another line to the lead (W2-1, 2026-10-07).
 */
export function matchExistingLines(
  drafts: readonly LineDraft[],
  existing: readonly KeptLine[],
): Array<KeptLine | null> {
  const free = [...existing];
  const take = (index: number): KeptLine | null => (index < 0 ? null : free.splice(index, 1)[0] ?? null);
  const variantAgrees = (line: KeptLine, draft: LineDraft): boolean =>
    !draft.variantId || !line.variantId || line.variantId === draft.variantId;
  return drafts.map((draft) => {
    if (draft.id) {
      const byId = free.findIndex((line) => line.id === draft.id && variantAgrees(line, draft));
      if (byId >= 0) return take(byId);
    }
    return take(
      free.findIndex(
        (line) =>
          line.productId === draft.productId &&
          variantAgrees(line, draft) &&
          colourKey(line.colour) === colourKey(draft.colour),
      ),
    );
  });
}

/**
 * A new line's colour as the company list spells it, or `undefined` when the
 * list does not have it. Case and spacing aside, so "ivory " is "Ivory".
 */
export function listedColour(
  colour: string,
  options: ReadonlyArray<{ value: string; label: string }>,
): string | undefined {
  const key = colourKey(colour);
  return options.find((option) => colourKey(option.value) === key || colourKey(option.label) === key)?.value;
}

/**
 * Build the stored line from what the panel sent plus the catalogue.
 *
 * Values the client supplied win. That looks backwards until you remember the
 * panel may have been offline for a day: the snapshot it captured is the spec
 * the customer was actually quoted, and re-deriving it from today's catalogue
 * would silently change an agreed line. The catalogue only fills blanks.
 *
 * The code and the weight come from the **sub product**, never from the
 * party's record — a party has its own name for a basin, not its own weight
 * for it. `packaging` and `grade` are never filled from any source: they come
 * from the person entering the line or they stay empty (§3.2, §5.2).
 *
 * The colour is resolved against what the sub product offers
 * (`resolveLineColour`): the one colour of a single-colour sub product
 * always, the chosen one when several are offered, and a colour it does not
 * offer **dropped** rather than refused — a lead queued offline cannot be
 * corrected by the person who typed it, so a refusal parked the whole lead
 * in the outbox over a field the line never needed
 * (`docs/catalogue/CATALOGUE_MODEL.md` §2). That rule is for a NEW line only:
 * a `kept` line (`matchExistingLines`) on a sub product that no longer lets
 * a colour be chosen keeps its stored colour and colour text whatever the
 * sub product is today, because it records what was sold.
 */
export function buildLineSnapshot(
  draft: LineDraft,
  product: ProductSnapshotSource,
  partyVariant: PartyVariantSnapshotSource | null,
  sequence: number,
  kept: KeptLine | null = null,
): LineSnapshot {
  const fromPartyVariant = partyVariant !== null;
  const carried = kept !== null && product.colours.length <= 1;
  const colour = carried ? kept.colour : resolveLineColour(product.colours, draft.colour);
  const productName = draft.productName ?? partyVariant?.productName ?? product.name;

  return {
    productId: product.id,
    variantId: draft.variantId ?? kept?.variantId ?? null,
    productName,
    // The main product the line was sold under, frozen like the name (v1.1.0).
    categoryName: draft.categoryName ?? product.categoryName,
    // Its code and brand beside it, by the same rule: the lead PDF prints the
    // brand and the product code as they were on the day the line was taken.
    categoryCode: draft.categoryCode ?? product.categoryCode,
    brandName: draft.brandName ?? product.brand,
    alias: firstDefined(draft.alias, partyVariant?.alias, product.alias),
    code: draft.code ?? product.code,
    variantLabel: carried ? kept.variantLabel : (draft.variantLabel ?? null),
    colour,
    printSide: draft.printSide ?? printSideOf(productName, product.printSide),
    size: firstDefined(draft.size, partyVariant?.size, product.size),
    weightKg: firstDefined(draft.weightKg, product.weightKg),
    // Deliberately only ever the caller's value.
    packaging: draft.packaging ?? null,
    // The same rule, and for the same reason: no product or party record
    // carries a grade to fall back on. Blank is a legal answer.
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

/** Kilograms, three decimals; null when the sub product's weight has not been entered. */
export function lineWeightKg(line: { weightKg: number | null; quantity: number }): number | null {
  if (line.weightKg === null || line.weightKg === undefined) return null;
  return Math.round(line.weightKg * line.quantity * 1000) / 1000;
}

/**
 * Total shipping weight over the lines that have a weight. Always computed,
 * even when a human overrides it — the override is displayed instead of this
 * figure, never in place of knowing it. Lines whose sub product has no weight
 * yet contribute nothing; `linesWithoutWeight` says how many were left out.
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
