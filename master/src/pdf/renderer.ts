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

import type { DocumentColumn, DocumentModel, DocumentRow } from '../domain/document-model.js';
import { registerFonts } from './fonts.js';
import {
  colourChip,
  horizontalRule,
  keyValueBlock,
  measureRuns,
  mm,
  pageFooter,
  runText,
  runTextRight,
  truncateToWidth,
  watermark,
  wrappedRunText,
} from './primitives.js';

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

const ROW_HEIGHT = 16;
const HEADER_ROW_HEIGHT = 18;

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

  doc.addPage();
  if (model.watermark) watermark(doc, model.watermark, size[0], size[1]);

  let y = mm(options.margins.top);

  const newPage = (): void => {
    doc.addPage();
    if (model.watermark) watermark(doc, model.watermark, size[0], size[1]);
    y = mm(options.margins.top);
  };

  const columns = layOutColumns(model.columns, width);

  for (const block of model.blocks) {
    switch (block.kind) {
      case 'header':
        y = drawHeader(doc, model, { left, right, width, y, logo: options.logo, align: block.align });
        break;

      case 'party':
        if (model.party) y = drawParty(doc, model, left, y);
        break;

      case 'lines':
        y = drawTable(doc, model, columns, {
          left,
          width,
          y,
          bottomLimit,
          onPageBreak: () => {
            newPage();
            return y;
          },
          setY: (next) => {
            y = next;
          },
        });
        break;

      case 'totals':
        // The model omits this block entirely when rates are out, so reaching
        // here means totals exist. The optional chain is for the compiler.
        if (model.totals) y = drawTotals(doc, model, right, y, block.showBoxCount);
        break;

      case 'terms':
        if (model.terms) y = drawTerms(doc, model.terms, left, y, width);
        break;

      case 'signature':
        y = drawSignature(doc, model, options.signature, right, y, bottomLimit);
        break;
    }
  }

  const pageCount = writeFooters(doc, model, { left, width, height: size[1], margins: options.margins });

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

function drawHeader(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  layout: {
    left: number;
    right: number;
    width: number;
    y: number;
    logo: Buffer | null;
    align: 'left' | 'centre';
  },
): number {
  const { left, right, y, logo } = layout;
  let textLeft = left;

  if (logo) {
    try {
      doc.image(logo, left, y, { fit: [90, 36] });
      textLeft = left + 100;
    } catch {
      // A logo that PDFKit cannot decode must not fail the whole render — the
      // document is still correct without it, and the alternative is a
      // customer's quotation blocked by a bad upload from months ago.
    }
  }

  if (model.companyName) {
    runText(doc, model.companyName, textLeft, y, { size: 15, bold: true });
  }

  runTextRight(doc, model.title, right, y, { size: 13, bold: true, colour: model.accentColour ?? '#111111' });

  keyValueBlock(
    doc,
    [
      { label: 'Ref', value: model.reference },
      { label: 'Date', value: model.issuedOn },
    ],
    right - 150,
    y + 20,
  );

  const bottom = y + 52;
  horizontalRule(doc, left, bottom - 8, layout.width, model.accentColour ?? '#DDDDDD');
  return bottom;
}

function drawParty(doc: typeof PDFDocument.prototype, model: DocumentModel, left: number, y: number): number {
  if (!model.party) return y;

  runText(doc, 'To', left, y, { size: 7.5, colour: '#777777' });
  runText(doc, model.party.name, left, y + 10, { size: 10.5, bold: true });

  let cursor = y + 24;
  for (const line of model.party.lines) {
    runText(doc, line, left, cursor, { size: 8 });
    cursor += 10;
  }

  return cursor + 8;
}

