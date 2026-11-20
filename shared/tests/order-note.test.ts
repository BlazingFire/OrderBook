/**
 * Building and paginating the Filling / Dispatch notes (docs/ORDER_NOTES_PLAN.md).
 *
 * Pagination is arithmetic on fixed row heights, so everything that can go
 * wrong with it — a line printed twice or not at all, a page total that does
 * not add up, a signature row on the wrong page — is checked here, not on paper.
 */

import { describe, expect, it } from 'vitest';

import {
  buildOrderNote, cleanVehicleNumber, colourLabeller, clampNoteCopies, namedLabel, namedRowHeight, noteCellCaption, noteCodedRowHeight, noteDocument, noteHeader, noteNumber,
  codeCellLines, codedRowHeight, NOTE_LAYOUT, NOTE_MAX_COPIES, noteCodeNameSize, paginateOrderNote,
} from '../src/index.js';
import type { Lead, LineItem, NoteKind, NotePage, Order, Party } from '../src/index.js';

let seq = 0;

function line(over: Partial<LineItem> = {}): LineItem {
  seq += 1;
  return {
    id: `l${seq}`, tenantId: 't', parentType: 'order', parentId: 'OD1',
    productId: `p${seq}`, variantId: `v${seq}`,
    productName: `Sub ${seq}`, categoryName: 'Duragres', categoryCode: 'DUR', brandName: null,
    alias: null, code: null, variantLabel: 'Ivory', colour: null, printSide: null, size: '600x600', weightKg: 2,
    packaging: 'Box', grade: 'Std', sequence: seq, fromPartyVariant: false, imagePath: null,
    notes: null, quantity: 3, lineWeightKg: 6, createdAt: '', updatedAt: '',
    ...over,
  } as LineItem;
}

function orderOf(items: LineItem[], over: Partial<Order> = {}): Order {
  return {
    id: 'OD0000000001', items, totalWeightKg: 0, totalWeightKgOverride: null, weightSource: 'computed',
    ...over,
  } as unknown as Order;
}

function orderWith(named: number, coded: number, over: Partial<Order> = {}): Order {
  const items: LineItem[] = [];
  for (let i = 0; i < named; i += 1) items.push(line({ productName: `Model ${String(i).padStart(4, '0')}` }));
  for (let i = 0; i < coded; i += 1) {
    items.push(line({ productName: String(100 + i), categoryName: i % 7 === 0 ? 'Alpha' : 'Beta' }));
  }
  return orderOf(items, over);
}

function printed(pages: NotePage[]): string[] {
  return pages.flatMap((page) => [
    ...page.left.flat().map((l) => l.key),
    ...page.right.flat().flatMap((slot) => (slot.kind === 'row' ? slot.lines.map((l) => l.key) : [])),
  ]);
}

const PRESETS: Array<[number, number]> = [[14, 84], [46, 430], [120, 1100], [0, 300], [200, 0], [1, 1]];

describe('the colour a note prints', () => {
  it('does not repeat a colour that only repeats the sub product name (shownColour)', () => {
    const model = buildOrderNote(orderOf([line({ productName: 'MAGENTA', variantLabel: 'Magenta' })]));
    expect(model.named[0]?.colour).toBeNull();
  });

  it('prints the colour list LABEL for the stored value, and the value when the list has none', () => {
    const labelOf = colourLabeller([{ value: 'RED BROWN', label: 'Red Brown' }]);
    const model = buildOrderNote(
      orderOf([
        line({ productName: 'Rustic', variantLabel: null, colour: 'RED BROWN' }),
        line({ productName: 'Classic', variantLabel: null, colour: 'Ochre' }),
      ]),
      labelOf,
    );
    expect(model.named.map((l) => l.colour).sort()).toEqual(['Ochre', 'Red Brown']);
  });
});

