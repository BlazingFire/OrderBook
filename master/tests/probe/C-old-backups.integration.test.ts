/**
 * Probe, lens C: a whole-Master backup an earlier version wrote, restored on
 * the current Master — does the product catalogue (main products with code,
 * brand and order; sub products with colours, weights and variants; the colour
 * list with hex; photos) come back exactly, and does the product backup zip
 * then read it as unchanged?
 *
 * 1.4.6 (ac573d66) knows every migration up to `20261015000000_catalogue_corrections`;
 * the current build adds `notice_placement`, `product_image_source_checksum`
 * and `notice_sell_today`. Both backup formats 1.4.6 wrote are rebuilt at that
 * level from a real export of this build: the "back up everything" archive
 * (format 2, `archive-restore.service.ts`) and the encrypted `.obbackup`
 * (format 1, `backup-restore.service.ts`), with the three migrations' columns
 * taken out of the rows.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { ArchiveManifest } from '@orderbook/shared';
import { BACKUP_FORMAT_VERSION } from '@orderbook/shared';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { db } from '../../src/db/knex.js';
import { migrations } from '../../src/db/migrations/index.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { MANIFEST_ENTRY, MAX_MANIFEST_BYTES, tableEntryName } from '../../src/domain/archive.js';
import { createZipWriter, openZipReader } from '../../src/lib/archive-zip.js';
import { encryptBackup } from '../../src/lib/backup-crypto.js';
import { dumpTable, listUserTables, tenantScopedTables } from '../../src/repositories/backup.repository.js';
import * as customFieldRepo from '../../src/repositories/custom-field.repository.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import { exportArchive } from '../../src/services/archive-export.service.js';
import { restoreArchive } from '../../src/services/archive-restore.service.js';
import { restoreBackup } from '../../src/services/backup-restore.service.js';
import * as catalog from '../../src/services/catalog.service.js';
import * as fields from '../../src/services/fields.service.js';
import * as imageService from '../../src/services/image.service.js';
import { exportProductZip, previewProductZip } from '../../src/services/product-zip.service.js';
import { getIdentity } from '../../src/services/setup.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase, testActor } from '../helpers/fixtures.js';

const LAST_1_4_6 = '20261015000000_catalogue_corrections';
const NEWER_COLUMNS: Record<string, string[]> = {
  product_images: ['source_checksum'],
  notices: ['show_on_home', 'show_at_sign_in', 'kind', 'product_ids', 'auto_close_seconds', 'show_from'],
};

let folder: string;
let actor: ActorContext;

const jpeg = (background: string) =>
  sharp({ create: { width: 64, height: 40, channels: 3, background } })
    .jpeg()
    .toBuffer();

/** A catalogue with everything the owner named: codes, brands, order, colours with hex, weights, variants, photos. */
async function buildCatalogue(): Promise<void> {
  await fields.createValue({ listKey: 'product.brand', value: 'Swisware+', label: 'Swisware+', hex: null }, actor);
  await fields.createValue({ listKey: 'stock.colour', value: 'Zz Blue', label: 'Zz Blue', hex: '#1A2B3C' }, actor);
  await fields.createValue({ listKey: 'stock.colour', value: 'Zz Ivory', label: 'Zz Ivory', hex: '#FFFFF0' }, actor);
  const wb = await catalog.createCategory({ name: 'Wash Basin', code: 'WB', brand: 'Swisware+', sortOrder: 2 }, actor);
  const opt = await catalog.createCategory({ name: 'One Piece Toilet', code: 'OPT', brand: 'Swisware+', sortOrder: 1 }, actor);
  await catalog.createProduct(
    { categoryId: opt.id, name: '102', size: '9", L-27, B-15, H-26', variants: [{ code: 'OPT-0001', label: 'Zz Blue', weightKg: 32.5 }], hasVariants: true },
    actor,
  );
  await catalog.createProduct(
    {
      categoryId: wb.id,
      name: 'DAMRU',
      alias: 'Damru',
      hasVariants: true,
      variants: [
        { code: 'WB-0001', label: 'Zz Blue', weightKg: 6.5 },
        { code: 'WB-0002', label: 'Zz Ivory', weightKg: 6.75 },
      ],
    },
    actor,
  );
  await catalog.createProduct({ categoryId: wb.id, name: 'ANY', multiColour: true, variants: [{ code: 'WB-0003', weightKg: 7 }] }, actor);
  const damru = (await productRepo.listProducts(actor.tenantId, { limit: 100, offset: 0 })).items.find(
    (product) => product.name === 'DAMRU',
  )!;
  for (const colour of ['#ff0000', '#00ff00']) {
    await imageService.uploadImage(
      {
        productId: damru.id,
        fileBuffer: await jpeg(colour),
        crop: { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 },
        wholeFrame: true,
      },
      actor,
    );
  }
}

