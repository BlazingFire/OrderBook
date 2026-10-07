/**
 * The product card's data side (`ui/src/order/gridModel.ts`): which rows a chosen product opens
 * with, when a row or the whole card can be added, how rows become lines and back, how the Added
 * products list groups lines, and where Enter goes from a field of the row walk.
 */

import type { Product } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import {
  addColourRow,
  buildRows,
  cardPieces,
  cardReady,
  groupLines,
  linesToRows,
  nextWalkStop,
  prevWalkStop,
  rowProblem,
  rowsToLines,
  type GridLine,
  type GridRow,
  type WalkStop,
} from '../src/order/gridModel.js';

function counter(): () => string {
  let n = 0;
  return () => `k${++n}`;
}

function product(over: Record<string, unknown>): Product {
  return {
    id: 'p1',
    name: 'S-trap 220',
    alias: null,
    categoryName: 'One piece toilet',
    categoryCode: 'OPT',
    brand: 'Swisware+',
    size: null,
    multiColour: false,
    sortOrder: 1,
    images: [],
    variants: [],
    ...over,
  } as unknown as Product;
}

const variant = (id: string, label: string | null, code: string, isActive = true) => ({
  id,
  label,
  code,
  weightKg: 25,
  isActive,
});

const OPTIONS = { packagingRequired: false, colourListNonEmpty: true };

describe('buildRows', () => {
  it('opens a row for every active variant of every sub product, in the order given', () => {
    const rows = buildRows(
      [
        product({
          id: 'a',
          name: 'A',
          variants: [variant('v1', 'White', 'OPT-1'), variant('v2', 'Ivory', 'OPT-2', false)],
        }),
        product({
          id: 'b',
          name: 'B',
          multiColour: true,
          variants: [variant('v3', null, 'OPT-3')],
        }),
      ],
      { nextKey: counter() },
    );
    expect(rows.map((row) => [row.productId, row.code, row.rule])).toEqual([
      ['a', 'OPT-1', 'fixed'],
      ['b', 'OPT-3', 'selectable'],
    ]);
    expect(rows.map((row) => row.key)).toEqual(['k1', 'k2']);
    expect(rows.every((row) => row.qty === '' && row.packaging === '' && row.colour === '')).toBe(
      true,
    );
  });

  it("carries each row's own product facts, and the party's own names where it has them", () => {
    const rows = buildRows(
      [
        product({ id: 'a', variants: [variant('v1', 'White', 'OPT-1')] }),
        product({ id: 'b', name: 'B', variants: [variant('v2', null, 'OPT-2')] }),
      ],
      {
        nextKey: counter(),
        partyRecordFor: (id) => (id === 'b' ? { productName: 'Their B', size: 'L' } : null),
      },
    );
    expect(rows[0]!.productName).toBe('S-trap 220');
    expect(rows[0]!.fromPartyVariant).toBe(false);
    expect(rows[1]!.productName).toBe('Their B');
    expect(rows[1]!.size).toBe('L');
    expect(rows[1]!.fromPartyVariant).toBe(true);
    expect(rows[0]!.categoryCode).toBe('OPT');
  });
});

describe('addColourRow', () => {
  it('puts a blank copy right under the row, with a key of its own', () => {
    const next = counter();
    const rows = buildRows(
      [
        product({ id: 'a', multiColour: true, variants: [variant('v1', null, 'OPT-1')] }),
        product({ id: 'b', variants: [variant('v2', 'White', 'OPT-2')] }),
      ],
      { nextKey: next },
    );
    rows[0]!.colour = 'White';
    rows[0]!.qty = '10';
    rows[0]!.packaging = 'Box';
    const grown = addColourRow(rows, rows[0]!.key, next);
    expect(grown.map((row) => row.productId)).toEqual(['a', 'a', 'b']);
    expect(grown[1]).toMatchObject({ colour: '', qty: '', packaging: '', variantId: 'v1' });
    expect(new Set(grown.map((row) => row.key)).size).toBe(3);
    // The source row is untouched.
    expect(grown[0]).toMatchObject({ colour: 'White', qty: '10', packaging: 'Box' });
  });

  it('does nothing for a key that is not on the card', () => {
    const rows = buildRows([product({ variants: [variant('v1', 'White', 'X')] })], {
      nextKey: counter(),
    });
    expect(addColourRow(rows, 'nope', counter())).toEqual(rows);
  });
});

