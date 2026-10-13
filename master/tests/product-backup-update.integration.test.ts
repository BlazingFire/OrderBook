/**
 * "Update only" (`ProductRestoreOptions.updateOnly`, in
 * `services/product-zip.service.ts` and `importProducts`' restore) against
 * PostgreSQL: the owner's scenario, where the company kept working on the
 * catalogue (more coloured variants, weights, a rename, a photo, a sub
 * product) while his side filled in an update zip from an older export with
 * only the cells to change. Everything the company did that the file leaves
 * blank stays; what the file fills in, adds or replaces lands; nothing is
 * removed; the preview is the run; a second run changes nothing. And the
 * backup zip carries every variant, each its own products.csv row.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { galleryOrder, type ProductInput, type ProductZipReport } from '@orderbook/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { toCsv } from '../src/lib/csv.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as customFieldRepo from '../src/repositories/custom-field.repository.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import * as fields from '../src/services/fields.service.js';
import * as imageService from '../src/services/image.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../src/services/product-zip.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

const WHOLE = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };
const TABLES = ['product_categories', 'products', 'product_variants', 'product_images', 'option_lists'];
const PRODUCTS_HEADER = [
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

let admin: ActorContext;
let dir: string;
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

async function productByCode(code: string) {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === code))!;
}

async function addPhoto(code: string, background: string, caption?: string): Promise<string> {
  const product = await imageService.uploadImage(
    {
      productId: (await productByCode(code)).id,
      fileBuffer: await jpeg(background),
      crop: { ...WHOLE, caption },
      wholeFrame: true,
    },
    admin,
  );
  return [...product.images].sort((a, b) => b.sequence - a.sequence)[0]!.id;
}

/** A sub product's photos in gallery order: id, caption, checksum. */
async function gallery(code: string) {
  const product = await productByCode(code);
  const byId = new Map(product.images.map((image) => [image.id, image]));
  return galleryOrder(product).map((id) => {
    const image = byId.get(id)!;
    return { id, caption: image.caption, checksum: image.checksum };
  });
}

/** Every live code: its sub product, colour and weight. */
async function variants(): Promise<Record<string, { name: string; label: string | null; weightKg: number | null }>> {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  const out: Record<string, { name: string; label: string | null; weightKg: number | null }> = {};
  for (const product of items)
    for (const variant of product.variants.filter((candidate) => candidate.isActive))
      out[variant.code] = { name: product.name, label: variant.label, weightKg: variant.weightKg };
  return out;
}

/** Every row of the catalogue's tables, to show a run wrote nothing. */
async function dump(): Promise<Record<string, string[]>> {
  const rows: Record<string, string[]> = {};
  for (const table of TABLES) {
    const { rows: json } = await db().raw<{ rows: Array<{ j: string }> }>(
      'SELECT row_to_json(t)::text AS j FROM ?? t ORDER BY 1',
      [table],
    );
    rows[table] = json.map((row) => row.j);
  }
  return rows;
}

const create = (input: Record<string, unknown>) => catalog.createProduct(input as unknown as ProductInput, admin);

/**
 * Two main products; Alpha with two coloured variants, Beta dedicated, Gamma
 * multicolour, Delta coloured; photos on Alpha (two) and Delta.
 */
async function ourCatalogue(): Promise<void> {
  for (const value of ['Snow', 'Coal', 'Rose', 'Sky'])
    await fields.createValue({ listKey: 'stock.colour', value, label: value, hex: null }, admin);
  await catalog.createCategory({ name: 'One Piece', code: 'OPT' }, admin);
  await catalog.createCategory({ name: 'Wash Basin', code: 'WB' }, admin);
  await create({
    categoryCode: 'OPT',
    name: 'Alpha',
    size: '20x20',
    hasVariants: true,
    variants: [
      { code: 'OPT-1', label: 'Snow', weightKg: 10 },
      { code: 'OPT-2', label: 'Coal', weightKg: 11 },
    ],
  });
  await create({
    categoryCode: 'OPT',
    name: 'Beta',
    hasVariants: false,
    variants: [{ code: 'OPT-3', label: null, weightKg: 5 }],
  });
  await create({
    categoryCode: 'OPT',
    name: 'Gamma',
    hasVariants: false,
    multiColour: true,
    variants: [{ code: 'OPT-4', label: null }],
  });
  await create({
    categoryCode: 'WB',
    name: 'Delta',
    hasVariants: true,
    variants: [{ code: 'WB-1', label: 'Snow', weightKg: 3 }],
  });
  await addPhoto('OPT-1', '#aa0000', 'Front');
  await addPhoto('OPT-1', '#00aa00', 'Back');
  await addPhoto('WB-1', '#0000aa');
}

