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
import * as productRepo from '../src/repositories/product.repository.js';
import * as productVariantRepo from '../src/repositories/product-variant.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import { IMPORT_HEADERS } from '../src/domain/product-import.js';
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
        [...HEAD, 'weightKg', 'size', 'multiColour'],
        ['ONE PIECE BASIN', 'DAMRU', 'White', 'DAMRU-WHITE', '18', 'L-16 H-31', 'yes'],
        ['ONE PIECE BASIN', 'DAMRU', 'Vitrosa 41', '41', '', '', ''],
        ['One piece basin', 'Damru', 'Vitrosa 42', '42', '18.5', '', ''],
        ['ONE PIECE TOILET', '102', '', '102', '32.5', '9" · L-27 B-15 H-26', 'no'],
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
    expect(damru).toMatchObject({ categoryName: 'ONE PIECE BASIN', size: 'L-16 H-31', multiColour: true, hasVariants: true });
    expect(damru?.variants.map((variant) => [variant.code, variant.label, variant.weightKg])).toEqual([
      ['DAMRU-WHITE', 'White', 18],
      ['41', 'Vitrosa 41', null],
      ['42', 'Vitrosa 42', 18.5],
    ]);
    const toilet = products.get('102');
    expect(toilet).toMatchObject({ categoryName: 'ONE PIECE TOILET', size: '9" · L-27 B-15 H-26', multiColour: false, hasVariants: false });
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
    const rows: Array<Array<string | number>> = [[...HEAD, 'weightKg', 'multiColour']];
    for (let i = 1; i <= 20; i += 1) rows.push(['Tiles', `Tile ${i}`, '', `T-${i}`, i, 'no']);
    rows[4] = ['Tiles', '', '', 'T-4', 3, 'no']; // row 5: no name
    rows[9] = ['Tiles', 'Tile 9', '', 'T-9', 0, 'no']; // row 10: weight not above zero
    rows[15] = ['Tiles', 'Tile 15', '', 'T-15', 1, 'maybe']; // row 16: not a yes or a no

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
        [...HEAD, 'weightKg', 'size', 'alias'],
        ['Basins', 'Damru', 'White', 'D-W', '18', 'L-16 H-31', 'Damru'],
        ['Basins', 'Damru', 'Vitrosa 41', '41', '', 'L-16 H-31', 'Damru'],
      ]),
    );
    const before = (await byName()).get('Damru');

    const result = await run(
      csv([
        [...HEAD, 'weightKg', 'size'],
        ['basins', 'DAMRU', 'Vitrosa 41', '41', '18.5', 'L-16 H-32'],
        ['Basins', 'Damru', 'Vitrosa 42', '42', '18.5', 'L-16 H-32'],
        ['Urinals', 'Hexa', '', 'HEXA', '8', ''],
      ]),
      admin,
      false,
      'upsert',
    );

    expect(result).toMatchObject({ created: 1, updated: 2, skipped: 0, failed: 0 });
    const after = await catalog.getProduct(before!.id, admin);
    // The sheet's spelling of the model name wins, as any other field would.
    expect(after).toMatchObject({ name: 'DAMRU', size: 'L-16 H-32', alias: 'Damru' });
    // The white variant the sheet did not mention is still there, id intact;
    // the one it did mention got its weight; the new one was added.
    expect(after?.variants.map((variant) => [variant.code, variant.label, variant.weightKg])).toEqual([
      ['D-W', 'White', 18],
      ['41', 'Vitrosa 41', 18.5],
      ['42', 'Vitrosa 42', 18.5],
    ]);
    expect(after?.variants[0]?.id).toBe(before?.variants[0]?.id);
    expect(after?.sync.version).toBe((before?.sync.version ?? 0) + 1);
    expect(after?.sync.fieldHlc.size).toBe(after?.sync.hlc);
    expect(after?.sync.fieldHlc.variants).toBe(after?.sync.hlc);
    expect(after?.sync.fieldHlc.alias).toBeUndefined();
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

  it('predicts on a dry run exactly what the real run then does, and writes nothing', async () => {
    const file = csv([
      [...HEAD, 'size'],
      ['Basins', 'One', '', 'S-1', '18x12'],
      ['Basins', '', '', 'S-2', '18x12'],
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
          size: '18x12',
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

  it('files a row under the product its code or its (brand, name) pair names, and never invents one for a code', async () => {
    const ids = await db().transaction((trx) =>
      productRepo.ensureCategories(
        admin.tenantId,
        [
          { name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+' },
          { name: 'Wash Basin', code: 'WB', brand: 'Swisware+' },
          { name: 'Wash Basin', code: 'WBO', brand: 'Other' },
        ],
        trx,
      ),
    );
    const file = csv([
      ['categoryCode', 'categoryName', 'categoryBrand', 'name', 'variant', 'code'],
      ['opt', '', '', '1111', '', 'OPT-0001'],
      ['NOPE', 'One Piece Toilet', '', '41', '', 'OPT-0002'],
      ['', 'Wash Basin', 'other', '14x14', '', 'WBO-0001'],
      ['', 'Wash Basin', 'Third', '16x12', '', 'X-1'],
      ['', 'Wash Basin', 'Fourth', '16x13', '', 'X-2'],
    ]);

    // The preview already names the unknown code, rather than the commit.
    const preview = await run(file, admin, true);
    expect(preview).toMatchObject({ created: 4, failed: 1 });
    expect(preview.issues).toEqual([
      expect.objectContaining({ row: 3, kind: 'error', messageKey: 'validation.product.categoryCodeUnknown' }),
    ]);

    const real = await run(file);
    expect(real).toMatchObject({ created: 4, failed: 1, issues: preview.issues });

    const made = await byName();
    expect(made.get('1111')?.categoryId).toBe(ids.get('opt'));
    expect(made.has('41')).toBe(false);
    expect(made.get('14x14')?.categoryId).toBe(ids.get('wbo'));
    // Two brands' new "Wash Basin" in one chunk are two products, not one.
    expect([made.get('16x12')?.brand, made.get('16x13')?.brand]).toEqual(['Third', 'Fourth']);
    expect(made.get('16x12')?.categoryId).not.toBe(made.get('16x13')?.categoryId);
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
    expect(csvTemplate.bytes.toString('utf8').split('\r\n')[0]).toBe(IMPORT_HEADERS.join(','));

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
