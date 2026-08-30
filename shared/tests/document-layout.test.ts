/**
 * The version 1 → version 2 layout conversion (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * The promise this file keeps is the one the owner cares about: **a template
 * that exists today must print the same after the conversion as before it.**
 * Every expected number below is the renderer's own — `master/src/pdf/renderer.ts`
 * draws in points, this converts to millimetres, and the two are pinned
 * together here rather than being allowed to drift.
 *
 * The geometry is duplicated on purpose. The shared package cannot import the
 * Master's PDF code without putting PDFKit into the browser's dependency
 * graph, so the numbers live in two places and this file is what stops them
 * disagreeing.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  blocksToElements,
  mmFromPt,
  normaliseLayout,
  pageSizeMm,
  PT_PER_MM,
  resetElementIds,
  type DocumentElement,
  type PageGeometry,
} from '../src/domain/document-layout.js';
import { TEMPLATE_DEFAULTS, type DocumentBlock } from '../src/domain/documents.js';

/** A4 portrait with the shipped default margins, which is what every default uses. */
const GEOMETRY: PageGeometry = {
  paperSize: 'A4',
  orientation: 'portrait',
  margins: { top: 18, right: 15, bottom: 18, left: 15 },
};

const LEFT = 15;
const RIGHT = 210 - 15;

const byKind = (elements: DocumentElement[], kind: string): DocumentElement[] =>
  elements.filter((element) => element.kind === kind);

const field = (elements: DocumentElement[], binding: string): DocumentElement | undefined =>
  elements.find(
    (element) =>
      element.kind === 'field' &&
      element.binding.source === 'catalogue' &&
      element.binding.binding === binding,
  );

beforeEach(resetElementIds);

