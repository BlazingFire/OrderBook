/**
 * Probe, lens C: the product files earlier released versions wrote, brought
 * into the current Master.
 *
 * - 1.2.4 .. 1.4.6 Products / Office "Export" (CSV, XLSX): the ten template
 *   columns, BOM + CRLF (`master/tests/fixtures/products-export-1.2.5.*` pins
 *   the layout; `git diff 5ed91cc ac573d66 -- master/src/domain/product-import.ts`
 *   is empty, so 1.4.6 wrote the same file). 1.2.4 alone also wrote rows for
 *   variants taken off the form (`git show 8a09f463:master/src/services/product-import.service.ts`,
 *   `product.variants.map`, no `isActive` filter).
 * - 1.2.0 .. 1.2.3 import template: field-key headers
 *   `categoryName,name,variant,code,weightKg,alias,size,multiColour`
 *   (`git show 6de23b76:master/src/domain/product-import.ts`, `IMPORT_HEADERS`).
 *
 * Each `it` asserts what the owner asked for; one named "demonstrates" fails
 * today and is the proof of a defect.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { db } from '../../src/db/knex.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { IMPORT_HEADERS } from '../../src/domain/product-import.js';
import { createZipWriter } from '../../src/lib/archive-zip.js';
import { toCsv } from '../../src/lib/csv.js';
import { readSheetRows } from '../../src/lib/spreadsheet.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import * as fields from '../../src/services/fields.service.js';
import { buildProductExport, importProducts } from '../../src/services/product-import.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from '../helpers/fixtures.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const OLD_CSV = 'products-export-1.2.5.csv';
const OLD_XLSX = 'products-export-1.2.5.xlsx';

let admin: ActorContext;
let dir: string;

const fixtureBytes = (name: string) => readFile(path.join(FIXTURES, name));

async function zipOf(entries: Array<[string, Buffer]>): Promise<string> {
  const file = path.join(dir, `${randomUUID()}.zip`);
  const writer = createZipWriter(file);
  for (const [name, bytes] of entries) await writer.appendEntry(name, [bytes], { store: true });
  await writer.finalize();
  return file;
}

/** The sub product export (what every version from 1.2.4 on writes), as rows. */
async function exportRows(): Promise<string[][]> {
  return readSheetRows((await buildProductExport('csv', admin, 'sub')).bytes);
}