describe('buildOrderNote', () => {
  it('puts a name left and a plain code right, and reuses isNumericSubProduct for the test', () => {
    const model = buildOrderNote(orderOf([
      line({ productName: '102 (9")' }),
      line({ productName: '102' }),
    ]));
    expect(model.named.map((l) => l.subProduct)).toEqual(['102 (9")']);
    expect(model.coded.flatMap((g) => g.lines.map((l) => l.subProduct))).toEqual(['102']);
  });

  it('prints a numeric variant code on the coded half under its sub product', () => {
    const model = buildOrderNote(orderOf([
      line({ productName: '18X14 VITROSA SET', categoryName: 'VITROSA SET', code: '1501' }),
      line({ productName: '18X14 VITROSA SET', categoryName: 'VITROSA SET', code: '1502' }),
    ]));
    expect(model.named).toEqual([]);
    expect(model.coded.map((g) => g.product)).toEqual(['VITROSA SET — 18X14 VITROSA SET']);
    expect(model.coded[0]?.lines.map((l) => l.subProduct)).toEqual(['1501', '1502']);
  });

  it('keeps an alphanumeric sub product with a non-numeric code on the named half', () => {
    const model = buildOrderNote(orderOf([line({ productName: 'DAMRU', code: 'AB-12' })]));
    expect(model.named.map((l) => l.subProduct)).toEqual(['DAMRU']);
    expect(model.coded).toEqual([]);
  });
  it('splits by the print-side snapshot over the name rule, both ways', () => {
    const model = buildOrderNote(orderOf([
      line({ productName: '1111', printSide: 'left' }),
      line({ productName: 'MAGENTA', printSide: 'right' }),
      line({ productName: '7511' }),
      line({ productName: 'Classic' }),
    ]));
    expect(model.named.map((l) => l.subProduct).sort()).toEqual(['1111', 'Classic']);
    expect(model.coded.flatMap((g) => g.lines.map((l) => l.subProduct)).sort()).toEqual(['7511', 'MAGENTA']);
  });

  it('merges lines of one sub product, colour, grade and packaging, and keeps different ones apart', () => {
    const base = { productId: 'p-shared', variantId: null, productName: 'Rustic' };
    const model = buildOrderNote(orderOf([
      line({ ...base, quantity: 2, lineWeightKg: 4 }),
      line({ ...base, quantity: 5, lineWeightKg: 10 }),
      line({ ...base, quantity: 1, lineWeightKg: 2, grade: 'Prem' }),
    ]));
    expect(model.named.map((l) => l.quantity).sort()).toEqual([1, 7]);
    expect(model.totalQuantity).toBe(8);
  });

  it('gives a merged weight of null when any part has none', () => {
    const base = { productId: 'p-shared', variantId: null, productName: 'Rustic' };
    const model = buildOrderNote(orderOf([
      line({ ...base, lineWeightKg: 4 }),
      line({ ...base, lineWeightKg: null }),
    ]));
    expect(model.named[0]?.weightKg).toBeNull();
  });

  it('sorts codes ascending as numbers and groups them under their product', () => {
    const model = buildOrderNote(orderOf([
      line({ productName: '1111', categoryName: 'Opt' }),
      line({ productName: '102', categoryName: 'Opt' }),
      line({ productName: '102', categoryName: 'Prm' }),
    ]));
    expect(model.coded.map((g) => g.product)).toEqual(['Opt', 'Prm']);
    expect(model.coded[0]?.lines.map((l) => l.subProduct)).toEqual(['102', '1111']);
  });

  it('takes the order override for the total weight when one is set', () => {
    const items = [line()];
    expect(buildOrderNote(orderOf(items, { totalWeightKg: 6 })).totalWeightKg).toBe(6);
    expect(
      buildOrderNote(orderOf(items, { totalWeightKg: 6, totalWeightKgOverride: 9, weightSource: 'manual' })).totalWeightKg,
    ).toBe(9);
  });
});

