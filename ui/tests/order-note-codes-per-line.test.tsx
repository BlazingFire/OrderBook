// @vitest-environment node
/**
 * V7 (owner, 2026-10-07): on the Filling and Dispatch notes the coded products take three places in one
 * line. This draws real pages through `OrderNote` and checks what the sheet carries: the number of places a
 * line has (a CSS variable on the coded half) and the cells the lines hold.
 */

import { buildOrderNote, noteHeader, paginateOrderNote, type LineItem, type NoteKind, type Order } from '@orderbook/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OrderNote } from '../src/OrderNote.js';

let seq = 0;
function line(over: Partial<LineItem>): LineItem {
  seq += 1;
  return {
    id: `l${seq}`, tenantId: 't', parentType: 'order', parentId: 'OD1', productId: `p${seq}`, variantId: `v${seq}`,
    productName: `Sub ${seq}`, categoryName: 'Duragres', categoryCode: 'DUR', brandName: null, alias: null, code: null,
    variantLabel: 'Ivory', colour: null, size: '600x600', weightKg: 2, packaging: 'Box', grade: 'Std', sequence: seq,
    fromPartyVariant: false, imagePath: null, notes: null, quantity: 3, lineWeightKg: 6, createdAt: '', updatedAt: '',
    ...over,
  } as LineItem;
}

function sheet(named: number, coded: number, kind: NoteKind = 'dispatch', notes: string | null = null): string {
  const items: LineItem[] = [];
  for (let i = 0; i < named; i += 1) items.push(line({ productName: `Model ${String(i).padStart(4, '0')}` }));
  for (let i = 0; i < coded; i += 1) items.push(line({ productName: String(100 + i), categoryName: 'Basin' }));
  const order = { id: 'OD0000000001', items, totalWeightKg: 0, totalWeightKgOverride: null, weightSource: 'computed' } as unknown as Order;
  const model = buildOrderNote(order);
  return renderToStaticMarkup(
    <OrderNote
      pages={paginateOrderNote(model, kind, { notes })}
      kind={kind}
      header={noteHeader(order, 'order')}
      party={null}
      partyName="Shree Tiles"
      vehicleNumber=""
      notes={notes}
      totalQuantity={model.totalQuantity}
      totalWeightKg={model.totalWeightKg}
      itemCount={model.itemCount}
      namedCount={model.named.length}
      codedCount={coded}
      printedAt={new Date('2026-10-07T09:00:00+05:30')}
    />,
  );
}

const perLine = (html: string): number[] =>
  [...html.matchAll(/ob-note-half--right[^>]*--note-codes-per-row:(\d+)/g)].map((match) => Number(match[1]));

describe('the coded half of a note', () => {
  it.each(['filling', 'dispatch'] as const)('%s: gives a line three places beside the named half and seven on a page of codes alone', (kind) => {
    const html = sheet(12, 90, kind);
    expect(perLine(html)[0]).toBe(3);
    const wide = sheet(0, 90, kind);
    expect(perLine(wide)[0]).toBe(7);
  });

  it('fills a line with three codes, not one', () => {
    const html = sheet(12, 30);
    const lines = [...html.matchAll(/ob-note-coderow">((?:(?!ob-note-coderow)[\s\S])*)/g)].map(
      (match) => (match[1]!.match(/class="ob-note-cell[ "]/g) ?? []).length,
    );
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((count) => count === 3).length).toBeGreaterThanOrEqual(lines.length - 1);
  });
});

