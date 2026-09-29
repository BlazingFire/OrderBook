/**
 * Catalogue model v2 on the 1.2 product master: brands, product codes and
 * catalogue order (`docs/catalogue/CATALOGUE_MODEL.md` §1, §3).
 *
 * The SWISWARE 2026 catalogue is Brand → Product → Sub product. A Product is a
 * `product_categories` row and a Sub product a one-variant model, so the only
 * schema the owner's restructure needs is on the category, plus an order and
 * two line snapshots:
 *
 * **Products (categories) gain a code, a brand, an order and a Recycle Bin.**
 * `code` is the software code staff type in the product bar instead of the
 * name (`OPT` for One Piece Toilet). `brand` is the `product.brand` option
 * value it is sold under — brand lives here and is read through the join, so
 * there is no copy on `products` to keep in step. `sort_order` is the
 * catalogue's own page order; alphabetical would put Accessories first.
 * `updated_at` and `deleted_at` exist because a category now has a real edit
 * and a soft delete of its own.
 *
 * **Name uniqueness moves from (tenant, name) to (tenant, brand, name), live
 * rows only.** Two brands may both sell a "One Piece Toilet"; one brand may
 * not have two. `lower(coalesce(brand, ''))` because a NULL brand would
 * otherwise never collide with anything, and every pre-v2 category has one.
 * `WHERE deleted_at IS NULL` so a category in the Recycle Bin does not hold
 * its name hostage — the rule `20260305` set for product and party codes. The
 * replacement is created *before* the old index is dropped, so there is no
 * moment without one. The code is unique the same way, and only when present.
 *
 * **Sub products gain `sort_order`** — catalogue order inside their product.
 *
 * **Lines snapshot the brand and the product code** (`brand_name`,
 * `category_code`) beside `category_name`, for the same reason it is
 * snapshotted: recoding a product or renaming a brand later must not rewrite
 * what an old lead was quoted as.
 *
 * **Why this name and this slot.** A stale checkout ran an older body of this
 * change as `20260323000000_catalogue_brands_and_codes`; that name is now a
 * no-op stub (see its file). This migration brings all three histories to one
 * schema, which is why every statement is `IF NOT EXISTS`:
 *
 *  - a fresh database or a 1.2.0 one: adds everything;
 *  - the stale database: finds everything already there (main's pending
 *    migrations ran on it first) and changes nothing.
 *
 * Pinned last in the registry, after the trim, for the reason
 * `20260325000000_line_item_grade` is: on a fresh database the trim runs at
 * the end, so anything ahead of it that it touches would be undone.
 *
 * Additive only (`migration-data-safety.test.ts`): no data, no dropped column,
 * no deleted row. Existing categories keep a NULL code and brand; the
 * catalogue loader owns filling them in. On a 1.2.0 database every brand is
 * NULL, so the new name index is exactly as strict as the one it replaces and
 * cannot fail on existing rows; every code is NULL, so neither can the code
 * index.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE product_categories
      ADD COLUMN IF NOT EXISTS code       TEXT,
      ADD COLUMN IF NOT EXISTS brand      TEXT,
      ADD COLUMN IF NOT EXISTS sort_order INTEGER,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_brand_name
      ON product_categories (tenant_id, lower(coalesce(brand, '')), lower(name))
      WHERE deleted_at IS NULL;

    DROP INDEX IF EXISTS idx_categories_name_tenant;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_code
      ON product_categories (tenant_id, lower(code))
      WHERE code IS NOT NULL AND deleted_at IS NULL;

    ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER;

    ALTER TABLE line_items
      ADD COLUMN IF NOT EXISTS brand_name    TEXT,
      ADD COLUMN IF NOT EXISTS category_code TEXT;
  `);
}

/**
 * Put back what a 1.2.0 database had. The old name index is restored first
 * and can fail if two brands now share a product name — a real conflict for
 * somebody to resolve, not something a rollback should guess at.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_tenant
      ON product_categories (tenant_id, lower(name));
    DROP INDEX IF EXISTS idx_categories_code;
    DROP INDEX IF EXISTS idx_categories_brand_name;

    ALTER TABLE line_items
      DROP COLUMN IF EXISTS brand_name,
      DROP COLUMN IF EXISTS category_code;
    ALTER TABLE products DROP COLUMN IF EXISTS sort_order;
    ALTER TABLE product_categories
      DROP COLUMN IF EXISTS code,
      DROP COLUMN IF EXISTS brand,
      DROP COLUMN IF EXISTS sort_order,
      DROP COLUMN IF EXISTS updated_at,
      DROP COLUMN IF EXISTS deleted_at;
  `);
}
