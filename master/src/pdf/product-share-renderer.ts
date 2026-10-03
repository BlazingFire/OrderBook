/**
 * The product share sheet: A4 portrait, a header on every page, and the page's
 * (at most four) products as 2 x 2 cards, each a photograph over its fields.
 *
 * Drawing only. What a card says is `domain/product-share.ts`; where the photo
 * bytes come from is the service. A card with no photo draws a grey placeholder
 * so the grid keeps its shape.
 */

import PDFDocument from 'pdfkit';

import { SHARE_PER_PAGE, chunkPages, shareText, type ShareCard, type ShareText } from '../domain/product-share.js';
import { registerFonts } from './fonts.js';
import { measureRuns, mm, runText, truncateToWidth, wrapLines, type TextStyle } from './primitives.js';

const PAGE: [number, number] = [595.28, 841.89];
const MARGIN = mm(12);
const GAP = mm(6);
const HEADER_HEIGHT = mm(16);

const TITLE_STYLE: TextStyle = { size: 12, bold: true, colour: '#1C2530' };
const SUBTITLE_STYLE: TextStyle = { size: 8.5, colour: '#667085' };
const LABEL_STYLE: TextStyle = { size: 8, bold: true, colour: '#555555' };
const VALUE_STYLE: TextStyle = { size: 8.5, colour: '#1C2530' };
const FIELD_STEP = 11;

export interface ShareEntry {
  card: ShareCard;
  /** A JPEG, already resized; `null` for a product without a usable photo. */
  photo: Buffer | null;
}

export interface ShareSheet {
  company: string;
  /** Printed under the company name, e.g. the date. */
  caption: string;
  entries: ShareEntry[];
  /** The sheet's fixed words; English when omitted. */
  text?: ShareText;
}

export async function renderProductShare(sheet: ShareSheet): Promise<Buffer> {
  const text = sheet.text ?? shareText('en');
  const doc = new PDFDocument({
    size: PAGE,
    margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
    autoFirstPage: false,
    info: { Title: text.title(sheet.company), Author: 'OrderBook' },
  });
  registerFonts(doc);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const left = MARGIN;
  const width = PAGE[0] - 2 * MARGIN;
  const top = MARGIN + HEADER_HEIGHT;
  const bottom = PAGE[1] - MARGIN;
  const cellWidth = (width - GAP) / 2;
  const cellHeight = (bottom - top - GAP) / 2;

  const pages = chunkPages(sheet.entries, SHARE_PER_PAGE);

  for (const [pageIndex, page] of pages.entries()) {
    doc.addPage();

    runText(doc, truncateToWidth(doc, sheet.company, width * 0.7, { size: 14, bold: true }), left, MARGIN, {
      size: 14,
      bold: true,
      colour: '#1C2530',
    });
    const pageLabel = `${sheet.caption}  |  ${text.page(pageIndex + 1, pages.length)}`;
    runText(
      doc,
      pageLabel,
      left + width - measureRuns(doc, pageLabel, SUBTITLE_STYLE),
      MARGIN + 3,
      SUBTITLE_STYLE,
    );

    for (const [slot, entry] of page.entries()) {
      const x = left + (slot % 2) * (cellWidth + GAP);
      const y = top + Math.floor(slot / 2) * (cellHeight + GAP);
      drawCard(doc, entry, x, y, cellWidth, cellHeight);
    }

    // Between pages the event loop gets a turn, so the Master keeps answering its sockets.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

function drawCard(
  doc: InstanceType<typeof PDFDocument>,
  entry: ShareEntry,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const pad = mm(3);
  doc.save().rect(x, y, width, height).lineWidth(0.6).strokeColor('#D0D5DD').stroke().restore();

  const photoHeight = height * 0.52;
  const photoBox = { x: x + pad, y: y + pad, width: width - 2 * pad, height: photoHeight - pad };
  if (entry.photo) {
    try {
      doc.image(entry.photo, photoBox.x, photoBox.y, {
        fit: [photoBox.width, photoBox.height],
        align: 'center',
        valign: 'center',
      });
    } catch {
      drawPlaceholder(doc, photoBox);
    }
  } else {
    drawPlaceholder(doc, photoBox);
  }

  let cursor = y + photoHeight + mm(2);
  const textWidth = width - 2 * pad;
  const innerLeft = x + pad;

  runText(doc, truncateToWidth(doc, entry.card.title, textWidth, TITLE_STYLE), innerLeft, cursor, TITLE_STYLE);
  cursor += 15;
  if (entry.card.subtitle) {
    runText(
      doc,
      truncateToWidth(doc, entry.card.subtitle, textWidth, SUBTITLE_STYLE),
      innerLeft,
      cursor,
      SUBTITLE_STYLE,
    );
    cursor += 13;
  }

  const labelWidth = textWidth * 0.28;
  const valueWidth = textWidth - labelWidth;
  const limit = y + height - pad;
  for (const field of entry.card.fields) {
    const lines = wrapLines(doc, field.value, valueWidth, VALUE_STYLE);
    // A field that no longer fits is dropped whole rather than cut across the border.
    if (cursor + lines.length * FIELD_STEP > limit) break;
    runText(doc, truncateToWidth(doc, field.label, labelWidth - 4, LABEL_STYLE), innerLeft, cursor, LABEL_STYLE);
    for (const [index, line] of lines.entries()) {
      runText(doc, line, innerLeft + labelWidth, cursor + index * FIELD_STEP, VALUE_STYLE);
    }
    cursor += lines.length * FIELD_STEP;
  }
}

function drawPlaceholder(
  doc: InstanceType<typeof PDFDocument>,
  box: { x: number; y: number; width: number; height: number },
): void {
  doc.save().rect(box.x, box.y, box.width, box.height).fillColor('#F2F4F7').fill().restore();
}
