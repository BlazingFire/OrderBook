/**
 * The Filling and Dispatch notes' sheet, drawn as a PDF (V8, 2026-10-07): the pending order PDF has the same
 * content layout as the notes.
 *
 * Two halves, so the layout can be tested without a PDF library:
 *
 *  - `planNotePdf` is pure. It takes the pages `paginateOrderNote` cut (the same pages the React note draws,
 *    so a line is on the same page in the preview, the print and this PDF) and returns, per page, a list of
 *    drawing operations in the note's own pixel space (A4 at 96 dpi, 794 x 1123). Widths come from an injected
 *    `measure`, so the tests use a fake one.
 *  - `renderNotePdf` measures with PDFKit and executes the operations, scaled 0.75 to points.
 *
 * Every number below is the note's CSS (`ui/src/order-note.css`) read in pixels; change a measurement there and
 * here together. The fonts are the vendored faces (Inter, and Source Code Pro in place of IBM Plex Mono, see
 * `fonts.ts`), so a figure is a few percent wider or narrower than on screen and nothing is cut: text that does not
 * fit gets an ellipsis, labels wrap to the same number of lines the pagination reserved room for.
 */

import PDFDocument from 'pdfkit';
import {
  namedLabel,
  namedRowHeight,
  noteBrandCode,
  noteCellCaption,
  noteCodedRowHeight,
  noteFigure,
  noteRange,
  noteStamp,
  NOTE_LAYOUT,
  t,
  type NoteLine,
  type NoteColumns,
  type NotePage,
  type NoteSlot,
} from '@orderbook/shared';

import { registerFonts } from './fonts.js';

export type PdfFont = 'body' | 'bold' | 'mono';

/** Width of `text` in pixels at `size`, with `spacing` extra pixels after each character. */
export type Measure = (text: string, font: PdfFont, size: number, spacing?: number) => number;

export interface TextOp {
  kind: 'text';
  /** Left edge and top of the line box, in px. */
  x: number;
  y: number;
  text: string;
  font: PdfFont;
  size: number;
  colour: string;
  spacing?: number;
}

export interface LineOp {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  colour: string;
  width: number;
  dotted?: boolean;
}

export interface BoxOp {
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
  colour: string;
  width: number;
  radius: number;
  dashed?: boolean;
}

export type PdfOp = TextOp | LineOp | BoxOp;

export interface NotePdfInput {
  /** `Pending order`. */
  title: string;
  /** Printed beside the date, top right: whose software made it. */
  companyName: string;
  printedAt: Date;
  /** The party the order is for, and the line under it (`P0042 · Morbi`). */
  partyName: string;
  partyMeta: string;
  /** The order number, or its id until it has one. */
  numberText: string;
  notes: string;
  pages: NotePage[];
  namedCount: number;
  codedCount: number;
  itemCount: number;
  totalQuantity: number;
  totalWeightKg: number;
  /**
   * The saved tick boxes (note_columns): an unticked column is not drawn.
   * Absent prints all three.
   */
  columns?: NoteColumns;
  /** The company switch (notes.defaultBold): regular faces when false. */
  bold?: boolean;
}

const INK = '#10161a';
const MUTED = '#6e7c84';
const SOFT = '#46535b';
const DOTS = '#aeb7bc';
const RULE = '#d6dbde';
const ROW_TEXT = '#2b353b';
const FAINT = '#8c979d';

const L = NOTE_LAYOUT;
const PAGE_W = L.pageWidth;
const PAGE_H = L.pageHeight;
const PAD_X = 30;
const PAD_TOP = 26;
const PAD_BOTTOM = 20;
const CONTENT_W = PAGE_W - 2 * PAD_X;

/** Natural line-box height of each face, as a multiple of its size. */
const LINE_BOX: Record<PdfFont, number> = { body: 1.21, bold: 1.21, mono: 1.257 };

/** Where the baseline sits below the top of a face's line box, as a multiple of its size: to set mixed sizes on one line. */
const ASCENT: Record<PdfFont, number> = { body: 0.97, bold: 0.97, mono: 0.98 };

