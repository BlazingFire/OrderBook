/**
 * Probe, lens C verifier: the 1.2.5-1.4.6 Main products export
 * (`main-products-YYYY-MM-DD.csv`, `git show ac573d66:master/src/services/product-import.service.ts`,
 * `buildProductExport` level `main`: Brand, Main product code, Main product, Sub products)
 * beside the sub product export in a restore zip, and C6's Apply over the same catalogue.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { createZipWriter } from '../../src/lib/archive-zip.js';
import { toCsv } from '../../src/lib/csv.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import { importProducts } from '../../src/services/product-import.service.js';
import { exportProductZip, restoreProductZip } from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import { resetData, setupDatabase, teardownDatabase, testActor, testTenantId } from '../helpers/fixtures.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

let admin: ActorContext;
let dir: string;

async function zipOf(entries: Array<[string, Buffer]>): Promise<string> {
  const file = path.join(dir, `${randomUUID()}.zip`);
  const writer = createZipWriter(file);
  for (const [name, bytes] of entries) await writer.appendEntry(name, [bytes], { store: true });
  await writer.finalize();
  return file;
}

/** The 1.4.6 main-level export of the fixture's catalogue, plus one main product that has no sub products yet. */
const mainExport = (): Buffer =>
  Buffer.from(
    '﻿' +
      toCsv(
        ['Brand', 'Main product code', 'Main product', 'Sub products'],
        [
          ['Swisware+', 'OPT', 'One Piece Toilet', 2],
          ['Swisware+', 'OPB', 'One Piece Basin', 1],
          ['Swisware+', 'EMP', 'Empty Main', 0],
          ['Swisware+', 'WB', 'Wash Basin', 2],
          ['Another Co', 'TNK', 'Cistern', 1],
        ],
      ),
    'utf8',
  );

const mains = async () => (await productRepo.listCategories(admin.tenantId)).map((main) => main.code);

describe.skipIf(!canRunIntegrationTests)('lens C verifier: the 1.4.6 Main products export (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
  }, 120_000);
  afterAll(async () => {
    await rm(path.join(config.imagesDir, await testTenantId()), { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-cv-'));
  });

  it('Cv1 checked: named main-products.csv, the 1.4.6 main export restores an empty main product in its place', async () => {
    const file = await zipOf([
      ['products.csv', await readFile(path.join(FIXTURES, 'products-export-1.2.5.csv'))],
      ['main-products.csv', mainExport()],
    ]);
    const done = await restoreProductZip(file, 'old.zip', {}, admin);
    expect(done.products).toMatchObject({ created: 6, failed: 0 });
    expect(await mains()).toEqual(['OPT', 'OPB', 'EMP', 'WB', 'TNK']);
  });

  it('Cv1 demonstrates: under its downloaded name the 1.4.6 main export is ignored without a word, and a main product with no sub products is lost', async () => {
    const file = await zipOf([
      ['products.csv', await readFile(path.join(FIXTURES, 'products-export-1.2.5.csv'))],
      ['main-products-2026-10-07.csv', mainExport()],
    ]);
    const done = await restoreProductZip(file, 'old.zip', {}, admin);
    expect({ problems: done.problems, mains: await mains() }).toEqual({
      problems: [],
      mains: ['OPT', 'OPB', 'EMP', 'WB', 'TNK'],
    });
  });

  it('C6 apply (verifies the auditor): the unedited zip of a 1.2.0-template multicolour sub product with colours, applied over the same catalogue, changes it', async () => {
    const template = [
      'categoryName,name,variant,code,weightKg,alias,size,multiColour',
      'Wash Basin,DAMRU,Blue,DM-01,6.5,Damru,18x12,yes',
      'Wash Basin,DAMRU,Ivory,DM-02,6.6,Damru,18x12,yes',
    ].join('\r\n');
    await importProducts(
      { buffer: Buffer.from(template + '\r\n', 'utf8'), fileName: 'products-template.csv' },
      { dryRun: false, mode: 'create' },
      admin,
    );
    const variants = async () =>
      (await productRepo.listProducts(admin.tenantId, { limit: 10, offset: 0 })).items[0]!.variants
        .filter((variant) => variant.isActive)
        .map((variant) => [variant.code, variant.label]);
    const before = await variants();

    const { filePath } = await exportProductZip(admin);
    const zip = path.join(dir, 'backup.zip');
    await copyFile(filePath, zip);
    await rm(filePath, { force: true });
    await restoreProductZip(zip, 'backup.zip', {}, admin);

    expect(before).toEqual([
      ['DM-01', 'Blue'],
      ['DM-02', 'Ivory'],
    ]);
    expect(await variants()).toEqual(before);
  });
});
