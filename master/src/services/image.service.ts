/**
 * Product image pipeline — upload, crop/rotate, normalize, store, serve, delete
 * (`7-IMAGE-PIPELINE.md`). Every write is one transaction containing the row
 * change and `recordActivity`, then `publishChange`, mirroring `fields.service.ts`.
 *
 * `publishChange` always names `entity: 'product'` with the freshly reloaded
 * product (images included) as payload, never a `'product_image'` entity —
 * an image mutation is, from every client's point of view, just the product
 * changing shape. This reuses the product-update dispatch path both
 * frontends already have instead of teaching them a new event.
 *
 * The normalization pipeline itself (decode → auto-orient → user rotate →
 * crop → derive four `sharp`-encoded WebP sizes → blurhash) runs once, here,
 * never on a render path — see `docs/UI_REDESIGN.md`-adjacent
 * `office/web/src/ui/ProgressiveImage.tsx` for the render side of that rule.
 */

import type { ImageCropInput, Product, ProductImageReorderInput, ProductImageUpdateInput } from '@orderbook/shared';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { assertCropRect, assertRotation, IMAGE_VARIANT_SPECS, MAX_SOURCE_BYTES, variantDimensions } from '../domain/images.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as imageRepo from '../repositories/product-image.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { publishChange } from './change-bus.js';

const log = createLogger('images');

export interface UploadImageRequest {
  productId: string;
  fileBuffer: Buffer;
  crop: ImageCropInput;
}

/*
 * One raster pipeline at a time, across this module and `avatar.service.ts`.
 *
 * The memory problem is not libvips' thread count, it is unbounded *concurrent
 * uploads*: each one holds a source of up to `MAX_SOURCE_BYTES` plus the
 * decoded raster plus the variant being encoded, and four people dragging
 * photos in at once on a 4 GB shop PC is what runs it out. Serialising the
 * pipelines bounds that at one.
 *
 * A promise chain rather than a semaphore class: the permit count is always
 * one, and `createGate(permits)` would be a general mechanism for a case that
 * has never had a second.
 *
 * `sharp.concurrency` is deliberately left alone. Pinning it to 1 would make
 * each upload single-threaded *as well as* serial, which costs the person
 * waiting and saves nothing — the gate is what bounds the memory.
 */
let rasterChain: Promise<unknown> = Promise.resolve();

