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

function parse(headers: string[], cells: string[], row = 2) {
  return parseImportRow(cells, matchHeaders(headers), headers, row);
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
    const match = matchHeaders(['Category', 'Model', 'Colour', 'SKU', 'Weight (kg)', 'Dimensions', 'All colours']);
    expect(match.byIndex.map((column) => column?.field)).toEqual([
      'categoryName',
      'name',
      'variant',
      'code',
      'weightKg',
      'size',
      'multiColour',
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
    expect(matchHeaders(['code', 'size']).missing).toEqual(['categoryName', 'name']);
    expect(matchHeaders(['categoryName', 'name']).missing).toEqual(['code']);
  });

  it('accepts every header the template writes', () => {
    const match = matchHeaders([...IMPORT_HEADERS]);
    expect(match.ignored).toEqual([]);
    expect(match.missing).toEqual([]);
    expect(match.byIndex.every((column) => column !== null)).toBe(true);
  });
});

describe('catalogue v2 columns', () => {
  it("knows the owner's words for brand, product, product code and sub product", () => {
    const match = matchHeaders(['Brand', 'Main product', 'Main product code', 'Sub product', 'Code']);
    expect(match.byIndex.map((column) => column?.field)).toEqual([
      'categoryBrand',
      'categoryName',
      'categoryCode',
      'name',
      'code',
    ]);
    expect(match.ignored).toEqual([]);
    expect(match.missing).toEqual([]);
  });

  it('lets a product code stand in for the product name, and nothing else', () => {
    expect(matchHeaders(['categoryCode', 'name', 'code']).missing).toEqual([]);
    expect(matchHeaders(['categoryBrand', 'name', 'code']).missing).toEqual(['categoryName']);

    const { input, issues } = parse(['categoryCode', 'name', 'code'], ['OPT', '102 (9")', 'OPT-0001']);
    expect(issues).toEqual([]);
    expect(input?.product).toEqual({ categoryCode: 'OPT', name: '102 (9")' });

    expect(
      parse(['categoryCode', 'categoryName', 'name', 'code'], ['', '', 'Hexa', 'HEXA']).issues.map(
        (issue) => issue.messageKey,
      ),
    ).toEqual(['validation.product.categoryRequired']);
  });

  it('keeps two brands’ products of the same name apart, and folds rows naming one code', () => {
    const { groups } = groupImportRows(
      [
        row(2, 'One Piece Toilet', 'Damru', 'A-1', null, { categoryBrand: 'Swisware+' }),
        row(3, 'One Piece Toilet', 'Damru', 'B-1', null, { categoryBrand: 'Other' }),
        { row: 4, input: { product: { categoryCode: 'opt', name: 'Hexa' }, variant: { code: 'H-1', label: 'White', weightKg: null } } },
        { row: 5, input: { product: { categoryCode: 'OPT', name: 'hexa' }, variant: { code: 'H-2', label: 'Ivory', weightKg: null } } },
      ],
      (field) => field,
    );

    expect(groups.map((group) => group.rows.map((entry) => entry.row))).toEqual([[2], [3], [4, 5]]);
  });
});

