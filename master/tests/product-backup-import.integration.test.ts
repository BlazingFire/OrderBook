/**
 * The import the product backup restore runs (`importProducts` with
 * `restore`, `services/product-import.service.ts`) against PostgreSQL: a
 * backup comes back as the data it was — colours, spacing, cleared cells,
 * colour rules, spellings, order — whether into an emptied catalogue or over
 * the one it came from; a sub product under another install's codes, or one
 * in the Recycle Bin, is that sub product rather than a twin beside it; and
 * the plain spreadsheet import keeps its own rules and still reads an
 * unedited export as unchanged.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Product } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { IMPORT_HEADERS } from '../src/domain/product-import.js';
import { db } from '../src/db/knex.js';
import { toCsv } from '../src/lib/csv.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as customFieldRepo from '../src/repositories/custom-field.repository.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import { buildProductExport, importProducts } from '../src/services/product-import.service.js';
import { exportProductZip, previewProductZip, restoreProductZip } from '../src/services/product-zip.service.js';
import * as settings from '../src/services/settings.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let admin: ActorContext;
let dir: string;

const csv = (rows: ReadonlyArray<ReadonlyArray<string | number>>): Buffer =>
  Buffer.from('﻿' + toCsv([...IMPORT_HEADERS], rows.map((row) => [...row])), 'utf8');

/** A column of the export, by its header. */
const column = (header: string): number => IMPORT_HEADERS.indexOf(header);

/** The products export's rows under its header (`IMPORT_HEADERS`): what a backup's products.csv holds. */
async function exportRows(): Promise<string[][]> {
  const [header, ...body] = await readSheetRows((await buildProductExport('csv', admin, 'sub')).bytes);
  expect(header).toEqual([...IMPORT_HEADERS]);
  return body;
}

/** Rows with cells changed, by the row's code and the column's header. */
function edit(rows: string[][], code: string, cells: Record<string, string>): string[][] {
  return rows.map((row) =>
    row[column('Code')] === code
      ? row.map((cell, index) => (IMPORT_HEADERS[index]! in cells ? cells[IMPORT_HEADERS[index]!]! : cell))
      : row,
  );
}

type Run = Awaited<ReturnType<typeof importProducts>>;

/** The restore's import of these rows: its preview, then the real run. */
async function restore(
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
  options: { exactVariants?: boolean } = {},
  actor: ActorContext = admin,
): Promise<[Run, Run]> {
  const run = (dryRun: boolean) =>
    importProducts({ buffer: csv(rows), fileName: 'products.csv' }, { dryRun, mode: 'upsert', restore: options }, actor);
  return [await run(true), await run(false)];
}

/** Where a binned sub product is: still in the Recycle Bin, or not. */
async function inBin(id: string): Promise<boolean> {
  return (await db()('products').where({ id }).first('deleted_at')).deleted_at !== null;
}

/** Each issue's message and its params, in the order reported. */
const problems = (result: Run) => result.issues.map((issue) => [issue.messageKey, issue.params]);

/** The plain spreadsheet import ("Update them") of these rows: its preview, then the real run. */
async function plain(rows: ReadonlyArray<ReadonlyArray<string | number>>, mode: 'create' | 'upsert' = 'upsert') {
  const run = (dryRun: boolean) => importProducts({ buffer: csv(rows), fileName: 'p.csv' }, { dryRun, mode }, admin);
  return [await run(true), await run(false)] as const;
}

const counts = (result: Run) => ({
  created: result.created,
  updated: result.updated,
  unchanged: result.unchanged,
  failed: result.failed,
});

async function live(): Promise<Product[]> {
  return (await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 })).items;
}

async function byCode(code: string): Promise<Product | undefined> {
  return (await live()).find((product) => product.variants.some((variant) => variant.isActive && variant.code === code));
}

/** What a person can set on every live sub product, in catalogue order. */
async function subs() {
  return (await live()).map((product) => ({
    main: product.categoryCode ?? product.categoryName,
    name: product.name,
    alias: product.alias,
    size: product.size,
    multiColour: product.multiColour,
    hasVariants: product.hasVariants,
    variants: product.variants
      .filter((variant) => variant.isActive)
      .map((variant) => [variant.code, variant.label, variant.weightKg]),
  }));
}

