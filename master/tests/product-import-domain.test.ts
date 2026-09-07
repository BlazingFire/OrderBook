/**
 * The pure half of the bulk import: how a header row is understood and how one
 * row of text becomes a `ProductInput` or a list of numbered problems.
 *
 * Pure, so it always runs — a `describe.skipIf` suite that skips looks exactly
 * like one that passes.
 */

import { describe, expect, it } from 'vitest';

import {
  findDuplicatesInFile,
  IMPORT_HEADERS,
  isBlankRow,
  matchHeaders,
  normalizeHeader,
  parseImportRow,
  templateGuideRows,
} from '../src/domain/product-import.js';

const ALL = { rates: true, cost: true };

function parse(headers: string[], cells: string[], allowed = ALL, row = 2) {
  return parseImportRow(cells, matchHeaders(headers), headers, row, allowed);
}

describe('header matching', () => {
  it('normalises case, spaces and punctuation', () => {
    expect(normalizeHeader('Product Code')).toBe('productcode');
    expect(normalizeHeader('product_code')).toBe('productcode');
    expect(normalizeHeader('Rate / box')).toBe('ratebox');
    expect(normalizeHeader('Coverage per box (sq ft)')).toBe('coverageperboxsqft');
  });

  it('maps the field keys, the form labels and the trade shorthand to the same fields', () => {
    const match = matchHeaders(['SKU', 'Product name', 'Rate / box', 'GST rate (%)', 'PEI', 'Colour', 'HSN']);
    expect(match.byIndex.map((column) => column?.field)).toEqual([
      'productCode',
      'name',
      'rate',
      'gstRatePct',
      'peiRating',
      'color',
      'hsnCode',
    ]);
    expect(match.ignored).toEqual([]);
    expect(match.missing).toEqual([]);
  });

  it('reports unknown headers as ignored, and a second header for the same field too', () => {
    const match = matchHeaders(['name', 'Supplier ref', 'Product name']);
    expect(match.byIndex.map((column) => column?.field ?? null)).toEqual(['name', null, null]);
    expect(match.ignored).toEqual(['Supplier ref', 'Product name']);
  });

  it('names the required column a file lacks', () => {
    expect(matchHeaders(['productCode', 'rate']).missing).toEqual(['name']);
  });

  it('accepts every header the template writes', () => {
    const match = matchHeaders([...IMPORT_HEADERS]);
    expect(match.ignored).toEqual([]);
    expect(match.missing).toEqual([]);
    expect(match.byIndex.every((column) => column !== null)).toBe(true);
  });
});

describe('parsing one row', () => {
  it('turns rupees into paise, keeps codes as text and leaves blank cells absent', () => {
    const { input, issues } = parse(
      ['productCode', 'name', 'rate', 'mrp', 'piecesPerBox', 'barcode', 'alias'],
      ['00123', 'Ivory Glossy', '1,200.50', 'Rs 1500', '8', '0089012345', ''],
    );

    expect(issues).toEqual([]);
    expect(input).toEqual({
      productCode: '00123',
      name: 'Ivory Glossy',
      rate: 120050,
      mrp: 150000,
      piecesPerBox: 8,
      barcode: '0089012345',
    });
    expect(input && 'alias' in input).toBe(false);
  });

  it('normalises closed-set values and their everyday synonyms', () => {
    const { input } = parse(
      ['name', 'uom', 'edgeType', 'application'],
      ['Tile', 'Boxes', 'Non rectified', 'Floor and wall'],
    );
    expect(input).toMatchObject({ uom: 'box', edgeType: 'non_rectified', application: 'floor_wall' });
  });

  it('names the column and the allowed values for a value outside the set', () => {
    const { input, issues } = parse(['name', 'Counted in'], ['Tile', 'crates']);
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
      ['name', 'rate', 'peiRating', 'gstRatePct', 'piecesPerBox'],
      ['Tile', 'twelve', '7', '150', '2.5'],
      ALL,
      9,
    );
    expect(issues.map((issue) => [issue.row, issue.column, issue.messageKey])).toEqual([
      [9, 'rate', 'validation.import.notANumber'],
      [9, 'peiRating', 'validation.product.peiRating'],
      [9, 'gstRatePct', 'validation.product.percentage'],
      [9, 'piecesPerBox', 'validation.import.notAWholeNumber'],
    ]);
  });

  it('refuses a price the actor may not set, per row, and names the permission', () => {
    const { input, issues } = parse(
      ['name', 'rate', 'purchaseRate'],
      ['Tile', '100', '80'],
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
    const { input, issues } = parse(['name', 'rate'], ['Tile', ''], { rates: false, cost: false });
    expect(issues).toEqual([]);
    expect(input).toEqual({ productCode: '', name: 'Tile' });
  });

  it('requires a name', () => {
    const { issues } = parse(['productCode', 'name'], ['X-1', '   ']);
    expect(issues).toEqual([
      { row: 2, kind: 'error', column: 'name', messageKey: 'validation.product.nameRequired', params: undefined },
    ]);
  });

  it('refuses a negative amount', () => {
    const { issues } = parse(['name', 'mrp'], ['Tile', '-5']);
    expect(issues.map((issue) => issue.messageKey)).toEqual(['validation.product.negativeAmount']);
  });
});

describe('the file as a whole', () => {
  it('treats a row of empty cells as blank', () => {
    expect(isBlankRow(['', '  ', ''])).toBe(true);
    expect(isBlankRow(['', 'x'])).toBe(false);
  });

  it('flags the second and later occurrences of a code or barcode, pointing at the first', () => {
    const rows = [
      { row: 2, input: { productCode: 'A-1', name: 'One', barcode: '111' } },
      { row: 3, input: { productCode: 'a-1', name: 'Two' } },
      { row: 4, input: { productCode: 'B-2', name: 'Three', barcode: '111' } },
      { row: 5, input: { productCode: '', name: 'Four' } },
      { row: 6, input: { productCode: '', name: 'Five' } },
    ];
    const headerFor = (field: string) => (field === 'productCode' ? 'Code' : field);

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
    ]);
  });

  it('writes one guide row per template column', () => {
    const guide = templateGuideRows();
    expect(guide).toHaveLength(IMPORT_HEADERS.length);
    expect(guide.find((row) => row[0] === 'uom')?.[3]).toBe('box, sqft, piece');
    expect(guide.find((row) => row[0] === 'name')?.[1]).toBe('yes');
  });
});
