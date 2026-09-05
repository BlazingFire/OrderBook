/**
 * Drawing primitives over PDFKit. Infrastructure — no business rule reaches
 * this file, and none may be added: if a column is not in the model it is not
 * drawn, and there is nothing here that could decide otherwise.
 *
 * `runText` is the load-bearing one. PDFKit binds **one font per `text()`
 * call**, so a line mixing scripts — "शर्मा टाइल्स (Sharma Tiles)" is an
 * ordinary party name in this business — has to be drawn as several calls that
 * share a baseline. Doing it any other way renders the Devanagari half as
 * blank boxes in the Latin face.
 */

import type PDFDocument from 'pdfkit';

import { splitByScript, type ScriptTag } from '../domain/document-text.js';
import type { DocumentColourChip } from '../domain/document-model.js';
import { faceFor } from './fonts.js';

type Doc = typeof PDFDocument.prototype;

export const MM_TO_PT = 72 / 25.4;

export function mm(millimetres: number): number {
  return millimetres * MM_TO_PT;
}

export interface TextStyle {
  size: number;
  bold?: boolean;
  colour?: string;
  script?: ScriptTag;
}

/**
 * Measures a mixed-script string by summing each run in its own face. A single
 * `widthOfString` under one font is wrong the moment a string mixes scripts,
 * and the error shows up as a column overlapping its neighbour.
 */
export function measureRuns(doc: Doc, text: string, style: TextStyle): number {
  return splitByScript(text, style.script ?? 'body').reduce((total, run) => {
    doc.font(faceFor(run.script, style.bold)).fontSize(style.size);
    return total + doc.widthOfString(run.text);
  }, 0);
}

/**
 * Draws a mixed-script string on one baseline, switching faces per run.
 *
 * Returns the x coordinate it finished at, so a caller can append. Nothing
 * wraps here — the table truncates instead, because a cell that grows to two
 * lines silently shifts every row below it and the page break lands somewhere
 * nobody chose.
 */
export function runText(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
): number {
  let cursor = x;

  for (const run of splitByScript(text, style.script ?? 'body')) {
    doc
      .font(faceFor(run.script, style.bold))
      .fontSize(style.size)
      .fillColor(style.colour ?? '#111111')
      .text(run.text, cursor, y, { lineBreak: false });

    cursor += doc.widthOfString(run.text);
  }

  return cursor;
}

/** Truncates to fit a width, appending an ellipsis. Measured per-run, so it is script-correct. */
export function truncateToWidth(doc: Doc, text: string, maxWidth: number, style: TextStyle): string {
  if (measureRuns(doc, text, style) <= maxWidth) return text;

  const characters = Array.from(text);
  let candidate = '';

  for (const char of characters) {
    const next = `${candidate}${char}`;
    if (measureRuns(doc, `${next}…`, style) > maxWidth) break;
    candidate = next;
  }

  return `${candidate}…`;
}

export function runTextRight(
  doc: Doc,
  text: string,
  rightEdge: number,
  y: number,
  style: TextStyle,
): void {
  runText(doc, text, rightEdge - measureRuns(doc, text, style), y, style);
}

/**
 * Word-wraps a mixed-script paragraph into lines, without drawing anything.
 *
 * Split out of `wrappedRunText` so that measuring and drawing cannot disagree.
 * Anything that decides whether text *fits* — the shrink-to-fit search below,
 * a caller sizing a box — has to break the text into exactly the lines that
 * will be drawn, and a second implementation that is nearly the same is how
 * "the last line got cut off" happens.
 *
 * A blank line is preserved as an empty entry, so `

` between paragraphs
 * costs a line rather than vanishing. Callers that want the older behaviour,
 * where every run of whitespace was one space, collapse it before calling.
 */
export function wrapLines(doc: Doc, text: string, maxWidth: number, style: TextStyle): string[] {
  const lines: string[] = [];

  // Hard breaks first: a newline the operator typed is a decision, and
  // re-flowing across it would silently join two paragraphs.
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);

    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';

    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;

      if (measureRuns(doc, candidate, style) > maxWidth && line.length > 0) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Word-wraps a mixed-script paragraph and draws each line through `runText`.
 *
 * PDFKit's own `text(…, { width })` cannot be used for anything that might
 * contain Devanagari: it wraps and draws under the **single** font bound at
 * the time of the call, so every Hindi character silently maps to `.notdef`
 * and vanishes from the page — the paragraph looks merely short rather than
 * broken. That is exactly what happened to the terms block before this
 * existed, and it survived a visual check because the English half rendered
 * perfectly.
 *
 * Returns the y coordinate below the last line drawn.
 */
export function wrappedRunText(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  style: TextStyle,
  lineHeight = style.size * 1.45,
): number {
  // Whitespace collapsed on the way in, which is what this function has always
  // done: `split(/\s+/)` treated a newline as a space. `wrapLines` honours
  // newlines, so preserving that behaviour here is deliberate rather than an
  // oversight — changing how every existing terms block prints is not this
  // function's business.
  const lines = wrapLines(doc, text.replace(/\s+/g, ' ').trim(), maxWidth, style);
  let cursor = y;

  for (const line of lines) {
    if (line.length > 0) runText(doc, line, x, cursor, style);
    cursor += lineHeight;
  }

  return cursor;
}

