/**
 * Product image pipeline (`7-IMAGE-PIPELINE.md`), against a real Postgres and
 * real `sharp` processing — no browser needed, since the whole normalize/
 * store/serve contract lives in `image.service.ts`, exactly like every other
 * service this suite drives directly (`catalog.integration.test.ts` et al.).
 */

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import { NotFoundError } from '../src/lib/errors.js';
import * as catalog from '../src/services/catalog.service.js';
import * as imageService from '../src/services/image.service.js';

let actor: ActorContext;
let testTenantImagesDir: string;

async function testJpeg(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

// `config.imagesDir` is the real data directory this machine's dev Master
// server also reads from — never `rm` the whole thing. Everything this suite
// writes lands under the throwaway test tenant's own subdirectory (a distinct
// UUID from any real tenant, since the tenant itself lives in the throwaway
// Postgres cluster `setupDatabase` starts), so cleanup is scoped to exactly
// that one folder, both before and after, self-healing the same way
// `fixtures.ts`'s stray-role cleanup does for a previous crashed run.
describe.skipIf(!canRunIntegrationTests)('product images (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    const { testTenantId } = await import('./helpers/fixtures.js');
    testTenantImagesDir = path.join(config.imagesDir, await testTenantId());
    await rm(testTenantImagesDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await rm(testTenantImagesDir, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('normalizes a source photo into four on-disk WebP variants and returns them on the product', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG1', name: 'Glossy Floor Tile' }, actor);
    const source = await testJpeg(1200, 900, { r: 210, g: 140, b: 60 });

    const updated = await imageService.uploadImage(
      {
        productId: product.id,
        fileBuffer: source,
        crop: { cropX: 100, cropY: 50, cropWidth: 900, cropHeight: 700, rotationDeg: 0 },
      },
      actor,
    );

    expect(updated.images).toHaveLength(1);
    const image = updated.images[0]!;
    expect(image.isPrimary).toBe(true);
    expect(image.width).toBe(900);
    expect(image.height).toBe(700);
    expect(image.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(image.blurhash.length).toBeGreaterThan(0);
    expect(image.byteSize).toBeGreaterThan(0);

    const dir = path.join(config.imagesDir, actor.tenantId, image.id);
    for (const variant of ['master', 'large', 'thumb', 'micro'] as const) {
      const file = path.join(dir, `${variant}.webp`);
      expect(existsSync(file)).toBe(true);
    }

    // §2.2's long-edge table: a 900×700 crop is smaller than `large`'s 800px
    // long edge target only on some sides — `thumb`/`micro` must still have
    // shrunk, and none may have upscaled past the crop's own size.
    const thumbMeta = await sharp(path.join(dir, 'thumb.webp')).metadata();
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(240);
    const microMeta = await sharp(path.join(dir, 'micro.webp')).metadata();
    expect(Math.max(microMeta.width ?? 0, microMeta.height ?? 0)).toBeLessThanOrEqual(64);
    const masterMeta = await sharp(path.join(dir, 'master.webp')).metadata();
    expect(masterMeta.width).toBe(900);
    expect(masterMeta.height).toBe(700);

    // The checksum is of the file actually on disk, not a value computed
    // separately — verifiable the same way a replica would verify its copy.
    const masterBytes = await readFile(path.join(dir, 'master.webp'));
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(masterBytes).digest('hex')).toBe(image.checksum);
  });

  it('rejects a file that is not a decodable image, naming it (§2.1)', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG2', name: 'Bad Upload' }, actor);
    const notAnImage = Buffer.from('this is not an image');

    await expect(
      imageService.uploadImage(
        { productId: product.id, fileBuffer: notAnImage, crop: { cropX: 0, cropY: 0, cropWidth: 10, cropHeight: 10, rotationDeg: 0 } },
        actor,
      ),
    ).rejects.toThrow(/could not be read/i);
  });

  it('bakes a 90° rotation into the pixels before cropping', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG3', name: 'Rotated Tile' }, actor);
    // A 400×200 source rotated 90° becomes a 200×400 canvas to crop against.
    const source = await testJpeg(400, 200, { r: 20, g: 20, b: 20 });

    const updated = await imageService.uploadImage(
      {
        productId: product.id,
        fileBuffer: source,
        crop: { cropX: 0, cropY: 0, cropWidth: 200, cropHeight: 380, rotationDeg: 90 },
      },
      actor,
    );

    expect(updated.images[0]!.width).toBe(200);
    expect(updated.images[0]!.height).toBe(380);
  });

  it('refuses a crop rect that falls outside the rotated source', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG4', name: 'Out Of Bounds' }, actor);
    const source = await testJpeg(200, 200, { r: 1, g: 2, b: 3 });

    await expect(
      imageService.uploadImage(
        { productId: product.id, fileBuffer: source, crop: { cropX: 150, cropY: 150, cropWidth: 100, cropHeight: 100, rotationDeg: 0 } },
        actor,
      ),
    ).rejects.toThrow();
  });

  it('makes the first upload primary, and later uploads not primary, in sequence order', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG5', name: 'Multi Photo' }, actor);
    const crop = { cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100, rotationDeg: 0 };

    const afterFirst = await imageService.uploadImage(
      { productId: product.id, fileBuffer: await testJpeg(100, 100, { r: 1, g: 1, b: 1 }), crop },
      actor,
    );
    const afterSecond = await imageService.uploadImage(
      { productId: product.id, fileBuffer: await testJpeg(100, 100, { r: 2, g: 2, b: 2 }), crop },
      actor,
    );

    expect(afterFirst.images[0]!.isPrimary).toBe(true);
    const primary = afterSecond.images[0]!;
    const secondary = afterSecond.images[1]!;
    expect(primary.isPrimary).toBe(true);
    expect(secondary.isPrimary).toBe(false);
    expect(secondary.sequence).toBeGreaterThan(primary.sequence);
  });

  it('moves primary to the oldest remaining image when the primary is deleted', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG6', name: 'Delete Primary' }, actor);
    const crop = { cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100, rotationDeg: 0 };

    const afterFirst = await imageService.uploadImage(
      { productId: product.id, fileBuffer: await testJpeg(100, 100, { r: 1, g: 1, b: 1 }), crop },
      actor,
    );
    await imageService.uploadImage(
      { productId: product.id, fileBuffer: await testJpeg(100, 100, { r: 2, g: 2, b: 2 }), crop },
      actor,
    );

    const afterDelete = await imageService.deleteImage(afterFirst.images[0]!.id, actor);
    expect(afterDelete.images).toHaveLength(1);
    expect(afterDelete.images[0]!.isPrimary).toBe(true);
  });

  it('leaves an empty gallery, not an error, when the last image is deleted', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG7', name: 'Delete Only' }, actor);
    const uploaded = await imageService.uploadImage(
      {
        productId: product.id,
        fileBuffer: await testJpeg(100, 100, { r: 5, g: 5, b: 5 }),
        crop: { cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100, rotationDeg: 0 },
      },
      actor,
    );

    const afterDelete = await imageService.deleteImage(uploaded.images[0]!.id, actor);
    expect(afterDelete.images).toEqual([]);
  });

  it('rejects an incomplete reorder permutation', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG8', name: 'Reorder Guard' }, actor);
    const crop = { cropX: 0, cropY: 0, cropWidth: 50, cropHeight: 50, rotationDeg: 0 };
    const after = await imageService.uploadImage(
      { productId: product.id, fileBuffer: await testJpeg(50, 50, { r: 9, g: 9, b: 9 }), crop },
      actor,
    );
    await imageService.uploadImage(
      { productId: product.id, fileBuffer: await testJpeg(50, 50, { r: 8, g: 8, b: 8 }), crop },
      actor,
    );

    await expect(
      imageService.reorderImages({ productId: product.id, ids: [after.images[0]!.id] }, actor),
    ).rejects.toThrow();
  });

  it('IMG-9 — a caller without products.edit cannot upload, and one without products.view gets a 404-shaped refusal reading a variant', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMG9', name: 'Permission Guard' }, actor);
    const uploaded = await imageService.uploadImage(
      {
        productId: product.id,
        fileBuffer: await testJpeg(80, 80, { r: 3, g: 3, b: 3 }),
        crop: { cropX: 0, cropY: 0, cropWidth: 80, cropHeight: 80, rotationDeg: 0 },
      },
      actor,
    );
    const imageId = uploaded.images[0]!.id;

    const noEdit = await actorWith(['products.view']);
    await expect(
      imageService.uploadImage(
        {
          productId: product.id,
          fileBuffer: await testJpeg(80, 80, { r: 4, g: 4, b: 4 }),
          crop: { cropX: 0, cropY: 0, cropWidth: 80, cropHeight: 80, rotationDeg: 0 },
        },
        noEdit,
      ),
    ).rejects.toThrow();

    // Same exception type/shape whether the image is genuinely missing or the
    // caller simply cannot see it — §4.3's "404, not 403" contract.
    const noView = await actorWith([]);
    await expect(imageService.resolveImageFile(imageId, 'thumb', noView)).rejects.toBeInstanceOf(NotFoundError);
    await expect(imageService.resolveImageFile('00000000-0000-0000-0000-000000000000', 'thumb', actor)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The permitted actor can still read it.
    const file = await imageService.resolveImageFile(imageId, 'thumb', actor);
    expect(existsSync(file.path)).toBe(true);
  });
});
