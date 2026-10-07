/**
 * The catalogue's colour rules, and how a sub product and its colours read on
 * the way out (`docs/catalogue/CATALOGUE_MODEL.md` §2, §8).
 *
 * Every sub product is a model with exactly one variant, and its rule is
 * **derived** from what 1.2's product master already stores — there is no
 * rule column and no sentinel colour:
 *
 * - `fixed` — `hasVariants`, one variant whose label *is* the colour (White,
 *   Black, Magenta). Nothing is chosen at the counter; the colour shows,
 *   unless it only repeats the sub product's own name (`MAGENTA` / Magenta).
 * - `dedicated` — no label and not multi-colour: numbered designer pieces
 *   (`1111`, `41`) and accessories, whose design is their colour. Nothing is
 *   chosen and nothing is shown.
 * - `selectable` — the owner's "multicolour": `multiColour`, no label. The
 *   counter picks from the `stock.colour` list, several colours with a
 *   quantity each, each one its own line on the same variant.
 *
 * Pure and shared because three places must agree on it without a network
 * call: the Master (which drops a colour sent for anything but `selectable`),
 * the panels' entry and list screens, and the lead PDF's Model / Code / Colour
 * cells.
 */

export type ColourRule = 'fixed' | 'dedicated' | 'selectable';

/** The rule a product follows, from the columns it already has. */
export function colourRuleOf(product: {
  multiColour: boolean;
  variants: ReadonlyArray<{ label: string | null }>;
}): ColourRule {
  if (product.multiColour) return 'selectable';
  return hasText(product.variants[0]?.label) ? 'fixed' : 'dedicated';
}

/**
 * True when a colour only says the sub product's name again — `MAGENTA` sold
 * in Magenta. Case-insensitive, because the catalogue prints names in
 * capitals and the colour list does not.
 */
export function colourRepeatsName(
  colour: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const shown = colour?.trim().toLowerCase() ?? '';
  return shown !== '' && shown === (name?.trim().toLowerCase() ?? '');
}

/** The colour worth showing beside a sub product, or null when there is none or it repeats the name. */
export function shownColour(
  colour: string | null | undefined,
  name: string | null | undefined,
): string | null {
  const trimmed = colour?.trim() ?? '';
  if (!trimmed || colourRepeatsName(trimmed, name)) return null;
  return trimmed;
}

/**
 * True for a sub product printed as a plain number (`1111`, `41`).
 *
 * `710 SOFT CLOSE SEAT COVER` is not: it is a model name that starts with digits, and the
 * owner's rule is about what is printed, not what it begins with.
 */
export function isNumericSubProduct(name: string | null | undefined): boolean {
  return /^\d+$/.test(name?.trim() ?? '');
}

/**
 * Which lead PDF column a sub product prints in (§8): a numbered one in
 * **Code** (right), anything else in **Model** (left). Exactly one is filled;
 * both are null only for a blank name.
 */
export function subProductCells(name: string | null | undefined): {
  model: string | null;
  code: string | null;
} {
  const printed = name?.trim() ?? '';
  if (!printed) return { model: null, code: null };
  return isNumericSubProduct(printed)
    ? { model: null, code: printed }
    : { model: printed, code: null };
}

/** Turns a stored colour into the words to print. */
export type ColourLabelOf = (colour: string) => string;

/**
 * A line stores the colour list's VALUE; what prints is that value's LABEL as
 * the list has it now, so a colour renamed in Fields reads the new way on
 * every note and screen. Matched case-insensitively; a value the list no
 * longer has (deleted, or never listed) prints as stored.
 */
export function colourLabeller(
  options: ReadonlyArray<{ value: string; label: string }>,
): ColourLabelOf {
  const byValue = new Map(options.map((option) => [option.value.trim().toLowerCase(), option.label]));
  return (colour) => byValue.get(colour.trim().toLowerCase())?.trim() || colour;
}

/**
 * The Colour cell for the lines of one sub product (§8).
 *
 * A line's colour is the one chosen on it (`selectable`) or else its
 * variant's label (`fixed`); a `dedicated` line has neither and adds nothing.
 * Lines of the same colour are summed. Then:
 *
 * - one line (or one colour) prints the colour's name — or nothing when it
 *   only repeats the sub product's name;
 * - several print each colour with its quantity, `White ×10, Ivory ×5`, in
 *   the order the lines hold them.
 *
 * The quantity is a bare integer on purpose: this is a cell on a printed
 * table of piece counts, not a sentence for the translation catalogue.
 */
export function lineColourText(
  lines: ReadonlyArray<{
    colour?: string | null;
    variantLabel?: string | null;
    quantity: number;
  }>,
  subProductName: string | null | undefined,
  /** The list's label for a stored colour value; the value itself when absent. */
  labelOf: ColourLabelOf = (colour) => colour,
): string {
  // Keyed case-insensitively, first spelling kept; a line with no colour is
  // its own entry so it still counts towards "several".
  const groups = new Map<string, { colour: string | null; quantity: number }>();
  for (const line of lines) {
    const stored = line.colour?.trim() || line.variantLabel?.trim() || null;
    const colour = stored === null ? null : labelOf(stored);
    const key = colour?.toLowerCase() ?? '';
    const group = groups.get(key);
    if (group) group.quantity += line.quantity;
    else groups.set(key, { colour, quantity: line.quantity });
  }

  const entries = [...groups.values()];
  if (entries.length === 1) return shownColour(entries[0]?.colour, subProductName) ?? '';

  return entries
    .filter((entry): entry is { colour: string; quantity: number } => entry.colour !== null)
    .map((entry) => `${entry.colour} ×${entry.quantity}`)
    .join(', ');
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
