/**
 * Gallery ordering across a delete (`7-IMAGE-PIPELINE.md` §3.3). Separated from
 * `images.integration.test.ts`, which pins the normalize/store/serve contract
 * on an untouched gallery — this one only cares what `sequence` a new photo
 * gets once the gallery has holes in it, since `loadImagesFor` orders on that
 * column alone and two rows sharing a value order arbitrarily.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from './helpers/fixtures.js';
import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import * as catalog from '../src/services/catalog.service.js';
import * as imageService from '../src/services/image.service.js';

let actor: ActorContext;
let testTenantImagesDir: string;

const CROP = { cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100, rotationDeg: 0 };

async function uploadPhoto(productId: string, shade: number) {
  const fileBuffer = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: shade, g: shade, b: shade } },
  })
    .jpeg()
    .toBuffer();

  return imageService.uploadImage({ productId, fileBuffer, crop: CROP }, actor);
}

// Same scoping rule as `images.integration.test.ts`: `config.imagesDir` is the
// real data directory, so cleanup never reaches past the throwaway tenant's
// own subdirectory.
describe.skipIf(!canRunIntegrationTests)('product image sequencing (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
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

  it('numbers a new photo past the highest sequence in use, not by the photo count', async () => {
    const product = await catalog.createProduct({ productCode: 'PRD-IMGSEQ', name: 'Gapped Gallery' }, actor);

    await uploadPhoto(product.id, 10);
    await uploadPhoto(product.id, 20);
    const afterThird = await uploadPhoto(product.id, 30);

    // The middle photo, leaving sequences 0 and 2 occupied and 1 free.
    await imageService.deleteImage(afterThird.images[1]!.id, actor);
    const afterFourth = await uploadPhoto(product.id, 40);

    const sequences = afterFourth.images.map((image) => image.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(afterFourth.images.filter((image) => image.isPrimary)).toHaveLength(1);
  });
});
