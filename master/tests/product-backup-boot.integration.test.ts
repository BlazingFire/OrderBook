/**
 * What a boot does to an install's catalogue (`loadShippedCatalogue`,
 * `attachCataloguePhotos`), and how the shipped photos stand beside a restore
 * (`restoreProductZip`, `restoreArchive`). The owner's rule: an update never
 * changes an install's data; the shipped catalogue and its photos land only on
 * a brand-new install, once, and never beside or after the catalogue the
 * company restores.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as settingsRepo from '../src/repositories/settings.repository.js';
import { exportArchive } from '../src/services/archive-export.service.js';
import { restoreArchive } from '../src/services/archive-restore.service.js';
import * as catalog from '../src/services/catalog.service.js';
import { attachCataloguePhotos, CATALOGUE_PHOTOS_MARKER } from '../src/services/catalogue-photos.service.js';
import { seedCatalogue } from '../src/services/catalogue-seed.service.js';
import * as imageService from '../src/services/image.service.js';
import {
  exportProductZip,
  loadShippedCatalogue,
  restoreProductZip,
  SHIPPED_CATALOGUE_MARKER,
} from '../src/services/product-zip.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

const noZip = path.join(os.tmpdir(), 'orderbook-no-such-catalogue.zip');
const WHOLE = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };

let admin: ActorContext;
let dir: string;
let shipped: string;
let tenantImagesDir: string;

const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } })
    .jpeg()
    .toBuffer();

/** A photo that takes a real encode, so a run of them lasts long enough to start something in. */
async function noisyJpeg(seed: number): Promise<Buffer> {
  const width = 1200;
  const height = 900;
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed * 2654435761;
  for (let at = 0; at < pixels.length; at += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    pixels[at] = state >>> 24;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

const code = (n: number) => `BAS-${String(n).padStart(4, '0')}`;

/** Sub products BAS-0001 … under one coded main product, as a shipped load would leave them. */
async function basins(count: number): Promise<void> {
  await catalog.createCategory({ name: 'Basins', code: 'BAS' }, admin);
  for (let n = 1; n <= count; n += 1) {
    await catalog.createProduct({ name: `Basin ${n}`, categoryCode: 'BAS', variants: [{ code: code(n) }] }, admin);
  }
}

/** What a load of the printed catalogue records (`loadCatalogue`), for a catalogue made here. */
const printedCatalogueLoaded = (value: object = { state: 'done', loaded: 'markdown' }) =>
  db().transaction((trx) =>
    settingsRepo.upsertSetting(admin.tenantId, SHIPPED_CATALOGUE_MARKER, value, false, 1, null, trx),
  );

const marker = async (key: string) =>
  (await db()('settings').where({ key }).first())?.value as Record<string, unknown> | undefined;

async function productByCode(wanted: string) {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === wanted))!;
}

const photos = async (wanted: string) => (await productByCode(wanted)).images;

async function imageCount(): Promise<number> {
  return Number((await db()('product_images').count('* as n').first<{ n: string }>())?.n);
}

const count = async (table: string) =>
  Number((await db()(table).count('* as n').first<{ n: string }>())?.n);

