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

import { isNumericSubProduct, shownColour, type ColourLabelOf } from './colour-rule.js';
import type { IsoTimestamp, Lead, LineItem, Order, Party, RecordId } from './entities.js';

export type NoteKind = 'filling' | 'dispatch';

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
  vehicleNumber: string | null;
  /** The record's notes, printed above the signatures. Absent on jobs frozen before notes were printed. */
  notes?: string | null;
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
  /** A named row whose label takes one or two lines… */
  rowNamed: 32,
  /** …and one that takes three (`namedRowHeight`). */
  rowNamedTall: 44,
  /**
   * Characters of a named label per printed line, as the design counts them. A named row is
   * `rowNamedTall` when the label plus three characters (room for a brand chip) takes more than two
   * lines; the design reserves those three on every row, branded or not.
   */
  namedCharsPerLine: 26,
  namedChipChars: 3,
  columnLabel: 13,
  /** A row of codes under their group's header. */
  rowCoded: 50,
  /** A row of codes with their product printed on each — groups too small to earn a header. */
  rowCodedLabelled: 62,
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

/** A product with this many codes (or more) gets one header, its codes listed below. */
export const NOTE_GROUP_HEADER_MIN = 3;

export interface NoteLine {
  /** `variantId|colour|grade|packaging` — what makes two lines one row. */
  key: string;
  brand: string | null;
  /** Main product and size, e.g. `Duragres Oak Wood 200×1200` — the coded side's group header. */
  product: string;
  /** The main product alone, without its size — what the named side prints. */
  productName: string;
  /** The sub product: a name on the left half, a code on the right. */
  subProduct: string;
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
      product: string;
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
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** How far a page is cut back at a time while it balances the tail (px). */
const TAIL_STEP = 10;

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

const PACK_CODES: Record<string, string> = { box: 'BOX', grass: 'GRS', paper: 'PPR' };

/** A packaging as the coded cell's three-letter chip. */
export function notePackCode(packaging: string): string {
  return PACK_CODES[packaging.trim().toLowerCase()] ?? packaging.trim().slice(0, 3).toUpperCase();
}

/** What the named half prints for a line: the sub product, and its size when the name does not carry it already. */
export function namedLabel(line: NoteLine): string {
  return line.size && !line.subProduct.includes(line.size) ? `${line.subProduct} ${line.size}` : line.subProduct;
}

/** A named row's height: taller when its label (and room for a brand chip) wraps past two lines. */
export function namedRowHeight(line: NoteLine): number {
  const chars = namedLabel(line).length + NOTE_LAYOUT.namedChipChars;
  return Math.ceil(chars / NOTE_LAYOUT.namedCharsPerLine) > 2 ? NOTE_LAYOUT.rowNamedTall : NOTE_LAYOUT.rowNamed;
}

function productLabel(line: LineItem): string {
  const label = [line.categoryName, line.size].filter(Boolean).join(' ').trim();
  return label || line.productName;
}

function compareLines(a: NoteLine, b: NoteLine): number {
  return (
    collator.compare(a.brand ?? '', b.brand ?? '') ||
    collator.compare(a.product, b.product) ||
    collator.compare(a.subProduct, b.subProduct) ||
    collator.compare(a.colour ?? '', b.colour ?? '')
  );
}

/**
 * Merges lines that the store fills as one (same sub product, colour, grade and
 * packaging), splits them by `isNumericSubProduct` — the only test of named
 * against coded — and sorts each half.
 */
export function buildOrderNote(
  order: NoteRecord,
  /** The list's label for a stored colour value (`colourLabeller`); the value when absent. */
  labelOf: ColourLabelOf = (colour) => colour,
): OrderNoteModel {
  const merged = new Map<string, NoteLine>();

  for (const line of order.items) {
    const key = [line.variantId, line.colour ?? '', line.grade ?? '', line.packaging ?? ''].join('|');
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += line.quantity;
      existing.weightKg =
        existing.weightKg === null || line.lineWeightKg === null
          ? null
          : existing.weightKg + line.lineWeightKg;
      continue;
    }
    merged.set(key, {
      key,
      brand: line.brandName,
      product: productLabel(line),
      productName: line.categoryName?.trim() || line.productName,
      subProduct: line.productName.trim(),
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

  const lines = [...merged.values()].sort(compareLines);
  const named = lines.filter((line) => !isNumericSubProduct(line.subProduct));

  const coded: NoteGroup[] = [];
  const byGroup = new Map<string, NoteGroup>();
  for (const line of lines) {
    if (!isNumericSubProduct(line.subProduct)) continue;
    const groupKey = `${line.brand ?? ''}|${line.product}`;
    let group = byGroup.get(groupKey);
    if (!group) {
      group = { product: line.productName, lines: [] };
      byGroup.set(groupKey, group);
      coded.push(group);
    }
    group.lines.push(line);
  }

  return {
    named,
    coded,
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
): NoteDocument {
  return {
    header: noteHeader(record, source),
    partyName: record.partyName,
    party: party
      ? { partyCode: party.partyCode, city: party.city, phone: party.phone, gstNumber: party.gstNumber }
      : null,
    vehicleNumber,
    notes: record.notes ?? null,
    model: buildOrderNote(record, labelOf),
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
): Filled {
  const { groupHeader, rowCoded, rowCodedLabelled } = NOTE_LAYOUT;
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
    const cost = (withHeader ? groupHeader : 0) + (headed ? rowCoded : rowCodedLabelled);

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
    // A headed product fills its own lines. Products too small for a header share them, so a line is
    // never a lone code with two empty places beside it.
    const lines: NoteLine[] = [];
    let g = group;
    let l = line;
    while (lines.length < codesPerRow && g < groups.length && (g === group || (!headed && groups[g]!.lines.length < NOTE_GROUP_HEADER_MIN))) {
      const taken = (groups[g] as NoteGroup).lines.slice(l, l + codesPerRow - lines.length);
      lines.push(...taken);
      l += taken.length;
      if (l < (groups[g] as NoteGroup).lines.length) break;
      g += 1;
      l = 0;
    }
    column.push({ kind: 'row', lines, labelled: !headed, product: current.product });
    used += cost;
    placed += lines.length;
    group = g;
    line = l;
    if (line === 0) needHeader = true;
  }

  if (column.length > 0) columns.push(column);
  return { columns, next: { group, line }, placed };
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
  /** `signatures: false` leaves the signature row's room to the lines: a document with none to sign. */
  options: { signatures?: boolean } = {},
): NotePage[] {
  const L = NOTE_LAYOUT;
  const filling = kind === 'filling';
  const totalCoded = codedCount(model.coded);

  const pages: Omit<NotePage, 'pageNo' | 'pageCount' | 'isLast' | 'runQuantity' | 'runWeightKg'>[] = [];
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

    const height = (isLast: boolean): number =>
      L.inner -
      8 -
      (first ? (filling ? L.headerFirstFilling : L.headerFirstDispatch) : filling ? L.headerContFilling : L.headerContDispatch) -
      L.caption -
      (filling ? L.footerFilling : 0) -
      (isLast ? L.notes + (options.signatures === false ? 0 : L.signature) : 0);
    const leftRows = (h: number): number => fillNamed(model.named, namedAt, wideLeft, h).flat().length;

    // Would the rest of the note fit on this page with the notes and signatures on it?
    const lastHeight = height(true);
    const probe = fillColumns(model.coded, codedAt, columnCount, lastHeight, perRow);
    const fitsLast = remainingNamed <= leftRows(lastHeight) && remainingCoded - probe.placed <= 0;
    // The rest fitting only without the notes and signatures is not a last page: cut it
    // at the last-page height so a page follows to carry the remainder and the
    // signatures, rather than printing them over the final rows.
    const fullHeight = height(false);
    const fullProbe = fillColumns(model.coded, codedAt, columnCount, fullHeight, perRow);
    const fitsFull = remainingNamed <= leftRows(fullHeight) && remainingCoded - fullProbe.placed <= 0;
    let h = fitsLast || fitsFull ? lastHeight : fullHeight;

    // A page that is not the last must leave the last one a fair share, not one or two lines: the
    // notes and signatures need a page of their own only if the lines run out exactly at the foot.
    // Cut it a little earlier until the tail it leaves is at least `minTailLines`.
    if (!fitsLast) {
      const placedAt = (height: number): number =>
        leftRows(height) + fillColumns(model.coded, codedAt, columnCount, height, perRow).placed;
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
    const filled = fillColumns(model.coded, codedAt, columnCount, h, perRow);

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

  let runQuantity = 0;
  let runWeightKg = 0;
  return pages.map((page, index) => {
    runQuantity += page.quantity;
    runWeightKg += page.weightKg;
    return {
      ...page,
      pageNo: index + 1,
      pageCount: pages.length,
      isLast: index === pages.length - 1,
      runQuantity,
      runWeightKg,
    };
  });
}
