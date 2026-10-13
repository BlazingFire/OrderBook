/**
 * Products — the models a line item snapshots from. Syncable, so rows carry
 * text ids and sync bookkeeping.
 *
 * A product is a model in a category; its codes and weights live on
 * `product_variants` (`product-variant.repository.ts`), and every read here
 * carries the variants along, because a product without them cannot be put
 * on a line, stocked or searched by code.
 *
 * A line item copies what it needs from the product at add time and never
 * re-reads it, which is why editing a product here cannot change what an
 * existing order recorded.
 */

import { columnPatch, PRODUCT_COLUMNS } from '@orderbook/shared';
import type {
  Product,
  ProductCategory,
  ProductCategoryListRow,
  ProductInput,
  ProductListPage,
} from '@orderbook/shared';
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

/**
 * Joined so a product always carries its category's name, code and brand for
 * display. Brand is read through the category and nowhere else — there is no
 * copy on `products` to fall out of step (`docs/catalogue/CATALOGUE_MODEL.md` §1).
 */
function baseQuery(tenantId: string, runner: Runner = db(), options: { includeDeleted?: boolean } = {}) {
  const query = runner(`${TABLE} as p`)
    .leftJoin(`${CATEGORY_TABLE} as c`, 'c.id', 'p.category_id')
    .where('p.tenant_id', tenantId)
    .select(
      'p.*',
      'c.name as category_name',
      'c.code as category_code',
      'c.brand as category_brand',
    );

  if (!options.includeDeleted) query.whereNull('p.deleted_at');
  return query;
}

/** A product whose variants have a weight gap — the "weight missing" chip. */
const MISSING_WEIGHT = `EXISTS (
  SELECT 1 FROM product_variants v
   WHERE v.product_id = p.id AND v.is_active AND v.weight_kg IS NULL
)`;

/**
 * 1.4 D3 (R17): the sortable columns, as SQL. The key comes from the caller, so
 * it is looked up here and never spliced into a query: an unknown key falls
 * back to catalogue order. Text is compared case-insensitively; a value that is
 * missing sorts last whichever way the column runs.
 */
const PRODUCT_SORT_SQL: Record<string, string> = {
  brand: 'lower(c.brand)',
  category: 'lower(c.name)',
  name: 'lower(p.name)',
  size: 'lower(p.size)',
  colours:
    '(SELECT min(lower(v.label)) FROM product_variants v WHERE v.product_id = p.id AND v.is_active)',
  code: '(SELECT min(lower(v.code)) FROM product_variants v WHERE v.product_id = p.id AND v.is_active)',
  weight:
    '(SELECT min(v.weight_kg) FROM product_variants v WHERE v.product_id = p.id AND v.is_active)',
};

const CATALOGUE_ORDER =
  'c.sort_order ASC NULLS LAST, lower(c.name) ASC, p.sort_order ASC NULLS LAST, lower(p.name) ASC, p.id ASC';

/** The ORDER BY for a requested sort; the catalogue's own order is the tie-break and the default. */
export function productOrderBy(sort: string | undefined, dir: string | undefined): string {
  const column = sort && Object.prototype.hasOwnProperty.call(PRODUCT_SORT_SQL, sort) ? PRODUCT_SORT_SQL[sort] : null;
  if (!column) return CATALOGUE_ORDER;
  return `${column} ${dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${CATALOGUE_ORDER}`;
}

