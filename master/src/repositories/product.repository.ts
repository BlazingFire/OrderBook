/**
 * Products — the models a line item snapshots from. Syncable, so rows carry
 * text ids and sync bookkeeping.
 *
 * A product is a model in a category; its codes and weights live on
 * `product_variants` (`product-variant.repository.ts`), and every read here
 * carries the variants along, because a product without them cannot be put
 * on a line, stocked or searched by code.
 *
 * `rate` is this table's sale price (it was `price_per_box` before the rebuild).
 * The line item copies it at add time and never re-reads it, which is why
 * editing a product here cannot change what an existing order was quoted at.
 */

import { columnPatch, PRODUCT_COLUMNS } from '@orderbook/shared';
import type { Product, ProductCategory, ProductInput, ProductListPage } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { ValidationError } from '../lib/errors.js';
import { allocatePermanentId, allocatePermanentIds } from './identity.repository.js';
import { firstCount, mapProduct, mapProductCategory } from './mappers.js';
import { loadImagesFor } from './product-image.repository.js';
import { loadVariantsFor, replaceVariants } from './product-variant.repository.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'products';
const CATEGORY_TABLE = 'product_categories';

type Runner = Knex | Knex.Transaction;

/** Joined so a product always carries its category name for display. */
function baseQuery(tenantId: string, runner: Runner = db(), options: { includeDeleted?: boolean } = {}) {
  const query = runner(`${TABLE} as p`)
    .leftJoin(`${CATEGORY_TABLE} as c`, 'c.id', 'p.category_id')
    .where('p.tenant_id', tenantId)
    .select('p.*', 'c.name as category_name');

  if (!options.includeDeleted) query.whereNull('p.deleted_at');
  return query;
}

/** A product whose variants have a weight gap — the "weight missing" chip. */
const MISSING_WEIGHT = `EXISTS (
  SELECT 1 FROM product_variants v
   WHERE v.product_id = p.id AND v.is_active AND v.weight_kg IS NULL
)`;

export async function listProducts(
  tenantId: string,
  options: {
    search?: string;
    categoryId?: string;
    missingWeight?: boolean;
    limit: number;
    offset: number;
  },
): Promise<ProductListPage> {
  const base = baseQuery(tenantId).andWhere('p.is_active', true);

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('p.name', pattern)
        .orWhereILike('p.alias', pattern)
        .orWhereILike('p.barcode', pattern)
        .orWhereILike('p.brand', pattern)
        .orWhereILike('p.product_type', pattern)
        .orWhereILike('c.name', pattern)
        // The codes are on the variants; a code typed into the catalogue
        // search still has to find its model.
        .orWhereExists((sub) =>
          sub
            .select('v.id')
            .from('product_variants as v')
            .whereRaw('v.product_id = p.id')
            .andWhere((inner) => inner.whereILike('v.code', pattern).orWhereILike('v.label', pattern)),
        ),
    );
  }

  if (options.missingWeight) base.whereRaw(MISSING_WEIGHT);

  // Counted over the search-filtered set *before* the category filter is
  // applied, so every chip stays clickable while one of them is selected.
  const facetRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .groupBy('c.id', 'c.name')
    .orderBy('c.name', 'asc')
    .select<Array<{ id: string; name: string; count: string }>>('c.id as id', 'c.name as name')
    .count('p.id as count');

  if (options.categoryId) base.andWhere('p.category_id', options.categoryId);

  const countRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<Array<{ count: string }>>('p.id as count');

  const rows = await base
    .clone()
    .orderBy('p.name', 'asc')
    .limit(options.limit)
    .offset(options.offset);

  const ids = rows.map((row) => String(row.id));
  const [images, variants] = await Promise.all([
    loadImagesFor(tenantId, ids),
    loadVariantsFor(tenantId, ids),
  ]);

  return {
    items: rows.map((row) =>
      mapProduct(row, images.get(String(row.id)) ?? [], variants.get(String(row.id)) ?? []),
    ),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
    categories: facetRows
      .filter((row) => row.id !== null && row.id !== undefined)
      .map((row) => ({ id: String(row.id), name: String(row.name), count: Number(row.count) })),
  };
}

