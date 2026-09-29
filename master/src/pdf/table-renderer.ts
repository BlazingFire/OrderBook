/**
 * A report as a printable table.
 *
 * A small renderer over the primitives: the vendored fonts, `mm()`, and text
 * runs that switch faces per script. What it draws is a title, optional
 * preamble lines (the lead PDF's party block), a header row, some rows, and an
 * optional totals line.
 *
 * Text cells wrap and grow their row; figures stay on one line
 * (`docs/catalogue/CATALOGUE_MODEL.md` §8). A customer cannot tell
 * `Diamond Vitrosa Doubl…` from its neighbours, nor read a size cut to
 * `L-27, B-15, …` — while a right-aligned figure cut to `10…` at least looks
 * wrong rather than reading as a different number.
 *
 * The rule it keeps for a missing value is the tabular one, not the JSON one:
 * **the column keeps its header and the cell stays empty.** Dropping the
 * column would silently change what every other column means by position, and a
 * zero would be a factual claim that the figure is nothing.
 */

import PDFDocument from 'pdfkit';
import type { ReportOrientation, ReportPaperSize } from '@orderbook/shared';

import { registerFonts } from './fonts.js';
import {
  horizontalRule,
  measureRuns,
  mm,
  runText,
  runTextRight,
  truncateToWidth,
  wrapLines,
  type TextStyle,
} from './primitives.js';

type Doc = typeof PDFDocument.prototype;

/** Points, at 72 per inch. */
const PAGE_SIZES: Record<ReportPaperSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_MM = 12;
const HEADER_STYLE = { size: 8, bold: true, colour: '#555555' };
const CELL_STYLE = { size: 9, colour: '#1C2530' };
const TOTAL_STYLE = { size: 9, bold: true, colour: '#1C2530' };
const PREAMBLE_STYLE = { size: 9, colour: '#1C2530' };
const ROW_HEIGHT = 16;
/** Each wrapped line past the first: the 9pt cell face at 1.2 leading. */
const LINE_STEP = 11;

interface ReportTableColumn {
  label: string;
  /**
   * Right-aligned, on one line. Counts, quantities and numbered codes; never a
   * name or a date. Summing is the caller's business (`totals`).
   */
  numeric?: boolean;
  /** Relative width. Defaults to 1 for text and 0.6 for a figure. */
  weight?: number;
}

export interface ReportTablePdf {
  title: string;
  subtitle?: string;
  /** Lines under the subtitle on the first page only — who the document is for. */
  preamble?: string[];
  columns: ReportTableColumn[];
  /** Already formatted. An empty string prints as empty. */
  rows: string[][];
  totals?: string[];
  paperSize: ReportPaperSize;
  orientation: ReportOrientation;
}