export function throughRasterGate<T>(work: () => Promise<T>): Promise<T> {
  const result = rasterChain.then(work, work);
  // Swallowed on the chain only: the caller still gets the rejection, but one
  // failed upload must not poison every upload after it.
  rasterChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Bound the decode cache. The default grows with whatever has been opened, and
// on this machine the interesting number is resident memory, not cache hits on
// files nobody will re-encode.
sharp.cache({ memory: 64, files: 0 });

function imageDir(tenantId: string, imageId: string): string {
  return path.join(config.imagesDir, tenantId, imageId);
}

/** `variant` is untrusted client input — this is the only place a filename is built from it. */
function variantFilePath(tenantId: string, imageId: string, variant: string): string | null {
  if (!IMAGE_VARIANT_SPECS.some((spec) => spec.name === variant)) return null;
  return path.join(imageDir(tenantId, imageId), `${variant}.webp`);
}

async function reloadProduct(tenantId: string, productId: string): Promise<Product> {
  const product = await productRepo.findProductById(tenantId, productId);
  if (!product) throw new NotFoundError('Product');
  return product;
}

/** Announce the change with the whole record, and answer the caller with it. */
function publishUpdated(product: Product): Product {
  publishChange({ entity: 'product', action: 'updated', id: product.id, payload: product });
  return product;
}

/**
 * §2.2 — decode once, auto-orient from EXIF, apply the editor's rotation,
 * crop, then derive every size from that single rotated-and-cropped raster.
 * Nothing here re-reads a previously-encoded WebP, so repeated edits in one
 * session never compound quality loss (IMG-3).
 *
 * **The two passes hand off as raw pixels, not as an image.** sharp 0.33 cannot
 * chain `.rotate().rotate(deg)` — the second call resets the first — so the
 * auto-orient and the editor's rotation have to be separate pipelines. What is
 * *not* forced is the format between them: `toBuffer()` on a JPEG source emits
 * JPEG at sharp's default quality 80 with 4:2:0 chroma subsampling, so a phone
 * photo used to be re-encoded lossily **twice** before the archival 2048px
 * master was derived from it. On a catalogue where the photograph is the
 * product, that gave away the whole point of the pipeline in two lines, while
 * this comment claimed the opposite.
 *
 * `.raw()` costs memory — width × height × channels, uncompressed — which is
 * affordable here precisely because `throughRasterGate` admits one of these at
 * a time.
 */
async function normalizeAndStore(
  tenantId: string,
  imageId: string,
  fileBuffer: Buffer,
  crop: ImageCropInput,
): Promise<{ width: number; height: number; checksum: string; blurhash: string; byteSize: number }> {
  if (fileBuffer.length === 0) throw new ValidationError('validation.image.fileRequired');
  if (fileBuffer.length > MAX_SOURCE_BYTES) throw new ValidationError('validation.image.tooLarge');

  let oriented: { data: Buffer; info: sharp.OutputInfo };
  try {
    // Bakes EXIF orientation into pixels — no renderer ever reads EXIF (§2.2).
    // Raw, so nothing is encoded on the way to the rotation below.
    oriented = await sharp(fileBuffer, { failOn: 'none' })
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new ValidationError('validation.image.unreadable', { reason: (error as Error).message });
  }

  const rotationDeg = assertRotation(crop.rotationDeg);
  const rotatedInfo = await sharp(oriented.data, {
    raw: {
      width: oriented.info.width,
      height: oriented.info.height,
      channels: oriented.info.channels,
    },
  })
    .rotate(rotationDeg, { background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rotated = rotatedInfo.data;
  const rotatedWidth = rotatedInfo.info.width;
  const rotatedHeight = rotatedInfo.info.height;

  const rect = assertCropRect(
    { x: crop.cropX, y: crop.cropY, width: crop.cropWidth, height: crop.cropHeight },
    rotatedWidth,
    rotatedHeight,
  );

  // Still raw, so the extract and every resize below work from the one decode.
  const cropped = sharp(rotated, {
    raw: {
      width: rotatedWidth,
      height: rotatedHeight,
      channels: rotatedInfo.info.channels,
    },
  }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

  const dir = imageDir(tenantId, imageId);
  await mkdir(dir, { recursive: true });

  let masterMeta: { width: number; height: number; byteSize: number } | null = null;
  let masterBytes: Buffer | null = null;

  for (const spec of IMAGE_VARIANT_SPECS) {
    const dims = variantDimensions(rect.width, rect.height, spec.longEdge);
    const { data, info } = await cropped
      .clone()
      .resize(dims.width, dims.height, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: spec.quality })
      .toBuffer({ resolveWithObject: true });

    await writeFile(path.join(dir, `${spec.name}.webp`), data);
    if (spec.name === 'master') {
      masterMeta = { width: info.width, height: info.height, byteSize: data.length };
      masterBytes = data;
    }
  }
  if (!masterMeta || !masterBytes) throw new Error('master variant was not generated');

  // Checksummed from the buffer that was just written, not by reading the file
  // back. A ≤2048px WebP is a few megabytes and this runs while somebody
  // watches a spinner; the re-read bought nothing but a second copy in memory
  // and a second trip to the disk.
  const checksum = createHash('sha256').update(masterBytes).digest('hex');
  const blurhash = await encodeBlurhashFrom(cropped);

  return { width: masterMeta.width, height: masterMeta.height, checksum, blurhash, byteSize: masterMeta.byteSize };
}

async function encodeBlurhashFrom(cropped: sharp.Sharp): Promise<string> {
  const { data, info } = await cropped
    .clone()
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
}

export async function uploadImage(request: UploadImageRequest, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.edit');

  const product = await productRepo.findProductById(actor.tenantId, request.productId);
  if (!product) throw new NotFoundError('Product');

  const imageId = randomUUID();
  const derived = await throughRasterGate(() =>
    normalizeAndStore(actor.tenantId, imageId, request.fileBuffer, request.crop),
  );

  await db().transaction(async (trx) => {
    // The product row is locked before the gallery is read, so two uploads
    // racing to the same product serialize here rather than both reading an
    // empty gallery and both inserting `isPrimary: true` — `imagesForProduct`
    // alone does not prevent that at READ COMMITTED, only ordering does.
    // `isPrimary` and `sequence` are then decided from that same locked read,
    // never from a value taken on the pool beforehand. `sequence` counts up
    // from the highest one in use rather than from the row count, because
    // deleting a photo from the middle leaves a gap that a count would hand
    // straight back to the next upload as a duplicate, and `loadImagesFor`
    // has no tiebreak beyond `sequence` to order the collision by.
    await productRepo.lockProduct(actor.tenantId, request.productId, trx);
    const existing = await imageRepo.imagesForProduct(actor.tenantId, request.productId, trx);
    const nextSequence = existing.reduce((next, image) => Math.max(next, image.sequence + 1), 0);

    await imageRepo.insertImage(
      actor.tenantId,
      {
        id: imageId,
        productId: request.productId,
        caption: request.crop.caption?.trim() || null,
        // The first photo on a product is primary by default (§3.3) — nobody
        // has to remember a separate "set as primary" click for a single-image product.
        isPrimary: existing.length === 0,
        sequence: nextSequence,
        width: derived.width,
        height: derived.height,
        checksum: derived.checksum,
        blurhash: derived.blurhash,
        byteSize: derived.byteSize,
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product_image',
        entityId: imageId,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { productId: request.productId, name: product.name },
      },
      actor,
      trx,
    );
  });

  const updated = await reloadProduct(actor.tenantId, request.productId);
  return publishUpdated(updated);
}

export async function updateImageCaption(
  imageId: string,
  input: ProductImageUpdateInput,
  actor: ActorContext,
): Promise<Product> {
  requirePermission(actor, 'products.edit');

  const productId = await db().transaction(async (trx) => {
    const existing = await imageRepo.lockImage(actor.tenantId, imageId, trx);
    if (!existing) throw new NotFoundError('Image');

    if (input.caption !== undefined) {
      await imageRepo.updateImage(actor.tenantId, imageId, { caption: input.caption }, trx);
    }
    if (input.isPrimary) {
      await imageRepo.setPrimary(actor.tenantId, existing.productId, imageId, trx);
    }

    const product = await productRepo.findProductById(actor.tenantId, existing.productId, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product_image',
        entityId: imageId,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { productId: existing.productId, name: product?.name ?? '' },
      },
      actor,
      trx,
    );

    return existing.productId;
  });

  const updated = await reloadProduct(actor.tenantId, productId);
  return publishUpdated(updated);
}

export async function reorderImages(input: ProductImageReorderInput, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.edit');

  const current = await imageRepo.imageIdsForProduct(actor.tenantId, input.productId);
  const currentSet = new Set(current);
  const inputSet = new Set(input.ids);
  const isCompletePermutation =
    current.length === input.ids.length && current.every((id) => inputSet.has(id)) && input.ids.every((id) => currentSet.has(id));
  if (!isCompletePermutation) {
    throw new ValidationError('validation.image.reorder.notPermutation');
  }

  await db().transaction(async (trx) => {
    await imageRepo.reorderImages(actor.tenantId, input.ids, trx);
    const product = await productRepo.findProductById(actor.tenantId, input.productId, trx);
    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product_image',
        entityId: input.productId,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { productId: input.productId, name: product?.name ?? '', reordered: true },
      },
      actor,
      trx,
    );
  });

  const updated = await reloadProduct(actor.tenantId, input.productId);
  return publishUpdated(updated);
}