/** Where a line of `size` text sits when centred in a CSS box `lineHeight` tall that starts at `top`. */
function centred(top: number, lineHeight: number, size: number, font: PdfFont): number {
  return top + (lineHeight - LINE_BOX[font] * size) / 2;
}

function caps(text: string): string {
  return text.toUpperCase();
}

/** `text` cut to `maxWidth` with an ellipsis. */
function clip(measure: Measure, text: string, font: PdfFont, size: number, maxWidth: number, spacing = 0): string {
  if (measure(text, font, size, spacing) <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && measure(`${text.slice(0, end)}…`, font, size, spacing) > maxWidth) end -= 1;
  return `${text.slice(0, Math.max(end, 1)).trimEnd()}…`;
}

/**
 * Greedy word wrap into at most `maxLines` lines; the last one is clipped with an ellipsis when text is left over.
 * `spacing` is the letter spacing the text will be drawn with: it counts towards the width, so a line never runs
 * past its box.
 */
function wrap(
  measure: Measure,
  text: string,
  font: PdfFont,
  size: number,
  maxWidth: number,
  maxLines: number,
  spacing = 0,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  const push = (value: string): void => {
    lines.push(value);
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, font, size, spacing) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) push(current);
    current = word;
    // A word wider than the line breaks where it must, like `overflow-wrap: anywhere`.
    while (measure(current, font, size, spacing) > maxWidth && current.length > 1) {
      let cut = current.length - 1;
      while (cut > 1 && measure(current.slice(0, cut), font, size, spacing) > maxWidth) cut -= 1;
      push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const rest = lines.slice(maxLines - 1).join(' ');
  kept[maxLines - 1] = clip(measure, rest, font, size, maxWidth, spacing);
  return kept;
}

class Page {
  readonly ops: PdfOp[] = [];

  constructor(private readonly measure: Measure) {}

  text(x: number, y: number, text: string, font: PdfFont, size: number, colour: string, spacing = 0): void {
    if (text !== '') this.ops.push({ kind: 'text', x, y, text, font, size, colour, ...(spacing ? { spacing } : {}) });
  }

  /** Text whose right edge is at `right`. */
  textRight(right: number, y: number, text: string, font: PdfFont, size: number, colour: string, spacing = 0): void {
    this.text(right - this.measure(text, font, size, spacing), y, text, font, size, colour, spacing);
  }

  /** Text centred on `middle`. */
  textCentre(middle: number, y: number, text: string, font: PdfFont, size: number, colour: string, spacing = 0): void {
    this.text(middle - this.measure(text, font, size, spacing) / 2, y, text, font, size, colour, spacing);
  }

  line(x1: number, y1: number, x2: number, y2: number, colour: string, width: number, dotted = false): void {
    this.ops.push({ kind: 'line', x1, y1, x2, y2, colour, width, ...(dotted ? { dotted } : {}) });
  }

  box(x: number, y: number, w: number, h: number, colour: string, width: number, radius: number, dashed = false): void {
    this.ops.push({ kind: 'box', x, y, w, h, colour, width, radius, ...(dashed ? { dashed } : {}) });
  }

  /** An eyebrow: 8.5 px bold capitals, widely spaced. */
  eyebrow(x: number, y: number, text: string): void {
    this.text(x, y, caps(text), 'bold', 8.5, MUTED, 0.85);
  }
}

function eyebrowKey(): number {
  return 8.5 * LINE_BOX.bold;
}

/** A small boxed tag (packaging code, brand code): returns its width. */
function tag(
  page: Page,
  measure: Measure,
  x: number,
  midY: number,
  text: string,
  size: number,
  font: PdfFont,
  spacing: number,
  dashed = false,
  colour = SOFT,
): number {
  const w = measure(text, font, size, spacing) + 4 + (dashed ? 0 : 0);
  const h = 10 + 2;
  page.box(x, midY - h / 2, w + 0, h, colour, 1, 2, dashed);
  page.text(x + 2.5, centred(midY - h / 2, h, size, font), text, font, size, dashed ? MUTED : INK, spacing);
  return w;
}

