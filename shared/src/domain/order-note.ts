/**
 * The two printable notes of an order — Filling note and Dispatch note
 * (docs/ORDER_NOTES_PLAN.md).
 *
 * `buildOrderNote` turns an order's lines into what is printed; `paginateOrderNote`
 * cuts that into A4 pages. Both are pure and take no measurements from a DOM:
 * every row and cell has a fixed height (`NOTE_LAYOUT`) and clips its text, so a
 * page break is arithmetic. That keeps the preview and the paper identical and
 * lets `verify` test the paging.
 *
 * `NOTE_LAYOUT` is the one place the heights live. `ui/src/OrderNote.tsx` sets
 * them on the sheet as CSS custom properties, so a row cannot be resized in CSS
 * alone and silently overflow a page.
 */

import {
  isNumericSubProduct,
  printSideOf,
  shownColour,
  type ColourLabelOf,
  type PrintSide,
} from './colour-rule.js';
import type { MessageKey } from '../i18n/keys.js';
import type { IsoTimestamp, Lead, LineItem, Order, Party, RecordId } from './entities.js';

export type NoteKind = 'filling' | 'dispatch';

/**
 * Which of packing, grade and colour the Dispatch note prints. The Filling
 * note always prints all three. One order saved tick boxes (note_columns):
 * the note screen initialises from them, and every renderer reads them, so an
 * unticked column vanishes from the preview, the print, the PDF and the
 * printroom alike.
 */
export interface NoteColumns {
  packaging: boolean;
  grade: boolean;
  colour: boolean;
}

/** Every column ticked: a note with no saved choice, and the Filling note. */
export const ALL_NOTE_COLUMNS: NoteColumns = { packaging: true, grade: true, colour: true };

/**
 * The saved tick boxes as the mappers read them: null when the record has
 * none (NULL, or a row written before the column existed), else each column
 * present and a boolean, missing keys ticked. Never throws: a value no writer
 * could have stored still reads as a note.
 */
export function parseNoteColumns(value: unknown): NoteColumns | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  const tick = (key: string): boolean => stored[key] === undefined || stored[key] === true;
  return { packaging: tick('packaging'), grade: tick('grade'), colour: tick('colour') };
}

/**
 * The tick boxes as a write path stores them: null clears the choice, an
 * object with only boolean packing/grade/colour keeps it. Anything else is
 * refused with a validation key, so a hand-built request cannot store a shape
 * the readers do not understand.
 */
export function cleanNoteColumns(value: unknown): { value: NoteColumns | null } | { errorKey: MessageKey } {
  if (value === null) return { value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { errorKey: 'validation.noteColumns.invalid' };
  const stored = value as Record<string, unknown>;
  const columns: NoteColumns = { packaging: true, grade: true, colour: true };
  for (const key of ['packaging', 'grade', 'colour'] as const) {
    const entry = stored[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'boolean') return { errorKey: 'validation.noteColumns.invalid' };
    columns[key] = entry;
  }
  return { value: columns };
}

/** The sizes `notes.gradeSize` and an order's own grade size may hold, in pixels. */
export const NOTE_GRADE_SIZE_MIN = 5;
export const NOTE_GRADE_SIZE_MAX = 20;

/**
 * A dealer code as a write path stores it: null clears the override (the
 * party's own code then prints), a string is trimmed and upper-cased. Blank is
 * null rather than an empty override, so a cleared field means "the party".
 */
export function cleanDealerCode(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toUpperCase();
  return text === '' ? null : text;
}

/**
 * A grade text size as a write path stores it: null follows the company
 * setting, otherwise a whole number of pixels in range. Anything else is
 * refused with a validation key, so a hand-built request cannot store a size
 * the sheet cannot print.
 */
export function cleanGradeSize(value: number | null | undefined): { value: number | null } | { errorKey: MessageKey } {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { errorKey: 'validation.noteGradeSize.invalid' };
  const size = Math.round(value);
  if (size < NOTE_GRADE_SIZE_MIN || size > NOTE_GRADE_SIZE_MAX) {
    return { errorKey: 'validation.noteGradeSize.invalid' };
  }
  return { value: size };
}

/** What a note is printed from: a pending order (a lead) or a final order. */
export type NoteSource = 'lead' | 'order';

/**
 * The fields `buildOrderNote` reads. An `Order` and a `Lead` both satisfy it; a
 * missing `weightSource` or override means the computed weight, which is all a
 * lead has.
 */
export type NoteRecord = Pick<Order, 'items' | 'totalWeightKg'> &
  Partial<Pick<Order, 'weightSource' | 'totalWeightKgOverride'>>;

/** The identity block of a note: which record, and what to call it ("Pending" or "Final Order No."). */
export interface NoteHeader {
  source: NoteSource;
  id: RecordId;
  /** What is printed as the order number; the record id when there is none yet. */
  number: string | null;
  /** When the lead was created (an order's `leadCreatedAt`). */
  createdAt: IsoTimestamp | null;
}

/** The four party fields the Filling note's header prints. */
export type NotePartyHeader = Pick<Party, 'partyCode' | 'city' | 'phone' | 'gstNumber'>;

/** Everything a note is drawn from, frozen at one moment. */
export interface NoteDocument {
  header: NoteHeader;
  partyName: string;
  party: NotePartyHeader | null;
  /**
   * The dealer code printed in the header: the order's own override when it
   * has one, else the party's `partyCode`. Null prints no dealer line at all.
   */
  dealerCode?: string | null;
  /** The account that created the record, printed at the foot. Null prints nothing. */
  createdByName?: string | null;
  /**
   * The grade's text size in pixels: the order's own override, else the
   * company `notes.gradeSize`, else the sheet's built-in size. Absent is the
   * sheet's own (`--note-grade`).
   */
  gradeSize?: number;
  vehicleNumber: string | null;
  /** The record's notes, printed above the signatures. Absent on jobs frozen before notes were printed. */
  notes?: string | null;
  /**
   * The saved tick boxes (note_columns), or null for all three. The
   * printroom renders from this frozen choice, the live screens from the
   * record own.
   */
  columns?: NoteColumns | null;
  /**
   * Bold, frozen with the rest at send time (the sender's Bold tick, else the
   * company `notes.defaultBold`): strip figures and headings print bold
   * unless this is false. Null on jobs frozen before bold travelled (15x):
   * those print bold, which is what they always did.
   */
  bold?: boolean | null;
  model: OrderNoteModel;
}

/**
 * The number a note prints for a record: its PO number, or null when it has none (the
 * sheet then prints the id). The one place it is decided.
 */
export function noteNumber(record: { id: RecordId; poNumber?: string | null }): string | null {
  return record.poNumber || null;
}

/** Copies of a note one print job may ask for. */
export const NOTE_MAX_COPIES = 50;

/** The copies a field holds as a whole number 1..NOTE_MAX_COPIES: rounded, then pulled into range; not a number is one. */
export function clampNoteCopies(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(NOTE_MAX_COPIES, Math.max(1, Math.round(n))) : 1;
}

/** The vehicle number as the Master holds it: upper-case, letters, digits, spaces and hyphens, one space between parts. */
export function cleanVehicleNumber(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, '')
    .replace(/\s+/g, ' ');
}