/** Everything the owner named, as it reads back. */
async function catalogue() {
  const mains = await productRepo.listCategories(actor.tenantId);
  const { items } = await productRepo.listProducts(actor.tenantId, { limit: 100_000, offset: 0 });
  const colours = await customFieldRepo.listOptionsForKey(actor.tenantId, 'stock.colour');
  const photos = [];
  for (const product of items) {
    for (const image of product.images) {
      const file = path.join(config.imagesDir, actor.tenantId, image.id, 'master.webp');
      const bytes = await readFile(file).catch(() => null);
      photos.push({
        product: product.name,
        id: image.id,
        primary: image.isPrimary,
        checksum: image.checksum,
        file: bytes ? createHash('sha256').update(bytes).digest('hex') : 'missing',
      });
    }
  }
  return {
    mains: mains.map((main) => ({ code: main.code, name: main.name, brand: main.brand, sortOrder: main.sortOrder })),
    subs: items.map((product) => ({
      main: product.categoryCode,
      name: product.name,
      size: product.size,
      alias: product.alias,
      multiColour: product.multiColour,
      hasVariants: product.hasVariants,
      variants: product.variants.map((variant) => [variant.code, variant.label, variant.weightKg, variant.isActive]),
    })),
    colours: colours.filter((option) => option.value.startsWith('Zz')).map((option) => [option.value, option.hex]),
    photos,
  };
}

/** The keys a 1.4.6 row did not have. */
function withoutNewerColumns(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  for (const column of NEWER_COLUMNS[table] ?? []) delete copy[column];
  return copy;
}

/** This build's archive rewritten to the 1.4.6 schema level (as `archive-replay.integration.test.ts` does). */
async function archiveAt146(source: string, target: string): Promise<void> {
  const reader = await openZipReader(source);
  const manifest = JSON.parse(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST_BYTES)) as ArchiveManifest;
  const writer = createZipWriter(target);
  try {
    for (const { name } of reader.entries) {
      if (name === MANIFEST_ENTRY) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.openStream(name)) chunks.push(chunk as Buffer);
      let data = Buffer.concat(chunks);
      const table = Object.keys(NEWER_COLUMNS).find((candidate) => tableEntryName(candidate) === name);
      if (table) {
        const lines = data
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.stringify(withoutNewerColumns(table, JSON.parse(line) as Record<string, unknown>)));
        data = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
      }
      const digest = await writer.appendEntry(name, [data]);
      const tableEntry = manifest.tables.find((entry) => tableEntryName(entry.name) === name);
      if (tableEntry) Object.assign(tableEntry, digest);
      const upload = manifest.uploads.find((entry) => entry.path === name);
      if (upload) Object.assign(upload, digest);
    }
    const names = migrations.map((migration) => migration.name);
    const keep = new Set(names.slice(0, names.indexOf(LAST_1_4_6) + 1));
    manifest.appliedMigrations = manifest.appliedMigrations.filter((name) => keep.has(name));
    manifest.appVersion = '1.4.6';
    await writer.appendEntry(MANIFEST_ENTRY, [JSON.stringify(manifest)]);
    await writer.finalize();
  } catch (error) {
    writer.abort();
    throw error;
  } finally {
    reader.close();
  }
}

