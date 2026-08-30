/**
 * `DocumentModel` → `Buffer`. Page setup, the line-item table, colour chips,
 * the watermark, page numbers, logo and signature placement.
 *
 * **No business rule and no permission check lives here.** If a column is not
 * in `model.columns` it is not drawn, full stop — the decision about whether a
 * rate appears was made in `domain/document-model.ts`, where it is a layout
 * fact rather than a rendering one. That separation is the whole reason a
 * rate-blind actor cannot get a priced PDF: there is no code path in this file
 * that could reintroduce a column the model omitted.
 */

import PDFDocument from 'pdfkit';

import type {
  DocumentColumn,
  DocumentModel,
  DocumentRow,
  ResolvedElement,
} from '../domain/document-model.js';
import { registerFonts } from './fonts.js';
import {
  colourChip,
  filledBox,
  horizontalRule,
  mm,
  pageFooter,
  runText,
  runTextRight,
  truncateToWidth,
  watermark,
} from './primitives.js';
import { drawElement } from './elements.js';

/** PDFKit's own point sizes, so a page size never has to be computed from millimetres. */
const PAGE_SIZES = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
} as const;

export interface RenderOptions {
  paperSize: 'A4' | 'A5' | 'Letter';
  orientation: 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number };
  /** PNG or JPEG bytes; drawn at the top-left of the header when present. */
  logo: Buffer | null;
  signature: Buffer | null;
}

export interface RenderedDocument {
  bytes: Buffer;
  pageCount: number;
}

export async function renderPdf(
  model: DocumentModel,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const [shortEdge, longEdge] = PAGE_SIZES[options.paperSize];
  const size: [number, number] =
    options.orientation === 'landscape' ? [longEdge, shortEdge] : [shortEdge, longEdge];

  const doc = new PDFDocument({
    size,
    margins: {
      top: mm(options.margins.top),
      right: mm(options.margins.right),
      bottom: mm(options.margins.bottom),
      left: mm(options.margins.left),
    },
    // PDFKit's own `bufferPages` is what lets the footer be written after the
    // page count is known — otherwise "Page 1 of 3" cannot exist.
    bufferPages: true,
    autoFirstPage: false,
    info: { Title: model.title, Author: model.companyName || 'OrderBook' },
  });

  registerFonts(doc);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const left = mm(options.margins.left);
  const right = size[0] - mm(options.margins.right);
  const width = right - left;
  const bottomLimit = size[1] - mm(options.margins.bottom) - 24;

  const elementContext = {
    offsetY: 0,
    accentColour: model.accentColour,
    logo: options.logo,
    signature: options.signature,
  };

  const drawBand = (band: 'header' | 'footer'): void => {
    for (const element of model.elements) {
      if (element.band === band) drawElement(doc, element, elementContext);
    }
  };

  const startPage = (): void => {
    doc.addPage();
    if (model.watermark) watermark(doc, model.watermark, size[0], size[1]);
    // Page furniture, drawn before the body so the body sits on top of it.
    drawBand('header');
  };

  startPage();

  const table = model.elements.find((element) => element.kind === 'table');
  const body = model.elements.filter((element) => element.band === 'body');

  // The table's top edge is the horizon: above it is page-one furniture, below
  // it is what may ride the table's growth.
  const tableTop = table ? mm(table.y) : Number.POSITIVE_INFINITY;
  const above = body.filter((element) => element !== table && mm(element.y) < tableTop);
  const below = body.filter((element) => element !== table && mm(element.y) >= tableTop);

  for (const element of above) drawElement(doc, element, elementContext);

  let tableBottom = tableTop;

  if (table && table.kind === 'table') {
    const columns = layOutColumns(model.columns, mm(table.w));

    tableBottom = drawTable(doc, model, table, columns, {
      left: mm(table.x),
      width: mm(table.w),
      y: tableTop,
      bottomLimit,
      onPageBreak: () => {
        startPage();
        return mm(options.margins.top);
      },
    });
  }

  /*
   * One delta, applied once.
   *
   * An element that asked to stay put stays put; one that asked to follow the
   * table moves by however far the table's real bottom landed from the height
   * it was designed at — which is negative when the order has fewer rows than
   * the design assumed. This is deliberately not a reflow engine: two
   * independently growing regions is a second feature, and nothing has asked
   * for one.
   */
  const declaredBottom = table ? mm(table.y) + mm(table.h) : tableBottom;
  const delta = tableBottom - declaredBottom;

  for (const element of below) {
    drawElement(doc, element, {
      ...elementContext,
      offsetY: element.flow === 'after-table' ? delta : 0,
    });
  }

  const pageCount = writeFooters(doc, model, {
    left,
    width,
    height: size[1],
    margins: options.margins,
  });

  doc.end();
  await finished;

  return { bytes: Buffer.concat(chunks), pageCount };
}

