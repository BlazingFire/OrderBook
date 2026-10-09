/**
 * The pure half of reading a product backup back (`domain/product-import.ts`,
 * `lib/csv.ts`): a restore's cells are the stored values exactly, a
 * multicolour sub product keeps the colours the export wrote, a decimal-comma
 * weight is read as the weight it was, twins stay two products, and a value
 * that begins with its own apostrophe survives the CSV's formula guard.
 *
 * Pure, so it always runs.
 */

import { describe, expect, it } from 'vitest';

import {
  findDuplicatesInFile,
  groupImportRows,
  matchHeaders,
  parseImportRow,
  separateTwins,
  type ParsedRow,
} from '../src/domain/product-import.js';
import { toCsv } from '../src/lib/csv.js';
import { parseCsv } from '../src/lib/spreadsheet.js';

const HEADER = ['Brand', 'Main product', 'Sub product', 'Size', 'Colour rule', 'Colour', 'Code', 'Weight (kg)', 'Alias'];

function parse(cells: string[], options: { restore?: boolean } = {}, row = 2) {
  return parseImportRow(cells, matchHeaders(HEADER), HEADER, row, options);
}

describe('a restore reads its cells as the stored values', () => {
  it('keeps inner spacing — double spaces, a line break, a non-breaking space — and trims only the ends', () => {
    const cells = [' Swis  ware ', 'WALL  HUNG', 'ROYAL SET', 'L-27  B-15', 'fixed', 'Off  White', 'R-1', '', 'a\nb'];
    const restored = parse(cells, { restore: true }).input!;
    expect(restored.product).toMatchObject({
      categoryBrand: 'Swis  ware',
      categoryName: 'WALL  HUNG',
      name: 'ROYAL SET',
      size: 'L-27  B-15',
      alias: 'a\nb',
    });
    expect(restored.variant.label).toBe('Off  White');

    // A typed sheet still reads "ONE  PIECE" as "ONE PIECE".
    const typed = parse(cells).input!;
    expect([typed.product.categoryName, typed.product.name, typed.variant.label]).toEqual([
      'WALL HUNG',
      'ROYAL SET',
      'Off White',
    ]);
  });

  it('reads a blank Alias or Size as cleared (null), where a typed sheet leaves it out', () => {
    const cells = ['B', 'M', 'S', '', 'dedicated', '', 'S-1', '', ''];
    expect(parse(cells, { restore: true }).input!.product).toMatchObject({ alias: null, size: null });
    const typed = parse(cells).input!.product;
    expect('alias' in typed || 'size' in typed).toBe(false);
  });

  it('keeps names that differ only by inner spacing as two sub products', () => {
    const rows: ParsedRow[] = [
      { row: 2, input: parse(['B', 'M', 'TWO SPACES', '', 'dedicated', '', 'T-1', '', ''], { restore: true }).input! },
      { row: 3, input: parse(['B', 'M', 'TWO  SPACES', '', 'dedicated', '', 'T-2', '', ''], { restore: true }).input! },
    ];
    expect(findDuplicatesInFile(rows, (field) => field)).toEqual([]);
    expect(groupImportRows(rows, (field) => field).groups).toHaveLength(2);
  });
});

describe('the colour rule', () => {
  it('keeps the colours of a multicolour sub product, and drops a dedicated one only', () => {
    const multi = parse(['B', 'M', 'BOTH', '', 'multicolour', 'White', 'B-1', '', '']).input!;
    expect([multi.product.multiColour, multi.variant.label]).toEqual([true, 'White']);
    expect(parse(['B', 'M', 'ANY', '', 'multicolour', '', 'A-1', '', '']).input!.variant.label).toBeNull();
    expect(parse(['B', 'M', 'D', '', 'dedicated', 'White', 'D-1', '', '']).input!.variant.label).toBeNull();
  });

  it('folds two labelled multicolour rows into one sub product with colours, not a duplicate', () => {
    const rows: ParsedRow[] = [
      { row: 2, input: parse(['B', 'M', 'BOTH', '', 'multicolour', 'White', 'B-1', '', '']).input! },
      { row: 3, input: parse(['B', 'M', 'BOTH', '', 'multicolour', 'Ivory', 'B-2', '', '']).input! },
    ];
    expect(findDuplicatesInFile(rows, (field) => field)).toEqual([]);
    const [group] = groupImportRows(rows, (field) => field).groups;
    expect(group!.input).toMatchObject({
      multiColour: true,
      hasVariants: true,
      variants: [
        { code: 'B-1', label: 'White' },
        { code: 'B-2', label: 'Ivory' },
      ],
    });
  });
});

describe('a weight', () => {
  const weight = (text: string) => parse(['B', 'M', 'S', '', 'dedicated', '', 'S-1', text, '']).input?.variant.weightKg;

  it('reads a lone comma as the decimal mark, and dot groups before a comma as thousands', () => {
    expect([weight('0,125'), weight('1,125'), weight('12,5'), weight('1.234,5')]).toEqual([0.125, 1.125, 12.5, 1234.5]);
  });

  it('still reads a dot decimal and comma thousands', () => {
    expect([weight('18.5'), weight('1,200.50'), weight('6.5 kg')]).toEqual([18.5, 1200.5, 6.5]);
  });
});

describe('twins already in the catalogue', () => {
  const twin = (row: number, code: string): ParsedRow => ({
    row,
    input: { product: { categoryCode: 'M', name: 'TWIN' }, variant: { code, label: null, weightKg: null } },
  });
  const owners: Record<string, string> = { 'TW-1': 'p1', 'TW-2': 'p2' };

  it('stay with the sub product each code is on, so neither row is a duplicate of the other', () => {
    const rows = [twin(2, 'TW-1'), twin(3, 'TW-2')];
    separateTwins(rows, (code) => owners[code]);
    expect(findDuplicatesInFile(rows, (field) => field)).toEqual([]);
    expect(groupImportRows(rows, (field) => field).groups.map((group) => group.rows.map((entry) => entry.row))).toEqual([
      [2],
      [3],
    ]);
  });

  it('leaves a sub product whose codes sit on one product, beside a row with a new code, as one group', () => {
    const rows = [twin(2, 'TW-1'), twin(3, 'TW-9')];
    separateTwins(rows, (code) => owners[code]);
    expect(rows.map((entry) => entry.input.owner)).toEqual([undefined, undefined]);
  });
});

describe('the CSV formula guard', () => {
  it('gives back a value that starts with its own apostrophe before - = + @', () => {
    const values = ["'-90 BEND", "'+1", "'-1", "''=x", "'@home", '-5', "'plain", "it's"];
    expect(parseCsv(toCsv(['x'], values.map((value) => [value]))).slice(1).map(([cell]) => cell)).toEqual(values);
  });
});
