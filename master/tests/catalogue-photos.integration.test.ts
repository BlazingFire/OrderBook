/**
 * The catalogue photos attached on boot (`services/catalogue-photos.service.ts`):
 * only where a sub product has no photo, once per shipped set.
 */

import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import * as catalog from '../src/services/catalog.service.js';
import { attachCataloguePhotos, healMissingImageFiles } from '../src/services/catalogue-photos.service.js';
import * as imageService from '../src/services/image.service.js';
import * as productRepo from '../src/repositories/product.repository.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;
let dir: string;
let tenantImagesDir: string;

const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } }).jpeg().toBuffer();

async function imagesOf(productId: string) {
  return (await productRepo.findProductById(actor.tenantId, productId))!.images;
}

describe.skipIf(!canRunIntegrationTests)('catalogue photos on boot (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    const { testTenantId } = await import('./helpers/fixtures.js');
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
  });
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'catalogue-photos-'));
  });

  it('attaches a photo only where there is none, and leaves the company photo alone', async () => {
    const bare = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0001' }], name: 'Oval' }, actor);
    const pictured = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0002' }], name: 'Round' }, actor);
    const own = await imageService.uploadImage(
      { productId: pictured.id, fileBuffer: await jpeg('#ff0000'), crop: { cropX: 0, cropY: 0, cropWidth: 48, cropHeight: 32, rotationDeg: 0 } },
      actor,
    );

    await writeFile(path.join(dir, 'BAS-0001.jpg'), await jpeg('#00ff00'));
    await writeFile(path.join(dir, 'BAS-0002.jpg'), await jpeg('#0000ff'));
    await writeFile(path.join(dir, 'NOPE-0001.jpg'), await jpeg('#000000'));

    const result = await attachCataloguePhotos(dir);

    expect(result).toMatchObject({ files: 3, attached: 1, skipped: 2, failed: 0 });
    expect(await imagesOf(bare.id)).toHaveLength(1);
    expect((await imagesOf(pictured.id)).map((image) => image.id)).toEqual(own.images.map((image) => image.id));
  });

  it('adds no shipped second photo beside one the company added', async () => {
    const pictured = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0007' }], name: 'Deep' }, actor);
    await imageService.uploadImage(
      { productId: pictured.id, fileBuffer: await jpeg('#ff0000'), crop: { cropX: 0, cropY: 0, cropWidth: 48, cropHeight: 32, rotationDeg: 0 } },
      actor,
    );
    await writeFile(path.join(dir, 'BAS-0007_2.jpg'), await jpeg('#00ff00'));

    expect(await attachCataloguePhotos(dir)).toMatchObject({ attached: 0, skipped: 1 });
    expect(await imagesOf(pictured.id)).toHaveLength(1);
  });

  it('does not run the same set twice, even after the company removed the photo', async () => {
    const bare = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0003' }], name: 'Square' }, actor);
    await writeFile(path.join(dir, 'BAS-0003.jpg'), await jpeg('#00ff00'));

    await attachCataloguePhotos(dir);
    const [attached] = await imagesOf(bare.id);
    await imageService.deleteImage(attached!.id, actor);

    expect(await attachCataloguePhotos(dir)).toBeNull();
    expect(await imagesOf(bare.id)).toHaveLength(0);
  });

  it('runs a changed set once more, adding only where a photo is still missing', async () => {
    const first = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0004' }], name: 'Wide' }, actor);
    const second = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0005' }], name: 'Narrow' }, actor);
    await writeFile(path.join(dir, 'BAS-0004.jpg'), await jpeg('#00ff00'));
    await attachCataloguePhotos(dir);

    await writeFile(path.join(dir, 'BAS-0005.jpg'), await jpeg('#0000ff'));
    const rerun = await attachCataloguePhotos(dir);

    expect(rerun).toMatchObject({ attached: 1, skipped: 1 });
    expect(await imagesOf(first.id)).toHaveLength(1);
    expect(await imagesOf(second.id)).toHaveLength(1);
  });

  it('tries again on the next boot when no photo matched, as before the catalogue is loaded', async () => {
    await writeFile(path.join(dir, 'BAS-0006.jpg'), await jpeg('#00ff00'));
    expect(await attachCataloguePhotos(dir)).toMatchObject({ attached: 0, skipped: 1 });

    const later = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0006' }], name: 'Late' }, actor);
    expect(await attachCataloguePhotos(dir)).toMatchObject({ attached: 1 });
    expect(await imagesOf(later.id)).toHaveLength(1);
  });

  it('writes missing photo files again on boot, under the same id, even after the set already ran', async () => {
    const bare = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0010' }], name: 'Healed' }, actor);
    await writeFile(path.join(dir, 'BAS-0010.jpg'), await jpeg('#00ff00'));
    await attachCataloguePhotos(dir);
    const [before] = await imagesOf(bare.id);
    const folder = path.join(tenantImagesDir, before!.id);
    await rm(folder, { recursive: true, force: true });

    // The set's marker is recorded, so nothing is attached; the files still come back.
    expect(await attachCataloguePhotos(dir)).toBeNull();
    expect((await readdir(folder)).sort()).toEqual(['large.webp', 'master.webp', 'micro.webp', 'thumb.webp']);
    const [after] = await imagesOf(bare.id);
    expect(after).toMatchObject({ id: before!.id, checksum: before!.checksum, sequence: before!.sequence, isPrimary: true });

    // A second boot finds every file and does nothing.
    expect(await healMissingImageFiles(actor.tenantId, dir, ['BAS-0010.jpg'])).toEqual({
      missing: 0,
      healed: 0,
      unsourced: 0,
      failed: 0,
    });
  });

  it('never writes a shipped photo over the files of one the company added, and keeps its row', async () => {
    const pictured = await catalog.createProduct({ categoryName: 'Basins', variants: [{ code: 'BAS-0011' }], name: 'Own' }, actor);
    const own = await imageService.uploadImage(
      { productId: pictured.id, fileBuffer: await jpeg('#ff0000'), crop: { cropX: 0, cropY: 0, cropWidth: 48, cropHeight: 32, rotationDeg: 0 } },
      actor,
    );
    const ownId = own.images[0]!.id;
    await rm(path.join(tenantImagesDir, ownId), { recursive: true, force: true });
    await writeFile(path.join(dir, 'BAS-0011.jpg'), await jpeg('#0000ff'));

    expect(await healMissingImageFiles(actor.tenantId, dir, ['BAS-0011.jpg'])).toEqual({
      missing: 1,
      healed: 0,
      unsourced: 1,
      failed: 0,
    });
    await expect(access(path.join(tenantImagesDir, ownId))).rejects.toThrow();
    expect((await imagesOf(pictured.id)).map((image) => image.id)).toEqual([ownId]);
  });

  it('does nothing when no photos are shipped', async () => {
    expect(await attachCataloguePhotos(path.join(dir, 'missing'))).toBeNull();
  });
});