export async function findProductById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
  options: { includeDeleted?: boolean } = {},
): Promise<Product | null> {
  const row = await baseQuery(tenantId, runner, options).andWhere('p.id', id).first();
  if (!row) return null;

  const [images, variants] = await Promise.all([
    loadImagesFor(tenantId, [id], runner),
    loadVariantsFor(tenantId, [id], runner),
  ]);
  return mapProduct(row, images.get(id) ?? [], variants.get(id) ?? []);
}

/** Several products by id, variants attached — for the picker and the snapshot. */
export async function findProductsByIds(
  tenantId: string,
  ids: string[],
  runner: Runner = db(),
): Promise<Map<string, Product>> {
  const found = new Map<string, Product>();
  if (ids.length === 0) return found;

  const rows = await baseQuery(tenantId, runner, { includeDeleted: true }).whereIn('p.id', ids);
  const rowIds = rows.map((row) => String(row.id));
  const [images, variants] = await Promise.all([
    loadImagesFor(tenantId, rowIds, runner),
    loadVariantsFor(tenantId, rowIds, runner),
  ]);
  for (const row of rows) {
    const id = String(row.id);
    found.set(id, mapProduct(row, images.get(id) ?? [], variants.get(id) ?? []));
  }
  return found;
}

/**
 * Row-locks the product within the caller's transaction — used before an
 * image upload so two overlapping uploads to the same product's empty
 * gallery cannot both read `existing.length === 0` and both insert
 * `isPrimary: true` under READ COMMITTED.
 */
export async function lockProduct(tenantId: string, id: string, trx: TransactionContext): Promise<void> {
  await trx('products').where({ tenant_id: tenantId, id }).forUpdate().first();
}

export interface NewProduct {
  tenantId: string;
  input: ProductInput;
  hlc: string;
  fieldHlc: Record<string, string>;
  temporaryId: string | null;
  id?: string;
}

export async function insertProduct(
  product: NewProduct,
  trx: TransactionContext,
): Promise<Product> {
  const id = product.id ?? (await allocatePermanentId(product.tenantId, 'product', trx));
  const categoryId = await resolveCategoryId(product.tenantId, product.input, trx);
  if (!categoryId) throw new ValidationError('validation.product.categoryRequired');

  await trx(TABLE).insert({
    id,
    tenant_id: product.tenantId,
    ...columnsFrom(product.input, categoryId),
    hlc: product.hlc,
    field_hlc: JSON.stringify(product.fieldHlc),
    temporary_id: product.temporaryId,
  });

  await replaceVariants(product.tenantId, id, product.input.variants ?? [], trx);

  const created = await findProductById(product.tenantId, id, trx);
  if (!created) throw new Error('Product disappeared immediately after insert');
  return created;
}