/**
 * Hard-deletes the row and best-effort removes its files. Not a Recycle Bin
 * entity — `docs/schema/02-parties-and-products.md` already reasons that an
 * image has no history value of its own once separated from its product, and
 * a soft-deleted *product* keeps its image rows (only a hard delete cascades),
 * so restoring a product already restores its gallery for free.
 */
export async function deleteImage(imageId: string, actor: ActorContext): Promise<Product> {
  requirePermission(actor, 'products.edit');

  const productId = await db().transaction(async (trx) => {
    const existing = await imageRepo.lockImage(actor.tenantId, imageId, trx);
    if (!existing) throw new NotFoundError('Image');

    await imageRepo.deleteImage(actor.tenantId, imageId, trx);

    // A deleted primary image needs a new one, oldest remaining by sequence,
    // so a product never silently loses its gallery cover photo entirely.
    if (existing.isPrimary) {
      const remaining = await imageRepo.imageIdsForProduct(actor.tenantId, existing.productId, trx);
      const [nextPrimaryId] = remaining;
      if (nextPrimaryId) await imageRepo.setPrimary(actor.tenantId, existing.productId, nextPrimaryId, trx);
    }

    const product = await productRepo.findProductById(actor.tenantId, existing.productId, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'product_image',
        entityId: imageId,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { productId: existing.productId, name: product?.name ?? '' },
      },
      actor,
      trx,
    );

    return existing.productId;
  });

  await rm(imageDir(actor.tenantId, imageId), { recursive: true, force: true }).catch(() => {
    // Best-effort: the row is already gone, which is what every reader
    // consults — an orphaned file on disk is a storage-report discrepancy,
    // never a correctness problem.
  });

  const updated = await reloadProduct(actor.tenantId, productId);
  return publishUpdated(updated);
}