/** All in CSS pixels at 96 dpi: one A4 sheet is 794 × 1123. */
export const NOTE_LAYOUT = {
  pageWidth: 794,
  pageHeight: 1123,
  /** Height inside the page padding, less the 8 px the artifact keeps spare. */
  inner: 1076,
  headerFirstFilling: 92,
  headerFirstDispatch: 118,
  headerContFilling: 34,
  headerContDispatch: 108,
  /** The range caption above each half. */
  caption: 16,
  /** Filling note only: its totals strip sits at the foot of every page. */
  footerFilling: 74,
  signature: 62,
  /** Last page only, above the signatures: the record's notes, or two lines to write on. */
  notes: 78,
  /**
   * What the notes block costs above its text, and per line of text (the block is `notes` tall for two lines, or
   * for none, which leaves two lines to write on). Whole notes are printed, never cut: the block grows with the
   * text, up to `notesMaxLines`; a longer note gets pages of its own, `notesPageLines` lines a page.
   */
  notesBase: 34,
  notesLine: 22,
  /** Characters of note per printed line at 17 px across the page, counted low so a line never runs over. */
  notesCharsPerLine: 64,
  notesMaxLines: 14,
  notesPageLines: 36,
  /** A named row whose label takes one or two lines… */
  rowNamed: 32,
  /** …and one that takes three (`namedRowHeight`). */
  rowNamedTall: 44,
  /**
   * Characters of a named label per printed line, as the design counts them. A named row is
   * `rowNamedTall` when the label plus three characters (room for a brand chip) takes more than two
   * lines; the design reserves those three on every row, branded or not.
   */
  namedCharsPerLine: 20,
  namedChipChars: 3,
  columnLabel: 13,
  /**
   * A row of codes under their group's header: code, colour, then pack, grade and quantity. Its floor: a code
   * that wraps past two lines, or a grade set large, makes it taller (`codedRowHeight`) — never cut (owner, 2026-11-20).
   */
  rowCoded: 50,
  /** One more printed line of a wrapping code name. */
  codeLine: 15,
  /** Past this many characters a code's name prints at `codeNameSmall` px rather than 14, so fewer of them wrap. */
  longCodeName: 10,
  codeNameSmall: 11.5,
  /**
   * A code cell's width: three across a half page (the halves split 50/50, owner 2026-11-20: 734 px of content,
   * 22 px from the divider, 10 px between cells), or seven across a codes-only page.
   */
  codeCell: 108,
  codeCellWide: 96,
  /**
   * A row of codes with a caption printed on each: their product, for groups too small to earn a header, or
   * their size, for a headed product whose codes come in more than one size (`noteCellCaption`).
   */
  rowCodedLabelled: 66,
  groupHeader: 26,
  /**
   * Codes side by side on one printed line: three beside the named half, as the owner asked (V7,
   * 2026-10-07). A product's codes run across the line, then down; small products share lines, each cell
   * printing its own product.
   */
  codesPerRow: 3,
  /**
   * The coded half on a page of its own: seven to a line across the page, as the owner's print of the design
   * has it (a cell of 96 px holds its pack, grade and quantity). The owner's print has no group headers; this
   * keeps them (the owner's choice), so a codes-only page holds fewer codes and Typical runs to 6 pages, Long to 14.
   */
  codesPerRowWide: 7,
  /** Columns of such lines the coded half takes: one, beside the named half or across a page of its own. */
  codedColumns: 1,
  codedColumnsWide: 1,
  /**
   * The last page carries the notes and signatures, so the page before it is cut early enough
   * that the last page holds at least this many lines rather than one or two.
   */
  minTailLines: 12,
} as const;

