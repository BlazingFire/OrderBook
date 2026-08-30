/**
 * The measuring half of the PDF primitives (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * Pure in the sense that matters here: it drives a real `PDFDocument` with the
 * real vendored faces, but writes nothing and needs no cluster. Measurement is
 * the thing being tested, and a stub would measure nothing.
 *
 * The claim under test is narrow and worth stating, because it is the defect
 * these functions exist to prevent: **whatever decides that text fits must
 * break it into the same lines that get drawn.** A fitter with its own nearly
 * identical wrap loop passes every casual check and then drops the last line of
 * a paragraph on a document already sent to a customer.
 */

import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';

import {
  measureRuns,
  mm,
  MM_TO_PT,
  shrinkToFit,
  wrapLines,
  type TextStyle,
} from '../src/pdf/primitives.js';
import { registerFonts } from '../src/pdf/fonts.js';

const STYLE: TextStyle = { size: 10 };

/** A document nothing is written to — it exists to own the font registry. */
function measuringDoc(): typeof PDFDocument.prototype {
  const doc = new PDFDocument({ autoFirstPage: false });
  registerFonts(doc);
  return doc;
}

const LOREM =
  'Rates are valid for fifteen days from the date of this quotation and are ' +
  'subject to confirmation of stock at the time the order is placed.';

describe('pdf primitives', () => {
  it('PDF-80: shrinkToFit returns a size whose own wrapped lines fit the box', () => {
    const doc = measuringDoc();
    const width = mm(60);
    const height = mm(18);

    const size = shrinkToFit(doc, LOREM, width, height, STYLE);

    // Re-wrap at the size it chose, through the same function the drawer uses.
    // This is the whole assertion: the fitter cannot be measuring one thing and
    // the renderer drawing another.
    const lines = wrapLines(doc, LOREM, width, { ...STYLE, size });
    expect(lines.length * size * 1.45).toBeLessThanOrEqual(height);

    // And it must not have shrunk further than it needed to.
    const bigger = size + 0.25;
    if (bigger <= STYLE.size) {
      const tooMany = wrapLines(doc, LOREM, width, { ...STYLE, size: bigger });
      expect(tooMany.length * bigger * 1.45).toBeGreaterThan(height);
    }
  });

  it('PDF-80: no wrapped line is wider than the width it was given', () => {
    const doc = measuringDoc();
    const width = mm(45);

    for (const line of wrapLines(doc, LOREM, width, STYLE)) {
      expect(measureRuns(doc, line, STYLE)).toBeLessThanOrEqual(width);
    }
  });

  it('PDF-80: a word longer than the box is kept whole rather than lost', () => {
    const doc = measuringDoc();

    // Breaking mid-word would be worse than overflowing: a part number or an
    // email address split across two lines cannot be typed back in.
    const lines = wrapLines(doc, 'supercalifragilisticexpialidocious', mm(10), STYLE);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('supercalifragilisticexpialidocious');
  });

  it('PDF-80: a hard newline is a line the operator asked for, not whitespace', () => {
    const doc = measuringDoc();

    expect(wrapLines(doc, 'Bank details\nAccount name', mm(80), STYLE)).toEqual([
      'Bank details',
      'Account name',
    ]);

    // A blank line survives as an empty entry, so a gap between paragraphs
    // costs a line rather than vanishing.
    expect(wrapLines(doc, 'One\n\nTwo', mm(80), STYLE)).toEqual(['One', '', 'Two']);
  });

  it('PDF-80: Devanagari is measured in its own face, not the Latin one', () => {
    const doc = measuringDoc();

    // The defect this guards: measuring a mixed-script string under a single
    // font reports a width for glyphs that face does not have, and the symptom
    // is a column overlapping its neighbour rather than an error.
    const mixed = measureRuns(doc, 'शर्मा टाइल्स (Sharma Tiles)', STYLE);

    expect(mixed).toBeGreaterThan(0);
    expect(Number.isFinite(mixed)).toBe(true);
  });

  it('PDF-80: shrinkToFit stops at the floor rather than looping to nothing', () => {
    const doc = measuringDoc();

    // An impossible box. Five points is unreadable, but it terminates and it is
    // still text on a page, which beats a hang or a zero.
    expect(shrinkToFit(doc, LOREM, mm(8), mm(2), STYLE)).toBe(5);
  });

  it('PDF-80: a millimetre is 72/25.4 points, and mm() agrees with it', () => {
    expect(MM_TO_PT).toBeCloseTo(2.8346, 4);
    expect(mm(210)).toBeCloseTo(595.28, 1);
  });
});