/** The sheets for one document, as drawing operations. */
export function planNotePdf(input: NotePdfInput, measure: Measure): PdfOp[][] {
  return input.pages.map((pageData) => planPage(input, pageData, measure));
}

function planPage(input: NotePdfInput, data: NotePage, measure: Measure): PdfOp[] {
  const page = new Page(measure);
  const last = data.isLast;
  // Every page carries the order totals, not its own (the preview reads the
  // same figures). Bold swaps the strip and heading faces body<->bold.
  const head: PdfFont = input.bold === false ? 'body' : 'bold';
  const show: NoteColumns = input.columns ?? { packaging: true, grade: true, colour: true };
  const right = PAD_X + CONTENT_W;
  let y = PAD_TOP;

  // ---- Head ---------------------------------------------------------------
  if (data.isFirst) {
    page.text(PAD_X, centred(y, 32, 28, 'bold'), input.title, 'bold', 28, INK, -0.7);
    const printed = `${input.companyName} · ${t('en', 'orderNote.printed')} ${noteStamp(input.printedAt)}`;
    page.textRight(right, centred(y, 32, 10, 'mono') + 2, clip(measure, printed, 'mono', 10, 360, 0.1), 'mono', 10, SOFT, 0.1);
    y += 44;
  } else {
    const title = input.title;
    page.text(PAD_X, centred(y, 18, 14, 'bold'), title, 'bold', 14, INK, -0.2);
    const titleW = measure(title, 'bold', 14, -0.2);
    page.text(
      PAD_X + titleW + 4,
      centred(y, 18, 9.5, 'bold') + 1,
      `· ${caps(t('en', 'orderNote.continued'))}`,
      'bold',
      9.5,
      MUTED,
      0.85,
    );
    y += 34;
  }

  // ---- Strip: the order totals, the party, the number and page ----
  const stripTop = y;
  const pageCellW = 148;
  const gap = 18;
  const flexW = (CONTENT_W - pageCellW - 3 - 6 * gap) / 3;
  const cellX = (index: number): number => PAD_X + index * (flexW + 1 + 2 * gap);
  const figureTop = stripTop + eyebrowKey() + 2;

  const unit = ` ${t('en', 'orderNote.unit')}`;
  const stripFigure = (x: number, w: number, label: string, value: string, suffix: string): void => {
    page.text(x, stripTop, caps(label), head, 8.5, MUTED, 0.85);
    const size = 21;
    page.text(x, centred(figureTop, 26, size, head), value, head, size, INK);
    const valueW = measure(value, head, size);
    page.text(x + valueW, centred(figureTop, 26, 11, 'body') + 2, clip(measure, suffix, 'body', 11, Math.max(w - valueW, 10)), 'body', 11, SOFT);
  };
  stripFigure(
    cellX(0),
    flexW,
    t('en', 'orderNote.qtyTotal'),
    noteFigure(input.totalQuantity),
    unit,
  );
  stripFigure(
    cellX(1),
    flexW,
    t('en', 'orderNote.weightTotal'),
    noteFigure(input.totalWeightKg),
    ' kg',
  );
  page.text(cellX(2), stripTop, caps(t('en', 'orderNote.party')), head, 8.5, MUTED, 0.85);
  // A long party name takes two lines of the same 26 px the figures stand on, rather than being cut.
  const partyLines = wrap(measure, input.partyName, 'bold', 13, flexW, 2);
  const partyTop = figureTop + (26 - partyLines.length * 13) / 2;
  partyLines.forEach((value, index) => page.text(cellX(2), centred(partyTop + index * 13, 13, 13, 'bold'), value, 'bold', 13, INK));
  page.text(cellX(2), figureTop + 26 + 1, clip(measure, input.partyMeta, 'mono', 8.5, flexW), 'mono', 8.5, FAINT);
  for (const index of [0, 1, 2]) {
    const ruleX = cellX(index) + flexW + gap;
    page.line(ruleX + 0.5, stripTop, ruleX + 0.5, stripTop + 56, RULE, 1);
  }
  const pageCellX = right - pageCellW;
  page.textRight(right, stripTop, clip(measure, input.numberText, 'mono', 9, pageCellW, 0.36), 'mono', 9, MUTED, 0.36);
  page.textRight(right, centred(figureTop, 26, 12, head), t('en', 'orderNote.page', { n: data.pageNo, total: data.pageCount }), head, 12, INK);
  page.textRight(
    right,
    figureTop + 26 + 1,
    last ? t('en', 'orderNote.endOfList', { n: input.itemCount }) : t('en', 'orderNote.carryOn'),
    'mono',
    8.5,
    FAINT,
  );
  void pageCellX;
  page.line(PAD_X, stripTop + 63, right, stripTop + 63, INK, 2);
  y = stripTop + 64 + 8;

  // ---- Body ---------------------------------------------------------------
  const hasLeft = data.leftCount > 0;
  const hasRight = data.rightCount > 0;
  const notesH = data.notesHeight;
  const bodyBottom = PAGE_H - PAD_BOTTOM - notesH;

  const leftX = PAD_X;
  let leftW = CONTENT_W;
  let rightX = PAD_X;
  let rightW = CONTENT_W;
  if (hasLeft && hasRight) {
    const basis = data.wideLeft ? 1 : 0.58;
    const total = CONTENT_W - 1;
    const leftBox = total * basis;
    const rightBox = total - leftBox;
    leftW = leftBox - 22;
    rightX = PAD_X + leftBox + 1 + 22;
    rightW = rightBox - 22;
    page.line(PAD_X + leftBox + 0.5, y - 0, PAD_X + leftBox + 0.5, bodyBottom, INK, 1);
  }

  if (hasLeft) {
    page.text(leftX, centred(y, L.caption, 8, head) + 2, caps(t('en', 'orderNote.productLines')), head, 8, MUTED, 1.04);
    page.textRight(leftX + leftW, centred(y, L.caption, 8, 'mono') + 2, noteRange(data.leftFrom, data.leftCount, input.namedCount), 'mono', 8, MUTED, 0.16);
    planNamed(page, measure, data.left, leftX, y + L.caption, leftW, head, show);
  }
  if (hasRight) {
    page.text(rightX, centred(y, L.caption, 8, head) + 2, caps(t('en', 'orderNote.codedProducts')), head, 8, MUTED, 1.04);
    page.textRight(rightX + rightW, centred(y, L.caption, 8, 'mono') + 2, noteRange(data.rightFrom, data.rightCount, input.codedCount), 'mono', 8, MUTED, 0.16);
    const perRow = data.wideRight ? L.codesPerRowWide : L.codesPerRow;
    planCoded(page, measure, data.right, rightX, y + L.caption, rightW, perRow, head, show);
  }

  // ---- Notes (the last pages) -----------------------------------------------
  if (notesH > 0) {
    // A page of a long note's own: the notes sit under the strip, not at the foot.
    const top = hasLeft || hasRight ? bodyBottom : y;
    page.line(PAD_X, top + 0.5, right, top + 0.5, INK, 1);
    page.text(PAD_X, top + 10, caps(t('en', 'orderNote.notes')), 'bold', 8.5, MUTED, 1.1);
    const notes = data.notesText.trim();
    if (notes) {
      // Every line of what was written, wrapped to the width: the page made room for all of it.
      const lines = notes.split('\n').flatMap((paragraph) => wrap(measure, paragraph, 'body', 17, CONTENT_W, 1000));
      lines.forEach((value, index) => page.text(PAD_X, centred(top + 24 + index * 22, 22, 17, 'body'), value, 'body', 17, INK));
    } else {
      page.line(PAD_X, top + 42, right, top + 42, '#98a3a9', 1, true);
      page.line(PAD_X, top + 62, right, top + 62, '#98a3a9', 1, true);
    }
  }
  return page.ops;
}

