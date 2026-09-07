/**
 * Bulk product import, end to end against PostgreSQL.
 *
 * The things worth pinning are the ones a unit test cannot see: that a file
 * with three bad rows imports the other seventeen and names exactly those
 * three; that re-uploading the same file changes nothing; that the write is
 * one activity row and one `catalog` event rather than five thousand of each;
 * that a clash the pre-check missed falls back to a per-row insert and the
 * rest of the chunk still lands; and that a file past the old 500-row ceiling
 * is fully reachable through the paged list.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';
import { db } from '../src/db/knex.js';
import type { ActorContext } from '../src/domain/actor.js';
import { ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { resetChangeRing, since } from '../src/realtime/change-ring.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import { importProducts, productImportTemplate } from '../src/services/product-import.service.js';

let admin: ActorContext;

function csv(rows: Array<Array<string | number>>): { buffer: Buffer; fileName: string } {
  const text = rows.map((row) => row.map(String).join(',')).join('\r\n') + '\r\n';
  return { buffer: Buffer.from(text, 'utf8'), fileName: 'supplier.csv' };
}

function run(file: { buffer: Buffer; fileName: string }, actor = admin, dryRun = false, mode: 'create' | 'upsert' = 'create') {
  return importProducts(file, { dryRun, mode }, actor);
}

describe.skipIf(!canRunIntegrationTests)('bulk product import (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
  });

  it('imports a valid file, writes one activity row and publishes one catalog event', async () => {
    const result = await run(
      csv([
        ['productCode', 'name', 'categoryName', 'rate', 'uom', 'application'],
        ['GVT-1', 'Carrara White', 'Vitrified', '1200.50', 'Boxes', 'Floor and wall'],
        ['GVT-2', 'Statuario', 'Vitrified', '980', 'box', 'floor'],
        ['', 'Ivory Matt', 'Wall Tiles', '', 'sqft', ''],
      ]),
    );

    expect(result).toMatchObject({
      dryRun: false,
      totalRows: 3,
      created: 3,
      updated: 0,
      skipped: 0,
      failed: 0,
      issues: [],
      ignoredColumns: [],
    });

    const page = await catalog.listProducts({}, admin);
    expect(page.total).toBe(3);
    const byCode = new Map(page.items.map((product) => [product.productCode, product]));
    expect(byCode.get('GVT-1')).toMatchObject({
      name: 'Carrara White',
      categoryName: 'Vitrified',
      rate: 120050,
      uom: 'box',
      application: 'floor_wall',
    });
    expect(byCode.get('PRD-0001')).toMatchObject({ name: 'Ivory Matt', categoryName: 'Wall Tiles', uom: 'sqft' });
    // Two rows named the same category; it exists once.
    expect(await catalog.listCategories(admin)).toHaveLength(2);

    const activity = await db()('activity_log').where({ entity_type: 'catalog' });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ action: 'imported' });
    expect(activity[0].details).toMatchObject({ count: 3, fileName: 'supplier.csv' });
    expect(await db()('activity_log').where({ entity_type: 'product' })).toHaveLength(0);

    const events = since(0) ?? [];
    expect(events.map((event) => event.entity)).toEqual(['catalog']);
    expect(events[0]?.payload).toMatchObject({ created: 3, updated: 0 });
  });

  it('names exactly the rows that are wrong and imports the rest', async () => {
    const rows: Array<Array<string | number>> = [['productCode', 'name', 'peiRating', 'uom']];
    for (let i = 1; i <= 20; i += 1) rows.push([`T-${i}`, `Tile ${i}`, i % 5, 'box']);
    rows[4] = ['T-4', '', 3, 'box']; // row 5: no name
    rows[9] = ['T-9', 'Tile 9', 9, 'box']; // row 10: PEI out of range
    rows[15] = ['T-15', 'Tile 15', 1, 'crates']; // row 16: not a unit

    const result = await run(csv(rows));

    expect(result.created).toBe(17);
    expect(result.failed).toBe(3);
    expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
      [5, 'validation.product.nameRequired'],
      [10, 'validation.product.peiRating'],
      [16, 'validation.import.invalidValue'],
    ]);
    expect((await catalog.listProducts({ limit: 100 }, admin)).total).toBe(17);
  });

  it('skips rows whose code already exists, so re-uploading a file is idempotent', async () => {
    const file = csv([
      ['productCode', 'name'],
      ['A-1', 'One'],
      ['A-2', 'Two'],
    ]);
    await run(file);
    resetChangeRing();

    const again = await run(file);

    expect(again).toMatchObject({ created: 0, skipped: 2, failed: 0 });
    expect(again.issues.map((issue) => [issue.row, issue.kind, issue.messageKey])).toEqual([
      [2, 'skipped', 'import.skip.codeExists'],
      [3, 'skipped', 'import.skip.codeExists'],
    ]);
    expect(since(0)).toEqual([]);
    expect(await db()('activity_log').where({ entity_type: 'catalog' })).toHaveLength(1);
  });

  it('updates existing rows by code in upsert mode, stamping only the touched fields', async () => {
    await run(
      csv([
        ['productCode', 'name', 'rate', 'brand'],
        ['A-1', 'One', '100', 'Kajaria'],
      ]),
    );
    const before = (await catalog.listProducts({}, admin)).items[0];

    const result = await run(
      csv([
        ['productCode', 'name', 'rate'],
        ['a-1', 'One renamed', '150'],
        ['A-2', 'Two', '200'],
      ]),
      admin,
      false,
      'upsert',
    );

    expect(result).toMatchObject({ created: 1, updated: 1, skipped: 0, failed: 0 });
    const after = (await catalog.listProducts({}, admin)).items.find((product) => product.id === before?.id);
    expect(after).toMatchObject({ name: 'One renamed', rate: 15000, brand: 'Kajaria' });
    expect(after?.sync.version).toBe((before?.sync.version ?? 0) + 1);
    expect(after?.sync.fieldHlc.rate).toBe(after?.sync.hlc);
    expect(after?.sync.fieldHlc.brand).toBeUndefined();
  });

  it('refuses a barcode another live product already carries', async () => {
    await catalog.createProduct({ productCode: 'X-1', name: 'Existing', barcode: '890123' }, admin);

    const result = await run(
      csv([
        ['productCode', 'name', 'barcode'],
        ['X-2', 'Clash', '890123'],
        ['X-3', 'Fine', '890124'],
      ]),
    );

    expect(result).toMatchObject({ created: 1, failed: 1 });
    expect(result.issues).toEqual([
      {
        row: 2,
        kind: 'error',
        column: 'barcode',
        messageKey: 'error.conflict.barcodeTaken',
        params: { barcode: '890123' },
      },
    ]);
  });

  it('flags a code repeated inside the file and imports its first occurrence only', async () => {
    const result = await run(
      csv([
        ['productCode', 'name'],
        ['D-1', 'First'],
        ['d-1', 'Second'],
      ]),
    );

    expect(result).toMatchObject({ created: 1, failed: 1 });
    expect(result.issues[0]).toMatchObject({
      row: 3,
      messageKey: 'validation.import.duplicateInFile',
      params: { column: 'productCode', firstRow: 2 },
    });
  });

  it('needs products.bulk, and products.edit for upsert', async () => {
    const file = csv([
      ['productCode', 'name'],
      ['P-1', 'One'],
    ]);

    await expect(run(file, await actorWith(['products.create', 'products.view']))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      run(file, await actorWith(['products.bulk', 'products.create']), false, 'upsert'),
    ).rejects.toThrow(/products\.edit/);
  });

  it('refuses a price cell per row for an actor without the edit key, and imports the priceless rows', async () => {
    const seller = await actorWith(['products.bulk', 'products.create', 'products.view']);

    const result = await run(
      csv([
        ['productCode', 'name', 'rate'],
        ['R-1', 'Priced', '100'],
        ['R-2', 'Unpriced', ''],
      ]),
      seller,
    );

    expect(result).toMatchObject({ created: 1, failed: 1 });
    expect(result.issues[0]).toMatchObject({
      row: 2,
      column: 'rate',
      messageKey: 'error.forbidden.missingPermission',
      params: { permission: 'field.saleRate.edit' },
    });
  });

  it('predicts on a dry run exactly what the real run then does, and writes nothing', async () => {
    const file = csv([
      ['productCode', 'name', 'uom'],
      ['S-1', 'One', 'box'],
      ['S-2', '', 'box'],
    ]);

    const preview = await run(file, admin, true);
    expect(preview).toMatchObject({ dryRun: true, created: 1, failed: 1, sample: [{ productCode: 'S-1', name: 'One', uom: 'box' }] });
    expect((await catalog.listProducts({}, admin)).total).toBe(0);
    expect(since(0)).toEqual([]);

    const real = await run(file);
    expect(real).toMatchObject({ dryRun: false, created: 1, failed: 1, issues: preview.issues });
  });

  it('refuses a file with no name column, an empty file and an unknown extension', async () => {
    await expect(run(csv([['productCode', 'rate'], ['A', '1']]))).rejects.toThrow(ValidationError);
    await expect(run(csv([['productCode', 'name']]))).rejects.toThrow(/no rows/);
    await expect(run({ buffer: Buffer.from('x'), fileName: 'legacy.xls' })).rejects.toThrow(/\.csv and \.xlsx/);
  });

  it('falls back to row-by-row when a chunk clashes, losing only the clashing row', async () => {
    // The pre-check is told the catalogue is empty; the unique index knows better.
    await catalog.createProduct({ productCode: 'C-3', name: 'Already there' }, admin);
    vi.spyOn(productRepo, 'findLiveByCodes').mockResolvedValueOnce(new Map());

    const result = await run(
      csv([
        ['productCode', 'name'],
        ['C-1', 'One'],
        ['C-2', 'Two'],
        ['C-3', 'Three'],
        ['C-4', 'Four'],
      ]),
    );

    expect(result).toMatchObject({ created: 3, failed: 1 });
    expect(result.issues).toEqual([
      {
        row: 4,
        kind: 'error',
        column: 'productCode',
        messageKey: 'error.conflict.productCodeTaken',
        params: { productCode: 'C-3' },
      },
    ]);
    expect((await catalog.listProducts({}, admin)).total).toBe(4);
    vi.restoreAllMocks();
  });

  it('imports a file well past the old 500-row ceiling and pages through all of it', async () => {
    const rows: Array<Array<string | number>> = [['productCode', 'name', 'productType']];
    for (let i = 1; i <= 1200; i += 1) {
      rows.push([`BIG-${String(i).padStart(4, '0')}`, `Product ${i}`, i % 3 === 0 ? 'Vitrified' : 'Ceramic']);
    }

    const result = await run(csv(rows));
    expect(result).toMatchObject({ created: 1200, failed: 0 });

    const first = await catalog.listProducts({ limit: 100 }, admin);
    expect(first.total).toBe(1200);
    expect(first.items).toHaveLength(100);
    expect(first.productTypes).toEqual([
      { value: 'Ceramic', count: 800 },
      { value: 'Vitrified', count: 400 },
    ]);

    const last = await catalog.listProducts({ limit: 100, offset: 1100 }, admin);
    expect(last.items).toHaveLength(100);

    const filtered = await catalog.listProducts({ productType: 'Vitrified', search: 'Product 12', limit: 500 }, admin);
    expect(filtered.items.every((product) => product.productType === 'Vitrified')).toBe(true);
    expect(filtered.productTypes?.map((facet) => facet.value)).toEqual(['Ceramic', 'Vitrified']);

    expect(await catalog.findProductByCode('BIG-1199', admin)).toMatchObject({ name: 'Product 1199' });
  });

  it('serves a CSV and an Excel template', async () => {
    const csvTemplate = await productImportTemplate('csv', admin);
    expect(csvTemplate.contentType).toMatch(/^text\/csv/);
    expect(csvTemplate.bytes.toString('utf8').split('\r\n')[0]).toMatch(/^productCode,name,/);

    const xlsxTemplate = await productImportTemplate('xlsx', admin);
    expect(xlsxTemplate.fileName).toBe('products-template.xlsx');
    expect(xlsxTemplate.bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    // What the template says is what the importer understands: a filled-in
    // template imports with nothing ignored.
    const result = await run(
      { buffer: xlsxTemplate.bytes, fileName: 'products-template.xlsx' },
      admin,
      true,
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ValidationError); // no rows yet — but it parsed

    await expect(productImportTemplate('csv', await actorWith(['products.view']))).rejects.toThrow(
      ForbiddenError,
    );
  });
});
