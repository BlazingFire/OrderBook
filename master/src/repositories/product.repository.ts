/**
 * Products — the catalogue a line item snapshots from. Syncable, so rows carry
 * text ids and sync bookkeeping.
 *
 * `rate` is this table's sale price (it was `price_per_box` before the rebuild).
 * The line item copies it at add time and never re-reads it, which is why
 * editing a product here cannot change what an existing order was quoted at.
 */

import type { Paginated, Product, ProductCategory, ProductInput } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { allocatePermanentId } from './identity.repository.js';
import { firstCount, mapProduct, mapProductCategory } from './mappers.js';
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

export async function listProducts(
  tenantId: string,
  options: { search?: string; limit: number; offset: number },
): Promise<Paginated<Product>> {
  const base = baseQuery(tenantId).andWhere('p.is_active', true);

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('p.name', pattern)
        .orWhereILike('p.product_code', pattern)
        .orWhereILike('p.alias', pattern)
        .orWhereILike('p.series', pattern)
        .orWhereILike('c.name', pattern),
    );
  }

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

  return {
    items: rows.map(mapProduct),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

export async function findProductById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
  options: { includeDeleted?: boolean } = {},
): Promise<Product | null> {
  const row = await baseQuery(tenantId, runner, options).andWhere('p.id', id).first();
  return row ? mapProduct(row) : null;
}

/**
 * Backs the "type a code, the line fills itself" convenience input (§3.2),
 * and the duplicate-code guard on create/edit. Filters `deleted_at` — without
 * it, the database would permit reusing a deleted product's code (the
 * partial unique index allows it) while this lookup still refused it,
 * making the Recycle Bin's freed code silently pointless
 * (`docs/backend-modules/03-DATABASE.md` §6.2).
 */
export async function findProductByCode(
  tenantId: string,
  code: string,
  runner: Runner = db(),
): Promise<Product | null> {
  const row = await baseQuery(tenantId, runner)
    .andWhereRaw('lower(p.product_code) = lower(?)', [code])
    .first();
  return row ? mapProduct(row) : null;
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

  await trx(TABLE).insert({
    id,
    tenant_id: product.tenantId,
    ...columnsFrom(product.input, categoryId),
    hlc: product.hlc,
    field_hlc: JSON.stringify(product.fieldHlc),
    temporary_id: product.temporaryId,
  });

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

  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...columnsFrom(input, categoryId),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });

  return updated ? findProductById(tenantId, id, trx) : null;
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
  renameCode?: string,
): Promise<Product | null> {
  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      ...(renameCode ? { product_code: renameCode } : {}),
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    });

  return updated ? findProductById(tenantId, id, trx, { includeDeleted: true }) : null;
}

export async function nextProductCode(): Promise<string> {
  const { rows } = await db().raw<{ rows: [{ code: string }] }>(
    `SELECT 'PRD-' || lpad(nextval('product_code_seq')::text, 4, '0') AS code`,
  );
  return rows[0].code;
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
): Promise<ProductCategory[]> {
  const rows = await runner(CATEGORY_TABLE).where({ tenant_id: tenantId }).orderBy('name', 'asc');
  return rows.map(mapProductCategory);
}

/**
 * What blocks deleting this product: a live line item (its parent lead or
 * order not itself deleted) or non-zero on-hand/reserved stock in any
 * colour. On-hand boxes are physical goods in a warehouse; a catalogue entry
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

  const stockRows = await runner('inventory_stock')
    .where({ tenant_id: tenantId, product_id: productId })
    .andWhere((builder) => builder.whereNot('quantity_boxes', 0))
    .select<Array<{ id: string; colour: string }>>('id', 'colour');

  const { rows: reservedRows } = await runner.raw<{ rows: Array<{ colour: string }> }>(
    `SELECT DISTINCT colour FROM stock_reservations
      WHERE tenant_id = ? AND product_id = ? AND status = 'active'`,
    [tenantId, productId],
  );

  // Every row here already has non-zero on-hand (filtered at the query), so
  // each one is a blocker on its own.
  const stockBlockers = stockRows.map((row) => ({
    entityType: 'inventory_stock' as const,
    id: row.id,
    label: row.colour,
  }));

  // A colour with zero on-hand but an active reservation still blocks —
  // `reservation.repository.ts` never guarantees a stock row exists for
  // every reserved colour.
  const reservedColours = new Set(reservedRows.map((row) => row.colour));
  const stockRowColours = new Set(stockRows.map((row) => row.colour));
  const reservationOnlyBlockers = [...reservedColours]
    .filter((colour) => !stockRowColours.has(colour))
    .map((colour) => ({ entityType: 'inventory_stock' as const, id: `${productId}:${colour}`, label: colour }));

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

function columnsFrom(input: ProductInput, categoryId: string | null): Record<string, unknown> {
  return {
    product_code: input.productCode,
    name: input.name,
    alias: input.alias ?? null,
    category_id: categoryId,
    size: input.size ?? null,
    sin: input.sin ?? null,
    grade: input.grade ?? null,
    product_type: input.productType ?? null,
    weight_kg: input.weightKg ?? null,
    finish: input.finish ?? null,
    series: input.series ?? null,
    color: input.color ?? null,
    thickness_mm: input.thicknessMm ?? null,
    pieces_per_box: input.piecesPerBox ?? null,
    box_coverage_sqft: input.boxCoverageSqft ?? null,
    rate: input.rate ?? null,
    price_per_sqft: input.pricePerSqft ?? null,
    hsn_code: input.hsnCode ?? null,
    parameters: JSON.stringify(input.parameters ?? {}),
    custom_fields: JSON.stringify(input.customFields ?? {}),
  };
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
