/**
 * Probe, lens D: what the boot steps a new build runs (`loadShippedCatalogue`,
 * `attachCataloguePhotos`) do to an install that UPDATES. The owner's rule:
 * an update leaves every record exactly as it was.
 *
 * Each `it` asserts the behaviour the owner asked for; a failing one is a defect.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { db } from '../../src/db/knex.js';
import type { ActorContext } from '../../src/domain/actor.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import { attachCataloguePhotos, CATALOGUE_PHOTOS_MARKER } from '../../src/services/catalogue-photos.service.js';
import { seedCatalogue } from '../../src/services/catalogue-seed.service.js';
import * as imageService from '../../src/services/image.service.js';
import { loadShippedCatalogue, SHIPPED_CATALOGUE_MARKER } from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import {
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from '../helpers/fixtures.js';

const noZip = path.join(os.tmpdir(), 'orderbook-probe-d-no-such-catalogue.zip');
const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } }).jpeg().toBuffer();

let actor: ActorContext;
let shipped: string;
let tenantImagesDir: string;

async function count(table: string, live = false): Promise<number> {
  let query = db()(table);
  if (live) query = query.whereNull('deleted_at');
  const row = await query.count('* as n').first<{ n: string }>();
  return Number(row?.n);
}

async function productByCode(code: string) {
  const { items } = await productRepo.listProducts(actor.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === code));
}

/** The product data an update must leave alone, as Postgres renders it. */
async function productDump(): Promise<Record<string, string[]>> {
  const dump: Record<string, string[]> = {};
  for (const table of ['product_categories', 'products', 'product_variants', 'product_images', 'option_lists']) {
    const { rows } = await db().raw<{ rows: Array<{ j: string }> }>(
      `SELECT row_to_json(t)::text AS j FROM ?? t ORDER BY 1`,
      [table],
    );
    dump[table] = rows.map((row) => row.j);
  }
  return dump;
}

