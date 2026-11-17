/**
 * A sub product's colours and print side, and how they read on the way out
 * (`docs/catalogue/CATALOGUE_MODEL.md` §2, §8).
 *
 * Each sub product stores the colours it is offered in (`Product.colours`)
 * and where it prints (`Product.printSide`) outright — no rule is derived
 * from other columns any more (the variant layer that carried the old
 * fixed/dedicated/selectable derivation is gone):
 *
 * - no colours — nothing is chosen and nothing is shown (numbered designer
 *   pieces like `1111` and accessories, whose design is their colour);
 * - one colour — it always applies and shows, unless it only repeats the
 *   sub product's own name (`MAGENTA` / Magenta);
 * - several — the counter picks per line from a dropdown, several colours
 *   with a quantity each, each one its own line.
 *
 * The print side is `left`, `right`, or `default`, and `default` keeps the
 * catalogue's original rule — a purely numeric name prints right (Code),
 * anything else left (Model) — so a catalogue nobody has re-sided by hand
 * prints exactly as it always did.
 *
 * Pure and shared because three places must agree on it without a network
 * call: the Master (which drops a colour a sub product does not offer),
 * the panels' entry and list screens, and the printed notes' two halves.
 */

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

/** A sub product's stored print-side setting: an explicit side, or `default`. */
export type PrintSideSetting = 'default' | 'left' | 'right';

/** The resolved side a sub product prints on — Model (left) or Code (right). */
export type PrintSide = 'left' | 'right';

/**
 * Which side a sub product prints on.
 *
 * An explicit `left`/`right` setting (chosen per sub product in Products)
 * wins. `default` — and a missing setting, on a line or product from before
 * the setting existed — keeps the catalogue's original rule: a purely
 * numeric name prints right, anything else left.
 */
export function printSideOf(
  name: string | null | undefined,
  setting: PrintSideSetting | null | undefined,
): PrintSide {
  if (setting === 'left' || setting === 'right') return setting;
  return isNumericSubProduct(name) ? 'right' : 'left';
}

/**
 * Which lead PDF column a sub product prints in (§8), by its resolved print
 * side: left in **Model**, right in **Code**. Exactly one is filled; both
 * are null only for a blank name. With no setting given, the side resolves
 * by the Default rule, as every print before the setting existed did.
 */
export function subProductCells(
  name: string | null | undefined,
  setting: PrintSideSetting | null | undefined = 'default',
): {
  model: string | null;
  code: string | null;
} {
  const printed = name?.trim() ?? '';
  if (!printed) return { model: null, code: null };
  return printSideOf(printed, setting) === 'right'
    ? { model: null, code: printed }
    : { model: printed, code: null };
}

/**
 * The colour list a sub product offers, cleaned for storage and display:
 * trimmed, blanks dropped, duplicates collapsed case-insensitively (first
 * spelling kept), order preserved.
 */
export function normalizeColours(
  colours: ReadonlyArray<string> | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const colour of colours ?? []) {
    const trimmed = colour.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * The colour one lead/order line may carry for a sub product offering
 * `colours`:
 *
 * - none offered → no colour, whatever was sent;
 * - exactly one → that colour, always (nothing to choose);
 * - several → the chosen one, in the list's own spelling, when it is on
 *   the list; a colour that is not offered is dropped to null rather than
 *   refusing the line (a queued offline lead must not bounce on it).
 */
export function resolveLineColour(
  colours: ReadonlyArray<string>,
  chosen: string | null | undefined,
): string | null {
  const offered = normalizeColours(colours);
  if (offered.length === 0) return null;
  if (offered.length === 1) return offered[0] ?? null;
  const wanted = chosen?.trim().toLowerCase() ?? '';
  return offered.find((colour) => colour.toLowerCase() === wanted) ?? null;
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
