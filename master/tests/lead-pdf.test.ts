/**
 * The lead PDF (`docs/catalogue/CATALOGUE_MODEL.md` §8): what prints in which
 * column, decided by the pure `leadPdfTable`, and the renderer's wrapping of
 * the cells it is handed.
 *
 * No cluster: the builder is pure and the renderer draws with the real
 * vendored faces into memory. What the owner reads off the printed page is the
 * claim — `1111` under Code, never a colour for a numbered designer piece,
 * `White ×10, Ivory ×5` on one row, a Brand column only when it says
 * something — and none of it can be seen by a test that only checks a route
 * answered 200.
 */

import PDFDocument from 'pdfkit';
import { describe, expect, it, vi } from 'vitest';
import type { Lead, LineItem, Party } from '@orderbook/shared';

import { leadPdfTable } from '../src/domain/lead-pdf.js';
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

let nextId = 0;

function line(overrides: Partial<LineItem>): LineItem {
  nextId += 1;
  return {
    id: `LI${nextId}`,
    tenantId: 't',
    parentType: 'lead',
    parentId: 'LD1',
    productId: `P${nextId}`,
    variantId: `V${nextId}`,
    productName: 'DAMRU',
    categoryName: 'One Piece Toilet',
    categoryCode: 'OPT',
    brandName: 'Swisware+',
    alias: null,
    code: `OPT-000${nextId}`,
    variantLabel: null,
    colour: null,
    size: 'L-27, B-15, H-26',
    weightKg: null,
    packaging: null,
    grade: null,
    sequence: nextId,
    fromPartyVariant: false,
    imagePath: null,
    notes: null,
    quantity: 1,
    lineWeightKg: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function lead(items: LineItem[]): Lead {
  return {
    id: 'LD0000000042',
    tenantId: 't',
    partyId: 'PT1',
    partyName: 'Sharma Tiles',
    ownerId: 'u',
    ownerName: null,
    stageId: 's',
    stageName: 'New',
    stageSequence: 1,
    sourcePlatform: null,
    followUpDate: null,
    partyWiseMode: false,
    notes: null,
    customFields: {},
    incomplete: false,
    missingFields: [],
    convertedOrderId: null,
    convertedAt: null,
    totalWeightKg: 0,
    linesWithoutWeight: items.length,
    sourcePanelId: null,
    createdByUserId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    sync: { version: 1, hlc: 'h', fieldHlc: {}, temporaryId: null },
    items,
    timeline: [],
  };
}

const PARTY = {
  name: 'Sharma Tiles',
  addressLine1: '12 Station Road',
  addressLine2: null,
  city: 'Morbi',
  state: 'Gujarat',
  pincode: '363641',
  phone: '9800000000',
  gstNumber: '24ABCDE1234F1Z5',
} as Party;

/** The table as `{heading: cell}` per row, so a test names columns, not positions. */
function build(items: LineItem[]) {
  const table = leadPdfTable(lead(items), PARTY, 'Swisware Ceramics', '2026-09-29');
  const headings = table.columns.map((column) => column.label);
  const rows = table.rows.map((row) =>
    Object.fromEntries(headings.map((heading, index) => [heading, row[index]])),
  );
  return { table, headings, rows };
}

describe('lead PDF — the table', () => {
  it('prints a numbered sub product under Code and a named one under Model, never both', () => {
    const { rows } = build([line({ productName: '1111' }), line({ productName: '102 (9")' })]);

    expect(rows[0]).toMatchObject({ Model: '', Code: '1111' });
    // Starts with digits, but is a name: the rule is about what is printed.
    expect(rows[1]).toMatchObject({ Model: '102 (9")', Code: '' });
    // The software code is internal and prints nowhere.
    expect(JSON.stringify(rows)).not.toContain('OPT-000');
  });

  it('shows a fixed colour, hides it when it repeats the name, and never shows a dedicated one', () => {
    const { rows } = build([
      line({ productName: 'DIAMOND', variantLabel: 'White' }),
      line({ productName: 'MAGENTA', variantLabel: 'Magenta' }),
      // Dedicated: no label, not multi-colour — the design is the colour.
      line({ productName: '1111', variantLabel: null, colour: null }),
    ]);

    expect(rows.map((row) => row.Colour)).toEqual(['White', '', '']);
  });

  it('groups the colours of one multicolour sub product onto one row, pieces summed', () => {
    const { rows } = build([
      line({ variantId: 'V-ORISSA', productName: 'ORISSA PAN', colour: 'White', quantity: 10 }),
      line({ productName: '1111', quantity: 2 }),
      line({ variantId: 'V-ORISSA', productName: 'ORISSA PAN', colour: 'Ivory', quantity: 5 }),
      line({ variantId: 'V-ORISSA', productName: 'ORISSA PAN', colour: 'white', quantity: 1 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      '#': '1',
      Model: 'ORISSA PAN',
      Colour: 'White ×11, Ivory ×5',
      Qty: '16',
    });
    expect(rows[1]).toMatchObject({ '#': '2', Code: '1111', Qty: '2' });
  });

  it('adds the Brand column only when the lines span more than one brand', () => {
    const oneBrand = build([
      line({ brandName: 'Swisware+' }),
      line({ brandName: 'swisware+ ' }),
      line({ brandName: null }),
    ]);
    expect(oneBrand.headings).toEqual([
      '#',
      'Main product',
      'Model',
      'Size',
      'Colour',
      'Code',
      'Qty',
    ]);

    const twoBrands = build([line({ brandName: 'Swisware+' }), line({ brandName: 'Vitrosa' })]);
    expect(twoBrands.headings).toEqual([
      '#',
      'Brand',
      'Main product',
      'Model',
      'Size',
      'Colour',
      'Code',
      'Qty',
    ]);
    expect(twoBrands.rows.map((row) => row.Brand)).toEqual(['Swisware+', 'Vitrosa']);
    // Every row is exactly as wide as the headings.
    expect(twoBrands.table.rows.every((row) => row.length === 8)).toBe(true);
  });

  it('heads the page with the PO number when the lead has one, its id otherwise', () => {
    const numbered = leadPdfTable({ ...lead([line({})]), poNumber: 'PO/2026-27/00042' }, PARTY, 'Swisware Ceramics', '2026-09-29');
    expect(numbered.subtitle).toBe('Pending order PO/2026-27/00042 · 2026-09-29');
    // An old Master's lead, or one restored before numbering ran, has no number.
    expect(build([line({})]).table.subtitle).toBe('Pending order LD0000000042 · 2026-09-29');
  });

  it('heads the page with the company, the lead and the party, and names no money', () => {
    const { table } = build([line({})]);

    expect(table.title).toBe('Swisware Ceramics');
    expect(table.subtitle).toBe('Pending order LD0000000042 · 2026-09-29');
    expect(table.preamble).toEqual([
      'Sharma Tiles',
      '12 Station Road',
      'Morbi Gujarat 363641',
      '9800000000',
      'GST: 24ABCDE1234F1Z5',
    ]);
    expect(JSON.stringify(table)).not.toMatch(
      /\b(prices?|pricing|rates?|amounts?|discounts?|rupees?|paise|total)\b|₹/i,
    );
  });

  it('falls back to the lead’s party name when the party record is gone', () => {
    const table = leadPdfTable(lead([line({})]), null, 'Swisware Ceramics', '2026-09-29');
    expect(table.preamble).toEqual(['Sharma Tiles']);
  });
});

describe('lead PDF — rendering', () => {
  it('renders a PDF with wrapped cells', async () => {
    const colours = ['White', 'Ivory', 'Pink', 'Black', 'Rustic Coffee Brown', 'Sky Blue'];
    const { table } = build(
      colours.map((colour, index) =>
        line({ variantId: 'V-MANY', productName: 'WATER CLOSET', colour, quantity: index + 1 }),
      ),
    );

    const bytes = await renderReportPdf(table);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The Latin face is embedded, so every word prints as glyphs.
    expect(bytes.toString('latin1')).toMatch(/Inter/);
  });

  it('prints every line of a wrapped cell, and the party block once however many pages', async () => {
    const colours = ['White', 'Ivory', 'Pink', 'Black', 'Rustic Coffee Brown', 'Sky Blue'];
    const { table } = build([
      ...colours.map((colour, index) =>
        line({ variantId: 'V-MANY', productName: 'WATER CLOSET', colour, quantity: index + 1 }),
      ),
      // Enough one-line rows after it to run onto a second page.
      ...Array.from({ length: 60 }, (_, index) => line({ productName: `E-${index + 1}` })),
    ]);

    drawn.length = 0;
    await renderReportPdf(table);

    // The Colour cell wrapped, every line of it printed one after another, and
    // no count on a line apart from its colour — at the real column width.
    const colourCell =
      table.rows[0]![table.columns.findIndex((column) => column.label === 'Colour')]!;
    expect(drawn.filter((text) => text.includes('×')).length).toBeGreaterThan(1);
    expect(drawn.join(' ')).toContain(colourCell);
    expect(drawn.filter((text) => text.startsWith('×'))).toEqual([]);

    // A header row on every page — and still one party block.
    expect(drawn.filter((text) => text === 'Main product').length).toBeGreaterThan(1);
    for (const partyLine of table.preamble ?? []) {
      expect(
        drawn.filter((text) => text === partyLine),
        partyLine,
      ).toHaveLength(1);
    }
  });
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

  it('gives the lead PDF’s figure columns room for their figures, Brand column or not', () => {
    // The renderer's own arithmetic: an A4 page less 12mm margins, shared by
    // weight, less the 6pt gutter. A figure never wraps, so one that does not
    // fit prints cut — row 100 as `1…`.
    const usable = 595.28 - 2 * 12 * (72 / 25.4);
    const widest: Record<string, string> = { '#': '999', Code: '7953', Qty: '99999' };

    for (const brands of [['Swisware+'], ['Swisware+', 'Vitrosa']]) {
      const { table } = build(brands.map((brandName) => line({ brandName })));
      const total = table.columns.reduce((sum, column) => sum + (column.weight ?? 0), 0);
      for (const column of table.columns.filter((each) => each.numeric)) {
        const room = (usable * (column.weight ?? 0)) / total - 6;
        expect(measureRuns(doc, widest[column.label]!, style), column.label).toBeLessThanOrEqual(
          room,
        );
      }
    }
  });
});