export async function renderReportPdf(table: ReportTablePdf): Promise<Buffer> {
  const [shortEdge, longEdge] = PAGE_SIZES[table.paperSize];
  const size: [number, number] =
    table.orientation === 'landscape' ? [longEdge, shortEdge] : [shortEdge, longEdge];

  const doc = new PDFDocument({
    size,
    margins: {
      top: mm(MARGIN_MM),
      right: mm(MARGIN_MM),
      bottom: mm(MARGIN_MM),
      left: mm(MARGIN_MM),
    },
    autoFirstPage: false,
    info: { Title: table.title, Author: 'OrderBook' },
  });

  // The vendored SIL faces. Without them PDFKit falls back to Helvetica, which
  // has no Devanagari glyphs — a Hindi party name would print as blank boxes.
  registerFonts(doc);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const left = mm(MARGIN_MM);
  const right = size[0] - mm(MARGIN_MM);
  const width = right - left;
  const bottom = size[1] - mm(MARGIN_MM);

  /*
   * Even columns, except that numeric ones get less — unless the caller says.
   *
   * A report's text column is a party name and its numeric ones are counts —
   * giving them equal width wastes half the page on figures that are five
   * characters wide. This is a heuristic, not a measurement pass: measuring
   * every cell would cost a full extra traversal for a layout nobody is
   * pixel-matching. A fixed layout like the lead PDF knows its columns and
   * passes weights instead.
   */
  const weights = table.columns.map((column) => column.weight ?? (column.numeric ? 0.6 : 1));
  const unit = width / weights.reduce((total, weight) => total + weight, 0);
  const widths = weights.map((weight) => weight * unit);
  const offsets = widths.map((_, index) =>
    widths.slice(0, index).reduce((total, columnWidth) => total + columnWidth, left),
  );

  let y = 0;
  let firstPage = true;

  const drawHeader = (): void => {
    doc.addPage();
    y = mm(MARGIN_MM);

    runText(doc, table.title, left, y, { size: 13, bold: true, colour: '#1C2530' });
    y += 18;

    if (table.subtitle) {
      runText(doc, table.subtitle, left, y, { size: 9, colour: '#667085' });
      y += 14;
    }

    // Once: a party block repeated on every page is a letterhead nobody asked for.
    if (firstPage && table.preamble?.length) {
      y += 4;
      for (const line of table.preamble) {
        runText(doc, truncateToWidth(doc, line, width, PREAMBLE_STYLE), left, y, PREAMBLE_STYLE);
        y += 12;
      }
      y += 6;
    }
    firstPage = false;

    y += 4;
    for (const [index, column] of table.columns.entries()) {
      const cell = truncateToWidth(doc, column.label, widths[index]! - 6, HEADER_STYLE);
      if (column.numeric) {
        runTextRight(doc, cell, offsets[index]! + widths[index]! - 6, y, HEADER_STYLE);
      } else {
        runText(doc, cell, offsets[index]!, y, HEADER_STYLE);
      }
    }

    y += 12;
    horizontalRule(doc, left, y, width);
    y += 6;
  };

  drawHeader();

  const drawRow = (cells: string[], style: TextStyle): void => {
    // Wrapped before the page-break test, so a grown row breaks as a whole
    // rather than running off the bottom of the sheet.
    const lines = table.columns.map((column, index) =>
      cellLines(doc, cells[index] ?? '', widths[index]! - 6, style, column.numeric ?? false),
    );
    const tallest = Math.max(1, ...lines.map((cell) => cell.length));
    const height = ROW_HEIGHT + (tallest - 1) * LINE_STEP;

    // A page break repeats the header. A table whose second page has no column
    // labels is a table somebody has to flip back to read.
    if (y + height > bottom) drawHeader();

    for (const [index, column] of table.columns.entries()) {
      for (const [lineIndex, line] of lines[index]!.entries()) {
        const lineY = y + lineIndex * LINE_STEP;
        if (column.numeric) {
          runTextRight(doc, line, offsets[index]! + widths[index]! - 6, lineY, style);
        } else {
          runText(doc, line, offsets[index]!, lineY, style);
        }
      }
    }

    y += height;
  };

  for (const row of table.rows) drawRow(row, CELL_STYLE);

  if (table.totals) {
    horizontalRule(doc, left, y, width);
    y += 6;
    drawRow(table.totals, TOTAL_STYLE);
  }

  doc.end();
  await finished;

  return Buffer.concat(chunks);
}

/**
 * One cell as the lines it prints; an empty value prints nothing.
 *
 * A figure stays on one line, truncated. Text packs whole `, `-separated
 * entries first, so `White ×10, Ivory ×5` never parts a colour from its
 * quantity and `L-27, B-15, H-26` never parts a letter from its number; an
 * entry wider than the column on its own word-wraps, its `×N` kept with the
 * word before it, and a single word wider than that is the one thing still cut.
 */
export function cellLines(
  doc: Doc,
  value: string,
  maxWidth: number,
  style: TextStyle,
  numeric: boolean,
): string[] {
  if (value === '') return [];
  if (numeric) return [truncateToWidth(doc, value, maxWidth, style)];

  const entries = value.split(', ');
  const packed: string[] = [];
  let line = '';

  for (const [index, entry] of entries.entries()) {
    // The separating comma stays at the end of the line it closes, so it is
    // measured with the entry it follows.
    const piece = index < entries.length - 1 ? `${entry},` : entry;
    const candidate = line ? `${line} ${piece}` : piece;

    if (line && measureRuns(doc, candidate, style) > maxWidth) {
      packed.push(line);
      line = piece;
    } else {
      line = candidate;
    }
  }
  packed.push(line);

  const lines = packed.flatMap((packedLine) => wrapLines(doc, packedLine, maxWidth, style));

  // A word wrap inside one entry could strand its count — `Rustic Coffee
  // Brown` over a lone `×5,` in the lead PDF's Colour column. The word before
  // goes down with it when the two fit, so the line reads `Brown ×5,`.
  for (let index = 1; index < lines.length; index += 1) {
    const before = lines[index - 1]!;
    const cut = before.lastIndexOf(' ');
    const joined = `${before.slice(cut + 1)} ${lines[index]}`;
    if (!lines[index]!.startsWith('×') || cut < 0 || measureRuns(doc, joined, style) > maxWidth) {
      continue;
    }
    lines[index - 1] = before.slice(0, cut);
    lines[index] = joined;
  }

  return lines.map((wrapped) => truncateToWidth(doc, wrapped, maxWidth, style));
}
