/**
 * The product backup zip's own files (`services/product-zip.service.ts`)
 * against PostgreSQL: what an earlier version saved restores as a backup
 * does; main products keep their Order and take the code the file gives the
 * one of their brand and name, or come back from the Recycle Bin; the colour
 * and brand lists come back whole; and a hand-combined file is reported,
 * never thrown, with the preview saying what the run does.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { IMPORT_HEADERS } from '../src/domain/product-import.js';
import { db } from '../src/db/knex.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { toCsv } from '../src/lib/csv.js';
import { ForbiddenError } from '../src/lib/errors.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as customFieldRepo from '../src/repositories/custom-field.repository.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../src/services/product-zip.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

const FIXTURES = path.join(__dirname, 'fixtures');
const MAIN_HEADERS = ['Brand', 'Main product code', 'Main product', 'Order'];

let admin: ActorContext;
let dir: string;

const csv = (
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): Buffer =>
  Buffer.from(
    '﻿' +
      toCsv(
        [...header],
        rows.map((row) => [...row]),
      ),
    'utf8',
  );

async function entriesOf(file: string): Promise<Map<string, Buffer>> {
  const reader = await openZipReader(file);
  const out = new Map<string, Buffer>();
  try {
    for (const { name } of reader.entries) {
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.openStream(name)) chunks.push(chunk as Buffer);
      out.set(name, Buffer.concat(chunks));
    }
  } finally {
    reader.close();
  }
  return out;
}

async function zipOf(entries: Iterable<[string, Buffer]>): Promise<string> {
  const file = path.join(dir, `${randomUUID()}.zip`);
  const writer = createZipWriter(file);
  for (const [name, bytes] of entries) await writer.appendEntry(name, [bytes], { store: true });
  await writer.finalize();
  return file;
}

async function exported(): Promise<{ file: string; entries: Map<string, Buffer> }> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return { file, entries: await entriesOf(file) };
}

/** The main products as the Main products screen lists them. */
const mains = async () =>
  (await productRepo.listCategories(admin.tenantId)).map((main) => ({
    code: main.code,
    name: main.name,
    brand: main.brand,
    order: main.sortOrder,
  }));

/** A list as the Fields screen shows it, in its order. */
const list = async (listKey: string) =>
  (await customFieldRepo.listOptionsForKey(admin.tenantId, listKey)).map((option) => [
    option.value,
    option.label,
    option.hex,
    option.isActive,
  ]);

/** Switched off on the Fields screen. */
async function switchOff(listKey: string, value: string): Promise<void> {
  await db()('option_lists').where({ list_key: listKey, value }).update({ is_active: false });
  customFieldRepo.invalidateFieldCache();
}

const sub = (categoryId: string, name: string, code: string) =>
  catalog.createProduct(
    { categoryId, name, hasVariants: false, variants: [{ code, label: null }] } as never,
    admin,
  );