describe.each(['filling', 'dispatch'] as NoteKind[])('paginateOrderNote (%s)', (kind) => {
  it.each(PRESETS)('prints every line exactly once for %i named + %i coded', (named, coded) => {
    const model = buildOrderNote(orderWith(named, coded));
    const keys = printed(paginateOrderNote(model, kind));
    expect(keys).toHaveLength(model.itemCount);
    expect(new Set(keys).size).toBe(model.itemCount);
  });

  it.each(PRESETS)('per-page quantities add up to the total for %i + %i', (named, coded) => {
    const model = buildOrderNote(orderWith(named, coded));
    const pages = paginateOrderNote(model, kind);
    expect(pages.reduce((sum, p) => sum + p.quantity, 0)).toBe(model.totalQuantity);
    expect(pages.at(-1)?.runQuantity).toBe(model.totalQuantity);
    const runs = pages.map((p) => p.runQuantity);
    expect(runs).toEqual([...runs].sort((a, b) => a - b));
  });

  it('is one page for a short order and grows for the long presets', () => {
    expect(paginateOrderNote(buildOrderNote(orderWith(6, 10)), kind)).toHaveLength(1);
    const typical = paginateOrderNote(buildOrderNote(orderWith(46, 430)), kind).length;
    const long = paginateOrderNote(buildOrderNote(orderWith(120, 1100)), kind).length;
    expect(typical).toBeGreaterThan(1);
    expect(long).toBeGreaterThan(typical);
  });

  it('numbers pages and marks only the last one', () => {
    const pages = paginateOrderNote(buildOrderNote(orderWith(46, 430)), kind);
    pages.forEach((page, i) => {
      expect(page.pageNo).toBe(i + 1);
      expect(page.pageCount).toBe(pages.length);
      expect(page.isLast).toBe(i === pages.length - 1);
      expect(page.isFirst).toBe(i === 0);
    });
  });

  it('gives the named half two columns when a page has no coded lines, and the coded half more columns when it has no named lines', () => {
    const onlyNamed = paginateOrderNote(buildOrderNote(orderWith(20, 0)), kind)[0];
    expect(onlyNamed?.wideLeft).toBe(true);
    expect(onlyNamed?.left).toHaveLength(2);

    // One column of lines of seven across a page of codes alone (as in the owner's print), one of three beside the named half.
    const onlyCoded = paginateOrderNote(buildOrderNote(orderWith(0, 500)), kind)[0];
    expect(onlyCoded?.wideRight).toBe(true);
    expect(onlyCoded?.right).toHaveLength(NOTE_LAYOUT.codedColumnsWide);
    expect(NOTE_LAYOUT.codedColumnsWide).toBe(1);

    const beside = paginateOrderNote(buildOrderNote(orderWith(20, 200)), kind)[0];
    expect(beside?.wideRight).toBe(false);
    expect(beside?.right).toHaveLength(NOTE_LAYOUT.codedColumns);
    expect(NOTE_LAYOUT.codedColumns).toBe(1);
  });

  it('gives a product of three or more codes one header, codes side by side, and never leaves the header alone at a column foot', () => {
    const pages = paginateOrderNote(buildOrderNote(orderWith(0, 300)), kind);
    for (const page of pages) {
      for (const column of page.right) {
        expect(column[0]?.kind).toBe('header');
        expect(column.at(-1)?.kind).toBe('row');
      }
    }
    const slots = pages.flatMap((p) => p.right.flat());
    expect(slots.some((slot) => slot.kind === 'header' && slot.continued)).toBe(true);
    const rows = slots.flatMap((slot) => (slot.kind === 'row' ? [slot] : []));
    expect(Math.max(...rows.map((row) => row.lines.length))).toBe(NOTE_LAYOUT.codesPerRowWide);
    expect(NOTE_LAYOUT.codesPerRowWide).toBe(7);
  });

  it('V7: puts three codes on every line beside the named half, only the last line of a product being short', () => {
    expect(NOTE_LAYOUT.codesPerRow).toBe(3);
    const pages = paginateOrderNote(buildOrderNote(orderWith(60, 120)), kind);
    const beside = pages.filter((page) => !page.wideRight && page.right.length > 0);
    expect(beside.length).toBeGreaterThan(0);
    for (const page of beside) {
      for (const column of page.right) {
        column.forEach((slot, index) => {
          if (slot.kind !== 'row') return;
          const next = column[index + 1];
          // A line is full unless the product (or the run of small ones) ends there, or the page does.
          if (next?.kind === 'row') expect(slot.lines).toHaveLength(NOTE_LAYOUT.codesPerRow);
        });
      }
    }
    // Where a product has a header, its first line already holds three, not one.
    const firstRows = beside.flatMap((page) => page.right.flat()).flatMap((slot, i, all) =>
      slot.kind === 'header' && all[i + 1]?.kind === 'row' ? [(all[i + 1] as { lines: unknown[] }).lines.length] : []);
    expect(firstRows.some((n) => n === NOTE_LAYOUT.codesPerRow)).toBe(true);
  });

  it('prints the product on each lone code and gives it no header; two codes of one product earn one', () => {
    const items = [
      line({ productName: '101', categoryName: 'Solo' }),
      line({ productName: '102', categoryName: 'Lone' }),
      line({ productName: '103', categoryName: 'Pair' }),
      line({ productName: '104', categoryName: 'Pair' }),
      ...['201', '202', '203'].map((code) => line({ productName: code, categoryName: 'Trio' })),
    ];
    const slots = paginateOrderNote(buildOrderNote(orderOf(items)), kind)[0]!.right.flat();
    expect(slots.flatMap((s) => (s.kind === 'header' ? [s.product] : []))).toEqual(['Pair', 'Trio']);
    const rows = slots.flatMap((s) => (s.kind === 'row' ? [s] : []));
    // Lone codes share a line, and each is its own labelled cell with its own product.
    const small = rows.filter((r) => r.labelled);
    expect(small).toHaveLength(1);
    expect(small[0]!.lines.map((l) => l.product.split(' ')[0]).sort()).toEqual(['Lone', 'Solo']);
    expect(rows.filter((r) => !r.labelled).flatMap((r) => r.lines)).toHaveLength(5);
  });

  it('puts every size of one main product under one header, with no size caption (owner, 2026-11-18)', () => {
    const items = [
      line({ productName: '7512', categoryName: 'Table Top Wash Basin', size: null }),
      line({ productName: '7513', categoryName: 'Table Top Wash Basin', size: null }),
      line({ productName: '7505', categoryName: 'Table Top Wash Basin', size: '17X11' }),
      line({ productName: '7507', categoryName: 'Table Top Wash Basin', size: '17X13' }),
    ];
    const slots = paginateOrderNote(buildOrderNote(orderOf(items)), kind)[0]!.right.flat();
    expect(slots.flatMap((s) => (s.kind === 'header' ? [s.product] : []))).toEqual(['Table Top Wash Basin']);
    const rows = slots.flatMap((s) => (s.kind === 'row' ? [s] : []));
    // No size is printed over the codes any more, which is the whole point of
    // the change. The rows now sort by code within the product, because the
    // size is no longer part of the sort key (`compareLines`).
    expect(rows.every((r) => !r.labelled && r.sized)).toBe(true);
    expect(rows.flatMap((r) => r.lines.map((l) => [l.subProduct, noteCellCaption(r, l)]))).toEqual([
      ['7505', null], ['7507', null], ['7512', null], ['7513', null],
    ]);
    expect(rows.map(noteCodedRowHeight)).toEqual(rows.map(() => NOTE_LAYOUT.rowCodedLabelled));
  });

  it('keeps the short row for a headed product of one size', () => {
    const items = ['301', '302'].map((code) => line({ productName: code, categoryName: 'Same' }));
    const rows = paginateOrderNote(buildOrderNote(orderOf(items)), kind)[0]!.right.flat()
      .flatMap((s) => (s.kind === 'row' ? [s] : []));
    expect(rows.map((r) => [r.sized, noteCodedRowHeight(r), noteCellCaption(r, r.lines[0]!)])).toEqual([[false, NOTE_LAYOUT.rowCoded, null]]);
  });

  it('still prints one page for an order with no lines', () => {
    const pages = paginateOrderNote(buildOrderNote(orderOf([])), kind);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.isLast).toBe(true);
  });

  it('fits rows of both heights into each named column without overfilling it, every line once', () => {
    const long = 'Wash basin with full pedestal, rimless';
    const items = Array.from({ length: 150 }, (_, i) =>
      line({ productName: i % 3 === 0 ? `${long} ${i}` : `Model ${i}`, brandName: 'Cera' }));
    const model = buildOrderNote(orderOf(items));
    const pages = paginateOrderNote(model, kind);
    expect(printed(pages)).toHaveLength(150);
    expect(new Set(printed(pages)).size).toBe(150);
    // The tallest a column can be: page one's body with no notes and signatures.
    const body = NOTE_LAYOUT.inner - 8 - NOTE_LAYOUT.caption - NOTE_LAYOUT.columnLabel
      - (kind === 'filling' ? NOTE_LAYOUT.headerContFilling + NOTE_LAYOUT.footerFilling : NOTE_LAYOUT.headerContDispatch);
    for (const page of pages) {
      for (const column of page.left) {
        expect(column.reduce((sum, l) => sum + namedRowHeight(l), 0)).toBeLessThanOrEqual(body);
      }
    }
  });
});