function drawTable(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  columns: PlacedColumn[],
  layout: {
    left: number;
    width: number;
    y: number;
    bottomLimit: number;
    onPageBreak: () => number;
    setY: (next: number) => void;
  },
): number {
  const { left, width, bottomLimit } = layout;
  let y = layout.y;

  const drawHeaderRow = (): void => {
    doc.save().rect(left, y, width, HEADER_ROW_HEIGHT).fillColor('#F4F4F5').fill().restore();

    for (const column of columns) {
      const style = { size: 7.5, bold: true, colour: '#444444' as string };
      if (column.align === 'right') {
        runTextRight(doc, column.heading, left + column.x + column.width - 4, y + 5.5, style);
      } else {
        runText(doc, column.heading, left + column.x + 4, y + 5.5, style);
      }
    }

    y += HEADER_ROW_HEIGHT;
  };

  drawHeaderRow();

  for (const row of model.rows) {
    if (y + ROW_HEIGHT > bottomLimit) {
      layout.setY(y);
      y = layout.onPageBreak();
      drawHeaderRow();
    }

    drawRow(doc, model, row, columns, left, y);
    y += ROW_HEIGHT;
    horizontalRule(doc, left, y, width, '#EEEEEE');
  }

  layout.setY(y + 10);
  return y + 10;
}

function drawRow(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  row: DocumentRow,
  columns: PlacedColumn[],
  left: number,
  y: number,
): void {
  for (const column of columns) {
    // A cell the model did not build is not drawn. This is the only place a
    // redacted rate could have leaked back in, and it cannot: the key is
    // absent from `row.cells`, so there is nothing to render.
    const raw = row.cells[column.key];
    if (raw === undefined) continue;

    const style = { size: 8, script: column.script };
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

function drawTotals(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  right: number,
  y: number,
  showBoxCount: boolean,
): number {
  if (!model.totals) return y;

  let cursor = y + 4;

  if (showBoxCount) {
    runTextRight(doc, `Boxes  ${model.totals.boxCount}`, right, cursor, {
      size: 8.5,
      colour: '#555555',
      script: 'mono',
    });
    cursor += 14;
  }

  if (model.totals.grandTotal !== undefined) {
    const label = 'Total  ';
    const value = `₹${model.totals.grandTotal}`;
    const valueWidth = measureRuns(doc, value, { size: 11, bold: true, script: 'mono' });

    runTextRight(doc, label, right - valueWidth, cursor, { size: 9, colour: '#555555' });
    runTextRight(doc, value, right, cursor - 1, {
      size: 11,
      bold: true,
      script: 'mono',
      colour: model.accentColour ?? '#111111',
    });
    cursor += 18;
  }

  return cursor;
}

function drawTerms(
  doc: typeof PDFDocument.prototype,
  terms: string,
  left: number,
  y: number,
  width: number,
): number {
  runText(doc, 'Terms', left, y + 6, { size: 7.5, colour: '#777777' });

  // The one place wrapping is wanted: terms are a paragraph, and the domain
  // already caps them at 500 characters so the height stays bounded.
  //
  // Wrapped through `wrappedRunText`, never PDFKit's own `text(…, { width })`
  // — that binds one font for the whole call, so a Hindi clause would be
  // dropped silently while the English around it rendered fine.
  const bottom = wrappedRunText(doc, terms, left, y + 18, width * 0.7, {
    size: 8,
    colour: '#333333',
  });

  return bottom + 10;
}

function drawSignature(
  doc: typeof PDFDocument.prototype,
  model: DocumentModel,
  signature: Buffer | null,
  right: number,
  y: number,
  bottomLimit: number,
): number {
  const blockHeight = 62;
  const top = Math.min(Math.max(y + 12, bottomLimit - blockHeight), bottomLimit - blockHeight);
  const boxLeft = right - 160;

  if (signature) {
    try {
      doc.image(signature, boxLeft, top, { fit: [150, 34] });
    } catch {
      // Same reasoning as the logo: an undecodable image loses the signature,
      // not the document.
    }
  }

  horizontalRule(doc, boxLeft, top + 40, 160, '#999999');

  if (model.signatureLabel) {
    runText(doc, model.signatureLabel, boxLeft, top + 44, { size: 7.5, colour: '#666666' });
  }

  return top + blockHeight;
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
