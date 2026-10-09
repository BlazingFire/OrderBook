/**
 * Lens E verifier probe: restore-semantics defects the first pass missed, a
 * realistic owner flow (backup from an install that loaded the shipped
 * catalogue, restored into a fresh install that loaded it again), and a guard
 * the E12 fix must keep passing.
 *
 * `Ev...` tests assert what a restore should do, so a failing one is a defect;
 * `checked:` ones pin behaviour found correct.
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
import { readSheetRows } from '../../src/lib/spreadsheet.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import { upsertOptions } from '../../src/services/catalogue-seed.service.js';
import {
  exportProductZip,
  loadShippedCatalogue,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { registerBrands } from '../../src/services/product-import.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from '../helpers/fixtures.js';

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

async function live(): Promise<Product[]> {
  return (await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 })).items;
}

async function byCode(code: string): Promise<Product | undefined> {
  return (await live()).find((product) =>
    product.variants.some((variant) => variant.isActive && variant.code === code),
  );
}

const lines = (entries: Map<string, Buffer>, name: string): string[] =>
  entries.get(name)!.toString('utf8').replace(/^\s+/, '').split(/\r?\n/).filter(Boolean);

function diff(want: Map<string, Buffer>, got: Map<string, Buffer>, name: string) {
  // main-products.csv's Order is the row's position, so one extra row shifts every later one: compared without it.
  const strip = (line: string) => (name === 'main-products.csv' ? line.replace(/,\d+$/, '') : line);
  const a = lines(want, name).map(strip);
  const b = lines(got, name).map(strip);
  return { missing: a.filter((line) => !b.includes(line)), extra: b.filter((line) => !a.includes(line)) };
}

/** OPT ONE PIECE TOILET: 101 fixed White OPT-0001, 102 dedicated OPT-0002. WB WASH BASIN: DAMRU fixed White WB-0001. */
async function seedSmall(): Promise<void> {
  const listed = await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand');
  await db().transaction(async (trx) => {
    await registerBrands(admin.tenantId, ['Swisware+'], listed, trx);
    await upsertOptions(admin.tenantId, 'stock.colour', [{ value: 'White', hex: '#FFFFFF' }], trx);
  });
  customFieldRepo.invalidateFieldCache(admin.tenantId);
  await catalog.createCategory({ code: 'OPT', name: 'ONE PIECE TOILET', brand: 'Swisware+' }, admin);
  await catalog.createCategory({ code: 'WB', name: 'WASH BASIN', brand: 'Swisware+' }, admin);
  await catalog.createProduct(
    { name: '101', categoryCode: 'OPT', hasVariants: true, variants: [{ code: 'OPT-0001', label: 'White', weightKg: 12.5 }] },
    admin,
  );
  await catalog.createProduct(
    { name: '102', categoryCode: 'OPT', hasVariants: false, variants: [{ code: 'OPT-0002', label: null, weightKg: 10 }] },
    admin,
  );
  await catalog.createProduct(
    { name: 'DAMRU', categoryCode: 'WB', hasVariants: true, variants: [{ code: 'WB-0001', label: 'White', weightKg: 4 }] },
    admin,
  );
}