interface PlacedColumn extends DocumentColumn {
  x: number;
  width: number;
}

/** Normalises the model's relative weights against the printable width. */
function layOutColumns(columns: DocumentColumn[], width: number): PlacedColumn[] {
  const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0);

  let x = 0;
  return columns.map((column) => {
    const columnWidth = (column.weight / totalWeight) * width;
    const placed = { ...column, x, width: columnWidth };
    x += columnWidth;
    return placed;
  });
}

function drawTable(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  table: Extract<ResolvedElement, { kind: 'table' }>,
  columns: PlacedColumn[],
  layout: {
    left: number;
    width: number;
    y: number;
    bottomLimit: number;
    onPageBreak: () => number;
  },
): number {
  const { left, width, bottomLimit } = layout;
  const rowHeight = mm(table.rowHeightMm);
  const headingHeight = mm(table.headingHeightMm);
  let y = layout.y;

  const drawHeadingRow = (): void => {
    if (table.headingFill) filledBox(doc, left, y, width, headingHeight, table.headingFill);

    for (const column of columns) {
      const style = {
        size: table.headingStyle.size,
        bold: table.headingStyle.bold,
        colour: table.headingStyle.colour ?? '#444444',
      };

      if (column.align === 'right') {
        runTextRight(
          doc,
          headingFor(table, column),
          left + column.x + column.width - 4,
          y + 5.5,
          style,
        );
      } else {
        runText(doc, headingFor(table, column), left + column.x + 4, y + 5.5, style);
      }
    }

    y += headingHeight;
  };

  drawHeadingRow();

  for (const row of model.rows) {
    if (y + rowHeight > bottomLimit) {
      y = layout.onPageBreak();
      if (table.repeatHeadingOnBreak) drawHeadingRow();
    }

    drawRow(doc, model, row, columns, left, y, table.cellStyle.size);
    y += rowHeight;
    horizontalRule(doc, left, y, width, '#EEEEEE');
  }

  return y + 10;
}

/**
 * The designer's own heading, or the model's translated one.
 *
 * A renamed heading is text the operator typed, and it can no more leak a rate
 * than any other literal: the column it names had to survive `buildColumns`
 * before there was anything to head.
 */
function headingFor(
  table: Extract<ResolvedElement, { kind: 'table' }>,
  column: PlacedColumn,
): string {
  const spec = table.columns.find((candidate) => candidate.key === column.key);
  return spec?.heading?.trim() || column.heading;
}

function drawRow(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  row: DocumentRow,
  columns: PlacedColumn[],
  left: number,
  y: number,
  cellSize: number,
): void {
  for (const column of columns) {
    // A cell the model did not build is not drawn. This is the only place a
    // redacted rate could have leaked back in, and it cannot: the key is
    // absent from `row.cells`, so there is nothing to render.
    const raw = row.cells[column.key];
    if (raw === undefined) continue;

    const style = { size: cellSize, script: column.script };
    const inner = column.width - 8;

    if (column.key === 'colours' && model.showColourChips && row.chips.length > 0) {
      let chipX = left + column.x + 4;
      for (const chip of row.chips) {
        if (chipX + 12 > left + column.x + column.width) break;
        chipX = colourChip(doc, chip, chipX, y + 3.5);
      }
      continue;
    }

    const text = truncateToWidth(doc, raw, inner, style);

    if (column.align === 'right') {
      runTextRight(doc, text, left + column.x + column.width - 4, y + 4, style);
    } else {
      runText(doc, text, left + column.x + 4, y + 4, style);
    }
  }
}

/**
 * Footers are written last, in a second pass over the buffered pages, because
 * "Page 2 of 5" cannot be written before the fifth page exists.
 */
function writeFooters(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  layout: {
    left: number;
    width: number;
    height: number;
    margins: { top: number; right: number; bottom: number; left: number };
  },
): number {
  const range = doc.bufferedPageRange();
  const y = layout.height - mm(layout.margins.bottom) - 10;

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    pageFooter(doc, {
      text: model.footer,
      pageNumber: model.showPageNumbers ? index + 1 : null,
      x: layout.left,
      y,
      width: layout.width,
    });
  }

  return range.count;
}
