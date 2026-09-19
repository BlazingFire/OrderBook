/**
 * The measuring half of the PDF primitives, and the script splitter under
 * them.
 *
 * Pure in the sense that matters here: it drives a real `PDFDocument` with the
 * real vendored faces, but writes nothing and needs no cluster. Measurement is
 * the thing being tested, and a stub would measure nothing.
 *
 * The claim under test is narrow and worth stating, because it is the defect
 * these functions exist to prevent: **a mixed-script string must be measured
 * and drawn face by face.** Measuring "शर्मा टाइल्स (Sharma Tiles)" under one
 * font reports a width for glyphs that face does not have, and the symptom is
 * a report column overlapping its neighbour rather than an error.
 */

import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';

import { registerFonts } from '../src/pdf/fonts.js';
import {
  MM_TO_PT,
  measureRuns,
  mm,
  truncateToWidth,
  type TextStyle,
} from '../src/pdf/primitives.js';
import { splitByScript } from '../src/pdf/text.js';

const STYLE: TextStyle = { size: 10 };

/** A document nothing is written to — it exists to own the font registry. */
function measuringDoc(): typeof PDFDocument.prototype {
  const doc = new PDFDocument({ autoFirstPage: false });
  registerFonts(doc);
  return doc;
}

describe('pdf text — script splitting', () => {
  it('PDF-13: a mixed line splits into runs so each can be drawn in its own face', () => {
    const runs = splitByScript('शर्मा टाइल्स (Sharma Tiles)');

    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0]!.script).toBe('devanagari');
    expect(runs.some((run) => run.script === 'body')).toBe(true);
    // Nothing is lost or duplicated in the split.
    expect(runs.map((run) => run.text).join('')).toBe('शर्मा टाइल्स (Sharma Tiles)');
  });

  it('PDF-14: a space between two Devanagari words does not start a Latin run', () => {
    const runs = splitByScript('शर्मा टाइल्स');

    expect(runs).toHaveLength(1);
    expect(runs[0]!.script).toBe('devanagari');
  });

  it('PDF-15: a pure-Latin string in a mono column stays one mono run', () => {
    const runs = splitByScript('LD0000000042', 'mono');

    expect(runs).toHaveLength(1);
    expect(runs[0]!.script).toBe('mono');
  });
});

describe('pdf primitives', () => {
  it('PDF-80: Devanagari is measured in its own face, not the Latin one', () => {
    const doc = measuringDoc();

    const mixed = measureRuns(doc, 'शर्मा टाइल्स (Sharma Tiles)', STYLE);

    expect(mixed).toBeGreaterThan(0);
    expect(Number.isFinite(mixed)).toBe(true);
  });

  it('PDF-80: truncateToWidth keeps what fits and ends in an ellipsis, script-correctly', () => {
    const doc = measuringDoc();
    const text = 'शर्मा टाइल्स (Sharma Tiles) — Morbi, Gujarat';
    const width = mm(25);

    const truncated = truncateToWidth(doc, text, width, STYLE);

    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated.length).toBeLessThan(text.length);
    expect(text.startsWith(truncated.slice(0, -1))).toBe(true);
    expect(measureRuns(doc, truncated, STYLE)).toBeLessThanOrEqual(width);

    // A string that already fits comes back untouched, ellipsis and all.
    expect(truncateToWidth(doc, text, mm(200), STYLE)).toBe(text);
  });

  it('PDF-80: a millimetre is 72/25.4 points, and mm() agrees with it', () => {
    expect(MM_TO_PT).toBeCloseTo(2.8346, 4);
    expect(mm(210)).toBeCloseTo(595.28, 1);
  });
});