const value = (listKey: 'stock.colour' | 'product.brand', text: string) =>
  fields.createValue({ listKey, value: text, label: text, hex: null }, admin);

/**
 * OPT ONE PIECE TOILET (Swisware+): 101 fixed White OPT-0001 12.5 kg, alias
 * One-o-one, size 70x40; 102 dedicated OPT-0002 10 kg; 103 multicolour
 * OPT-0003. WB WASH BASIN: DAMRU White WB-0001 and Ivory WB-0002, 4 kg each.
 */
async function seed(): Promise<void> {
  await value('product.brand', 'Swisware+');
  await value('stock.colour', 'White');
  await value('stock.colour', 'Ivory');
  await catalog.createCategory({ code: 'OPT', name: 'ONE PIECE TOILET', brand: 'Swisware+', sortOrder: 1 }, admin);
  await catalog.createCategory({ code: 'WB', name: 'WASH BASIN', brand: 'Swisware+', sortOrder: 2 }, admin);
  const sub = (input: Record<string, unknown>) => catalog.createProduct(input as never, admin);
  await sub({
    categoryCode: 'OPT',
    name: '101',
    alias: 'One-o-one',
    size: '70x40',
    sortOrder: 1,
    hasVariants: true,
    variants: [{ code: 'OPT-0001', label: 'White', weightKg: 12.5 }],
  });
  await sub({ categoryCode: 'OPT', name: '102', sortOrder: 2, hasVariants: false, variants: [{ code: 'OPT-0002', label: null, weightKg: 10 }] });
  await sub({ categoryCode: 'OPT', name: '103', sortOrder: 3, multiColour: true, hasVariants: false, variants: [{ code: 'OPT-0003', label: null }] });
  await sub({
    categoryCode: 'WB',
    name: 'DAMRU',
    hasVariants: true,
    variants: [
      { code: 'WB-0001', label: 'White', weightKg: 4 },
      { code: 'WB-0002', label: 'Ivory', weightKg: 4 },
    ],
  });
}

/** The product zip export, as a file in `dir`. */
async function zipped(): Promise<string> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return file;
}

async function emptyCatalogue(): Promise<void> {
  await resetData();
  customFieldRepo.invalidateFieldCache();
  admin = await testActor();
}

