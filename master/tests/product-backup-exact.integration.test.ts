/**
 * "Make the catalogue exactly this file" (`exactCatalogue`, in
 * `services/product-zip.service.ts`) against PostgreSQL and the real SWISWARE
 * catalogue: the owner's backup restored onto a new install, after its first
 * boot loaded and photographed the shipped catalogue, exports exactly as his
 * own did and leaves nothing shipped beside it; the preview lists everything
 * the run takes out; and the import's own lists reach the report.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProductZipReport } from '@orderbook/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { toCsv } from '../src/lib/csv.js';
import { ForbiddenError } from '../src/lib/errors.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as customFieldRepo from '../src/repositories/custom-field.repository.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as settingsRepo from '../src/repositories/settings.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import {
  attachCataloguePhotos,
  CATALOGUE_PHOTOS_MARKER,
} from '../src/services/catalogue-photos.service.js';
import { seedCatalogue } from '../src/services/catalogue-seed.service.js';
import * as fields from '../src/services/fields.service.js';
import * as imageService from '../src/services/image.service.js';
import {
  exportProductZip,
  loadShippedCatalogue,
  previewProductZip,
  restoreProductZip,
  SHIPPED_CATALOGUE_MARKER,
} from '../src/services/product-zip.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

const FIXTURES = path.join(__dirname, 'fixtures');
const noZip = path.join(os.tmpdir(), 'orderbook-no-such-catalogue.zip');
/** The shipped photos `<code>.jpg` this build carries, here a few. */
const SHIPPED_PHOTOS = ['OPT-0001', 'OPT-0002', 'OPT-0004', 'WB-0001', 'MER-0001'];
const WHOLE = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };
const CATALOGUE_TABLES = [
  'product_categories',
  'products',
  'product_variants',
  'product_images',
  'option_lists',
];

let admin: ActorContext;
let dir: string;
let shipped: string;
let tenantImagesDir: string;

const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } })
    .jpeg()
    .toBuffer();

const csv = (header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string>>): Buffer =>
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

/** The export's products.csv (or `name`) with its rows passed through `edit`. */
async function editRows(
  entries: Map<string, Buffer>,
  edit: (rows: string[][], at: (column: string) => number) => string[][],
  name = 'products.csv',
): Promise<string> {
  const [header, ...body] = await readSheetRows(entries.get(name)!);
  const edited = new Map(entries);
  edited.set(
    name,
    csv(
      header!,
      edit(body, (column) => header!.indexOf(column)),
    ),
  );
  return zipOf(edited);
}

async function productByCode(code: string) {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === code));
}

async function addPhoto(code: string, background: string, caption?: string): Promise<void> {
  await imageService.uploadImage(
    {
      productId: (await productByCode(code))!.id,
      fileBuffer: await jpeg(background),
      crop: { ...WHOLE, caption },
      wholeFrame: true,
    },
    admin,
  );
}

const liveCodes = async () =>
  (await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 })).items
    .flatMap((product) =>
      product.variants.filter((variant) => variant.isActive).map((variant) => variant.code),
    )
    .sort();

const marker = async (key: string) =>
  (await db()('settings').where({ key }).first())?.value as Record<string, unknown> | undefined;

/** Every row of the catalogue's tables, to show a run wrote nothing. */
async function dump(): Promise<Record<string, string[]>> {
  const rows: Record<string, string[]> = {};
  for (const table of CATALOGUE_TABLES) {
    const { rows: json } = await db().raw<{ rows: Array<{ j: string }> }>(
      'SELECT row_to_json(t)::text AS j FROM ?? t ORDER BY 1',
      [table],
    );
    rows[table] = json.map((row) => row.j);
  }
  return rows;
}

/** A new install of this build: its first boot loads and photographs the shipped catalogue, then setup. */
async function freshInstall(): Promise<void> {
  await resetData();
  customFieldRepo.invalidateFieldCache();
  expect(await loadShippedCatalogue({ zip: noZip })).toBe('markdown');
  expect(await attachCataloguePhotos(shipped)).toMatchObject({
    attached: SHIPPED_PHOTOS.length,
    failed: 0,
  });
  await setUpFirstRun('Owner Ceramics');
  admin = await testActor();
}

/**
 * The owner's catalogue, as his install made it: the shipped catalogue and its
 * photos, then his own brand, main products, sub products of every colour
 * rule, weights, aliases, sizes, colours, captions and order, a shipped main
 * product and sub product deleted, and a main product code changed.
 */
