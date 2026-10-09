/**
 * Probe, lens D (verifier): on a NEW install the first boot loads the shipped
 * catalogue, starts the panel, and only then attaches the shipped photos in the
 * background (`index.ts`: `void attachCataloguePhotos()`), which takes minutes
 * for 549 photos. The owner sets up and restores his product zip meanwhile.
 * `startProductRestore` does not wait for the attach, and the attach plans once
 * at its start and never looks again before each upload.
 *
 * Asserts what the owner asked for: after his restore (both opt-ins ticked) the
 * only photos are the ones his zip carries.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { db } from '../../src/db/knex.js';
import type { ActorContext } from '../../src/domain/actor.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import { attachCataloguePhotos } from '../../src/services/catalogue-photos.service.js';
import { seedCatalogue } from '../../src/services/catalogue-seed.service.js';
import * as imageService from '../../src/services/image.service.js';
import { exportProductZip, loadShippedCatalogue, restoreProductZip } from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import {
  resetData,
  setUpFirstRun,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from '../helpers/fixtures.js';

const noZip = path.join(os.tmpdir(), 'orderbook-probe-dv-no-such-catalogue.zip');

let admin: ActorContext;
let dir: string;
let shipped: string;
let tenantImagesDir: string;

/** A photo that takes a real encode: 1200x900 of noise. */
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

async function photosByCode(): Promise<Map<string, number>> {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  const out = new Map<string, number>();
  for (const product of items) {
    if (product.images.length > 0) out.set(product.variants[0]!.code, product.images.length);
  }
  return out;
}

describe.skipIf(!canRunIntegrationTests)('probe Dv: the first-boot photo attach racing the owner restore (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-dv-race-'));
    shipped = await mkdtemp(path.join(os.tmpdir(), 'probe-dv-race-shipped-'));
  }, 180_000);
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rm(shipped, { recursive: true, force: true });
    await teardownDatabase();
  });

  it('Dv3: a restore made while the first-boot photo attach runs ends with only the owner photos', async () => {
    // The owner's catalogue: the shipped rows, one photo of his own on OPT-0001, no other photo.
    await resetData();
    await setUpFirstRun('Owner Ceramics');
    admin = await testActor();
    await seedCatalogue({ actor: admin });
    const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
    const opt1 = items.find((product) => product.variants[0]!.code === 'OPT-0001')!;
    const whole = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };
    await imageService.uploadImage({ productId: opt1.id, fileBuffer: await noisyJpeg(999), crop: whole, wholeFrame: true }, admin);
    const { filePath } = await exportProductZip(admin);
    const ownerZip = path.join(dir, `${randomUUID()}.zip`);
    await copyFile(filePath, ownerZip);
    await rm(filePath, { force: true });

    // The build's photos: 120 of the shipped codes, OPT-0001 among them.
    const codes = items.map((product) => product.variants[0]!.code).slice(0, 120);
    for (const [index, code] of codes.entries()) await writeFile(path.join(shipped, `${code}.jpg`), await noisyJpeg(index + 1));

    // A fresh install: the awaited shipped load, then the panel starts and the attach runs behind it.
    await resetData();
    expect(await loadShippedCatalogue({ zip: noZip })).toBe('markdown');
    const attaching = attachCataloguePhotos(shipped);
    await setUpFirstRun('Owner Ceramics');
    admin = await testActor();
    // The owner restores once the first shipped photo is in.
    for (let tries = 0; tries < 600; tries += 1) {
      if (Number((await db()('product_images').count('* as n').first<{ n: string }>())?.n) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const atRestoreStart = Number((await db()('product_images').count('* as n').first<{ n: string }>())?.n);
    const report = await restoreProductZip(ownerZip, 'owner.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const afterRestore = await photosByCode();
    const attach = await attaching;
    const final = await photosByCode();

    const notTheOwners = [...final.entries()].filter(([code]) => code !== 'OPT-0001');
    console.log(
      `[Dv3] shipped photos in when the restore began: ${atRestoreStart}; restore photosRemoved ${report.photosRemoved}; ` +
        `right after the restore: ${afterRestore.size} sub products with photos (OPT-0001: ${afterRestore.get('OPT-0001') ?? 0}); ` +
        `attach finished ${JSON.stringify({ attached: attach?.attached, skipped: attach?.skipped, failed: attach?.failed })}; ` +
        `final: OPT-0001 photos ${final.get('OPT-0001') ?? 0}, other sub products with a shipped photo ${notTheOwners.length} (e.g. ${JSON.stringify(notTheOwners.slice(0, 3))})`,
    );
    expect.soft(notTheOwners.length, 'shipped photos on sub products the owner zip carries none for').toBe(0);
    expect.soft(final.get('OPT-0001') ?? 0, 'OPT-0001 carries only the owner photo').toBe(1);
  }, 600_000);
});
