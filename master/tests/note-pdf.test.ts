// @vitest-environment node
/**
 * The pending order PDF (V8, 2026-10-07): the same sheet as the Dispatch note. `leadNotePdf` builds the pages
 * with the notes' own pagination, `planNotePdf` turns them into drawing operations (pure, measured with a fake
 * ruler here), and `renderNotePdf` draws them with the real vendored faces into memory.
 *
 * What the owner reads off the printed page is the claim: three codes to a line beside the named lines, seven
 * on a page of codes alone, every line once, every figure inside the sheet, "pcs" and never "box" after a
 * quantity, no money, no signature row.
 */

import { NOTE_LAYOUT, type Lead, type LineItem, type Order, type Party } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import { leadNotePdf, orderNotePdf } from '../src/domain/lead-pdf.js';
import { planNotePdf, renderNotePdf, type Measure, type PdfOp, type TextOp } from '../src/pdf/note-renderer.js';

let nextId = 0;

function line(overrides: Partial<LineItem>): LineItem {
  nextId += 1;
  return {
    id: `LI${nextId}`, tenantId: 't', parentType: 'lead', parentId: 'LD1', productId: `P${nextId}`, variantId: `V${nextId}`,
    productName: `Model ${nextId}`, categoryName: 'Wash basin', categoryCode: 'WB', brandName: null, alias: null, code: null,
    variantLabel: null, colour: null, size: null, weightKg: 2, packaging: 'Box', grade: 'Std', sequence: nextId,
    fromPartyVariant: false, imagePath: null, notes: null, quantity: 4, lineWeightKg: 8,
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function lead(items: LineItem[], over: Partial<Lead> = {}): Lead {
  return {
    id: 'LD0000000042', poNumber: 'PO/2026-27/00042', tenantId: 't', partyId: 'PT1', partyName: 'Sharma Tiles', ownerId: 'u',
    ownerName: null, stageId: 's', stageName: 'New', stageSequence: 1, sourcePlatform: null, followUpDate: null,
    partyWiseMode: false, notes: null, customFields: {}, incomplete: false, missingFields: [], convertedOrderId: null,
    convertedAt: null, totalWeightKg: 0, linesWithoutWeight: 0, sourcePanelId: null, createdByUserId: null,
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
    sync: { version: 1, hlc: 'h', fieldHlc: {}, temporaryId: null }, items, timeline: [],
    ...over,
  } as Lead;
}

const PARTY = { name: 'Sharma Tiles', partyCode: 'P0042', city: 'Morbi' } as Party;
const PRINTED = new Date(2026, 8, 19, 9, 41);

/** A fixed-pitch ruler: every glyph is 0.55 em wide, plus the letter spacing. */
const measure: Measure = (text, _font, size, spacing = 0) => text.length * (size * 0.55 + spacing);

function order(named: number, coded: number, notes: string | null = null): ReturnType<typeof leadNotePdf> {
  const items: LineItem[] = [];
  for (let i = 0; i < named; i += 1) items.push(line({ productName: `Model ${String(i).padStart(4, '0')}`, categoryName: `Cat ${i % 9}` }));
  for (let i = 0; i < coded; i += 1) items.push(line({ productName: String(100 + i), categoryName: `Code group ${i % 7}` }));
  return leadNotePdf(lead(items, { notes }), PARTY, 'Swisware Ceramics', PRINTED);
}

const texts = (ops: readonly PdfOp[]): TextOp[] => ops.filter((op): op is TextOp => op.kind === 'text');
const words = (plans: PdfOp[][]): string => plans.flatMap((ops) => texts(ops).map((op) => op.text)).join(' | ');

describe('the pending order PDF — what is on the sheets', () => {
  it('heads page 1 with the document, the party and the page, and the last page with the totals and the notes', () => {
    const input = order(40, 120, 'Handle with care');
    const plans = planNotePdf(input, measure);
    const first = texts(plans[0]!).map((op) => op.text);
    const last = texts(plans.at(-1)!).map((op) => op.text);

    expect(plans).toHaveLength(input.pages.length);
    expect(plans.length).toBeGreaterThan(1);
    expect(first).toContain('New order');
    expect(first.join(' ')).toContain('Printed 19 Sep 2026 · 09:41');
    expect(first).toContain('TOTAL QUANTITY');
    expect(first).toContain('TOTAL ITEM WEIGHT');
    expect(first).toContain('Sharma Tiles');
    expect(first).toContain('P0042 · Morbi');
    expect(first).toContain('PO/2026-27/00042');
    expect(first).toContain(`Page 1 of ${plans.length}`);
    expect(first).toContain('Continued →');

    expect(last).toContain('TOTAL QUANTITY');
    expect(last).toContain('TOTAL ITEM WEIGHT');
    expect(last).toContain(`Page ${plans.length} of ${plans.length}`);
    expect(last).toContain('End of list · 160 items');
    expect(last).toContain('NOTES');
    expect(last).toContain('Handle with care');
    // Nobody signs this one.
    expect(words(plans)).not.toMatch(/SUPERVISOR|LOADED BY|CHECKED BY|FILLED BY|VEHICLE/i);
  });

  it('puts every line on the sheets once, in the notes’ own page split', () => {
    const input = order(60, 300);
    const plans = planNotePdf(input, measure);
    const codes = plans.flatMap((ops) => texts(ops).filter((op) => op.size === 14 && op.font === 'bold' && /^\d{3}$/.test(op.text)));
    const names = plans.flatMap((ops) => texts(ops).filter((op) => op.size === 11 && /^MODEL |^Model /i.test(op.text)));

    expect(codes).toHaveLength(300);
    expect(new Set(codes.map((op) => op.text)).size).toBe(300);
    expect(names).toHaveLength(60);
    expect(input.pages.reduce((sum, page) => sum + page.leftCount, 0)).toBe(60);
  });

  it('lays the coded half out three to a line beside the named lines and seven on a page of codes alone', () => {
    const input = order(30, 400);
    const plans = planNotePdf(input, measure);
    const perLine = (ops: PdfOp[]): number[] => {
      const byY = new Map<number, number>();
      for (const op of texts(ops)) {
        if (op.size === 14 && op.font === 'bold' && /^\d{3}$/.test(op.text)) byY.set(op.y, (byY.get(op.y) ?? 0) + 1);
      }
      return [...byY.values()];
    };

    const beside = input.pages.findIndex((page) => !page.wideRight && page.rightCount > 0);
    const alone = input.pages.findIndex((page) => page.wideRight);
    expect(beside).toBeGreaterThanOrEqual(0);
    expect(alone).toBeGreaterThan(0);
    expect(Math.max(...perLine(plans[beside]!))).toBe(NOTE_LAYOUT.codesPerRow);
    expect(NOTE_LAYOUT.codesPerRow).toBe(3);
    expect(Math.max(...perLine(plans[alone]!))).toBe(NOTE_LAYOUT.codesPerRowWide);
    expect(NOTE_LAYOUT.codesPerRowWide).toBe(7);
  });

  it('keeps every figure inside the sheet, and the sheet the size of the note', () => {
    const plans = planNotePdf(order(120, 600, 'A long note. '.repeat(30)), measure);
    for (const ops of plans) {
      for (const op of texts(ops)) {
        expect(op.x, op.text).toBeGreaterThanOrEqual(0);
        expect(op.x + measure(op.text, op.font, op.size, op.spacing), op.text).toBeLessThanOrEqual(NOTE_LAYOUT.pageWidth - 29);
        expect(op.y + op.size, op.text).toBeLessThanOrEqual(NOTE_LAYOUT.pageHeight - 19);
      }
    }
  });
});

describe('the pending order PDF — the whole note', () => {
  const longNote = (words: number): string => Array.from({ length: words }, (_, i) => `word${i}`).join(' ');

  it('prints every word of a long note, wrapped, with room made for it', () => {
    const text = `${longNote(120)}
and a second paragraph`;
    const input = order(40, 120, text);
    const plans = planNotePdf(input, measure);
    const printed = texts(plans.at(-1)!).map((op) => op.text).join(' ');

    for (let i = 0; i < 120; i += 1) expect(printed).toContain(`word${i}`);
    expect(printed).toContain('and a second paragraph');
    expect(printed).not.toContain('…');
    for (const op of texts(plans.at(-1)!)) expect(op.y + op.size, op.text).toBeLessThanOrEqual(NOTE_LAYOUT.pageHeight - 19);
  });

  it('puts a note too long for the last page on pages of its own, every word once and in order', () => {
    const text = longNote(2200);
    const input = order(30, 60, text);
    const plans = planNotePdf(input, measure);
    const printed = plans
      .flatMap((ops) => texts(ops).filter((op) => op.size === 17 && /^word/.test(op.text)))
      .flatMap((op) => op.text.split(' '));

    expect(input.pages.filter((page) => page.notesHeight > 0).length).toBeGreaterThan(1);
    expect(printed).toEqual(text.split(' '));
    expect(texts(plans.at(-1)!).map((op) => op.text)).toContain(`Page ${plans.length} of ${plans.length}`);
  });
});

describe('the pending order PDF — the saved tick boxes', () => {
  const tickedHeading = (plans: PdfOp[][], heading: string): boolean =>
    texts(plans[0]!).some((op) => op.text === heading);

  it('prints no heading for an unticked column, as the preview gates it (15x)', () => {
    const items = [line({ packaging: 'Box', colour: 'Blue', grade: 'Std' })];
    const headed = planNotePdf(
      leadNotePdf(lead(items), PARTY, 'Swisware Ceramics', PRINTED, (colour) => colour, {
        packaging: true, grade: true, colour: true,
      }),
      measure,
    );
    expect(tickedHeading(headed, 'PACKING')).toBe(true);
    expect(tickedHeading(headed, 'COLOUR')).toBe(true);
    expect(tickedHeading(headed, 'GRADE')).toBe(true);

    const unticked = planNotePdf(
      leadNotePdf(lead(items), PARTY, 'Swisware Ceramics', PRINTED, (colour) => colour, {
        packaging: false, grade: false, colour: false,
      }),
      measure,
    );
    const all = words(unticked);
    expect(tickedHeading(unticked, 'PACKING')).toBe(false);
    expect(tickedHeading(unticked, 'COLOUR')).toBe(false);
    expect(tickedHeading(unticked, 'GRADE')).toBe(false);
    // The rows print too, only without the ticked columns.
    expect(all).toContain('Sharma Tiles');
  });
});

describe('the final order PDF — the document', () => {
  it('heads the sheet as a final order and freezes ticks and bold (15x)', () => {
    const items = [line({ packaging: 'Box', colour: 'Blue', grade: 'Std' })];
    const order = {
      ...lead(items),
      poNumber: 'FO/2026-27/00042',
      leadId: null,
      dispatchAddressLabel: null,
      expectedDispatchDate: null,
      totalWeightKgOverride: null,
      weightSource: 'computed',
      linesWithoutWeight: 0,
      dispatchedAt: null,
    } as Order;
    const input = orderNotePdf(order, PARTY, 'Swisware Ceramics', PRINTED, (colour) => colour, {
      packaging: false, grade: true, colour: true,
    }, false);

    expect(input.title).toBe('Final order');
    expect(input.numberText).toBe('FO/2026-27/00042');
    expect(input.bold).toBe(false);
    expect(input.columns).toEqual({ packaging: false, grade: true, colour: true });

    const plans = planNotePdf(input, measure);
    const first = texts(plans[0]!).map((op) => op.text);
    expect(first).toContain('Final order');
    expect(first).not.toContain('PACKING');
    expect(first).toContain('COLOUR');
    expect(first).toContain('GRADE');
  });
});

describe('the pending order PDF — captions stay in their cells', () => {
  it('wraps the product caption of a labelled cell to two lines inside its own cell, never over its neighbour', () => {
    // Products of one or two codes get no group header: each cell carries its own caption.
    const items: LineItem[] = [];
    for (let i = 0; i < 40; i += 1) {
      items.push(line({ productName: String(900 + i), categoryName: `One piece toilet ${i}"`, size: 'L-27, B-14, H-27, extra long size text' }));
    }
    const input = leadNotePdf(lead(items), PARTY, 'Swisware Ceramics', PRINTED);
    const plans = planNotePdf(input, measure);
    let captions = 0;

    for (const ops of plans) {
      const lines = texts(ops).filter((op) => op.size === 8 && op.font === 'bold' && op.spacing === 0.64);
      const byY = new Map<number, TextOp[]>();
      for (const op of lines) byY.set(op.y, [...(byY.get(op.y) ?? []), op]);
      for (const row of byY.values()) {
        const sorted = [...row].sort((a, b) => a.x - b.x);
        captions += sorted.length;
        sorted.forEach((op, index) => {
          const next = sorted[index + 1];
          const right = op.x + measure(op.text, op.font, op.size, op.spacing);
          if (next) expect(right, `${op.text} runs into ${next.text}`).toBeLessThanOrEqual(next.x);
          // The widest cell is 96 px (seven to a line): a caption never is wider than its own cell.
          expect(right - op.x, op.text).toBeLessThanOrEqual(96.3);
        });
      }
      // And no caption is more than two lines tall: at most two caption rows above any code.
      const captionYs = new Set(lines.map((op) => op.y));
      expect(captionYs.size).toBeGreaterThan(0);
    }
    expect(captions).toBeGreaterThan(40);
    // A caption too long for two lines ends in an ellipsis rather than spilling.
    expect(words(plans)).toContain('…');
  });
});

describe('the pending order PDF — units and money', () => {
  it('prints pcs after a quantity, never box or boxes, and carries no money', () => {
    const plans = planNotePdf(order(25, 90, 'Packed in boxes of four.'), measure);
    const all = words(plans);

    expect(all).toMatch(/pcs/);
    // "Box" is a packaging value: the BOX tag and the Box in the Packing column stay.
    expect(all).toMatch(/BOX|Box/);
    expect(all).not.toMatch(/\d\s*boxe?s?\b/i);
    const figures = plans.flatMap((ops) => texts(ops).filter((op) => /^\d[\d,.]*$/.test(op.text)));
    expect(figures.length).toBeGreaterThan(0);
    expect(all).not.toMatch(/\b(prices?|pricing|rates?|amounts?|discounts?|rupees?|paise)\b|₹/i);
  });

  it('puts the unit after the total as well', () => {
    const plans = planNotePdf(order(10, 30), measure);
    const last = texts(plans.at(-1)!);
    const total = last.findIndex((op) => op.text === 'TOTAL QUANTITY');
    expect(total).toBeGreaterThanOrEqual(0);
    expect(last.some((op) => op.text === ' pcs')).toBe(true);
  });
});

describe('the pending order PDF — the document', () => {
  it('names the party from the lead when the party record is gone, and the colour label as the list has it now', () => {
    const items = [line({ productName: 'ROMA', colour: 'Red Brown' })];
    const input = leadNotePdf(lead(items), null, 'Swisware Ceramics', PRINTED, (colour) => (colour === 'Red Brown' ? 'Rust' : colour));

    expect(input.partyName).toBe('Sharma Tiles');
    expect(input.partyMeta).toBe('');
    expect(input.pages[0]!.left[0]![0]!.colour).toBe('Rust');
  });

  it('renders an A4 PDF with a page for every planned page, in the vendored faces', async () => {
    const input = order(60, 300, 'Handle with care');
    const bytes = await renderNotePdf(input);
    const text = bytes.toString('latin1');

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(text.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(input.pages.length);
    expect(text).toMatch(/Inter/);
    expect(text).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
  });
});

describe('the saved column ticks — 15x (2026-10-25 audit)', () => {
  const items = [line({ productName: 'Rustic', packaging: 'Box', grade: 'Std', colour: 'Ivory' })];
  const withColumns = (columns?: { packaging: boolean; colour: boolean; grade: boolean }): string =>
    words(planNotePdf(leadNotePdf(lead(items), PARTY, 'Swisware Ceramics', PRINTED, undefined, columns), measure));

  it('prints every column heading when all three are ticked, none of an unticked column', () => {
    const all = withColumns();
    expect(all).toContain('PACKING');
    expect(all).toContain('COLOUR');
    expect(all).toContain('GRADE');

    // The defect this closes: the headings used to print regardless, so an unticked
    // column left an empty-headed column on the sheet.
    const none = withColumns({ packaging: false, colour: false, grade: false });
    expect(none).not.toContain('PACKING');
    expect(none).not.toContain('COLOUR');
    expect(none).not.toContain('GRADE');
    // The sub-product/brand and quantity headings are never ticked away.
    expect(none).toContain('QTY');

    const half = withColumns({ packaging: true, colour: false, grade: true });
    expect(half).toContain('PACKING');
    expect(half).not.toContain('COLOUR');
    expect(half).toContain('GRADE');
  });

  it('calls the sheet Final order when it is built from an order, New order for a lead', () => {
    const pending = words(planNotePdf(leadNotePdf(lead(items), PARTY, 'Swisware Ceramics', PRINTED), measure));
    expect(pending).toContain('New order');

    const asOrder = { ...lead(items), leadCreatedAt: '2026-09-29T00:00:00.000Z' } as ReturnType<typeof lead> & {
      leadCreatedAt: string;
    };
    const final = words(planNotePdf(leadNotePdf(asOrder, PARTY, 'Swisware Ceramics', PRINTED), measure));
    expect(final).toContain('Final order');
    expect(final).not.toContain('New order');
  });
});
