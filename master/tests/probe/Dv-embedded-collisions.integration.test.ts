/**
 * Probe, lens D (verifier): the owner's product zip restored onto a NEW install
 * of the current build, where the first boot already loaded the shipped
 * catalogue. Defects the D audit did not list: the shipped rows collide with
 * the owner's own and change or refuse his data. Each case is also restored
 * into an EMPTY catalogue, which shows the file itself is fine.
 *
 * Each `it` asserts what the owner asked for; a failing one is a defect.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { db } from '../../src/db/knex.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { openZipReader } from '../../src/lib/archive-zip.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import { seedCatalogue } from '../../src/services/catalogue-seed.service.js';
import {
  exportProductZip,
  loadShippedCatalogue,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
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
let tenantImagesDir: string;

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
  (bytes ?? Buffer.alloc(0)).toString('utf8').trimStart().split(/\r?\n/).filter(Boolean);

function onlyIn(owner?: Buffer, now?: Buffer) {
  const mine = linesOf(owner);
  const after = linesOf(now);
  return {
    onlyInOwnersZip: mine.filter((line) => !after.includes(line)),
    onlyAfterRestore: after.filter((line) => !mine.includes(line)),
  };
}

/** A fresh install of the current build: the first boot loads the shipped catalogue, then setup. */
async function freshInstall(): Promise<void> {
  await resetData();
  expect(await loadShippedCatalogue({ zip: noZip })).toBe('markdown');
  await setUpFirstRun('Owner Ceramics');
  admin = await testActor();
}

/** An install whose catalogue is empty (the shipped load never ran or the catalogue was emptied). */
async function emptyInstall(): Promise<void> {
  await resetData();
  await setUpFirstRun('Owner Ceramics');
  admin = await testActor();
}

/** The owner's install: the shipped catalogue as his install got it, then one edit. */
async function ownerZipAfter(edit: () => Promise<void>) {
  await resetData();
  await setUpFirstRun('Owner Ceramics');
  admin = await testActor();
  await seedCatalogue({ actor: admin });
  await edit();
  customFieldRepo.invalidateFieldCache(admin.tenantId);
  return exported();
}

describe.skipIf(!canRunIntegrationTests)('probe Dv: shipped rows colliding with the owner zip (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-dv-zip-'));
  }, 180_000);
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await teardownDatabase();
  });

  it('Dv1: a main product whose code the owner changed is restored onto a fresh install, not refused', async () => {
    // He changed One Piece Toilet's code OPT to TOI on the Main products screen (same name, same brand).
    const owner = await ownerZipAfter(async () => {
      const opt = (await productRepo.listCategories(admin.tenantId)).find((main) => main.code === 'OPT')!;
      await catalog.updateCategory(opt.id, { code: 'TOI' }, admin);
    });
    const toiRows = linesOf(owner.entries.get('products.csv')).filter((line) => line.includes(',TOI,')).length;
    expect(toiRows).toBeGreaterThan(0);

    // Into an empty catalogue: exact.
    await emptyInstall();
    await restoreProductZip(owner.file, 'owner.zip', {}, admin);
    const intoEmpty = onlyIn(owner.entries.get('products.csv'), (await exported()).entries.get('products.csv'));

    // Onto the fresh install, both opt-ins ticked.
    await freshInstall();
    const preview = await previewProductZip(owner.file, 'owner.zip', admin);
    const done = await restoreProductZip(owner.file, 'owner.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const after = await exported();
    const diff = onlyIn(owner.entries.get('products.csv'), after.entries.get('products.csv'));
    const mains = (await productRepo.listCategories(admin.tenantId)).map((main) => `${main.code} ${main.name} (${main.subProductCount})`);
    const errors = (report: typeof done) => report.products.issues.filter((issue) => issue.kind === 'error');
    console.log(
      `[Dv1] owner zip TOI rows ${toiRows}; into an empty catalogue exact: ${intoEmpty.onlyInOwnersZip.length === 0 && intoEmpty.onlyAfterRestore.length === 0}; ` +
        `fresh install: preview main products added ${JSON.stringify(preview.mainProducts.added)}, preview row errors ${errors(preview).length}, ` +
        `restore row errors ${errors(done).length} (first: ${JSON.stringify(errors(done)[0] ?? null)}), failed ${done.products.failed}, binned ${done.binned}; ` +
        `rows only in the owner zip after restore: ${diff.onlyInOwnersZip.length}, rows only after restore: ${diff.onlyAfterRestore.length}; ` +
        `main products OPT/TOI now: ${JSON.stringify(mains.filter((main) => /^(OPT|TOI) /.test(main)))}`,
    );
    expect.soft(intoEmpty.onlyInOwnersZip, 'into an empty catalogue').toEqual([]);
    expect.soft(diff.onlyInOwnersZip.length, 'owner rows missing after the restore onto a fresh install').toBe(0);
    expect.soft(mains.some((main) => main.startsWith('TOI ')), 'the owner main product TOI exists').toBe(true);
  }, 600_000);

  it('Dv2: the owner brand spelling survives a restore onto a fresh install', async () => {
    // His brand is written "SWISWARE+" (the Brands list and every main product).
    const owner = await ownerZipAfter(async () => {
      await db()('product_categories').update({ brand: 'SWISWARE+' });
      await db()('option_lists')
        .where({ list_key: 'product.brand', value: 'Swisware+' })
        .update({ value: 'SWISWARE+', label: 'SWISWARE+' });
    });
    expect(owner.entries.get('main-products.csv')!.toString('utf8')).toContain('SWISWARE+,OPT,');

    await emptyInstall();
    await restoreProductZip(owner.file, 'owner.zip', {}, admin);
    const intoEmpty = onlyIn(owner.entries.get('main-products.csv'), (await exported()).entries.get('main-products.csv'));

    await freshInstall();
    const preview = await previewProductZip(owner.file, 'owner.zip', admin);
    await restoreProductZip(owner.file, 'owner.zip', { binMissingProducts: true, removeMissingPhotos: true }, admin);
    const diff = onlyIn(owner.entries.get('main-products.csv'), (await exported()).entries.get('main-products.csv'));
    const brands = (await customFieldRepo.listOptionsForKey(admin.tenantId, 'product.brand')).map((brand) => brand.value);
    console.log(
      `[Dv2] into an empty catalogue main-products.csv exact: ${intoEmpty.onlyInOwnersZip.length === 0 && intoEmpty.onlyAfterRestore.length === 0}; ` +
        `fresh install: preview renamed ${preview.mainProducts.renamed.length},main-products.csv rows changed ${diff.onlyInOwnersZip.length} ` +
        `(e.g. ${JSON.stringify(diff.onlyAfterRestore[0] ?? null)}); Brands list ${JSON.stringify(brands)}`,
    );
    expect.soft(intoEmpty.onlyInOwnersZip, 'into an empty catalogue').toEqual([]);
    expect.soft(diff.onlyInOwnersZip, 'owner brand spelling after the restore onto a fresh install').toEqual([]);
    expect.soft(brands, 'the owner brand in the Brands list').toContain('SWISWARE+');
  }, 600_000);
});