describe.skipIf(!canRunIntegrationTests)('importing a product backup back (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
  }, 120_000);
  afterAll(async () => {
    await teardownDatabase();
  });
  beforeEach(async () => {
    await emptyCatalogue();
    await seed();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'product-backup-'));
  }, 120_000);

  it('reads an unedited export as unchanged and lists nothing', async () => {
    const [preview, done] = await restore(await exportRows());
    for (const result of [preview, done]) {
      expect(counts(result)).toEqual({ created: 0, updated: 0, unchanged: 5, failed: 0 });
      expect(result.rows).toMatchObject({ added: [], changed: [], variantsNotInFile: [], restoredFromBin: [], reordered: [] });
    }
  });

  describe('a multicolour sub product that also has colours (the form allows both; a 1.2.0 template made them)', () => {
    beforeEach(async () => {
      await catalog.createProduct(
        {
          categoryCode: 'WB',
          name: 'BOTH',
          multiColour: true,
          hasVariants: true,
          variants: [
            { code: 'B-1', label: 'White', weightKg: 6.5 },
            { code: 'B-2', label: 'Ivory', weightKg: 6.6 },
          ],
        },
        admin,
      );
    });

    it('exports its colours and comes back whole into an emptied catalogue', async () => {
      const before = await subs();
      const rows = await exportRows();
      expect(rows.filter((row) => row[column('Code')]?.startsWith('B-')).map((row) => [row[column('Colour rule')], row[column('Colour')]])).toEqual([
        ['multicolour', 'White'],
        ['multicolour', 'Ivory'],
      ]);
      const file = await zipped();
      await emptyCatalogue();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      expect(report.products.failed).toBe(0);
      expect(await subs()).toEqual(before);
    });

    it('reads as unchanged over the same catalogue, and keeps its colours', async () => {
      const before = await subs();
      const file = await zipped();
      const preview = await previewProductZip(file, 'p.zip', admin);
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect(preview.products).toMatchObject({ updated: 0, failed: 0 });
      expect(preview.rows.changed).toEqual([]);
      expect(await subs()).toEqual(before);
    });

    it('comes back from a 1.2.0 template file the same way', async () => {
      const template = [
        'categoryName,name,variant,code,weightKg,alias,size,multiColour',
        'Wash Basin,DAMRU2,Blue,DM-01,6.5,Damru,18x12,yes',
        'Wash Basin,DAMRU2,Ivory,DM-02,6.6,Damru,18x12,yes',
      ].join('\r\n');
      await importProducts(
        { buffer: Buffer.from(template + '\r\n', 'utf8'), fileName: 'template.csv' },
        { dryRun: false, mode: 'create' },
        admin,
      );
      const before = await subs();
      const [preview] = await restore(await exportRows());
      expect(counts(preview)).toMatchObject({ updated: 0, failed: 0 });
      const file = await zipped();
      await emptyCatalogue();
      await restoreProductZip(file, 'p.zip', {}, admin);
      expect(await subs()).toEqual(before);
    });
  });

  describe('text the screens keep as typed', () => {
    beforeEach(async () => {
      await value('product.brand', 'Swis  ware');
      await value('stock.colour', 'Off  White');
      // A code-less main product, as the product form's name box creates it.
      await catalog.createProduct(
        {
          categoryName: 'WALL  HUNG',
          categoryBrand: 'Swis  ware',
          name: 'TWO  SPACES',
          alias: 'a  b',
          size: 'L-27  B-15',
          hasVariants: true,
          variants: [{ code: 'T-2', label: 'Off  White' }],
        } as never,
        admin,
      );
      const wall = (await productRepo.listCategories(admin.tenantId)).find((category) => category.name === 'WALL  HUNG')!;
      await catalog.createProduct({ categoryId: wall.id, name: 'TWO SPACES', hasVariants: false, variants: [{ code: 'T-1', label: null }] }, admin);
      await catalog.createProduct({ categoryId: wall.id, name: 'ROYAL SET', hasVariants: false, variants: [{ code: 'R-1', label: null }] }, admin);
      await catalog.createProduct({ categoryId: wall.id, name: "'-90 BEND", alias: "'+1", hasVariants: false, variants: [{ code: "'-1", label: null }] }, admin);
    });

    const brands = async () =>
      (await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand')).map((option) => option.value);
    const mains = async () => (await productRepo.listCategories(admin.tenantId)).map((category) => category.name);

    it('comes back exactly into an emptied catalogue: no collapsed brand, main product or merged sub product', async () => {
      const before = { subs: await subs(), brands: await brands(), mains: await mains() };
      const file = await zipped();
      await emptyCatalogue();
      const report = await restoreProductZip(file, 'p.zip', {}, admin);
      expect(report.products.failed).toBe(0);
      expect({ subs: await subs(), brands: await brands(), mains: await mains() }).toEqual(before);
    });

    it('reads as unchanged over the same catalogue and writes nothing', async () => {
      const before = { subs: await subs(), mains: await mains() };
      const [preview, done] = await restore(await exportRows());
      expect(preview.rows?.changed).toEqual([]);
      expect(done.updated).toBe(0);
      expect({ subs: await subs(), mains: await mains() }).toEqual(before);
    });

    it('a typed sheet still collapses spacing, but an unedited export neither reports nor writes a spacing-only change', async () => {
      const rows = (await exportRows()).filter((row) => row[column('Code')] === 'T-2');
      const [preview, done] = await plain(rows);
      expect(counts(preview)).toEqual({ created: 0, updated: 0, unchanged: 1, failed: 0 });
      expect(counts(done)).toEqual(counts(preview));

      // Another cell changed: that cell is written, the stored spacing is not touched.
      await plain(edit(rows, 'T-2', { 'Weight (kg)': '3' }));
      expect(await byCode('T-2')).toMatchObject({ name: 'TWO  SPACES', alias: 'a  b', size: 'L-27  B-15' });
      expect((await byCode('T-2'))!.variants[0]).toMatchObject({ label: 'Off  White', weightKg: 3 });
    });

    it('a typed sheet moves a sub product into the main product its preview matched, not a new one of the collapsed name', async () => {
      await settings.writeSetting(admin, 'catalog.importCreatesCategories', false);
      const rows = edit(await exportRows(), 'OPT-0001', { Brand: 'Swis ware', 'Main product code': '', 'Main product': 'WALL HUNG' });
      const [preview, done] = await plain(rows.filter((row) => row[column('Code')] === 'OPT-0001'));
      for (const result of [preview, done]) expect(counts(result)).toEqual({ created: 0, updated: 1, unchanged: 0, failed: 0 });
      expect((await mains()).filter((name) => name.toUpperCase().includes('WALL'))).toEqual(['WALL  HUNG']);
      expect((await byCode('OPT-0001'))!.categoryName).toBe('WALL  HUNG');
    });
  });

  it('clears a weight, an alias and a size the backup has blank, and lists them; a typed sheet leaves them', async () => {
    const rows = edit(await exportRows(), 'OPT-0001', { 'Weight (kg)': '', Alias: '', Size: '' });
    const [preview, done] = await restore(rows);
    for (const result of [preview, done]) {
      expect(result.rows?.changed).toEqual([
        {
          code: 'OPT-0001',
          name: '101',
          fields: [
            { column: 'Alias', from: 'One-o-one', to: '' },
            { column: 'Size', from: '70x40', to: '' },
            { column: 'Weight (kg)', from: '12.5', to: '' },
          ],
        },
      ]);
    }
    expect(await byCode('OPT-0001')).toMatchObject({ alias: null, size: null });
    expect((await byCode('OPT-0001'))!.variants[0]!.weightKg).toBeNull();

    await emptyCatalogue();
    await seed();
    const [typed] = await plain(rows);
    expect(counts(typed)).toMatchObject({ updated: 0, unchanged: 5 });
  });

  it.each([
    ['fixed', 'dedicated', '', { multiColour: false, hasVariants: false, label: null }],
    ['fixed', 'multicolour', '', { multiColour: true, hasVariants: false, label: null }],
    ['multicolour', 'dedicated', '', { multiColour: false, hasVariants: false, label: null }],
    ['dedicated', 'fixed', 'White', { multiColour: false, hasVariants: true, label: 'White' }],
  ] as const)('turns a %s sub product the file calls %s into exactly that, preview and run alike', async (from, to, colour, want) => {
    const code = { fixed: 'OPT-0001', dedicated: 'OPT-0002', multicolour: 'OPT-0003' }[from];
    const [preview, done] = await restore(edit(await exportRows(), code, { 'Colour rule': to, Colour: colour }));
    expect(preview.rows?.changed).toEqual(done.rows?.changed);
    expect(preview.rows?.changed[0]?.fields).toContainEqual({ column: 'Colour rule', from, to });
    const product = (await byCode(code))!;
    expect({ multiColour: product.multiColour, hasVariants: product.hasVariants, label: product.variants[0]!.label }).toEqual(want);
    const [again] = await restore(await exportRows());
    expect(again.updated).toBe(0);
  });

  it('lists a live colour the file does not name, keeps it, and removes it under exactVariants', async () => {
    const rows = (await exportRows()).filter((row) => row[column('Code')] !== 'WB-0002');
    const [preview, done] = await restore(rows);
    for (const result of [preview, done]) {
      expect(result.rows?.variantsNotInFile).toEqual([{ code: 'WB-0002', name: 'DAMRU' }]);
      expect(result.rows?.changed).toEqual([]);
    }
    expect((await byCode('WB-0001'))!.variants.map((variant) => variant.code)).toEqual(['WB-0001', 'WB-0002']);

    const [exactPreview, exact] = await restore(rows, { exactVariants: true });
    for (const result of [exactPreview, exact]) {
      expect(result.rows?.variantsNotInFile).toEqual([{ code: 'WB-0002', name: 'DAMRU' }]);
      expect(result.updated).toBe(1);
    }
    const damru = (await byCode('WB-0001'))!;
    expect(damru.variants.map((variant) => [variant.code, variant.label])).toEqual([['WB-0001', 'White']]);
    expect(damru.hasVariants).toBe(true);
  });

  it('keeps a colour whose row it refused, under exactVariants too, and does not list it as missing', async () => {
    // A second size on DAMRU's second row: that row is another sub product the file cannot tell apart.
    const rows = edit(await exportRows(), 'WB-0002', { Size: '60x45' });
    const [preview, done] = await restore(rows, { exactVariants: true });
    for (const result of [preview, done]) {
      expect(problems(result)).toEqual([['validation.import.subProductCellsDiffer', { name: 'DAMRU', column: 'Size', firstRow: 5 }]]);
      expect(result.rows?.variantsNotInFile).toEqual([]);
    }
    expect((await byCode('WB-0001'))!.variants.map((variant) => [variant.code, variant.isActive])).toEqual([
      ['WB-0001', true],
      ['WB-0002', true],
    ]);
  });

  describe('colour spelling', () => {
    beforeEach(async () => {
      // The Fields screen allows both spellings; WHITE came second.
      await value('stock.colour', 'WHITE');
      await catalog.createProduct(
        { categoryCode: 'OPT', name: '104', hasVariants: true, variants: [{ code: 'OPT-0004', label: 'WHITE' }] },
        admin,
      );
    });

    const labels = async () =>
      Promise.all(['OPT-0001', 'OPT-0004', 'WB-0001'].map(async (code) => (await byCode(code))!.variants[0]!.label));

    it('a restore keeps the backup\'s own spelling of every colour', async () => {
      const [preview, done] = await restore(await exportRows());
      expect([preview.updated, done.updated]).toEqual([0, 0]);
      expect(await labels()).toEqual(['White', 'WHITE', 'White']);
    });

    it('a typed sheet keeps a spelling the list has and maps another to the first one listed, preview and run alike', async () => {
      const rows = edit(edit(await exportRows(), 'OPT-0001', { Colour: 'white' }), 'WB-0001', { Colour: 'WHITE' });
      const [preview, done] = await plain(rows);
      // DAMRU's two rows.
      expect(preview.updated).toBe(2);
      expect(done.updated).toBe(preview.updated);
      // white → White (first listed); WHITE and White are both list values and stay.
      expect(await labels()).toEqual(['White', 'WHITE', 'WHITE']);
    });
  });

  describe('the same sub product under codes this catalogue does not have', () => {
    it('is the live one of that name: updated and recoded, not created beside it', async () => {
      const rows = edit(await exportRows(), 'OPT-0001', { Code: 'OPT-9001', Colour: 'Ivory' });
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) {
        expect(counts(result)).toEqual({ created: 0, updated: 1, unchanged: 4, failed: 0 });
        expect(result.rows?.variantsNotInFile).toEqual([{ code: 'OPT-0001', name: '101' }]);
      }
      const named101 = (await live()).filter((product) => product.name === '101');
      expect(named101.map((product) => product.variants.map((variant) => [variant.code, variant.label]))).toEqual([
        [['OPT-9001', 'Ivory']],
      ]);
    });

    it('is refused by name in a typed sheet, create or update, as the screens refuse it', async () => {
      const rows = edit(await exportRows(), 'OPT-0001', { Code: 'OPT-9001' });
      for (const mode of ['upsert', 'create'] as const) {
        const [preview, done] = await plain(rows, mode);
        for (const result of [preview, done]) {
          expect(result.created).toBe(0);
          expect(result.issues.filter((issue) => issue.kind === 'error').map((issue) => [issue.row, issue.messageKey, issue.params])).toEqual([
            [2, 'validation.product.nameTaken', { name: '101', category: 'ONE PIECE TOILET' }],
          ]);
        }
      }
      expect((await live()).filter((product) => product.name === '101')).toHaveLength(1);
    });

    it('a move next to a live one of the same name is refused, while a swap of two names lands', async () => {
      await catalog.createProduct({ categoryCode: 'WB', name: '102', hasVariants: false, variants: [{ code: 'WB-0102', label: null }] }, admin);
      const moved = edit(await exportRows(), 'OPT-0002', { 'Main product code': 'WB', 'Main product': 'WASH BASIN' });
      const [preview, done] = await restore(moved);
      for (const result of [preview, done]) {
        expect(result.issues.map((issue) => issue.messageKey)).toEqual(['validation.product.nameTaken']);
      }
      expect((await live()).filter((product) => product.name === '102').map((product) => product.categoryCode).sort()).toEqual(['OPT', 'WB']);

      const swapped = edit(edit(await exportRows(), 'OPT-0001', { 'Sub product': '102' }), 'OPT-0002', { 'Sub product': '101' });
      const [swapPreview, swap] = await restore(swapped);
      expect([swapPreview.updated, swap.updated, swap.failed]).toEqual([2, 2, 0]);
      expect([(await byCode('OPT-0001'))!.name, (await byCode('OPT-0002'))!.name]).toEqual(['102', '101']);
    });
  });

  describe('twins already in the catalogue (two sub products of one name, made before the import kept the rule)', () => {
    beforeEach(async () => {
      await catalog.createProduct({ categoryCode: 'WB', name: 'TWIN', hasVariants: false, variants: [{ code: 'TW-1', label: null }] }, admin);
      const second = await catalog.createProduct({ categoryCode: 'WB', name: 'TWIN B', hasVariants: false, variants: [{ code: 'TW-2', label: null }] }, admin);
      await db()('products').where({ id: second.id }).update({ name: 'TWIN' });
    });

    it('read as unchanged over the same catalogue', async () => {
      const [preview, done] = await restore(await exportRows());
      expect(counts(preview)).toEqual({ created: 0, updated: 0, unchanged: 7, failed: 0 });
      expect(counts(done)).toEqual(counts(preview));
    });

    it('into a catalogue without them, the second is reported as a row problem, never lost silently', async () => {
      const rows = await exportRows();
      await emptyCatalogue();
      await seed();
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) {
        expect(result.failed).toBe(1);
        expect(result.issues.map((issue) => issue.messageKey)).toEqual(['validation.import.duplicateInFile']);
      }
    });

    it('with colours and another size, into a catalogue without them: the second is reported, not folded into the first', async () => {
      await value('stock.colour', 'Black');
      await catalog.createProduct({ categoryCode: 'WB', name: 'PAIR', size: '10x10', hasVariants: true, variants: [{ code: 'P-W', label: 'White' }] }, admin);
      const second = await catalog.createProduct({ categoryCode: 'WB', name: 'PAIR B', size: '20x20', hasVariants: true, variants: [{ code: 'P-B', label: 'Black' }] }, admin);
      await db()('products').where({ id: second.id }).update({ name: 'PAIR' });
      const rows = (await exportRows()).filter((row) => !row[column('Code')]?.startsWith('TW-'));
      const rowOf = (code: string) => rows.findIndex((row) => row[column('Code')] === code) + 2;
      await emptyCatalogue();
      await seed();
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) {
        expect(result.issues.map((issue) => [issue.row, issue.messageKey, issue.params])).toEqual([
          [rowOf('P-B'), 'validation.import.subProductCellsDiffer', { name: 'PAIR', column: 'Size', firstRow: rowOf('P-W') }],
        ]);
      }
      const pairs = (await live()).filter((product) => product.name === 'PAIR');
      expect(pairs.map((product) => [product.size, product.variants.map((variant) => variant.code)])).toEqual([['10x10', ['P-W']]]);
    });
  });

  it('brings a sub product back from the Recycle Bin when the backup names its code, rather than a copy beside it', async () => {
    const rows = await exportRows();
    const binned = (await byCode('OPT-0002'))!;
    await catalog.deleteProduct(binned.id, admin);
    const [preview, done] = await restore(edit(rows, 'OPT-0002', { 'Weight (kg)': '11' }));
    for (const result of [preview, done]) {
      expect(counts(result)).toEqual({ created: 0, updated: 1, unchanged: 4, failed: 0 });
      expect(result.rows?.restoredFromBin).toEqual([
        { code: 'OPT-0002', name: '102', fields: [{ column: 'Weight (kg)', from: '10', to: '11' }] },
      ]);
      expect(result.rows?.added).toEqual([]);
    }
    const back = (await byCode('OPT-0002'))!;
    expect(back.id).toBe(binned.id);
    expect(back.variants[0]!.weightKg).toBe(11);
    expect(await db()('products').where({ name: '102' })).toHaveLength(1);
  });

  describe('a sub product the backup brings back from the Recycle Bin', () => {
    it('keeps a colour the file does not name: listed, as a live one keeps it', async () => {
      const damru = (await byCode('WB-0001'))!;
      const rows = (await exportRows()).filter((row) => row[column('Code')] !== 'WB-0002');
      await catalog.deleteProduct(damru.id, admin);
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) {
        expect(result.rows?.restoredFromBin.map((row) => row.code)).toEqual(['WB-0001']);
        expect(result.rows?.variantsNotInFile).toEqual([{ code: 'WB-0002', name: 'DAMRU' }]);
      }
      const back = (await byCode('WB-0001'))!;
      expect(back.variants.map((variant) => [variant.code, variant.label, variant.isActive])).toEqual([
        ['WB-0001', 'White', true],
        ['WB-0002', 'Ivory', true],
      ]);
    });

    it('stays there when a code it holds is another sub product\'s now, preview and run alike', async () => {
      const damru = (await byCode('WB-0001'))!;
      const rows = (await exportRows()).filter((row) => row[column('Code')] !== 'WB-0002');
      await catalog.deleteProduct(damru.id, admin);
      await catalog.createProduct({ categoryCode: 'WB', name: 'OTHER', hasVariants: false, variants: [{ code: 'WB-0002', label: null }] }, admin);
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) {
        expect(problems(result)).toEqual([['validation.product.restoreCodesTaken', { codes: 'WB-0002' }]]);
        expect([result.created, result.updated, result.rows?.restoredFromBin]).toEqual([0, 0, []]);
      }
      expect(await inBin(damru.id)).toBe(true);
      expect((await byCode('WB-0002'))!.name).toBe('OTHER');
    });

    it('stays there, with no copy made, for a person who may not delete products', async () => {
      const binned = (await byCode('OPT-0002'))!;
      const rows = await exportRows();
      await catalog.deleteProduct(binned.id, admin);
      const limited = await actorWith(['products.view', 'products.bulk', 'products.create', 'products.edit']);
      const [preview, done] = await restore(rows, {}, limited);
      for (const result of [preview, done]) {
        expect(problems(result)).toEqual([['validation.import.binnedNeedsDelete', { name: '102' }]]);
        expect(result.created).toBe(0);
      }
      expect(await inBin(binned.id)).toBe(true);
      expect(await byCode('OPT-0002')).toBeUndefined();
    });
  });

  describe('order', () => {
    it('renumbers a main product whose sub products the file lists in another order, after them the ones it does not name', async () => {
      await catalog.createProduct({ categoryCode: 'OPT', name: '105', sortOrder: 5, hasVariants: false, variants: [{ code: 'OPT-0005', label: null }] }, admin);
      const body = await exportRows();
      const at = (code: string) => body.find((row) => row[column('Code')] === code)!;
      // 103, 101, 102; 105 left out; WASH BASIN as it was.
      const rows = [at('OPT-0003'), at('OPT-0001'), at('OPT-0002'), at('WB-0001'), at('WB-0002')];
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) {
        expect(result.rows?.reordered).toEqual([{ code: 'OPT', name: 'ONE PIECE TOILET' }]);
        expect(counts(result)).toMatchObject({ updated: 0, unchanged: 5 });
      }
      expect((await live()).filter((product) => product.categoryCode === 'OPT').map((product) => [product.name, product.sortOrder])).toEqual([
        ['103', 1],
        ['101', 2],
        ['102', 3],
        ['105', 4],
      ]);
      const [again] = await restore(rows);
      expect(again.rows?.reordered).toEqual([]);
    });

    it('reads an unedited export as in order whatever the stored numbers: gaps and blanks', async () => {
      await db()('products').where({ name: '101' }).update({ sort_order: 10 });
      await db()('products').where({ name: '102' }).update({ sort_order: 40 });
      await db()('products').where({ name: '103' }).update({ sort_order: null });
      const [preview, done] = await restore(await exportRows());
      expect([preview.rows?.reordered, done.rows?.reordered]).toEqual([[], []]);
      expect((await live()).filter((product) => product.categoryCode === 'OPT').map((product) => product.sortOrder)).toEqual([10, 40, null]);
    });

    const inOpt = async () =>
      (await live()).filter((product) => product.categoryCode === 'OPT').map((product) => [product.name, product.sortOrder]);

    it('files a new sub product where the file lists it between live ones, and a second run changes nothing', async () => {
      const body = await exportRows();
      const at = (code: string) => body.find((row) => row[column('Code')] === code)!;
      // ZNEW sorts after 102 by name, so a number tied with 102's would put it there.
      const fresh = edit([at('OPT-0002')], 'OPT-0002', { 'Sub product': 'ZNEW', Code: 'OPT-0015' })[0]!;
      const rows = [at('OPT-0001'), fresh, at('OPT-0002'), at('OPT-0003'), at('WB-0001'), at('WB-0002')];
      const [preview, done] = await restore(rows);
      for (const result of [preview, done]) expect(result.rows?.reordered).toEqual([{ code: 'OPT', name: 'ONE PIECE TOILET' }]);
      expect(await inOpt()).toEqual([
        ['101', 1],
        ['ZNEW', 2],
        ['102', 3],
        ['103', 4],
      ]);
      const [again] = await restore(rows);
      expect([again.rows?.reordered, again.updated]).toEqual([[], 0]);
    });

    it('files one the file lists after every live one last, past gaps in the numbers, renumbering nothing', async () => {
      await db()('products').where({ name: '101' }).update({ sort_order: 10 });
      await db()('products').where({ name: '102' }).update({ sort_order: 40 });
      await db()('products').where({ name: '103' }).update({ sort_order: 50 });
      const body = await exportRows();
      const fresh = edit(body, 'OPT-0003', { 'Sub product': '104', Code: 'OPT-0004' }).find((row) => row[column('Code')] === 'OPT-0004')!;
      const [preview, done] = await restore([...body.slice(0, 3), fresh, ...body.slice(3)]);
      for (const result of [preview, done]) expect(result.rows?.reordered).toEqual([]);
      expect(await inOpt()).toEqual([
        ['101', 10],
        ['102', 40],
        ['103', 50],
        ['104', 51],
      ]);
    });
  });

  it('lists every code and colour of the sub products it adds or changes, for the dry run\'s photo plan', async () => {
    const body = await exportRows();
    const copy = (code: string, cells: Record<string, string>) =>
      edit(body, code, cells).find((row) => row[column('Code')] === cells.Code)!;
    const added = copy('WB-0001', { Colour: 'Blue', Code: 'WB-0003' });
    const fresh = copy('OPT-0002', { 'Sub product': '106', Code: 'OPT-0006' });
    const [preview] = await restore([...body, added, fresh]);
    const damru = (await byCode('WB-0001'))!;
    expect(preview.rows?.subProducts).toEqual([
      { id: null, name: '106', hasVariants: false, variants: [{ code: 'OPT-0006', label: null }] },
      {
        id: damru.id,
        name: 'DAMRU',
        hasVariants: true,
        variants: [
          { code: 'WB-0001', label: 'White' },
          { code: 'WB-0002', label: 'Ivory' },
          { code: 'WB-0003', label: 'Blue' },
        ],
      },
    ]);
    expect(preview.rows?.matchedIds).toContain(damru.id);
  });
});