/**
 * A main product with this many codes (or more) gets one header, its codes listed below: any two codes of one
 * product make it a section of its own, whatever their sizes (owner, 2026-10-13). A lone code shares a line.
 */
export const NOTE_GROUP_HEADER_MIN = 2;

export interface NoteLine {
  /** `productId|colour|grade|packaging` — what makes two lines one row. */
  key: string;
  brand: string | null;
  /** Main product and size, e.g. `Duragres Oak Wood 200×1200` — the coded side's group header. */
  product: string;
  /** The main product alone, without its size — what the named side prints. */
  productName: string;
  /** The sub product text: its name, or a legacy numeric variant code on old lines. */
  subProduct: string;
  /** The half it prints on: its line's print-side snapshot, else the Default name rule. */
  side: PrintSide;
  size: string | null;
  colour: string | null;
  grade: string | null;
  packaging: string | null;
  /** Pieces, summed over the merged lines. */
  quantity: number;
  /** Summed line weight; null when any merged line has no weight. */
  weightKg: number | null;
}

export interface NoteGroup {
  product: string;
  lines: NoteLine[];
}

export interface OrderNoteModel {
  named: NoteLine[];
  coded: NoteGroup[];
  itemCount: number;
  totalQuantity: number;
  /** The order's manual override when set, else its computed weight. */
  totalWeightKg: number;
}

/** One slot of a coded column: a group's header, or a line of up to `codesPerRow` codes. */
export type NoteSlot =
  | { kind: 'header'; product: string; continued: boolean }
  | {
      kind: 'row';
      lines: NoteLine[];
      /** Each code prints its own product (`NoteLine.product`): the products are too small for a header. */
      labelled: boolean;
      /** Each code prints its own size: its headed product comes in more than one size. */
      sized: boolean;
      product: string;
      /** The printed height the page planned for this line of codes (`codedRowHeight`). */
      height: number;
    };

export interface NotePage {
  pageNo: number;
  pageCount: number;
  isFirst: boolean;
  isLast: boolean;
  /** One column of named lines, or two when the page has no coded lines. */
  left: NoteLine[][];
  right: NoteSlot[][];
  leftFrom: number;
  leftCount: number;
  rightFrom: number;
  rightCount: number;
  wideLeft: boolean;
  wideRight: boolean;
  quantity: number;
  weightKg: number;
  /** Carried forward: everything up to and including this page. */
  runQuantity: number;
  runWeightKg: number;
  /**
   * The block of notes this page carries, as tall as its text needs (0: none). The last page has one, blank
   * lines to write on when the record has no notes; a long note also fills pages of its own after the lines.
   */
  notesHeight: number;
  /** The part of the notes printed on this page. */
  notesText: string;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** How far a page is cut back at a time while it balances the tail (px). */
const TAIL_STEP = 10;

/** Printed lines a note's text takes, counted the same way on every sheet so a page's room is known before it is drawn. */
export function noteTextLines(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed
    .split('\n')
    .reduce((sum, paragraph) => sum + Math.max(1, Math.ceil(paragraph.trim().length / NOTE_LAYOUT.notesCharsPerLine)), 0);
}

/** The note cut into parts of at most `maxLines` lines, at line ends and spaces: nothing is dropped. */
export function splitNoteText(text: string, maxLines: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let used = 0;
  const flush = (): void => {
    if (current.length > 0) parts.push(current.join('\n'));
    current = [];
    used = 0;
  };
  for (const paragraph of text.trim().split('\n')) {
    let rest = paragraph.trim();
    for (;;) {
      const lines = Math.max(1, Math.ceil(rest.length / NOTE_LAYOUT.notesCharsPerLine));
      if (used + lines <= maxLines) {
        current.push(rest);
        used += lines;
        break;
      }
      const room = maxLines - used;
      if (room <= 0) {
        flush();
        continue;
      }
      let cut = room * NOTE_LAYOUT.notesCharsPerLine;
      const space = rest.lastIndexOf(' ', cut);
      if (space > cut / 2) cut = space;
      current.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
      flush();
      if (rest === '') break;
    }
  }
  flush();
  return parts;
}

/** The block of notes for `lines` lines of text: the blank block for none, never shorter than for two. */
export function notesBlockHeight(lines: number): number {
  return NOTE_LAYOUT.notesBase + NOTE_LAYOUT.notesLine * Math.max(2, lines);
}

/** A quantity or weight as the sheets print it: Indian digit grouping, one decimal at most. */
export function noteFigure(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 1 });
}

