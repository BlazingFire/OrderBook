/**
 * The pure half of the bulk import: how a header row is understood, how one
 * row of text becomes a model-and-variant or a list of numbered problems, and
 * how rows fold into products.
 *
 * Pure, so it always runs — a `describe.skipIf` suite that skips looks exactly
 * like one that passes.
 */

import { describe, expect, it } from 'vitest';

import {
  findDuplicatesInFile,
  groupImportRows,
  IMPORT_HEADERS,
  isBlankRow,
  matchHeaders,
  normalizeHeader,
  parseImportRow,
  templateGuideRows,
  type ParsedRow,
} from '../src/domain/product-import.js';

const ALL = { rates: true, cost: true };

function parse(headers: string[], cells: string[], allowed = ALL, row = 2) {
  return parseImportRow(cells, matchHeaders(headers), headers, row, allowed);
}

const BASE = ['categoryName', 'name', 'code'];

describe('header matching', () => {
  it('normalises case, spaces and punctuation', () => {
    expect(normalizeHeader('Product Code')).toBe('productcode');
    expect(normalizeHeader('product_code')).toBe('productcode');
    expect(normalizeHeader('Weight (kg)')).toBe('weightkg');
    expect(normalizeHeader('Colour / variant')).toBe('colourvariant');
  });

  it('maps the field keys, the form labels and the trade shorthand to the same fields', () => {
    const match = matchHeaders(['Category', 'Model', 'Colour', 'SKU', 'Weight (kg)', 'Rate', 'GST', 'HSN']);
    expect(match.byIndex.map((column) => column?.field)).toEqual([
      'categoryName',
      'name',
      'variant',
      'code',
      'weightKg',
      'rate',
      'gstRatePct',
      'hsnCode',
    ]);
    expect(match.ignored).toEqual([]);
    expect(match.missing).toEqual([]);
  });

  it('reports unknown headers as ignored, and a second header for the same field too', () => {
    const match = matchHeaders([...BASE, 'Supplier ref', 'Product name']);
    expect(match.byIndex.map((column) => column?.field ?? null)).toEqual([
      'categoryName',
      'name',
      'code',
      null,
      null,
    ]);
    expect(match.ignored).toEqual(['Supplier ref', 'Product name']);
  });

  it('names the required columns a file lacks', () => {
    expect(matchHeaders(['code', 'rate']).missing).toEqual(['categoryName', 'name']);
    expect(matchHeaders(['categoryName', 'name']).missing).toEqual(['code']);
  });

  it('accepts every header the template writes', () => {
    const match = matchHeaders([...IMPORT_HEADERS]);
    expect(match.ignored).toEqual([]);
    expect(match.missing).toEqual([]);
    expect(match.byIndex.every((column) => column !== null)).toBe(true);
  });
});

describe('parsing one row', () => {
  it('splits the row into the model and its variant, converting money and keeping codes as text', () => {
    const { input, issues } = parse(
      [...BASE, 'variant', 'weightKg', 'rate', 'mrp', 'barcode', 'alias'],
      ['ONE PIECE BASIN', 'DAMRU', '00041', 'Vitrosa 41', '18.5', '1,200.50', 'Rs 1500', '0089012345', ''],
    );

    expect(issues).toEqual([]);
    expect(input).toEqual({
      product: {
        categoryName: 'ONE PIECE BASIN',
        name: 'DAMRU',
        rate: 120050,
        mrp: 150000,
        barcode: '0089012345',
      },
      variant: { code: '00041', label: 'Vitrosa 41', weightKg: 18.5 },
    });
    expect(input && 'alias' in input.product).toBe(false);
  });

  it('leaves a blank variant and a blank weight as null, not absent', () => {
    const { input } = parse([...BASE, 'variant', 'weightKg'], ['Urinals', 'Hexa', 'HEXA', '', '']);
    expect(input?.variant).toEqual({ code: 'HEXA', label: null, weightKg: null });
  });

  it('normalises the unit and its everyday synonyms', () => {
    expect(parse([...BASE, 'uom'], ['Pans', 'Orissa', 'OP-20', 'pcs']).input?.product.uom).toBe('piece');
    expect(parse([...BASE, 'uom'], ['Pans', 'Orissa', 'OP-20', 'Boxes']).input?.product.uom).toBe('box');
  });

  it('names the column and the allowed values for a value outside the set', () => {
    const { input, issues } = parse([...BASE, 'Counted in'], ['Pans', 'Orissa', 'OP-20', 'crates']);
    expect(input).toBeNull();
    expect(issues).toEqual([
      {
        row: 2,
        kind: 'error',
        column: 'Counted in',
        messageKey: 'validation.import.invalidValue',
        params: { column: 'Counted in', allowed: 'box, sqft, piece' },
      },
    ]);
  });

  it('reports every bad cell in the row, not just the first', () => {
    const { issues } = parse(
      [...BASE, 'rate', 'weightKg', 'gstRatePct'],
      ['Pans', 'Orissa', 'OP-20', 'twelve', '0', '150'],
      ALL,
      9,
    );
    expect(issues.map((issue) => [issue.row, issue.column, issue.messageKey])).toEqual([
      [9, 'rate', 'validation.import.notANumber'],
      [9, 'weightKg', 'validation.product.weightPositive'],
      [9, 'gstRatePct', 'validation.product.percentage'],
    ]);
  });

  it('refuses a price the actor may not set, per row, and names the permission', () => {
    const { input, issues } = parse(
      [...BASE, 'rate', 'purchaseRate'],
      ['Pans', 'Orissa', 'OP-20', '100', '80'],
      { rates: false, cost: false },
    );
    expect(input).toBeNull();
    expect(issues).toEqual([
      {
        row: 2,
        kind: 'error',
        column: 'rate',
        messageKey: 'error.forbidden.missingPermission',
        params: { permission: 'field.saleRate.edit' },
      },
      {
        row: 2,
        kind: 'error',
        column: 'purchaseRate',
        messageKey: 'error.forbidden.missingPermission',
        params: { permission: 'field.purchaseRate.edit' },
      },
    ]);
  });

  it('lets a blank price cell through for an actor without the permission', () => {
    const { input, issues } = parse([...BASE, 'rate'], ['Pans', 'Orissa', 'OP-20', ''], {
      rates: false,
      cost: false,
    });
    expect(issues).toEqual([]);
    expect(input?.product).toEqual({ categoryName: 'Pans', name: 'Orissa' });
  });

  it('requires a category, a model name and a code', () => {
    expect(parse(BASE, ['   ', 'Orissa', 'OP-20']).issues.map((issue) => issue.messageKey)).toEqual([
      'validation.product.categoryRequired',
    ]);
    expect(parse(BASE, ['Pans', '   ', 'OP-20']).issues.map((issue) => issue.messageKey)).toEqual([
      'validation.product.nameRequired',
    ]);
    expect(parse(BASE, ['Pans', 'Orissa', '']).issues).toEqual([
      {
        row: 2,
        kind: 'error',
        column: 'code',
        messageKey: 'validation.product.variantCodeRequired',
        params: undefined,
      },
    ]);
  });

  it('refuses a negative amount', () => {
    const { issues } = parse([...BASE, 'mrp'], ['Pans', 'Orissa', 'OP-20', '-5']);
    expect(issues.map((issue) => issue.messageKey)).toEqual(['validation.product.negativeAmount']);
  });
});

