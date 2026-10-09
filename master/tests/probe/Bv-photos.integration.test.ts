/**
 * Lens B, verifier's probes: photo defects in the product backup zip
 * (`services/product-zip.service.ts`) the first audit did not report. Each
 * `Bv<n>:` test asserts what a backup and restore should do and fails on
 * ad15b2a2. Values worth reading are logged with a `PROBE` prefix.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { galleryOrder, type Product, type ProductInput } from '@orderbook/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { db } from '../../src/db/knex.js';
import { createZipWriter, openZipReader } from '../../src/lib/archive-zip.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import { seedCatalogue } from '../../src/services/catalogue-seed.service.js';
import * as imageService from '../../src/services/image.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../../src/services/product-zip.service.js';
import { canRunIntegrationTests } from '../helpers/db.js';
import {
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from '../helpers/fixtures.js';

let admin: ActorContext;
let dir: string;
let tenantImagesDir: string;

const WHOLE = { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0 };
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } }).jpeg().toBuffer();

async function allProducts(): Promise<Product[]> {
  return (await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 })).items;
}

async function productByCode(code: string): Promise<Product | undefined> {
  return (await allProducts()).find((product) => product.variants.some((variant) => variant.code === code));
}

async function addPhoto(code: string, bytes: Buffer, caption?: string | null): Promise<string> {
  const product = await productByCode(code);
  if (!product) throw new Error(`no product ${code}`);
  const updated = await imageService.uploadImage(
    {
      productId: product.id,
      fileBuffer: bytes,
      crop: { ...WHOLE, ...(caption !== undefined ? { caption } : {}) },
      wholeFrame: true,
    },
    admin,
  );
  return [...updated.images].sort((a, b) => b.sequence - a.sequence)[0]!.id;
}

interface Shot {
  id: string;
  checksum: string;
  source: string | null;
}

async function gallery(code: string): Promise<Shot[]> {
  const product = await productByCode(code);
  if (!product) return [];
  const ids = galleryOrder(product);
  const rows = (await db()('product_images')
    .whereIn('id', ids)
    .select('id', 'checksum', 'source_checksum')) as Array<{ id: string; checksum: string; source_checksum: string | null }>;
  return ids.map((id) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    return { id, checksum: row.checksum, source: row.source_checksum };
  });
}

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

async function zipOf(entries: Iterable<[string, Buffer]>): Promise<string> {
  const file = path.join(dir, `${randomUUID()}.zip`);
  const writer = createZipWriter(file);
  for (const [name, bytes] of entries) await writer.appendEntry(name, [bytes], { store: true });
  await writer.finalize();
  return file;
}

async function exported(): Promise<{ file: string; entries: Map<string, Buffer> }> {
  const { filePath } = await exportProductZip(admin);
  const file = path.join(dir, `${randomUUID()}.zip`);
  await copyFile(filePath, file);
  await rm(filePath, { force: true });
  return { file, entries: await entriesOf(file) };
}

async function singleCodes(): Promise<string[]> {
  return (await allProducts())
    .filter((product) => !product.hasVariants && product.variants.length === 1)
    .map((product) => product.variants[0]!.code);
}

describe.skipIf(!canRunIntegrationTests)('lens B verifier: photos in the product backup zip (probe)', () => {
  beforeAll(async () => {
    await setupDatabase();
    tenantImagesDir = path.join(config.imagesDir, await testTenantId());
  }, 120_000);
  afterAll(async () => {
    await rm(tenantImagesDir, { recursive: true, force: true });
    await teardownDatabase();
  });
  beforeEach(async () => {
    await resetData();
    admin = await testActor();
    await seedCatalogue({ actor: admin });
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-bv-'));
  }, 120_000);

  it('Bv1: restoring a backup onto a gallery with a newer photo in front never leaves the backed-up picture there twice', async () => {
    const [code] = await singleCodes();
    // The backup: one photo, Y.
    const y = await addPhoto(code!, await jpeg('#aa0000'), 'Front');
    const yChecksum = (await gallery(code!))[0]!.checksum;
    const { file } = await exported();
    // Since then a new photo X was added and made the main photo: the gallery is [X, Y].
    const x = await addPhoto(code!, await jpeg('#00aa00'));
    await imageService.updateImageCaption(x, { isPrimary: true }, admin);
    expect((await gallery(code!)).map((shot) => shot.id)).toEqual([x, y]);

    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await gallery(code!);
    const copiesOfY = after.filter((shot) => shot.checksum === yChecksum || shot.source === yChecksum);
    console.log(
      `PROBE Bv1 preview ${JSON.stringify({ replaced: preview.photos.replaced, unchanged: preview.photos.unchanged, notInZip: preview.photos.notInZip })}; ` +
        `after: ${after.length} photos, copies of the backed-up picture ${copiesOfY.length}, X still there ${after.some((shot) => shot.id === x)}`,
    );
    expect(copiesOfY).toHaveLength(1);
  }, 120_000);

  it('Bv2: restoring the same zip twice adds nothing when two colour codes of one sub product each name a photo 1', async () => {
    const host = (await allProducts())[0]!;
    await catalog.createProduct(
      {
        name: 'Probe Twin',
        categoryId: host.categoryId,
        hasVariants: true,
        variants: [
          { code: 'PRB-0001', label: 'White' },
          { code: 'PRB-0002', label: 'Ivory' },
        ],
      } as ProductInput,
      admin,
    );
    const { entries } = await exported();
    // One picture per colour, named by that colour's code, as the photo import reads a folder.
    const white = await jpeg('#f0f0f0');
    const ivory = await jpeg('#fff0d0');
    const edited = new Map(entries);
    edited.set('images/PRB-0001.jpg', white);
    edited.set('images/PRB-0002.jpg', ivory);
    const file = await zipOf(edited);

    const first = await restoreProductZip(file, 'p.zip', {}, admin);
    const once = await gallery('PRB-0001');
    const preview = await previewProductZip(file, 'p.zip', admin);
    const second = await restoreProductZip(file, 'p.zip', {}, admin);
    const twice = await gallery('PRB-0001');
    const pictures = (shots: Shot[]) => shots.map((shot) => (shot.source === sha(white) ? 'white' : shot.source === sha(ivory) ? 'ivory' : '?'));
    console.log(
      `PROBE Bv2 first run added ${JSON.stringify(first.photos.added)} -> ${JSON.stringify(pictures(once))}; ` +
        `second preview replaced ${JSON.stringify(preview.photos.replaced)} unchanged ${preview.photos.unchanged}; ` +
        `second run replaced ${JSON.stringify(second.photos.replaced)} -> ${JSON.stringify(pictures(twice))}`,
    );
    expect(pictures(once).sort()).toEqual(['ivory', 'white']);
    expect(second.photos).toMatchObject({ added: [], replaced: [] });
    expect(twice.map((shot) => shot.id)).toEqual(once.map((shot) => shot.id));
  }, 120_000);

  it('Bv3: a photo whose files are missing at backup time is named in the README, not left out silently', async () => {
    const [a, b] = await singleCodes();
    await addPhoto(a!, await jpeg('#aa0000'));
    const lost = await addPhoto(b!, await jpeg('#00aa00'));
    await rm(path.join(tenantImagesDir, lost), { recursive: true, force: true });

    const { entries } = await exported();
    const readme = entries.get('README.txt')!.toString('utf8');
    const name = (await productByCode(b!))!.name;
    const images = [...entries.keys()].filter((entry) => entry.startsWith('images/'));
    console.log(`PROBE Bv3 images ${JSON.stringify(images)}; README names ${name}: ${readme.includes(name)}; README has NOT IN THIS ZIP: ${readme.includes('NOT IN THIS ZIP')}`);
    expect(images).toEqual([`images/${a}.webp`]);
    expect(readme).toContain(name);
  }, 120_000);
});