export async function updateProduct(
  tenantId: string,
  id: string,
  input: ProductInput,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Product | null> {
  const categoryId = await resolveCategoryId(tenantId, input, trx);
  if ((input.categoryId !== undefined || input.categoryName !== undefined) && !categoryId) {
    throw new ValidationError('validation.product.categoryRequired');
  }

  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...columnsFrom(input, categoryId),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
  if (!updated) return null;

  // Absent means "leave the variants alone"; present replaces the set.
  if (input.variants !== undefined) await replaceVariants(tenantId, id, input.variants, trx);

  return findProductById(tenantId, id, trx);
}

export async function updateProductColumns(
  tenantId: string,
  id: string,
  patch: Record<string, unknown>,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...patch,
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
}

export async function softDeleteProduct(
  tenantId: string,
  id: string,
  actorUserId: string | null,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Product | null> {
  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update({
      deleted_at: trx.fn.now(),
      deleted_by: actorUserId,
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    });

  return updated ? findProductById(tenantId, id, trx, { includeDeleted: true }) : null;
}

export async function restoreProduct(
  tenantId: string,
  id: string,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Product | null> {
  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    });

  return updated ? findProductById(tenantId, id, trx, { includeDeleted: true }) : null;
}

/** Which of these barcodes are already on a live product, with that product's id. */
export async function findLiveBarcodes(
  tenantId: string,
  barcodes: readonly string[],
  runner: Runner = db(),
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const wanted = [...new Set(barcodes.map((code) => code.trim().toLowerCase()).filter(Boolean))];

  for (let at = 0; at < wanted.length; at += 1000) {
    const rows = await runner(TABLE)
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw('lower(barcode) = ANY(?)', [wanted.slice(at, at + 1000)])
      .select<Array<{ id: string; barcode: string }>>('id', 'barcode');
    for (const row of rows) found.set(String(row.barcode).toLowerCase(), String(row.id));
  }

  return found;
}

/**
 * The category id for each name, creating the missing ones in one pass.
 *
 * `resolveCategoryId` does this for one row and stays for the single-product
 * paths; a five-thousand-row import over twenty categories wants one read and
 * one insert, not five thousand of each.
 */
export async function ensureCategories(
  tenantId: string,
  names: readonly string[],
  trx: TransactionContext,
): Promise<Map<string, string>> {
  const byLowerName = new Map<string, string>();
  const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (wanted.length === 0) return byLowerName;

  const lower = wanted.map((name) => name.toLowerCase());
  const existing = await trx(CATEGORY_TABLE)
    .where({ tenant_id: tenantId })
    .whereRaw('lower(name) = ANY(?)', [lower])
    .select<Array<{ id: string; name: string }>>('id', 'name');
  for (const row of existing) byLowerName.set(String(row.name).toLowerCase(), String(row.id));

  const missing = wanted.filter((name) => !byLowerName.has(name.toLowerCase()));
  if (missing.length > 0) {
    const ids = await allocatePermanentIds(tenantId, 'product_category', missing.length, trx);
    await trx(CATEGORY_TABLE).insert(
      missing.map((name, index) => ({ id: ids[index], tenant_id: tenantId, name })),
    );
    missing.forEach((name, index) => byLowerName.set(name.toLowerCase(), ids[index] as string));
  }

  return byLowerName;
}

/**
 * Many products in one INSERT, ids and clock already settled by the caller.
 *
 * No re-read: `insertProduct` reads its row back so the single-product paths
 * can hand the finished record to the browser, and a bulk import reports
 * counts rather than records.
 */
export async function insertProductRows(
  rows: ReadonlyArray<{ id: string; input: ProductInput; categoryId: string | null }>,
  meta: { tenantId: string; hlc: string },
  trx: TransactionContext,
): Promise<void> {
  if (rows.length === 0) return;

  await trx(TABLE).insert(
    rows.map((row) => ({
      id: row.id,
      tenant_id: meta.tenantId,
      ...columnsFrom(row.input, row.categoryId),
      hlc: meta.hlc,
      field_hlc: '{}',
      temporary_id: null,
    })),
  );
}

export async function countProducts(tenantId: string): Promise<number> {
  const rows = await db()(TABLE)
    .where({ tenant_id: tenantId, is_active: true })
    .whereNull('deleted_at')
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

export async function listCategories(
  tenantId: string,
  runner: Runner = db(),
  options: { search?: string } = {},
): Promise<ProductCategory[]> {
  const query = runner(CATEGORY_TABLE).where({ tenant_id: tenantId }).orderBy('name', 'asc');
  if (options.search?.trim()) query.whereILike('name', `%${options.search.trim()}%`);
  const rows = await query;
  return rows.map(mapProductCategory);
}

/**
 * What blocks deleting this product: a live line item (its parent lead or
 * order not itself deleted) or non-zero on-hand/reserved stock on any
 * variant. On-hand boxes are physical goods in a warehouse; a catalogue entry
 * can be wrong, but the pallet is not.
 */
export async function liveReferencesToProduct(
  tenantId: string,
  productId: string,
  runner: Runner = db(),
): Promise<Array<{ entityType: 'line_item' | 'inventory_stock'; id: string; label: string }>> {
  const { rows: lineRows } = await runner.raw<{
    rows: Array<{ id: string; parent_id: string; product_name: string }>;
  }>(
    `SELECT li.id, li.parent_id, li.product_name
       FROM line_items li
       JOIN leads l ON li.parent_type = 'lead' AND l.id = li.parent_id AND l.deleted_at IS NULL
      WHERE li.tenant_id = ? AND li.product_id = ?
     UNION
     SELECT li.id, li.parent_id, li.product_name
       FROM line_items li
       JOIN orders o ON li.parent_type = 'order' AND o.id = li.parent_id AND o.deleted_at IS NULL
      WHERE li.tenant_id = ? AND li.product_id = ?`,
    [tenantId, productId, tenantId, productId],
  );

  const stockRows = await runner('inventory_stock as s')
    .join('product_variants as v', 'v.id', 's.variant_id')
    .where({ 's.tenant_id': tenantId, 's.product_id': productId })
    .andWhere((builder) => builder.whereNot('s.quantity_boxes', 0))
    .select<Array<{ id: string; variant_id: string; code: string; label: string | null }>>(
      's.id',
      's.variant_id',
      'v.code',
      'v.label',
    );

  const { rows: reservedRows } = await runner.raw<{
    rows: Array<{ variant_id: string; code: string; label: string | null }>;
  }>(
    `SELECT DISTINCT r.variant_id, v.code, v.label
       FROM stock_reservations r
       JOIN product_variants v ON v.id = r.variant_id
      WHERE r.tenant_id = ? AND r.product_id = ? AND r.status = 'active'`,
    [tenantId, productId],
  );

  const variantLabel = (row: { code: string; label: string | null }): string =>
    row.label ? `${row.label} (${row.code})` : row.code;

  // Every row here already has non-zero on-hand (filtered at the query), so
  // each one is a blocker on its own.
  const stockBlockers = stockRows.map((row) => ({
    entityType: 'inventory_stock' as const,
    id: row.id,
    label: variantLabel(row),
  }));

  // A variant with zero on-hand but an active reservation still blocks —
  // `reservation.repository.ts` never guarantees a stock row exists for
  // every reserved variant.
  const stockedVariants = new Set(stockRows.map((row) => String(row.variant_id)));
  const reservationOnlyBlockers = reservedRows
    .filter((row) => !stockedVariants.has(String(row.variant_id)))
    .map((row) => ({
      entityType: 'inventory_stock' as const,
      id: String(row.variant_id),
      label: variantLabel(row),
    }));

  return [
    ...lineRows.map((row) => ({
      entityType: 'line_item' as const,
      id: row.id,
      label: `${row.product_name} (${row.parent_id})`,
    })),
    ...stockBlockers,
    ...reservationOnlyBlockers,
  ];
}

/**
 * Only the columns this input actually asserts.
 *
 * This used to list every column with `?? null` and was spread straight into
 * `.update()`, which made an update a full record replace: the 8-field product
 * drawer nulled the twelve columns it does not know about. See the contract in
 * `shared/src/domain/columns.ts`.
 *
 * A partial insert is safe because `parameters` and `custom_fields` are both
 * `JSONB NOT NULL DEFAULT '{}'` — the constraint any column added here must
 * also meet.
 */
function columnsFrom(input: ProductInput, categoryId: string | null): Record<string, unknown> {
  const patch = columnPatch(input, PRODUCT_COLUMNS);

  // The category is resolved by the caller, from either an id or a free-text
  // name, so it is settled here rather than copied straight off the input.
  if (input.categoryId !== undefined || input.categoryName !== undefined) {
    patch.category_id = categoryId;
  } else {
    delete patch.category_id;
  }

  return patch;
}

/**
 * Accepts either an existing category id or a free-text name, so the Add
 * Product form can offer a combo box that creates categories on the fly
 * without a separate management screen.
 */
async function resolveCategoryId(
  tenantId: string,
  input: ProductInput,
  trx: TransactionContext,
): Promise<string | null> {
  if (input.categoryId) return input.categoryId;

  const name = input.categoryName?.trim();
  if (!name) return null;

  const existing = await trx(CATEGORY_TABLE)
    .where({ tenant_id: tenantId })
    .whereRaw('lower(name) = lower(?)', [name])
    .first();
  if (existing) return String(existing.id);

  const id = await allocatePermanentId(tenantId, 'product_category', trx);
  await trx(CATEGORY_TABLE).insert({ id, tenant_id: tenantId, name });
  return id;
}