export async function listProducts(
  tenantId: string,
  options: {
    search?: string;
    /** 1.4 D3 (R17). */
    sort?: string;
    dir?: string;
    size?: string;
    hasPhoto?: boolean;
    categoryId?: string;
    /** A `product.brand` value, matched case-insensitively against the category's brand. */
    brand?: string;
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
        .orWhereILike('p.size', pattern)
        .orWhereILike('c.name', pattern)
        .orWhereILike('c.code', pattern)
        .orWhereILike('c.brand', pattern)
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
  if (options.size?.trim()) base.whereRaw('lower(p.size) = lower(?)', [options.size.trim()]);
  if (options.hasPhoto !== undefined) {
    base.whereRaw(
      `${options.hasPhoto ? '' : 'NOT '}EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id)`,
    );
  }
  // Before the facet, unlike the category filter: a brand narrows which
  // category chips are worth offering at all.
  if (options.brand?.trim()) base.whereRaw('lower(c.brand) = lower(?)', [options.brand.trim()]);

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

  // Catalogue order — product by product, each product's sub products as the
  // catalogue prints them — the same order the pickers and the loader use.
  // Alphabetical put `10" FITTING`, `100` and `1001` from three products on
  // the first three rows.
  const rows = await base
    .clone()
    .orderByRaw(productOrderBy(options.sort, options.dir))
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
  /** Deleted products are returned unless asked otherwise: the snapshot needs them. */
  options: { includeDeleted?: boolean } = {},
): Promise<Map<string, Product>> {
  const found = new Map<string, Product>();
  if (ids.length === 0) return found;

  const rows = await baseQuery(tenantId, runner, {
    includeDeleted: options.includeDeleted ?? true,
  }).whereIn('p.id', ids);
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
  if (assertsCategory(input) && !categoryId) {
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

/** One category `ensureCategories` should find or create. */
export interface CategorySeed {
  name: string;
  code?: string | null;
  brand?: string | null;
  sortOrder?: number | null;
}

/**
 * The key `ensureCategories` answers each seed under: its code when it has
 * one, since a code is exact, and otherwise its name — behind its brand when
 * it has one, so two brands' "Wash Basin" in one import stay two seeds (the
 * pair `idx_categories_brand_name` keeps apart). Lower-cased throughout, the
 * way the unique indexes compare.
 */
export function categorySeedKey(seed: Pick<CategorySeed, 'name' | 'code' | 'brand'>): string {
  const code = seed.code?.trim();
  if (code) return code.toLowerCase();
  const brand = seed.brand?.trim();
  return (brand ? `${brand}\u0000${seed.name.trim()}` : seed.name.trim()).toLowerCase();
}

/**
 * The category id for each seed, creating the missing ones in one pass.
 *
 * `resolveCategoryId` does this for one row and stays for the single-product
 * paths; a five-thousand-row import over twenty categories, or the catalogue
 * loader's 41 products, wants one read and one insert, not one of each per row.
 *
 * Live rows only — a category in the Recycle Bin must not quietly collect new
 * sub products, and its name and code are free again by the partial unique
 * indexes. A seed matches by code first; failing that by (brand, name), the
 * pair `idx_categories_brand_name` keeps unique; and a seed that names no
 * brand takes any live category of that name, brandless first, so an import
 * row that only says "One Piece Toilet" does not mint a second one beside the
 * catalogue's. Nothing found is created with the seed's code, brand and order.
 * An existing row is never changed: loading is additive.
 *
 * Answers by `categorySeedKey`.
 */
export async function ensureCategories(
  tenantId: string,
  seeds: readonly CategorySeed[],
  trx: TransactionContext,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  const wanted = new Map<string, CategorySeed>();
  for (const seed of seeds) {
    const name = seed.name.trim();
    if (!name) continue;
    const clean = {
      name,
      code: seed.code?.trim() || null,
      brand: seed.brand?.trim() || null,
      sortOrder: seed.sortOrder ?? null,
    };
    const key = categorySeedKey(clean);
    if (!wanted.has(key)) wanted.set(key, clean);
  }
  if (wanted.size === 0) return byKey;

  const asked = [...wanted.values()];
  const existing = await trx(CATEGORY_TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .where((builder) =>
      builder
        .whereRaw('lower(name) = ANY(?)', [asked.map((seed) => seed.name.toLowerCase())])
        .orWhereRaw('lower(code) = ANY(?)', [
          asked.flatMap((seed) => (seed.code ? [seed.code.toLowerCase()] : [])),
        ]),
    )
    .orderByRaw('brand IS NOT NULL, created_at, id')
    .select<Array<{ id: string; name: string; code: string | null; brand: string | null }>>(
      'id',
      'name',
      'code',
      'brand',
    );

  const lower = (value: string | null | undefined): string => value?.toLowerCase() ?? '';
  const missing: Array<[string, CategorySeed]> = [];
  for (const [key, seed] of wanted) {
    const hit =
      (seed.code ? existing.find((row) => lower(row.code) === lower(seed.code)) : undefined) ??
      existing.find(
        (row) =>
          lower(row.name) === lower(seed.name) &&
          (seed.brand === null || lower(row.brand) === lower(seed.brand)),
      );
    if (hit) byKey.set(key, String(hit.id));
    else missing.push([key, seed]);
  }

  if (missing.length > 0) {
    const ids = await allocatePermanentIds(tenantId, 'product_category', missing.length, trx);
    await trx(CATEGORY_TABLE).insert(
      missing.map(([, seed], index) => ({
        id: ids[index],
        tenant_id: tenantId,
        name: seed.name,
        code: seed.code,
        brand: seed.brand,
        sort_order: seed.sortOrder,
      })),
    );
    missing.forEach(([key], index) => byKey.set(key, ids[index] as string));
  }

  return byKey;
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

/**
 * The live categories in catalogue order — `sort_order`, then name — each
 * with how many live sub products it holds, which is what the Products list
 * shows and what a delete is refused over. `search` matches the code, the
 * name and the brand; `brand` is one `product.brand` value, case-insensitive.
 */
export async function listCategories(
  tenantId: string,
  runner: Runner = db(),
  options: { search?: string; brand?: string } = {},
): Promise<ProductCategoryListRow[]> {
  const query = runner(`${CATEGORY_TABLE} as c`)
    .where('c.tenant_id', tenantId)
    .whereNull('c.deleted_at')
    .select(
      'c.*',
      runner.raw(
        `(SELECT count(*) FROM ${TABLE} p
           WHERE p.tenant_id = c.tenant_id AND p.category_id = c.id AND p.deleted_at IS NULL
        )::int AS sub_product_count`,
      ),
    )
    .orderByRaw('c.sort_order ASC NULLS LAST, lower(c.name) ASC, c.id ASC');

  if (options.brand?.trim()) query.whereRaw('lower(c.brand) = lower(?)', [options.brand.trim()]);

  const term = options.search?.trim();
  if (term) {
    const pattern = `%${term}%`;
    query.where((builder) =>
      builder
        .whereILike('c.name', pattern)
        .orWhereILike('c.code', pattern)
        .orWhereILike('c.brand', pattern),
    );
  }

  const rows = await query;
  return rows.map((row) => ({
    ...mapProductCategory(row),
    subProductCount: Number(row.sub_product_count),
  }));
}

/** The live category holding this code, case-insensitively — codes are unique among live rows. */
export async function findLiveCategoryByCode(
  tenantId: string,
  code: string,
  runner: Runner = db(),
): Promise<ProductCategory | null> {
  const row = await runner(CATEGORY_TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw('lower(code) = lower(?)', [code.trim()])
    .first();
  return row ? mapProductCategory(row) : null;
}

// --- Category writes (`docs/catalogue/CATALOGUE_MODEL.md` §5) ----------------

export async function findCategoryById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
  /** `forUpdate` inside a transaction only — `deleteCategory` says why. */
  options: { includeDeleted?: boolean; forUpdate?: boolean } = {},
): Promise<ProductCategory | null> {
  const query = runner(CATEGORY_TABLE).where({ tenant_id: tenantId, id });
  if (!options.includeDeleted) query.whereNull('deleted_at');
  if (options.forUpdate) query.forUpdate();
  const row = await query.first();
  return row ? mapProductCategory(row) : null;
}

/** The live category of this (brand, name) pair — the pair `idx_categories_brand_name` keeps unique. */
export async function findLiveCategoryByBrandName(
  tenantId: string,
  brand: string | null,
  name: string,
  runner: Runner = db(),
): Promise<ProductCategory | null> {
  const row = await runner(CATEGORY_TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw("lower(coalesce(brand, '')) = lower(?)", [brand ?? ''])
    .whereRaw('lower(name) = lower(?)', [name.trim()])
    .first();
  return row ? mapProductCategory(row) : null;
}

export async function insertCategory(
  category: {
    tenantId: string;
    name: string;
    code: string | null;
    brand: string | null;
    sortOrder: number | null;
  },
  trx: TransactionContext,
): Promise<ProductCategory> {
  const id = await allocatePermanentId(category.tenantId, 'product_category', trx);
  const [row] = await trx(CATEGORY_TABLE)
    .insert({
      id,
      tenant_id: category.tenantId,
      name: category.name,
      code: category.code,
      brand: category.brand,
      sort_order: category.sortOrder,
    })
    .returning('*');
  return mapProductCategory(row);
}

/** A partial patch: only the fields present are written. */
export async function updateCategoryColumns(
  tenantId: string,
  id: string,
  patch: { name?: string; code?: string; brand?: string | null; sortOrder?: number | null },
  trx: TransactionContext,
): Promise<ProductCategory | null> {
  const columns: Record<string, unknown> = { updated_at: trx.fn.now() };
  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.code !== undefined) columns.code = patch.code;
  if (patch.brand !== undefined) columns.brand = patch.brand;
  if (patch.sortOrder !== undefined) columns.sort_order = patch.sortOrder;

  const [row] = await trx(CATEGORY_TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update(columns)
    .returning('*');
  return row ? mapProductCategory(row) : null;
}

/**
 * Into the Recycle Bin (`deleted_at` set) or back out of it (`null`) — under
 * `renameTo` in the same statement, so a restore whose name was taken since
 * never meets the live-name index under its old one.
 */
export async function setCategoryDeletedAt(
  tenantId: string,
  id: string,
  deletedAt: 'now' | null,
  trx: TransactionContext,
  renameTo?: string,
): Promise<ProductCategory | null> {
  const [row] = await trx(CATEGORY_TABLE)
    .where({ tenant_id: tenantId, id })
    .modify((query) =>
      deletedAt ? query.whereNull('deleted_at') : query.whereNotNull('deleted_at'),
    )
    .update({
      deleted_at: deletedAt ? trx.fn.now() : null,
      updated_at: trx.fn.now(),
      ...(renameTo ? { name: renameTo } : {}),
    })
    .returning('*');
  return row ? mapProductCategory(row) : null;
}

/** The live sub products under a category, with their codes — what refuses its delete. */
export async function liveSubProducts(
  tenantId: string,
  categoryId: string,
  runner: Runner = db(),
): Promise<Array<{ id: string; name: string; codes: string }>> {
  const { rows } = await runner.raw<{
    rows: Array<{ id: string; name: string; codes: string | null }>;
  }>(
    `SELECT p.id, p.name,
            (SELECT string_agg(v.code, ', ' ORDER BY v.sequence)
               FROM product_variants v
              WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS codes
       FROM ${TABLE} p
      WHERE p.tenant_id = ? AND p.category_id = ? AND p.deleted_at IS NULL
      ORDER BY p.sort_order ASC NULLS LAST, lower(p.name) ASC, p.id ASC`,
    [tenantId, categoryId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    codes: row.codes ?? '',
  }));
}

/**
 * The live sub product of this name inside a category, other than `excludeId`.
 * Sub-product names are unique inside their product among live rows (§5) —
 * by the service, not an index: a v1.2 catalogue may already hold two.
 */
export async function findLiveSubProductByName(
  tenantId: string,
  categoryId: string,
  name: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<{ id: string } | null> {
  const query = runner(TABLE)
    .where({ tenant_id: tenantId, category_id: categoryId })
    .whereNull('deleted_at')
    .whereRaw('lower(name) = lower(?)', [name.trim()]);
  if (excludeId) query.whereNot('id', excludeId);
  const row = await query.first('id');
  return row ? { id: String(row.id) } : null;
}

/**
 * The live sub product a (product code, printed name) pair names, with its
 * first variant — the pair that stays the same across catalogue loads, where
 * the generated `CODE-####` codes need not.
 */
export async function findLiveSubProductByCodeAndName(
  tenantId: string,
  categoryCode: string,
  name: string,
  runner: Runner = db(),
): Promise<{ productId: string; variantId: string } | null> {
  const row = await runner(`${TABLE} as p`)
    .join(`${CATEGORY_TABLE} as c`, 'c.id', 'p.category_id')
    .join('product_variants as v', 'v.product_id', 'p.id')
    .where('p.tenant_id', tenantId)
    .whereNull('p.deleted_at')
    .whereNull('c.deleted_at')
    .whereNull('v.deleted_at')
    .whereRaw('lower(c.code) = lower(?)', [categoryCode])
    .whereRaw('lower(p.name) = lower(?)', [name])
    .orderBy('v.sequence')
    .first<{ product_id: string; variant_id: string } | undefined>(
      'p.id as product_id',
      'v.id as variant_id',
    );
  return row ? { productId: String(row.product_id), variantId: String(row.variant_id) } : null;
}

/** `OPT` and 7 → `OPT-0007`: a sub product's software code (§1). */
export function subProductCode(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(4, '0')}`;
}

/**
 * The next `count` free `PREFIX-####` variant codes, after the highest number
 * any variant has ever carried under that prefix — Recycle Bin rows included,
 * so a binned sub product's code is never handed out again and its restore
 * never collides.
 */
export async function nextSubProductCodes(
  tenantId: string,
  prefix: string,
  count: number,
  runner: Runner = db(),
): Promise<string[]> {
  const { rows } = await runner.raw<{ rows: Array<{ top: string | null }> }>(
    `SELECT max(substring(code FROM length(?) + 2)::bigint) AS top
       FROM product_variants
      WHERE tenant_id = ?
        AND lower(left(code, length(?) + 1)) = lower(? || '-')
        AND substring(code FROM length(?) + 2) ~ '^[0-9]+$'`,
    [prefix, tenantId, prefix, prefix, prefix],
  );
  const start = Number(rows[0]?.top ?? 0) + 1;
  return Array.from({ length: count }, (_, index) => subProductCode(prefix, start + index));
}

/**
 * Every live sub product with what the duplicate finder compares: its
 * Product and that Product's brand, its live variant codes, and how many live
 * lead/order lines quote it (the same test `liveReferencesToProduct` makes).
 */
export async function listSubProductsForDuplicates(
  tenantId: string,
  runner: Runner = db(),
): Promise<
  Array<{
    id: string;
    name: string;
    size: string | null;
    createdAt: string;
    categoryId: string | null;
    categoryName: string | null;
    brand: string | null;
    codes: string[];
    lineCount: number;
  }>
> {
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT p.id, p.name, p.size, p.created_at,
            c.id AS category_id, c.name AS category_name, c.brand,
            COALESCE((SELECT array_agg(v.code ORDER BY v.sequence)
                        FROM product_variants v
                       WHERE v.product_id = p.id AND v.deleted_at IS NULL), '{}') AS codes,
            (SELECT count(*)
               FROM line_items li
              WHERE li.tenant_id = p.tenant_id AND li.product_id = p.id
                AND ((li.parent_type = 'lead' AND EXISTS (
                        SELECT 1 FROM leads l WHERE l.id = li.parent_id AND l.deleted_at IS NULL))
                  OR (li.parent_type = 'order' AND EXISTS (
                        SELECT 1 FROM orders o WHERE o.id = li.parent_id AND o.deleted_at IS NULL)))
            )::int AS line_count
       FROM ${TABLE} p
       LEFT JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id AND c.deleted_at IS NULL
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL`,
    [tenantId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    size: (row.size as string | null) ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    categoryId: (row.category_id as string | null) ?? null,
    categoryName: (row.category_name as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    codes: (row.codes as string[]) ?? [],
    lineCount: Number(row.line_count),
  }));
}

/**
 * What blocks deleting this product: a live line item (its parent lead or
 * order not itself deleted).
 */
export async function liveReferencesToProduct(
  tenantId: string,
  productId: string,
  runner: Runner = db(),
): Promise<Array<{ entityType: 'line_item'; id: string; label: string }>> {
  const { rows: lineRows } = await runner.raw<{
    rows: Array<{ id: string; parent_id: string; product_name: string }>;
  }>(
    // The order's PO number where it has one, which is what the reader knows it by.
    `SELECT li.id, COALESCE(l.po_number, li.parent_id) AS parent_id, li.product_name
       FROM line_items li
       JOIN leads l ON li.parent_type = 'lead' AND l.id = li.parent_id AND l.deleted_at IS NULL
      WHERE li.tenant_id = ? AND li.product_id = ?
     UNION
     SELECT li.id, COALESCE(ld.po_number, li.parent_id) AS parent_id, li.product_name
       FROM line_items li
       JOIN orders o ON li.parent_type = 'order' AND o.id = li.parent_id AND o.deleted_at IS NULL
       LEFT JOIN leads ld ON ld.id = o.lead_id
      WHERE li.tenant_id = ? AND li.product_id = ?`,
    [tenantId, productId, tenantId, productId],
  );

  return [
    ...lineRows.map((row) => ({
      entityType: 'line_item' as const,
      id: row.id,
      label: `${row.product_name} (${row.parent_id})`,
    })),
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

  // The category is resolved by the caller, from an id, a code or a free-text
  // name, so it is settled here rather than copied straight off the input.
  if (assertsCategory(input)) {
    patch.category_id = categoryId;
  } else {
    delete patch.category_id;
  }

  return patch;
}

/** Whether the input names a category at all — absent on all three means "leave it alone". */
function assertsCategory(input: ProductInput): boolean {
  return (
    input.categoryId !== undefined ||
    input.categoryCode !== undefined ||
    input.categoryName !== undefined
  );
}

/**
 * The category a product input names, in the order
 * `docs/catalogue/CATALOGUE_MODEL.md` §5 sets — live rows only throughout:
 *
 * 1. **An id** must name a live category. One in the Recycle Bin is refused
 *    rather than quietly given a sub product nobody can see.
 * 2. **A code** must name a live category too, and never creates one: the
 *    loader and an import file use it precisely because it is exact, so a code
 *    that matches nothing is a typo to refuse, not a new product to invent
 *    under a name nobody chose.
 * 3. **A name** still creates on the fly, so the product form's combo box and
 *    an import keep working. With `categoryBrand` it is the (brand, name)
 *    pair `idx_categories_brand_name` keeps unique, and a new category is
 *    created under that brand. Without one, any live category of that name
 *    matches — a brandless one first, then the oldest — and a new one is
 *    created without a brand.
 *
 * A category found is read `FOR KEY SHARE`, held to the end of the write.
 * `deleteCategory` holds the row `FOR UPDATE` while it counts the live sub
 * products, so this either waits for that delete and then finds the category
 * binned, or is counted by it — never a sub product filed under a category in
 * the Recycle Bin. A rename's lock does not conflict with this one.
 */
async function resolveCategoryId(
  tenantId: string,
  input: ProductInput,
  trx: TransactionContext,
): Promise<string | null> {
  if (input.categoryId) {
    const live = await trx(CATEGORY_TABLE)
      .where({ tenant_id: tenantId, id: input.categoryId })
      .whereNull('deleted_at')
      .forKeyShare()
      .first('id');
    if (!live) throw new ValidationError('validation.product.categoryRequired');
    return String(live.id);
  }

  const code = input.categoryCode?.trim();
  if (code) {
    const byCode = await trx(CATEGORY_TABLE)
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw('lower(code) = lower(?)', [code])
      .forKeyShare()
      .first('id');
    if (!byCode) throw new ValidationError('validation.product.categoryCodeUnknown', { code });
    return String(byCode.id);
  }

  const name = input.categoryName?.trim();
  if (!name) return null;
  const brand = input.categoryBrand?.trim() || null;

  const query = trx(CATEGORY_TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw('lower(name) = lower(?)', [name]);
  if (brand) query.whereRaw('lower(brand) = lower(?)', [brand]);
  const existing = await query
    .orderByRaw('brand IS NOT NULL, created_at, id')
    .forKeyShare()
    .first('id');
  if (existing) return String(existing.id);

  const id = await allocatePermanentId(tenantId, 'product_category', trx);
  await trx(CATEGORY_TABLE).insert({ id, tenant_id: tenantId, name, brand });
  return id;
}