describe('the last page', () => {
  it('is never a one-to-five-line orphan: a page before it is cut early enough to leave a fair share', () => {
    for (const [named, coded] of [...PRESETS, [0, 120], [0, 125], [0, 250], [0, 380], [30, 200], [28, 54], [26, 480]] as Array<[number, number]>) {
      for (const kind of ['filling', 'dispatch'] as const) {
        const pages = paginateOrderNote(buildOrderNote(orderWith(named, coded)), kind);
        const tail = pages.at(-1)!.leftCount + pages.at(-1)!.rightCount;
        if (pages.length > 1) {
          expect(tail, `${kind} ${named}+${coded}`).toBeGreaterThanOrEqual(12); // a fair share, not the constant under test
        }
        expect(printed(pages)).toHaveLength(named + coded);
      }
    }
  });

  it('sweeps every size from one to two pages without an orphan or a lost line', () => {
    for (let coded = 1; coded <= 330; coded += 1) {
      const pages = paginateOrderNote(buildOrderNote(orderWith(0, coded)), 'dispatch');
      if (pages.length > 1) {
        const last = pages.at(-1)!;
        expect(last.leftCount + last.rightCount, `coded ${coded}`).toBeGreaterThanOrEqual(Math.min(12, coded));
      }
      expect(new Set(printed(pages)).size).toBe(coded);
    }
  });

  it('matches the design page counts for its three volumes (Short, Typical, Long) on this plain data', () => {
    // The design's own dataset gives 2 / 5 / 12 pages for both notes; this synthetic data is
    // simpler, so the bound is the design's count, never more.
    const volumes: Array<[number, number, number]> = [[14, 84, 2], [46, 430, 5], [120, 1100, 12]];
    for (const [named, coded, designPages] of volumes) {
      for (const kind of ['filling', 'dispatch'] as const) {
        const pages = paginateOrderNote(buildOrderNote(orderWith(named, coded)), kind);
        expect(pages.length, `${kind} ${named}+${coded}`).toBeLessThanOrEqual(designPages);
      }
    }
  });
});