export interface ImageFile {
  path: string;
  variant: string;
  checksum: string;
}

/**
 * §4.3 — "the caller's role cannot view the product → 404, not 403": this
 * throws the same `NotFoundError` whether the image genuinely doesn't exist
 * or the actor simply lacks `products.view`, so a disallowed caller cannot
 * distinguish the two.
 */
export async function resolveImageFile(imageId: string, variant: string, actor: ActorContext): Promise<ImageFile> {
  if (!actorCan(actor, 'products.view')) throw new NotFoundError('Image');

  const image = await imageRepo.findImageById(actor.tenantId, imageId);
  if (!image) throw new NotFoundError('Image');

  const filePath = variantFilePath(actor.tenantId, imageId, variant);
  if (!filePath) throw new NotFoundError('Image');

  return { path: filePath, variant, checksum: image.checksum };
}

/**
 * Delete variant folders that no `product_images` row names.
 *
 * **At startup only, and that is a correctness requirement rather than a
 * scheduling preference.** `normalizeAndStore` writes four `.webp` files
 * *before* the caller inserts the row, so a sweep that anti-joins the directory
 * against `product_images.id` while somebody is uploading deletes a completed
 * upload's files and leaves a row pointing at nothing. At startup nothing else
 * is writing — the same reason `sweepOrphanTemporaries` gives for running
 * where it does.
 *
 * Orphans come from a crash between the files and the commit, and from a
 * restore that reinstated an older `product_images` than the disk holds.
 */
export async function sweepOrphanImageVariants(): Promise<number> {
  let removed = 0;

  let tenants: string[];
  try {
    tenants = await readdir(config.imagesDir);
  } catch {
    // No images directory yet. Nothing to sweep.
    return 0;
  }

  const known = await imageRepo.allImageIds();

  for (const tenantId of tenants) {
    const tenantDir = path.join(config.imagesDir, tenantId);

    let entries: string[];
    try {
      entries = await readdir(tenantDir);
    } catch {
      continue;
    }

    for (const imageId of entries) {
      if (known.has(imageId)) continue;
      await rm(path.join(tenantDir, imageId), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }

  if (removed > 0) log.info(`Removed ${removed} orphaned image folder(s)`);
  return removed;
}