/** The named half: one column of product lines, or two when the page has no coded lines. */
function planNamed(
  page: Page,
  measure: Measure,
  columns: NoteLine[][],
  x0: number,
  top: number,
  width: number,
  face: PdfFont,
  show: NoteColumns,
): void {
  const gap = 16;
  const count = Math.max(columns.length, 1);
  const colW = (width - gap * (count - 1)) / count;
  columns.forEach((column, index) => {
    const x = x0 + index * (colW + gap);
    const edge = x + colW;
    const packW = colW * 0.11;
    const colourW = colW * 0.15;
    const gradeW = 40;
    const qtyW = 34;
    const labelW = colW - packW - colourW - gradeW - qtyW - 4 * 7;
    const packX = x + labelW + 7;
    const colourX = packX + packW + 7;
    const gradeX = colourX + colourW + 7;
    const qtyRight = edge;

    // Column heading, with its rule.
    const head = L.columnLabel;
    const headY = centred(top, head, 7.5, 'bold');
    page.text(x, headY, caps(t('en', 'orderNote.subProductBrand')), face, 7.5, MUTED, 0.83);
    // An unticked column prints no heading either — the preview never shows one, and the
    // empty-headed column this used to draw was a defect (2026-10-25 audit, 15x).
    if (show.packaging) page.text(packX, headY, caps(t('en', 'orderNote.packing')), face, 7.5, MUTED, 0.83);
    if (show.colour) page.text(colourX, headY, caps(t('en', 'orderNote.colour')), face, 7.5, MUTED, 0.83);
    if (show.grade) page.text(gradeX, headY, caps(t('en', 'orderNote.grade')), face, 7.5, MUTED, 0.83);
    page.textRight(qtyRight, headY, caps(t('en', 'orderNote.qty')), face, 7.5, MUTED, 0.83);
    page.line(x, top + head - 0.5, edge, top + head - 0.5, INK, 1);

    let y = top + head;
    for (const line of column) {
      const h = namedRowHeight(line);
      const tall = h > L.rowNamed;
      const labelLines = wrap(measure, namedLabel(line), 'bold', 11, labelW, tall ? 3 : 2);
      const labelTop = y + (h - labelLines.length * 13) / 2;
      labelLines.forEach((value, i) => page.text(x, centred(labelTop + i * 13, 13, 11, 'bold'), value, 'bold', 11, INK));
      if (line.brand) {
        const code = noteBrandCode(line.brand);
        const lastLine = labelLines.at(-1) ?? '';
        const chipX = x + measure(lastLine, 'bold', 11) + 5;
        if (code && chipX + 14 < x + labelW) {
          tag(page, measure, chipX, labelTop + (labelLines.length - 1) * 13 + 7, code, 7.5, 'mono', 0.45, false, SOFT);
        }
      }
      const small = (value: string | null, cx: number, w: number): void => {
        if (!value) return;
        const lines = wrap(measure, value, 'body', 11, w, 2);
        const top2 = y + (h - lines.length * 13) / 2;
        lines.forEach((text, i) => page.text(cx, centred(top2 + i * 13, 13, 11, 'body'), text, 'body', 11, ROW_TEXT));
      };
      if (show.packaging) small(line.packaging, packX, packW);
      if (show.colour) small(line.colour, colourX, colourW);
      if (show.grade && line.grade) {
        page.text(gradeX, centred(y + (h - 13) / 2, 13, 11, 'body'), clip(measure, line.grade, 'body', 11, gradeW), 'body', 11, ROW_TEXT);
      }
      page.textRight(qtyRight, centred(y + (h - 18) / 2, 18, 15, 'bold'), noteFigure(line.quantity), 'bold', 15, INK);
      page.line(x, y + h - 0.5, edge, y + h - 0.5, DOTS, 1, true);
      y += h;
    }
  });
}

