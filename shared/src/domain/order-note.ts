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

import { isNumericSubProduct } from './colour-rule.js';
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
  model: OrderNoteModel;
}

/**
 * The number a note prints for a record. The one place it is decided: until the
 * pending-order numbering lands it is the record's id.
 */
export function noteNumber(record: { id: RecordId }): string {
  return record.id;
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
  rowNamed: 40,
  columnLabel: 13,
  /** A row of codes under their group's header. */
  rowCoded: 46,
  /** A row of codes with their product printed on each — groups too small to earn a header. */
  rowCodedLabelled: 58,
  groupHeader: 26,
  /** Codes side by side in a row. */
  codesPerRow: 3,
  /** Columns the coded half takes: one beside the named half, two when it has the page. */
  codedColumns: 1,
  codedColumnsWide: 2,
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

/** One slot of a coded column: a group's header, or a row of up to three codes. */
export type NoteSlot =
  | { kind: 'header'; product: string; continued: boolean }
  | {
      kind: 'row';
      lines: NoteLine[];
      /** Each code prints its own product: the group is too small for a header. */
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
export function buildOrderNote(order: NoteRecord): OrderNoteModel {
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
      colour: line.colour ?? line.variantLabel,
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

/** Builds the document a note is drawn from, for a lead (pending order) or a final order. */
export function noteDocument(
  record: Lead | Order,
  source: NoteSource,
  party: Party | null,
  vehicleNumber: string | null,
): NoteDocument {
  return {
    header: noteHeader(record, source),
    partyName: record.partyName,
    party: party
      ? { partyCode: party.partyCode, city: party.city, phone: party.phone, gstNumber: party.gstNumber }
      : null,
    vehicleNumber,
    model: buildOrderNote(record),
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
): Filled {
  const { groupHeader, rowCoded, rowCodedLabelled, codesPerRow } = NOTE_LAYOUT;
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
    const lines = current.lines.slice(line, line + codesPerRow);
    column.push({ kind: 'row', lines, labelled: !headed, product: current.product });
    used += cost;
    placed += lines.length;
    line += lines.length;

    if (line >= current.lines.length) {
      group += 1;
      line = 0;
      needHeader = true;
    }
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
 * Cuts the note into A4 pages. Page one takes the full (Filling) or slim
 * (Dispatch) header, the last page reserves the signature row, and a page with
 * no coded lines gives the named half the full width in two columns — as one
 * with no named lines gives the coded half two columns.
 */
export function paginateOrderNote(
  model: OrderNoteModel,
  kind: NoteKind,
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

    const height = (isLast: boolean): number =>
      L.inner -
      8 -
      (first ? (filling ? L.headerFirstFilling : L.headerFirstDispatch) : filling ? L.headerContFilling : L.headerContDispatch) -
      L.caption -
      (filling ? L.footerFilling : 0) -
      (isLast ? L.signature : 0);
    const leftRows = (h: number): number => {
      const rows = Math.max(1, Math.floor((h - L.columnLabel) / L.rowNamed));
      return wideLeft ? rows * 2 : rows;
    };

    // Would the rest of the note fit on this page with the signature row on it?
    const lastHeight = height(true);
    const probe = fillColumns(model.coded, codedAt, columnCount, lastHeight);
    const fitsLast = remainingNamed <= leftRows(lastHeight) && remainingCoded - probe.placed <= 0;
    // The rest fitting only without the signature row is not a last page: cut it
    // at the last-page height so a page follows to carry the remainder and the
    // signatures, rather than printing them over the final rows.
    const fullHeight = height(false);
    const fullProbe = fillColumns(model.coded, codedAt, columnCount, fullHeight);
    const fitsFull = remainingNamed <= leftRows(fullHeight) && remainingCoded - fullProbe.placed <= 0;
    const h = fitsLast || fitsFull ? lastHeight : fullHeight;

    const take = Math.min(remainingNamed, leftRows(h));
    const namedSlice = model.named.slice(namedAt, namedAt + take);
    const filled = fillColumns(model.coded, codedAt, columnCount, h);

    const half = Math.ceil(namedSlice.length / 2);
    const left = wideLeft && namedSlice.length > 1 ? [namedSlice.slice(0, half), namedSlice.slice(half)] : [namedSlice];
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
