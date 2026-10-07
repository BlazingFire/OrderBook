/**
 * The product picker's rows carry the product's primary photo, for the thumbnail on the new
 * pending order: the first image only (a thumbnail, not a gallery), and an empty list when the
 * product has none.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import * as catalog from '../src/services/catalog.service.js';
import * as imageService from '../src/services/image.service.js';
import * as searchService from '../src/services/search.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;
let tenantImagesDir: string;

const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } })
    .jpeg()
    .toBuffer();

const crop = { cropX: 0, cropY: 0, cropWidth: 48, cropHeight: 32, rotationDeg: 0 };

describe.skipIf(!canRunIntegrationTests)('product picker photos (integration)', () => {
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
  });

  it('sends the primary photo only, and none for a product without one', async () => {
    const pictured = await catalog.createProduct(
      { categoryName: 'Basins', variants: [{ code: 'PK-0001' }], name: 'Pictured' },
      actor,
    );
    const bare = await catalog.createProduct(
      { categoryName: 'Basins', variants: [{ code: 'PK-0002' }], name: 'Bare' },
      actor,
    );
    const first = await imageService.uploadImage(
      { productId: pictured.id, fileBuffer: await jpeg('#ff0000'), crop },
      actor,
    );
    await imageService.uploadImage(
      { productId: pictured.id, fileBuffer: await jpeg('#00ff00'), crop },
      actor,
    );
    const primaryId = first.images.find((image) => image.isPrimary)!.id;

    const page = await searchService.pick(
      'product',
      { term: '', categoryId: pictured.categoryId },
      actor,
    );
    const items = page.items as Array<{
      id: string;
      images: Array<{ id: string; isPrimary: boolean }>;
    }>;
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get(pictured.id)!.images.map((image) => image.id)).toEqual([primaryId]);
    expect(byId.get(pictured.id)!.images[0]!.isPrimary).toBe(true);
    expect(byId.get(bare.id)!.images).toEqual([]);
  });
});
