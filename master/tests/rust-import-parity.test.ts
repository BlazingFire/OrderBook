/**
 * Rust sidecar parity for sheet row parsing (`lib/product-import-via-rust.ts`).
 *
 * The batch must answer exactly what the TypeScript loop computes — same
 * inputs (or null), same issues in the same order — whether the binary is
 * present (Rust parses the whole sheet in one spawn) or absent (TypeScript
 * parses row by row). `product-import.service.ts` filters blank and
 * out-of-scope rows before calling, so the test does the same.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  isBlankRow,
  matchHeaders,
  parseImportRow,
} from '../src/domain/product-import.js';
import {
  parseImportSheetViaRust,
  type ParsedImportSheetRow,
} from '../src/lib/product-import-via-rust.js';
import { helperPath, resetRustBridgeForTest, tryHelper } from '../src/lib/rust-bridge.js';

const HEADER_POOL = [
  'Brand',
  'Main product',
  'Sub product',
  'Code',
  'Weight (kg)',
  'Colour',
  'productcode',
  'weight',
  'Multicolour',
  'Colour rule',
  'Size',
  'Alias',
  'Main product code',
  'Dimensions',
  'weightkgs',
  'colorrule',
  'RANDOM!',
  'Model',
  'Rule',
  'make',
];
const CELL_POOL = [
  'OPT-0001',
  'Damru',
  '12.5',
  '12,5',
  '1.234,5',
  '12kg',
  'yes',
  'N',
  'true',
  'maybe',
  '',
  '  ',
  'fixed',
  'SELECTABLE',
  'dedicated',
  'old',
  '-3',
  '0',
  'abc',
  '1,200.50',
  '0,125',
  '1e3',
  '0x10',
  '  padded  line  break ',
  'Glazed Vitrified',
  '600x600_MATT',
];

function seedRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seedRandom(20261130);
const pick = <T>(pool: T[]): T => {
  const item = pool[Math.floor(rand() * pool.length) % pool.length];
  if (item === undefined) throw new Error('empty test pool');
  return item;
};

function makeSheet(): { headerRow: string[]; rows: Array<{ cells: string[]; row: number }> } {
  const width = 1 + Math.floor(rand() * 6);
  const headerRow = Array.from({ length: width }, () => pick(HEADER_POOL));
  const rows: Array<{ cells: string[]; row: number }> = [];
  let selected = 2;
  for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) {
    const cells = Array.from({ length: width }, () => pick(CELL_POOL));
    if (rand() < 0.15) {
      for (let k = 0; k < cells.length; k++) cells[k] = '   ';
    }
    if (!isBlankRow(cells)) {
      rows.push({ cells, row: selected });
    }
    selected += 1;
  }
  return { headerRow, rows };
}

function parseViaTypescript(
  headerRow: string[],
  rows: Array<{ cells: string[]; row: number }>,
  options: { restore: boolean; updateOnly: boolean },
): ParsedImportSheetRow[] {
  const match = matchHeaders(headerRow);
  return rows.map(({ cells, row }) => {
    const outcome = parseImportRow(cells, match, headerRow, row, options);
    return { input: outcome.input, issues: outcome.issues };
  });
}

afterEach(() => {
  delete process.env.ORDERBOOK_RUST_HELPER;
  resetRustBridgeForTest();
});

describe('parseImportSheet via Rust', () => {
  it('parses every sheet exactly like the TypeScript loop', async () => {
    for (const options of [
      { restore: false, updateOnly: false },
      { restore: true, updateOnly: false },
      { restore: false, updateOnly: true },
    ]) {
      for (let sheet = 0; sheet < 15; sheet++) {
        const { headerRow, rows } = makeSheet();
        const expected = parseViaTypescript(headerRow, rows, options);
        await expect(
          parseImportSheetViaRust(headerRow, rows, options),
          JSON.stringify({ headerRow, rows, options }),
        ).resolves.toEqual(expected);
      }
    }
  });

  it('falls back row by row when the helper is missing', async () => {
    process.env.ORDERBOOK_RUST_HELPER = 'C:\\definitely-not-here\\orderbook-helper.exe';
    resetRustBridgeForTest();
    const { headerRow, rows } = makeSheet();
    await expect(
      tryHelper({ op: 'parseImportSheet', headerRow, rows: [], rowNumbers: [] }),
    ).resolves.toBeNull();
    await expect(parseImportSheetViaRust(headerRow, rows, { restore: false, updateOnly: false })).resolves.toEqual(
      parseViaTypescript(headerRow, rows, { restore: false, updateOnly: false }),
    );
  });

  it('answers through a real binary when one is present', async () => {
    resetRustBridgeForTest();
    if (helperPath() === null) {
      await expect(tryHelper({ op: 'parseImportSheet', headerRow: [] })).resolves.toBeNull();
      return;
    }
    const outcome = (await tryHelper({
      op: 'parseImportSheet',
      headerRow: ['Main product', 'Sub product', 'Code'],
      rows: [['One Piece Basin', 'Damru', 'DPV-0001']],
      rowNumbers: ['2'],
      restore: 'false',
      updateOnly: 'false',
    })) as ParsedImportSheetRow[];
    expect(outcome).toEqual([
      {
        input: {
          product: { categoryName: 'One Piece Basin', name: 'Damru' },
          variant: { code: 'DPV-0001', label: null, weightKg: null },
        },
        issues: [],
      },
    ]);
  });
});