/** What the company did since: more variants, a weight, a rename, a photo, a sub product. */
async function companyWork(): Promise<{ deltaPhoto: string }> {
  const alpha = await productByCode('OPT-1');
  await catalog.updateProduct(
    alpha.id,
    {
      name: alpha.name,
      hasVariants: true,
      variants: [
        ...alpha.variants.map((variant) => ({
          id: variant.id,
          code: variant.code,
          label: variant.label,
          weightKg: variant.code === 'OPT-2' ? 11.5 : variant.weightKg,
        })),
        { code: 'OPT-5', label: 'Rose', weightKg: 12 },
        { code: 'OPT-6', label: 'Sky' },
      ],
    } as ProductInput,
    admin,
  );
  const beta = await productByCode('OPT-3');
  await catalog.updateProduct(beta.id, { name: 'Beta Plus' } as ProductInput, admin);
  const delta = await productByCode('WB-1');
  await catalog.updateProduct(
    delta.id,
    {
      name: delta.name,
      hasVariants: true,
      variants: [
        ...delta.variants.map((variant) => ({ id: variant.id, code: variant.code, label: variant.label, weightKg: variant.weightKg })),
        { code: 'WB-3', label: 'Coal', weightKg: 4 },
      ],
    } as ProductInput,
    admin,
  );
  await imageService.deleteImage(delta.images[0]!.id, admin);
  const deltaPhoto = await addPhoto('WB-1', '#7700aa', 'Company shot');
  await create({
    categoryCode: 'WB',
    name: 'Epsilon',
    hasVariants: true,
    variants: [{ code: 'WB-2', label: 'Coal', weightKg: 6 }],
  });
  return { deltaPhoto };
}

/** The parts of a report a preview and its run must agree on. */
const planOf = (report: ProductZipReport) => ({
  mainAdded: report.mainProducts.added,
  mainRenamed: report.mainProducts.renamed,
  created: report.products.created,
  updated: report.products.updated,
  unchanged: report.products.unchanged,
  failed: report.products.failed,
  issues: report.products.issues,
  added: report.rows.added,
  changed: report.rows.changed,
  notInFile: report.rows.notInFile,
  variantsNotInFile: report.rows.variantsNotInFile,
  reordered: report.rows.reordered,
  colours: report.colours,
  brands: report.brands,
  photosAdded: [...report.photos.added].sort(),
  photosReplaced: [...report.photos.replaced].sort(),
  photosReordered: report.photos.reordered,
  notInZip: report.photos.notInZip,
  problems: report.problems,
});

