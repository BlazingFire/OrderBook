/**
 * The product backup zip (`services/product-zip.service.ts`) against
 * PostgreSQL and the real SWISWARE catalogue: what the export writes, what an
 * edited zip would do, that the real run does exactly that, that missing rows
 * and photos are only reported unless the person opts in, and that an emptied
 * catalogue comes back whole from one zip.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import sharp from 'sharp';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { IMPORT_HEADERS } from '../src/domain/product-import.js';
import { db } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { toCsv } from '../src/lib/csv.js';
import { ConflictError, ForbiddenError, ValidationError } from '../src/lib/errors.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as productRepo from '../src/repositories/product.repository.js';
import { startJob } from '../src/services/backup-job.js';
import { seedCatalogue } from '../src/services/catalogue-seed.service.js';
import * as imageService from '../src/services/image.service.js';
import {
  exportProductZip,
  isProductRestoreRunning,
  loadShippedCatalogue,
  previewProductZip,
  productRestoreJob,
  restoreProductZip,
  SHIPPED_CATALOGUE_MARKER,
  startProductRestore,
} from '../src/services/product-zip.service.js';
import * as roleService from '../src/services/role.service.js';
import * as userService from '../src/services/user.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

let admin: ActorContext;
let dir: string;
let tenantImagesDir: string;
const SUB_PRODUCTS = 549;

const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } })
    .jpeg()
    .toBuffer();

async function productByCode(code: string) {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === code))!;
}

async function addPhoto(code: string, background: string) {
  const product = await productByCode(code);
  await imageService.uploadImage(
    {
      productId: product.id,
      fileBuffer: await jpeg(background),
      crop: { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 },
      wholeFrame: true,
    },
    admin,
  );
}

/** Every entry of a zip, by name. */
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

/** A zip of these entries, stored, in this order. */
async function zipOf(entries: Iterable<[string, Buffer]>): Promise<string> {
  const file = path.join(dir, `${randomUUID()}.zip`);
  const writer = createZipWriter(file);
  for (const [name, bytes] of entries) await writer.appendEntry(name, [bytes], { store: true });
  await writer.finalize();
  return file;
}

/** The export, as a file in `dir` (the service's own copy goes, as the route deletes it). */
async function exported(): Promise<{ file: string; entries: Map<string, Buffer> }> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return { file, entries: await entriesOf(file) };
}

/** products.csv with one cell changed, by the row's code and the column's header. */
function editCell(rows: string[][], code: string, column: string, value: string): Buffer {
  const [header, ...body] = rows;
  const codeAt = header!.indexOf('Code');
  const at = header!.indexOf(column);
  const edited = body.map((row) =>
    row[codeAt] === code ? row.map((cell, index) => (index === at ? value : cell)) : row,
  );
  return Buffer.from('﻿' + toCsv(header!, edited), 'utf8');
}

function withoutRow(rows: string[][], code: string): Buffer {
  const [header, ...body] = rows;
  const codeAt = header!.indexOf('Code');
  return Buffer.from(
    '﻿' +
      toCsv(
        header!,
        body.filter((row) => row[codeAt] !== code),
      ),
    'utf8',
  );
}