async function ownerCatalogue(): Promise<void> {
  await resetData();
  customFieldRepo.invalidateFieldCache();
  await setUpFirstRun('Owner Ceramics');
  admin = await testActor();
  await seedCatalogue({ actor: admin });
  expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: SHIPPED_PHOTOS.length });

  // His brand on every main product, one he has not used yet, and the shipped one deleted.
  await fields.createValue(
    { listKey: 'product.brand', value: 'Owner Ceramics', label: 'Owner Ceramics Ltd', hex: null },
    admin,
  );
  await fields.createValue(
    { listKey: 'product.brand', value: 'Owner Studio', label: 'Owner Studio', hex: null },
    admin,
  );
  const mains = await productRepo.listCategories(admin.tenantId);
  for (const main of mains)
    await catalog.updateCategory(main.id, { brand: 'Owner Ceramics' }, admin);
  const swisware = (await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand')).find(
    (option) => option.value === 'Swisware+',
  )!;
  await fields.deleteValue(swisware.id, admin);

  // A main product recoded, one renamed, one put first; Merchandise and OPT-0003 deleted.
  const byCode = (code: string) => mains.find((main) => main.code === code)!;
  await catalog.updateCategory(byCode('OPT').id, { code: 'TOI' }, admin);
  await catalog.updateCategory(byCode('WB').id, { name: 'Wash Basins' }, admin);
  await catalog.updateCategory(mains[5]!.id, { sortOrder: 0 }, admin);
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  for (const product of items.filter((item) => item.categoryId === byCode('MER').id)) {
    await catalog.deleteProduct(product.id, admin);
  }
  await catalog.deleteCategory(byCode('MER').id, admin);
  await catalog.deleteProduct((await productByCode('OPT-0003'))!.id, admin);
  // OPT-0005 first in its main product; a weight and an alias on shipped ones.
  await db()('products')
    .where({ id: (await productByCode('OPT-0005'))!.id })
    .update({ sort_order: 0 });
  await db()('product_variants').where({ code: 'OPT-0001' }).update({ weight_kg: 12.5 });
  await db()('products')
    .where({ id: (await productByCode('OPT-0002'))!.id })
    .update({ alias: 'Best seller' });

  // His colours: one relabelled with another hex, one switched off, one deleted, his own first.
  const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
  await fields.updateValue(
    colours[0]!.id,
    { label: 'Snow', hex: '#fafafa', expectedVersion: colours[0]!.version },
    admin,
  );
  await fields.updateValue(
    colours[1]!.id,
    { isActive: false, expectedVersion: colours[1]!.version },
    admin,
  );
  await fields.deleteValue(colours.at(-1)!.id, admin);
  const teal = await fields.createValue(
    { listKey: 'stock.colour', value: 'Owner Teal', label: 'Teal', hex: '#00897b' },
    admin,
  );
  await fields.reorderValues(
    {
      listKey: 'stock.colour',
      ids: [
        teal.id,
        ...(await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour'))
          .filter((option) => option.id !== teal.id)
          .map((option) => option.id),
      ],
    },
    admin,
  );

  // His own main products: one with no sub product, one with a sub product of each colour rule.
  await catalog.createCategory({ name: 'Own Range', code: 'OWN', brand: 'Owner Ceramics' }, admin);
  await catalog.createCategory(
    { name: 'Own Basins', code: 'OBS', brand: 'Owner Ceramics', sortOrder: 2 },
    admin,
  );
  const own = (input: Record<string, unknown>) =>
    catalog.createProduct({ categoryCode: 'OBS', ...input } as never, admin);
  await own({
    name: 'Solo',
    alias: 'Solo alias',
    size: '20x20',
    hasVariants: true,
    variants: [{ code: 'OBS-0001', label: 'Owner Teal', weightKg: 2.5 }],
  });
  await own({
    name: 'Duo',
    hasVariants: true,
    variants: [
      { code: 'OBS-0002', label: colours[2]!.value, weightKg: 3 },
      { code: 'OBS-0003', label: colours[3]!.value },
    ],
  });
  await own({
    name: 'Plain',
    size: '10x10',
    hasVariants: false,
    variants: [{ code: 'OBS-0004', label: null, weightKg: 1.25 }],
  });
  await own({
    name: 'Rainbow',
    hasVariants: false,
    multiColour: true,
    variants: [{ code: 'OBS-0005', label: null }],
  });

  // Photos: a shipped one captioned, one removed, one replaced, a second one, his own captioned.
  const opt1 = (await productByCode('OPT-0001'))!;
  await imageService.updateImageCaption(opt1.images[0]!.id, { caption: 'Front' }, admin);
  await imageService.deleteImage((await productByCode('OPT-0002'))!.images[0]!.id, admin);
  await imageService.deleteImage((await productByCode('OPT-0004'))!.images[0]!.id, admin);
  await addPhoto('OPT-0004', '#123456');
  await addPhoto('WB-0001', '#345678', 'Side');
  await addPhoto('OBS-0001', '#00897b', 'Teal glaze');
  await addPhoto('OBS-0003', '#eeeeee', colours[3]!.value);
}