/**
 * Fixed month names: `toLocaleString` abbreviates September as "Sept" in current Chromium, and the
 * design (and every other month) is three letters.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A moment as the sheets print it, `19 Sep 2026 · 09:41`, in the clock of the machine that prints. */
export function noteStamp(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} · ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The caption's range, `1–28 / 46`, or a dash when the page holds none. */
export function noteRange(from: number, count: number, all: number): string {
  return count > 0 ? `${from + 1}–${from + count} / ${all}` : '—';
}

/** A brand as its two-letter chip: the first two letters or digits of its name. */
export function noteBrandCode(brand: string): string {
  return brand.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
}

/**
 * What the named half prints for a line: the sub product alone.
 *
 * The size used to ride behind it (`9", L-27, B-14, H-25`), which wrapped a
 * row onto two lines and moved the columns beside it. The owner took it off the
 * sheet (2026-11-18): a note is a picking list, and the size is read on the
 * screen it is printed from.
 */
export function namedLabel(line: NoteLine): string {
  return line.subProduct;
}

/** A named row's height: taller when its label (and room for a brand chip) wraps past two lines. */
export function namedRowHeight(line: NoteLine): number {
  const chars = namedLabel(line).length + NOTE_LAYOUT.namedChipChars;
  return Math.ceil(chars / NOTE_LAYOUT.namedCharsPerLine) > 2 ? NOTE_LAYOUT.rowNamedTall : NOTE_LAYOUT.rowNamed;
}

/** The coded side's group header: the main product alone — the size came off the sheet (2026-11-18). */
function productLabel(line: LineItem): string {
  return line.categoryName?.trim() || line.productName;
}

function compareLines(a: NoteLine, b: NoteLine): number {
  return (
    collator.compare(a.brand ?? '', b.brand ?? '') ||
    collator.compare(a.product, b.product) ||
    collator.compare(a.subProduct, b.subProduct) ||
    collator.compare(a.colour ?? '', b.colour ?? '')
  );
}

/** A grade as two lines compare it: case and spaces aside, none is its own grade. */
function gradeKey(line: NoteLine | undefined): string {
  return (line?.grade ?? '').trim().toUpperCase();
}

/**
 * Where a grade sorts: its place in the company's Grade list (`line.grade`, in the list's own order — UT, S.UT,
 * REJ, FOURTH, BHANGAR), matched without regard to case or spaces. A grade the list does not hold, and a line
 * with none, sort after every listed grade.
 */
export function gradeRank(grade: string | null | undefined, gradeOrder: readonly string[]): number {
  const wanted = (grade ?? '').trim().toUpperCase();
  const at = wanted === '' ? -1 : gradeOrder.findIndex((value) => value.trim().toUpperCase() === wanted);
  return at === -1 ? gradeOrder.length : at;
}

/**
 * Merges lines that the store fills as one (same sub product, colour, grade and
 * packaging), splits them by each line's resolved print side — its frozen
 * snapshot, or the Default name rule on a line from before the setting — and
 * sorts each half.
 */