/** The coded half: group headers and lines of up to `perRow` cells, in one column or two. */
function planCoded(
  page: Page,
  measure: Measure,
  columns: NoteSlot[][],
  x0: number,
  top: number,
  width: number,
  perRow: number,
  face: PdfFont,
  show: NoteColumns,
): void {
  const gap = 20;
  const count = Math.max(columns.length, 1);
  const colW = (width - gap * (count - 1)) / count;
  const cellGap = 10;
  const cellW = (colW - cellGap * (perRow - 1)) / perRow;

  columns.forEach((column, index) => {
    const x = x0 + index * (colW + gap);
    let y = top;
    for (const slot of column) {
      if (slot.kind === 'header') {
        const h = L.groupHeader;
        const cont = slot.continued ? t('en', 'orderNote.groupContinued') : '';
        const contW = cont ? measure(cont, 'body', 7) + 3 : 0;
        const lines = wrap(measure, caps(slot.product), face, 9.5, colW - contW, 2, 0.29);
        const base = y + h - 3 - lines.length * 11;
        lines.forEach((value, i) => page.text(x, centred(base + i * 11, 11, 9.5, face), value, face, 9.5, INK, 0.29));
        if (cont) {
          const lastW = measure(lines.at(-1) ?? '', face, 9.5, 0.29);
          page.text(x + lastW + 3, centred(y + h - 3 - 11, 11, 7, 'body') + 1, cont, 'body', 7, MUTED);
        }
        page.line(x, y + h - 0.5, x + colW, y + h - 0.5, INK, 1);
        y += h;
        continue;
      }
      // The pending order PDF is a Dispatch sheet: the Dispatch note's cell (owner's artifact, 2026-10-13).
      const h = noteCodedRowHeight(slot);
      slot.lines.forEach((line, cell) => {
        const cx = x + cell * (cellW + cellGap);
        const middle = cx + cellW / 2;
        // A caption stays inside its own cell: two lines at most, then an ellipsis, as the note's CSS clamps it.
        const caption = noteCellCaption(slot, line);
        const productLines = caption !== null ? wrap(measure, caps(caption), face, 8, cellW, 2, 0.64) : [];
        // First line: the code, its colour and its brand, on one baseline; the colour (and brand) drop to a
        // line of their own when the three do not fit, as the sheet's flex line wraps.
        const brand = line.brand ? noteBrandCode(line.brand) : '';
        const brandW = brand ? measure(brand, 'mono', 7.5, 0.45) : 0;
        const code = clip(measure, line.subProduct, 'bold', 14, cellW - (brandW ? brandW + 4 : 0));
        const codeW = measure(code, 'bold', 14);
        const fullColour = show.colour ? (line.colour ?? '—') : null;
        const colourW = fullColour ? measure(fullColour, 'body', 10) : 0;
        const oneLine = codeW + (fullColour ? 4 + colourW : 0) + (brand ? 4 + brandW : 0) <= cellW;
        const colour = fullColour && !oneLine ? clip(measure, fullColour, 'body', 10, cellW - (brand ? brandW + 4 : 0)) : fullColour;
        const contentH = productLines.length * 10 + 16 + (fullColour && !oneLine ? 12 : 0) + 3 + 16;
        let cy = y + (h - 1 - contentH) / 2;
        productLines.forEach((value) => {
          page.textCentre(middle, centred(cy, 10, 8, face), value, face, 8, SOFT, 0.64);
          cy += 10;
        });
        const baseline = cy + (16 - LINE_BOX.bold * 14) / 2 + ASCENT.bold * 14;
        const onBaseline = (font: PdfFont, size: number): number => baseline - ASCENT[font] * size;
        if (oneLine) {
          const rowW = codeW + (fullColour ? 4 + colourW : 0) + (brand ? 4 + brandW : 0);
          let lx = middle - rowW / 2;
          page.text(lx, onBaseline('bold', 14), code, 'bold', 14, INK);
          lx += codeW + 4;
          if (fullColour) {
            page.text(lx, onBaseline('body', 10), fullColour, 'body', 10, ROW_TEXT);
            lx += colourW + 4;
          }
          if (brand) page.text(lx, onBaseline('mono', 7.5), brand, 'mono', 7.5, SOFT, 0.45);
          cy += 16;
        } else {
          const rowW = codeW + (brand && !colour ? 4 + brandW : 0);
          const lx = middle - rowW / 2;
          page.text(lx, onBaseline('bold', 14), code, 'bold', 14, INK);
          if (brand && !colour) page.text(lx + codeW + 4, onBaseline('mono', 7.5), brand, 'mono', 7.5, SOFT, 0.45);
          cy += 16;
          if (colour) {
            const toneW = measure(colour, 'body', 10) + (brand ? 4 + brandW : 0);
            const tx = middle - toneW / 2;
            page.text(tx, centred(cy, 12, 10, 'body'), colour, 'body', 10, ROW_TEXT);
            if (brand) page.text(tx + measure(colour, 'body', 10) + 4, centred(cy, 12, 7.5, 'mono') + 1, brand, 'mono', 7.5, SOFT, 0.45);
            cy += 12;
          }
        }
        cy += 3;
        // Second line: the grade chip, the packing (its full name, cut short only when the cell cannot hold it),
        // then × and the quantity.
        const qty = noteFigure(line.quantity);
        const qtyW = measure(qty, 'bold', 15);
        const timesW = measure('×', 'bold', 7);
        const grade = show.grade && line.grade ? clip(measure, caps(line.grade), 'bold', 8.5, Math.max(cellW / 2, 0)) : '';
        const gradeW = grade ? measure(grade, 'bold', 8.5) + 2 : 0;
        const packRoom = cellW - (gradeW ? gradeW + 2 : 0) - timesW - 2 - qtyW - 2;
        const pack = show.packaging && line.packaging ? clip(measure, caps(line.packaging), 'bold', 7, Math.max(packRoom, 0), -0.07) : '';
        const packW = pack ? measure(pack, 'bold', 7, -0.07) : 0;
        const detailW = (gradeW ? gradeW + 2 : 0) + (pack ? packW + 2 : 0) + timesW + 2 + qtyW;
        let dx = middle - detailW / 2;
        if (grade) {
          page.box(dx, cy + 2.5, gradeW, 11, SOFT, 1, 2);
          page.text(dx + 1, centred(cy + 2.5, 11, 8.5, 'bold'), grade, 'bold', 8.5, INK);
          dx += gradeW + 2;
        }
        if (pack) {
          page.text(dx, centred(cy + 2.5, 11, 7, 'bold'), pack, 'bold', 7, ROW_TEXT, -0.07);
          dx += packW + 2;
        }
        page.text(dx, centred(cy + 2.5, 11, 7, 'bold'), '×', 'bold', 7, MUTED);
        dx += timesW + 2;
        page.text(dx, centred(cy, 16, 15, 'bold'), qty, 'bold', 15, INK);
        page.line(cx, y + h - 0.5, cx + cellW, y + h - 0.5, DOTS, 1, true);
      });
      y += h;
    }
  });
}