describe('parsing one row', () => {
  it('splits the row into the model and its variant, keeping codes as text', () => {
    const { input, issues } = parse(
      [...BASE, 'variant', 'weightKg', 'size', 'multiColour', 'alias'],
      ['ONE PIECE BASIN', 'DAMRU', '00041', 'Vitrosa 41', '18.5 kg', 'L-16 H-31', 'yes', ''],
    );

    expect(issues).toEqual([]);
    expect(input).toEqual({
      product: {
        categoryName: 'ONE PIECE BASIN',
        name: 'DAMRU',
        size: 'L-16 H-31',
        multiColour: true,
      },
      variant: { code: '00041', label: 'Vitrosa 41', weightKg: 18.5 },
    });
    expect(input && 'alias' in input.product).toBe(false);
  });

  it('leaves a blank variant and a blank weight as null, not absent', () => {
    const { input } = parse([...BASE, 'variant', 'weightKg'], ['Urinals', 'Hexa', 'HEXA', '', '']);
    expect(input?.variant).toEqual({ code: 'HEXA', label: null, weightKg: null });
  });

  it('reads the colour switch in the words a sheet uses', () => {
    for (const word of ['yes', 'Y', 'TRUE', '1']) {
      expect(parse([...BASE, 'multiColour'], ['Pans', 'Orissa', 'OP-20', word]).input?.product.multiColour).toBe(true);
    }
    for (const word of ['no', 'n', 'false', '0']) {
      expect(parse([...BASE, 'multiColour'], ['Pans', 'Orissa', 'OP-20', word]).input?.product.multiColour).toBe(false);
    }
  });

  it('names the column and the allowed values for a switch word it does not know', () => {
    const { input, issues } = parse([...BASE, 'All colours'], ['Pans', 'Orissa', 'OP-20', 'maybe']);
    expect(input).toBeNull();
    expect(issues).toEqual([
      {
        row: 2,
        kind: 'error',
        column: 'All colours',
        messageKey: 'validation.import.invalidValue',
        params: { column: 'All colours', allowed: 'yes, no' },
      },
    ]);
  });

  it('reports every bad cell in the row, not just the first', () => {
    const { issues } = parse(
      [...BASE, 'weightKg', 'multiColour'],
      ['Pans', 'Orissa', 'OP-20', '0', 'sometimes'],
      9,
    );
    expect(issues.map((issue) => [issue.row, issue.column, issue.messageKey])).toEqual([
      [9, 'weightKg', 'validation.product.weightPositive'],
      [9, 'multiColour', 'validation.import.invalidValue'],
    ]);
  });

  it('refuses a weight that is not a number', () => {
    const { issues } = parse([...BASE, 'weightKg'], ['Pans', 'Orissa', 'OP-20', 'twelve']);
    expect(issues.map((issue) => [issue.column, issue.messageKey])).toEqual([
      ['weightKg', 'validation.import.notANumber'],
    ]);
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

  it('flags the second and later occurrences of a code or a variant, pointing at the first', () => {
    const rows = [
      row(2, 'Basins', 'Damru', 'A-1', 'White'),
      row(3, 'Basins', 'Damru', 'a-1', 'Blue'),
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
        row(2, 'Basins', 'Damru', '41', 'Vitrosa 41', { size: 'L-16 H-31' }),
        row(3, 'basins', 'DAMRU', '42', 'Vitrosa 42', { size: 'L-99 H-99' }),
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
        size: 'L-16 H-31',
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

  it('reads the colour rule: fixed keeps the colour, dedicated drops it, multicolour sets the flag', () => {
    const cols = ['Main product', 'Sub product', 'Code', 'Colour rule', 'Colour'];
    const fixed = parse(cols, ['Basins', 'Damru', 'D-1', 'fixed', 'White']).input;
    expect(fixed?.variant.label).toBe('White');
    expect(fixed?.product.multiColour).toBe(false);

    const dedicated = parse(cols, ['Basins', '1111', 'D-2', 'dedicated', 'White']).input;
    expect(dedicated?.variant.label).toBeNull();

    const multi = parse(cols, ['Pans', 'Orissa', 'P-1', 'Multicolour', '']).input;
    expect(multi?.product.multiColour).toBe(true);
    expect(multi?.variant.label).toBeNull();

    expect(parse(cols, ['Basins', 'Damru', 'D-3', 'fixed', '']).issues.map((i) => i.messageKey)).toEqual([
      'validation.import.fixedNeedsColour',
    ]);
    expect(parse(cols, ['Basins', 'Damru', 'D-4', 'odd', '']).issues.map((i) => i.messageKey)).toEqual([
      'validation.import.invalidValue',
    ]);
  });

  it('writes one guide row per template column', () => {
    const guide = templateGuideRows(true);
    expect(guide).toHaveLength(IMPORT_HEADERS.length);
    expect(guide.find((row) => row[0] === 'Colour rule')?.[1]).toBe('');
    expect(guide.find((row) => row[0] === 'Sub product')?.[1]).toBe('yes');
    expect(guide.find((row) => row[0] === 'Code')?.[1]).toBe('yes');
    expect(guide.find((row) => row[0] === 'Main product')?.[3]).toMatch(/Created if it does not exist yet/);
  });

  it('tells the truth about categories when the company does not let an import create one', () => {
    // The template is the one thing a person reads before filling the sheet
    // in. Left alone it would promise the opposite of what the import does.
    const standing = templateGuideRows(true);
    const changed = templateGuideRows(false);
    expect(changed.find((row) => row[0] === 'Main product')?.[3]).toBe(
      'Required unless Main product code is filled. Must already exist — an import cannot create one.',
    );
    // Every other note is untouched.
    const differing = changed
      .filter((row, index) => row[3] !== standing[index]?.[3])
      .map((row) => row[0]);
    expect(differing).toEqual(['Main product']);
  });
});
