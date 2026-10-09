/**
 * Lens E probe: what the product backup zip restore does when the zip's data
 * differs from the catalogue, and what a hand-combined zip must look like.
 *
 * Each `it` asserts the behaviour a restore should have (so a failing one is a
 * defect, by its name), except the ones named `checked:`, which pin behaviour
 * found correct. A small catalogue of its own, not the shipped one, so every
 * weight, alias, size and colour rule is known.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Product } from '@orderbook/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { db } from '../../src/db/knex.js';
import { createZipWriter, openZipReader } from '../../src/lib/archive-zip.js';
import { toCsv } from '../../src/lib/csv.js';
import { ForbiddenError } from '../../src/lib/errors.js';
import { readSheetRows } from '../../src/lib/spreadsheet.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import { upsertOptions } from '../../src/services/catalogue-seed.service.js';
import { onChange } from '../../src/services/change-bus.js';
import {
  exportProductZip,
  loadShippedCatalogue,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { registerBrands } from '../../src/services/product-import.service.js';
import * as settings from '../../src/services/settings.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from '../helpers/fixtures.js';

let admin: ActorContext;
let dir: string;
let tenantImagesDir: string;

const csv = (header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): Buffer =>
  Buffer.from('﻿' + toCsv([...header], rows.map((row) => [...row])), 'utf8');

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

/** products.csv of the export, as rows (header first). */
async function exportedRows(): Promise<{ entries: Map<string, Buffer>; header: string[]; body: string[][] }> {
  const { entries } = await exported();
  const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
  return { entries, header: header!, body };
}

function setCells(
  header: readonly string[],
  body: string[][],
  code: string,
  cells: Record<string, string>,
): string[][] {
  const codeAt = header.indexOf('Code');
  return body.map((row) =>
    row[codeAt] === code
      ? row.map((cell, index) => (header[index]! in cells ? cells[header[index]!]! : cell))
      : row,
  );
}

async function live(): Promise<Product[]> {
  return (await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 })).items;
}

async function byCode(code: string): Promise<Product | undefined> {
  return (await live()).find((product) =>
    product.variants.some((variant) => variant.isActive && variant.code === code),
  );
}

/** The products.csv row of a code in a fresh export, by header. */
async function exportRowOf(code: string): Promise<Record<string, string>> {
  const { header, body } = await exportedRows();
  const row = body.find((cells) => cells[header.indexOf('Code')] === code);
  return Object.fromEntries(header.map((name, index) => [name, row?.[index] ?? '<missing>']));
}

/**
 * OPT  ONE PIECE TOILET  Swisware+
 *   101   fixed White    OPT-0001  12.5 kg  alias One-o-one  size 70x40
 *   102   dedicated      OPT-0002  10 kg
 *   103   multicolour    OPT-0003
 * WB   WASH BASIN        Swisware+
 *   DAMRU  two colours: White WB-0001 (4 kg), Ivory WB-0002 (4 kg)
 */
async function seedSmallCatalogue(): Promise<void> {
  const listed = await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand');
  await db().transaction(async (trx) => {
    await registerBrands(admin.tenantId, ['Swisware+'], listed, trx);
    await upsertOptions(
      admin.tenantId,
      'stock.colour',
      [
        { value: 'White', hex: '#FFFFFF' },
        { value: 'Ivory', hex: '#FFFFF0' },
      ],
      trx,
    );
  });
  customFieldRepo.invalidateFieldCache(admin.tenantId);
  await catalog.createCategory({ code: 'OPT', name: 'ONE PIECE TOILET', brand: 'Swisware+' }, admin);
  await catalog.createCategory({ code: 'WB', name: 'WASH BASIN', brand: 'Swisware+' }, admin);
  await catalog.createProduct(
    {
      name: '101',
      categoryCode: 'OPT',
      alias: 'One-o-one',
      size: '70x40',
      multiColour: false,
      hasVariants: true,
      variants: [{ code: 'OPT-0001', label: 'White', weightKg: 12.5 }],
    },
    admin,
  );
  await catalog.createProduct(
    {
      name: '102',
      categoryCode: 'OPT',
      multiColour: false,
      hasVariants: false,
      variants: [{ code: 'OPT-0002', label: null, weightKg: 10 }],
    },
    admin,
  );
  await catalog.createProduct(
    {
      name: '103',
      categoryCode: 'OPT',
      multiColour: true,
      hasVariants: false,
      variants: [{ code: 'OPT-0003', label: null, weightKg: null }],
    },
    admin,
  );
  await catalog.createProduct(
    {
      name: 'DAMRU',
      categoryCode: 'WB',
      multiColour: false,
      hasVariants: true,
      variants: [
        { code: 'WB-0001', label: 'White', weightKg: 4 },
        { code: 'WB-0002', label: 'Ivory', weightKg: 4 },
      ],
    },
    admin,
  );
}

