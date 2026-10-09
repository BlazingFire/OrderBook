/**
 * The photos of the product backup zip (`services/product-zip.service.ts`)
 * against PostgreSQL and the real SWISWARE catalogue: a restore matches each
 * file by its bytes before its slot, carries every caption, keeps a photo's
 * bytes from one Master to the next, names a photo by another colour's code
 * rather than leave it out, and lists a photo whose files are missing.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { galleryOrder, type ProductInput } from '@orderbook/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';
import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { readSheetRows } from '../src/lib/spreadsheet.js';
import * as productRepo from '../src/repositories/product.repository.js';
import * as catalog from '../src/services/catalog.service.js';
import { seedCatalogue } from '../src/services/catalogue-seed.service.js';
import * as imageService from '../src/services/image.service.js';
import {
  exportProductZip,
  previewProductZip,
  restoreProductZip,
} from '../src/services/product-zip.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
  testTenantId,
} from './helpers/fixtures.js';

let admin: ActorContext;
let dir: string;
let tenantImagesDir: string;

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const jpeg = (background: string) =>
  sharp({ create: { width: 48, height: 32, channels: 3, background } })
    .jpeg()
    .toBuffer();

async function productByCode(code: string) {
  const { items } = await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 });
  return items.find((product) => product.variants.some((variant) => variant.code === code))!;
}

/** Adds a photo as the bulk import does, whole; answers its id. */
async function addPhoto(code: string, bytes: Buffer, caption?: string | null): Promise<string> {
  const product = await imageService.uploadImage(
    {
      productId: (await productByCode(code)).id,
      fileBuffer: bytes,
      crop: { cropX: 0, cropY: 0, cropWidth: 0, cropHeight: 0, rotationDeg: 0, caption },
      wholeFrame: true,
    },
    admin,
  );
  return [...product.images].sort((a, b) => b.sequence - a.sequence)[0]!.id;
}

/** A sub product's photos in gallery order. */
async function gallery(code: string) {
  const product = await productByCode(code);
  const byId = new Map(product.images.map((image) => [image.id, image]));
  return galleryOrder(product).map((id) => byId.get(id)!);
}