describe.skipIf(!canRunIntegrationTests)(
  'the catalogue made exactly the file (integration)',
  () => {
    beforeAll(async () => {
      await setupDatabase();
      tenantImagesDir = path.join(config.imagesDir, await testTenantId());
      shipped = await mkdtemp(path.join(os.tmpdir(), 'product-backup-exact-shipped-'));
      for (const [index, code] of SHIPPED_PHOTOS.entries()) {
        await writeFile(
          path.join(shipped, `${code}.jpg`),
          await jpeg(`#${(index * 40 + 30).toString(16).padStart(2, '0')}4080`),
        );
      }
    }, 120_000);
    afterAll(async () => {
      await rm(tenantImagesDir, { recursive: true, force: true });
      await rm(shipped, { recursive: true, force: true });
      if (dir) await rm(dir, { recursive: true, force: true });
      await teardownDatabase();
    });
    beforeEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(path.join(os.tmpdir(), 'product-backup-exact-'));
    });

    describe('onto a new install', () => {
      it("D2, E13, B7: the owner's zip comes back exactly, with nothing shipped left beside it, and again changes nothing", async () => {
        await ownerCatalogue();
        const owner = await exported();

        await freshInstall();
        const preview = await previewProductZip(owner.file, 'owner.zip', admin);
        // Everything the run takes out is listed first: what neither file names, and the shipped photo he removed.
        expect(preview.mainProducts.notInFile?.map((main) => main.code).sort()).toEqual([
          'MER',
          'OPT',
        ]);
        expect(preview.rows.notInFile.map((row) => row.code).sort()).toEqual(
          ['OPT-0003', ...Array.from({ length: 7 }, (_, n) => `MER-000${n + 1}`)].sort(),
        );
        expect(preview.brands?.notInFile).toEqual(['Swisware+']);
        expect(preview.colours.notInFile).toHaveLength(1);
        expect(preview.photos.notInZip).toEqual(['OPT-0002']);
        expect(preview.problems).toEqual([]);

        const done = await restoreProductZip(
          owner.file,
          'owner.zip',
          { exactCatalogue: true },
          admin,
        );
        expect(done.problems).toEqual([]);
        expect(done.products.failed).toBe(0);
        expect({
          binned: done.binned,
          photosRemoved: done.photosRemoved,
          removed: done.exactRemoved,
        }).toEqual({
          binned: 8,
          photosRemoved: 1,
          removed: { mainProducts: 2, colours: 1, brands: 1 },
        });

        const after = await exported();
        for (const file of [
          'products.csv',
          'main-products.csv',
          'colours.csv',
          'brands.csv',
          'photos.csv',
        ]) {
          expect({ file, text: after.entries.get(file)!.toString('utf8') }).toEqual({
            file,
            text: owner.entries.get(file)!.toString('utf8'),
          });
        }
        const images = (entries: Map<string, Buffer>) =>
          [...entries]
            .filter(([name]) => name.startsWith('images/'))
            .sort(([a], [b]) => a.localeCompare(b));
        expect(images(after.entries).map(([name]) => name)).toEqual(
          images(owner.entries).map(([name]) => name),
        );
        for (const [name, bytes] of images(owner.entries))
          expect(after.entries.get(name)!.equals(bytes), name).toBe(true);

        // The same zip again: nothing to do, and nothing written.
        const before = await dump();
        const again = await restoreProductZip(
          owner.file,
          'owner.zip',
          { exactCatalogue: true },
          admin,
        );
        expect(await dump()).toEqual(before);
        expect({
          created: again.products.created,
          updated: again.products.updated,
          binned: again.binned,
          photosRemoved: again.photosRemoved,
          removed: again.exactRemoved,
          photos: [...again.photos.added, ...again.photos.replaced],
        }).toEqual({
          created: 0,
          updated: 0,
          binned: 0,
          photosRemoved: 0,
          removed: { mainProducts: 0, colours: 0, brands: 0 },
          photos: [],
        });
      }, 600_000);

      it('leaves only the main and sub products of a bare products sheet 1.2.4-1.4.6 saved, and the colours and photos as they are', async () => {
        await freshInstall();
        const sheet = path.join(dir, 'products-2026-10-07.csv');
        await writeFile(sheet, await readFile(path.join(FIXTURES, 'products-export-1.2.5.csv')));
        const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
        const photoIds = async () =>
          (await db()('product_images').select('id').orderBy('id')).map((row) => row.id as string);
        const photosBefore = await photoIds();
        expect(photosBefore.length).toBeGreaterThan(0);

        const preview = await previewProductZip(sheet, 'products-2026-10-07.csv', admin);
        expect(preview.colours).toEqual({ added: [], changed: [], noFile: true });
        // A sheet carries no photo, so none is missing from it: the opt-ins take none out.
        expect(preview.photos).toMatchObject({ noFile: true, notInZip: [] });
        const done = await restoreProductZip(
          sheet,
          'products-2026-10-07.csv',
          { exactCatalogue: true },
          admin,
        );
        expect(done.problems).toEqual([]);
        expect(done.mainProducts.notInFile).toEqual(preview.mainProducts.notInFile);

        expect(
          (await productRepo.listCategories(admin.tenantId)).map((main) => main.code).sort(),
        ).toEqual(['OPB', 'OPT', 'TNK', 'WB']);
        expect(await liveCodes()).toEqual([
          'OPB-0001',
          'OPT-0001',
          'OPT-0002',
          'TNK-0001',
          'WB-0001',
          'WB-0002',
        ]);
        expect(await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).toEqual(
          colours,
        );
        expect(done.photosRemoved).toBe(0);
        expect(await photoIds()).toEqual(photosBefore);
      }, 300_000);
    });

    describe('the run, the preview and the report', () => {
      beforeEach(async () => {
        await resetData();
        customFieldRepo.invalidateFieldCache();
        admin = await testActor();
        await catalog.createCategory({ name: 'Basins', code: 'BAS' }, admin);
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz White', label: 'Zz White', hex: null },
          admin,
        );
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Ivory', label: 'Zz Ivory', hex: null },
          admin,
        );
        const sub = (input: Record<string, unknown>) =>
          catalog.createProduct({ categoryCode: 'BAS', ...input } as never, admin);
        await sub({
          name: 'Duo',
          hasVariants: true,
          variants: [
            { code: 'BAS-0001', label: 'Zz White' },
            { code: 'BAS-0002', label: 'Zz Ivory' },
          ],
        });
        await sub({
          name: 'Solo',
          hasVariants: false,
          variants: [{ code: 'BAS-0003', label: null }],
        });
        await sub({
          name: 'Third',
          hasVariants: false,
          variants: [{ code: 'BAS-0004', label: null }],
        });
      });

      it('E6: lists the codes of a sub product its rows leave out, keeps them, and removes them with the exact catalogue', async () => {
        const { entries } = await exported();
        const file = await editRows(entries, (rows, at) =>
          rows.filter((row) => row[at('Code')] !== 'BAS-0002'),
        );
        const listed = [{ code: 'BAS-0002', name: 'Duo' }];

        expect((await previewProductZip(file, 'p.zip', admin)).rows.variantsNotInFile).toEqual(
          listed,
        );
        expect((await restoreProductZip(file, 'p.zip', {}, admin)).rows.variantsNotInFile).toEqual(
          listed,
        );
        expect(await liveCodes()).toContain('BAS-0002');

        expect(
          (await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, admin)).rows
            .variantsNotInFile,
        ).toEqual(listed);
        expect(await liveCodes()).not.toContain('BAS-0002');
      });

      it('keeps the codes its rows leave out of a sub product read by its name under another code, unless the catalogue is made exactly the file', async () => {
        const { entries } = await exported();
        // Another install's numbering of Duo, White only.
        const file = await editRows(entries, (rows, at) =>
          rows
            .filter((row) => row[at('Code')] !== 'BAS-0002')
            .map((row) =>
              row.map((value, index) =>
                index === at('Code') && value === 'BAS-0001' ? 'XYZ-0001' : value,
              ),
            ),
        );
        const listed = [{ code: 'BAS-0002', name: 'Duo' }];
        const duo = async () =>
          (await productByCode('XYZ-0001'))!.variants
            .filter((variant) => variant.isActive)
            .map((variant) => [variant.code, variant.label]);

        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.rows.variantsNotInFile).toEqual(listed);
        expect(await duo()).toEqual([
          ['XYZ-0001', 'Zz White'],
          ['BAS-0002', 'Zz Ivory'],
        ]);

        await resetData();
        customFieldRepo.invalidateFieldCache();
        admin = await testActor();
        await restoreProductZip(await zipOf(entries), 'p.zip', {}, admin);
        const exact =await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, admin);
        expect(exact.rows.variantsNotInFile).toEqual(listed);
        expect(await duo()).toEqual([['XYZ-0001', 'Zz White']]);
      });

      it('lists a sub product back from the Recycle Bin and a main product put in the order of the file, and counts that order alone as a change', async () => {
        const { entries } = await exported();
        await catalog.deleteProduct((await productByCode('BAS-0004'))!.id, admin);
        const back = await previewProductZip(await zipOf(entries), 'p.zip', admin);
        expect(back.rows.restoredFromBin).toEqual([
          { code: 'BAS-0004', name: 'Third', fields: [] },
        ]);
        expect(back.products.updated).toBe(1);
        await restoreProductZip(await zipOf(entries), 'p.zip', {}, admin);

        // Solo before Duo, nothing else.
        const file = await editRows(entries, (rows, at) => [
          ...rows.filter((row) => row[at('Code')] === 'BAS-0003'),
          ...rows.filter((row) => row[at('Code')] !== 'BAS-0003'),
        ]);
        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(preview.rows.reordered).toEqual([{ code: 'BAS', name: 'Basins' }]);
        expect({ created: preview.products.created, updated: preview.products.updated }).toEqual({
          created: 0,
          updated: 0,
        });

        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(done.rows.reordered).toEqual([{ code: 'BAS', name: 'Basins' }]);
        const logged = await db()('activity_log')
          .where({ entity_type: 'catalog', action: 'imported' })
          .orderBy('created_at', 'desc')
          .first();
        expect(logged?.details).toMatchObject({ subProductsReordered: 1, subProductsRestored: 0 });
        const [header, first] = await readSheetRows(
          (await exported()).entries.get('products.csv')!,
        );
        expect(first?.[header!.indexOf('Code')]).toBe('BAS-0003');
      });

      it('a preview lists as missing no sub product a row reads by its name under another code, as the run does not', async () => {
        const { entries } = await exported();
        const file = await editRows(entries, (rows, at) =>
          rows.map((row) =>
            row[at('Code')] === 'BAS-0003'
              ? row.map((value, index) => (index === at('Code') ? 'BAS-0099' : value))
              : row,
          ),
        );

        const preview = await previewProductZip(file, 'p.zip', admin);
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(preview.rows.notInFile).toEqual([]);
        expect(done.rows.notInFile).toEqual([]);
        expect(await liveCodes()).toContain('BAS-0099');
      });

      it('B8: previews a photo of a colour the same zip adds to a sub product there, as the run adds it', async () => {
        await addPhoto('BAS-0001', '#aa0000', 'Zz White');
        const { entries } = await exported();
        const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
        const at = (column: string) => header!.indexOf(column);
        const duo = body.find((row) => row[at('Code')] === 'BAS-0001')!;
        const edited = new Map(entries);
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Grey', label: 'Zz Grey', hex: null },
          admin,
        );
        edited.set(
          'products.csv',
          csv(header!, [
            ...body,
            duo.map((value, index) =>
              index === at('Code') ? 'BAS-0005' : index === at('Colour') ? 'Zz Grey' : value,
            ),
          ]),
        );
        edited.set('images/BAS-0005_2.jpg', await jpeg('#777777'));
        const file = await zipOf(edited);

        const preview = await previewProductZip(file, 'p.zip', admin);
        const done = await restoreProductZip(file, 'p.zip', {}, admin);
        expect(preview.photos.added).toEqual(['BAS-0005_2.jpg']);
        expect({ added: preview.photos.added, unmatched: preview.photos.unmatched }).toEqual({
          added: done.photos.added,
          unmatched: done.photos.unmatched,
        });
        expect((await productByCode('BAS-0005'))!.images).toHaveLength(2);
      });

      it('plans the photos of a code it removes as the preview did: one the zip still holds is kept or replaced, never removed', async () => {
        await addPhoto('BAS-0001', '#aa0000', 'Zz White');
        await addPhoto('BAS-0001', '#00aa00', 'Zz Ivory');
        await addPhoto('BAS-0001', '#0000aa', 'Zz Ivory');
        const { entries } = await exported();
        expect([...entries.keys()].filter((name) => name.startsWith('images/BAS-0002'))).toEqual([
          'images/BAS-0002_2.webp',
          'images/BAS-0002_3.webp',
        ]);
        // The Ivory row left out, its photos kept, the second of them changed.
        const edited = new Map(entries);
        edited.delete('images/BAS-0002_3.webp');
        edited.set('images/BAS-0002_3.jpg', await jpeg('#ffff00'));
        const file = await editRows(edited, (rows, at) =>
          rows.filter((row) => row[at('Code')] !== 'BAS-0002'),
        );
        const photosOf = ({ photos }: ProductZipReport) => ({
          added: photos.added,
          replaced: photos.replaced,
          unchanged: photos.unchanged,
          unmatched: photos.unmatched,
          notInZip: photos.notInZip,
        });

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect(photosOf(preview)).toEqual({
          added: [],
          replaced: ['BAS-0002_3.jpg'],
          unchanged: 2,
          unmatched: [],
          notInZip: [],
        });
        const done = await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, admin);
        expect(photosOf(done)).toEqual(photosOf(preview));
        expect(done.photosRemoved).toBe(0);
        expect(await liveCodes()).not.toContain('BAS-0002');
        expect((await productByCode('BAS-0001'))!.images).toHaveLength(3);
      });

      it('takes out a main product neither file names, and a colour or brand the files do not list, only when asked', async () => {
        await catalog.createCategory({ name: 'Spare', code: 'SPR' }, admin);
        const { entries } = await exported();
        await catalog.createCategory({ name: 'Later', code: 'LAT' }, admin);
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Later', label: 'Zz Later', hex: null },
          admin,
        );
        await fields.createValue(
          { listKey: 'product.brand', value: 'Later Brand', label: 'Later Brand', hex: null },
          admin,
        );
        const file = await zipOf(entries);

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect({
          mains: preview.mainProducts.notInFile,
          colours: preview.colours.notInFile,
          brands: preview.brands?.notInFile,
        }).toEqual({
          mains: [{ code: 'LAT', name: 'Later', brand: null }],
          colours: ['Zz Later'],
          brands: ['Later Brand'],
        });
        await restoreProductZip(file, 'p.zip', {}, admin);
        expect(
          (await productRepo.listCategories(admin.tenantId)).map((main) => main.code),
        ).toContain('LAT');

        const done = await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, admin);
        expect(done.exactRemoved).toEqual({ mainProducts: 1, colours: 1, brands: 1 });
        // Spare has no sub product, and the file lists it: it stays.
        expect(
          (await productRepo.listCategories(admin.tenantId)).map((main) => main.code).sort(),
        ).toEqual(['BAS', 'SPR']);
        const binnedColour = (
          await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour', {
            includeDeleted: true,
          })
        ).find((option) => option.value === 'Zz Later');
        expect(binnedColour?.deletedAt).not.toBeNull();
        expect(
          (await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand')).map(
            (option) => option.value,
          ),
        ).not.toContain('Later Brand');
        expect(await previewProductZip(file, 'p.zip', admin)).toMatchObject({
          mainProducts: { added: [], renamed: [] },
          colours: { added: [], changed: [] },
          brands: { added: [], changed: [] },
        });
      });

      it('keeps a main product main-products.csv lists by its code with no name, and says that row was not read', async () => {
        await catalog.createCategory({ name: 'Spare', code: 'SPR' }, admin);
        const { entries } = await exported();
        const file = await editRows(
          entries,
          (rows, at) =>
            rows.map((row) =>
              row[at('Main product code')] === 'SPR'
                ? row.map((value, index) => (index === at('Main product') ? '' : value))
                : row,
            ),
          'main-products.csv',
        );

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect({ gone: preview.mainProducts.notInFile, problems: preview.problems }).toEqual({
          gone: undefined,
          problems: [{ subject: 'SPR', messageKey: 'validation.category.nameRequired' }],
        });
        const done = await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, admin);
        expect(done.exactRemoved?.mainProducts).toBe(0);
        expect(
          (await productRepo.listCategories(admin.tenantId)).map((main) => main.code).sort(),
        ).toEqual(['BAS', 'SPR']);
      });

      it('reads a colours.csv or brands.csv with no value column as no file, and says so', async () => {
        const { entries } = await exported();
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Later', label: 'Zz Later', hex: null },
          admin,
        );
        const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
        const edited = new Map(entries);
        edited.set('colours.csv', csv(['Name', 'Hex'], [['Zz White', '']]));
        edited.set('brands.csv', csv(['Name'], [['Nobody']]));
        const file = await zipOf(edited);

        const preview = await previewProductZip(file, 'p.zip', admin);
        expect({ problems: preview.problems, colours: preview.colours }).toEqual({
          problems: [
            {
              subject: 'colours.csv',
              messageKey: 'validation.import.missingColumn',
              params: { column: 'Colour' },
            },
            {
              subject: 'brands.csv',
              messageKey: 'validation.import.missingColumn',
              params: { column: 'Brand' },
            },
          ],
          colours: { added: [], changed: [], noFile: true },
        });
        await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, admin);
        expect(await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).toEqual(
          colours,
        );
      });

      it('switches a colour off for a person who may not delete one, and asks for each permission before anything is written', async () => {
        const { entries } = await exported();
        await fields.createValue(
          { listKey: 'stock.colour', value: 'Zz Later', label: 'Zz Later', hex: null },
          admin,
        );
        const file = await editRows(entries, (rows, at) =>
          rows.map((row) =>
            row[at('Code')] === 'BAS-0003'
              ? row.map((value, index) => (index === at('Size') ? '9x9' : value))
              : row,
          ),
        );
        const keys = [
          'products.view',
          'products.bulk',
          'products.create',
          'products.edit',
        ] as const;

        await expect(
          restoreProductZip(file, 'p.zip', { exactCatalogue: true }, await actorWith([...keys])),
        ).rejects.toBeInstanceOf(ForbiddenError);
        // The lists' own permission, asked before the first write: nothing changed, the shipped photos
        // not retired. The preview says so first.
        const deleter = await actorWith([...keys, 'products.delete']);
        expect((await previewProductZip(file, 'p.zip', deleter)).exactNeedsLists).toBe(true);
        await expect(
          restoreProductZip(file, 'p.zip', { exactCatalogue: true }, deleter),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect((await productByCode('BAS-0003'))!.size).not.toBe('9x9');
        expect(await marker(CATALOGUE_PHOTOS_MARKER)).toBeUndefined();

        const lists = await actorWith([...keys, 'products.delete', 'catalog.lists.manage']);
        const seen = await previewProductZip(file, 'p.zip', lists);
        expect(seen.exactNeedsLists).toBeUndefined();
        expect(seen.colours).toEqual({
          added: [],
          changed: [],
          notInFile: ['Zz Later'],
          switchedOff: true,
        });
        await restoreProductZip(file, 'p.zip', { exactCatalogue: true }, lists);
        const colour = (
          await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')
        ).find((option) => option.value === 'Zz Later');
        expect(colour).toMatchObject({ isActive: false, deletedAt: null });
        expect((await productByCode('BAS-0003'))!.size).toBe('9x9');
      });

      it('a restore refused before its first write stops the shipped photos but leaves them to finish on the next boot', async () => {
        const shippedHere = path.join(dir, 'shipped');
        await mkdir(shippedHere);
        await writeFile(path.join(shippedHere, 'BAS-0003.jpg'), await jpeg('#00ff00'));
        // What a load of the printed catalogue records, for a catalogue made here.
        await db().transaction((trx) =>
          settingsRepo.upsertSetting(
            admin.tenantId,
            SHIPPED_CATALOGUE_MARKER,
            { state: 'done', loaded: 'markdown' },
            false,
            1,
            null,
            trx,
          ),
        );
        const notABackup = await zipOf([['notes.csv', Buffer.from('a,b\n1,2\n')]]);

        await expect(restoreProductZip(notABackup, 'notes.zip', {}, admin)).rejects.toMatchObject({
          messageKey: 'validation.productZip.noProductsCsv',
        });
        expect(await marker(CATALOGUE_PHOTOS_MARKER)).toBeUndefined();
        expect(await attachCataloguePhotos(shippedHere)).toMatchObject({ attached: 1 });
      });
    });
  },
);