describe.skipIf(!canRunIntegrationTests)('probe D: an update boot and the shipped catalogue (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
  }, 180_000);
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    if (shipped) await rm(shipped, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    if (shipped) await rm(shipped, { recursive: true, force: true });
    shipped = await mkdtemp(path.join(os.tmpdir(), 'probe-d-shipped-'));
  });

  it('D1: an install set up on 1.4.6 with no products gets no shipped catalogue when it updates', async () => {
    // 1.4.6 never wrote the marker: a set-up install with parties and an empty catalogue.
    await setUpFirstRun('Old Install Ceramics');
    actor = await testActor();
    await catalog.createParty({ name: 'Existing Party' }, actor);
    const optionsBefore = await db()('option_lists').whereIn('list_key', ['product.brand', 'stock.colour']).count('* as n').first();
    expect(await db()('settings').where({ key: SHIPPED_CATALOGUE_MARKER }).first()).toBeUndefined();

    // The first boot of the new build.
    const loaded = await loadShippedCatalogue({ zip: noZip });
    console.log(
      `[D1] loadShippedCatalogue on an updated, set-up install with an empty catalogue -> ${String(loaded)}; ` +
        `main products ${await count('product_categories', true)}, sub products ${await count('products', true)}`,
    );

    expect.soft(loaded, 'the update loaded the shipped catalogue').not.toBe('markdown');
    expect.soft(await count('product_categories')).toBe(0);
    expect.soft(await count('products')).toBe(0);
    expect
      .soft(await db()('option_lists').whereIn('list_key', ['product.brand', 'stock.colour']).count('* as n').first())
      .toEqual(optionsBefore);
  }, 180_000);

  it('D2: an install with products: the update boot (same photo set) changes no product data', async () => {
    await setUpFirstRun('Old Install Ceramics');
    actor = await testActor();
    await seedCatalogue({ actor });
    await writeFile(path.join(shipped, 'OPT-0001.jpg'), await jpeg('#ff0000'));
    await writeFile(path.join(shipped, 'OPT-0002.jpg'), await jpeg('#00ff00'));
    // The 1.4.6 boot: photos attached, the set recorded.
    expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 2 });
    // The company removed one photo on purpose, renamed and weighed one sub product.
    const opt2 = (await productByCode('OPT-0002'))!;
    await imageService.deleteImage(opt2.images[0]!.id, actor);
    await db()('products').where({ id: (await productByCode('OPT-0004'))!.id }).update({ alias: 'Owner alias' });
    await db()('product_variants').where({ code: 'OPT-0005' }).update({ weight_kg: 21.5 });

    const before = await productDump();
    expect(await loadShippedCatalogue({ zip: noZip })).toBe('none');
    expect(await attachCataloguePhotos(shipped)).toBeNull();
    expect(await productDump()).toEqual(before);
  }, 180_000);

  it('D3: a later update that ships a changed photo set does not bring back a photo the company removed', async () => {
    await setUpFirstRun('Old Install Ceramics');
    actor = await testActor();
    await seedCatalogue({ actor });
    await writeFile(path.join(shipped, 'OPT-0001.jpg'), await jpeg('#ff0000'));
    await writeFile(path.join(shipped, 'OPT-0002.jpg'), await jpeg('#00ff00'));
    expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 2 });
    const opt2 = (await productByCode('OPT-0002'))!;
    await imageService.deleteImage(opt2.images[0]!.id, actor);
    const wb1Before = (await productByCode('WB-0001'))!.images.length;

    // The next build's photo set differs by one file (a photo fixed or added, as ba367329 did).
    await writeFile(path.join(shipped, 'WB-0001.jpg'), await jpeg('#0000ff'));
    const rerun = await attachCataloguePhotos(shipped);
    const opt2After = (await productByCode('OPT-0002'))!.images.length;
    const wb1After = (await productByCode('WB-0001'))!.images.length;
    console.log(
      `[D3] changed photo set -> ${JSON.stringify(rerun)}; OPT-0002 photos (company removed it): ${opt2After}; ` +
        `WB-0001 photos before/after the update: ${wb1Before}/${wb1After}`,
    );
    expect.soft(opt2After, 'the update re-attached a photo the company deleted').toBe(0);
    expect.soft(wb1After, 'the update added a photo to a sub product the company left without one').toBe(wb1Before);
  }, 180_000);

  it('D8: a heal never writes the shipped photo over a sharper photo the company put in its place', async () => {
    await setUpFirstRun('Old Install Ceramics');
    actor = await testActor();
    await seedCatalogue({ actor });
    // One picture, two sizes: the shipped 48x32 photo, and the company's own 480x320 of the same view.
    const width = 480;
    const height = 320;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 3;
        pixels[at] = Math.round((x / width) * 255);
        pixels[at + 1] = Math.round((y / height) * 255);
        pixels[at + 2] = 128;
      }
    }
    const big = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(path.join(shipped, 'OPT-0001.jpg'), await sharp(big).resize(48, 32).jpeg().toBuffer());
    expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 1 });

    const opt1 = (await productByCode('OPT-0001'))!;
    await imageService.deleteImage(opt1.images[0]!.id, actor);
    const whole = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };
    const own = (await imageService.uploadImage({ productId: opt1.id, fileBuffer: big, crop: whole, wholeFrame: true }, actor)).images[0]!;
    // Its files gone (a copied data folder), the next boot heals.
    await rm(path.join(tenantImagesDir, own.id), { recursive: true, force: true });
    const { healMissingImageFiles } = await import('../../src/services/catalogue-photos.service.js');
    const heal = await healMissingImageFiles(actor.tenantId, shipped, ['OPT-0001.jpg']);
    const after = (await productByCode('OPT-0001'))!.images[0]!;
    console.log(
      `[D8] heal ${JSON.stringify(heal)}; company photo was ${own.width}x${own.height} ${own.checksum.slice(0, 12)}, ` +
        `now ${after.width}x${after.height} ${after.checksum.slice(0, 12)}`,
    );
    expect.soft(heal.healed, 'the shipped photo was written into the company photo').toBe(0);
    expect.soft({ width: after.width, height: after.height, checksum: after.checksum }).toEqual({
      width: own.width,
      height: own.height,
      checksum: own.checksum,
    });
  }, 180_000);

  it('D4: an install whose photo run was never recorded (a failed photo) re-attaches a removed photo on every boot', async () => {
    await setUpFirstRun('Old Install Ceramics');
    actor = await testActor();
    await seedCatalogue({ actor });
    await writeFile(path.join(shipped, 'OPT-0002.jpg'), await jpeg('#00ff00'));
    // A file that matches a sub product but cannot be decoded: the run fails one photo, so no marker.
    await writeFile(path.join(shipped, 'OPT-0006.jpg'), Buffer.from('not a picture'));
    expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 1, failed: 1 });
    expect(await db()('settings').where({ key: CATALOGUE_PHOTOS_MARKER }).first()).toBeUndefined();

    const opt2 = (await productByCode('OPT-0002'))!;
    await imageService.deleteImage(opt2.images[0]!.id, actor);
    // The next boot (or update).
    await attachCataloguePhotos(shipped);
    const after = (await productByCode('OPT-0002'))!.images.length;
    console.log(`[D4] boot after a run with a failed photo: OPT-0002 photos (company removed it): ${after}`);
    expect.soft(after, 'a boot re-attached a photo the company deleted').toBe(0);
  }, 180_000);
});