describe.skipIf(!canRunIntegrationTests)(
  'the product backup zip, its own files (integration)',
  () => {
    beforeAll(async () => {
      await setupDatabase();
    }, 120_000);
    afterAll(async () => {
      await rm(path.join(config.imagesDir, await testTenantId()), { recursive: true, force: true });
      await teardownDatabase();
    });
    beforeEach(async () => {
      await resetData();
      customFieldRepo.invalidateFieldCache();
      admin = await testActor();
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(path.join(os.tmpdir(), 'product-backup-zip-'));
    });

    describe('files an earlier version saved', () => {
      it('restores the products export 1.2.4-1.4.6 saved, bare or zipped under its dated name, CSV or XLSX', async () => {
        const oldCsv = await readFile(path.join(FIXTURES, 'products-export-1.2.5.csv'));
        const oldXlsx = await readFile(path.join(FIXTURES, 'products-export-1.2.5.xlsx'));
        const bareCsv = path.join(dir, 'products-2026-10-07.csv');
        await writeFile(bareCsv, oldCsv);
        const bareXlsx = path.join(dir, 'products-2026-10-07.xlsx');
        await writeFile(bareXlsx, oldXlsx);
        const files = {
          bareCsv,
          bareXlsx,
          zippedCsv: await zipOf([['products-2026-10-07.csv', oldCsv]]),
          zippedXlsx: await zipOf([['Backup/products-2026-10-07.xlsx', oldXlsx]]),
        };
        for (const [name, file] of Object.entries(files)) {
          const preview = await previewProductZip(file, path.basename(file), admin);
          expect({
            name,
            created: preview.products.created,
            failed: preview.products.failed,
            mains: preview.mainProducts.added.map((main) => main.code),
            problems: preview.problems,
          }).toEqual({
            name,
            created: 6,
            failed: 0,
            mains: ['OPT', 'OPB', 'WB', 'TNK'],
            problems: [],
          });
        }

        const done = await restoreProductZip(bareCsv, 'products-2026-10-07.csv', {}, admin);
        expect(done.products).toMatchObject({ created: 6, failed: 0 });
        expect((await mains()).map((main) => main.code)).toEqual(['OPT', 'OPB', 'WB', 'TNK']);
      });

      it('reads the main products export under its dated name, and names a sheet in the zip it does not read', async () => {
        const file = await zipOf([
          ['products.csv', await readFile(path.join(FIXTURES, 'products-export-1.2.5.csv'))],
          [
            'main-products-2026-10-07.csv',
            csv(
              ['Brand', 'Main product code', 'Main product', 'Sub products'],
              [
                ['Swisware+', 'OPT', 'One Piece Toilet', 2],
                ['Swisware+', 'OPB', 'One Piece Basin', 1],
                ['Swisware+', 'EMP', 'Empty Main', 0],
                ['Swisware+', 'WB', 'Wash Basin', 2],
                ['Another Co', 'TNK', 'Cistern', 1],
              ],
            ),
          ],
          ['notes.csv', csv(['Note'], [['call the dealer']])],
        ]);
        const unread = [
          {
            subject: 'notes.csv',
            messageKey: 'validation.productZip.unknownFile',
            params: { file: 'notes.csv' },
          },
        ];

        const preview = await previewProductZip(file, 'old.zip', admin);
        expect(preview.problems).toEqual(unread);
        expect(preview.mainProducts.added.map((main) => main.code)).toEqual([
          'OPT',
          'OPB',
          'EMP',
          'WB',
          'TNK',
        ]);
        const done = await restoreProductZip(file, 'old.zip', {}, admin);
        expect(done.problems).toEqual(unread);
        expect((await mains()).map((main) => main.code)).toEqual([
          'OPT',
          'OPB',
          'EMP',
          'WB',
          'TNK',
        ]);
      });
    });

    describe('main products', () => {
      beforeEach(async () => {
        await fields.createValue(
          { listKey: 'product.brand', value: 'Swisware+', label: 'Swisware+', hex: null },
          admin,
        );
      });

      it('keeps the Order a person typed, blank included, and puts back an Order the file changes', async () => {
        const a = await catalog.createCategory(
          { name: 'A FIRST', code: 'AF', brand: 'Swisware+', sortOrder: 10 },
          admin,
        );
        await catalog.createCategory(
          { name: 'B SECOND', code: 'BS', brand: 'Swisware+', sortOrder: 20 },
          admin,
        );
        await catalog.createCategory(
          { name: 'C UNORDERED', code: 'CU', brand: 'Swisware+', sortOrder: null },
          admin,
        );
        await sub(a.id, 'X', 'AF-1');
        const before = await mains();
        const { file, entries } = await exported();
        expect((await readSheetRows(entries.get('main-products.csv')!)).slice(1)).toEqual([
          ['Swisware+', 'AF', 'A FIRST', '10'],
          ['Swisware+', 'BS', 'B SECOND', '20'],
          ['Swisware+', 'CU', 'C UNORDERED', ''],
        ]);
        expect((await previewProductZip(file, 'p.zip', admin)).mainProducts).toEqual({
          added: [],
          renamed: [],
        });

        const edited = new Map(entries);
        edited.set(
          'main-products.csv',
          csv(MAIN_HEADERS, [
            ['Swisware+', 'AF', 'A FIRST', 30],
            ['Swisware+', 'BS', 'B SECOND', ''],
            ['Swisware+', 'CU', 'C UNORDERED', ''],
          ]),
        );
        const reordered = await zipOf(edited);
        const changes = [
          { code: 'AF', fields: [{ column: 'Order', from: '10', to: '30' }] },
          { code: 'BS', fields: [{ column: 'Order', from: '20', to: '' }] },
        ];
        expect((await previewProductZip(reordered, 'p.zip', admin)).mainProducts.renamed).toEqual(
          changes,
        );
        expect(
          (await restoreProductZip(reordered, 'p.zip', {}, admin)).mainProducts.renamed,
        ).toEqual(changes);
        expect((await mains()).map((main) => [main.code, main.order])).toEqual([
          ['AF', 30],
          ['BS', null],
          ['CU', null],
        ]);

        // Into an emptied catalogue: every Order as it was typed.
        await resetData();
        admin = await testActor();
        await restoreProductZip(file, 'p.zip', {}, admin);
        expect(await mains()).toEqual(before);
      });

      it('leaves the Order of the ones there when the file has no Order column, and puts a new one after the last', async () => {
        const a = await catalog.createCategory(
          { name: 'A FIRST', code: 'AF', brand: 'Swisware+', sortOrder: 10 },
          admin,
        );
        await sub(a.id, 'X', 'AF-1');
        await catalog.createCategory(
          { name: 'B SECOND', code: 'BS', brand: 'Swisware+', sortOrder: 20 },
          admin,
        );
        const { entries } = await exported();
        const edited = new Map(entries);
        edited.set(
          'main-products.csv',
          csv(
            ['Brand', 'Main product code', 'Main product', 'Sub products'],
            [
              ['Swisware+', 'NEW', 'NEW ONE', 0],
              ['Swisware+', 'BS', 'B SECOND', 0],
              ['Swisware+', 'AF', 'A FIRST', 0],
            ],
          ),
        );
        const file = await zipOf(edited);

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(preview.mainProducts).toEqual({
          added: [{ code: 'NEW', name: 'NEW ONE', brand: 'Swisware+' }],
          renamed: [],
        });
        await restoreProductZip(file, 'p.zip', {}, admin);
        expect((await mains()).map((main) => [main.code, main.order])).toEqual([
          ['AF', 10],
          ['BS', 20],
          ['NEW', 21],
        ]);
      });

      it("gives the main product of the file's brand and name the file's code, and the preview reads its rows by it", async () => {
        const basin = await catalog.createCategory(
          { name: 'WASH BASIN', code: 'WBX', brand: 'Swisware+', sortOrder: 1 },
          admin,
        );
        await sub(basin.id, 'DAMRU', 'WB-0001');
        const plain = await catalog.createCategory(
          { name: 'PLAIN', code: 'PL', brand: 'Swisware+', sortOrder: 2 },
          admin,
        );
        await db()('product_categories').where({ id: plain.id }).update({ code: null });
        const { entries } = await exported();
        const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
        const codeAt = header!.indexOf('Main product code');
        const rows = body.map((row) => row.map((cell, index) => (index === codeAt ? 'WB' : cell)));
        rows.push([
          'Swisware+',
          'WB',
          'WASH BASIN',
          'SQUARE',
          '',
          'dedicated',
          '',
          'WB-0003',
          '',
          '',
        ]);
        const edited = new Map(entries);
        edited.set('products.csv', csv(header!, rows));
        edited.set(
          'main-products.csv',
          csv(MAIN_HEADERS, [
            ['Swisware+', 'WB', 'WASH BASIN', 1],
            ['Swisware+', 'PL', 'PLAIN', 2],
          ]),
        );
        const file = await zipOf(edited);
        const recoded = [
          { code: 'WBX', fields: [{ column: 'Main product code', from: 'WBX', to: 'WB' }] },
          { code: 'PLAIN', fields: [{ column: 'Main product code', from: '', to: 'PL' }] },
        ];

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(preview.mainProducts).toEqual({ added: [], renamed: recoded });
        expect(preview.products).toMatchObject({ created: 1, updated: 0, unchanged: 1, failed: 0 });
        expect(preview.rows.changed).toEqual([]);
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.mainProducts).toEqual({ added: [], renamed: recoded });
        expect(done.products).toMatchObject({ created: 1, updated: 0, unchanged: 1, failed: 0 });
        expect((await mains()).map((main) => main.code)).toEqual(['WB', 'PL']);
        expect((await productRepo.listCategories(admin.tenantId))[0]!.id).toBe(basin.id);
      });

      it('reports a main product a combined file lists twice, by code or by brand and name, and the run throws nothing', async () => {
        const header = [...IMPORT_HEADERS];
        const file = await zipOf([
          [
            'products.csv',
            csv(header, [
              ['Swisware+', 'WB', 'WASH BASIN', 'DAMRU', '', 'dedicated', '', 'WB-0001', '', ''],
              ['Swisware+', 'WB1', 'WASH BASIN', 'SQUARE', '', 'dedicated', '', 'WB1-0001', '', ''],
            ]),
          ],
          [
            'main-products.csv',
            csv(MAIN_HEADERS, [
              ['Swisware+', 'WB', 'WASH BASIN', 1],
              ['Swisware+', 'WB1', 'WASH BASIN', 2],
              ['Swisware+', 'wb', 'WASH BASINS', 3],
            ]),
          ],
          ['colours.csv', csv(['Colour', 'Hex'], [['Probe Teal', '#008080']])],
        ]);
        const twice = [
          {
            subject: 'wb',
            messageKey: 'validation.productZip.mainDuplicate',
            params: { first: 'WB — WASH BASIN' },
          },
          {
            subject: 'WB1',
            messageKey: 'validation.productZip.mainDuplicate',
            params: { first: 'WB — WASH BASIN' },
          },
        ];

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(preview.mainProducts.added).toEqual([
          { code: 'WB', name: 'WASH BASIN', brand: 'Swisware+' },
        ]);
        expect(preview.problems).toEqual(twice);
        expect(preview.products).toMatchObject({ created: 1, failed: 1 });
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.mainProducts.added).toEqual(preview.mainProducts.added);
        expect(done.problems).toEqual(twice);
        expect(done.products).toMatchObject({ created: 1, failed: 1 });
        expect(await mains()).toEqual([
          { code: 'WB', name: 'WASH BASIN', brand: 'Swisware+', order: 1 },
        ]);
      });

      it('refuses two main products that swap names in the preview as in the run, and makes a chain of renames in its order', async () => {
        await catalog.createCategory(
          { name: 'TOILET', code: 'T', brand: 'Swisware+', sortOrder: 1 },
          admin,
        );
        await catalog.createCategory(
          { name: 'BASIN', code: 'B', brand: 'Swisware+', sortOrder: 2 },
          admin,
        );
        const pan = await catalog.createCategory(
          { name: 'PAN', code: 'P', brand: 'Swisware+', sortOrder: 5 },
          admin,
        );
        await sub(pan.id, '101', 'P-1');
        await catalog.createCategory(
          { name: 'TANK', code: 'K', brand: 'Swisware+', sortOrder: 3 },
          admin,
        );
        await catalog.createCategory(
          { name: 'SEAT', code: 'S', brand: 'Swisware+', sortOrder: 4 },
          admin,
        );
        const { entries } = await exported();
        const edited = new Map(entries);
        edited.set(
          'main-products.csv',
          csv(MAIN_HEADERS, [
            // T and B swap; K takes S's name, which S lets go for a new one.
            ['Swisware+', 'T', 'BASIN', 1],
            ['Swisware+', 'B', 'TOILET', 2],
            ['Swisware+', 'K', 'SEAT', 3],
            ['Swisware+', 'S', 'SEAT COVER', 4],
            ['Swisware+', 'P', 'PAN', 5],
          ]),
        );
        const file = await zipOf(edited);
        const renamed = ['S', 'K'];
        const clashes = [
          ['T', 'error.conflict.categoryNameTaken'],
          ['B', 'error.conflict.categoryNameTaken'],
        ];

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(preview.mainProducts.renamed.map((main) => main.code)).toEqual(renamed);
        expect(preview.problems.map((problem) => [problem.subject, problem.messageKey])).toEqual(
          clashes,
        );
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.mainProducts.renamed.map((main) => main.code)).toEqual(renamed);
        expect(done.problems.map((problem) => [problem.subject, problem.messageKey])).toEqual(
          clashes,
        );
        expect((await mains()).map((main) => [main.code, main.name])).toEqual([
          ['T', 'TOILET'],
          ['B', 'BASIN'],
          ['K', 'SEAT'],
          ['S', 'SEAT COVER'],
          ['P', 'PAN'],
        ]);
      });

      it('brings a main product the file names back from the Recycle Bin, not a twin beside it, for a person who may delete', async () => {
        const kept = await catalog.createCategory(
          { name: 'TOILET', code: 'T', brand: 'Swisware+', sortOrder: 1 },
          admin,
        );
        await sub(kept.id, '101', 'T-1');
        const binned = await catalog.createCategory(
          { name: 'URINAL', code: 'UR', brand: 'Swisware+', sortOrder: 5 },
          admin,
        );
        const { file } = await exported();
        await catalog.deleteCategory(binned.id, admin);
        const back = [{ code: 'UR', name: 'URINAL', brand: 'Swisware+' }];

        const limited = await actorWith([
          'products.view',
          'products.bulk',
          'products.create',
          'products.edit',
        ]);
        const refused = await previewProductZip(file, 'p.zip', limited);
        expect(refused.mainProducts).toEqual({ added: [], renamed: [] });
        expect(refused.problems).toEqual([
          {
            subject: 'UR',
            messageKey: 'validation.import.binnedNeedsDelete',
            params: { name: 'URINAL' },
          },
        ]);

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(preview.mainProducts).toEqual({ added: [], renamed: [], restoredFromBin: back });
        expect(preview.problems).toEqual([]);
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.mainProducts).toEqual({ added: [], renamed: [], restoredFromBin: back });
        expect(
          await db()('product_categories').where({ code: 'UR' }).select('id', 'deleted_at'),
        ).toEqual([{ id: binned.id, deleted_at: null }]);
      });
    });

    describe('the colour and brand lists', () => {
      async function lists(): Promise<void> {
        const white = await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz White', label: 'Pure White', hex: '#ffffff' },
          admin,
        );
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Retired', label: 'Zz Retired', hex: '#123456' },
          admin,
        );
        const ivory = await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Ivory', label: 'Zz Ivory', hex: null },
          admin,
        );
        await fields.reorderValues(
          {
            listKey: 'stock.colour',
            ids: [
              ...(await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour'))
                .filter((option) => option.id !== white.id && option.id !== ivory.id)
                .map((option) => option.id),
              ivory.id,
              white.id,
            ],
          },
          admin,
        );
        await switchOff('stock.colour', 'Zz Retired');

        const zeta = await fields.createValue(
          { listKey: 'product.brand', value: 'Zeta', label: 'Zeta Ceramics', hex: null },
          admin,
        );
        const alpha = await fields.createValue(
          { listKey: 'product.brand', value: 'Alpha', label: 'Alpha', hex: null },
          admin,
        );
        await fields.createValue(
          { listKey: 'product.brand', value: 'Unused Brand', label: 'Unused Brand', hex: null },
          admin,
        );
        await fields.createValue(
          { listKey: 'product.brand', value: 'Old Brand', label: 'Old Brand', hex: null },
          admin,
        );
        await fields.reorderValues(
          {
            listKey: 'product.brand',
            ids: [
              zeta.id,
              alpha.id,
              ...(await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand'))
                .filter((option) => option.id !== zeta.id && option.id !== alpha.id)
                .map((option) => option.id),
            ],
          },
          admin,
        );
        const a = await catalog.createCategory(
          { name: 'A', code: 'A', brand: 'Alpha', sortOrder: 1 },
          admin,
        );
        const old = await catalog.createCategory(
          { name: 'O', code: 'O', brand: 'Old Brand', sortOrder: 2 },
          admin,
        );
        await sub(a.id, 'S', 'A-1');
        await sub(old.id, 'S', 'O-1');
        await switchOff('product.brand', 'Old Brand');
      }

      it('come back whole into an emptied catalogue: labels, hex, switched off ones, unused ones, order', async () => {
        await lists();
        const before = { colours: await list('stock.colour'), brands: await list('product.brand') };
        const { file, entries } = await exported();
        expect(
          (await readSheetRows(entries.get('colours.csv')!)).filter((row) =>
            row[0]?.startsWith('Zz '),
          ),
        ).toEqual([
          ['Zz Retired', 'Zz Retired', '#123456', 'no'],
          ['Zz Ivory', 'Zz Ivory', '', 'yes'],
          ['Zz White', 'Pure White', '#ffffff', 'yes'],
        ]);
        expect((await readSheetRows(entries.get('brands.csv')!)).slice(0, 3)).toEqual([
          ['Brand', 'Label', 'Active'],
          ['Zeta', 'Zeta Ceramics', 'yes'],
          ['Alpha', 'Alpha', 'yes'],
        ]);
        const unedited = await previewProductZip(file, 'p.zip', admin);
        expect({ colours: unedited.colours, brands: unedited.brands }).toEqual({
          colours: { added: [], changed: [] },
          brands: { added: [], changed: [] },
        });

        await resetData();
        customFieldRepo.invalidateFieldCache();
        admin = await testActor();
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.problems).toEqual([]);
        expect({
          colours: await list('stock.colour'),
          brands: await list('product.brand'),
        }).toEqual(before);
      });

      it("are the truth for each value the file lists: label, hex, Active and order, the list's own spelling kept", async () => {
        await lists();
        const { entries } = await exported();
        const [colourHeader, ...colourRows] = await readSheetRows(entries.get('colours.csv')!);
        const edited = new Map(entries);
        edited.set(
          'colours.csv',
          csv(colourHeader!, [
            ['ZZ WHITE', 'Snow', '#FAFAFA', 'no'],
            ...colourRows.filter((row) => row[0] !== 'Zz White'),
            ['Zz New', 'Brand New', '#abcdef', 'no'],
          ]),
        );
        edited.set(
          'brands.csv',
          csv(
            ['Brand', 'Label', 'Active'],
            [
              ['Alpha', 'Alpha Ware', 'yes'],
              ['Zeta', 'Zeta Ceramics', 'yes'],
            ],
          ),
        );
        const file = await zipOf(edited);
        const expected = {
          colours: {
            added: ['Zz New'],
            changed: [
              { column: 'Zz White — Label', from: 'Pure White', to: 'Snow' },
              { column: 'Zz White — Hex', from: '#ffffff', to: '#FAFAFA' },
              { column: 'Zz White — Active', from: 'yes', to: 'no' },
            ],
            reordered: true,
          },
          brands: {
            added: [],
            changed: [{ column: 'Alpha — Label', from: 'Alpha', to: 'Alpha Ware' }],
            reordered: true,
          },
        };

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect({ colours: preview.colours, brands: preview.brands }).toEqual(expected);
        await expect(
          previewProductZip(
            file,
            'p.zip',
            await actorWith(['products.view', 'products.bulk', 'products.create', 'products.edit']),
          ),
        ).rejects.toBeInstanceOf(ForbiddenError);
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect({ colours: done.colours, brands: done.brands }).toEqual(expected);

        const colours = await list('stock.colour');
        expect(colours[0]).toEqual(['Zz White', 'Snow', '#FAFAFA', false]);
        expect(
          colours.filter(([value]) => String(value).toLowerCase() === 'zz white'),
        ).toHaveLength(1);
        expect(colours.at(-1)).toEqual(['Zz New', 'Brand New', '#abcdef', false]);
        expect((await list('product.brand')).slice(0, 2)).toEqual([
          ['Alpha', 'Alpha Ware', null, true],
          ['Zeta', 'Zeta Ceramics', null, true],
        ]);
        const again = await previewProductZip(file, 'p.zip', admin);
        expect({ colours: again.colours, brands: again.brands }).toEqual({
          colours: { added: [], changed: [] },
          brands: { added: [], changed: [] },
        });
      });

      it('reads a colours.csv of only Colour and Hex as it always did', async () => {
        await lists();
        const { entries } = await exported();
        const edited = new Map(entries);
        edited.delete('brands.csv');
        edited.set(
          'colours.csv',
          csv(
            ['Colour', 'Hex'],
            [
              ['Zz Retired', '#654321'],
              ['Zz White', ''],
            ],
          ),
        );
        const file = await zipOf(edited);
        const expected = {
          added: [],
          changed: [
            { column: 'Zz Retired — Hex', from: '#123456', to: '#654321' },
            { column: 'Zz Retired — Active', from: 'no', to: 'yes' },
          ],
        };

        expect((await previewProductZip(file, 'p.zip', admin)).colours).toEqual(expected);
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.colours).toEqual(expected);
        expect(done.brands).toEqual({ added: [], changed: [] });
        const colours = await list('stock.colour');
        expect(colours.filter(([value]) => String(value).startsWith('Zz '))).toEqual([
          ['Zz Retired', 'Zz Retired', '#654321', true],
          ['Zz Ivory', 'Zz Ivory', null, true],
          ['Zz White', 'Pure White', '#ffffff', true],
        ]);
      });
    });
  },
);
