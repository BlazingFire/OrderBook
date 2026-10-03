/**
 * R20: the product import and export keep working across versions.
 *
 * `fixtures/products-export-1.2.5.*` are files in the layout the product
 * screens wrote at 1.2.5 (the newest shipped build): the ten template columns
 * of `IMPORT_COLUMNS`, which `git diff 5ed91cc` shows unchanged to this day, a
 * BOM and CRLF for the CSV, a text-formatted Code column and a numeric weight
 * for the workbook. They are hand-built to that layout (generating a real
 * export needs a 1.2.5 Master), so they pin the layout, not a binary.
 * `-with-stock.csv` is the same file with the four stock columns somebody
 * added to an old sheet by hand; stock left in 1.4 (R15), so they are ignored.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRODUCT_FORMAT_SUBJECT, PRODUCT_FORMAT_VERSION, productFormatOf } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { IMPORT_COLUMNS, IMPORT_HEADERS } from '../src/domain/product-import.js';
import { readSheetRows, readSheetSubject } from '../src/lib/spreadsheet.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import {
  exportProducts,
  importProducts,
  productImportTemplate,
} from '../src/services/product-import.service.js';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string) => ({ buffer: readFileSync(path.join(FIXTURES, name)), fileName: name });

/** The 1.2.5 template header, written out: this literal is the contract, not `IMPORT_HEADERS`. */
const HEADERS_1_2_5 = [
  'Brand',
  'Main product code',
  'Main product',
  'Sub product',
  'Size',
  'Colour rule',
  'Colour',
  'Code',
  'Weight (kg)',
  'Alias',
];

/** The fixture's six sub products as the sheet states them, by Code. */
const EXPECTED = new Map<string, string[]>([
  ['OPT-0001', ['Swisware+', 'OPT', 'One Piece Toilet', '102 (9")', 'L-27, B-15, H-26', 'fixed', 'White', 'OPT-0001', '32.5', '']],
  ['OPT-0002', ['Swisware+', 'OPT', 'One Piece Toilet', '111 (9")', 'L-27, B-14, H-25', 'fixed', 'White', 'OPT-0002', '', '']],
  ['OPB-0001', ['Swisware+', 'OPB', 'One Piece Basin', 'DAMRU', '18x12', 'dedicated', '', 'OPB-0001', '12.25', 'Damru']],
  ['WB-0001', ['Swisware+', 'WB', 'Wash Basin', 'WB-18X12', '18x12', 'multicolour', '', 'WB-0001', '6.4', '18 by 12']],
  ['WB-0002', ['Swisware+', 'WB', 'Wash Basin', 'MAGENTA "D"', '', 'fixed', 'Magenta', 'WB-0002', '5', '']],
  ['TNK-0001', ['Another Co', 'TNK', 'Cistern', 'Dual Flush', '', 'dedicated', '', 'TNK-0001', '9.1', '']],
]);

describe('the product file format is versioned and did not move', () => {
  it('has the 1.2.5 header, in the 1.2.5 order, and no required column 1.2.5 did not require', () => {
    expect([...IMPORT_HEADERS]).toEqual(HEADERS_1_2_5);
    // A 1.2.5 file never had a column a newer one demands: what must be filled
    // is the sub product and its code, and the main product by name (or code).
    expect(IMPORT_COLUMNS.filter((column) => column.required).map((column) => column.field)).toEqual([
      'categoryName',
      'name',
      'code',
    ]);
  });

  it('reads a workbook subject as a version, and nothing else as one', () => {
    expect(productFormatOf(`${PRODUCT_FORMAT_SUBJECT} ${PRODUCT_FORMAT_VERSION}`)).toBe(PRODUCT_FORMAT_VERSION);
    expect(productFormatOf(`${PRODUCT_FORMAT_SUBJECT} 3`)).toBe(3);
    for (const other of [null, undefined, '', 'Products', `${PRODUCT_FORMAT_SUBJECT} x`, `${PRODUCT_FORMAT_SUBJECT} 0`]) {
      expect(productFormatOf(other)).toBeNull();
    }
  });
});

