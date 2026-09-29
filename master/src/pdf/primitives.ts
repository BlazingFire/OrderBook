/**
 * Drawing primitives over PDFKit. Infrastructure — no business rule reaches
 * this file, and none may be added: if a column is not in the table it is not
 * drawn, and there is nothing here that could decide otherwise.
 *
 * `runText` is the load-bearing one. PDFKit binds **one font per `text()`
 * call**, so a line mixing scripts — "शर्मा टाइल्स (Sharma Tiles)" is an
 * ordinary party name in this business — has to be drawn as several calls that
 * share a baseline. Doing it any other way renders the Devanagari half as
 * blank boxes in the Latin face.
 */

import type PDFDocument from 'pdfkit';

import { faceFor } from './fonts.js';
import { splitByScript, type ScriptTag } from './text.js';

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
 * wraps here: a caller that wants several lines breaks them with `wrapLines`
 * first and draws each one. The table does exactly that, and measures the grown
 * row before it decides on a page break, so a wrapped cell moves the rows below
 * it by an amount it chose rather than one it discovered.
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

/**
 * Word-wraps a mixed-script string into lines no wider than `maxWidth`,
 * without drawing anything.
 *
 * Measuring and drawing share it, so they cannot disagree: whatever decides how
 * tall a cell is has to break the text into exactly the lines that will be
 * drawn, and a second, nearly identical implementation is how "the last line
 * got cut off" happens.
 *
 * A newline the operator typed is kept as a break — re-flowing across it would
 * silently join two paragraphs. A single word wider than `maxWidth` is left on
 * a line of its own, still too wide; cutting it is the caller's decision
 * (`truncateToWidth`), because only the caller knows whether a clipped word is
 * acceptable where it is going.
 */
export function wrapLines(doc: Doc, text: string, maxWidth: number, style: TextStyle): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);

    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';

    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;

      if (line.length > 0 && measureRuns(doc, candidate, style) > maxWidth) {
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

export function runTextRight(
  doc: Doc,
  text: string,
  rightEdge: number,
  y: number,
  style: TextStyle,
): void {
  runText(doc, text, rightEdge - measureRuns(doc, text, style), y, style);
}

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
