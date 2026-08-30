/**
 * Pages, and what rides the table (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * A quotation with three lines and one with two hundred are the same template.
 * What differs is how far down the page the totals land and how many sheets
 * come out, and those two facts are the whole of the flow model:
 *
 *   · the header band repeats on every page, the footer band is written in the
 *     second pass because "Page 2 of 5" cannot be written before page 5 exists;
 *   · elements below the table move by **one delta**, applied once, and only if
 *     they asked to.
 *
 * Real PDFKit, read back through pdfjs. No database: `renderPdf` takes a model,
 * and a model is a plain object, so this needs no cluster and cannot silently
 * skip.
 */

import { describe, expect, it } from 'vitest';

import { textStyle, type DocumentElement } from '@orderbook/shared';

import { renderPdf } from '../src/pdf/renderer.js';
import type { DocumentModel, ResolvedElement } from '../src/domain/document-model.js';

interface Placed {
  text: string;
  x: number;
  y: number;
  page: number;
}

/** Every text item with the page it landed on and where. */
async function placedText(bytes: Buffer): Promise<Placed[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
    .promise;

  const out: Placed[] = [];

  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();

    for (const item of content.items) {
      if (!('str' in item) || item.str.trim().length === 0) continue;
      const transform = (item as { transform: number[] }).transform;
      out.push({ text: item.str, x: transform[4] ?? 0, y: transform[5] ?? 0, page });
    }
  }

  return out;
}

const OPTIONS = {
  paperSize: 'A4' as const,
  orientation: 'portrait' as const,
  margins: { top: 18, right: 15, bottom: 18, left: 15 },
  logo: null,
  signature: null,
};

const TABLE: ResolvedElement = {
  id: 'table',
  kind: 'table',
  columns: [],
  rowHeightMm: 5.6444,
  headingHeightMm: 6.35,
  repeatHeadingOnBreak: true,
  headingFill: '#F4F4F5',
  groupByProduct: false,
  headingStyle: textStyle({ size: 7.5, bold: true, colour: '#444444' }),
  cellStyle: textStyle({ size: 8 }),
  x: 15,
  y: 60,
  w: 180,
  h: 60,
  z: 5,
  band: 'body',
  flow: 'fixed',
};

function textElement(patch: Partial<DocumentElement> & { id: string }): ResolvedElement {
  return {
    kind: 'text',
    text: patch.id,
    label: null,
    labelPlacement: 'none',
    style: textStyle({ size: 9 }),
    x: 15,
    y: 130,
    w: 80,
    h: 8,
    z: 9,
    band: 'body',
    flow: 'fixed',
    ...patch,
  } as ResolvedElement;
}

function model(rowCount: number, extra: ResolvedElement[] = []): DocumentModel {
  return {
    title: 'Quotation',
    companyName: 'Smruti Ceramics',
    reference: 'LD0000000001',
    issuedOn: '20 Aug 2026',
    party: null,
    columns: [
      { key: 'sequence', heading: 'No', align: 'left', weight: 6, script: 'mono' },
      { key: 'product', heading: 'Product', align: 'left', weight: 40, script: 'body' },
      { key: 'quantity', heading: 'Boxes', align: 'right', weight: 12, script: 'mono' },
    ],
    rows: Array.from({ length: rowCount }, (_, index) => ({
      cells: {
        sequence: String(index + 1),
        product: `Tile ${index + 1}`,
        quantity: String((index % 9) + 1),
      },
      chips: [],
    })),
    totals: null,
    terms: null,
    signatureLabel: null,
    watermark: null,
    footer: 'Smruti Ceramics',
    accentColour: null,
    elements: [textElement({ id: 'BANNER', band: 'header', y: 20, z: 1 }), TABLE, ...extra],
    ratesIncluded: false,
    showColourChips: false,
    showPageNumbers: true,
  };
}

describe('page flow', () => {
  it('PDF-84: two hundred rows spill onto more pages, and the furniture repeats', async () => {
    const { bytes, pageCount } = await renderPdf(model(200), OPTIONS);

    expect(pageCount).toBeGreaterThan(1);

    const items = await placedText(bytes);
    const pages = new Set(items.map((item) => item.page));

    // The header band is drawn as each page opens, so it appears once per page
    // — never twice on one, never missing from the second.
    for (const page of pages) {
      const banners = items.filter((item) => item.page === page && item.text === 'BANNER');
      expect(banners, `page ${page}`).toHaveLength(1);
    }

    // And the table's heading row comes back at the top of each page, because
    // a column of numbers with no heading on page two is unreadable.
    for (const page of pages) {
      const headings = items.filter((item) => item.page === page && item.text === 'Product');
      expect(headings.length, `page ${page} heading`).toBeGreaterThanOrEqual(1);
    }

    // Every row printed, exactly once.
    expect(items.filter((item) => item.text === 'Tile 1')).toHaveLength(1);
    expect(items.filter((item) => item.text === 'Tile 200')).toHaveLength(1);
  });

  it('PDF-84: a body element below the table is drawn once, not once per page', async () => {
    const { bytes } = await renderPdf(
      model(200, [textElement({ id: 'ONCE', y: 130, flow: 'after-table' })]),
      OPTIONS,
    );

    const items = await placedText(bytes);
    expect(items.filter((item) => item.text === 'ONCE')).toHaveLength(1);
  });

  it('PDF-85: an after-table element moves with the table; a fixed one does not', async () => {
    const extra = [
      textElement({ id: 'RIDES', y: 130, flow: 'after-table' }),
      textElement({ id: 'STAYS', y: 140, flow: 'fixed', x: 110 }),
    ];

    const short = await placedText((await renderPdf(model(3, extra), OPTIONS)).bytes);
    const long = await placedText((await renderPdf(model(30, extra), OPTIONS)).bytes);

    const find = (items: Placed[], text: string): Placed | undefined =>
      items.find((item) => item.text === text);

    const ridesShort = find(short, 'RIDES');
    const ridesLong = find(long, 'RIDES');
    const staysShort = find(short, 'STAYS');
    const staysLong = find(long, 'STAYS');

    expect(ridesShort).toBeDefined();
    expect(ridesLong).toBeDefined();

    // PDF's y grows upward, so further down the page is a smaller number.
    expect(ridesLong!.y).toBeLessThan(ridesShort!.y);

    // The fixed one is where it was put, whatever the table did.
    expect(staysLong!.y).toBeCloseTo(staysShort!.y, 1);
  });

  it('PDF-85: fewer rows than the design assumed pulls the block upward', async () => {
    // The delta is signed. A table designed 60mm tall carrying one row leaves a
    // hole, and an element that asked to follow the table should close it
    // rather than sitting where a longer order would have put it.
    const extra = [textElement({ id: 'RIDES', y: 130, flow: 'after-table' })];

    const one = await placedText((await renderPdf(model(1, extra), OPTIONS)).bytes);
    const many = await placedText((await renderPdf(model(12, extra), OPTIONS)).bytes);

    expect(one.find((item) => item.text === 'RIDES')!.y).toBeGreaterThan(
      many.find((item) => item.text === 'RIDES')!.y,
    );
  });

  it('PDF-84: a footer-band element appears on every page', async () => {
    const { bytes, pageCount } = await renderPdf(
      model(200, [textElement({ id: 'FOOT', band: 'footer', y: 285, z: 20 })]),
      OPTIONS,
    );

    const items = await placedText(bytes);

    // Written in the second pass, alongside "Page N of M", because that is the
    // only moment the page count is known.
    expect(items.filter((item) => item.text === 'FOOT')).toHaveLength(pageCount);
  });
});
