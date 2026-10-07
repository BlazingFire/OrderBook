/**
 * `product_images` — a product's photo gallery. Structurally the same shape
 * as `line_item_quantities` (`line-item.repository.ts`): a plain child table,
 * batch-loaded per parent and assembled into an array on the wire type.
 *
 * Unlike every syncable entity here, rows are plain UUIDs minted with
 * `randomUUID()` (mirroring Fields' `option_list_item`/`custom_field_definition`),
 * not the `LD`/`PR`/… text-id scheme — images are online-only (uploaded
 * directly against a reachable Master, never offline), so they never need a
 * temporary-id promotion path.
 */

import type { ProductImage } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { mapProductImage } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'product_images';

type Runner = Knex | Knex.Transaction;

export async function loadImagesFor(
  tenantId: string,
  productIds: string[],
  runner: Runner = db(),
): Promise<Map<string, ProductImage[]>> {
  const byProduct = new Map<string, ProductImage[]>();
  if (productIds.length === 0) return byProduct;

  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereIn('product_id', productIds)
    .orderBy([
      { column: 'is_primary', order: 'desc' },
      { column: 'sequence', order: 'asc' },
    ])
    .select('*');

  for (const row of rows) {
    const image = mapProductImage(row);
    const bucket = byProduct.get(image.productId);
    if (bucket) bucket.push(image);
    else byProduct.set(image.productId, [image]);
  }

  return byProduct;
}

export async function imagesForProduct(
  tenantId: string,
  productId: string,
  runner: Runner = db(),
): Promise<ProductImage[]> {
  const byProduct = await loadImagesFor(tenantId, [productId], runner);
  return byProduct.get(productId) ?? [];
}

export async function findImageById(
  tenantId: string,
  imageId: string,
  runner: Runner = db(),
): Promise<ProductImage | null> {
  const row = await runner(TABLE).where({ tenant_id: tenantId, id: imageId }).first();
  return row ? mapProductImage(row) : null;
}

/** Row-locks the image within the caller's transaction — used before a delete/setPrimary/reorder so a concurrent write can't race it. */
export async function lockImage(
  tenantId: string,
  imageId: string,
  trx: TransactionContext,
): Promise<ProductImage | null> {
  const row = await trx(TABLE).where({ tenant_id: tenantId, id: imageId }).forUpdate().first();
  return row ? mapProductImage(row) : null;
}

export interface NewImageRow {
  id: string;
  productId: string;
  caption: string | null;
  isPrimary: boolean;
  sequence: number;
  width: number;
  height: number;
  checksum: string;
  blurhash: string;
  byteSize: number;
}

export async function insertImage(tenantId: string, image: NewImageRow, trx: TransactionContext): Promise<ProductImage> {
  await trx(TABLE).insert({
    id: image.id,
    tenant_id: tenantId,
    product_id: image.productId,
    caption: image.caption,
    is_primary: image.isPrimary,
    sequence: image.sequence,
    width: image.width,
    height: image.height,
    checksum: image.checksum,
    blurhash: image.blurhash,
    byte_size: image.byteSize,
  });

  const created = await findImageById(tenantId, image.id, trx);
  if (!created) throw new Error('Product image disappeared immediately after insert');
  return created;
}

export async function updateImage(
  tenantId: string,
  imageId: string,
  patch: { caption?: string | null },
  trx: TransactionContext,
): Promise<ProductImage | null> {
  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id: imageId })
    .update({ ...(patch.caption !== undefined ? { caption: patch.caption } : {}) });

  return updated ? findImageById(tenantId, imageId, trx) : null;
}

/** What re-deriving an image's files from its source can change: the row keeps its id, product, caption and place. */
export async function updateImageDerivation(
  tenantId: string,
  imageId: string,
  derived: { width: number; height: number; checksum: string; blurhash: string; byteSize: number },
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id: imageId }).update({
    width: derived.width,
    height: derived.height,
    checksum: derived.checksum,
    blurhash: derived.blurhash,
    byte_size: derived.byteSize,
  });
}

/** Every image row of a tenant, id and product only: what the startup file check walks. */
export async function imageRefsForTenant(
  tenantId: string,
  runner: Runner = db(),
): Promise<Array<{ id: string; productId: string }>> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .select<Array<{ id: string; product_id: string }>>('id', 'product_id');
  return rows.map((row) => ({ id: String(row.id), productId: String(row.product_id) }));
}

/** Unsets every other image on the product, then marks this one primary — kept in one transaction so exactly one is ever true. */
export async function setPrimary(tenantId: string, productId: string, imageId: string, trx: TransactionContext): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, product_id: productId }).update({ is_primary: false });
  await trx(TABLE).where({ tenant_id: tenantId, id: imageId }).update({ is_primary: true });
}

export async function reorderImages(tenantId: string, ids: string[], trx: TransactionContext): Promise<void> {
  for (let i = 0; i < ids.length; i += 1) {
    await trx(TABLE).where({ tenant_id: tenantId, id: ids[i] }).update({ sequence: i });
  }
}

export async function imageIdsForProduct(tenantId: string, productId: string, runner: Runner = db()): Promise<string[]> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, product_id: productId })
    .orderBy('sequence')
    .select<Array<{ id: string }>>('id');
  return rows.map((row) => String(row.id));
}

export async function deleteImage(tenantId: string, imageId: string, trx: TransactionContext): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id: imageId }).delete();
}

/** Every image id this installation still has a row for, across all tenants. */
export async function allImageIds(runner: Runner = db()): Promise<Set<string>> {
  const rows = await runner(TABLE).select<Array<{ id: string }>>('id');
  return new Set(rows.map((row) => row.id));
}