export function buildOrderNote(
  order: NoteRecord,
  /** The list's label for a stored colour value (`colourLabeller`); the value when absent. */
  labelOf: ColourLabelOf = (colour) => colour,
  /** The company's Grade list values in the list's order (`gradeRank`); empty sorts by name alone. */
  gradeOrder: readonly string[] = [],
): OrderNoteModel {
  const merged = new Map<string, NoteLine>();

  for (const line of order.items) {
    const key = [
      line.productId,
      // Null on every new line; on legacy lines it keeps two coded variants
      // of one sub product from merging into a row that shows one code.
      line.variantId ?? '',
      line.colour ?? line.variantLabel ?? '',
      line.grade ?? '',
      line.packaging ?? '',
    ].join('|');
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += line.quantity;
      existing.weightKg =
        existing.weightKg === null || line.lineWeightKg === null
          ? null
          : existing.weightKg + line.lineWeightKg;
      continue;
    }
    // Legacy lines only: a numeric VARIANT code (1501 on 18X14 VITROSA SET)
    // printed as a code on the right half under its sub product heading, like
    // a numeric sub product name does: the cell shows the code, the header
    // its parent. A line with a print-side snapshot never takes this path —
    // its own code is the sub product's software code, not a printed name.
    const subName = line.productName.trim();
    const code = line.code?.trim() ?? '';
    const category = line.categoryName?.trim() || '';
    const codedByCode =
      line.printSide == null && code !== '' && !isNumericSubProduct(subName) && isNumericSubProduct(code);
    merged.set(key, {
      key,
      brand: line.brandName,
      product: productLabel(line),
      productName: codedByCode ? (category === '' ? subName : `${category} — ${subName}`) : (category || subName),
      subProduct: codedByCode ? code : subName,
      side: codedByCode ? 'right' : (line.printSide ?? printSideOf(subName, 'default')),
      size: line.size?.trim() || null,
      // Through `shownColour`, as every other colour that prints: a colour that
      // only repeats the sub product's name ("Ivory" on "IVORY BASIN") is not
      // printed beside it a second time. Then the list's current label.
      colour: noteColour(line.colour ?? line.variantLabel, line.productName, labelOf),
      grade: line.grade,
      packaging: line.packaging,
      quantity: line.quantity,
      weightKg: line.lineWeightKg,
    });
  }

  // By grade first, as the owner asked (2026-11-20): the named half lists every UT line, then every S.UT, and so
  // on, each grade in name order. The coded half keeps its products in name order (the grouping below takes
  // them as they come) and lists each product's codes by grade, then name.
  const rank = (line: NoteLine): number => gradeRank(line.grade, gradeOrder);
  const lines = [...merged.values()].sort(
    (a, b) =>
      collator.compare(a.brand ?? '', b.brand ?? '') ||
      collator.compare(a.productName, b.productName) ||
      rank(a) - rank(b) ||
      compareLines(a, b),
  );
  const named = lines
    .filter((line) => line.side === 'left')
    .sort((a, b) => rank(a) - rank(b) || compareLines(a, b));

  const coded: NoteGroup[] = [];
  const byGroup = new Map<string, NoteGroup>();
  for (const line of lines) {
    if (line.side !== 'right') continue;
    // One section per main product, whatever the size: a product's sizes print under one header, each code
    // captioned with its size (`noteCellCaption`).
    const groupKey = `${line.brand ?? ''}|${line.productName}`;
    let group = byGroup.get(groupKey);
    if (!group) {
      group = { product: line.productName, lines: [] };
      byGroup.set(groupKey, group);
      coded.push(group);
    }
    group.lines.push(line);
  }

  // Sections first, then the lone codes in one run, so they share full lines instead of sitting between sections.
  const sectioned = coded.filter((group) => group.lines.length >= NOTE_GROUP_HEADER_MIN);
  const lone = coded.filter((group) => group.lines.length < NOTE_GROUP_HEADER_MIN);

  return {
    named,
    coded: [...sectioned, ...lone],
    itemCount: lines.length,
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    totalWeightKg:
      order.weightSource === 'manual' && typeof order.totalWeightKgOverride === 'number'
        ? order.totalWeightKgOverride
        : order.totalWeightKg,
  };
}

/** The identity block of a note for a lead (pending order) or a final order. */
export function noteHeader(record: Lead | Order, source: NoteSource): NoteHeader {
  const createdAt =
    source === 'lead' ? (record as Lead).createdAt : ((record as Order).leadCreatedAt ?? null);
  return { source, id: record.id, number: noteNumber(record), createdAt };
}

function noteColour(
  stored: string | null | undefined,
  subProduct: string,
  labelOf: ColourLabelOf,
): string | null {
  const shown = shownColour(stored, subProduct);
  return shown === null ? null : labelOf(shown);
}

/** Builds the document a note is drawn from, for a lead (pending order) or a final order. */
export function noteDocument(
  record: Lead | Order,
  source: NoteSource,
  party: Party | null,
  vehicleNumber: string | null,
  labelOf: ColourLabelOf = (colour) => colour,
  /** The sender's Bold tick; the printroom sheet prints exactly this. */
  bold?: boolean | null,
  /**
   * The company's grade text size (`notes.gradeSize`). The record's own
   * `noteGradeSize` still wins over it.
   */
  gradeSize?: number,
  /** The Grade list's values in order, for the grade-first sort (`buildOrderNote`). */
  gradeOrder: readonly string[] = [],
): NoteDocument {
  return {
    header: noteHeader(record, source),
    partyName: record.partyName,
    party: party
      ? { partyCode: party.partyCode, city: party.city, phone: party.phone, gstNumber: party.gstNumber }
      : null,
    // The order's own override wins; else the party's code, as before. A record
    // that is not a Lead/Order (a test double) simply has neither.
    dealerCode: (record as { dealerCode?: string | null }).dealerCode ?? party?.partyCode ?? null,
    createdByName: (record as { createdByName?: string | null }).createdByName ?? null,
    gradeSize: (record as { noteGradeSize?: number | null }).noteGradeSize ?? gradeSize,
    vehicleNumber,
    notes: record.notes ?? null,
    columns: parseNoteColumns(record.noteColumns ?? null),
    bold: bold ?? null,
    model: buildOrderNote(record, labelOf, gradeOrder),
  };
}

interface Cursor {
  group: number;
  line: number;
}

interface Filled {
  columns: NoteSlot[][];
  next: Cursor;
  placed: number;
}

/**
 * Fills up to `columnCount` columns of height `height` top-down, from `start`.
 *
 * A group opens with a header row and never leaves that header alone at a
 * column's foot; a group that runs into the next column repeats its header,
 * marked `continued`.
 */