describe.skipIf(!canRunIntegrationTests)('product import / export compatibility (integration)', () => {
  let admin: ActorContext;

  beforeAll(async () => {
    await setupDatabase();
    admin = await testActor();
  }, 120_000);
  afterAll(teardownDatabase);

  /**
   * The main products the file names. A sheet that names a main product by its
   * code needs it to exist already (the code never creates one), exactly as at
   * 1.2.5: an export is imported back into the catalogue it came from.
   */
  async function freshCatalogue(): Promise<void> {
    await resetData();
    for (const brand of ['Swisware+', 'Another Co']) {
      await fields.createValue({ listKey: 'product.brand', value: brand, label: brand, hex: null }, admin);
    }
    for (const [name, code, brand] of [
      ['One Piece Toilet', 'OPT', 'Swisware+'],
      ['One Piece Basin', 'OPB', 'Swisware+'],
      ['Wash Basin', 'WB', 'Swisware+'],
      ['Cistern', 'TNK', 'Another Co'],
    ] as const) {
      await catalog.createCategory({ name, code, brand }, admin);
    }
  }

  /** The catalogue as the export writes it, keyed by Code, cells as text. */
  async function exportedByCode(format: 'csv' | 'xlsx'): Promise<Map<string, string[]>> {
    const rows = await readSheetRows((await exportProducts(format, admin)).bytes);
    expect(rows[0]).toEqual(HEADERS_1_2_5);
    return new Map(rows.slice(1).map((row) => [row[7] ?? '', HEADERS_1_2_5.map((_, at) => row[at] ?? '')]));
  }

  for (const name of ['products-export-1.2.5.csv', 'products-export-1.2.5.xlsx']) {
    it(`imports ${name} into 1.4 with no loss: every cell comes back out of the export`, async () => {
      await freshCatalogue();

      const preview = await importProducts(fixture(name), { dryRun: true, mode: 'create' }, admin);
      expect(preview).toMatchObject({ created: 6, failed: 0, skipped: 0, ignoredColumns: [] });
      expect(preview.issues).toEqual([]);
      // A pre-1.4 file declares no format; the importer says so rather than guessing.
      expect(preview.formatVersion).toBeNull();

      const done = await importProducts(fixture(name), { dryRun: false, mode: 'create' }, admin);
      expect(done).toMatchObject({ created: 6, failed: 0 });

      const back = await exportedByCode('csv');
      expect([...back.keys()].sort()).toEqual([...EXPECTED.keys()].sort());
      for (const [code, cells] of EXPECTED) expect(back.get(code), code).toEqual(cells);

      // The same file again, as an update, finds nothing to change.
      const again = await importProducts(fixture(name), { dryRun: true, mode: 'upsert' }, admin);
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 6, failed: 0 });
    });
  }

  it('ignores the stock columns an old sheet carries, tells the person which, and imports the rest', async () => {
    await freshCatalogue();
    const file = fixture('products-export-1.2.5-with-stock.csv');

    const preview = await importProducts(file, { dryRun: true, mode: 'create' }, admin);
    expect(preview.ignoredColumns).toEqual(['Stock', 'On hand', 'Reserved', 'Free to sell']);
    expect(preview).toMatchObject({ created: 6, failed: 0 });
    expect(preview.issues).toEqual([]);

    const done = await importProducts(file, { dryRun: false, mode: 'create' }, admin);
    expect(done).toMatchObject({ created: 6, failed: 0, ignoredColumns: ['Stock', 'On hand', 'Reserved', 'Free to sell'] });
    const { items } = await catalog.listProducts({ limit: 100 }, admin);
    expect(items).toHaveLength(6);
  });

  it('writes a 1.4 export that declares its format, and reads it back unchanged', async () => {
    await freshCatalogue();
    await importProducts(fixture('products-export-1.2.5.csv'), { dryRun: false, mode: 'create' }, admin);

    const xlsx = await exportProducts('xlsx', admin);
    expect(productFormatOf(await readSheetSubject(xlsx.bytes))).toBe(PRODUCT_FORMAT_VERSION);
    const template = await productImportTemplate('xlsx', admin);
    expect(productFormatOf(await readSheetSubject(template.bytes))).toBe(PRODUCT_FORMAT_VERSION);
    // A CSV has nowhere to put a marker and carries none, so it stays a 1.2.5 file to the letter.
    const csv = await exportProducts('csv', admin);
    expect(await readSheetSubject(csv.bytes)).toBeNull();
    expect((await readSheetRows(csv.bytes))[0]).toEqual(HEADERS_1_2_5);

    for (const file of [
      { buffer: xlsx.bytes, fileName: xlsx.fileName },
      { buffer: csv.bytes, fileName: csv.fileName },
    ]) {
      const result = await importProducts(file, { dryRun: true, mode: 'upsert' }, admin);
      expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 6, failed: 0, ignoredColumns: [] });
      expect(result.formatVersion).toBe(file.fileName.endsWith('.xlsx') ? PRODUCT_FORMAT_VERSION : null);
    }

    expect(await exportedByCode('xlsx')).toEqual(EXPECTED);
  });

  it('imports a 1.4 export with the optional columns left off', async () => {
    await freshCatalogue();
    // Only what a 1.2.5 reader required: Main product, Sub product, Code.
    const trimmed = {
      buffer: Buffer.from(
        ['Main product,Sub product,Code', 'One Piece Toilet,"102 (9"")",OPT-0001', 'Wash Basin,WB-18X12,WB-0001'].join(
          '\r\n',
        ) + '\r\n',
        'utf8',
      ),
      fileName: 'minimal.csv',
    };
    const result = await importProducts(trimmed, { dryRun: false, mode: 'create' }, admin);
    expect(result).toMatchObject({ created: 2, failed: 0 });
    expect(result.ignoredColumns).toEqual([]);
  });
});
