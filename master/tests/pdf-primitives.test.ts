/**
 * The measuring half of the PDF primitives.
 *
 * Pure in the sense that matters here: it drives a real `PDFDocument` with the
 * real vendored faces, but writes nothing and needs no cluster. Measurement is
 * the thing being tested, and a stub would measure nothing.
 *
 * The claim under test: a string is measured in the very face it is drawn in
 * (body, bold or mono), so a column never overlaps its neighbour.
 */

import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';

import { registerFonts } from '../src/pdf/fonts.js';
import {
  MM_TO_PT,
  measureRuns,
  mm,
  truncateToWidth,
  wrapLines,
  type TextStyle,
} from '../src/pdf/primitives.js';

const STYLE: TextStyle = { size: 10 };

/** A document nothing is written to — it exists to own the font registry. */
function measuringDoc(): typeof PDFDocument.prototype {
  const doc = new PDFDocument({ autoFirstPage: false });
  registerFonts(doc);
  return doc;
}

describe('pdf primitives', () => {
  it('PDF-80: a string is measured in the face its style names: bold is wider, mono differs', () => {
    const doc = measuringDoc();
    const text = 'Sharma Tiles (Morbi)';

    const regular = measureRuns(doc, text, STYLE);
    const bold = measureRuns(doc, text, { ...STYLE, bold: true });
    const mono = measureRuns(doc, text, { ...STYLE, script: 'mono' });

    expect(regular).toBeGreaterThan(0);
    expect(Number.isFinite(regular)).toBe(true);
    expect(bold).toBeGreaterThan(regular);
    expect(mono).not.toBe(regular);
  });

  it('PDF-80: truncateToWidth keeps what fits and ends in an ellipsis, ', () => {
    const doc = measuringDoc();
    const text = 'Sharma Tiles (Sharma Tiles) — Morbi, Gujarat';
    const width = mm(25);

    const truncated = truncateToWidth(doc, text, width, STYLE);

    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated.length).toBeLessThan(text.length);
    expect(text.startsWith(truncated.slice(0, -1))).toBe(true);
    expect(measureRuns(doc, truncated, STYLE)).toBeLessThanOrEqual(width);

    // A string that already fits comes back untouched, ellipsis and all.
    expect(truncateToWidth(doc, text, mm(200), STYLE)).toBe(text);
  });

  it('PDF-81: wrapLines breaks between words so every line fits, and keeps a typed newline', () => {
    const doc = measuringDoc();
    const text = 'Sharma Tiles (Sharma Tiles) Station Road, Morbi, Gujarat';
    const width = mm(25);

    const lines = wrapLines(doc, text, width, STYLE);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureRuns(doc, line, STYLE)).toBeLessThanOrEqual(width);
    // Word boundaries only: joining the lines gives the text back.
    expect(lines.join(' ')).toBe(text);

    expect(wrapLines(doc, 'One\nTwo', mm(200), STYLE)).toEqual(['One', 'Two']);
  });

  it('PDF-80: a millimetre is 72/25.4 points, and mm() agrees with it', () => {
    expect(MM_TO_PT).toBeCloseTo(2.8346, 4);
    expect(mm(210)).toBeCloseTo(595.28, 1);
  });
});