describe.skipIf(!canRunIntegrationTests)('lens E verifier: missed restore-semantics defects (probe)', () => {
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
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-ev-'));
  }, 120_000);

  it('Ev1: a colour spelled in another case in colours.csv does not recolour the sub products of an otherwise unedited backup, and the preview agrees with the apply', async () => {
    await seedSmall();
    const { entries } = await exported();
    const edited = new Map(entries);
    // A hand-combined colours.csv that took the other backup's spelling of White.
    edited.set('colours.csv', csv(['Colour', 'Hex'], [['WHITE', '#FFFFFF']]));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await Promise.all(
      ['OPT-0001', 'WB-0001'].map(async (code) => (await byCode(code))!.variants[0]!.label),
    );
    const again = await previewProductZip((await exported()).file, 'p.zip', admin);
    console.log(
      'Ev1 preview products', JSON.stringify({ updated: preview.products.updated, unchanged: preview.products.unchanged }),
      'changed', JSON.stringify(preview.rows.changed),
      '| apply products', JSON.stringify({ updated: done.products.updated, unchanged: done.products.unchanged }),
      'changed', JSON.stringify(done.rows.changed),
      '| labels after', JSON.stringify(after),
      '| colour list', JSON.stringify((await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).map((option) => option.value)),
      '| re-export previews updated', again.products.updated,
    );
    expect(done.products.updated).toBe(preview.products.updated);
    expect(after).toEqual(['White', 'White']);
  });

  it('Ev1b: with the colour list holding White and WHITE (the Fields screen allows both), an unedited export reads back unchanged and recolours nothing', async () => {
    await seedSmall();
    await db().transaction((trx) => upsertOptions(admin.tenantId, 'stock.colour', [{ value: 'WHITE', hex: '#FFFFFF' }], trx));
    customFieldRepo.invalidateFieldCache(admin.tenantId);
    const { file } = await exported();
    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await Promise.all(
      ['OPT-0001', 'WB-0001'].map(async (code) => (await byCode(code))!.variants[0]!.label),
    );
    console.log(
      'Ev1b unedited export: preview updated', preview.products.updated, 'unchanged', preview.products.unchanged,
      'changed', JSON.stringify(preview.rows.changed.map((row) => [row.code, row.fields])),
      '| labels after', JSON.stringify(after),
    );
    expect(preview.products.updated).toBe(0);
    expect(after).toEqual(['White', 'White']);
  });

  it('Ev3: a sub product saved on the screens with a double space in its name or size reads back unchanged from its own unedited export', async () => {
    await seedSmall();
    await catalog.createProduct(
      {
        name: 'OVAL  BASIN',
        categoryCode: 'WB',
        size: '18 x  12',
        hasVariants: false,
        variants: [{ code: 'WB-0009', label: null, weightKg: null }],
      },
      admin,
    );
    const { file } = await exported();
    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = (await byCode('WB-0009'))!;
    console.log(
      'Ev3 preview updated', preview.products.updated, 'changed', JSON.stringify(preview.rows.changed),
      '| after restore name', JSON.stringify(after.name), 'size', JSON.stringify(after.size),
    );
    expect(preview.rows.changed).toEqual([]);
    expect([after.name, after.size]).toEqual(['OVAL  BASIN', '18 x  12']);
  });

  it('Ev2: the owner flow, realistic codes: a backup taken from an install that loaded the shipped catalogue, restored with both opt-ins into a fresh install that loaded it again, exports as the backup', async () => {
    expect(await loadShippedCatalogue({ zip: path.join(dir, 'no-such.zip') })).toBe('markdown');
    const all = await live();
    const categories = await productRepo.listCategories(admin.tenantId);
    // The owner's edits on the screens.
    const fixed = all.find((product) => !product.multiColour && product.variants[0]?.label)!;
    const sized = all.find((product) => product.size && product.id !== fixed.id)!;
    const weighed = all.find((product) => product.id !== fixed.id && product.id !== sized.id)!;
    const binned = all.find((product) => ![fixed.id, sized.id, weighed.id].includes(product.id))!;
    const smallest = [...categories].sort((a, b) => a.subProductCount - b.subProductCount)[0]!;
    const renamed = categories.find((category) => category.id !== smallest.id && category.code !== fixed.categoryCode)!;
    const variantOf = (product: Product) => product.variants.find((variant) => variant.isActive)!;

    await catalog.updateProduct(
      fixed.id,
      { name: fixed.name, hasVariants: false, multiColour: false, variants: [{ ...variantOf(fixed), label: null }] },
      admin,
    );
    await catalog.updateProduct(sized.id, { name: sized.name, size: null }, admin);
    await catalog.updateProduct(weighed.id, { name: weighed.name, variants: [{ ...variantOf(weighed), weightKg: 7.5 }] }, admin);
    await catalog.deleteProduct(binned.id, admin);
    for (const product of all.filter((candidate) => candidate.categoryId === smallest.id && candidate.id !== binned.id)) {
      await catalog.deleteProduct(product.id, admin);
    }
    await catalog.deleteCategory(smallest.id, admin);
    await catalog.updateCategory(renamed.id, { name: `${renamed.name} RENAMED` }, admin);
    await catalog.createProduct(
      { name: 'PROBE NEW', categoryId: fixed.categoryId, hasVariants: false, variants: [{ code: 'PROBE-0001', label: null, weightKg: 3 }] },
      admin,
    );
    const offColour = (await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour')).at(-1)!;
    await db()('option_lists').where({ id: offColour.id }).update({ is_active: false });
    customFieldRepo.invalidateFieldCache(admin.tenantId);

    const backup = await exported();

    // Install the current build fresh: the boot loads the shipped catalogue again.
    await resetData();
    expect(await loadShippedCatalogue({ zip: path.join(dir, 'no-such.zip') })).toBe('markdown');
    const preview = await previewProductZip(backup.file, 'p.zip', admin);
    const done = await restoreProductZip(backup.file, 'p.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const after = await exported();

    const products = diff(backup.entries, after.entries, 'products.csv');
    const mains = diff(backup.entries, after.entries, 'main-products.csv');
    const colours = diff(backup.entries, after.entries, 'colours.csv');
    console.log(
      `Ev2 edits: fixed->dedicated ${variantOf(fixed).code}, size cleared ${variantOf(sized).code}, weight 7.5 ${variantOf(weighed).code},`,
      `binned ${variantOf(binned).code}, main product deleted ${smallest.code} (${smallest.subProductCount}), renamed ${renamed.code}, colour off ${offColour.value}`,
    );
    console.log(
      `Ev2 preview created ${preview.products.created} updated ${preview.products.updated} failed ${preview.products.failed} notInFile ${preview.rows.notInFile.length}`,
      `| apply created ${done.products.created} updated ${done.products.updated} failed ${done.products.failed} binned ${done.binned}`,
      `| main renamed ${done.mainProducts.renamed.length} added ${done.mainProducts.added.length}`,
    );
    console.log('Ev2 products.csv', JSON.stringify(products));
    console.log('Ev2 main-products.csv', JSON.stringify(mains));
    console.log('Ev2 colours.csv', JSON.stringify(colours));
    const codeOrder = async (entries: Map<string, Buffer>) => {
      const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
      return body.map((row) => row[header!.indexOf('Code')]!);
    };
    const wantOrder = await codeOrder(backup.entries);
    const gotOrder = (await codeOrder(after.entries)).filter((code) => wantOrder.includes(code));
    const firstOff = wantOrder.findIndex((code, index) => gotOrder[index] !== code);
    console.log(
      'Ev2 sub product order', firstOff === -1 ? 'same' : `differs at ${firstOff}: want ${wantOrder.slice(firstOff, firstOff + 3).join(',')} got ${gotOrder.slice(firstOff, firstOff + 3).join(',')}`,
    );
    expect({ products, mains, colours }).toEqual({
      products: { missing: [], extra: [] },
      mains: { missing: [], extra: [] },
      colours: { missing: [], extra: [] },
    });
  }, 180_000);

  it('checked: two sub products of one main product whose names the file swaps both land (a guard any E1/E12 name check must keep passing)', async () => {
    await seedSmall();
    const { entries } = await exported();
    const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
    const codeAt = header!.indexOf('Code');
    const nameAt = header!.indexOf('Sub product');
    const swapped = body.map((row) =>
      row[codeAt] === 'OPT-0001'
        ? row.map((cell, index) => (index === nameAt ? '102' : cell))
        : row[codeAt] === 'OPT-0002'
          ? row.map((cell, index) => (index === nameAt ? '101' : cell))
          : row,
    );
    const edited = new Map(entries);
    edited.set('products.csv', csv(header!, swapped));
    const file = await zipOf(edited);
    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(preview.products).toMatchObject({ updated: 2, failed: 0 });
    expect(done.products).toMatchObject({ updated: 2, failed: 0 });
    expect([(await byCode('OPT-0001'))!.name, (await byCode('OPT-0002'))!.name]).toEqual(['102', '101']);
  });
});