describe.skipIf(!canRunIntegrationTests)('lens E: restore semantics and merge-readiness (probe)', () => {
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
    await seedSmallCatalogue();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-e-'));
  }, 120_000);

  it('checked: an unedited export (weights, alias, size, all three colour rules, a two-colour sub product) reads back unchanged, twice', async () => {
    const { file, entries } = await exported();
    const rows = await readSheetRows(entries.get('products.csv')!);
    expect(rows).toHaveLength(6);
    const preview = await previewProductZip(file, 'p.zip', admin);
    expect(preview.products).toMatchObject({ created: 0, updated: 0, unchanged: 5, failed: 0 });
    expect(preview.rows).toEqual({ added: [], changed: [], notInFile: [] });
    expect(preview.mainProducts).toEqual({ added: [], renamed: [] });
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(done.products).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    expect(await db()('activity_log').where({ entity_type: 'catalog', action: 'imported' })).toHaveLength(0);
  });

  it('E1: the same sub product (main product + name + colour) under another code does not become a second sub product', async () => {
    const { entries, header, body } = await exportedRows();
    // A backup from an install where 101 White carried another code.
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, setCells(header, body, 'OPT-0001', { Code: 'OPT-9001' })));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const named101 = (await live()).filter(
      (product) => product.categoryCode === 'OPT' && product.name === '101',
    );
    console.log(
      'E1 preview created', preview.products.created, 'notInFile', JSON.stringify(preview.rows.notInFile),
      '| apply created', done.products.created, '| live "101" under OPT:',
      named101.map((product) => product.variants.map((variant) => variant.code).join('+')).join(', '),
    );
    expect(named101).toHaveLength(1);
  });

  it('E2: a weight cleared in products.csv is cleared by the restore (and the preview lists it)', async () => {
    const { entries, header, body } = await exportedRows();
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, setCells(header, body, 'OPT-0001', { 'Weight (kg)': '' })));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const weight = (await byCode('OPT-0001'))!.variants[0]!.weightKg;
    console.log('E2 preview changed', JSON.stringify(preview.rows.changed), 'unchanged', preview.products.unchanged, '| weight after restore', weight);
    expect(preview.rows.changed).toEqual([
      { code: 'OPT-0001', name: '101', fields: [{ column: 'Weight (kg)', from: '12.5', to: '' }] },
    ]);
    expect(weight).toBeNull();
  });

  it('E3: an alias and a size cleared in products.csv are cleared by the restore', async () => {
    const { entries, header, body } = await exportedRows();
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, setCells(header, body, 'OPT-0001', { Alias: '', Size: '' })));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = (await byCode('OPT-0001'))!;
    console.log('E3 preview changed', JSON.stringify(preview.rows.changed), '| after restore alias', after.alias, 'size', after.size);
    expect({ alias: after.alias, size: after.size }).toEqual({ alias: null, size: null });
  });

  it('E4: a fixed sub product the file says is dedicated is restored as dedicated, not as fixed "Standard"', async () => {
    const { entries, header, body } = await exportedRows();
    const edited = new Map(entries);
    edited.set(
      'products.csv',
      csv(header, setCells(header, body, 'OPT-0001', { 'Colour rule': 'dedicated', Colour: '' })),
    );
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const row = await exportRowOf('OPT-0001');
    const again = await previewProductZip(file, 'p.zip', admin);
    console.log(
      'E4 preview changed', JSON.stringify(preview.rows.changed),
      '| export after restore: rule', row['Colour rule'], 'colour', row.Colour,
      '| second preview updated', again.products.updated, 'unchanged', again.products.unchanged,
    );
    expect({ rule: row['Colour rule'], colour: row.Colour }).toEqual({ rule: 'dedicated', colour: '' });
  });

  it('E5: fixed -> multicolour -> fixed and multicolour -> dedicated each land as the file says', async () => {
    const { entries, header, body } = await exportedRows();
    const step = async (cells: Record<string, string>) => {
      const edited = new Map(entries);
      edited.set('products.csv', csv(header, setCells(header, body, 'OPT-0001', cells)));
      const file = await zipOf(edited);
      const preview = await previewProductZip(file, 'p.zip', admin);
      await restoreProductZip(file, 'p.zip', {}, admin);
      const product = (await byCode('OPT-0001'))!;
      const row = await exportRowOf('OPT-0001');
      console.log(
        'E5', JSON.stringify(cells), '-> preview', JSON.stringify(preview.rows.changed.map((change) => change.fields)),
        '| stored multiColour', product.multiColour, 'hasVariants', product.hasVariants,
        'label', JSON.stringify(product.variants.map((variant) => variant.label)),
        '| export rule', row['Colour rule'], 'colour', JSON.stringify(row.Colour),
      );
      return row;
    };
    const multi = await step({ 'Colour rule': 'multicolour', Colour: '' });
    expect({ rule: multi['Colour rule'], colour: multi.Colour }).toEqual({ rule: 'multicolour', colour: '' });
    const fixed = await step({ 'Colour rule': 'fixed', Colour: 'White' });
    expect({ rule: fixed['Colour rule'], colour: fixed.Colour }).toEqual({ rule: 'fixed', colour: 'White' });
    await step({ 'Colour rule': 'multicolour', Colour: '' });
    const dedicated = await step({ 'Colour rule': 'dedicated', Colour: '' });
    expect({ rule: dedicated['Colour rule'], colour: dedicated.Colour }).toEqual({ rule: 'dedicated', colour: '' });
  });

  it('E6: a colour of a sub product the file names, whose own code the file does not name, is reported (and binned on opt-in)', async () => {
    const { entries, header, body } = await exportedRows();
    const codeAt = header.indexOf('Code');
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, body.filter((row) => row[codeAt] !== 'WB-0002')));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', { binMissingProducts: true }, admin);
    const damru = (await byCode('WB-0001'))!;
    console.log(
      'E6 preview notInFile', JSON.stringify(preview.rows.notInFile), 'changed', JSON.stringify(preview.rows.changed),
      'unchanged', preview.products.unchanged, '| apply binned', done.binned,
      '| DAMRU live codes after', damru.variants.filter((variant) => variant.isActive).map((variant) => variant.code).join(','),
    );
    expect(
      [...preview.rows.notInFile.map((row) => row.code), ...preview.rows.changed.map((row) => row.code)].length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['no code (one an import created by name)', null],
    ['another code', 'WBX'],
  ])('E7: a main product the catalogue has by brand + name with %s still takes the file\'s sub products', async (_label, liveCode) => {
    await db()('product_categories').where({ code: 'WB' }).update({ code: liveCode });
    const { entries, header, body } = await exportedRows();
    const mainCodeAt = header.indexOf('Main product code');
    // The backup comes from an install whose WASH BASIN is coded WB, with one more sub product.
    const rows = body.map((row) =>
      row[header.indexOf('Main product')] === 'WASH BASIN'
        ? row.map((cell, index) => (index === mainCodeAt ? 'WB' : cell))
        : row,
    );
    const extra = [...rows.find((row) => row[header.indexOf('Code')] === 'WB-0001')!];
    extra[header.indexOf('Sub product')] = 'SQUARE';
    extra[header.indexOf('Code')] = 'WB-0003';
    rows.push(extra);
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, rows));
    edited.set(
      'main-products.csv',
      csv(
        ['Brand', 'Main product code', 'Main product', 'Order'],
        [
          ['Swisware+', 'OPT', 'ONE PIECE TOILET', 1],
          ['Swisware+', 'WB', 'WASH BASIN', 2],
        ],
      ),
    );
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    console.log(
      'E7 preview mainProducts', JSON.stringify(preview.mainProducts), 'failed', preview.products.failed,
      'issues', JSON.stringify(preview.products.issues.map((issue) => [issue.row, issue.messageKey, issue.params])),
      '| apply failed', done.products.failed, 'created', done.products.created,
      '| WB-0003 exists', Boolean(await byCode('WB-0003')),
    );
    expect(done.products.failed).toBe(0);
    expect(await byCode('WB-0003')).toBeDefined();
  });

  it('E7b: a brandless, codeless main product of the same name is the file\'s main product, not a second one beside it', async () => {
    await db()('product_categories').where({ code: 'WB' }).update({ code: null, brand: null });
    const { entries, header, body } = await exportedRows();
    const rows = body.map((row) =>
      row[header.indexOf('Main product')] === 'WASH BASIN'
        ? row.map((cell, index) =>
            index === header.indexOf('Main product code') ? 'WB' : index === header.indexOf('Brand') ? 'Swisware+' : cell,
          )
        : row,
    );
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, rows));
    edited.set(
      'main-products.csv',
      csv(['Brand', 'Main product code', 'Main product', 'Order'], [
        ['Swisware+', 'OPT', 'ONE PIECE TOILET', 1],
        ['Swisware+', 'WB', 'WASH BASIN', 2],
      ]),
    );
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const basins = (await productRepo.listCategories(admin.tenantId)).filter((category) => category.name === 'WASH BASIN');
    console.log(
      'E7b preview added', JSON.stringify(preview.mainProducts.added), 'changed', JSON.stringify(preview.rows.changed.map((row) => [row.code, row.fields])),
      '| apply updated', done.products.updated,
      '| WASH BASIN main products after:', basins.map((category) => `${category.brand ?? '-'}:${category.code ?? '-'}:${category.subProductCount}`).join(', '),
    );
    expect(basins).toHaveLength(1);
  });

  it('demonstrates: two rows of one sub product (two colours) that disagree on Size are one sub product with the first row\'s size, and nothing is reported', async () => {
    const { entries, header, body } = await exportedRows();
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, setCells(header, setCells(header, body, 'WB-0001', { Size: '50x40' }), 'WB-0002', { Size: '60x45' })));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    console.log('first-row-wins: preview issues', preview.products.issues.length, 'changed', JSON.stringify(preview.rows.changed.map((row) => row.fields)), '| size after', (await byCode('WB-0002'))!.size);
    expect(preview.products.issues).toEqual([]);
    expect((await byCode('WB-0002'))!.size).toBe('50x40');
  });

  it('E8: a hand-combined main-products.csv naming one main product under two codes is refused or reported by the preview, not thrown by the apply', async () => {
    await resetData();
    const header = ['Brand', 'Main product code', 'Main product', 'Sub product', 'Size', 'Colour rule', 'Colour', 'Code', 'Weight (kg)', 'Alias'];
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
        csv(['Brand', 'Main product code', 'Main product', 'Order'], [
          ['Swisware+', 'WB', 'WASH BASIN', 1],
          ['Swisware+', 'WB1', 'WASH BASIN', 2],
        ]),
      ],
      ['colours.csv', csv(['Colour', 'Hex'], [['Probe Teal', '#008080']])],
    ]);

    const preview = await previewProductZip(file, 'p.zip', admin);
    console.log(
      'E8 preview mainProducts.added', JSON.stringify(preview.mainProducts.added), 'created', preview.products.created,
      'problems', JSON.stringify(preview.problems),
    );
    const outcome = await restoreProductZip(file, 'p.zip', {}, admin).then(
      (report) => `resolved: main added ${report.mainProducts.added.length}`,
      (error: unknown) => `threw: ${(error as Error).message}`,
    );
    const teal = (await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).some(
      (option) => option.value === 'Probe Teal',
    );
    const categories = await productRepo.listCategories(admin.tenantId);
    console.log('E8 apply', outcome, '| colour written before the failure:', teal, '| main products now', categories.length);
    expect(outcome).toMatch(/^resolved/);
  });

  it('E9: one main product code listed twice in main-products.csv is reported once, as what the apply creates', async () => {
    await resetData();
    const header = ['Brand', 'Main product code', 'Main product', 'Sub product', 'Size', 'Colour rule', 'Colour', 'Code', 'Weight (kg)', 'Alias'];
    const file = await zipOf([
      [
        'products.csv',
        csv(header, [['Swisware+', 'WB', 'WASH BASIN', 'DAMRU', '', 'dedicated', '', 'WB-0001', '', '']]),
      ],
      [
        'main-products.csv',
        csv(['Brand', 'Main product code', 'Main product', 'Order'], [
          ['Swisware+', 'WB', 'WASH BASIN', 1],
          ['Swisware+', 'WB', 'WASH BASINS', 2],
        ]),
      ],
    ]);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const categories = await productRepo.listCategories(admin.tenantId);
    console.log(
      'E9 preview added', JSON.stringify(preview.mainProducts.added), 'problems', preview.problems.length,
      '| apply reported added', done.mainProducts.added.length, '| created', categories.map((category) => `${category.code}:${category.name}`).join(', '),
    );
    expect(done.mainProducts.added).toHaveLength(categories.length);
  });

  it('E10: two main products whose names the file swaps: what the preview lists as renamed is what the apply renames', async () => {
    const { entries } = await exported();
    const edited = new Map(entries);
    edited.set(
      'main-products.csv',
      csv(['Brand', 'Main product code', 'Main product', 'Order'], [
        ['Swisware+', 'OPT', 'WASH BASIN', 1],
        ['Swisware+', 'WB', 'ONE PIECE TOILET', 2],
      ]),
    );
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    console.log(
      'E10 preview renamed', preview.mainProducts.renamed.length, 'problems', JSON.stringify(preview.problems.map((problem) => problem.messageKey)),
      '| apply renamed', done.mainProducts.renamed.length, 'problems', JSON.stringify(done.problems.map((problem) => [problem.subject, problem.messageKey])),
    );
    expect(done.mainProducts.renamed.length).toBe(preview.mainProducts.renamed.length);
  });

  it('E11: a colour spelled in another case in colours.csv is the colour the list has, not a second one', async () => {
    const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
    const white = colours.find((option) => option.value.toLowerCase() === 'white');
    expect(white).toBeDefined();
    const { entries } = await exported();
    const edited = new Map(entries);
    edited.set('colours.csv', csv(['Colour', 'Hex'], [[white!.value.toUpperCase(), white!.hex ?? '']]));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const whites = (await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).filter(
      (option) => option.value.toLowerCase() === 'white',
    );
    console.log('E11 preview colours', JSON.stringify(preview.colours), '| white-ish colours after', JSON.stringify(whites.map((option) => option.value)));
    expect(whites).toHaveLength(1);
  });

  it('E12: a sub product the file moves next to a live one of the same name does not leave two of that name', async () => {
    // WASH BASIN already has a 102 that the file does not list.
    await catalog.createProduct(
      { name: '102', categoryCode: 'WB', hasVariants: false, variants: [{ code: 'WB-0102', label: null, weightKg: null }] },
      admin,
    );
    const { entries, header, body } = await exportedRows();
    const codeAt = header.indexOf('Code');
    const moved = setCells(header, body, 'OPT-0002', { 'Main product code': 'WB', 'Main product': 'WASH BASIN' }).filter(
      (row) => row[codeAt] !== 'WB-0102',
    );
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, moved));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const twins = (await live()).filter((product) => product.categoryCode === 'WB' && product.name === '102');
    console.log(
      'E12 preview changed', JSON.stringify(preview.rows.changed), 'failed', preview.products.failed,
      '| apply updated', done.products.updated, '| live 102 under WB:', twins.length,
    );
    expect(twins).toHaveLength(1);
  });

  it('checked: with no main-products.csv, a main product code products.csv names under another name and brand is renamed from its first row', async () => {
    const listed = await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand');
    await db().transaction((trx) => registerBrands(admin.tenantId, ['Other'], listed, trx));
    const { entries, header, body } = await exportedRows();
    const nameAt = header.indexOf('Main product');
    const brandAt = header.indexOf('Brand');
    const edited = new Map(entries);
    edited.delete('main-products.csv');
    edited.set(
      'products.csv',
      csv(
        header,
        body.map((row) =>
          row[header.indexOf('Main product code')] === 'WB'
            ? row.map((cell, index) => (index === nameAt ? 'WASH BASINS' : index === brandAt ? 'Other' : cell))
            : row,
        ),
      ),
    );
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    for (const report of [preview, done]) {
      expect(report.mainProducts.renamed).toEqual([
        {
          code: 'WB',
          fields: [
            { column: 'Main product', from: 'WASH BASIN', to: 'WASH BASINS' },
            { column: 'Brand', from: 'Swisware+', to: 'Other' },
          ],
        },
      ]);
      expect(report.products).toMatchObject({ created: 0, updated: 0, failed: 0 });
    }
    const wb = (await productRepo.listCategories(admin.tenantId)).find((category) => category.code === 'WB')!;
    expect([wb.name, wb.brand]).toEqual(['WASH BASINS', 'Other']);
  });

  it('checked: two brands with the same main product name stay two main products, each with its own sub products', async () => {
    const { entries, header, body } = await exportedRows();
    const other = [...body.find((row) => row[header.indexOf('Code')] === 'WB-0001')!];
    other[header.indexOf('Brand')] = 'Other';
    other[header.indexOf('Main product code')] = 'OWB';
    other[header.indexOf('Code')] = 'OWB-0001';
    other[header.indexOf('Colour rule')] = 'dedicated';
    other[header.indexOf('Colour')] = '';
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, [...body, other]));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    for (const report of [preview, done]) {
      expect(report.mainProducts.added).toEqual([{ code: 'OWB', name: 'WASH BASIN', brand: 'Other' }]);
      expect(report.products).toMatchObject({ created: 1, updated: 0, failed: 0, unchanged: 5 });
    }
    const basins = (await productRepo.listCategories(admin.tenantId)).filter((category) => category.name === 'WASH BASIN');
    expect(basins.map((category) => `${category.brand}:${category.code}:${category.subProductCount}`).sort()).toEqual([
      'Other:OWB:1',
      'Swisware+:WB:1',
    ]);
  });

  it('demonstrates: a sub product in the Recycle Bin that the zip lists comes back as a new sub product beside the binned one', async () => {
    const { file } = await exported();
    await catalog.deleteProduct((await byCode('OPT-0002'))!.id, admin);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const all = await db()('products').where({ name: '102' }).select('id', 'deleted_at');
    console.log(
      'Bin: preview created', preview.products.created, '| apply created', done.products.created,
      '| rows named 102:', all.map((row) => (row.deleted_at ? 'binned' : 'live')).join(','),
    );
    const binned = all.find((row) => row.deleted_at)!;
    const outcome = await catalog.restoreProduct(String(binned.id), admin).then(
      () => 'restored',
      (error: unknown) => `refused: ${(error as { messageKey?: string }).messageKey ?? (error as Error).message}`,
    );
    console.log('Bin: restoring the binned 102 afterwards ->', outcome);
    expect(all).toHaveLength(2);
  });

  it('E13: a full backup restored, both opt-ins ticked, into a fresh install that loaded the shipped catalogue leaves exactly the backup', async () => {
    const backup = await exported();
    await resetData();
    // A fresh install of this build: the boot loads the shipped catalogue (no products.zip here, so the markdown).
    expect(await loadShippedCatalogue({ zip: path.join(dir, 'no-such.zip') })).toBe('markdown');
    const shipped = { mains: (await productRepo.listCategories(admin.tenantId)).length, subs: (await live()).length };

    const preview = await previewProductZip(backup.file, 'p.zip', admin);
    const done = await restoreProductZip(backup.file, 'p.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const after = await exported();

    const lines = (entries: Map<string, Buffer>, name: string) =>
      entries.get(name)!.toString('utf8').replace(/^\s+/, '').split(/\r?\n/).filter(Boolean);
    const diff = (name: string) => {
      const want = lines(backup.entries, name);
      const got = lines(after.entries, name);
      return {
        missing: want.filter((line) => !got.includes(line)),
        extra: got.filter((line) => !want.includes(line)),
      };
    };
    const products = diff('products.csv');
    const mains = diff('main-products.csv');
    const colours = diff('colours.csv');
    console.log(
      `E13 shipped ${shipped.mains} main / ${shipped.subs} sub products | preview created ${preview.products.created} updated ${preview.products.updated} notInFile ${preview.rows.notInFile.length} failed ${preview.products.failed}`,
      `| apply binned ${done.binned} failed ${done.products.failed} problems ${JSON.stringify(done.problems.slice(0, 3))}`,
    );
    console.log('E13 products.csv missing', JSON.stringify(products.missing), 'extra', JSON.stringify(products.extra));
    console.log(
      'E13 main-products.csv extra', mains.extra.length, JSON.stringify(mains.extra.slice(0, 4)),
      'WB now', JSON.stringify(mains.extra.filter((line) => line.includes(',WB,'))), 'missing', JSON.stringify(mains.missing),
    );
    console.log(
      'E13 live sub products', (await live()).length, 'live main products', (await productRepo.listCategories(admin.tenantId)).length,
      'binned sub products', (await db()('products').whereNotNull('deleted_at').count('* as n').first())?.n,
    );
    console.log('E13 colours.csv extra', colours.extra.length, JSON.stringify(colours.extra.slice(0, 4)), 'missing', JSON.stringify(colours.missing));
    expect({ products, mains, colours }).toEqual({
      products: { missing: [], extra: [] },
      mains: { missing: [], extra: [] },
      colours: { missing: [], extra: [] },
    });
  }, 120_000);

  it('checked: a code twice in a hand-combined products.csv: the later row is refused, the first lands, preview == apply', async () => {
    const { entries, header, body } = await exportedRows();
    const twin = [...body.find((row) => row[header.indexOf('Code')] === 'OPT-0002')!];
    twin[header.indexOf('Sub product')] = '102 B';
    twin[header.indexOf('Weight (kg)')] = '99';
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, [...body, twin]));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    console.log('checked dup code: preview', JSON.stringify(preview.products.issues), '| apply failed', done.products.failed);
    expect(preview.products).toMatchObject({ failed: 1, created: 0, updated: 0 });
    expect(done.products).toMatchObject({ failed: 1, created: 0, updated: 0 });
    expect(preview.products.issues[0]).toMatchObject({ messageKey: 'validation.import.duplicateInFile' });
    expect((await byCode('OPT-0002'))!.variants[0]!.weightKg).toBe(10);
  });

  it('checked: a code under another main product and name moves and renames that sub product; preview lists it; no duplicate', async () => {
    const { entries, header, body } = await exportedRows();
    const edited = new Map(entries);
    edited.set(
      'products.csv',
      csv(header, setCells(header, body, 'OPT-0002', { 'Main product code': 'WB', 'Main product': 'WASH BASIN', 'Sub product': 'OVAL' })),
    );
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(preview.rows.changed).toEqual([
      {
        code: 'OPT-0002',
        name: 'OVAL',
        fields: [
          { column: 'Main product code', from: 'OPT', to: 'WB' },
          { column: 'Sub product', from: '102', to: 'OVAL' },
        ],
      },
    ]);
    expect(done.products).toMatchObject({ updated: 1, created: 0 });
    const moved = (await byCode('OPT-0002'))!;
    expect([moved.categoryCode, moved.name]).toEqual(['WB', 'OVAL']);
    expect(await live()).toHaveLength(4);
  });

  it('checked: main-products.csv rows with no sub products are created; a products.csv main product missing from main-products.csv is created from its first row', async () => {
    const { entries, header, body } = await exportedRows();
    const extra = [...body[0]!];
    extra[header.indexOf('Main product code')] = 'CB';
    extra[header.indexOf('Main product')] = 'CLOSET BOWL';
    extra[header.indexOf('Sub product')] = 'C1';
    extra[header.indexOf('Code')] = 'CB-0001';
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, [...body, extra]));
    edited.set(
      'main-products.csv',
      csv(['Brand', 'Main product code', 'Main product', 'Order'], [
        ['Swisware+', 'OPT', 'ONE PIECE TOILET', 1],
        ['Swisware+', 'WB', 'WASH BASIN', 2],
        ['Swisware+', 'URI', 'URINAL', 3],
      ]),
    );
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(preview.mainProducts.added.map((main) => main.code).sort()).toEqual(['CB', 'URI']);
    expect(done.mainProducts.added.map((main) => main.code).sort()).toEqual(['CB', 'URI']);
    expect(preview.products).toMatchObject({ created: 1, failed: 0 });
    expect(done.products).toMatchObject({ created: 1, failed: 0 });
    const codes = (await productRepo.listCategories(admin.tenantId)).map((category) => category.code);
    expect(codes).toEqual(expect.arrayContaining(['CB', 'URI']));
  });

  it('checked: with catalog.importCreatesCategories off the zip still creates its coded main products; a name-only unknown one is refused alike in preview and apply', async () => {
    await settings.writeSetting(admin, 'catalog.importCreatesCategories', false);
    const { entries, header, body } = await exportedRows();
    const coded = [...body[0]!];
    coded[header.indexOf('Main product code')] = 'CB';
    coded[header.indexOf('Main product')] = 'CLOSET BOWL';
    coded[header.indexOf('Code')] = 'CB-0001';
    const named = [...body[0]!];
    named[header.indexOf('Main product code')] = '';
    named[header.indexOf('Main product')] = 'PAN';
    named[header.indexOf('Code')] = 'PAN-0001';
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, [...body, coded, named]));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    for (const report of [preview, done]) {
      expect(report.products).toMatchObject({ created: 1, failed: 1 });
      expect(report.products.issues.map((issue) => issue.messageKey)).toEqual(['validation.import.unknownCategory']);
      expect(report.mainProducts.added.map((main) => main.code)).toEqual(['CB']);
    }
    expect(await byCode('CB-0001')).toBeDefined();
    expect(await byCode('PAN-0001')).toBeUndefined();
  });

  it('checked: permissions — binning needs products.delete; a colour change needs catalog.lists.manage, preview included', async () => {
    const { file, entries } = await exported();
    const bulk = await actorWith(['products.view', 'products.bulk', 'products.create', 'products.edit']);
    await expect(restoreProductZip(file, 'p.zip', { binMissingProducts: true }, bulk)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(previewProductZip(file, 'p.zip', bulk)).resolves.toBeDefined();
    const edited = new Map(entries);
    edited.set('colours.csv', csv(['Colour', 'Hex'], [['Probe Teal', '#008080']]));
    const coloured = await zipOf(edited);
    await expect(previewProductZip(coloured, 'p.zip', bulk)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(restoreProductZip(coloured, 'p.zip', {}, bulk)).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      (await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).some((option) => option.value === 'Probe Teal'),
    ).toBe(false);
  });

  it('checked: a mixed restore — the preview counts equal the apply, one activity row and one catalogue event carry them, a second run is all unchanged', async () => {
    const { entries, header, body } = await exportedRows();
    const extra = [...body[0]!];
    extra[header.indexOf('Sub product')] = '104';
    extra[header.indexOf('Code')] = 'OPT-0004';
    const rows = [...setCells(header, body, 'OPT-0002', { Size: '60x30', 'Weight (kg)': '11' }), extra];
    const edited = new Map(entries);
    edited.set('products.csv', csv(header, rows));
    edited.set(
      'main-products.csv',
      csv(['Brand', 'Main product code', 'Main product', 'Order'], [
        ['Swisware+', 'OPT', 'ONE PIECE TOILETS', 1],
        ['Swisware+', 'WB', 'WASH BASIN', 2],
        ['Swisware+', 'URI', 'URINAL', 3],
      ]),
    );
    edited.set('colours.csv', csv(['Colour', 'Hex'], [['Probe Teal', '#008080']]));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const events: unknown[] = [];
    // A rename announces itself (`publishCatalogueMoved`, payload `{categoryId}`); the restore's own event carries the counts.
    const stop = onChange((event) => {
      if (event.entity === 'catalog' && 'created' in ((event.payload ?? {}) as object)) events.push(event);
    });
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    stop();
    const pick = (report: typeof preview) => ({
      main: report.mainProducts,
      products: {
        created: report.products.created,
        updated: report.products.updated,
        unchanged: report.products.unchanged,
        failed: report.products.failed,
      },
      rows: report.rows,
      colours: report.colours,
    });
    expect(pick(done)).toEqual(pick(preview));
    expect(preview.products).toMatchObject({ created: 1, updated: 1, unchanged: 4 });
    const logged = await db()('activity_log').where({ entity_type: 'catalog', action: 'imported' });
    expect(logged).toHaveLength(1);
    expect(logged[0].details).toMatchObject({
      created: 1,
      updated: 1,
      mainProductsAdded: 1,
      mainProductsRenamed: 1,
      coloursChanged: 1,
    });
    expect(events).toHaveLength(1);

    const again = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(again.products).toMatchObject({ created: 0, updated: 0, unchanged: 6 });
    expect(again.mainProducts).toEqual({ added: [], renamed: [] });
    expect(again.colours).toEqual({ added: [], changed: [] });
    expect(await db()('activity_log').where({ entity_type: 'catalog', action: 'imported' })).toHaveLength(1);
  });
});
