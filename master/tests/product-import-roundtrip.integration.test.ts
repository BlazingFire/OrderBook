/**
 * The catalogue export and import as one loop, against PostgreSQL and the real
 * SWISWARE catalogue (41 products, 549 sub products): what the export writes
 * must be exactly what the import reads, so an export uploaded back unedited
 * changes nothing — on both formats, in both modes, and fast.
 */

import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_PRODUCT_IMPORT_ROWS } from '@orderbook/shared';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { IMPORT_HEADERS } from '../src/domain/product-import.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as catalog from '../src/services/catalog.service.js';
import { seedCatalogue } from '../src/services/catalogue-seed.service.js';
import { exportProducts, importProducts } from '../src/services/product-import.service.js';

let admin: ActorContext;
const SUB_PRODUCTS = 549;

const run = (
  file: { buffer: Buffer; fileName: string },
  mode: 'create' | 'upsert',
  dryRun: boolean,
) => importProducts(file, { dryRun, mode }, admin);

const csv = (lines: string[]) => ({ buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'), fileName: 'f.csv' });

describe.skipIf(!canRunIntegrationTests)('catalogue export -> import round trip (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    await resetData();
    admin = await testActor();
    await seedCatalogue({ actor: admin });
  }, 120_000);
  afterAll(teardownDatabase);

  it('writes the template header, in the template order, in both formats', async () => {
    const asCsv = await exportProducts('csv', admin);
    expect(asCsv.contentType).toMatch(/^text\/csv/);
    expect(asCsv.fileName).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
    const csvRows = await readSheetRows(asCsv.bytes);
    expect(csvRows[0]).toEqual([...IMPORT_HEADERS]);
    expect(csvRows).toHaveLength(SUB_PRODUCTS + 1);

    const asXlsx = await exportProducts('xlsx', admin);
    expect(asXlsx.fileName).toMatch(/^products-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const xlsxRows = await readSheetRows(asXlsx.bytes);
    expect(xlsxRows[0]).toEqual([...IMPORT_HEADERS]);
    // Same cells in either format.
    expect(xlsxRows.map((row) => row.slice(0, IMPORT_HEADERS.length))).toEqual(
      csvRows.map((row) => Array.from({ length: IMPORT_HEADERS.length }, (_, at) => row[at] ?? '')),
    );
  });

  it.each(['csv', 'xlsx'] as const)(
    'an unedited %s export re-imports with nothing to create, update or fix — in about a second',
    async (format) => {
      const file = await exportProducts(format, admin);
      const upload = { buffer: file.bytes, fileName: file.fileName };

      const started = Date.now();
      const upsert = await run(upload, 'upsert', true);
      const elapsed = Date.now() - started;

      expect(upsert).toMatchObject({
        dryRun: true,
        totalRows: SUB_PRODUCTS,
        created: 0,
        updated: 0,
        unchanged: SUB_PRODUCTS,
        skipped: 0,
        failed: 0,
        issues: [],
        ignoredColumns: [],
      });
      expect(elapsed).toBeLessThan(3000);

      const create = await run(upload, 'create', true);
      expect(create).toMatchObject({ created: 0, updated: 0, failed: 0, skipped: SUB_PRODUCTS });
      expect(create.issues.every((issue) => issue.messageKey === 'import.skip.codeExists')).toBe(true);
    },
    30_000,
  );

  it('a real upsert of an unedited export writes nothing: no new row, no activity entry', async () => {
    const before = await db()('activity_log').where({ entity_type: 'catalog' }).count('* as n').first<{ n: string }>();
    const file = await exportProducts('csv', admin);
    const result = await run({ buffer: file.bytes, fileName: file.fileName }, 'upsert', false);
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: SUB_PRODUCTS, failed: 0 });
    const after = await db()('activity_log').where({ entity_type: 'catalog' }).count('* as n').first<{ n: string }>();
    expect(after?.n).toBe(before?.n);
  });

  it('applies exactly the cells that were edited, then reads as unchanged again', async () => {
    const exported = await exportProducts('csv', admin);
    const rows = await readSheetRows(exported.bytes);
    const at = (header: string): number => IMPORT_HEADERS.indexOf(header);

    const first = rows[1] as string[];
    const second = rows[2] as string[];
    first[at('Weight (kg)')] = '12.75';
    second[at('Size')] = '99x99';
    const edited = csv(rows.map((row) => row.map((cell) => (/[",]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')));

    const preview = await run(edited, 'upsert', true);
    expect(preview).toMatchObject({ updated: 2, failed: 0, unchanged: SUB_PRODUCTS - 2 });

    const real = await run(edited, 'upsert', false);
    expect(real).toMatchObject({ updated: 2, failed: 0 });
    const product = await catalog.findProductByCode(first[at('Code')] as string, admin);
    expect(product?.variants.find((variant) => variant.code === first[at('Code')])?.weightKg).toBe(12.75);
    expect((await catalog.findProductByCode(second[at('Code')] as string, admin))?.size).toBe('99x99');

    expect(await run(edited, 'upsert', true)).toMatchObject({ updated: 0, unchanged: SUB_PRODUCTS });
  });

  it('exports and reports soft-deleted and deactivated rows the way a person sees the catalogue', async () => {
    const page = await catalog.listProducts({ limit: 1 }, admin);
    const gone = page.items[0];
    expect(gone).toBeDefined();
    const code = gone?.variants[0]?.code as string;

    // A deactivated variant (history still quotes it) is not part of the export.
    await db()('product_variants').where({ id: gone?.variants[0]?.id }).update({ is_active: false });
    const rows = await readSheetRows((await exportProducts('csv', admin)).bytes);
    expect(rows.some((row) => row[IMPORT_HEADERS.indexOf('Code')] === code)).toBe(false);
    await db()('product_variants').where({ id: gone?.variants[0]?.id }).update({ is_active: true });

    // A binned product is not exported either, and its code is free to import again.
    await catalog.deleteProduct(gone?.id as string, admin);
    const after = await readSheetRows((await exportProducts('csv', admin)).bytes);
    expect(after).toHaveLength(SUB_PRODUCTS);
    const revived = await run(
      csv([IMPORT_HEADERS.join(','), `,,${gone?.categoryName},Revived,,dedicated,,${code},,`]),
      'create',
      true,
    );
    expect(revived).toMatchObject({ created: 1, failed: 0, skipped: 0 });
  });

  it('exports the main-product level and refuses a caller who cannot even view products', async () => {
    const main = await exportProducts('csv', admin, 'main');
    expect(main.fileName).toMatch(/^main-products-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = await readSheetRows(main.bytes);
    expect(rows[0]).toEqual(['Brand', 'Main product code', 'Main product', 'Sub products']);
    expect(rows).toHaveLength(42);

    await expect(exportProducts('csv', await actorWith([]))).rejects.toThrow(ForbiddenError);
    // Seeing the catalogue is enough to export it; only importing needs products.bulk.
    await expect(exportProducts('csv', await actorWith(['products.view']))).resolves.toBeDefined();
    await expect(
      importProducts(csv([IMPORT_HEADERS.join(',')]), { dryRun: true, mode: 'create' }, await actorWith(['products.view'])),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      importProducts(
        csv([IMPORT_HEADERS.join(',')]),
        { dryRun: true, mode: 'upsert' },
        await actorWith(['products.view', 'products.bulk', 'products.create']),
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe.skipIf(!canRunIntegrationTests)('import error reporting and Excel input (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    await resetData();
    admin = await testActor();
    await seedCatalogue({ actor: admin });
  }, 120_000);
  afterAll(teardownDatabase);

  const HEAD = IMPORT_HEADERS.join(',');
  // Brand, Main product code, Main product, Sub product, Size, Colour rule, Colour, Code, Weight, Alias

  it('numbers every problem by its spreadsheet row, blank lines included, and imports nothing from a bad row', async () => {
    const result = await run(
      csv([
        HEAD,
        'Swisware+,,ONE PIECE TOILET,NEW A,,dedicated,,ZZ-1,10,', // row 2: fine
        '', // row 3: blank
        'Swisware+,,ONE PIECE TOILET,NEW B,,fixed,,ZZ-2,10,', // row 4: fixed needs a colour
        'Nobrand Co,,ONE PIECE TOILET,NEW C,,dedicated,,ZZ-3,10,', // row 5: a new brand — created and listed
        ',,ONE PIECE TOILET,NEW D,,dedicated,,zz-1,10,', // row 6: repeats row 2's code
        ',,ONE PIECE TOILET,NEW E,,dedicated,,ZZ-5,heavy,', // row 7: weight not a number
        ',,Not A Product,NEW F,,dedicated,,ZZ-6,1,', // row 8: a new main product — created (the company switch is on by default)
        'swisware+,,one piece toilet,new g,,dedicated,,ZZ-7,2,', // row 9: fine, matched case-blind
      ]),
      'create',
      false,
    );

    expect(result).toMatchObject({ totalRows: 7, created: 4, failed: 3, skipped: 0 });
    const byRow = new Map(result.issues.map((issue) => [issue.row, issue]));
    expect([...byRow.keys()].sort()).toEqual([4, 6, 7]);
    expect(byRow.get(4)?.messageKey).toBe('validation.import.fixedNeedsColour');
    expect(byRow.get(6)).toMatchObject({ messageKey: 'validation.import.duplicateInFile', params: { firstRow: 2 } });
    expect(byRow.get(7)?.messageKey).toBe('validation.import.notANumber');

    for (const code of ['ZZ-1', 'ZZ-3', 'ZZ-6', 'ZZ-7']) expect(await catalog.findProductByCode(code, admin)).not.toBeNull();
    for (const code of ['ZZ-2', 'ZZ-5']) {
      expect(await catalog.findProductByCode(code, admin)).toBeNull();
    }
    // The new brand joined the Brands list, once, as typed; "swisware+" was matched to the listed one.
    const brands = await db()('option_lists').where({ list_key: 'product.brand' }).pluck<string[]>('value');
    expect(brands.filter((brand) => brand.toLowerCase() === 'swisware+')).toHaveLength(1);
    expect(brands).toContain('Nobrand Co');
    // Matched case-blind: no second Swisware+ "ONE PIECE TOILET" was minted
    // (Nobrand Co's is a different product — the (brand, name) pair is the key).
    const categories = await catalog.listCategories(admin);
    const toilets = categories.filter((category) => category.name.toLowerCase() === 'one piece toilet');
    expect(toilets.map((category) => category.brand).sort()).toEqual(['Nobrand Co', 'Swisware+']);
  });

  it('reads an Excel sheet whose code cells are numbers and whose size is text', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.addRow([...IMPORT_HEADERS]);
    sheet.addRow(['Swisware+', '', 'ONE PIECE TOILET', 'XL ONE', '18x12', 'dedicated', '', 8812, 14.5, '']);
    sheet.addRow(['Swisware+', '', 'ONE PIECE TOILET', 'XL TWO', '', 'dedicated', '', '0099', '', '']);
    const buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await run({ buffer, fileName: 'sheet.xlsx' }, 'create', false);
    expect(result).toMatchObject({ created: 2, failed: 0 });
    const one = await catalog.findProductByCode('8812', admin);
    expect(one).toMatchObject({ name: 'XL ONE', size: '18x12' });
    expect(one?.variants[0]?.weightKg).toBe(14.5);
    expect((await catalog.findProductByCode('0099', admin))?.name).toBe('XL TWO');
  });

  it('reads a semicolon-separated, decimal-comma, Windows-1252 file from a European-locale Excel', async () => {
    const text = [
      'Brand;Main product code;Main product;Sub product;Size;Colour rule;Colour;Code;Weight (kg);Alias',
      'Swisware+;;ONE PIECE TOILET;CAFÉ ONE;;dedicated;;SC-1;12,5;',
    ].join('\r\n');
    const result = await run({ buffer: Buffer.from(text, 'latin1'), fileName: 'eu.csv' }, 'create', false);
    expect(result).toMatchObject({ created: 1, failed: 0 });
    const product = await catalog.findProductByCode('SC-1', admin);
    expect(product?.name).toBe('CAFÉ ONE');
    expect(product?.variants[0]?.weightKg).toBe(12.5);
  });

  it('refuses a file past the row ceiling before reading any row, and an empty one by name', async () => {
    const lines = [HEAD];
    for (let i = 0; i <= MAX_PRODUCT_IMPORT_ROWS; i += 1) lines.push(`,,X,Y,,,,C-${i},,`);
    await expect(run(csv(lines), 'create', true)).rejects.toMatchObject({
      messageKey: 'validation.import.tooManyRows',
      params: { max: MAX_PRODUCT_IMPORT_ROWS },
    });
    await expect(run(csv([HEAD]), 'create', true)).rejects.toThrow(ValidationError);
  });

  it('a 5,000-row file is read, matched and previewed without a query per row', async () => {
    const lines = [HEAD];
    for (let i = 1; i <= 5000; i += 1) {
      lines.push(`Swisware+,,ONE PIECE TOILET,BULK ${i},,dedicated,,BK-${i},1.5,`);
    }
    const started = Date.now();
    const result = await run(csv(lines), 'create', true);
    expect(result).toMatchObject({ created: 5000, failed: 0 });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);
});