function fillColumns(
  groups: readonly NoteGroup[],
  start: Cursor,
  columnCount: number,
  height: number,
  codesPerRow: number,
  /** Sizes a line of codes from its cells (`codedRowHeight`, bound to the note's kind, cell width and grade size). */
  rowHeight: (lines: readonly NoteLine[], captioned: boolean) => number,
): Filled {
  const { groupHeader } = NOTE_LAYOUT;
  const columns: NoteSlot[][] = [];
  let column: NoteSlot[] = [];
  let used = 0;
  let placed = 0;
  let { group, line } = start;
  // Every column opens with a header — a repeat, marked `continued`, when the
  // group started earlier.
  let needHeader = true;

  const closeColumn = (): boolean => {
    columns.push(column);
    column = [];
    used = 0;
    return columns.length < columnCount;
  };

  while (group < groups.length) {
    const current = groups[group] as NoteGroup;
    const headed = current.lines.length >= NOTE_GROUP_HEADER_MIN;
    const withHeader = needHeader && headed;
    const sized = headed && new Set(current.lines.map((l) => l.size ?? '')).size > 1;

    // A headed product fills its own lines. Products too small for a header share them, so a line is
    // never a lone code with two empty places beside it. Chosen first: the line's height depends on its codes.
    const lines: NoteLine[] = [];
    let g = group;
    let l = line;
    while (lines.length < codesPerRow && g < groups.length && (g === group || (!headed && groups[g]!.lines.length < NOTE_GROUP_HEADER_MIN))) {
      let taken = (groups[g] as NoteGroup).lines.slice(l, l + codesPerRow - lines.length);
      // Inside a headed product each grade starts a line of its own (owner, 2026-11-20): UT codes, then a new
      // line for S.UT, and so on. The lines arrive grade-sorted, so the run ends at the first other grade.
      if (headed) {
        const first = gradeKey(taken[0]);
        const end = taken.findIndex((code) => gradeKey(code) !== first);
        if (end > 0) taken = taken.slice(0, end);
      }
      lines.push(...taken);
      l += taken.length;
      if (l < (groups[g] as NoteGroup).lines.length) break;
      g += 1;
      l = 0;
    }
    const rowH = rowHeight(lines, !headed || sized);
    const cost = (withHeader ? groupHeader : 0) + rowH;

    if (used + cost > height) {
      if (column.length === 0) break; // height below one row: cannot happen, never loop
      if (!closeColumn()) return { columns, next: { group, line }, placed };
      needHeader = true;
      continue;
    }

    if (withHeader) {
      column.push({ kind: 'header', product: current.product, continued: line > 0 });
    }
    needHeader = false;
    column.push({ kind: 'row', lines, labelled: !headed, sized, product: current.product, height: rowH });
    used += cost;
    placed += lines.length;
    group = g;
    line = l;
    if (line === 0) needHeader = true;
  }

  if (column.length > 0) columns.push(column);
  return { columns, next: { group, line }, placed };
}

/**
 * What a code cell prints above its code: its product, or nothing (`NoteSlot.labelled`).
 *
 * `slot.sized` used to print the size here, which is what the owner struck off
 * the sheet (2026-11-18) — a "9\", L-27, B-14, H-25" over every code in a
 * product that came in several sizes. The note no longer captions by size at
 * all; a sized group still gets the taller row, so the line the size used to
 * take is breathing room rather than a wrap.
 */
export function noteCellCaption(slot: Extract<NoteSlot, { kind: 'row' }>, line: NoteLine): string | null {
  return slot.labelled ? line.product : null;
}

/** A line of codes' printed height, as the page planned it (`codedRowHeight`). */
export function noteCodedRowHeight(slot: Extract<NoteSlot, { kind: 'row' }>): number {
  return slot.height;
}

/** The px size a code's name prints at: smaller past `longCodeName` characters. */
export function noteCodeNameSize(subProduct: string): number {
  return subProduct.length > NOTE_LAYOUT.longCodeName ? NOTE_LAYOUT.codeNameSmall : 14;
}

// Average glyph width per px of type, for each face a code cell prints. Set wide on purpose: a row planned a
// line too tall prints some white space, one planned too short would push the page's last rows off the sheet.
const GLYPH = { name: 0.68, colour: 0.62, brand: 0.72 } as const;

/**
 * How many lines a code cell's first line takes at `cellWidth`: its name word by word, then (Dispatch) its
 * colour and brand, wrapped the way the sheet's inline text wraps.
 */
export function codeCellLines(line: NoteLine, kind: NoteKind, cellWidth: number): number {
  const nameSize = kind === 'dispatch' ? noteCodeNameSize(line.subProduct) : 14;
  const words: { width: number; space: number }[] = line.subProduct
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ width: word.length * nameSize * GLYPH.name, space: nameSize * 0.3 }));
  if (kind === 'dispatch') {
    for (const word of (line.colour ?? '—').split(/\s+/).filter(Boolean)) {
      words.push({ width: word.length * 10 * GLYPH.colour, space: 4 });
    }
  }
  const brand = line.brand ? noteBrandCode(line.brand) : '';
  if (brand) words.push({ width: brand.length * 7.5 * GLYPH.brand, space: 4 });

  let lines = 1;
  let used = 0;
  for (const word of words) {
    if (used > 0 && used + word.space + word.width > cellWidth) {
      lines += 1;
      used = 0;
    }
    if (word.width > cellWidth) {
      // One word wider than the cell breaks anywhere inside it (`overflow-wrap: anywhere`).
      lines += Math.ceil(word.width / cellWidth) - 1;
      used = word.width % cellWidth;
    } else {
      used += (used > 0 ? word.space : 0) + word.width;
    }
  }
  return lines;
}