describe("the Dispatch note's code cell (owner's artifact, 2026-10-13)", () => {
  it('prints the code, colour and brand on one line, then a grade chip, the packing, × and the quantity', () => {
    const items = [line({ productName: '102', categoryName: 'Basin', brandName: 'Swisware', colour: 'Ivory', grade: 'Prem', packaging: 'Grass', quantity: 7 })];
    const order = { id: 'OD0000000002', items, totalWeightKg: 0, totalWeightKgOverride: null, weightSource: 'computed' } as unknown as Order;
    const model = buildOrderNote(order);
    const html = renderToStaticMarkup(
      <OrderNote
        pages={paginateOrderNote(model, 'dispatch')}
        kind="dispatch"
        header={noteHeader(order, 'order')}
        party={null}
        partyName="Shree Tiles"
        vehicleNumber=""
        notes={null}
        totalQuantity={model.totalQuantity}
        totalWeightKg={model.totalWeightKg}
        itemCount={model.itemCount}
        namedCount={0}
        codedCount={1}
        printedAt={new Date('2026-10-13T09:00:00+05:30')}
      />,
    );
    const cell = html.slice(html.indexOf('ob-note-cell--dispatch'));
    expect(cell).toMatch(/ob-note-cell-line"><span class="ob-note-cell-name">102<\/span><span class="ob-note-cell-tone">Ivory<\/span><span class="ob-note-cell-brand"[^>]*>SW<\/span>/);
    expect(cell).toMatch(/ob-note-cell-gradechip">Prem<\/span><span class="ob-note-cell-pack"[^>]*>Grass<\/span><span class="ob-note-cell-times">×<\/span><span class="ob-note-cell-qty">7<\/span>/);
    // No colour: a dash in its place, as the design prints it.
    const bare = { ...order, items: [line({ productName: '205', categoryName: 'Basin', variantLabel: null, colour: null })] } as Order;
    const bareModel = buildOrderNote(bare);
    const plain = renderToStaticMarkup(
      <OrderNote pages={paginateOrderNote(bareModel, 'dispatch')} kind="dispatch" header={noteHeader(bare, 'order')} party={null}
        partyName="Shree Tiles" vehicleNumber="" notes={null} totalQuantity={3} totalWeightKg={6} itemCount={1} namedCount={0}
        codedCount={1} printedAt={new Date('2026-10-13T09:00:00+05:30')} />,
    );
    expect(plain).toMatch(/ob-note-cell-name">205<\/span><span class="ob-note-cell-tone">—</);
  });

  it("leaves the Filling note's cell as it was", () => {
    expect(sheet(4, 6, 'filling')).not.toContain('ob-note-cell--dispatch');
  });
});

describe('the unit of a quantity on a note', () => {
  const cellsOf = (html: string, className: string): string[] =>
    [...html.matchAll(new RegExp(`class="${className}"[^>]*>([^<]*)<`, 'g'))].map((match) => match[1]!.trim());

  it.each(['filling', 'dispatch'] as const)('%s: says pcs after a quantity and never box or boxes; Box stays a packaging value', (kind) => {
    const html = sheet(14, 60, kind);

    // The strip's figures carry the unit, and it is pcs.
    const units = cellsOf(html, 'ob-note-strip-unit').filter((unit) => !/^kg$/i.test(unit));
    expect(units.length).toBeGreaterThan(0);
    expect(new Set(units)).toEqual(new Set(['pcs']));
    // A quantity cell is a bare figure, nothing after it.
    for (const cell of [...cellsOf(html, 'ob-note-qty'), ...cellsOf(html, 'ob-note-cell-qty')].filter((text) => text !== 'Qty')) {
      expect(cell).toMatch(/^×?[0-9,.]+$/);
    }
    // Box is only ever the packaging: the Packing column and a code cell's packing (a tag on the Filling note).
    expect(cellsOf(html, 'ob-note-pack ob-note-wrap')).toContain('Box');
    expect(cellsOf(html, kind === 'filling' ? 'ob-note-chip' : 'ob-note-cell-pack')).toContain('Box');
    expect(html).not.toMatch(/boxes/i);
  });
});

describe('the notes of a note', () => {
  const words = (count: number): string => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');

  it.each(['filling', 'dispatch'] as const)('%s: prints a long note whole, and gives the page the height it needs', (kind) => {
    const text = words(100);
    const html = sheet(30, 80, kind, text);

    expect(html).toContain(text);
    // The block is as tall as the note, not the 78 px of two lines.
    const heights = [...html.matchAll(/ob-note-notes" style="height:([0-9.]+)px/g)].map((match) => Number(match[1]));
    expect(heights.length).toBe(1);
    expect(heights[0]).toBeGreaterThan(78);
  });

  it.each(['filling', 'dispatch'] as const)('%s: prints a very long note over pages of its own, once', (kind) => {
    const text = words(2200);
    const html = sheet(10, 20, kind, text);
    const printed = [...html.matchAll(/ob-note-notes-text">([^<]*)</g)].map((match) => match[1]).join(' ');

    expect(printed.split(' ').filter(Boolean)).toEqual(text.split(' '));
  });
});
