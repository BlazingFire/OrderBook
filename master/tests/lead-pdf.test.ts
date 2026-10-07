/**
 * The table renderer behind the report PDFs: how a cell wraps and where a page breaks. (The pending order PDF is no
 * longer a table: it is the note's sheet, `note-pdf.test.ts`.)
 *
 * No cluster: the renderer draws with the real vendored faces into memory.
 */

import PDFDocument from 'pdfkit';
import { describe, expect, it, vi } from 'vitest';

import { registerFonts } from '../src/pdf/fonts.js';
import { measureRuns } from '../src/pdf/primitives.js';
import type * as Primitives from '../src/pdf/primitives.js';
import { cellLines, renderReportPdf } from '../src/pdf/table-renderer.js';

/*
 * Every string the renderer draws, in order. The page streams are compressed,
 * so what prints is read at the draw call rather than out of the bytes — and
 * passed straight through, so every case here draws exactly as it would.
 * Without it, a renderer that drew only the first line of a wrapped cell, or
 * no party block at all, still produced a valid `%PDF-`.
 */
const drawn = vi.hoisted((): string[] => []);
vi.mock('../src/pdf/primitives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Primitives>();
  return {
    ...actual,
    runText: (...args: Parameters<typeof actual.runText>) => {
      drawn.push(args[1]);
      return actual.runText(...args);
    },
    runTextRight: (...args: Parameters<typeof actual.runTextRight>) => {
      drawn.push(args[1]);
      actual.runTextRight(...args);
    },
  };
});

describe('table renderer — cells', () => {
  const doc = new PDFDocument({ autoFirstPage: false });
  registerFonts(doc);
  const style = { size: 9 };

  it('wraps a text cell into lines that fit, keeping every colour with its count', () => {
    const text = 'White ×10, Ivory ×5, Pink ×4, Rustic Coffee Brown ×12, Sky Blue ×1';
    const width = 70;

    const lines = cellLines(doc, text, width, style, false);

    expect(lines.length).toBeGreaterThan(1);
    for (const wrapped of lines) {
      expect(measureRuns(doc, wrapped, style)).toBeLessThanOrEqual(width);
      expect(wrapped).not.toContain('…');
    }
    // Nothing lost, nothing reordered.
    expect(lines.join(' ')).toBe(text);
    // A colour never parts from its count.
    expect(lines.some((wrapped) => /^×/.test(wrapped))).toBe(false);
    // Not even inside an entry too wide for the column on its own: the word
    // before the count goes down with it. A plain word wrap left `×5,` alone.
    const name = 'Rustic Coffee Brown';
    expect(
      cellLines(doc, `${name} ×5, Sky Blue ×6`, measureRuns(doc, name, style) + 1, style, false),
    ).toEqual(['Rustic Coffee', 'Brown ×5,', 'Sky Blue ×6']);
    // And entries share a line while they fit: a row is no taller than it has to be.
    expect(cellLines(doc, 'White ×10, Ivory ×5', 200, style, false)).toEqual([
      'White ×10, Ivory ×5',
    ]);
  });

  it('keeps a figure on one line, and cuts only a single word too wide to fit', () => {
    // Spaced, so a figure sent down the text path would wrap rather than pass.
    const [figure, ...more] = cellLines(doc, '1 234 567 890', 20, style, true);
    expect(more).toEqual([]);
    expect(figure!.endsWith('…')).toBe(true);
    expect(cellLines(doc, '', 20, style, false)).toEqual([]);

    const [cut] = cellLines(doc, 'Supercalifragilistic', 30, style, false);
    expect(cut!.endsWith('…')).toBe(true);
  });

  it('breaks the page on the grown row height, so no wrapped row runs off the sheet', async () => {
    // Ten lines a row whatever the width: a typed newline always breaks.
    const tenLines = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join('\n');
    const rows = Array.from({ length: 42 }, () => [tenLines]);

    const bytes = await renderReportPdf({
      title: 'Grown rows',
      columns: [{ label: 'Text' }],
      rows,
      paperSize: 'a4',
      orientation: 'portrait',
    });

    // 16pt + 9 more lines at 11pt each, against an A4 page less its 12mm
    // margins: the least number of pages those rows can honestly fill. A break
    // tested against the one-line height fits one row too many on each page.
    const rowHeight = 16 + 9 * 11;
    const pageHeight = 841.89 - 2 * 12 * (72 / 25.4);
    const pages = bytes.toString('latin1').match(/\/Type \/Page\b(?!s)/g)?.length ?? 0;

    expect(pages).toBeGreaterThanOrEqual(Math.ceil((rows.length * rowHeight) / pageHeight));
  });
});
