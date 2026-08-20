import type { Paginated, Product, ProductCategory, ProductInput } from '@orderbook/shared';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { firstCount, mapProduct, mapProductCategory } from './mappers.js';

const TABLE = 'products';
const CATEGORY_TABLE = 'product_categories';

/** Joined so a product always carries its category name for display. */
function baseQuery() {
  return db()(`${TABLE} as p`)
    .leftJoin(`${CATEGORY_TABLE} as c`, 'c.id', 'p.category_id')
    .select('p.*', 'c.name as category_name');
}

export async function listProducts(options: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<Paginated<Product>> {
  const base = baseQuery().where('p.is_active', true);

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder
        .whereILike('p.name', pattern)
        .orWhereILike('p.product_code', pattern)
        .orWhereILike('p.series', pattern)
        .orWhereILike('c.name', pattern),
    );
  }

  const countRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<{ count: string }[]>('p.id as count');

  const rows = await base.clone().orderBy('p.name', 'asc').limit(options.limit).offset(options.offset);

  return {
    items: rows.map(mapProduct),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

export async function findProductById(id: string): Promise<Product | null> {
  const row = await baseQuery().where('p.id', id).first();
  return row ? mapProduct(row) : null;
}

export async function findProductByCode(code: string): Promise<Product | null> {
  const row = await baseQuery().whereRaw('lower(p.product_code) = lower(?)', [code]).first();
  return row ? mapProduct(row) : null;
}

export async function insertProduct(input: ProductInput): Promise<Product> {
  const categoryId = await resolveCategoryId(input);

  const [row] = await db()(TABLE)
    .insert({
      id: uuid(),
      product_code: input.productCode,
      name: input.name,
      category_id: categoryId,
      size: input.size ?? null,
      finish: input.finish ?? null,
      series: input.series ?? null,
      color: input.color ?? null,
      thickness_mm: input.thicknessMm ?? null,
      pieces_per_box: input.piecesPerBox ?? null,
      box_coverage_sqft: input.boxCoverageSqft ?? null,
      price_per_box: input.pricePerBox ?? null,
      price_per_sqft: input.pricePerSqft ?? null,
      hsn_code: input.hsnCode ?? null,
      parameters: JSON.stringify(input.parameters ?? {}),
    })
    .returning('id');

  const created = await findProductById(String(row.id));
  if (!created) throw new Error('Product disappeared immediately after insert');
  return created;
}

export async function updateProduct(id: string, input: ProductInput): Promise<Product | null> {
  const categoryId = await resolveCategoryId(input);

  const updated = await db()(TABLE)
    .where({ id })
    .update({
      product_code: input.productCode,
      name: input.name,
      category_id: categoryId,
      size: input.size ?? null,
      finish: input.finish ?? null,
      series: input.series ?? null,
      color: input.color ?? null,
      thickness_mm: input.thicknessMm ?? null,
      pieces_per_box: input.piecesPerBox ?? null,
      box_coverage_sqft: input.boxCoverageSqft ?? null,
      price_per_box: input.pricePerBox ?? null,
      price_per_sqft: input.pricePerSqft ?? null,
      hsn_code: input.hsnCode ?? null,
      parameters: JSON.stringify(input.parameters ?? {}),
      updated_at: db().fn.now(),
    });

  return updated ? findProductById(id) : null;
}

export async function nextProductCode(): Promise<string> {
  const { rows } = await db().raw<{ rows: [{ code: string }] }>(
    `SELECT 'PRD-' || lpad(nextval('product_code_seq')::text, 4, '0') AS code`,
  );
  return rows[0].code;
}

export async function countProducts(): Promise<number> {
  const rows = await db()(TABLE)
    .where({ is_active: true })
    .count<{ count: string }[]>('id as count');
  return firstCount(rows);
}

export async function listCategories(): Promise<ProductCategory[]> {
  const rows = await db()(CATEGORY_TABLE).orderBy('name', 'asc');
  return rows.map(mapProductCategory);
}

/**
 * Accepts either an existing category id or a free-text name, so the Add
 * Product form can offer a combo box that creates categories on the fly
 * without a separate management screen.
 */
async function resolveCategoryId(input: ProductInput): Promise<string | null> {
  if (input.categoryId) return input.categoryId;

  const name = input.categoryName?.trim();
  if (!name) return null;

  const existing = await db()(CATEGORY_TABLE).whereRaw('lower(name) = lower(?)', [name]).first();
  if (existing) return String(existing.id);

  const [created] = await db()(CATEGORY_TABLE).insert({ id: uuid(), name }).returning('id');
  return String(created.id);
}
