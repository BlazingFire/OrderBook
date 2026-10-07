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

function sheet(named: number, coded: number, kind: NoteKind = 'dispatch'): string {
  const items: LineItem[] = [];
  for (let i = 0; i < named; i += 1) items.push(line({ productName: `Model ${String(i).padStart(4, '0')}` }));
  for (let i = 0; i < coded; i += 1) items.push(line({ productName: String(100 + i), categoryName: 'Basin' }));
  const order = { id: 'OD0000000001', items, totalWeightKg: 0, totalWeightKgOverride: null, weightSource: 'computed' } as unknown as Order;
  const model = buildOrderNote(order);
  return renderToStaticMarkup(
    <OrderNote
      pages={paginateOrderNote(model, kind)}
      kind={kind}
      header={noteHeader(order, 'order')}
      party={null}
      partyName="Shree Tiles"
      vehicleNumber=""
      notes={null}
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
  it.each(['filling', 'dispatch'] as const)('%s: gives a line three places beside the named half and four on a page of codes alone', (kind) => {
    const html = sheet(12, 90, kind);
    expect(perLine(html)[0]).toBe(3);
    const wide = sheet(0, 90, kind);
    expect(perLine(wide)[0]).toBe(4);
  });

  it('fills a line with three codes, not one', () => {
    const html = sheet(12, 30);
    const lines = [...html.matchAll(/ob-note-coderow">((?:(?!ob-note-coderow)[\s\S])*)/g)].map(
      (match) => (match[1]!.match(/ob-note-cell"/g) ?? []).length,
    );
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((count) => count === 3).length).toBeGreaterThanOrEqual(lines.length - 1);
  });
});