describe('named rows (design rule)', () => {
  it('use the design rule: label plus room for a brand chip over two lines is tall, branded or not', () => {
    const fits = 2 * NOTE_LAYOUT.namedCharsPerLine - NOTE_LAYOUT.namedChipChars; // 37 characters
    const make = (n: number, brandName: string | null) =>
      buildOrderNote(orderOf([line({ productName: 'A'.repeat(n), size: null, brandName })])).named[0]!;
    expect(namedRowHeight(make(fits, null))).toBe(NOTE_LAYOUT.rowNamed);
    expect(namedRowHeight(make(fits + 1, null))).toBe(NOTE_LAYOUT.rowNamedTall);
    expect(namedRowHeight(make(fits, 'Cera'))).toBe(NOTE_LAYOUT.rowNamed);
    // 20, not 26, since the halves split 50/50 (owner, 2026-11-20): the label column lost about a quarter.
    expect(NOTE_LAYOUT.namedCharsPerLine).toBe(20);
  });

  it('prints the sub product alone — the size came off the sheet — and grows tall for a three-line label', () => {
    const [short, sized, long] = buildOrderNote(orderOf([
      line({ productName: 'Rustic', size: '600x600' }),
      line({ productName: 'Rustic 600x600 Gloss', size: '600x600' }),
      line({ productName: 'Wash basin with full pedestal and rimless overflow', size: '24"', brandName: 'Cera' }),
    ])).named.sort((a, b) => a.subProduct.length - b.subProduct.length);
    // The size no longer rides behind the name (owner, 2026-11-18): it wrapped
    // the row and shifted the columns beside it.
    expect(namedLabel(short!)).toBe('Rustic');
    expect(namedLabel(sized!)).toBe('Rustic 600x600 Gloss');
    expect(namedRowHeight(short!)).toBe(NOTE_LAYOUT.rowNamed);
    expect(namedRowHeight(long!)).toBe(NOTE_LAYOUT.rowNamedTall);
  });
});