/**
 * A line of codes' printed height: the floor (taller with a caption), plus a line for each one the longest
 * name wraps past what the floor holds — two on the Dispatch note, one on the Filling note, whose colour has a
 * line of its own — plus whatever a grade set larger than the quantity beside it adds to the detail line.
 */
export function codedRowHeight(
  lines: readonly NoteLine[],
  captioned: boolean,
  kind: NoteKind,
  cellWidth: number,
  gradeSize: number,
): number {
  const L = NOTE_LAYOUT;
  const floor = captioned ? L.rowCodedLabelled : L.rowCoded;
  const held = kind === 'dispatch' ? 2 : 1;
  const most = Math.max(1, ...lines.map((line) => codeCellLines(line, kind, cellWidth)));
  const gradeExtra = Math.max(0, Math.ceil(gradeSize * 1.3 + 2) - 18);
  return floor + Math.max(0, most - held) * L.codeLine + gradeExtra;
}

function codedCount(groups: readonly NoteGroup[]): number {
  return groups.reduce((sum, group) => sum + group.lines.length, 0);
}

function sumOf(lines: readonly NoteLine[]): { quantity: number; weightKg: number } {
  return lines.reduce(
    (total, line) => ({
      quantity: total.quantity + line.quantity,
      weightKg: total.weightKg + (line.weightKg ?? 0),
    }),
    { quantity: 0, weightKg: 0 },
  );
}

/**
 * The named lines from `start` that fit `height`, by each row's own height: one
 * column, or two side by side when `wide`, split about evenly.
 */
function fillNamed(lines: readonly NoteLine[], start: number, wide: boolean, height: number): NoteLine[][] {
  const budget = height - NOTE_LAYOUT.columnLabel;
  const columns: NoteLine[][] = [[]];
  let used = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] as NoteLine;
    const rowHeight = namedRowHeight(line);
    if (used > 0 && used + rowHeight > budget) {
      if (!wide || columns.length === 2) break;
      columns.push([]);
      used = 0;
    }
    (columns[columns.length - 1] as NoteLine[]).push(line);
    used += rowHeight;
  }
  if (!wide) return columns;

  // Two columns: the first takes about half the height, unless that overfills either.
  const taken = columns.flat();
  if (taken.length < 2) return [taken];
  const total = taken.reduce((sum, line) => sum + namedRowHeight(line), 0);
  let split = 0;
  let first = 0;
  while (split < taken.length && first < total / 2) {
    first += namedRowHeight(taken[split] as NoteLine);
    split += 1;
  }
  return first <= budget && total - first <= budget ? [taken.slice(0, split), taken.slice(split)] : columns;
}

/**
 * Cuts the note into A4 pages. Page one takes the full (Filling) or slim
 * (Dispatch) header, the last page reserves the notes and signature rows, and a page with
 * no coded lines gives the named half the full width in two columns — as one
 * with no named lines gives the coded half two columns.
 */