/** White PRB-0001 and Ivory PRB-0002: one sub product with two colours. */
async function twoColours(): Promise<void> {
  const host = await productByCode('OPT-0001');
  await catalog.createProduct(
    {
      name: 'Twin',
      categoryId: host.categoryId,
      hasVariants: true,
      variants: [
        { code: 'PRB-0001', label: 'White' },
        { code: 'PRB-0002', label: 'Ivory' },
      ],
    } as ProductInput,
    admin,
  );
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

const images = (entries: Map<string, Buffer>) =>
  [...entries.keys()].filter((name) => name.startsWith('images/')).sort();

describe.skipIf(!canRunIntegrationTests)(
  'the photos of the product backup zip (integration)',
  () => {
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
      dir = await mkdtemp(path.join(os.tmpdir(), 'backup-photos-'));
    }, 120_000);

    it("keeps a photo the zip names by one colour's code, adds the other colour's photo 1 beside it, and a second run changes nothing", async () => {
      await twoColours();
      const white = await addPhoto('PRB-0001', await jpeg('#f0f0f0'), 'White');
      const { entries } = await exported();
      expect(images(entries)).toEqual(['images/PRB-0001.webp']);
      const edited = new Map(entries);
      edited.set('images/PRB-0002.jpg', await jpeg('#fff0d0'));
      const file = await zipOf(edited);

      const preview = await previewProductZip(file, 'p.zip', admin);
      expect(preview.photos).toMatchObject({ added: ['PRB-0002.jpg'], replaced: [], unchanged: 1 });
      const done = await restoreProductZip(file, 'p.zip', {}, admin);
      expect(done.photos).toMatchObject({ added: ['PRB-0002.jpg'], replaced: [] });
      expect(done.problems).toEqual([]);
      const once = await gallery('PRB-0001');
      expect(once.map((image) => image.id)[0]).toBe(white);
      expect(once).toHaveLength(2);

      // Each file now matches its own photo by its bytes: nothing is uploaded, removed or moved.
      const again = await restoreProductZip(file, 'p.zip', { removeMissingPhotos: true }, admin);
      expect(again.photos).toMatchObject({ added: [], replaced: [], unchanged: 2, notInZip: [] });
      expect(again.photosRemoved).toBe(0);
      expect(await gallery('PRB-0001')).toEqual(once);
    });

    it('keeps a later photo as it is when an earlier one was deleted, and puts the deleted one back in its slot', async () => {
      const front = await addPhoto('OPT-0001', await jpeg('#aa0000'), 'Front');
      const back = await addPhoto('OPT-0001', await jpeg('#00aa00'), 'Back');
      const side = await addPhoto('OPT-0001', await jpeg('#0000aa'), 'Side');
      const { file } = await exported();
      await imageService.deleteImage(back, admin);

      const preview = await previewProductZip(file, 'p.zip', admin);
      expect(preview.photos).toMatchObject({
        added: ['OPT-0001_2.webp'],
        replaced: [],
        unchanged: 2,
      });
      await restoreProductZip(file, 'p.zip', {}, admin);
      const after = await gallery('OPT-0001');
      expect(after.map((image) => image.id)).toEqual([front, expect.any(String), side]);
      expect(after.map((image) => image.caption)).toEqual(['Front', 'Back', 'Side']);
    });

    it('makes the photo the zip names as photo 1 the main photo again, and keeps a newer one it does not name', async () => {
      const backedUp = await addPhoto('OPT-0001', await jpeg('#aa0000'), 'Front');
      const { file } = await exported();
      const newer = await addPhoto('OPT-0001', await jpeg('#00aa00'));
      await imageService.updateImageCaption(newer, { isPrimary: true }, admin);

      // The newer photo is named by the slot it takes: behind the one the zip names.
      const preview = await previewProductZip(file, 'p.zip', admin);
      expect(preview.photos).toMatchObject({
        added: [],
        replaced: [],
        unchanged: 1,
        notInZip: ['OPT-0001_2'],
      });
      await restoreProductZip(file, 'p.zip', {}, admin);
      const after = await gallery('OPT-0001');
      expect(after.map((image) => [image.id, image.isPrimary])).toEqual([
        [backedUp, true],
        [newer, false],
      ]);

      // Only the opt-in removes the photo the zip does not have.
      const opted = await restoreProductZip(file, 'p.zip', { removeMissingPhotos: true }, admin);
      expect(opted.photosRemoved).toBe(1);
      expect((await gallery('OPT-0001')).map((image) => image.id)).toEqual([backedUp]);
    });

    it('carries every caption in photos.csv: into an empty catalogue, and back onto a photo whose caption changed', async () => {
      await twoColours();
      await addPhoto('OPT-0001', await jpeg('#aa0000'), 'Front view');
      await addPhoto('OPT-0001', await jpeg('#00aa00'), null);
      await addPhoto('PRB-0001', await jpeg('#0000aa'), null);
      await addPhoto('PRB-0001', await jpeg('#aaaa00'), 'Box packing');
      await addPhoto('PRB-0001', await jpeg('#00aaaa'), 'Ivory');
      const captions = async () => ({
        single: (await gallery('OPT-0001')).map((image) => image.caption),
        twin: (await gallery('PRB-0001')).map((image) => image.caption),
      });
      const before = await captions();
      expect(before).toEqual({
        single: ['Front view', null],
        twin: [null, 'Box packing', 'Ivory'],
      });

      const { file, entries } = await exported();
      const listed = await readSheetRows(entries.get('photos.csv')!);
      expect(listed[0]).toEqual(['File', 'Caption']);
      expect(listed.slice(1).filter((row) => row[0]!.startsWith('PRB'))).toEqual([
        ['PRB-0001.webp', ''],
        ['PRB-0001_2.webp', 'Box packing'],
        ['PRB-0002_3.webp', 'Ivory'],
      ]);

      // A caption changed since the backup is put back, and the preview says so.
      const front = (await gallery('OPT-0001'))[0]!;
      await imageService.updateImageCaption(front.id, { caption: 'Changed' }, admin);
      const preview = await previewProductZip(file, 'p.zip', admin);
      expect(preview.photos).toMatchObject({ unchanged: 5, recaptioned: ['OPT-0001.webp'] });
      const done = await restoreProductZip(file, 'p.zip', {}, admin);
      expect(done.photos.recaptioned).toEqual(['OPT-0001.webp']);
      expect(await captions()).toEqual(before);
      expect((await gallery('OPT-0001'))[0]!.id).toBe(front.id);

      // Into an emptied catalogue, with photos.csv moved into the images folder: never read as a photo.
      await resetData();
      const moved = new Map(entries);
      moved.delete('photos.csv');
      moved.set('images/photos.csv', entries.get('photos.csv')!);
      const empty = await restoreProductZip(await zipOf(moved), 'p.zip', {}, admin);
      expect(empty.photos.notImage).toEqual([]);
      expect(await captions()).toEqual(before);

      // A zip without photos.csv captions a colour's photo with that colour, as it always has.
      await resetData();
      const bare = new Map(entries);
      bare.delete('photos.csv');
      await restoreProductZip(await zipOf(bare), 'p.zip', {}, admin);
      expect((await captions()).twin).toEqual(['White', 'White', 'Ivory']);
    }, 120_000);

    it("keeps a photo's bytes from Master to Master: a backup of a restored Master reads as unchanged on the first", async () => {
      await addPhoto('OPT-0001', await jpeg('#aa0000'), 'Front');
      await addPhoto('OPT-0001', await jpeg('#00aa00'), 'Back');
      await addPhoto('OPT-0002', await jpeg('#0000aa'), 'Front');
      const shots = async () =>
        [...(await gallery('OPT-0001')), ...(await gallery('OPT-0002'))].map((image) => ({
          id: image.id,
          caption: image.caption,
          checksum: image.checksum,
        }));
      const onA = await shots();
      const fromA = await exported();

      // Master B: restored from A's backup, then backed up itself. Its masters are A's, byte for byte.
      await resetData();
      await restoreProductZip(fromA.file, 'a.zip', {}, admin);
      expect((await shots()).map((shot) => shot.checksum)).toEqual(
        onA.map((shot) => shot.checksum),
      );
      const fromB = await exported();
      for (const name of images(fromA.entries))
        expect(sha(fromB.entries.get(name)!), name).toBe(sha(fromA.entries.get(name)!));

      // Master A again (the pipeline is deterministic), then B's backup restored onto it.
      await resetData();
      await seedCatalogue({ actor: admin });
      await addPhoto('OPT-0001', await jpeg('#aa0000'), 'Front');
      await addPhoto('OPT-0001', await jpeg('#00aa00'), 'Back');
      await addPhoto('OPT-0002', await jpeg('#0000aa'), 'Front');
      const again = await shots();
      expect(again.map((shot) => shot.checksum)).toEqual(onA.map((shot) => shot.checksum));

      const preview = await previewProductZip(fromB.file, 'b.zip', admin);
      expect(preview.photos).toMatchObject({
        added: [],
        replaced: [],
        unchanged: 3,
        recaptioned: [],
      });
      const done = await restoreProductZip(fromB.file, 'b.zip', {}, admin);
      expect(done.photos).toMatchObject({ added: [], replaced: [], unchanged: 3 });
      expect(await shots()).toEqual(again);
    }, 120_000);

    it('keeps only a still, lossy WebP with no metadata as it is; any other file is encoded as before', async () => {
      const raw = sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } });
      const lossy = await raw.clone().webp({ quality: 80 }).toBuffer();
      const lossless = await raw.clone().webp({ lossless: true }).toBuffer();
      const withIcc = await raw.clone().webp({ quality: 80 }).withIccProfile('srgb').toBuffer();
      const big = await sharp({
        create: { width: 2100, height: 40, channels: 3, background: '#336699' },
      })
        .webp({ quality: 80 })
        .toBuffer();
      for (const [code, bytes] of [
        ['OPT-0001', lossy],
        ['OPT-0002', lossless],
        ['OPT-0003', withIcc],
        ['OPT-0004', big],
      ] as const)
        await addPhoto(code, bytes);

      const stored = async (code: string) => {
        const image = (await gallery(code))[0]!;
        const master = await readFile(path.join(tenantImagesDir, image.id, 'master.webp'));
        return { checksum: image.checksum, master: sha(master) };
      };
      expect(await stored('OPT-0001')).toEqual({ checksum: sha(lossy), master: sha(lossy) });
      for (const [code, bytes] of [
        ['OPT-0002', lossless],
        ['OPT-0003', withIcc],
        ['OPT-0004', big],
      ] as const)
        expect((await stored(code)).checksum, code).not.toBe(sha(bytes));
    });

    it("names a photo by another colour's code when its own CODE_N is another sub product's code", async () => {
      await twoColours();
      await db()('product_variants').where({ code: 'OPT-0005' }).update({ code: 'PRB-0001_2' });
      await addPhoto('PRB-0001', await jpeg('#aa0000'), 'White');
      await addPhoto('PRB-0001', await jpeg('#00aa00'), 'White');
      const before = await gallery('PRB-0001');

      const { file, entries } = await exported();
      expect(images(entries)).toEqual(['images/PRB-0001.webp', 'images/PRB-0002_2.webp']);
      expect(entries.get('README.txt')!.toString('utf8')).not.toMatch(/NOT IN THIS ZIP/);
      const same = await previewProductZip(file, 'p.zip', admin);
      expect(same.photos).toMatchObject({ added: [], replaced: [], unchanged: 2, notInZip: [] });

      await resetData();
      await restoreProductZip(file, 'p.zip', {}, admin);
      const after = await gallery('PRB-0001');
      expect(after.map((image) => image.caption)).toEqual(['White', 'White']);
      expect(after.map((image) => image.checksum)).toEqual(before.map((image) => image.checksum));
    });

    it('lists a photo whose files are missing in the README, and never removes it as missing from the zip', async () => {
      await addPhoto('OPT-0001', await jpeg('#aa0000'));
      const lost = await addPhoto('OPT-0002', await jpeg('#00aa00'));
      await rm(path.join(tenantImagesDir, lost), { recursive: true, force: true });

      const { file, entries } = await exported();
      expect(images(entries)).toEqual(['images/OPT-0001.webp']);
      const name = (await productByCode('OPT-0002')).name;
      expect(entries.get('README.txt')!.toString('utf8')).toContain(
        `  ${name}, photo 1 (its file is missing)`,
      );

      const preview = await previewProductZip(file, 'p.zip', admin);
      expect(preview.photos).toMatchObject({ unchanged: 1, notInZip: [] });
      const done = await restoreProductZip(file, 'p.zip', { removeMissingPhotos: true }, admin);
      expect(done.photosRemoved).toBe(0);
      expect((await gallery('OPT-0002')).map((image) => image.id)).toEqual([lost]);
    });
  },
);