describe('a lead as the source of a note', () => {
  const items = [line({ productName: 'Oak' }), line({ productName: '102' })];
  const lead = {
    id: 'LD0000000007', partyName: 'Shree Tiles', createdAt: '2026-10-01T05:00:00.000Z',
    items, totalWeightKg: 12, convertedOrderId: null,
  } as unknown as Lead;
  const party = {
    partyCode: 'P0042', city: 'Morbi', phone: '9876543210', gstNumber: '24ABCDE1234F1Z5',
    name: 'Never copied', email: 'x@y.z',
  } as unknown as Party;

  it('builds the same model as the equivalent order: no weight source means the computed weight', () => {
    const asOrder = orderOf(items, { totalWeightKg: 12, weightSource: 'computed', totalWeightKgOverride: null });
    expect(buildOrderNote(lead)).toEqual(buildOrderNote(asOrder));
    expect(buildOrderNote(lead).totalWeightKg).toBe(12);
  });

  it('carries no number before the PO number exists (the sheet prints the id), the lead source and when the lead was created', () => {
    const doc = noteDocument(lead, 'lead', party, null);
    expect(doc.header).toEqual({
      source: 'lead', id: 'LD0000000007', number: null, createdAt: '2026-10-01T05:00:00.000Z',
    });
    expect(doc.partyName).toBe('Shree Tiles');
    expect(doc.notes).toBeNull();
    expect(noteDocument({ ...lead, notes: 'Handle with care' }, 'lead', null, null).notes).toBe('Handle with care');
  });

  it('keeps only the four party fields the header prints', () => {
    const doc = noteDocument(lead, 'lead', party, null);
    expect(doc.party).toEqual({ partyCode: 'P0042', city: 'Morbi', phone: '9876543210', gstNumber: '24ABCDE1234F1Z5' });
    expect(noteDocument(lead, 'lead', null, null).party).toBeNull();
  });

  /*
   * The dealer code, the grade's size and the creator's name (owner, 2026-11-18).
   * Each has an override on the order that must beat the company/party answer,
   * and each must fall back to what the sheet printed before when absent —
   * otherwise an upgraded installation's notes would change on their own.
   */
  it('prints the party code as the dealer until this order overrides it', () => {
    expect(noteDocument(lead, 'lead', party, null).dealerCode).toBe('P0042');
    expect(noteDocument({ ...lead, dealerCode: 'P9999' }, 'lead', party, null).dealerCode).toBe('P9999');
    // A note whose party could not be read, and an order with nothing stored.
    expect(noteDocument(lead, 'lead', null, null, undefined, undefined, undefined).dealerCode).toBeNull();
  });

  it("takes the grade's size from the order, else the company's, else the sheet's own", () => {
    // Absent everywhere: undefined, which the sheet reads as its built-in size.
    expect(noteDocument(lead, 'lead', party, null).gradeSize).toBeUndefined();
    // The company setting alone.
    expect(noteDocument(lead, 'lead', party, null, undefined, undefined, 12).gradeSize).toBe(12);
    // The order's own wins over the company's.
    expect(
      noteDocument({ ...lead, noteGradeSize: 16 }, 'lead', party, null, undefined, undefined, 12).gradeSize,
    ).toBe(16);
  });

  it('carries the creator for the foot of the sheet, and nothing when unknown', () => {
    expect(noteDocument(lead, 'lead', party, null).createdByName).toBeNull();
    expect(
      noteDocument({ ...lead, createdByName: 'Riya Shah' }, 'lead', party, null).createdByName,
    ).toBe('Riya Shah');
  });

  it('freezes bold with the document: absent reads as bold, printroom honours false (15x)', () => {
    expect(noteDocument(lead, 'lead', party, null).bold).toBeNull();
    expect(noteDocument(lead, 'lead', party, null, (colour) => colour, false).bold).toBe(false);
    expect(noteDocument(lead, 'lead', party, null, (colour) => colour, true).bold).toBe(true);
  });

  it('reads an order\'s created-at from leadCreatedAt, and null when it has none', () => {
    const order = orderOf(items, { partyName: 'Shree Tiles', leadCreatedAt: '2026-09-30T05:00:00.000Z' });
    expect(noteDocument(order, 'order', null, 'GJ 03 AB 1234').header).toMatchObject({
      source: 'order', createdAt: '2026-09-30T05:00:00.000Z',
    });
    expect(noteDocument(orderOf(items), 'order', null, null).header.createdAt).toBeNull();
    expect(noteDocument(order, 'order', null, 'GJ 03 AB 1234').vehicleNumber).toBe('GJ 03 AB 1234');
  });

  it('freezes the bold tick it was given, and leaves it unset when there was none (the printroom 15x)', () => {
    expect(noteDocument(lead, 'lead', null, null, undefined, false).bold).toBe(false);
    expect(noteDocument(lead, 'lead', null, null, undefined, true).bold).toBe(true);
    // Older callers and old payloads: no bold field freezes as null — the sheet renders bold, as it always did.
    expect(noteDocument(lead, 'lead', null, null).bold).toBeNull();
  });
});