/** Until the attach running in the background has written its first photo. */
async function untilAPhotoIsIn(): Promise<void> {
  for (let tries = 0; tries < 1200; tries += 1) {
    if ((await imageCount()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the attach wrote no photo in a minute');
}

/** The shipped photos `<code>.jpg` for BAS-0001 … BAS-<count>, each a real encode. */
async function shipNoisyPhotos(count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) await writeFile(path.join(shipped, `${code(n)}.jpg`), await noisyJpeg(n));
}

async function ownerZip(): Promise<string> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return file;
}

describe.skipIf(!canRunIntegrationTests)('the shipped catalogue and its photos on boot, and a restore (integration)', () => {
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
    admin = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'product-backup-boot-'));
    shipped = path.join(dir, 'shipped');
    await mkdir(shipped);
  });

  describe('the shipped catalogue', () => {
    it('D1: an install already set up gets nothing from an update boot, even with an empty catalogue', async () => {
      await setUpFirstRun('Updated Ceramics');
      const options = await count('option_lists');

      expect(await loadShippedCatalogue({ zip: noZip })).toBe('none');
      expect(await count('product_categories')).toBe(0);
      expect(await count('products')).toBe(0);
      expect(await count('option_lists')).toBe(options);
      expect(await marker(SHIPPED_CATALOGUE_MARKER)).toMatchObject({ state: 'done', loaded: 'none' });
      expect(await loadShippedCatalogue({ zip: noZip })).toBeNull();
    });

    it('an update boot leaves an install with products, its photos attached by an earlier build, exactly as it was', async () => {
      await setUpFirstRun('Old Install Ceramics');
      await basins(2);
      await printedCatalogueLoaded();
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));
      await writeFile(path.join(shipped, `${code(2)}.jpg`), await jpeg('#0000ff'));
      expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 2 });
      // 1.4.6 recorded no shipped load; the company removed one photo and renamed a sub product.
      await db()('settings').where({ key: SHIPPED_CATALOGUE_MARKER }).delete();
      await imageService.deleteImage((await photos(code(1)))[0]!.id, admin);
      await db()('products').where({ id: (await productByCode(code(2))).id }).update({ alias: 'Own alias' });

      const dump = async () => {
        const rows: Record<string, string[]> = {};
        for (const table of ['product_categories', 'products', 'product_variants', 'product_images', 'option_lists']) {
          const { rows: json } = await db().raw<{ rows: Array<{ j: string }> }>(
            'SELECT row_to_json(t)::text AS j FROM ?? t ORDER BY 1',
            [table],
          );
          rows[table] = json.map((row) => row.j);
        }
        return rows;
      };
      const before = await dump();
      expect(await loadShippedCatalogue({ zip: noZip })).toBe('none');
      expect(await attachCataloguePhotos(shipped)).toBeNull();
      expect(await dump()).toEqual(before);
    });

    it('D5: a load that failed on the first boot is never carried on over what the company set up since', async () => {
      await expect(
        loadShippedCatalogue({ zip: noZip, markdown: path.join(dir, 'no-such-catalogue.md') }),
      ).rejects.toThrow();
      expect(await marker(SHIPPED_CATALOGUE_MARKER)).toMatchObject({ state: 'loading' });

      // The panel started all the same: the company set up and restored its own catalogue.
      await setUpFirstRun('Owner Ceramics');
      await basins(1);
      const options = await count('option_lists');

      expect(await loadShippedCatalogue({ zip: noZip })).toBe('none');
      expect(await count('product_categories')).toBe(1);
      expect(await count('products')).toBe(1);
      expect(await count('option_lists')).toBe(options);
      expect(await marker(SHIPPED_CATALOGUE_MARKER)).toMatchObject({ state: 'done', loaded: 'none' });
    });
  });

  describe('the shipped photos', () => {
    it('D6: attach once; a later build with a changed set brings back no photo the company removed, and adds none', async () => {
      await basins(2);
      await printedCatalogueLoaded();
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));
      expect(await attachCataloguePhotos(shipped)).toMatchObject({ files: 1, attached: 1, skipped: 0, failed: 0 });

      await imageService.deleteImage((await photos(code(1)))[0]!.id, admin);
      await writeFile(path.join(shipped, `${code(2)}.jpg`), await jpeg('#0000ff'));

      expect(await attachCataloguePhotos(shipped)).toBeNull();
      expect(await photos(code(1))).toHaveLength(0);
      expect(await photos(code(2))).toHaveLength(0);
    });

    it('D6: a run with a failed photo is the one run too: it is recorded, and a photo removed since stays removed', async () => {
      await basins(2);
      await printedCatalogueLoaded();
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));
      await writeFile(path.join(shipped, `${code(2)}.jpg`), Buffer.from('not a picture'));

      expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 1, failed: 1 });
      expect(await marker(CATALOGUE_PHOTOS_MARKER)).toMatchObject({ attached: 1, failed: 1 });

      await imageService.deleteImage((await photos(code(1)))[0]!.id, admin);
      expect(await attachCataloguePhotos(shipped)).toBeNull();
      expect(await photos(code(1))).toHaveLength(0);
    });

    it('a run with no photo files is the one run too: a later build that ships photos attaches none on the update', async () => {
      await basins(1);
      await printedCatalogueLoaded();

      expect(await attachCataloguePhotos(shipped)).toMatchObject({ files: 0, attached: 0 });
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));
      expect(await attachCataloguePhotos(shipped)).toBeNull();
      expect(await photos(code(1))).toHaveLength(0);
    });

    it("the run's own photo 2 of a sub product lands beside its photo 1", async () => {
      await basins(1);
      await printedCatalogueLoaded();
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));
      await writeFile(path.join(shipped, `${code(1)}_2.jpg`), await jpeg('#0000ff'));

      expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 2, skipped: 0 });
      expect(await photos(code(1))).toHaveLength(2);
    });

    it('D6: an install that never loaded the printed catalogue gets no shipped photo', async () => {
      await basins(1);
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));

      // From 1.4.4 or earlier: no record of either.
      expect(await attachCataloguePhotos(shipped)).toBeNull();
      // Set up or holding products when the shipped load first ran; a build that shipped
      // products.zip, which carries its own photos; a load still under way.
      for (const value of [
        { state: 'done', loaded: 'none' },
        { state: 'done', loaded: 'zip' },
        { state: 'loading', loaded: 'markdown' },
      ]) {
        await printedCatalogueLoaded(value);
        expect(await attachCataloguePhotos(shipped)).toBeNull();
      }
      expect(await photos(code(1))).toHaveLength(0);
      expect(await marker(CATALOGUE_PHOTOS_MARKER)).toBeUndefined();
    });

    it('an explicit load of the printed catalogue gets the shipped photos on the next boot, once', async () => {
      await seedCatalogue({ actor: admin });
      expect(await marker(SHIPPED_CATALOGUE_MARKER)).toMatchObject({ state: 'done', loaded: 'markdown' });
      await writeFile(path.join(shipped, 'OPT-0001.jpg'), await jpeg('#00ff00'));

      expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 1 });
      expect(await photos('OPT-0001')).toHaveLength(1);
      expect(await attachCataloguePhotos(shipped)).toBeNull();
      expect(await loadShippedCatalogue({ zip: noZip })).toBeNull();
    }, 120_000);
  });

  describe('a restore and the shipped photos', () => {
    it('B9: a product restore retires the attach for good, even after a first run that recorded nothing', async () => {
      // The company's catalogue: a photo of its own on BAS-0002, none on BAS-0001.
      await basins(2);
      await imageService.uploadImage({ productId: (await productByCode(code(2))).id, fileBuffer: await jpeg('#aa0000'), crop: WHOLE, wholeFrame: true }, admin);
      const owner = await ownerZip();

      // A new install: the shipped catalogue and photos, the run closed before it recorded itself.
      await resetData();
      await basins(2);
      await printedCatalogueLoaded();
      await writeFile(path.join(shipped, `${code(1)}.jpg`), await jpeg('#00ff00'));
      await writeFile(path.join(shipped, `${code(2)}.jpg`), await jpeg('#0000ff'));
      expect(await attachCataloguePhotos(shipped)).toMatchObject({ attached: 2 });
      await db()('settings').where({ key: CATALOGUE_PHOTOS_MARKER }).delete();

      await restoreProductZip(owner, 'owner.zip', { removeMissingPhotos: true }, admin);
      expect([(await photos(code(1))).length, (await photos(code(2))).length]).toEqual([0, 1]);
      expect(await marker(CATALOGUE_PHOTOS_MARKER)).toMatchObject({ retired: true });

      // The next boot.
      expect(await attachCataloguePhotos(shipped)).toBeNull();
      expect([(await photos(code(1))).length, (await photos(code(2))).length]).toEqual([0, 1]);
    });

    it('B6, Dv3: a product restore stops the attach under way before it plans; no shipped photo lands beside or after the owner photo', async () => {
      const files = 10;
      await basins(files);
      // The owner's photo is on the sub product the attach reaches last.
      await imageService.uploadImage({ productId: (await productByCode(code(files))).id, fileBuffer: await jpeg('#aa0000'), crop: WHOLE, wholeFrame: true }, admin);
      const owner = await ownerZip();

      await resetData();
      await basins(files);
      await printedCatalogueLoaded();
      await shipNoisyPhotos(files);

      // Unawaited, as on boot; the owner restores once the first shipped photo is in.
      const attaching = attachCataloguePhotos(shipped);
      await untilAPhotoIsIn();
      await restoreProductZip(owner, 'owner.zip', {}, admin);
      const afterRestore = await imageCount();
      const attach = await attaching;

      expect(await photos(code(files))).toHaveLength(1);
      expect(await imageCount()).toBe(afterRestore);
      expect(attach?.attached).toBeLessThan(files - 1);
      expect(await marker(CATALOGUE_PHOTOS_MARKER)).toMatchObject({ retired: true });
      expect(await attachCataloguePhotos(shipped)).toBeNull();
    }, 300_000);

    it('a full backup restore stops the attach before it copies or replaces anything', async () => {
      await setUpFirstRun('Owner Ceramics');
      admin = await testActor();
      const files = 10;
      await basins(files);
      const archive = await exportArchive({ folder: dir, actor: admin });

      await printedCatalogueLoaded();
      await shipNoisyPhotos(files);
      const attaching = attachCataloguePhotos(shipped);
      let settled = false;
      void attaching.then(() => (settled = true));
      await untilAPhotoIsIn();
      await restoreArchive(archive.path, { mode: 'replace', actor: admin });

      // Stopped before the restore went on, between two photos: none of its
      // uploads ran into the copy or the replay, and none came after.
      expect(settled).toBe(true);
      const attach = (await attaching)!;
      expect(attach.failed).toBe(0);
      expect(attach.attached).toBeLessThan(files - 1);
      expect(attach.attached + attach.skipped).toBe(files);
      // The archive's catalogue had no photo.
      expect(await imageCount()).toBe(0);
    }, 300_000);

    it('onlyIfEmpty: the attach adds nothing beside a photo the company put in while it ran', async () => {
      const files = 8;
      await basins(files);
      await printedCatalogueLoaded();
      await shipNoisyPhotos(files);

      const attaching = attachCataloguePhotos(shipped);
      await untilAPhotoIsIn();
      // The sub product the attach reaches last, planned as having no photo.
      const own = await imageService.uploadImage(
        { productId: (await productByCode(code(files))).id, fileBuffer: await jpeg('#aa0000'), crop: WHOLE, wholeFrame: true },
        admin,
      );

      expect(await attaching).toMatchObject({ attached: files - 1, skipped: 1, failed: 0 });
      expect((await photos(code(files))).map((image) => image.id)).toEqual(own.images.map((image) => image.id));
    }, 300_000);

    it('onlyIfEmpty: an upload to a sub product that has a photo adds nothing and leaves no files behind', async () => {
      await basins(1);
      const productId = (await productByCode(code(1))).id;
      await imageService.uploadImage({ productId, fileBuffer: await jpeg('#aa0000'), crop: WHOLE, wholeFrame: true }, admin);
      const folders = (await readdir(tenantImagesDir)).sort();

      await expect(
        imageService.uploadImage(
          { productId, fileBuffer: await jpeg('#00aa00'), crop: WHOLE, wholeFrame: true, onlyIfEmpty: true },
          admin,
        ),
      ).rejects.toBeInstanceOf(imageService.GalleryTakenError);
      expect(await photos(code(1))).toHaveLength(1);
      expect((await readdir(tenantImagesDir)).sort()).toEqual(folders);
    });
  });
});
