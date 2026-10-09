/**
 * Lens B probes: the photos in the product backup zip
 * (`services/product-zip.service.ts`), against PostgreSQL and the real
 * SWISWARE catalogue. Each test asserts what a backup and restore should do;
 * the ones named `B<n>:` fail on ad15b2a2 and prove a defect, the ones named
 * `B-ok:` pass and record what was checked. Values worth reading are logged
 * with a `PROBE` prefix.
 */

import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { galleryOrder, type Product, type ProductInput, type ProductVariant } from '@orderbook/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import type { ActorContext } from '../../src/domain/actor.js';
import { db } from '../../src/db/knex.js';
import { createZipWriter, openZipReader } from '../../src/lib/archive-zip.js';
import { toCsv } from '../../src/lib/csv.js';
import { readSheetRows } from '../../src/lib/spreadsheet.js';
import * as productRepo from '../../src/repositories/product.repository.js';
import * as catalog from '../../src/services/catalog.service.js';
import {
  attachCataloguePhotos,
  CATALOGUE_PHOTOS_MARKER,
  healMissingImageFiles,
} from '../../src/services/catalogue-photos.service.js';
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
const VARIANT_FILES = ['master', 'large', 'thumb', 'micro'];

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const picture = (background: string, width = 48, height = 32) =>
  sharp({ create: { width, height, channels: 3, background } });
const jpeg = (background: string) => picture(background).jpeg().toBuffer();
const colour = (index: number) => `#${((index * 37) % 256).toString(16).padStart(2, '0')}${((index * 91) % 256).toString(16).padStart(2, '0')}80`;

async function allProducts(): Promise<Product[]> {
  return (await productRepo.listProducts(admin.tenantId, { limit: 100_000, offset: 0 })).items;
}

async function productByCode(code: string): Promise<Product | undefined> {
  return (await allProducts()).find((product) => product.variants.some((variant) => variant.code === code));
}

/** Adds a photo the way the screen's whole-picture upload does; answers its id. */
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
  caption: string | null;
  isPrimary: boolean;
  checksum: string;
  source: string | null;
}

/** A sub product's gallery in its own order (primary first, then sequence). */
async function gallery(code: string): Promise<Shot[]> {
  const product = await productByCode(code);
  if (!product) return [];
  const ids = galleryOrder(product);
  const rows = (await db()('product_images')
    .whereIn('id', ids)
    .select('id', 'caption', 'is_primary', 'checksum', 'source_checksum')) as Array<{
    id: string;
    caption: string | null;
    is_primary: boolean;
    checksum: string;
    source_checksum: string | null;
  }>;
  return ids.map((id) => {
    const row = rows.find((candidate) => candidate.id === id)!;
    return {
      id,
      caption: row.caption,
      isPrimary: row.is_primary,
      checksum: row.checksum,
      source: row.source_checksum,
    };
  });
}