describe('clampNoteCopies', () => {
  it('rounds to a whole number and pulls it into 1..50; anything that is not a number is one copy', () => {
    expect(NOTE_MAX_COPIES).toBe(50);
    expect([1, 3, 50].map(clampNoteCopies)).toEqual([1, 3, 50]);
    expect([0, -4, 0.4].map(clampNoteCopies)).toEqual([1, 1, 1]);
    expect([51, 500, Infinity].map(clampNoteCopies)).toEqual([50, 50, 1]);
    expect([2.6, 2.4].map(clampNoteCopies)).toEqual([3, 2]);
    for (const bad of [NaN, '3', null, undefined, {}]) expect(clampNoteCopies(bad)).toBe(1);
  });
});

describe('noteHeader', () => {
  it('is what noteDocument carries, and its number is the one place the printed number is chosen', () => {
    const lead = { id: 'LD0000000009', partyName: 'A', createdAt: '2026-10-02T00:00:00.000Z', items: [], totalWeightKg: 0 } as unknown as Lead;
    expect(noteHeader(lead, 'lead')).toEqual(noteDocument(lead, 'lead', null, null).header);
    // No PO number yet (or a pre-1.3 Master): null, and the sheet prints the id.
    expect(noteHeader(lead, 'lead').number).toBeNull();
    expect(noteNumber(lead)).toBeNull();
    expect(noteNumber({ id: 'LD1', poNumber: null })).toBeNull();
    expect(noteNumber({ id: 'LD1', poNumber: '' })).toBeNull();
  });

  it('carries the PO number of a pending order and of the final order made from it', () => {
    const lead = { id: 'LD0000000009', poNumber: 'PO/2026-27/00009', partyName: 'A', createdAt: '2026-10-02T00:00:00.000Z', items: [], totalWeightKg: 0 } as unknown as Lead;
    const order = { id: 'OD0000000003', poNumber: 'PO/2026-27/00009', partyName: 'A', leadCreatedAt: '2026-10-02T00:00:00.000Z', items: [], totalWeightKg: 0 } as unknown as Order;
    expect(noteHeader(lead, 'lead').number).toBe('PO/2026-27/00009');
    expect(noteHeader(order, 'order')).toMatchObject({ number: 'PO/2026-27/00009', id: 'OD0000000003' });
  });
});