const FONT_NAMES: Record<PdfFont, string> = { body: 'body', bold: 'bodyBold', mono: 'mono' };

/** The sheets as a PDF: A4, one page per planned page. */
export async function renderNotePdf(input: NotePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: input.title } });
  registerFonts(doc);
  const measure: Measure = (text, font, size, spacing = 0) => {
    doc.font(FONT_NAMES[font]).fontSize(size);
    return doc.widthOfString(text, { characterSpacing: spacing });
  };
  const plans = planNotePdf(input, measure);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  for (const ops of plans) {
    doc.addPage({ size: 'A4', margin: 0 });
    doc.save();
    // The plan is in CSS pixels; a point is 0.75 of one.
    doc.scale(0.75);
    for (const op of ops) draw(doc, op);
    doc.restore();
  }
  doc.end();
  return done;
}

function draw(doc: typeof PDFDocument.prototype, op: PdfOp): void {
  if (op.kind === 'text') {
    doc
      .font(FONT_NAMES[op.font])
      .fontSize(op.size)
      .fillColor(op.colour)
      .text(op.text, op.x, op.y, { lineBreak: false, characterSpacing: op.spacing ?? 0 });
    return;
  }
  if (op.kind === 'line') {
    doc.save().lineWidth(op.width).strokeColor(op.colour);
    if (op.dotted) doc.dash(1, { space: 2 });
    doc.moveTo(op.x1, op.y1).lineTo(op.x2, op.y2).stroke().restore();
    return;
  }
  doc.save().lineWidth(op.width).strokeColor(op.colour);
  if (op.dashed) doc.dash(2, { space: 2 });
  doc.roundedRect(op.x, op.y, op.w, op.h, op.radius).stroke().restore();
}
