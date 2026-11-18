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
    code: 'OPT-1',
    weightKg: 25,
    colours: [],
    printSide: 'default',
    defaultPackaging: null,
    sortOrder: 1,
    images: [],
    ...over,
  } as unknown as Product;
}

const OPTIONS = { packagingRequired: false };

describe('buildRows', () => {
  it('opens a row for every sub product, in the order given, with its own colours', () => {
    const rows = buildRows(
      [
        product({ id: 'a', name: 'A', code: 'OPT-1', colours: ['White'] }),
        product({ id: 'b', name: 'B', code: 'OPT-3', colours: ['White', 'Ivory'] }),
      ],
      { nextKey: counter() },
    );
    expect(rows.map((row) => [row.productId, row.code, row.colours])).toEqual([
      ['a', 'OPT-1', ['White']],
      ['b', 'OPT-3', ['White', 'Ivory']],
    ]);
    expect(rows.map((row) => row.key)).toEqual(['k1', 'k2']);
    expect(rows.every((row) => row.qty === '' && row.colour === '')).toBe(true);
    // No default on either product, so the line asks, as it always did.
    expect(rows.every((row) => row.packaging === '')).toBe(true);
  });

  it("starts a row's packaging from the sub product's own default", () => {
    // The point of the column: the counter stops choosing the same value on
    // every order (owner, 2026-11-18), and anyone can still change the line.
    const rows = buildRows(
      [
        product({ id: 'a', code: 'OPT-1', defaultPackaging: 'Carton' }),
        product({ id: 'b', code: 'OPT-2', defaultPackaging: null }),
      ],
      { nextKey: counter() },
    );
    expect(rows[0]!.packaging).toBe('Carton');
    expect(rows[1]!.packaging).toBe('');
  });

  it("carries each row's own product facts, and the party's own names where it has them", () => {
    const rows = buildRows(
      [
        product({ id: 'a', code: 'OPT-1', colours: ['White'] }),
        product({ id: 'b', name: 'B', code: 'OPT-2' }),
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
        product({ id: 'a', code: 'OPT-1', colours: ['White', 'Ivory'] }),
        product({ id: 'b', code: 'OPT-2', colours: ['White'] }),
      ],
      { nextKey: next },
    );
    rows[0]!.colour = 'White';
    rows[0]!.qty = '10';
    rows[0]!.packaging = 'Box';
    const grown = addColourRow(rows, rows[0]!.key, next);
    expect(grown.map((row) => row.productId)).toEqual(['a', 'a', 'b']);
    expect(grown[1]).toMatchObject({ colour: '', qty: '', packaging: '', code: 'OPT-1' });
    expect(new Set(grown.map((row) => row.key)).size).toBe(3);
    // The source row is untouched.
    expect(grown[0]).toMatchObject({ colour: 'White', qty: '10', packaging: 'Box' });
  });

  it('does nothing for a key that is not on the card', () => {
    const rows = buildRows([product({ code: 'X', colours: ['White'] })], {
      nextKey: counter(),
    });
    expect(addColourRow(rows, 'nope', counter())).toEqual(rows);
  });
});

describe('when a row and the card can be added', () => {
  const row = (over: Partial<GridRow>): GridRow =>
    ({
      ...buildRows([product({ code: 'X', colours: ['White'] })], {
        nextKey: counter(),
      })[0]!,
      ...over,
    }) as GridRow;

  it('ignores a row with no quantity, whatever else is missing', () => {
    expect(rowProblem(row({ colours: ['White', 'Ivory'], qty: '' }), OPTIONS)).toBeNull();
    expect(rowProblem(row({ colours: ['White', 'Ivory'], qty: '0' }), OPTIONS)).toBeNull();
  });

  it('wants a colour on a counted row whose sub product offers several', () => {
    expect(rowProblem(row({ colours: ['White', 'Ivory'], qty: '3' }), OPTIONS)).toBe('colour');
    expect(
      rowProblem(row({ colours: ['White', 'Ivory'], qty: '3', colour: 'White' }), OPTIONS),
    ).toBeNull();
    // One colour or none never asks for one.
    expect(rowProblem(row({ colours: ['White'], qty: '3' }), OPTIONS)).toBeNull();
    expect(rowProblem(row({ colours: [], qty: '3' }), OPTIONS)).toBeNull();
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
    const bad = row({ key: 'b', qty: '2', colours: ['White', 'Ivory'] });
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
        product({ id: 'a', code: 'A1', colours: ['White'] }),
        product({ id: 'b', name: 'B', code: 'A2', colours: ['Ivory'] }),
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
        ...buildRows([product({ code: 'A1', colours: ['White'] })], {
          nextKey: next,
        })[0]!,
        key: 'saved-1',
        quantity: 7,
      } as unknown as GridLine,
      {
        ...buildRows([product({ id: 'b', code: 'A2', colours: ['Ivory'] })], {
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