describe('cleanVehicleNumber', () => {
  it('upper-cases, drops punctuation and collapses runs of spaces', () => {
    expect(cleanVehicleNumber('gj 03  ab.1234')).toBe('GJ 03 AB1234');
    expect(cleanVehicleNumber('gj-03 ab/1234')).toBe('GJ-03 AB1234');
    expect(cleanVehicleNumber('')).toBe('');
  });
});

describe('coded rows hold their whole names (owner, 2026-11-20: no cut names)', () => {
  const coded = (productName: string, colour: string | null = 'WHITE') =>
    buildOrderNote(orderOf([line({ productName, colour, variantLabel: null, categoryName: 'One Piece Toilet', printSide: 'right' })]))
      .coded[0]!.lines[0]!;
  const cell = NOTE_LAYOUT.codeCell;

  it('prints a long name smaller, and keeps a short one at 14 px', () => {
    expect(noteCodeNameSize('101')).toBe(14);
    expect(noteCodeNameSize('2501 PADESTAL ONLY')).toBe(NOTE_LAYOUT.codeNameSmall);
  });

  it('plans a row taller when a name wraps past two lines, and never shorter than the floor', () => {
    const short = coded('101');
    const long = coded('2501 PADESTAL ONLY WITH FULL PEDESTAL');
    expect(codeCellLines(short, 'dispatch', cell)).toBe(1);
    expect(codeCellLines(long, 'dispatch', cell)).toBeGreaterThan(2);
    expect(codedRowHeight([short], false, 'dispatch', cell, 9)).toBe(NOTE_LAYOUT.rowCoded);
    const tall = codedRowHeight([short, long], false, 'dispatch', cell, 9);
    expect(tall).toBe(NOTE_LAYOUT.rowCoded + (codeCellLines(long, 'dispatch', cell) - 2) * NOTE_LAYOUT.codeLine);
  });

  it('breaks a single word wider than the cell rather than letting it overflow', () => {
    expect(codeCellLines(coded('X'.repeat(40), null), 'dispatch', cell)).toBeGreaterThan(2);
  });

  it('adds room for a grade set large, and none at the default size', () => {
    const short = coded('101');
    expect(codedRowHeight([short], false, 'dispatch', cell, 9)).toBe(NOTE_LAYOUT.rowCoded);
    expect(codedRowHeight([short], false, 'dispatch', cell, 20)).toBeGreaterThan(NOTE_LAYOUT.rowCoded);
  });

  it('prints every row at the height it was planned, and the page keeps them inside the sheet', () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      line({ productName: `${100 + i} NEATWARE SPANISIA ${i}`, categoryName: 'One Piece Toilet', colour: 'WHITE', variantLabel: null, printSide: 'right' }));
    const pages = paginateOrderNote(buildOrderNote(orderOf(items)), 'dispatch', { gradeSize: 20 });
    const rows = pages.flatMap((page) => page.right.flat()).filter((slot) => slot.kind === 'row');
    expect(rows.flatMap((row) => row.lines).length).toBe(300);
    for (const row of rows) expect(noteCodedRowHeight(row)).toBeGreaterThan(NOTE_LAYOUT.rowCoded);
    // More pages than a short-named order of the same size: the room came from the page count, not the sheet's foot.
    const plain = paginateOrderNote(buildOrderNote(orderOf(items.map((item, i) => ({ ...item, productName: String(100 + i) })))), 'dispatch');
    expect(pages.length).toBeGreaterThan(plain.length);
  });
});