async function missingFiles(imageId: string): Promise<string[]> {
  const missing: string[] = [];
  for (const variant of VARIANT_FILES) {
    const present = await access(path.join(tenantImagesDir, imageId, `${variant}.webp`)).then(
      () => true,
      () => false,
    );
    if (!present) missing.push(variant);
  }
  return missing;
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

const imageNames = (entries: Map<string, Buffer>) =>
  [...entries.keys()].filter((name) => name.startsWith('images/')).sort();

/** Codes of one-colour sub products, in catalogue order. */
async function singleCodes(): Promise<string[]> {
  return (await allProducts())
    .filter((product) => !product.hasVariants && product.variants.length === 1)
    .map((product) => product.variants[0]!.code);
}

/**
 * A fixed sub product with two colours, White and Ivory (the seeded catalogue
 * has one colour per sub product), in a seeded main product so the backup
 * carries its main product code.
 */
async function multiColour(): Promise<{ v1: ProductVariant; v2: ProductVariant }> {
  const host = (await allProducts())[0]!;
  const product = await catalog.createProduct(
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
  return { v1: product.variants[0]!, v2: product.variants[1]! };
}

/** A real shipped catalogue photo (a product on white), for the re-encoding checks. */
const realPhoto = (name: string) => readFile(path.join(config.cataloguePhotosDir, name));

/** PSNR in dB between two images of the same size (Infinity when identical). */
async function psnr(a: Buffer, b: Buffer): Promise<number> {
  const one = await sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const two = await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (one.info.width !== two.info.width || one.info.height !== two.info.height) return -1;
  let sum = 0;
  for (let index = 0; index < one.data.length; index += 1) {
    const diff = one.data[index]! - two.data[index]!;
    sum += diff * diff;
  }
  const mse = sum / one.data.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

describe.skipIf(!canRunIntegrationTests)('lens B: photos in the product backup zip (probe)', () => {
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
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-b-'));
  }, 120_000);

  it('B-ok: one photo and several photos come back in number, order, primary, picture and files, into the same and an empty catalogue', async () => {
    const [one, many] = await singleCodes();
    await addPhoto(one!, await jpeg('#112233'));
    for (const name of ['ACC-0001.jpg', 'ACC-0002.jpg', 'ACC-0003.jpg']) await addPhoto(many!, await realPhoto(name));
    // The third upload made primary: the primary is not simply the first upload.
    const third = (await gallery(many!))[2]!;
    await imageService.updateImageCaption(third.id, { isPrimary: true }, admin);
    const before = new Map([
      [one!, await gallery(one!)],
      [many!, await gallery(many!)],
    ]);
    expect(before.get(many!)![0]!.id).toBe(third.id);

    const { file, entries } = await exported();
    expect(imageNames(entries)).toEqual(
      [`images/${one}.webp`, `images/${many}.webp`, `images/${many}_2.webp`, `images/${many}_3.webp`].sort(),
    );

    const same = await restoreProductZip(file, 'p.zip', { removeMissingPhotos: true }, admin);
    expect(same.photos).toMatchObject({ added: [], replaced: [], unchanged: 4, notInZip: [] });
    expect(same.photosRemoved).toBe(0);
    expect(await gallery(many!)).toEqual(before.get(many!));

    await resetData();
    const empty = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(empty.problems).toEqual([]);
    for (const [code, was] of before) {
      const after = await gallery(code);
      // The picture: each restored row's source is the stored master it came from, in the same slot.
      expect(after.map((shot) => shot.source), code).toEqual(was.map((shot) => shot.checksum));
      expect(after.filter((shot) => shot.isPrimary).map((shot) => shot.id)).toEqual([after[0]!.id]);
      for (const shot of after) expect(await missingFiles(shot.id), `${code} ${shot.id}`).toEqual([]);
    }
    // Re-encoded on the way in: what the next export writes is the restore's own encoding.
    const restored = (await gallery(many!))[0]!;
    const restoredMaster = await readFile(path.join(tenantImagesDir, restored.id, 'master.webp'));
    const original = entries.get(`images/${many}.webp`)!;
    console.log(
      `PROBE B-ok1 restored master identical to backed-up master: ${sha(restoredMaster) === sha(original)}; PSNR ${(await psnr(original, restoredMaster)).toFixed(1)} dB`,
    );
  }, 120_000);

  it('B1: keeps every photo caption through a restore into an empty catalogue', async () => {
    const [single] = await singleCodes();
    // A seeded `fixed` sub product: one colour, labelled (hasVariants), as most of the catalogue is.
    const fixed = (await allProducts()).find(
      (product) => product.hasVariants && product.variants.length === 1 && product.variants[0]!.label,
    )!.variants[0]!;
    const { v1, v2 } = await multiColour();
    await addPhoto(single!, await jpeg('#aa0000'), 'Front view');
    await addPhoto(single!, await jpeg('#00aa00'), 'White');
    await addPhoto(fixed.code, await jpeg('#aa00aa'), null);
    await addPhoto(v1.code, await jpeg('#0000aa'), null);
    await addPhoto(v1.code, await jpeg('#aaaa00'), 'Box packing');
    await addPhoto(v1.code, await jpeg('#00aaaa'), v2.label);
    const captions = async () => ({
      single: (await gallery(single!)).map((shot) => shot.caption),
      fixed: (await gallery(fixed.code)).map((shot) => shot.caption),
      multi: (await gallery(v1.code)).map((shot) => shot.caption),
    });
    const before = await captions();
    expect(before).toEqual({
      single: ['Front view', 'White'],
      fixed: [null],
      multi: [null, 'Box packing', v2.label],
    });

    const { file } = await exported();
    await resetData();
    await restoreProductZip(file, 'p.zip', {}, admin);

    const after = await captions();
    console.log(`PROBE B1 captions before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    expect(after).toEqual(before);
  }, 120_000);

  it('B-ok: a multi-colour sub product whose photos are captioned per colour goes out under each colour code and comes back in order, with its colours', async () => {
    const { v1, v2 } = await multiColour();
    await addPhoto(v1.code, await jpeg('#aa0000'), v2.label);
    await addPhoto(v1.code, await jpeg('#00aa00'), v1.label);
    await addPhoto(v1.code, await jpeg('#0000aa'), v1.label);
    await addPhoto(v1.code, await jpeg('#aaaa00'), v2.label);
    const before = await gallery(v1.code);

    const { file, entries } = await exported();
    expect(imageNames(entries)).toEqual(
      [`images/${v2.code}.webp`, `images/${v1.code}_2.webp`, `images/${v1.code}_3.webp`, `images/${v2.code}_4.webp`].sort(),
    );

    const same = await restoreProductZip(file, 'p.zip', { removeMissingPhotos: true }, admin);
    expect(same.photos).toMatchObject({ added: [], replaced: [], unchanged: 4, notInZip: [] });
    expect(same.photosRemoved).toBe(0);
    expect(await gallery(v1.code)).toEqual(before);

    await resetData();
    const preview = await previewProductZip(file, 'p.zip', admin);
    expect([...preview.photos.added].sort()).toEqual(
      [`${v2.code}.webp`, `${v1.code}_2.webp`, `${v1.code}_3.webp`, `${v2.code}_4.webp`].sort(),
    );
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await gallery(v1.code);
    expect(after.map((shot) => shot.source)).toEqual(before.map((shot) => shot.checksum));
    expect(after.map((shot) => shot.caption)).toEqual(before.map((shot) => shot.caption));
    expect(after[0]!.isPrimary).toBe(true);
  }, 120_000);

  it('B2: a photo named by another colour code of the same sub product does not delete the photo the preview calls unchanged', async () => {
    const { v1, v2 } = await multiColour();
    const kept = await addPhoto(v1.code, await jpeg('#aa0000'), v1.label);
    const { entries } = await exported();
    expect(imageNames(entries)).toEqual([`images/${v1.code}.webp`]);
    // Someone adds the other colour's picture, named by that colour's code as the README describes.
    const edited = new Map(entries);
    edited.set(`images/${v2.code}.jpg`, await jpeg('#eeeeee'));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await gallery(v1.code);
    console.log(
      `PROBE B2 preview photos ${JSON.stringify(preview.photos)}; run photos ${JSON.stringify(done.photos)}; ` +
        `kept photo still there: ${after.some((shot) => shot.id === kept)}; gallery now ${after.length}`,
    );
    expect(preview.photos.unchanged).toBe(1);
    expect(after.map((shot) => shot.id)).toContain(kept);
  }, 120_000);

  it('B3: a backup made on a Master that was itself restored from a backup reads as unchanged on the first Master', async () => {
    const codes = (await singleCodes()).slice(0, 3);
    const sources = await Promise.all(['ACC-0010.jpg', 'ACC-0011.jpg', 'ACC-0012.jpg'].map(realPhoto));
    const build = async () => {
      for (const [index, code] of codes.entries()) await addPhoto(code, sources[index]!, 'Front');
      return Promise.all(codes.map(async (code) => (await gallery(code))[0]!));
    };
    const onA = await build();
    const zip1 = await exported();

    // Master B: a new install, restored from A's backup, then backed up itself.
    await resetData();
    await restoreProductZip(zip1.file, 'a.zip', {}, admin);
    const zip2 = await exported();
    for (const code of codes) {
      const a = zip1.entries.get(`images/${code}.webp`)!;
      const b = zip2.entries.get(`images/${code}.webp`)!;
      console.log(`PROBE B3 ${code}: B's backup bytes equal A's: ${sha(a) === sha(b)}; PSNR ${(await psnr(a, b)).toFixed(1)} dB`);
    }

    // Master A again, made the same way it was (the pipeline is deterministic).
    await resetData();
    await seedCatalogue({ actor: admin });
    const again = await build();
    expect(again.map((shot) => shot.checksum)).toEqual(onA.map((shot) => shot.checksum));

    const preview = await previewProductZip(zip2.file, 'b.zip', admin);
    const done = await restoreProductZip(zip2.file, 'b.zip', {}, admin);
    const after = await Promise.all(codes.map(async (code) => (await gallery(code))[0]!));
    console.log(
      `PROBE B3 B's backup previewed on A: replaced ${JSON.stringify(preview.photos.replaced)}, unchanged ${preview.photos.unchanged}; ` +
        `after the run ids kept ${after.every((shot, index) => shot.id === again[index]!.id)}, captions ${JSON.stringify(after.map((shot) => shot.caption))}`,
    );
    expect(done.photos).toMatchObject({ replaced: [], unchanged: 3 });
    expect(preview.photos).toMatchObject({ replaced: [], unchanged: 3 });
  }, 180_000);

  it('B4: restoring a backup after a middle photo was deleted keeps the later photo as it is', async () => {
    const [code] = await singleCodes();
    await addPhoto(code!, await jpeg('#aa0000'), 'Front');
    const middle = await addPhoto(code!, await jpeg('#00aa00'), 'Back');
    const last = await addPhoto(code!, await jpeg('#0000aa'), 'Side');
    const { file } = await exported();
    await imageService.deleteImage(middle, admin);

    const preview = await previewProductZip(file, 'p.zip', admin);
    await restoreProductZip(file, 'p.zip', {}, admin);
    const after = await gallery(code!);
    console.log(
      `PROBE B4 preview ${JSON.stringify({ added: preview.photos.added, replaced: preview.photos.replaced, unchanged: preview.photos.unchanged })}; ` +
        `after: ${after.length} photos, 'Side' photo id kept ${after.some((shot) => shot.id === last)}, captions ${JSON.stringify(after.map((shot) => shot.caption))}`,
    );
    expect(after).toHaveLength(3);
    expect(after[2]).toMatchObject({ id: last, caption: 'Side' });
  }, 120_000);

  it('B-ok: codes holding characters a file name cannot hold come back to their own sub product', async () => {
    const weird = ['Q"1', 'Q*2', 'Q:3', 'Q<4', 'Q>5', 'Q?6', 'Q|7', 'Q\\8', 'Q%9', 'Q%2F10', 'Q.11.', 'Q 12'];
    const targets = (await singleCodes()).slice(10, 10 + weird.length);
    for (const [index, code] of targets.entries()) {
      await db()('product_variants').where({ code }).update({ code: weird[index] });
      await addPhoto(weird[index]!, await jpeg(colour(index + 3)));
    }
    const before = new Map(await Promise.all(weird.map(async (code) => [code, await gallery(code)] as const)));

    const { file, entries } = await exported();
    console.log(`PROBE B-ok codes as file names: ${JSON.stringify(imageNames(entries))}`);
    expect(imageNames(entries)).toHaveLength(weird.length);
    const same = await previewProductZip(file, 'p.zip', admin);
    expect(same.photos).toMatchObject({ added: [], replaced: [], unchanged: weird.length, unmatched: [], notInZip: [] });

    await resetData();
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect(done.photos.unmatched).toEqual([]);
    for (const code of weird) {
      const after = await gallery(code);
      expect(after.map((shot) => shot.source), code).toEqual(before.get(code)!.map((shot) => shot.checksum));
    }
  }, 120_000);

  it('B-ok: a hand-edited zip (jpg, png, webp, upper-case ending, a duplicate, junk, top folder, backslashes) into an empty catalogue', async () => {
    const [c1, c2, c3] = await singleCodes();
    const { entries } = await exported();
    const jpg1 = await jpeg('#aa0000');
    const png = await picture('#00aa00', 40, 40).png().toBuffer();
    const webp = await picture('#0000aa', 40, 30).webp().toBuffer();
    const jpg2 = await jpeg('#aaaa00');
    const jpg3 = await jpeg('#00aaaa');
    const named: Array<[string, Buffer]> = [
      ...[...entries].filter(([name]) => !name.startsWith('images/')).map(([name, bytes]): [string, Buffer] => [`Backup/${name}`, bytes]),
      [`Backup/images/${c1}.JPG`, jpg1],
      [`Backup/images/${c1}_2.png`, png],
      [`Backup/images/${c2}.webp`, webp],
      [`Backup/images/${c2}.jpg`, jpg2],
      [`Backup/images/${c3}.jpeg`, jpg3],
      [`__MACOSX/Backup/images/._${c1}.JPG`, Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, 77, 97, 99, 32, 79, 83, 32, 88])],
      ['Backup/images/Thumbs.db', Buffer.from('not a picture at all')],
    ];
    const file = await zipOf(named);
    // Compress-Archive's backslashes, written over the names at the same length.
    const bytes = await readFile(file);
    for (const [name] of named) {
      const slashed = Buffer.from(name, 'utf8');
      const backslashed = Buffer.from(name.replace(/\//g, '\\'), 'utf8');
      let at = bytes.indexOf(slashed);
      while (at !== -1) {
        backslashed.copy(bytes, at);
        at = bytes.indexOf(slashed, at + 1);
      }
    }
    await writeFile(file, bytes);

    await resetData();
    const preview = await previewProductZip(file, 'p.zip', admin);
    expect([...preview.photos.added].sort()).toEqual([`${c1}.JPG`, `${c1}_2.png`, `${c2}.jpg`, `${c3}.jpeg`].sort());
    expect(preview.photos.duplicate).toEqual([`${c2}.webp`]);
    expect([...preview.photos.notImage].sort()).toEqual([`._${c1}.JPG`, 'Thumbs.db'].sort());

    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    expect([...done.photos.added].sort()).toEqual([...preview.photos.added].sort());
    expect((await gallery(c1!)).map((shot) => shot.source)).toEqual([sha(jpg1), sha(png)]);
    expect((await gallery(c2!)).map((shot) => shot.source)).toEqual([sha(jpg2)]);
    expect((await gallery(c3!)).map((shot) => shot.source)).toEqual([sha(jpg3)]);
    for (const code of [c1!, c2!, c3!])
      for (const shot of await gallery(code)) expect(await missingFiles(shot.id)).toEqual([]);
  }, 120_000);

  it('B5: a photo the backup leaves out (its CODE_N is another sub product code) survives a restore into an empty catalogue', async () => {
    const [a, , , , b] = await singleCodes();
    await db()('product_variants').where({ code: b }).update({ code: `${a}_2` });
    await addPhoto(a!, await jpeg('#aa0000'));
    await addPhoto(a!, await jpeg('#00aa00'));
    await addPhoto(`${a}_2`, await jpeg('#0000aa'));
    const { file, entries } = await exported();
    console.log(`PROBE B5 images in the zip: ${JSON.stringify(imageNames(entries))}`);

    await resetData();
    await restoreProductZip(file, 'p.zip', {}, admin);
    const count = (await gallery(a!)).length;
    console.log(`PROBE B5 ${a} had 2 photos, after the restore into an empty catalogue: ${count}`);
    expect(count).toBe(2);
  }, 120_000);

  it('B8: the preview matches a photo named by a colour the same zip adds to an existing sub product, as the run does', async () => {
    const host = (await allProducts())[0]!;
    await catalog.createProduct(
      {
        name: 'Probe Solo',
        categoryId: host.categoryId,
        hasVariants: true,
        variants: [{ code: 'PRB-0101', label: 'White' }],
      } as ProductInput,
      admin,
    );
    await addPhoto('PRB-0101', await jpeg('#aa0000'), 'White');
    const { entries } = await exported();
    // The other backup's row for the same sub product, in another colour, and its photo 2.
    const [header, ...body] = await readSheetRows(entries.get('products.csv')!);
    const codeAt = header!.indexOf('Code');
    const colourAt = header!.indexOf('Colour');
    const own = body.find((row) => row[codeAt] === 'PRB-0101')!;
    const added = own.map((cell, index) => (index === codeAt ? 'PRB-0102' : index === colourAt ? 'Ivory' : cell));
    const edited = new Map(entries);
    edited.set('products.csv', Buffer.from('﻿' + toCsv(header!, [...body, added]), 'utf8'));
    edited.set('images/PRB-0102_2.jpg', await jpeg('#eeeeee'));
    const file = await zipOf(edited);

    const preview = await previewProductZip(file, 'p.zip', admin);
    const done = await restoreProductZip(file, 'p.zip', {}, admin);
    console.log(
      `PROBE B8 preview rows changed ${JSON.stringify(preview.rows.changed.map((row) => row.code))}, photos added ${JSON.stringify(preview.photos.added)} unmatched ${JSON.stringify(preview.photos.unmatched)}; ` +
        `run photos added ${JSON.stringify(done.photos.added)} unmatched ${JSON.stringify(done.photos.unmatched)}; gallery ${(await gallery('PRB-0101')).length}`,
    );
    expect(preview.photos.added).toEqual(done.photos.added);
    expect(preview.photos.unmatched).toEqual(done.photos.unmatched);
  }, 120_000);

  it('B6: the catalogue photos attached on boot never land beside photos a restore running at the same time puts in', async () => {
    const shipped = (await singleCodes()).slice(0, 40);
    const ownerPhotos = shipped.slice(-8);
    for (const [index, code] of ownerPhotos.entries()) await addPhoto(code, await jpeg(colour(index + 7)));
    const owner = await exported();

    // The shipped photos, `<code>.jpg`, large enough to take a moment each, as real ones do.
    const shippedDir = path.join(dir, 'shipped');
    await mkdir(shippedDir);
    for (const code of shipped) {
      const bytes = await sharp({
        create: {
          width: 1600,
          height: 1200,
          channels: 3,
          background: '#808080',
          noise: { type: 'gaussian', mean: 128, sigma: 40 },
        },
      })
        .jpeg()
        .toBuffer();
      await writeFile(path.join(shippedDir, `${code}.jpg`), bytes);
    }

    // A fresh install: the shipped catalogue, no photo yet. The attach runs unawaited on boot;
    // the owner restores the backup while it is still going.
    await resetData();
    await seedCatalogue({ actor: admin });
    const attaching = attachCataloguePhotos(shippedDir);
    const restoring = restoreProductZip(owner.file, 'owner.zip', {}, admin);
    const [attached, restored] = await Promise.all([attaching, restoring]);

    const counts = await Promise.all(ownerPhotos.map(async (code) => [code, (await gallery(code)).length] as const));
    console.log(
      `PROBE B6 attach ${JSON.stringify(attached)}; restore photos added ${restored.photos.added.length}, replaced ${restored.photos.replaced.length}; ` +
        `photos per owner sub product ${JSON.stringify(counts)}`,
    );
    expect(counts.filter(([, count]) => count !== 1)).toEqual([]);
  }, 300_000);

  it('B7: restoring a backup into a fresh install leaves no shipped catalogue photo on a sub product the backup had none on', async () => {
    const shipped = (await singleCodes()).slice(0, 5);
    // The owner's catalogue: photos on the last two only.
    await addPhoto(shipped[3]!, await jpeg('#aa0000'));
    await addPhoto(shipped[4]!, await jpeg('#00aa00'));
    const owner = await exported();

    const shippedDir = path.join(dir, 'shipped');
    await mkdir(shippedDir);
    for (const [index, code] of shipped.entries()) await writeFile(path.join(shippedDir, `${code}.jpg`), await jpeg(colour(index + 20)));

    // Fresh install: the shipped catalogue and its photos (boot), then the owner's backup.
    await resetData();
    await seedCatalogue({ actor: admin });
    expect(await attachCataloguePhotos(shippedDir)).toMatchObject({ attached: 5, failed: 0 });
    const preview = await previewProductZip(owner.file, 'owner.zip', admin);
    await restoreProductZip(owner.file, 'owner.zip', {}, admin);
    const counts = await Promise.all(shipped.map(async (code) => (await gallery(code)).length));
    console.log(`PROBE B7 preview notInZip ${JSON.stringify(preview.photos.notInZip)}; photos per sub product after restore ${JSON.stringify(counts)} (backup had [0,0,0,1,1])`);
    expect.soft(counts).toEqual([0, 0, 0, 1, 1]);

    // Checked alongside: the next boot attaches nothing (the marker holds the set) ...
    expect(await attachCataloguePhotos(shippedDir)).toBeNull();
    // ... and the heal never writes a shipped photo over a restored one whose files went missing.
    const restoredOwn = (await gallery(shipped[4]!))[0]!;
    await rm(path.join(tenantImagesDir, restoredOwn.id), { recursive: true, force: true });
    const heal = await healMissingImageFiles(admin.tenantId, shippedDir, shipped.map((code) => `${code}.jpg`));
    expect(heal).toMatchObject({ missing: 1, healed: 0, unsourced: 1 });
    expect((await gallery(shipped[4]!))[0]).toEqual(restoredOwn);
  }, 180_000);

  it('B9: after a first-boot photo attach that did not finish, the next boot leaves a restored sub product without the photo its backup did not have', async () => {
    const shipped = (await singleCodes()).slice(0, 5);
    await addPhoto(shipped[3]!, await jpeg('#aa0000'));
    await addPhoto(shipped[4]!, await jpeg('#00aa00'));
    const owner = await exported();
    const shippedDir = path.join(dir, 'shipped');
    await mkdir(shippedDir);
    for (const [index, code] of shipped.entries()) await writeFile(path.join(shippedDir, `${code}.jpg`), await jpeg(colour(index + 20)));

    // First boot of a fresh install: the shipped catalogue, and the attach, closed before it
    // recorded its marker (the marker is written only after the last photo). Same rows either way.
    await resetData();
    await seedCatalogue({ actor: admin });
    await attachCataloguePhotos(shippedDir);
    await db()('settings').where({ key: CATALOGUE_PHOTOS_MARKER }).delete();
    // The owner restores the backup, removing the photos it does not have.
    await restoreProductZip(owner.file, 'owner.zip', { removeMissingPhotos: true }, admin);
    const restored = await Promise.all(shipped.map(async (code) => (await gallery(code)).length));
    expect(restored).toEqual([0, 0, 0, 1, 1]);

    // The next boot.
    const rerun = await attachCataloguePhotos(shippedDir);
    const after = await Promise.all(shipped.map(async (code) => (await gallery(code)).length));
    console.log(`PROBE B9 after the restore ${JSON.stringify(restored)}; next boot attach ${JSON.stringify(rerun)}; now ${JSON.stringify(after)}`);
    expect(after).toEqual([0, 0, 0, 1, 1]);
  }, 180_000);
});