describe.skipIf(!canRunIntegrationTests)('the product backup zip, update only (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
  }, 120_000);
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    if (dir) await rm(dir, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    customFieldRepo.invalidateFieldCache();
    admin = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'product-backup-update-'));
  }, 120_000);

  it("the owner's scenario: the company's variants, rename, weights, photo and sub product stay; our filled cells, rows and photos land; nothing is removed", async () => {
    await ourCatalogue();
    const older = await exported();
    const { deltaPhoto } = await companyWork();
    const company = await variants();
    const alphaBefore = await gallery('OPT-1');
    const listBefore = (await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).map(
      (option) => option.value,
    );

    // Our update zip, built from the older export: only the cells we change are filled.
    const blankRow = (code: string, cells: Partial<Record<string, string>> = {}) =>
      PRODUCTS_HEADER.map((column) => (column === 'Code' ? code : (cells[column] ?? '')));
    const update = new Map<string, Buffer>([
      [
        'products.csv',
        csv(PRODUCTS_HEADER, [
          blankRow('OPT-1', { 'Weight (kg)': '10.5' }),
          blankRow('OPT-2'),
          blankRow('OPT-3', { Alias: 'Counter B' }),
          // A new variant of Alpha, read by its name inside its main product.
          blankRow('OPT-7', { 'Main product code': 'OPT', 'Sub product': 'Alpha', Colour: 'Gold', 'Weight (kg)': '9' }),
          // A new sub product, and one under a new main product.
          blankRow('OPT-9', {
            'Main product code': 'OPT',
            'Sub product': 'Zeta',
            'Colour rule': 'fixed',
            Colour: 'Snow',
            'Weight (kg)': '7',
          }),
          blankRow('NEW-1', { 'Main product code': 'NEW', 'Main product': 'New Range', 'Sub product': 'Eta', 'Colour rule': 'dedicated' }),
        ]),
      ],
      [
        'main-products.csv',
        csv(['Brand', 'Main product code', 'Main product', 'Order'], [
          ['', 'OPT', '', ''],
          ['', 'NEW', 'New Range', ''],
        ]),
      ],
      [
        'colours.csv',
        csv(['Colour', 'Label', 'Hex', 'Active'], [
          ['Snow', '', '', ''],
          ['Gold', 'Gold', '#d4af37', 'yes'],
        ]),
      ],
      ['photos.csv', csv(['File', 'Caption'], [['OPT-1_2.jpg', 'Back, new'], ['OPT-1_3.jpg', '']])],
      ['images/OPT-1_2.jpg', await jpeg('#dddd00')],
      ['images/OPT-1_3.jpg', await jpeg('#00dddd')],
      ['images/OPT-9.jpg', await jpeg('#dd00dd')],
    ]);
    const file = await zipOf(update);
    // Removals asked for too: none can happen under update only.
    const options = {
      updateOnly: true,
      binMissingProducts: true,
      removeMissingPhotos: true,
      exactCatalogue: true,
    };

    const preview = await previewProductZip(file, 'update.zip', admin, options);
    expect(preview.products.issues).toEqual([]);
    expect(preview.problems).toEqual([]);
    expect(preview.rows.added.map((row) => row.code).sort()).toEqual(['NEW-1', 'OPT-9']);
    expect(preview.mainProducts.added).toEqual([{ code: 'NEW', name: 'New Range', brand: null }]);
    expect(preview.mainProducts.renamed).toEqual([]);
    expect(preview.rows.notInFile).toEqual([]);
    expect(preview.rows.variantsNotInFile).toBeUndefined();
    expect([...preview.photos.added].sort()).toEqual(['OPT-1_3.jpg', 'OPT-9.jpg']);
    expect(preview.photos).toMatchObject({ replaced: ['OPT-1_2.jpg'], notInZip: [] });
    expect(preview.colours.added).toEqual(['Gold']);
    expect(preview.colours.changed).toEqual([]);
    expect(preview.colours.reordered).toBeUndefined();

    const done = await restoreProductZip(file, 'update.zip', options, admin);
    expect(planOf(done)).toEqual(planOf(preview));
    expect({ binned: done.binned, photosRemoved: done.photosRemoved, exactRemoved: done.exactRemoved }).toEqual({
      binned: 0,
      photosRemoved: 0,
      exactRemoved: undefined,
    });

    // Every company variant, weight and the rename stay; our cells and rows land.
    expect(await variants()).toEqual({
      ...company,
      'OPT-1': { ...company['OPT-1']!, weightKg: 10.5 },
      'OPT-3': { name: 'Beta Plus', label: null, weightKg: 5 },
      'OPT-7': { name: 'Alpha', label: 'Gold', weightKg: 9 },
      'OPT-9': { name: 'Zeta', label: 'Snow', weightKg: 7 },
      'NEW-1': { name: 'Eta', label: null, weightKg: null },
    });
    expect(company['OPT-2']).toEqual({ name: 'Alpha', label: 'Coal', weightKg: 11.5 });
    expect(company['WB-2']).toEqual({ name: 'Epsilon', label: 'Coal', weightKg: 6 });
    const alpha = await productByCode('OPT-1');
    expect(alpha.size).toBe('20x20');
    expect(alpha.variants.filter((variant) => variant.isActive).map((variant) => variant.code)).toEqual([
      'OPT-1',
      'OPT-2',
      'OPT-5',
      'OPT-6',
      'OPT-7',
    ]);
    expect((await productByCode('OPT-3')).alias).toBe('Counter B');
    expect((await productByCode('OPT-4')).multiColour).toBe(true);
    // Nothing renumbered; the new main product after the last.
    const mains = await productRepo.listCategories(admin.tenantId);
    const newMain = mains.find((main) => main.code === 'NEW')!;
    expect(newMain.sortOrder).toBe(Math.max(...mains.filter((main) => main !== newMain).map((main) => main.sortOrder ?? 0)) + 1);
    expect(mains.find((main) => main.code === 'OPT')!.name).toBe('One Piece');

    // Photos: ours replaced photo 2 and added photo 3 in place; the company's Delta photo stays.
    const alphaAfter = await gallery('OPT-1');
    expect(alphaAfter).toHaveLength(3);
    expect(alphaAfter[0]).toEqual(alphaBefore[0]);
    expect(alphaAfter[1]!.caption).toBe('Back, new');
    expect(alphaAfter.map((image) => image.id)).not.toContain(alphaBefore[1]!.id);
    expect((await gallery('WB-1')).map((image) => image.id)).toEqual([deltaPhoto]);
    expect(await gallery('OPT-9')).toHaveLength(1);

    // The colour list: Gold added, Snow as it was, nothing removed.
    const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
    expect(colours.map((option) => option.value)).toEqual([...listBefore, 'Gold']);
    expect(colours.find((option) => option.value === 'Snow')).toMatchObject({ label: 'Snow', isActive: true });

    // The same zip again: nothing to do, and nothing written.
    const before = await dump();
    const again = await restoreProductZip(file, 'update.zip', options, admin);
    expect(await dump()).toEqual(before);
    expect({
      created: again.products.created,
      updated: again.products.updated,
      photos: [...again.photos.added, ...again.photos.replaced],
      colours: again.colours.added.length + again.colours.changed.length,
      problems: again.problems,
    }).toEqual({ created: 0, updated: 0, photos: [], colours: 0, problems: [] });

    // The older export itself, restored update only, takes back nothing the company did but the
    // cells that differ and are filled: here the rename, weight and photo it still holds.
    const back = await previewProductZip(older.file, 'older.zip', admin, { updateOnly: true });
    expect(back.rows.notInFile).toEqual([]);
    expect(back.rows.variantsNotInFile).toBeUndefined();
    expect(back.photos.notInZip).toEqual([]);
  });

  it('exports every variant as its own row and photo, and an update-only restore of that export changes nothing', async () => {
    await ourCatalogue();
    await companyWork();
    const first = await exported();
    const [header, ...rows] = await readSheetRows(first.entries.get('products.csv')!);
    const at = (column: string) => header!.indexOf(column);
    const row = (code: string) => rows.find((cells) => cells[at('Code')] === code)!;
    // Several coloured variants, each its own row with its code, colour and weight.
    expect(['OPT-1', 'OPT-2', 'OPT-5', 'OPT-6'].map((code) => [row(code)[at('Sub product')], row(code)[at('Colour')], row(code)[at('Weight (kg)')]])).toEqual([
      ['Alpha', 'Snow', '10'],
      ['Alpha', 'Coal', '11.5'],
      ['Alpha', 'Rose', '12'],
      ['Alpha', 'Sky', ''],
    ]);
    expect([row('OPT-3')[at('Colour rule')], row('OPT-3')[at('Colour')]]).toEqual(['dedicated', '']);
    expect(row('OPT-4')[at('Colour rule')]).toBe('multicolour');
    expect(rows.map((cells) => cells[at('Code')]).sort()).toEqual(Object.keys(await variants()).sort());
    expect([...first.entries.keys()].filter((name) => name.startsWith('images/')).sort()).toEqual([
      'images/OPT-1.webp',
      'images/OPT-1_2.webp',
      'images/WB-1.webp',
    ]);

    const preview = await previewProductZip(first.file, 'first.zip', admin, { updateOnly: true });
    expect({ created: preview.products.created, updated: preview.products.updated, problems: preview.problems }).toEqual({
      created: 0,
      updated: 0,
      problems: [],
    });
    const before = await dump();
    await restoreProductZip(first.file, 'first.zip', { updateOnly: true }, admin);
    expect(await dump()).toEqual(before);

    const second = await exported();
    for (const name of first.entries.keys())
      if (name !== 'README.txt') expect(second.entries.get(name)!.equals(first.entries.get(name)!), name).toBe(true);
  });

  it('a blank cell never clears, and a dedicated rule that would strip colours from codes the file does not name is left out and said', async () => {
    await ourCatalogue();
    await db()('products').where({ id: (await productByCode('OPT-3')).id }).update({ alias: 'Keep me', size: '9x9' });
    const header = PRODUCTS_HEADER;
    const file = await zipOf([
      [
        'products.csv',
        csv(header, [
          // Every cell of Beta blank but its code: alias, size, weight stay.
          header.map((column) => (column === 'Code' ? 'OPT-3' : '')),
          // Alpha "dedicated", naming one of its two coloured codes.
          header.map((column) => (column === 'Code' ? 'OPT-1' : column === 'Colour rule' ? 'dedicated' : '')),
        ]),
      ],
    ]);
    const done = await restoreProductZip(file, 'blank.zip', { updateOnly: true }, admin);
    expect(done.problems).toEqual([
      { subject: 'OPT-1', messageKey: 'productZip.problem.ruleKept', params: { name: 'Alpha' } },
    ]);
    expect(done.products.updated).toBe(0);
    const beta = await productByCode('OPT-3');
    expect([beta.alias, beta.size, beta.variants[0]!.weightKg]).toEqual(['Keep me', '9x9', 5]);
    const alpha = await productByCode('OPT-1');
    expect([alpha.hasVariants, alpha.variants.map((variant) => variant.label)]).toEqual([true, ['Snow', 'Coal']]);
  });

  it('reads a products.csv of only Code and Weight (kg), changing those weights alone', async () => {
    await ourCatalogue();
    const before = await variants();
    const file = await zipOf([['products.csv', csv(['Code', 'Weight (kg)'], [['OPT-2', '13'], ['WB-1', '']])]]);
    const preview = await previewProductZip(file, 'weights.zip', admin, { updateOnly: true });
    expect(preview.rows.changed).toEqual([
      { code: 'OPT-2', name: 'Alpha', fields: [{ column: 'Weight (kg)', from: '11', to: '13' }] },
    ]);
    // A full restore still needs the sub product columns.
    await expect(previewProductZip(file, 'weights.zip', admin)).rejects.toMatchObject({
      messageKey: 'validation.import.missingColumn',
    });
    await restoreProductZip(file, 'weights.zip', { updateOnly: true }, admin);
    expect(await variants()).toEqual({ ...before, 'OPT-2': { ...before['OPT-2']!, weightKg: 13 } });
  });

  it('refuses in the preview a new code that would repeat a colour of its sub product, and a new row with no sub product', async () => {
    await ourCatalogue();
    const file = await zipOf([
      [
        'products.csv',
        csv(PRODUCTS_HEADER, [
          PRODUCTS_HEADER.map((column) =>
            ({ Code: 'OPT-8', 'Main product code': 'OPT', 'Sub product': 'Alpha', Colour: 'Snow' })[column] ?? '',
          ),
          PRODUCTS_HEADER.map((column) => (column === 'Code' ? 'ZZ-1' : column === 'Weight (kg)' ? '2' : '')),
        ]),
      ],
    ]);
    const preview = await previewProductZip(file, 'bad.zip', admin, { updateOnly: true });
    expect(preview.products.issues.map((issue) => [issue.row, issue.messageKey])).toEqual([
      [2, 'validation.product.variantLabelDuplicate'],
      [3, 'validation.product.nameRequired'],
      [3, 'validation.product.categoryRequired'],
    ]);
    const before = await dump();
    const done = await restoreProductZip(file, 'bad.zip', { updateOnly: true }, admin);
    expect(planOf(done)).toEqual(planOf(preview));
    expect(await dump()).toEqual(before);
  });
});