describe('document layout conversion', () => {
  it('PDF-73: a millimetre is 72/25.4 points, and paper agrees with the renderer', () => {
    expect(PT_PER_MM).toBeCloseTo(2.8346, 4);

    // `PAGE_SIZES` in the renderer, in points: A4 595.28 x 841.89.
    const a4 = pageSizeMm('A4', 'portrait');
    expect(a4.width * PT_PER_MM).toBeCloseTo(595.28, 1);
    expect(a4.height * PT_PER_MM).toBeCloseTo(841.89, 1);

    const landscape = pageSizeMm('A4', 'landscape');
    expect(landscape.width).toBeCloseTo(297, 6);
    expect(landscape.height).toBeCloseTo(210, 6);
  });

  it('PDF-73: a header block converts to the same geometry drawHeader draws', () => {
    const elements = blocksToElements([{ kind: 'header', align: 'left' }], GEOMETRY, {
      hasLogo: true,
    });

    // drawHeader: logo at (left, y) fit 90x36.
    const [logo] = byKind(elements, 'image');
    expect(logo?.x).toBeCloseTo(LEFT, 6);
    expect(logo?.y).toBeCloseTo(18, 6);
    expect(logo?.w).toBeCloseTo(mmFromPt(90), 6);

    // Company name shifts right by 100pt when a logo is present.
    expect(field(elements, 'company.name')?.x).toBeCloseTo(LEFT + mmFromPt(100), 6);

    // Ref and Date sit at right - 150pt, on an 11pt step from y + 20pt.
    const ref = field(elements, 'document.reference');
    const issued = field(elements, 'document.issuedOn');
    expect(ref?.x).toBeCloseTo(RIGHT - mmFromPt(150), 6);
    expect(ref?.y).toBeCloseTo(18 + mmFromPt(20), 6);
    expect(issued?.y).toBeCloseTo(18 + mmFromPt(31), 6);

    // The rule sits 8pt above a block bottom that is always 52pt down.
    const [rule] = byKind(elements, 'rule');
    expect(rule?.y).toBeCloseTo(18 + mmFromPt(44), 6);

    // Everything in the header band repeats per page; nothing else does.
    for (const element of elements) expect(element.band).toBe('header');
  });

  it('PDF-73: a header with no logo starts the company name at the margin', () => {
    const elements = blocksToElements([{ kind: 'header', align: 'left' }], GEOMETRY, {
      hasLogo: false,
    });

    expect(byKind(elements, 'image')).toHaveLength(0);
    expect(field(elements, 'company.name')?.x).toBeCloseTo(LEFT, 6);
  });

  it('PDF-73: a party block keeps the To / name / address rhythm', () => {
    const elements = blocksToElements(
      [{ kind: 'header', align: 'left' }, { kind: 'party' }],
      GEOMETRY,
      { hasLogo: false },
    );

    // The header block always ends 52pt below where it started.
    const partyTop = 18 + mmFromPt(52);

    const label = elements.find((element) => element.kind === 'text');
    expect(label?.y).toBeCloseTo(partyTop, 6);

    expect(field(elements, 'party.name')?.y).toBeCloseTo(partyTop + mmFromPt(10), 6);
    expect(field(elements, 'party.addressLines')?.y).toBeCloseTo(partyTop + mmFromPt(24), 6);

    // The address wraps rather than truncating, and keeps its own line breaks.
    const address = field(elements, 'party.addressLines');
    expect(address?.kind === 'field' && address.style.fit).toBe('wrap');
  });

  it('PDF-73: a lines block becomes the one table, at the renderer’s row heights', () => {
    const elements = blocksToElements([{ kind: 'lines', groupByProduct: true }], GEOMETRY);
    const [table] = byKind(elements, 'table');

    expect(table).toBeDefined();
    if (table?.kind !== 'table') throw new Error('expected a table');

    expect(table.rowHeightMm).toBeCloseTo(mmFromPt(16), 6);
    expect(table.headingHeightMm).toBeCloseTo(mmFromPt(18), 6);
    expect(table.headingFill).toBe('#F4F4F5');
    expect(table.repeatHeadingOnBreak).toBe(true);
    expect(table.groupByProduct).toBe(true);

    // Columns stay empty in a converted layout: the model supplies them, which
    // is what keeps a rate column out of a rate-blind document.
    expect(table.columns).toEqual([]);

    expect(table.x).toBeCloseTo(LEFT, 6);
    expect(table.w).toBeCloseTo(RIGHT - LEFT, 6);
  });

  it('PDF-73: totals ride the table and the grand total is a separate binding', () => {
    const elements = blocksToElements(
      [
        { kind: 'lines', groupByProduct: false },
        { kind: 'totals', showBoxCount: true },
      ],
      GEOMETRY,
    );

    const boxes = field(elements, 'document.boxCount');
    const total = field(elements, 'document.grandTotal');

    expect(boxes).toBeDefined();
    expect(total).toBeDefined();

    // Both move with the table — a totals block under sixty rows is the whole
    // reason `after-table` exists.
    expect(boxes?.flow).toBe('after-table');
    expect(total?.flow).toBe('after-table');

    // Right-aligned against the right margin, label and value on one baseline.
    expect(total?.kind === 'field' && total.style.align).toBe('right');
    expect(total?.kind === 'field' && total.labelPlacement).toBe('before');
    expect((boxes?.x ?? 0) + (boxes?.w ?? 0)).toBeCloseTo(RIGHT, 6);
  });

  it('PDF-73: showBoxCount false drops the boxes line and nothing else', () => {
    const elements = blocksToElements([{ kind: 'totals', showBoxCount: false }], GEOMETRY);

    expect(field(elements, 'document.boxCount')).toBeUndefined();
    expect(field(elements, 'document.grandTotal')).toBeDefined();
  });

  it('PDF-73: a terms block takes its text from the template, not the block', () => {
    // The block carries a `text` field that `buildDocumentModel` has never
    // read — it uses the template's `termsText` column. Converting the block's
    // copy would resurrect a value that has never been printed.
    const elements = blocksToElements([{ kind: 'terms', text: 'never rendered' }], GEOMETRY);

    expect(JSON.stringify(elements)).not.toContain('never rendered');

    const terms = field(elements, 'document.terms');
    expect(terms?.kind === 'field' && terms.style.fit).toBe('wrap');
    expect(terms?.kind === 'field' && terms.style.maxChars).toBe(500);
    expect(terms?.w).toBeCloseTo((RIGHT - LEFT) * 0.7, 6);
  });

  it('PDF-73: a signature block converts to the bottom pin it already was', () => {
    // `drawSignature`'s clamp reduces to `bottomLimit - 62` for every input, so
    // the block has always printed at the foot of the page whatever its place
    // in the order. It converts to what it does, not to what the order implied.
    const early = blocksToElements(
      [
        { kind: 'signature', label: 'Authorised Signatory' },
        { kind: 'lines', groupByProduct: false },
      ],
      GEOMETRY,
    );
    const late = blocksToElements(
      [
        { kind: 'lines', groupByProduct: false },
        { kind: 'signature', label: 'Authorised Signatory' },
      ],
      GEOMETRY,
    );

    const topOf = (elements: DocumentElement[]): number | undefined =>
      elements.find((element) => element.kind === 'rule' && element.colour === '#999999')?.y;

    expect(topOf(early)).toBeCloseTo(topOf(late) ?? -1, 6);

    const label = late.find((element) => element.kind === 'text');
    expect(label?.kind === 'text' && label.text).toBe('Authorised Signatory');
  });

  it('PDF-73: every element lands inside the page it was converted for', () => {
    const page = pageSizeMm('A4', 'portrait');

    for (const [type, defaults] of Object.entries(TEMPLATE_DEFAULTS)) {
      resetElementIds();
      const elements = blocksToElements(defaults.layout.blocks, GEOMETRY, {
        hasLogo: defaults.showLogo,
        hasSignature: defaults.showSignature,
      });

      expect(elements.length, `${type} converted to nothing`).toBeGreaterThan(0);

      for (const element of elements) {
        expect(element.x, `${type}/${element.id} x`).toBeGreaterThanOrEqual(0);
        expect(element.y, `${type}/${element.id} y`).toBeGreaterThanOrEqual(0);
        expect(element.x + element.w, `${type}/${element.id} right`).toBeLessThanOrEqual(
          page.width + 0.001,
        );
        expect(element.y + element.h, `${type}/${element.id} bottom`).toBeLessThanOrEqual(
          page.height + 0.001,
        );
      }
    }
  });

  it('PDF-73: every shipped default still has exactly one table', () => {
    for (const [type, defaults] of Object.entries(TEMPLATE_DEFAULTS)) {
      resetElementIds();
      const elements = blocksToElements(defaults.layout.blocks, GEOMETRY);

      expect(byKind(elements, 'table'), `${type}`).toHaveLength(1);
    }
  });

  it('PDF-73: paint order follows the order the blocks were written in', () => {
    const elements = blocksToElements(
      [
        { kind: 'header', align: 'left' },
        { kind: 'party' },
        { kind: 'lines', groupByProduct: false },
      ],
      GEOMETRY,
    );

    const zs = elements.map((element) => element.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    expect(new Set(zs).size).toBe(zs.length);
  });

  it('PDF-74: a version 1 blob normalises to the same elements the converter makes', () => {
    const blocks: DocumentBlock[] = [
      { kind: 'header', align: 'left' },
      { kind: 'lines', groupByProduct: false },
    ];

    resetElementIds();
    const expected = blocksToElements(blocks, GEOMETRY);
    resetElementIds();
    const normalised = normaliseLayout({ blocks }, GEOMETRY);

    expect(normalised.version).toBe(2);
    expect(normalised.elements).toEqual(expected);
  });

  it('PDF-74: a version 2 blob passes through untouched', () => {
    const elements: DocumentElement[] = [
      {
        id: 'r1',
        kind: 'rule',
        colour: '#000000',
        thickness: 1,
        x: 10,
        y: 10,
        w: 50,
        h: 0,
        z: 1,
        band: 'body',
        flow: 'fixed',
      },
    ];

    expect(normaliseLayout({ version: 2, elements }, GEOMETRY).elements).toEqual(elements);
  });

  it('PDF-74: a corrupt layout renders an empty page rather than refusing', () => {
    // A row nobody can explain should still produce the document — the page
    // comes out with its watermark and footer and nothing else, which beats
    // telling somebody their quotation cannot be made at all.
    for (const raw of [null, undefined, 42, 'blocks', {}, { version: 9 }]) {
      expect(normaliseLayout(raw, GEOMETRY)).toEqual({ version: 2, elements: [] });
    }
  });
});