/** A 1.4.6 `.obbackup`: every table's rows (as `exportBackup` dumps them) without the newer columns. */
async function obbackupAt146(passphrase: string): Promise<Buffer> {
  const identity = (await getIdentity())!;
  const scoped = await tenantScopedTables();
  const dump: Record<string, Record<string, unknown>[]> = {};
  for (const table of await listUserTables()) {
    dump[table] = (await dumpTable(table, null, scoped.has(table), db())).map((row) => withoutNewerColumns(table, row));
  }
  const payload = gzipSync(Buffer.from(JSON.stringify({ tables: dump }), 'utf8'));
  return encryptBackup(
    {
      formatVersion: BACKUP_FORMAT_VERSION,
      sourcePanelType: 'master',
      sourcePanelId: identity.masterUniqueId,
      scope: 'whole',
      scopeDetail: [actor.tenantId],
      createdAt: new Date().toISOString(),
      appVersion: '1.4.6',
    },
    payload,
    passphrase,
  );
}

/** The product backup zip of the catalogue as it is now, kept in `folder`. */
async function productZip(): Promise<string> {
  const { filePath } = await exportProductZip(actor);
  const file = path.join(folder, 'products.zip');
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return file;
}

describe.skipIf(!canRunIntegrationTests)('lens C: a 1.4.6 whole backup restored on this build (integration)', () => {
  beforeAll(setupDatabase, 120_000);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    await setUpFirstRun('Old Ceramics');
    actor = await testActor();
    folder = await mkdtemp(path.join(os.tmpdir(), 'probe-c-backup-'));
    await buildCatalogue();
  }, 120_000);
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
    await rm(path.join(config.imagesDir, actor.tenantId), { recursive: true, force: true });
  });

  it('C8 checked: a 1.4.6 "back up everything" archive brings the catalogue back whole, and the product zip then reads it as unchanged', async () => {
    const before = await catalogue();
    expect(before.photos).toHaveLength(2);
    const zip = await productZip();

    const exported = await exportArchive({ folder, actor });
    const older = path.join(folder, 'older.zip');
    await archiveAt146(exported.path, older);
    // Fact, not a verdict: the products cannot be taken out of it on their own; Restore from .zip refuses it.
    await expect(previewProductZip(older, 'older.zip', actor)).rejects.toMatchObject({
      messageKey: 'validation.productZip.noProductsCsv',
    });

    // Things change after the backup: a sub product goes, a photo goes.
    const damru = (await productRepo.listProducts(actor.tenantId, { limit: 100, offset: 0 })).items.find(
      (product) => product.name === 'DAMRU',
    )!;
    await imageService.deleteImage(damru.images[0]!.id, actor);
    await catalog.deleteProduct(damru.id, actor);

    await restoreArchive(older, { mode: 'replace', actor });
    actor = await testActor();

    expect(await catalogue()).toEqual(before);
    const preview = await previewProductZip(zip, 'products.zip', actor);
    expect({
      products: preview.products,
      mains: preview.mainProducts,
      colours: preview.colours,
      photos: preview.photos,
      problems: preview.problems,
    }).toMatchObject({
      products: { created: 0, updated: 0, unchanged: 4, failed: 0 },
      mains: { added: [], renamed: [] },
      colours: { added: [], changed: [] },
      photos: { added: [], replaced: [], unchanged: 2, notInZip: [] },
      problems: [],
    });
  }, 120_000);

  it('C9 checked: a 1.4.6 .obbackup restored on the same PC brings the catalogue rows back, photos included while their files are on disk', async () => {
    const before = await catalogue();
    const zip = await productZip();
    const passphrase = 'correct horse battery staple';
    const file = await obbackupAt146(passphrase);

    const damru = (await productRepo.listProducts(actor.tenantId, { limit: 100, offset: 0 })).items.find(
      (product) => product.name === 'DAMRU',
    )!;
    await catalog.deleteProduct(damru.id, actor);

    await restoreBackup(file, passphrase, true, actor);
    actor = await testActor();

    expect(await catalogue()).toEqual(before);
    const preview = await previewProductZip(zip, 'products.zip', actor);
    expect(preview.products).toMatchObject({ created: 0, updated: 0, unchanged: 4, failed: 0 });
    expect(preview.photos).toMatchObject({ added: [], replaced: [], unchanged: 2 });
  }, 120_000);
});