function row(
  rowNumber: number,
  category: string,
  name: string,
  code: string,
  label: string | null = null,
  extra: Record<string, unknown> = {},
): ParsedRow {
  return {
    row: rowNumber,
    input: {
      product: { categoryName: category, name, ...extra },
      variant: { code, label, weightKg: null },
    },
  };
}

describe('the file as a whole', () => {
  it('treats a row of empty cells as blank', () => {
    expect(isBlankRow(['', '  ', ''])).toBe(true);
    expect(isBlankRow(['', 'x'])).toBe(false);
  });

  it('flags the second and later occurrences of a code, a barcode or a variant, pointing at the first', () => {
    const rows = [
      row(2, 'Basins', 'Damru', 'A-1', 'White', { barcode: '111' }),
      row(3, 'Basins', 'Damru', 'a-1', 'Blue'),
      row(4, 'Basins', 'Damru', 'B-2', 'Red', { barcode: '111' }),
      row(5, 'Basins', 'damru', 'C-3', 'white'),
    ];
    const headerFor = (field: string) => (field === 'code' ? 'Code' : field);

    expect(findDuplicatesInFile(rows, headerFor as never)).toEqual([
      {
        row: 3,
        kind: 'error',
        column: 'Code',
        messageKey: 'validation.import.duplicateInFile',
        params: { column: 'Code', firstRow: 2 },
      },
      {
        row: 4,
        kind: 'error',
        column: 'barcode',
        messageKey: 'validation.import.duplicateInFile',
        params: { column: 'barcode', firstRow: 2 },
      },
      {
        row: 5,
        kind: 'error',
        column: 'variant',
        messageKey: 'validation.import.duplicateInFile',
        params: { column: 'variant', firstRow: 2 },
      },
    ]);
  });

  it('folds rows sharing a category and model into one product with variants', () => {
    const { groups, issues } = groupImportRows(
      [
        row(2, 'Basins', 'Damru', '41', 'Vitrosa 41', { rate: 100 }),
        row(3, 'basins', 'DAMRU', '42', 'Vitrosa 42', { rate: 999 }),
        row(4, 'Urinals', 'Hexa', 'HEXA'),
      ],
      (field) => field,
    );

    expect(issues).toEqual([]);
    expect(groups.map((group) => group.input)).toEqual([
      {
        categoryName: 'Basins',
        name: 'Damru',
        // The first row's model fields win.
        rate: 100,
        hasVariants: true,
        variants: [
          { code: '41', label: 'Vitrosa 41', weightKg: null, sequence: 1 },
          { code: '42', label: 'Vitrosa 42', weightKg: null, sequence: 2 },
        ],
      },
      {
        categoryName: 'Urinals',
        name: 'Hexa',
        hasVariants: false,
        variants: [{ code: 'HEXA', label: null, weightKg: null, sequence: 1 }],
      },
    ]);
    expect(groups.map((group) => group.rows.map((entry) => entry.row))).toEqual([[2, 3], [4]]);
  });

  it('refuses a model that names a variant on some rows and none on others', () => {
    const { groups, issues } = groupImportRows(
      [row(2, 'Basins', 'Damru', '41', 'Vitrosa 41'), row(3, 'Basins', 'Damru', 'DAMRU-W')],
      (field) => field,
    );

    expect(groups).toEqual([]);
    expect(issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
      [2, 'validation.import.mixedVariants'],
      [3, 'validation.import.mixedVariants'],
    ]);
  });

  it('writes one guide row per template column', () => {
    const guide = templateGuideRows();
    expect(guide).toHaveLength(IMPORT_HEADERS.length);
    expect(guide.find((row) => row[0] === 'uom')?.[3]).toBe('box, sqft, piece');
    expect(guide.find((row) => row[0] === 'name')?.[1]).toBe('yes');
    expect(guide.find((row) => row[0] === 'code')?.[1]).toBe('yes');
  });
});
