/**
 * Probe, lens D: the owner's flow on a NEW install of the current build.
 *
 * The build ships a catalogue (`swisware-plus-2026.md` + photos) that the first
 * boot loads (`loadShippedCatalogue`) and decorates (`attachCataloguePhotos`).
 * The owner then restores his own product backup zip. He asked that afterwards
 * NOTHING of the shipped catalogue is left (main products, sub products,
 * colours, brands, photos), and that his data comes back exactly as it was.
 *
 * Phase 1 builds "his" catalogue the way his install got it (the same shipped
 * catalogue, then his own edits) and exports it. Each `it` is then a fresh
 * install: reset, shipped load, shipped photos, setup, restore of his zip, and
 * an export compared with his zip. Assertions state what the owner asked for;
 * a failing one is a defect.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { db } from '../../src/db/knex.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { openZipReader } from '../../src/lib/archive-zip.js';
import { readSheetRows } from '../../src/lib/spreadsheet.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import { attachCataloguePhotos, healMissingImageFiles } from '../../src/services/catalogue-photos.service.js';
import { seedCatalogue } from '../../src/services/catalogue-seed.service.js';
import * as imageService from '../../src/services/image.service.js';
import {
  exportProductZip,
  loadShippedCatalogue,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import {
  createTestProduct,
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from '../helpers/fixtures.js';

const noZip = path.join(os.tmpdir(), 'orderbook-probe-d-no-such-catalogue.zip');
const SHIPPED_PHOTOS = ['OPT-0001', 'OPT-0002', 'OPT-0004', 'WB-0001', 'MER-0001'];
const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } }).jpeg().toBuffer();

let admin: ActorContext;
let dir: string;
let shipped: string;
let tenantImagesDir: string;
let owner: { file: string; entries: Map<string, Buffer> };

async function productByCode(code: string) {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === code));
}

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

async function exported(): Promise<{ file: string; entries: Map<string, Buffer> }> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return { file, entries: await entriesOf(file) };
}

const linesOf = (bytes: Buffer | undefined): string[] =>
  (bytes ?? Buffer.alloc(0))
    .toString('utf8')
    // trimStart drops the byte order mark too.
    .trimStart()
    .split(/\r?\n/)
    .filter(Boolean);

/** Lines only one side has, and whether the order is the same. */
function compare(name: string, ownerBytes?: Buffer, afterBytes?: Buffer) {
  const mine = linesOf(ownerBytes);
  const now = linesOf(afterBytes);
  const firstOrderDifference = mine.findIndex((line, index) => now[index] !== line);
  return {
    file: name,
    onlyInOwnersZip: mine.filter((line) => !now.includes(line)),
    onlyAfterRestore: now.filter((line) => !mine.includes(line)),
    firstOrderDifference:
      firstOrderDifference === -1 ? null : { line: firstOrderDifference, owner: mine[firstOrderDifference], now: now[firstOrderDifference] },
  };
}

/** A fresh install of the current build: the first boot, then first-run setup. */
async function freshInstall(): Promise<void> {
  await resetData();
  expect(await loadShippedCatalogue({ zip: noZip })).toBe('markdown');
  expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: SHIPPED_PHOTOS.length });
  await setUpFirstRun('Owner Ceramics');
  admin = await testActor();
}

/** What is left on the install that the owner's zip does not carry. */
async function leftovers() {
  const mainRows = await readSheetRows(owner.entries.get('main-products.csv')!);
  const ownerMainCodes = new Set(mainRows.slice(1).map((row) => (row[1] ?? '').toLowerCase()));
  const ownerBrands = new Set(mainRows.slice(1).map((row) => row[0] ?? ''));
  const colourRows = await readSheetRows(owner.entries.get('colours.csv')!);
  const ownerColours = new Set(colourRows.slice(1).map((row) => row[0] ?? ''));
  const ownerImages = [...owner.entries.keys()].filter((name) => name.startsWith('images/'));

  const liveMain = await productRepo.listCategories(admin.tenantId);
  const brands = await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand');
  const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
  const binnedProducts = await db()('products as p')
    .join('product_variants as v', 'v.product_id', 'p.id')
    .whereNotNull('p.deleted_at')
    .pluck('v.code');
  const binnedMain = await db()('product_categories').whereNotNull('deleted_at').pluck('code');
  const systemCatalogueLog = await db()('activity_log')
    .where({ entity_type: 'catalog', actor_type: 'system' })
    .select('action', db().raw(`details->>'fileName' as file`));
  return {
    mainProductsNotInZip: liveMain
      .filter((main) => !ownerMainCodes.has((main.code ?? '').toLowerCase()))
      .map((main) => `${main.code} ${main.name} (${main.subProductCount} sub products)`),
    brandsNotInZip: brands.filter((brand) => !ownerBrands.has(brand.value)).map((brand) => brand.value),
    coloursNotInZip: colours.filter((colour) => colour.isActive && !ownerColours.has(colour.value)).map((colour) => colour.value),
    recycleBinSubProducts: binnedProducts,
    recycleBinMainProducts: binnedMain,
    photoRows: Number((await db()('product_images').count('* as n').first<{ n: string }>())?.n),
    photosInOwnersZip: ownerImages.length,
    systemCatalogueLog,
  };
}