/**
 * The largest size at or below `style.size` whose wrapped text fits `maxHeight`.
 *
 * Steps down rather than solving, because the wrap points move as the size
 * changes and the relationship between size and height is a step function, not
 * a line. A quarter of a point is finer than anybody can see and coarse enough
 * to terminate quickly; the floor stops a runaway box from producing text
 * nobody could read anyway.
 *
 * Wrapping goes through `wrapLines`, the same function the drawing path uses.
 * That shared call is the whole point of this function existing here rather
 * than in a caller.
 */
export function shrinkToFit(
  doc: Doc,
  text: string,
  maxWidth: number,
  maxHeight: number,
  style: TextStyle,
  lineHeightRatio = 1.45,
  floor = 5,
): number {
  for (let size = style.size; size >= floor; size -= 0.25) {
    const lines = wrapLines(doc, text, maxWidth, { ...style, size });
    if (lines.length * size * lineHeightRatio <= maxHeight) return size;
  }

  return floor;
}

/** Centres a mixed-script string on `centreX`. The measuring twin of `runTextRight`. */
export function runTextCentre(
  doc: Doc,
  text: string,
  centreX: number,
  y: number,
  style: TextStyle,
): void {
  runText(doc, text, centreX - measureRuns(doc, text, style) / 2, y, style);
}

/**
 * A filled and/or stroked rectangle.
 *
 * `save`/`restore` around it because PDFKit's fill colour is document state:
 * without them the next `runText` inherits whatever this painted, and the
 * symptom is a table heading that turns the rest of the page grey.
 */
export function filledBox(
  doc: Doc,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string | null,
  stroke: string | null = null,
  radius = 0,
): void {
  if (!fill && !stroke) return;

  doc.save();
  if (radius > 0) doc.roundedRect(x, y, width, height, radius);
  else doc.rect(x, y, width, height);

  if (fill && stroke) doc.fillColor(fill).strokeColor(stroke).lineWidth(0.5).fillAndStroke();
  else if (fill) doc.fillColor(fill).fill();
  else if (stroke) doc.strokeColor(stroke).lineWidth(0.5).stroke();

  doc.restore();
}

/**
 * `lineWidth` is a parameter because `rule.thickness` is a real, stored field.
 *
 * It was declared on the element type, carried through `resolveElement`, and
 * then dropped: `drawElement` called this without it and this hardcoded 0.5, so
 * a thickness the operator set had no effect on the page. The table's own row
 * separators keep the default by omitting the argument.
 */
export function horizontalRule(
  doc: Doc,
  x: number,
  y: number,
  width: number,
  colour = '#DDDDDD',
  lineWidth = 0.5,
): void {
  doc
    .save()
    .moveTo(x, y)
    .lineTo(x + width, y)
    .lineWidth(lineWidth)
    .strokeColor(colour)
    .stroke()
    .restore();
}

/**
 * A 14pt colour swatch, or a two-letter ring when the colour has no hex.
 *
 * Fields owns the hex — this only reads it. The ring fallback matters because
 * a colour set up before `stock.colour` gained hex values has none, and
 * drawing it as a default grey square would state that the tile is grey.
 */
export function colourChip(doc: Doc, chip: DocumentColourChip, x: number, y: number): number {
  const size = 9;

  if (chip.hex) {
    doc.save().rect(x, y, size, size).fillColor(chip.hex).fill().restore();
    doc
      .save()
      .rect(x, y, size, size)
      .lineWidth(0.4)
      .strokeColor('#00000022')
      .stroke()
      .restore();
  } else {
    doc
      .save()
      .rect(x, y, size, size)
      .lineWidth(0.6)
      .strokeColor('#999999')
      .stroke()
      .restore();

    doc
      .font(faceFor('body'))
      .fontSize(4.5)
      .fillColor('#666666')
      .text(chip.colour.slice(0, 2).toUpperCase(), x + 1, y + 2.2, { lineBreak: false });
  }

  return x + size + 3;
}

/**
 * The diagonal watermark, drawn under everything else.
 *
 * Called before the page's content so the content sits on top; PDFKit paints
 * in call order and has no z-index.
 */
export function watermark(doc: Doc, text: string, pageWidth: number, pageHeight: number): void {
  doc
    .save()
    .translate(pageWidth / 2, pageHeight / 2)
    .rotate(-35)
    .font(faceFor('body', true))
    .fontSize(64)
    .fillColor('#000000')
    .opacity(0.07)
    .text(text, -pageWidth / 2, -32, { width: pageWidth, align: 'center', lineBreak: false })
    .opacity(1)
    .restore();
}

export function pageFooter(
  doc: Doc,
  options: {
    text: string | null;
    pageNumber: number | null;
    x: number;
    y: number;
    width: number;
  },
): void {
  if (options.text) {
    runText(doc, options.text, options.x, options.y, { size: 7, colour: '#888888' });
  }

  if (options.pageNumber !== null) {
    runTextRight(doc, `Page ${options.pageNumber}`, options.x + options.width, options.y, {
      size: 7,
      colour: '#888888',
      script: 'mono',
    });
  }
}

/** A label/value stack, for the party block and the header's right-hand column. */
export function keyValueBlock(
  doc: Doc,
  entries: Array<{ label: string; value: string }>,
  x: number,
  y: number,
  lineHeight = 11,
): number {
  let cursor = y;

  for (const entry of entries) {
    const labelEnd = runText(doc, `${entry.label} `, x, cursor, {
      size: 8,
      colour: '#777777',
    });
    runText(doc, entry.value, labelEnd, cursor, { size: 8, colour: '#111111' });
    cursor += lineHeight;
  }

  return cursor;
}