describe.skipIf(!canRunIntegrationTests)('the product backup zip (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
  }, 120_000);
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    await seedCatalogue({ actor: admin });
    // OPT-0001 has two photos, OPT-0002 one.
    await addPhoto('OPT-0001', '#ff0000');
    await addPhoto('OPT-0001', '#00ff00');
    await addPhoto('OPT-0002', '#0000ff');
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'product-zip-'));
  }, 120_000);

  it('writes the CSVs, the README and every photo as its stored master.webp, named by code', async () => {
    const { filePath, fileName } = await exportProductZip(admin);
    expect(fileName).toMatch(/^OrderBook-Products-company-\d{4}-\d{2}-\d{2}\.zip$/);
    const entries = await entriesOf(filePath);
    await rm(filePath, { force: true });

    expect([...entries.keys()].sort()).toEqual(
      [
        'README.txt',
        'brands.csv',
        'colours.csv',
        'images/OPT-0001.webp',
        'images/OPT-0001_2.webp',
        'images/OPT-0002.webp',
        'main-products.csv',
        'photos.csv',
        'products.csv',
      ].sort(),
    );
    const products = entries.get('products.csv')!;
    expect(products.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const rows = await readSheetRows(products);
    expect(rows[0]).toEqual([...IMPORT_HEADERS]);
    expect(rows).toHaveLength(SUB_PRODUCTS + 1);
    expect((await readSheetRows(entries.get('main-products.csv')!))[0]).toEqual([
      'Brand',
      'Main product code',
      'Main product',
      'Order',
    ]);
    expect((await readSheetRows(entries.get('colours.csv')!))[0]).toEqual(['Colour', 'Label', 'Hex', 'Active']);
    expect((await readSheetRows(entries.get('brands.csv')!))[0]).toEqual(['Brand', 'Label', 'Active']);
    expect(entries.get('README.txt')!.toString('utf8')).toMatch(/10-12/);

    // The bytes are the stored file: its hash is the row's checksum.
    const opt1 = await productByCode('OPT-0001');
    const primary = opt1.images.find((image) => image.isPrimary)!;
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(entries.get('images/OPT-0001.webp')!).digest('hex')).toBe(
      primary.checksum,
    );
  });

  it('needs products.export to back up, and the bulk permissions to restore', async () => {
    await expect(exportProductZip(await actorWith(['products.view']))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const { file } = await exported();
    await expect(
      previewProductZip(
        file,
        'p.zip',
        await actorWith(['products.view', 'products.create', 'products.edit']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      restoreProductZip(
        file,
        'p.zip',
        { binMissingProducts: true },
        await actorWith(['products.bulk', 'products.create', 'products.edit']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reads an unedited export back as unchanged, every photo included by its hash', async () => {
    const { file } = await exported();
    const preview = await previewProductZip(file, 'p.zip', admin);

    expect(preview.products).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: SUB_PRODUCTS,
      failed: 0,
    });
    expect(preview.mainProducts).toEqual({ added: [], renamed: [] });
    expect(preview.rows).toEqual({ added: [], changed: [], notInFile: [] });
    expect(preview.colours).toEqual({ added: [], changed: [] });
    expect(preview.photos).toEqual({
      added: [],
      replaced: [],
      unchanged: 3,
      recaptioned: [],
      reordered: [],
      unmatched: [],
      duplicate: [],
      notImage: [],
      notInZip: [],
    });
    expect(preview.problems).toEqual([]);
  });

  it('finds one edited cell, one swapped photo and one added photo, and the run applies exactly that', async () => {
    const { entries } = await exported();
    const rows = await readSheetRows(entries.get('products.csv')!);
    const sizeBefore = (await productByCode('OPT-0003')).size;
    const edited = new Map(entries);
    edited.set('products.csv', editCell(rows, 'OPT-0003', 'Size', '99x99'));
    edited.delete('images/OPT-0002.webp');
    edited.set('images/OPT-0002.jpg', await jpeg('#ffff00'));
    edited.set('images/OPT-0001_3.jpg', await jpeg('#00ffff'));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.products).toMatchObject({ created: 0, updated: 1, unchanged: SUB_PRODUCTS - 1 });
    expect(preview.rows.changed).toEqual([
      {
        code: 'OPT-0003',
        name: expect.any(String),
        fields: [{ column: 'Size', from: sizeBefore ?? '', to: '99x99' }],
      },
    ]);
    expect(preview.photos).toMatchObject({
      added: ['OPT-0001_3.jpg'],
      replaced: ['OPT-0002.jpg'],
      unchanged: 2,
      notInZip: [],
    });

    const oldOpt2 = (await productByCode('OPT-0002')).images[0]!;
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(done.products).toMatchObject({ created: 0, updated: 1 });
    expect(done.photos).toMatchObject({ added: ['OPT-0001_3.jpg'], replaced: ['OPT-0002.jpg'] });
    expect(done.problems).toEqual([]);

    expect((await productByCode('OPT-0003')).size).toBe('99x99');
    const opt2 = (await productByCode('OPT-0002')).images;
    expect(opt2).toHaveLength(1);
    expect(opt2[0]!.id).not.toBe(oldOpt2.id);
    expect(opt2[0]!.isPrimary).toBe(true);
    expect((await productByCode('OPT-0001')).images).toHaveLength(3);

    // What it left is a catalogue whose next export reads back as unchanged.
    const again = await previewProductZip((await exported()).file, 'p.zip', admin);
    expect(again.products).toMatchObject({ updated: 0, unchanged: SUB_PRODUCTS });
    expect(again.photos).toMatchObject({ added: [], replaced: [], unchanged: 4, notInZip: [] });

    // One activity row for the restore (the seed wrote its own, under the catalogue file's name).
    const imported = await db()('activity_log')
      .where({ entity_type: 'catalog', action: 'imported' })
      .whereRaw(`details->>'fileName' = 'p.zip'`);
    expect(imported).toHaveLength(1);
  });

  it('keeps a replaced second photo in its slot', async () => {
    const { entries } = await exported();
    const before = (await productByCode('OPT-0001')).images;
    const edited = new Map(entries);
    edited.delete('images/OPT-0001_2.webp');
    edited.set(
      'images/OPT-0001_2.png',
      await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } })
        .png()
        .toBuffer(),
    );
    await restoreProductZip(await zipOf(edited), 'p.zip', {}, admin);

    const after = await productByCode('OPT-0001');
    const order = [...after.images].sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sequence - b.sequence,
    );
    expect(order).toHaveLength(2);
    expect(order[0]!.id).toBe(before.find((image) => image.isPrimary)!.id);
    expect(before.map((image) => image.id)).not.toContain(order[1]!.id);
  });

  it('reads photos a restore brought in from its own files back as unchanged, so a second run uploads nothing', async () => {
    const { entries } = await exported();
    const picture = (background: string) =>
      sharp({ create: { width: 40, height: 40, channels: 3, background } });
    const edited = new Map(entries);
    // Each is re-encoded on upload, so none of these bytes is ever a stored master.
    edited.set('images/OPT-0001_2.webp', await picture('#abcdef').webp().toBuffer());
    edited.delete('images/OPT-0002.webp');
    edited.set('images/OPT-0002.png', await picture('#123456').png().toBuffer());
    edited.set('images/OPT-0003.webp', await picture('#654321').webp().toBuffer());
    const file = await zipOf(edited);

    const first = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(first.photos.added).toEqual(['OPT-0003.webp']);
    expect([...first.photos.replaced].sort()).toEqual(['OPT-0001_2.webp', 'OPT-0002.png']);
    expect(first.photos.unchanged).toBe(1);
    const photoIds = async () => db()('product_images').orderBy('id').pluck('id');
    const ids = await photoIds();
    expect(ids).toHaveLength(4);

    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.photos).toMatchObject({ added: [], replaced: [], unchanged: 4, notInZip: [] });

    const second = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(second.photos).toMatchObject({ added: [], replaced: [], unchanged: 4 });
    expect(second.problems).toEqual([]);
    expect(await photoIds()).toEqual(ids);
  });

  it('reads the original of a photo cropped or rotated on screen as replaced, and of one left whole as unchanged', async () => {
    const original = await sharp({ create: { width: 60, height: 30, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    const onScreen = async (code: string, crop: { cropWidth: number; cropHeight: number; rotationDeg: number }) =>
      imageService.uploadImage(
        { productId: (await productByCode(code)).id, fileBuffer: original, crop: { cropX: 0, cropY: 0, ...crop } },
        admin,
      );
    await onScreen('OPT-0003', { cropWidth: 30, cropHeight: 30, rotationDeg: 0 });
    await onScreen('OPT-0004', { cropWidth: 30, cropHeight: 60, rotationDeg: 90 });
    // The editor's rect over the whole picture, unrotated: what a restore of the file makes.
    await onScreen('OPT-0005', { cropWidth: 60, cropHeight: 30, rotationDeg: 0 });

    const edited = new Map((await exported()).entries);
    for (const code of ['OPT-0003', 'OPT-0004', 'OPT-0005']) {
      edited.delete(`images/${code}.webp`);
      edited.set(`images/${code}.jpg`, original);
    }
    const preview = await previewProductZip(await zipOf(edited), 'p.zip', admin);
    expect([...preview.photos.replaced].sort()).toEqual(['OPT-0003.jpg', 'OPT-0004.jpg']);
    expect(preview.photos).toMatchObject({ added: [], unchanged: 4, notInZip: [] });
  });

  it('only reports a deleted row and a deleted photo, unless the opt-ins are ticked', async () => {
    const { entries } = await exported();
    const rows = await readSheetRows(entries.get('products.csv')!);
    const edited = new Map(entries);
    edited.set('products.csv', withoutRow(rows, 'OPT-0004'));
    edited.delete('images/OPT-0001_2.webp');
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.rows.notInFile).toEqual([{ code: 'OPT-0004', name: expect.any(String) }]);
    expect(preview.photos.notInZip).toEqual(['OPT-0001_2']);

    const plain = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(plain).toMatchObject({ binned: 0, photosRemoved: 0 });
    expect(await productByCode('OPT-0004')).toBeDefined();
    expect((await productByCode('OPT-0001')).images).toHaveLength(2);

    const opted = await restoreProductZip(
      file,
      'p.zip',
      { binMissingProducts: true, removeMissingPhotos: true },
      admin,
    );
    expect(opted).toMatchObject({ binned: 1, photosRemoved: 1 });
    expect(await productByCode('OPT-0004')).toBeUndefined();
    // In the Recycle Bin, not gone: the ordinary delete.
    const binned = await db()('products').whereNotNull('deleted_at').select('id');
    expect(binned).toHaveLength(1);
    expect((await productByCode('OPT-0001')).images).toHaveLength(1);
  });

  it('restores an emptied catalogue whole: main products with codes, sub products in order, colours, photos', async () => {
    const original = await exported();
    await resetData();
    expect(await db()('product_categories').count('* as n').first()).toEqual({ n: '0' });

    const preview = await previewProductZip(original.file, 'p.zip', admin);
    expect(preview.mainProducts.added).toHaveLength(41);
    expect(preview.products).toMatchObject({ created: SUB_PRODUCTS, failed: 0 });
    expect(preview.colours.added.length).toBeGreaterThan(0);
    expect(preview.photos.added.sort()).toEqual([
      'OPT-0001.webp',
      'OPT-0001_2.webp',
      'OPT-0002.webp',
    ]);

    const done = await restoreProductZip(original.file, 'p.zip', {}, admin);
    expect(done.products).toMatchObject({ created: SUB_PRODUCTS, failed: 0 });
    expect(done.problems).toEqual([]);

    const again = await exported();
    for (const name of ['products.csv', 'main-products.csv', 'colours.csv']) {
      expect(again.entries.get(name)!.toString('utf8'), name).toBe(
        original.entries.get(name)!.toString('utf8'),
      );
    }
    expect([...again.entries.keys()].filter((name) => name.startsWith('images/')).sort()).toEqual([
      'images/OPT-0001.webp',
      'images/OPT-0001_2.webp',
      'images/OPT-0002.webp',
    ]);
  });

  it('finds the files under a top folder and with the backslashes Compress-Archive writes', async () => {
    const { entries } = await exported();
    // archiver writes forward slashes, so the names are put in by hand, at the same length.
    const named = [...entries].map(([name, bytes]): [string, Buffer] => [`Backup/${name}`, bytes]);
    const file = await zipOf(named);
    const bytes = await readFile(file);
    for (const [name] of named) {
      const slashed = Buffer.from(name, 'utf8');
      const backslashed = Buffer.from(name.replace(/\//g, '\\'), 'utf8');
      let at = bytes.indexOf(slashed);
      while (at !== -1) {
        backslashed.copy(bytes, at);
        at = bytes.indexOf(slashed, at + 1);
      }
    }
    await writeFile(file, bytes);

    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.products).toMatchObject({ unchanged: SUB_PRODUCTS });
    expect(preview.photos).toMatchObject({ unchanged: 3, notInZip: [] });
  });

  it('refuses a climbing entry name, a broken zip, a sheet with no product columns, and a zip with no products.csv', async () => {
    const { entries } = await exported();
    const file = await zipOf([['xx/products.csv', entries.get('products.csv')!]]);
    const bytes = await readFile(file);
    let at = bytes.indexOf('xx/products.csv');
    while (at !== -1) {
      Buffer.from('../products.csv').copy(bytes, at);
      at = bytes.indexOf('xx/products.csv', at + 1);
    }
    await writeFile(file, bytes);
    await expect(previewProductZip(file, 'p.zip', admin)).rejects.toMatchObject({
      messageKey: 'validation.productZip.entryRejected',
    });

    const broken = path.join(dir, 'broken.zip');
    await writeFile(broken, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64)]));
    await expect(previewProductZip(broken, 'broken.zip', admin)).rejects.toMatchObject({
      messageKey: 'validation.productZip.notAZip',
    });
    // Not a zip's first bytes: read as a bare products sheet, refused with the import's own words.
    const text = path.join(dir, 'not.csv');
    await writeFile(text, 'Brand,Code\r\n');
    await expect(previewProductZip(text, 'not.csv', admin)).rejects.toMatchObject({
      messageKey: 'validation.import.missingColumn',
    });

    const bare = await zipOf([['images/OPT-0001.webp', entries.get('images/OPT-0001.webp')!]]);
    const refusal = await previewProductZip(bare, 'p.zip', admin).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).toMatchObject({ messageKey: 'validation.productZip.noProductsCsv' });

    // A header and no rows: refused before a main product is written, not half applied.
    const headerOnly = new Map(entries);
    headerOnly.set('products.csv', Buffer.from('﻿' + toCsv([...IMPORT_HEADERS], []), 'utf8'));
    const empty = await zipOf(headerOnly);
    await resetData();
    await expect(restoreProductZip(empty, 'p.zip', {}, admin)).rejects.toMatchObject({
      messageKey: 'validation.import.emptyFile',
    });
    expect(await db()('product_categories').count('* as n').first()).toEqual({ n: '0' });
  });

  it('names every photo so a restore brings it back to its own sub product, whatever the code', async () => {
    // OPT-0005 recoded to read like "photo 2 of OPT-0002", OPT-0006 to a code no file name can hold.
    await db()('product_variants').where({ code: 'OPT-0005' }).update({ code: 'OPT-0002_2' });
    await db()('product_variants').where({ code: 'OPT-0006' }).update({ code: 'OPT/0006' });
    await addPhoto('OPT-0002_2', '#aa0000');
    await addPhoto('OPT/0006', '#00aa00');
    // OPT-0002's photo 2 would go out as OPT-0002_2, the other one's name: it is left out, and never "missing".
    await addPhoto('OPT-0002', '#0000aa');

    const { file, entries } = await exported();
    expect([...entries.keys()].filter((name) => name.startsWith('images/')).sort()).toEqual(
      [
        'images/OPT%2F0006.webp',
        'images/OPT-0001.webp',
        'images/OPT-0001_2.webp',
        'images/OPT-0002.webp',
        'images/OPT-0002_2.webp',
      ].sort(),
    );
    expect(entries.get('README.txt')!.toString('utf8')).toMatch(/NOT IN THIS ZIP[\s\S]*, photo 2/);

    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.photos).toMatchObject({
      added: [],
      replaced: [],
      unchanged: 5,
      unmatched: [],
      notInZip: [],
    });
    const done = await restoreProductZip(file, 'p.zip', { removeMissingPhotos: true }, admin);
    expect(done).toMatchObject({ photosRemoved: 0 });
    expect((await productByCode('OPT-0002')).images).toHaveLength(2);
    expect((await productByCode('OPT-0002_2')).images).toHaveLength(1);
    expect((await productByCode('OPT/0006')).images).toHaveLength(1);

    // Into an emptied catalogue, each photo lands on its own sub product.
    await resetData();
    await restoreProductZip(file, 'p.zip', {}, admin);
    expect((await productByCode('OPT-0002')).images).toHaveLength(1);
    expect((await productByCode('OPT-0002_2')).images).toHaveLength(1);
    expect((await productByCode('OPT/0006')).images).toHaveLength(1);
  });

  it('says where products.csv and main-products.csv disagree, reads a brand only from a Brand column, and a colour once', async () => {
    const { entries } = await exported();
    const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
    const codeAt = header!.indexOf('Main product code');
    const nameAt = header!.indexOf('Main product');
    const main = body[0]![codeAt]!;
    const mainName = body[0]![nameAt]!;
    const csv = (head: string[], rows: string[][]) => Buffer.from('﻿' + toCsv(head, rows), 'utf8');
    const edited = new Map(entries);
    edited.set(
      'products.csv',
      csv(
        header!,
        body.map((row) =>
          row[codeAt] === main
            ? row.map((cell, index) => (index === nameAt ? 'Renamed here' : cell))
            : row,
        ),
      ),
    );
    // main-products.csv without its Brand column: every brand stays as it is.
    const [mainHeader, ...mainRows] = await readSheetRows(entries.get('main-products.csv')!);
    expect(mainHeader![0]).toBe('Brand');
    edited.set(
      'main-products.csv',
      csv(
        mainHeader!.slice(1),
        mainRows.map((row) => row.slice(1)),
      ),
    );
    const [colourHeader, ...colourRows] = await readSheetRows(entries.get('colours.csv')!);
    edited.set(
      'colours.csv',
      csv(colourHeader!, [
        ...colourRows,
        colourRows[0]!,
        ['Zzz New', 'Zzz New', '#123456', 'yes'],
        ['Zzz New', 'Zzz New', '#654321', 'yes'],
      ]),
    );
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.mainProducts).toEqual({ added: [], renamed: [] });
    expect(preview.colours).toEqual({ added: ['Zzz New'], changed: [] });
    expect(preview.problems).toEqual([
      {
        subject: main,
        messageKey: 'validation.productZip.mainDiffers',
        params: { column: 'Main product', value: 'Renamed here', main: mainName },
      },
    ]);

    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(done.colours.added).toEqual(['Zzz New']);
    const categories = await productRepo.listCategories(admin.tenantId);
    expect(categories.find((category) => category.code === main)?.name).toBe(mainName);
    expect(categories.every((category) => category.brand === 'Swisware+')).toBe(true);
  });

  it('carries on a boot load that threw or was stopped halfway, adding only what is missing', async () => {
    const { file, entries } = await exported();
    await resetData();
    const marker = async () =>
      (await db()('settings').where({ key: SHIPPED_CATALOGUE_MARKER }).first())?.value as
        { state: string; loaded: string } | undefined;

    // A first boot whose zip cannot be read: under way, not done, and nothing written.
    const broken = path.join(dir, 'broken.zip');
    await writeFile(broken, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64)]));
    await expect(loadShippedCatalogue({ zip: broken })).rejects.toMatchObject({
      messageKey: 'validation.productZip.notAZip',
    });
    expect(await marker()).toMatchObject({ state: 'loading' });

    // A second, stopped in the photo phase: every row in, one photo of three.
    const partial = new Map(entries);
    partial.delete('images/OPT-0001_2.webp');
    partial.delete('images/OPT-0002.webp');
    await restoreProductZip(await zipOf(partial), 'p.zip', {}, admin);
    const kept = (await productByCode('OPT-0001')).images[0]!.id;

    expect(await loadShippedCatalogue({ zip: file })).toBe('zip');
    expect(await marker()).toMatchObject({ state: 'done', loaded: 'zip' });
    expect(await db()('products').whereNull('deleted_at').count('* as n').first()).toEqual({
      n: String(SUB_PRODUCTS),
    });
    const opt1 = (await productByCode('OPT-0001')).images;
    expect(opt1).toHaveLength(2);
    // The photo already in slot 1 stays, though its bytes are its own encoding now, not the zip's.
    expect(opt1.find((image) => image.isPrimary)?.id).toBe(kept);
    expect((await productByCode('OPT-0002')).images).toHaveLength(1);

    expect(await loadShippedCatalogue({ zip: file })).toBeNull();
  }, 120_000);

  it('runs the restore as one job at a time and keeps its report', async () => {
    const { file } = await exported();
    const first = path.join(dir, 'first.zip');
    const second = path.join(dir, 'second.zip');
    await copyFile(file, first);
    await copyFile(file, second);

    const started = startProductRestore(first, 'first.zip', {}, admin);
    expect(started.phase).toBe('checking');
    expect(() => startProductRestore(second, 'second.zip', {}, admin)).toThrow(ConflictError);
    // What a full backup restore asks before it starts (`data.routes.ts`).
    expect(isProductRestoreRunning()).toBe(true);

    await vi.waitFor(() => expect(productRestoreJob()?.finishedAt).toBeDefined(), {
      timeout: 60_000,
      interval: 100,
    });
    expect(isProductRestoreRunning()).toBe(false);
    expect(productRestoreJob()).toMatchObject({
      id: started.id,
      phase: 'done',
      result: { products: { unchanged: SUB_PRODUCTS } },
    });
    // The upload goes when the job ends.
    await vi.waitFor(async () => expect(await readdir(dir)).not.toContain('first.zip'));

    // Nor beside a full backup restore, which would replace the database under it.
    let release = (): void => undefined;
    const { finished } = startJob(
      'restore',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let refusal: unknown;
    try {
      startProductRestore(second, 'second.zip', {}, admin);
    } catch (error) {
      refusal = error;
    }
    release();
    await finished;
    expect(refusal).toMatchObject({ messageKey: 'error.conflict.backupBusy' });
  });

  describe('over HTTP, for a signed-in Master user', () => {
    let app: Express;
    beforeAll(() => {
      app = createApp();
    });

    async function agentWith(permissions: string[], username: string) {
      const role = await roleService.createRole(
        { name: `Role ${username}`, tier: 'management', permissions },
        admin,
      );
      await userService.createUser(
        { username, displayName: username, roleId: role.id, password: 'correct-horse' },
        admin,
      );
      const agent = request.agent(app);
      await agent
        .post('/api/auth/sign-in')
        .send({ username, password: 'correct-horse' })
        .expect(200);
      return agent;
    }

    it('streams the backup, previews and restores an upload, and leaves no file behind', async () => {
      const tmp = path.join(config.dataDir, 'tmp');
      const before = await readdir(tmp).catch(() => []);
      const agent = await agentWith(
        ['products.view', 'products.export', 'products.bulk', 'products.create', 'products.edit'],
        'owner',
      );
      const download = await agent
        .get('/api/products/export.zip')
        .buffer()
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(download.headers['content-type']).toBe('application/zip');
      expect(download.headers['content-disposition']).toMatch(
        /^attachment; filename="OrderBook-Products-.+\.zip"$/,
      );
      const zip = download.body as Buffer;

      const preview = await agent
        .post('/api/products/restore')
        .field('dryRun', 'true')
        .attach('file', zip, 'backup.zip')
        .expect(200);
      expect(preview.body).toMatchObject({
        dryRun: true,
        fileName: 'backup.zip',
        products: { unchanged: SUB_PRODUCTS },
      });
      // The preview is of the run its opt-ins ask for: the exact catalogue asks products.delete.
      await agent
        .post('/api/products/restore')
        .field('dryRun', 'true')
        .field('exactCatalogue', 'true')
        .attach('file', zip, 'backup.zip')
        .expect(403);

      const started = await agent
        .post('/api/products/restore')
        .attach('file', zip, 'backup.zip')
        .expect(202);
      expect(started.body).toMatchObject({ phase: 'checking' });
      await vi.waitFor(
        async () => {
          const job = await agent.get('/api/products/restore/job').expect(200);
          expect(job.body.phase).toBe('done');
        },
        { timeout: 60_000, interval: 200 },
      );

      await vi.waitFor(async () => expect(await readdir(tmp).catch(() => [])).toEqual(before));
    });

    it('refuses the backup without products.export, which the CSV export does not ask for', async () => {
      const viewer = await agentWith(['products.view'], 'viewer');
      await viewer.get('/api/products/export.zip').expect(403);
      await viewer.get('/api/products/export.csv').expect(200);
    });
  });
});