describe.skipIf(!canRunIntegrationTests)('probe D: restoring the owner zip over the shipped catalogue (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-d-zip-'));
    shipped = await mkdtemp(path.join(os.tmpdir(), 'probe-d-shipped-'));
    for (const [index, code] of SHIPPED_PHOTOS.entries()) {
      await writeFile(path.join(shipped, `${code}.jpg`), await jpeg(`#${(index * 40 + 30).toString(16).padStart(2, '0')}4080`));
    }

    // --- Phase 1: the owner's install, as it got its catalogue, then his edits.
    await resetData();
    await setUpFirstRun('Owner Ceramics');
    admin = await testActor();
    await seedCatalogue({ actor: admin });
    expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: SHIPPED_PHOTOS.length });

    // His brand, everywhere.
    await db()('product_categories').update({ brand: 'Owner Ceramics' });
    await db()('option_lists')
      .where({ list_key: 'product.brand', value: 'Swisware+' })
      .update({ value: 'Owner Ceramics', label: 'Owner Ceramics' });
    customFieldRepo.invalidateFieldCache(admin.tenantId);

    const mains = await productRepo.listCategories(admin.tenantId);
    // His main product order: the second one first.
    await catalog.updateCategory(mains[1]!.id, { sortOrder: 0 }, admin);
    await catalog.updateCategory(mains[0]!.id, { name: 'Owner Toilets' }, admin);
    // He does not sell Merchandise: its sub products and itself binned.
    const mer = mains.find((main) => main.code === 'MER')!;
    const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
    for (const product of items.filter((item) => item.categoryId === mer.id)) await catalog.deleteProduct(product.id, admin);
    await catalog.deleteCategory(mer.id, admin);
    await catalog.deleteProduct((await productByCode('OPT-0003'))!.id, admin);

    // OPT-0001: a weight, an alias, and no colour (dedicated) instead of fixed White.
    const opt1 = (await productByCode('OPT-0001'))!;
    await db()('products').where({ id: opt1.id }).update({ alias: 'Best seller', has_variants: false, multi_colour: false });
    await db()('product_variants').where({ code: 'OPT-0001' }).update({ weight_kg: 12.5, label: null });
    // OPT-0005 first inside its main product.
    await db()('products').where({ id: (await productByCode('OPT-0005'))!.id }).update({ sort_order: 0 });

    // His colour list: one shipped colour binned, one of his own added.
    const colours = await customFieldRepo.listOptionsForKey(admin.tenantId, 'stock.colour');
    await db()('option_lists').where({ id: colours[colours.length - 1]!.id }).update({ deleted_at: db().fn.now() });
    await db().transaction((trx) =>
      customFieldRepo.insertOption(
        { tenantId: admin.tenantId, listKey: 'stock.colour', value: 'Owner Teal', label: 'Owner Teal', hex: '#00897b', sequence: 999, createdBy: null },
        trx,
      ),
    );
    customFieldRepo.invalidateFieldCache(admin.tenantId);

    // Photos: one shipped photo removed, one replaced with his own, his own product with his own photo.
    await imageService.deleteImage((await productByCode('OPT-0002'))!.images[0]!.id, admin);
    const opt4 = (await productByCode('OPT-0004'))!;
    await imageService.deleteImage(opt4.images[0]!.id, admin);
    const whole = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };
    await imageService.uploadImage({ productId: opt4.id, fileBuffer: await jpeg('#123456'), crop: whole, wholeFrame: true }, admin);
    await catalog.createCategory({ name: 'Own Range', code: 'OWN', brand: 'Owner Ceramics' }, admin);
    const own = await createTestProduct(admin, { name: 'Own Basin', categoryName: 'Own Range', code: 'OWN-0001' });
    await imageService.uploadImage({ productId: own.product.id, fileBuffer: await jpeg('#654321'), crop: whole, wholeFrame: true }, admin);

    owner = await exported();
  }, 600_000);

  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rm(shipped, { recursive: true, force: true });
    await teardownDatabase();
  });

  it('D5: with both opt-ins ticked, the restored catalogue is exactly the owner zip and nothing shipped is left', async () => {
    await freshInstall();
    const preview = await previewProductZip(owner.file, 'owner.zip', admin);
    const done = await restoreProductZip(owner.file, 'owner.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const after = await exported();
    const left = await leftovers();
    const diffs = ['products.csv', 'main-products.csv', 'colours.csv'].map((name) =>
      compare(name, owner.entries.get(name), after.entries.get(name)),
    );
    const images = {
      owner: [...owner.entries.keys()].filter((name) => name.startsWith('images/')).sort(),
      now: [...after.entries.keys()].filter((name) => name.startsWith('images/')).sort(),
    };
    console.log(`[D5] preview: notInFile ${preview.rows.notInFile.length}, photos.notInZip ${preview.photos.notInZip.length}, problems ${JSON.stringify(preview.problems)}`);
    console.log(`[D5] restore: created ${done.products.created}, updated ${done.products.updated}, binned ${done.binned}, photosRemoved ${done.photosRemoved}, problems ${JSON.stringify(done.problems)}`);
    console.log(`[D5] diffs ${JSON.stringify(diffs, null, 1)}`);
    console.log(`[D5] images ${JSON.stringify(images)}`);
    console.log(`[D5] leftovers ${JSON.stringify(left, null, 1)}`);

    for (const diff of diffs) {
      expect.soft(diff, `${diff.file} after restore differs from the owner zip`).toEqual({
        file: diff.file,
        onlyInOwnersZip: [],
        onlyAfterRestore: [],
        firstOrderDifference: null,
      });
    }
    expect.soft(images.now).toEqual(images.owner);
    // Sub product order inside a main product the shipped catalogue also has.
    const optOrder = async (bytes?: Buffer) =>
      (await readSheetRows(bytes ?? Buffer.alloc(0))).filter((row) => row[1] === 'OPT').map((row) => row[7]);
    const optOwner = await optOrder(owner.entries.get('products.csv'));
    const optNow = await optOrder(after.entries.get('products.csv'));
    console.log(`[D5] OPT order: owner ${optOwner.slice(0, 4).join(' ')} | after restore ${optNow.slice(0, 4).join(' ')}`);
    expect.soft(optNow, 'sub product order inside OPT').toEqual(optOwner);
    expect.soft(left.mainProductsNotInZip, 'shipped main products left').toEqual([]);
    expect.soft(left.brandsNotInZip, 'shipped brands left').toEqual([]);
    expect.soft(left.coloursNotInZip, 'shipped colours left').toEqual([]);
    expect.soft(left.recycleBinSubProducts, 'shipped sub products in the Recycle Bin').toEqual([]);
    expect.soft(left.recycleBinMainProducts, 'shipped main products in the Recycle Bin').toEqual([]);
  }, 600_000);

  it('D6: with no opt-in (the default), no shipped sub product, main product or photo stays live beside the owner data', async () => {
    await freshInstall();
    const done = await restoreProductZip(owner.file, 'owner.zip', {}, admin);
    const after = await exported();
    const left = await leftovers();
    const products = compare('products.csv', owner.entries.get('products.csv'), after.entries.get('products.csv'));
    const ownerRows = linesOf(owner.entries.get('products.csv')).length - 1;
    const liveRows = linesOf(after.entries.get('products.csv')).length - 1;
    const opt2Photos = (await productByCode('OPT-0002'))!.images.length;
    console.log(`[D6] restore: created ${done.products.created}, updated ${done.products.updated}, notInFile ${done.rows.notInFile.length}, photos.notInZip ${JSON.stringify(done.photos.notInZip)}`);
    console.log(`[D6] sub products: owner zip ${ownerRows}, live after restore ${liveRows}; only after restore: ${JSON.stringify(products.onlyAfterRestore.slice(0, 12))} (+${Math.max(0, products.onlyAfterRestore.length - 12)} more)`);
    console.log(`[D6] OPT-0002 photos (none in the owner zip): ${opt2Photos}; leftovers ${JSON.stringify(left, null, 1)}`);

    expect.soft(liveRows, 'live sub products beyond the owner zip').toBe(ownerRows);
    expect.soft(opt2Photos, 'a shipped photo stays on a sub product the owner left without one').toBe(0);
    expect.soft(left.mainProductsNotInZip, 'shipped main products left').toEqual([]);
  }, 600_000);

  it('D9: a shipped load that failed on the first boot does not land on top of the owner data restored since', async () => {
    await resetData();
    // The first boot: the load is marked under way, then fails (here: its file cannot be read).
    await expect(
      loadShippedCatalogue({ zip: noZip, markdown: path.join(dir, 'no-such-catalogue.md') }),
    ).rejects.toThrow();
    // The panel starts anyway; the owner sets up and restores his zip into the empty catalogue.
    await setUpFirstRun('Owner Ceramics');
    admin = await testActor();
    await restoreProductZip(owner.file, 'owner.zip', {}, admin);
    const restored = await exported();
    const exactBefore = compare('products.csv', owner.entries.get('products.csv'), restored.entries.get('products.csv'));

    // Any later boot (a restart, an update).
    const loaded = await loadShippedCatalogue({ zip: noZip });
    const after = await exported();
    const left = await leftovers();
    const products = compare('products.csv', owner.entries.get('products.csv'), after.entries.get('products.csv'));
    console.log(
      `[D9] restore into the empty catalogue exact: ${exactBefore.onlyAfterRestore.length === 0 && exactBefore.onlyInOwnersZip.length === 0}; ` +
        `next boot loadShippedCatalogue -> ${String(loaded)}; sub product rows only after that boot: ${products.onlyAfterRestore.length} ` +
        `${JSON.stringify(products.onlyAfterRestore.slice(0, 3))}; leftovers ${JSON.stringify({ main: left.mainProductsNotInZip, brands: left.brandsNotInZip, colours: left.coloursNotInZip })}`,
    );
    expect.soft(products.onlyAfterRestore, 'shipped sub products added over the owner data').toEqual([]);
    expect.soft(left.mainProductsNotInZip, 'shipped main products added over the owner data').toEqual([]);
    expect.soft(left.brandsNotInZip, 'shipped brand added over the owner data').toEqual([]);
    expect.soft(left.coloursNotInZip, 'shipped colour brought back over the owner data').toEqual([]);
  }, 600_000);

  it('D7: after the restore, the next boot and an update with a changed photo set leave the owner data alone', async () => {
    await freshInstall();
    await restoreProductZip(owner.file, 'owner.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const opt4Own = (await productByCode('OPT-0004'))!.images[0]!;

    // The next boot.
    expect(await loadShippedCatalogue({ zip: noZip })).toBeNull();
    expect(await attachCataloguePhotos(shipped)).toBeNull();

    // His OPT-0004 photo's files gone (a copied data folder): the shipped OPT-0004.jpg must not be written in.
    await rm(path.join(tenantImagesDir, opt4Own.id), { recursive: true, force: true });
    const names = (await readdir(shipped)).filter((name) => name.endsWith('.jpg'));
    const heal = await healMissingImageFiles(admin.tenantId, shipped, names);
    expect(heal).toMatchObject({ missing: 1, healed: 0, unsourced: 1 });

    // An update whose photo set differs by one file.
    await writeFile(path.join(shipped, 'WB-0002.jpg'), await jpeg('#abcdef'));
    const rerun = await attachCataloguePhotos(shipped);
    const opt2 = (await productByCode('OPT-0002'))!.images.length;
    const wb2 = (await productByCode('WB-0002'))!.images.length;
    console.log(`[D7] update with a changed photo set -> ${JSON.stringify(rerun)}; OPT-0002 photos ${opt2}, WB-0002 photos ${wb2} (owner zip has none for either)`);
    expect.soft(opt2, 'shipped photo attached to an owner sub product after his restore').toBe(0);
    expect.soft(wb2, 'shipped photo attached to an owner sub product after his restore').toBe(0);
  }, 600_000);
});