describe('when a row and the card can be added', () => {
  const row = (over: Partial<GridRow>): GridRow =>
    ({
      ...buildRows([product({ variants: [variant('v1', 'White', 'X')] })], {
        nextKey: counter(),
      })[0]!,
      ...over,
    }) as GridRow;

  it('ignores a row with no quantity, whatever else is missing', () => {
    expect(rowProblem(row({ rule: 'selectable', qty: '' }), OPTIONS)).toBeNull();
    expect(rowProblem(row({ rule: 'selectable', qty: '0' }), OPTIONS)).toBeNull();
  });

  it('wants a colour on a counted selectable row, unless the company has no colour list', () => {
    expect(rowProblem(row({ rule: 'selectable', qty: '3' }), OPTIONS)).toBe('colour');
    expect(rowProblem(row({ rule: 'selectable', qty: '3', colour: 'White' }), OPTIONS)).toBeNull();
    expect(
      rowProblem(row({ rule: 'selectable', qty: '3' }), { ...OPTIONS, colourListNonEmpty: false }),
    ).toBeNull();
    // A fixed or dedicated row never asks for one.
    expect(rowProblem(row({ rule: 'fixed', qty: '3' }), OPTIONS)).toBeNull();
  });

  it('wants a packaging on every counted row only while the company requires one', () => {
    expect(rowProblem(row({ qty: '3' }), { ...OPTIONS, packagingRequired: true })).toBe(
      'packaging',
    );
    expect(
      rowProblem(row({ qty: '3', packaging: 'Box' }), { ...OPTIONS, packagingRequired: true }),
    ).toBeNull();
    expect(rowProblem(row({ qty: '3' }), OPTIONS)).toBeNull();
  });

  it('is ready with at least one counted row and every counted row complete', () => {
    const empty = row({ qty: '' });
    const good = row({ key: 'g', qty: '2' });
    const bad = row({ key: 'b', qty: '2', rule: 'selectable' });
    expect(cardReady([empty], OPTIONS)).toBe(false);
    expect(cardReady([empty, good], OPTIONS)).toBe(true);
    expect(cardReady([good, bad], OPTIONS)).toBe(false);
    expect(cardPieces([empty, good, bad])).toBe(4);
  });
});

describe('rows and lines', () => {
  it("turns counted rows into lines in the card's order, with new keys", () => {
    const next = counter();
    const rows = buildRows(
      [
        product({
          id: 'a',
          variants: [variant('v1', 'White', 'A1'), variant('v2', 'Ivory', 'A2')],
        }),
      ],
      { nextKey: next },
    );
    rows[1]!.qty = '5';
    rows[0]!.qty = '3';
    const lines = rowsToLines(rows, next);
    expect(lines.map((line) => [line.code, line.quantity])).toEqual([
      ['A1', 3],
      ['A2', 5],
    ]);
    expect(lines.every((line) => /^k\d+$/.test(line.key) && !('qty' in line))).toBe(true);
  });

  it('puts saved lines back as rows that remember their key, so the lines stay themselves', () => {
    const next = counter();
    const saved: GridLine[] = [
      {
        ...buildRows([product({ variants: [variant('v1', 'White', 'A1')] })], {
          nextKey: next,
        })[0]!,
        key: 'saved-1',
        quantity: 7,
      } as unknown as GridLine,
      {
        ...buildRows([product({ id: 'b', variants: [variant('v2', 'Ivory', 'A2')] })], {
          nextKey: next,
        })[0]!,
        key: 'saved-2',
        quantity: 2,
      } as unknown as GridLine,
    ];
    const rows = linesToRows(saved, next);
    expect(rows.map((row) => [row.lineKey, row.qty])).toEqual([
      ['saved-1', '7'],
      ['saved-2', '2'],
    ]);
    // Added again unchanged, the lines come back with their own keys, same order.
    expect(rowsToLines(rows, next).map((line) => [line.key, line.quantity])).toEqual([
      ['saved-1', 7],
      ['saved-2', 2],
    ]);
  });
});