/** The main products the 1.2.5 fixture names, created as a company would have them. */
async function mainProductsOfFixture(): Promise<void> {
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

async function subProducts() {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.map((product) => ({
    main: product.categoryCode ?? product.categoryName,
    name: product.name,
    multiColour: product.multiColour,
    hasVariants: product.hasVariants,
    variants: product.variants.map((variant) => ({
      code: variant.code,
      label: variant.label,
      weightKg: variant.weightKg,
      isActive: variant.isActive,
    })),
  }));
}

describe.skipIf(!canRunIntegrationTests)('lens C: product files from earlier versions (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
  }, 120_000);
  afterAll(async () => {
    await rm(path.join(config.imagesDir, await testTenantId()), { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-c-'));
  });

  it('C1 demonstrates: Restore from .zip refuses the bare products export every earlier version wrote', async () => {
    // A 1.2.4 .. 1.4.6 install can only have saved its products as this CSV or XLSX.
    const csv = path.join(dir, 'products-2026-10-07.csv');
    await writeFile(csv, await fixtureBytes(OLD_CSV));
    const xlsx = path.join(dir, 'products-2026-10-07.xlsx');
    await writeFile(xlsx, await fixtureBytes(OLD_XLSX));
    // And each put in a zip under the name 1.2.5 .. 1.4.6 downloaded it as (`products-${today()}.csv`).
    const zippedCsv = await zipOf([['products-2026-10-07.csv', await fixtureBytes(OLD_CSV)]]);
    const zippedXlsx = await zipOf([['products-2026-10-07.xlsx', await fixtureBytes(OLD_XLSX)]]);

    const outcome = async (file: string) =>
      previewProductZip(file, path.basename(file), admin).then(
        (report) => ({ created: report.products.created, failed: report.products.failed }),
        (error: { messageKey?: string }) => error.messageKey,
      );

    expect({
      csv: await outcome(csv),
      xlsx: await outcome(xlsx),
      zippedCsv: await outcome(zippedCsv),
      zippedXlsx: await outcome(zippedXlsx),
    }).toEqual({
      csv: { created: 6, failed: 0 },
      xlsx: { created: 6, failed: 0 },
      zippedCsv: { created: 6, failed: 0 },
      zippedXlsx: { created: 6, failed: 0 },
    });
  });

  it('C2 demonstrates: the Import dialog ("Update them") refuses every row of a 1.2.5-1.4.6 export when its main products are not in the catalogue', async () => {
    // An empty catalogue: the one a backup is restored into.
    for (const name of [OLD_CSV, OLD_XLSX]) {
      const result = await importProducts(
        { buffer: await fixtureBytes(name), fileName: name },
        { dryRun: false, mode: 'upsert' },
        admin,
      );
      expect(
        {
          name,
          created: result.created,
          failed: result.failed,
          keys: [...new Set(result.issues.map((issue) => issue.messageKey))],
        },
        name,
      ).toEqual({ name, created: 6, failed: 0, keys: [] });
    }
  });

  it('C3 checked: a zip holding only the 1.2.5-1.4.6 products.csv restores an empty catalogue with every cell, code, brand and order', async () => {
    const file = await zipOf([['products.csv', await fixtureBytes(OLD_CSV)]]);

    const preview = await previewProductZip(file, 'old.zip', admin);
    expect(preview.mainProducts.added).toEqual([
      { code: 'OPT', name: 'One Piece Toilet', brand: 'Swisware+' },
      { code: 'OPB', name: 'One Piece Basin', brand: 'Swisware+' },
      { code: 'WB', name: 'Wash Basin', brand: 'Swisware+' },
      { code: 'TNK', name: 'Cistern', brand: 'Another Co' },
    ]);
    expect(preview.products).toMatchObject({ created: 6, failed: 0 });

    const done = await restoreProductZip(file, 'old.zip', {}, admin);
    expect(done.products).toMatchObject({ created: 6, failed: 0 });
    expect(done.problems).toEqual([]);

    // The export written again is the old file, row for row, in its order.
    expect(await exportRows()).toEqual(await readSheetRows(await fixtureBytes(OLD_CSV)));
    const mains = await productRepo.listCategories(admin.tenantId);
    expect(mains.map((main) => [main.code, main.name, main.brand])).toEqual([
      ['OPT', 'One Piece Toilet', 'Swisware+'],
      ['OPB', 'One Piece Basin', 'Swisware+'],
      ['WB', 'Wash Basin', 'Swisware+'],
      ['TNK', 'Cistern', 'Another Co'],
    ]);
    // The same zip again changes nothing.
    const again = await previewProductZip(file, 'old.zip', admin);
    expect(again.products).toMatchObject({ created: 0, updated: 0, unchanged: 6, failed: 0 });
    expect(again.mainProducts).toEqual({ added: [], renamed: [] });
  });

  it('C4 demonstrates: the Import dialog files the sub products of a 1.2.5-1.4.6 export in name order, not in the catalogue order the file holds', async () => {
    await mainProductsOfFixture();
    const result = await importProducts(
      { buffer: await fixtureBytes(OLD_CSV), fileName: OLD_CSV },
      { dryRun: false, mode: 'upsert' },
      admin,
    );
    expect(result).toMatchObject({ created: 6, failed: 0 });

    // The sub products of each main product in order (the main products' own
    // order is this test's setup, made by hand with none, so it is not compared).
    const codeAt = IMPORT_HEADERS.indexOf('Code');
    const mainAt = IMPORT_HEADERS.indexOf('Main product code');
    const byMain = (rows: string[][]) => {
      const out: Record<string, string[]> = {};
      for (const row of rows.slice(1)) (out[row[mainAt]!] ??= []).push(row[codeAt]!);
      return out;
    };
    // The file: WB-0001 (WB-18X12) before WB-0002 (MAGENTA "D").
    expect(byMain(await exportRows())).toEqual(byMain(await readSheetRows(await fixtureBytes(OLD_CSV))));
  });

  it('C5 demonstrates: a 1.2.4 export (it wrote rows for variants taken off the form) brings such a variant back to life', async () => {
    await mainProductsOfFixture();
    await catalog.createProduct(
      {
        categoryCode: 'WB',
        name: 'DAMRU',
        hasVariants: true,
        variants: [
          { code: 'DM-01', label: 'Blue', weightKg: 6.5 },
          { code: 'DM-02', label: 'Ivory', weightKg: 6.6 },
        ],
      },
      admin,
    );
    // DM-02 taken off the form while history still quotes it.
    await db()('product_variants').where({ code: 'DM-02' }).update({ is_active: false });

    // What 1.2.4's `exportProducts` wrote for it: every variant, active or not.
    const rows = [
      ['Swisware+', 'WB', 'Wash Basin', 'DAMRU', '', 'fixed', 'Blue', 'DM-01', '6.5', ''],
      ['Swisware+', 'WB', 'Wash Basin', 'DAMRU', '', 'fixed', 'Ivory', 'DM-02', '6.6', ''],
    ];
    const file = { buffer: Buffer.from('﻿' + toCsv([...IMPORT_HEADERS], rows), 'utf8'), fileName: 'products.csv' };
    await importProducts(file, { dryRun: false, mode: 'upsert' }, admin);

    const variant = await db()('product_variants').where({ code: 'DM-02' }).first<{ is_active: boolean }>();
    expect(variant?.is_active).toBe(false);
  });

  it('C6 demonstrates: a sub product a 1.2.0-1.2.3 template made (Multicolour yes + a variant column) does not come back from the current zip', async () => {
    // The 1.2.0 template's own header row; the current import still reads it.
    const template = [
      'categoryName,name,variant,code,weightKg,alias,size,multiColour',
      'Wash Basin,DAMRU,Blue,DM-01,6.5,Damru,18x12,yes',
      'Wash Basin,DAMRU,Ivory,DM-02,6.6,Damru,18x12,yes',
    ].join('\r\n');
    const imported = await importProducts(
      { buffer: Buffer.from(template + '\r\n', 'utf8'), fileName: 'products-template.csv' },
      { dryRun: false, mode: 'create' },
      admin,
    );
    expect(imported).toMatchObject({ created: 2, failed: 0 });
    const before = await subProducts();
    expect(before[0]).toMatchObject({ multiColour: true, hasVariants: true });

    const { filePath } = await exportProductZip(admin);
    const zip = path.join(dir, 'backup.zip');
    await copyFile(filePath, zip);
    await rm(filePath, { force: true });

    // Over the same catalogue, the unedited zip must read as unchanged.
    const preview = await previewProductZip(zip, 'backup.zip', admin);
    // Into an emptied catalogue, it must bring the sub product back whole.
    await resetData();
    admin = await testActor();
    const done = await restoreProductZip(zip, 'backup.zip', {}, admin);

    expect({
      preview: { updated: preview.products.updated, failed: preview.products.failed },
      restored: { failed: done.products.failed, subs: await subProducts() },
    }).toEqual({
      preview: { updated: 0, failed: 0 },
      restored: { failed: 0, subs: before },
    });
  });

  it('C7 checked: a zip whose products.csv is a filled-in 1.2.0-1.2.3 template restores an empty catalogue as that template says', async () => {
    const template = [
      'categoryName,name,variant,code,weightKg,alias,size,multiColour',
      'Tiles,Plain Tile,,PT-01,1.5,PT,30x30,no',
      'Wash Basin,Any Colour Basin,,AC-01,7,,18x12,yes',
      'Wash Basin,Pattern Basin,Vitrosa 41,PB-01,6.25,,,',
      'Wash Basin,Pattern Basin,Blue,PB-02,,,,',
    ].join('\r\n');
    const file = await zipOf([['products.csv', Buffer.from(template + '\r\n', 'utf8')]]);
    const done = await restoreProductZip(file, 'old-template.zip', {}, admin);
    expect(done.products).toMatchObject({ created: 4, failed: 0 });

    expect(await subProducts()).toEqual([
      {
        main: 'Tiles',
        name: 'Plain Tile',
        multiColour: false,
        hasVariants: false,
        variants: [{ code: 'PT-01', label: null, weightKg: 1.5, isActive: true }],
      },
      {
        main: 'Wash Basin',
        name: 'Any Colour Basin',
        multiColour: true,
        hasVariants: false,
        variants: [{ code: 'AC-01', label: null, weightKg: 7, isActive: true }],
      },
      {
        main: 'Wash Basin',
        name: 'Pattern Basin',
        multiColour: false,
        hasVariants: true,
        variants: [
          { code: 'PB-01', label: 'Vitrosa 41', weightKg: 6.25, isActive: true },
          { code: 'PB-02', label: 'Blue', weightKg: null, isActive: true },
        ],
      },
    ]);
    const product = (await productRepo.listProducts(admin.tenantId, { limit: 10, offset: 0 })).items[0]!;
    expect({ alias: product.alias, size: product.size }).toEqual({ alias: 'PT', size: '30x30' });
  });
});
