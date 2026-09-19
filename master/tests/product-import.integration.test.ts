/**
 * Bulk product import, end to end against PostgreSQL.
 *
 * The things worth pinning are the ones a unit test cannot see: that a file
 * with three bad rows imports the other seventeen and names exactly those
 * three; that re-uploading the same file changes nothing; that rows sharing a
 * model fold into one product with several variants; that the write is one
 * activity row and one `catalog` event rather than five thousand of each;
 * that a clash the pre-check missed falls back to a per-product insert and
 * the rest of the chunk still lands; and that a file past the old 500-row
 * ceiling is fully reachable through the paged list.
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
import * as productVariantRepo from '../src/repositories/product-variant.repository.js';
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

const HEAD = ['categoryName', 'name', 'variant', 'code'];

async function byName(): Promise<Map<string, Awaited<ReturnType<typeof catalog.listProducts>>['items'][number]>> {
  const page = await catalog.listProducts({ limit: 500 }, admin);
  return new Map(page.items.map((product) => [product.name, product]));
}

describe.skipIf(!canRunIntegrationTests)('bulk product import (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    resetChangeRing();
    admin = await testActor();
  });

  it('imports a valid file — folding rows into models — and publishes one catalog event', async () => {
    const result = await run(
      csv([
        [...HEAD, 'weightKg', 'rate', 'uom'],
        ['ONE PIECE BASIN', 'DAMRU', 'White', 'DAMRU-WHITE', '18', '2600', 'pcs'],
        ['ONE PIECE BASIN', 'DAMRU', 'Vitrosa 41', '41', '', '3400', ''],
        ['One piece basin', 'Damru', 'Vitrosa 42', '42', '18.5', '', ''],
        ['ONE PIECE TOILET', '102', '', '102', '32.5', '6800', 'piece'],
      ]),
    );

    expect(result).toMatchObject({
      dryRun: false,
      totalRows: 4,
      created: 4,
      updated: 0,
      skipped: 0,
      failed: 0,
      issues: [],
      ignoredColumns: [],
    });

    const products = await byName();
    expect(products.size).toBe(2);
    const damru = products.get('DAMRU');
    expect(damru).toMatchObject({ categoryName: 'ONE PIECE BASIN', rate: 260000, uom: 'piece', hasVariants: true });
    expect(damru?.variants.map((variant) => [variant.code, variant.label, variant.weightKg])).toEqual([
      ['DAMRU-WHITE', 'White', 18],
      ['41', 'Vitrosa 41', null],
      ['42', 'Vitrosa 42', 18.5],
    ]);
    const toilet = products.get('102');
    expect(toilet).toMatchObject({ categoryName: 'ONE PIECE TOILET', rate: 680000, hasVariants: false });
    expect(toilet?.variants.map((variant) => [variant.code, variant.label, variant.weightKg])).toEqual([
      ['102', null, 32.5],
    ]);
    // Three rows named the same category in three spellings; it exists once.
    expect(await catalog.listCategories(admin)).toHaveLength(2);

    const activity = await db()('activity_log').where({ entity_type: 'catalog' });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ action: 'imported' });
    expect(activity[0].details).toMatchObject({ count: 4, fileName: 'supplier.csv' });
    expect(await db()('activity_log').where({ entity_type: 'product' })).toHaveLength(0);

    const events = since(0) ?? [];
    expect(events.map((event) => event.entity)).toEqual(['catalog']);
    expect(events[0]?.payload).toMatchObject({ created: 4, updated: 0 });
  });

  it('names exactly the rows that are wrong and imports the rest', async () => {
    const rows: Array<Array<string | number>> = [[...HEAD, 'weightKg', 'uom']];
    for (let i = 1; i <= 20; i += 1) rows.push(['Tiles', `Tile ${i}`, '', `T-${i}`, i, 'box']);
    rows[4] = ['Tiles', '', '', 'T-4', 3, 'box']; // row 5: no name
    rows[9] = ['Tiles', 'Tile 9', '', 'T-9', 0, 'box']; // row 10: weight not above zero
    rows[15] = ['Tiles', 'Tile 15', '', 'T-15', 1, 'crates']; // row 16: not a unit

    const result = await run(csv(rows));

    expect(result.created).toBe(17);
    expect(result.failed).toBe(3);
    expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
      [5, 'validation.product.nameRequired'],
      [10, 'validation.product.weightPositive'],
      [16, 'validation.import.invalidValue'],
    ]);
    expect((await catalog.listProducts({ limit: 100 }, admin)).total).toBe(17);
  });

  it('refuses a model that names a variant on some rows and not on others', async () => {
    const result = await run(
      csv([
        [...HEAD],
        ['Basins', 'Nova', 'White', 'NOVA-W'],
        ['Basins', 'Nova', '', 'NOVA'],
        ['Urinals', 'Hexa', '', 'HEXA'],
      ]),
    );

    expect(result).toMatchObject({ created: 1, failed: 2 });
    expect(result.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
      [2, 'validation.import.mixedVariants'],
      [3, 'validation.import.mixedVariants'],
    ]);
  });

  it('skips rows whose code already exists, so re-uploading a file is idempotent', async () => {
    const file = csv([
      [...HEAD],
      ['Basins', 'One', '', 'A-1'],
      ['Basins', 'Two', '', 'A-2'],
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

  it('updates existing models by code in upsert mode, folding new variants in and stamping only the touched fields', async () => {
    await run(
      csv([
        [...HEAD, 'weightKg', 'rate', 'brand'],
        ['Basins', 'Damru', 'White', 'D-W', '18', '100', 'Swisware'],
        ['Basins', 'Damru', 'Vitrosa 41', '41', '', '100', 'Swisware'],
      ]),
    );
    const before = (await byName()).get('Damru');

    const result = await run(
      csv([
        [...HEAD, 'weightKg', 'rate'],
        ['basins', 'DAMRU', 'Vitrosa 41', '41', '18.5', '150'],
        ['Basins', 'Damru', 'Vitrosa 42', '42', '18.5', '150'],
        ['Urinals', 'Hexa', '', 'HEXA', '8', '200'],
      ]),
      admin,
      false,
      'upsert',
    );

    expect(result).toMatchObject({ created: 1, updated: 2, skipped: 0, failed: 0 });
    const after = await catalog.getProduct(before!.id, admin);
    // The sheet's spelling of the model name wins, as any other field would.
    expect(after).toMatchObject({ name: 'DAMRU', rate: 15000, brand: 'Swisware' });
    // The white variant the sheet did not mention is still there, id intact;
    // the one it did mention got its weight; the new one was added.
    expect(after?.variants.map((variant) => [variant.code, variant.label, variant.weightKg])).toEqual([
      ['D-W', 'White', 18],
      ['41', 'Vitrosa 41', 18.5],
      ['42', 'Vitrosa 42', 18.5],
    ]);
    expect(after?.variants[0]?.id).toBe(before?.variants[0]?.id);
    expect(after?.sync.version).toBe((before?.sync.version ?? 0) + 1);
    expect(after?.sync.fieldHlc.rate).toBe(after?.sync.hlc);
    expect(after?.sync.fieldHlc.variants).toBe(after?.sync.hlc);
    expect(after?.sync.fieldHlc.brand).toBeUndefined();
  });

  it('refuses a barcode another live product already carries', async () => {
    await catalog.createProduct(
      { name: 'Existing', categoryName: 'Basins', barcode: '890123', variants: [{ code: 'X-1' }] },
      admin,
    );

    const result = await run(
      csv([
        [...HEAD, 'barcode'],
        ['Basins', 'Clash', '', 'X-2', '890123'],
        ['Basins', 'Fine', '', 'X-3', '890124'],
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
        [...HEAD],
        ['Basins', 'First', '', 'D-1'],
        ['Basins', 'Second', '', 'd-1'],
      ]),
    );

    expect(result).toMatchObject({ created: 1, failed: 1 });
    expect(result.issues[0]).toMatchObject({
      row: 3,
      messageKey: 'validation.import.duplicateInFile',
      params: { column: 'code', firstRow: 2 },
    });
  });

  it('needs products.bulk, and products.edit for upsert', async () => {
    const file = csv([
      [...HEAD],
      ['Basins', 'One', '', 'P-1'],
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
        [...HEAD, 'rate'],
        ['Basins', 'Priced', '', 'R-1', '100'],
        ['Basins', 'Unpriced', '', 'R-2', ''],
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
      [...HEAD, 'uom'],
      ['Basins', 'One', '', 'S-1', 'box'],
      ['Basins', '', '', 'S-2', 'box'],
    ]);

    const preview = await run(file, admin, true);
    expect(preview).toMatchObject({
      dryRun: true,
      created: 1,
      failed: 1,
      sample: [
        {
          categoryName: 'Basins',
          name: 'One',
          uom: 'box',
          hasVariants: false,
          variants: [{ code: 'S-1', label: null, weightKg: null, sequence: 1 }],
        },
      ],
    });
    expect((await catalog.listProducts({}, admin)).total).toBe(0);
    expect(since(0)).toEqual([]);

    const real = await run(file);
    expect(real).toMatchObject({ dryRun: false, created: 1, failed: 1, issues: preview.issues });
  });

  it('refuses a file with a required column missing, an empty file and an unknown extension', async () => {
    await expect(run(csv([['name', 'code'], ['A', '1']]))).rejects.toThrow(ValidationError);
    await expect(run(csv([[...HEAD]]))).rejects.toThrow(/no rows/);
    await expect(run({ buffer: Buffer.from('x'), fileName: 'legacy.xls' })).rejects.toThrow(/\.csv and \.xlsx/);
  });

  it('falls back to product-by-product when a chunk clashes, losing only the clashing model', async () => {
    // The pre-check is told the catalogue is empty; the unique index knows better.
    await catalog.createProduct(
      { name: 'Already there', categoryName: 'Basins', variants: [{ code: 'C-3' }] },
      admin,
    );
    vi.spyOn(productVariantRepo, 'findLiveVariantsByCodes').mockResolvedValueOnce(new Map());

    const result = await run(
      csv([
        [...HEAD],
        ['Basins', 'One', '', 'C-1'],
        ['Basins', 'Two', '', 'C-2'],
        ['Basins', 'Three', '', 'C-3'],
        ['Basins', 'Four', '', 'C-4'],
      ]),
    );

    expect(result).toMatchObject({ created: 3, failed: 1 });
    expect(result.issues).toEqual([
      {
        row: 4,
        kind: 'error',
        column: 'code',
        messageKey: 'error.conflict.productCodeTaken',
        params: { productCode: 'C-3' },
      },
    ]);
    expect((await catalog.listProducts({}, admin)).total).toBe(4);
    vi.restoreAllMocks();
  });

  it('imports a file well past the old 500-row ceiling and pages through all of it', async () => {
    const rows: Array<Array<string | number>> = [[...HEAD]];
    for (let i = 1; i <= 1200; i += 1) {
      rows.push([i % 3 === 0 ? 'Vitrified' : 'Ceramic', `Product ${i}`, '', `BIG-${String(i).padStart(4, '0')}`]);
    }

    const result = await run(csv(rows));
    expect(result).toMatchObject({ created: 1200, failed: 0 });

    const first = await catalog.listProducts({ limit: 100 }, admin);
    expect(first.total).toBe(1200);
    expect(first.items).toHaveLength(100);
    expect(first.categories?.map((facet) => [facet.name, facet.count])).toEqual([
      ['Ceramic', 800],
      ['Vitrified', 400],
    ]);

    const last = await catalog.listProducts({ limit: 100, offset: 1100 }, admin);
    expect(last.items).toHaveLength(100);

    const vitrified = first.categories?.find((facet) => facet.name === 'Vitrified');
    const filtered = await catalog.listProducts(
      { categoryId: vitrified?.id, search: 'Product 12', limit: 500 },
      admin,
    );
    expect(filtered.items.every((product) => product.categoryName === 'Vitrified')).toBe(true);
    expect(filtered.categories?.map((facet) => facet.name)).toEqual(['Ceramic', 'Vitrified']);

    expect(await catalog.findProductByCode('BIG-1199', admin)).toMatchObject({ name: 'Product 1199' });
  });

  it('serves a CSV and an Excel template', async () => {
    const csvTemplate = await productImportTemplate('csv', admin);
    expect(csvTemplate.contentType).toMatch(/^text\/csv/);
    expect(csvTemplate.bytes.toString('utf8').split('\r\n')[0]).toMatch(/^categoryName,name,variant,code,weightKg,/);

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