describe('groupLines', () => {
  const line = (key: string, code: string | null, name: string, quantity: number): GridLine =>
    ({ key, categoryCode: code, categoryName: name, brand: null, quantity }) as unknown as GridLine;

  it('groups by product in the order first seen, never reordering the lines', () => {
    const groups = groupLines([
      line('1', 'OPT', 'One piece', 10),
      line('2', 'WB', 'Wash basin', 5),
      line('3', 'OPT', 'One piece', 20),
    ]);
    expect(groups.map((group) => [group.code, group.pieces])).toEqual([
      ['OPT', 30],
      ['WB', 5],
    ]);
    expect(groups[0]!.lines.map((l) => l.key)).toEqual(['1', '3']);
  });

  it('tells two products with the same name but different codes apart', () => {
    const groups = groupLines([line('1', 'A', 'Same', 1), line('2', 'B', 'Same', 1)]);
    expect(groups).toHaveLength(2);
  });
});

describe('the row walk, forward and back', () => {
  const stops: WalkStop[] = [
    { rowKey: 'r1', field: 'qty' },
    { rowKey: 'r1', field: 'packaging' },
    { rowKey: 'r1', field: 'grade' },
    { rowKey: 'r2', field: 'colour' },
    { rowKey: 'r2', field: 'qty' },
    { rowKey: 'r2', field: 'packaging' },
    { rowKey: 'r2', field: 'grade' },
    { rowKey: null, field: 'add' },
  ];
  const rows = (table: Record<string, { qty: number; hasColour?: boolean }>) => (key: string) => ({
    qty: table[key]?.qty ?? 0,
    hasColour: table[key]?.hasColour ?? false,
  });

  it('goes on to the next field of a row that has a quantity', () => {
    const of = rows({ r1: { qty: 5 } });
    expect(nextWalkStop(stops, 0, of)).toBe(1);
    expect(nextWalkStop(stops, 1, of)).toBe(2);
    expect(nextWalkStop(stops, 2, of)).toBe(3);
  });

  it("skips a row's packaging and grade from an empty quantity, on to the next row", () => {
    const of = rows({});
    expect(nextWalkStop(stops, 0, of)).toBe(3);
    // From the last row's empty quantity: the Add button.
    expect(nextWalkStop(stops, 4, of)).toBe(7);
  });

  it('skips a row nobody has started from its closed colour select, but not one that has a colour or a quantity', () => {
    expect(nextWalkStop(stops, 3, rows({}))).toBe(7);
    expect(nextWalkStop(stops, 3, rows({ r2: { qty: 0, hasColour: true } }))).toBe(4);
    expect(nextWalkStop(stops, 3, rows({ r2: { qty: 3 } }))).toBe(4);
  });

  it('ends after the Add button', () => {
    expect(nextWalkStop(stops, 7, rows({}))).toBeNull();
    expect(nextWalkStop(stops, 99, rows({}))).toBeNull();
  });

  it('goes back one stop, leaving out the packaging and grade of a row with no quantity', () => {
    // r1 has a quantity: every stop of it is there on the way back.
    expect(prevWalkStop(stops, 3, rows({ r1: { qty: 5 } }))).toBe(2);
    expect(prevWalkStop(stops, 2, rows({ r1: { qty: 5 } }))).toBe(1);
    // r1 is empty: from the row below, back to its quantity, past its grade and packaging.
    expect(prevWalkStop(stops, 3, rows({}))).toBe(0);
    // From the Add button over an empty last row: that row's quantity.
    expect(prevWalkStop(stops, 7, rows({ r1: { qty: 5 } }))).toBe(4);
    expect(prevWalkStop(stops, 0, rows({}))).toBeNull();
  });
});