export function paginateOrderNote(
  model: OrderNoteModel,
  kind: NoteKind,
  /**
   * `signatures: false` leaves the signature row's room to the lines: a document with none to sign. `notes`
   * is the record's notes: the last page makes room for all of them, and a note too long for that gets pages of
   * its own.
   */
  options: { signatures?: boolean; notes?: string | null; gradeSize?: number } = {},
): NotePage[] {
  const L = NOTE_LAYOUT;
  const filling = kind === 'filling';
  const totalCoded = codedCount(model.coded);
  const noteText = options.notes?.trim() ?? '';
  const noteLines = noteTextLines(noteText);
  // A note that fits beside the last lines goes under them; a longer one gets pages after them.
  const inlineNotes = noteLines <= L.notesMaxLines;
  const lastNotesHeight = inlineNotes ? notesBlockHeight(noteLines) : 0;

  type Draft = Omit<NotePage, 'pageNo' | 'pageCount' | 'isLast' | 'runQuantity' | 'runWeightKg' | 'notesHeight' | 'notesText'>;
  const pages: Draft[] = [];
  let namedAt = 0;
  let codedAt: Cursor = { group: 0, line: 0 };
  let codedDone = 0;

  for (;;) {
    const first = pages.length === 0;
    const remainingNamed = model.named.length - namedAt;
    const remainingCoded = totalCoded - codedDone;
    if (pages.length > 0 && remainingNamed <= 0 && remainingCoded <= 0) break;

    const wideLeft = remainingCoded === 0;
    const wideRight = remainingNamed === 0;
    const columnCount = wideRight ? L.codedColumnsWide : L.codedColumns;
    const perRow = wideRight ? L.codesPerRowWide : L.codesPerRow;
    const cellWidth = wideRight ? L.codeCellWide : L.codeCell;
    const rowHeight = (lines: readonly NoteLine[], captioned: boolean): number =>
      // Absent: no extra height (a grade adds some only from 13 px up).
      codedRowHeight(lines, captioned, kind, cellWidth, options.gradeSize ?? 0);

    const height = (isLast: boolean): number =>
      L.inner -
      8 -
      (first ? (filling ? L.headerFirstFilling : L.headerFirstDispatch) : filling ? L.headerContFilling : L.headerContDispatch) -
      L.caption -
      (filling ? L.footerFilling : 0) -
      (isLast ? lastNotesHeight + (inlineNotes && options.signatures !== false ? L.signature : 0) : 0);
    const leftRows = (h: number): number => fillNamed(model.named, namedAt, wideLeft, h).flat().length;

    // Would the rest of the note fit on this page with the notes and signatures on it?
    const lastHeight = height(true);
    const probe = fillColumns(model.coded, codedAt, columnCount, lastHeight, perRow, rowHeight);
    const fitsLast = remainingNamed <= leftRows(lastHeight) && remainingCoded - probe.placed <= 0;
    // The rest fitting only without the notes and signatures is not a last page: cut it
    // at the last-page height so a page follows to carry the remainder and the
    // signatures, rather than printing them over the final rows.
    const fullHeight = height(false);
    const fullProbe = fillColumns(model.coded, codedAt, columnCount, fullHeight, perRow, rowHeight);
    const fitsFull = remainingNamed <= leftRows(fullHeight) && remainingCoded - fullProbe.placed <= 0;
    let h = fitsLast || fitsFull ? lastHeight : fullHeight;

    // A page that is not the last must leave the last one a fair share, not one or two lines: the
    // notes and signatures need a page of their own only if the lines run out exactly at the foot.
    // Cut it a little earlier until the tail it leaves is at least `minTailLines`.
    if (!fitsLast) {
      const placedAt = (height: number): number =>
        leftRows(height) + fillColumns(model.coded, codedAt, columnCount, height, perRow, rowHeight).placed;
      const remaining = remainingNamed + remainingCoded;
      const floor = Math.floor(fullHeight / 2);
      let tail = remaining - placedAt(h);
      while (tail > 0 && tail < L.minTailLines && h - TAIL_STEP >= floor) {
        h -= TAIL_STEP;
        tail = remaining - placedAt(h);
      }
    }

    const left = fillNamed(model.named, namedAt, wideLeft, h);
    const namedSlice = left.flat();
    const filled = fillColumns(model.coded, codedAt, columnCount, h, perRow, rowHeight);

    const cells = filled.columns.flat().flatMap((slot) => (slot.kind === 'row' ? slot.lines : []));
    const totals = sumOf([...namedSlice, ...cells]);

    pages.push({
      isFirst: first,
      left,
      right: filled.columns,
      leftFrom: namedAt,
      leftCount: namedSlice.length,
      rightFrom: codedDone,
      rightCount: filled.placed,
      wideLeft,
      wideRight,
      quantity: totals.quantity,
      weightKg: totals.weightKg,
    });

    namedAt += namedSlice.length;
    codedAt = filled.next;
    codedDone += filled.placed;
    if (namedAt >= model.named.length && codedDone >= totalCoded) break;
  }

  // An order with no lines still prints one page.
  if (pages.length === 0) {
    pages.push({
      isFirst: true, left: [[]], right: [], leftFrom: 0, leftCount: 0, rightFrom: 0, rightCount: 0,
      wideLeft: true, wideRight: true, quantity: 0, weightKg: 0,
    });
  }

  // The notes of each page: all of them under the last lines, or, for a long note, pages of their own.
  const noteParts = inlineNotes ? [noteText] : splitNoteText(noteText, L.notesPageLines);
  const withNotes = inlineNotes ? 1 : noteParts.length;
  if (!inlineNotes) {
    for (let part = 0; part < noteParts.length; part += 1) {
      pages.push({
        isFirst: false, left: [[]], right: [], leftFrom: model.named.length, leftCount: 0,
        rightFrom: totalCoded, rightCount: 0, wideLeft: true, wideRight: true, quantity: 0, weightKg: 0,
      });
    }
  }
  const firstWithNotes = pages.length - withNotes;

  let runQuantity = 0;
  let runWeightKg = 0;
  return pages.map((page, index) => {
    runQuantity += page.quantity;
    runWeightKg += page.weightKg;
    const part = index - firstWithNotes;
    const text = part >= 0 ? (noteParts[part] ?? '') : '';
    return {
      ...page,
      pageNo: index + 1,
      pageCount: pages.length,
      isLast: index === pages.length - 1,
      runQuantity,
      runWeightKg,
      notesHeight: part >= 0 ? notesBlockHeight(noteTextLines(text)) : 0,
      notesText: text,
    };
  });
}
