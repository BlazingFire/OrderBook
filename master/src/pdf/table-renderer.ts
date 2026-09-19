/**
 * A report as a printable table.
 *
 * A small renderer over the primitives: the vendored fonts, `mm()`, and text
 * runs that switch faces per script. What it draws is a header row, some
 * rows, and an optional totals line.
 *
 * The redaction rule it implements is the tabular one, not the JSON one: **a
 * redacted money column keeps its header and empties its cells.** Dropping the
 * column would silently change what every other column means by position, and a
 * zero would be a factual claim that the figure is nothing.
 */

import PDFDocument from 'pdfkit';
import type { ReportOrientation, ReportPaperSize } from '@orderbook/shared';

import { registerFonts } from './fonts.js';
import {
  horizontalRule,
  mm,
  runText,
  runTextRight,
  truncateToWidth,
  type TextStyle,
} from './primitives.js';

/** Points, at 72 per inch. */
const PAGE_SIZES: Record<ReportPaperSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_MM = 12;
const HEADER_STYLE = { size: 8, bold: true, colour: '#555555' };
const CELL_STYLE = { size: 9, colour: '#1C2530' };
const TOTAL_STYLE = { size: 9, bold: true, colour: '#1C2530' };
const ROW_HEIGHT = 16;

export interface ReportTableColumn {
  label: string;
  /** Right-aligned and summed. Numbers and money; never a name or a date. */
  numeric?: boolean;
}

export interface ReportTablePdf {
  title: string;
  subtitle?: string;
  columns: ReportTableColumn[];
  /** Already formatted, already redacted. An empty string prints as empty. */
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
   * Even columns, except that numeric ones get less.
   *
   * A report's text column is a party name and its numeric ones are counts —
   * giving them equal width wastes half the page on figures that are five
   * characters wide. This is a heuristic, not a measurement pass: measuring
   * every cell would cost a full extra traversal for a layout nobody is
   * pixel-matching.
   */
  const weights = table.columns.map((column) => (column.numeric ? 0.6 : 1));
  const unit = width / weights.reduce((total, weight) => total + weight, 0);
  const widths = weights.map((weight) => weight * unit);
  const offsets = widths.map((_, index) =>
    widths.slice(0, index).reduce((total, columnWidth) => total + columnWidth, left),
  );

  let y = 0;

  const drawHeader = (): void => {
    doc.addPage();
    y = mm(MARGIN_MM);

    runText(doc, table.title, left, y, { size: 13, bold: true, colour: '#1C2530' });
    y += 18;

    if (table.subtitle) {
      runText(doc, table.subtitle, left, y, { size: 9, colour: '#667085' });
      y += 14;
    }

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
    // A page break repeats the header. A table whose second page has no column
    // labels is a table somebody has to flip back to read.
    if (y + ROW_HEIGHT > bottom) drawHeader();

    for (const [index, column] of table.columns.entries()) {
      const value = cells[index] ?? '';
      if (value === '') continue;

      const cell = truncateToWidth(doc, value, widths[index]! - 6, style);
      if (column.numeric) {
        runTextRight(doc, cell, offsets[index]! + widths[index]! - 6, y, style);
      } else {
        runText(doc, cell, offsets[index]!, y, style);
      }
    }

    y += ROW_HEIGHT;
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
