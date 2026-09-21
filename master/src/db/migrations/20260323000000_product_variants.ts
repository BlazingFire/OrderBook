/**
 * Category → product model → product variant.
 *
 * The product master was built for a tile trade: one `products` row carried
 * one code and one weight, and "colour" existed only as `inventory_stock` rows
 * that a stock movement happened to create. The business is sanitaryware,
 * where a model (DAMRU) is sold in many coded variants (41, 42, … each a
 * pattern; White; Rustic Coffee Brown) and every variant has its own code and
 * its own weight. So:
 *
 *  · `product_variants` is the new home of **every** code and weight. A
 *    product with no colour variants still has exactly one row, with a null
 *    label — which is what lets one unique index guard all codes, whichever
 *    kind of product they belong to.
 *  · `products` loses `product_code`, `weight_kg` and `color`, gains
 *    `has_variants`, and must belong to a category.
 *  · A lead or order line is **one variant** — `line_items.variant_id`,
 *    `variant_label`, `quantity` — instead of one product with a child table
 *    of colour quantities. Two colours of one model are two lines, each with
 *    its own code, weight and total.
 *  · Stock, movements and reservations are keyed by `variant_id` instead of
 *    `(product_id, colour)`.
 *
 * **This migration wipes every product-linked record** — products, categories,
 * image rows, party-wise rates, the stock ledger and snapshot, reservations,
 * leads, orders, their lines and timelines. The owner chose a fresh product
 * master from the catalogue over a migration of tile data that no longer
 * describes the business (2026-09-19), and leads and orders cannot outlive
 * the products they quote. Users, roles, parties, settings, pipelines and
 * option lists stay. `activity_log` is append-only and keeps its history of
 * the wiped ids; image *files* on disk are left alone, as every migration
 * here leaves files alone.
 *
 * Idempotent: the body is skipped once `products.product_code` is gone, so a
 * second run against an already-migrated database changes nothing.
 *
 * `down()` throws. The wipe and the dropped columns cannot be undone — restore
 * from a backup.
 */

import type { Knex } from 'knex';

/** The tile-era body of `products_search_refresh()` minus `product_code`, plus the variants. */
const PRODUCTS_SEARCH_REFRESH = `
  CREATE OR REPLACE FUNCTION products_search_refresh() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE((
        SELECT string_agg(v.code || ' ' || COALESCE(v.label, ''), ' ')
          FROM product_variants v
         WHERE v.product_id = NEW.id AND v.is_active AND v.deleted_at IS NULL
      ), '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.barcode, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.sin, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.brand, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.grade, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.series, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.product_type, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.shade, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.surface_texture, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.origin_plant, '')), 'D');
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
`;

/**
 * A variant changing re-fires the product's own trigger. `products_search_trg`
 * is `BEFORE INSERT OR UPDATE … FOR EACH ROW` with no column list and no
 * `WHEN`, so an update that assigns a column to itself rebuilds the vector
 * without touching `updated_at` — nothing on `products` maintains that column
 * by trigger.
 */
const VARIANTS_SEARCH_REFRESH = `
  CREATE OR REPLACE FUNCTION product_variants_search_refresh() RETURNS trigger AS $$
  BEGIN
    UPDATE products SET search_vector = search_vector
     WHERE id = COALESCE(NEW.product_id, OLD.product_id);
    RETURN NULL;
  END $$ LANGUAGE plpgsql;
`;

/** The line snapshot's vector, with the variant label alongside the code. */
const LINE_ITEMS_SEARCH_REFRESH = `
  CREATE OR REPLACE FUNCTION line_items_search_refresh() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', COALESCE(NEW.product_name, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.code, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.sin, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.variant_label, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.grade, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.packaging, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.notes, '')), 'D');
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
`;

export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{ rows: Array<{ present: boolean }> }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'product_code'
     ) AS present`,
  );
  if (!rows[0]?.present) return;

  // --- A. The wipe -----------------------------------------------------------
  //
  // One TRUNCATE naming every table at once: `orders.lead_id` and
  // `leads.converted_order_id` reference each other, and Postgres accepts a
  // circular set only when the whole set is truncated together.
  await knex.raw(`
    TRUNCATE TABLE
      stock_reservations, line_item_quantities, line_items, stock_movements,
      inventory_stock, timeline_entries, orders, leads, party_product_variants,
      product_images, products, product_categories
    RESTART IDENTITY;
    DELETE FROM sync_conflicts WHERE entity IN ('lead', 'order', 'product', 'party_variant');
    DELETE FROM api_connector_links WHERE entity = 'product';
  `);

  // --- B. product_variants ---------------------------------------------------

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS product_variants (
      id         TEXT PRIMARY KEY,
      tenant_id  UUID NOT NULL REFERENCES tenants(id),
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      code       TEXT NOT NULL,
      -- Null only on a product that has no colour or pattern variants: then
      -- this one row is the product's own code and weight.
      label      TEXT,
      weight_kg  NUMERIC(10,3),
      sequence   INTEGER NOT NULL DEFAULT 0,
      is_active  BOOLEAN NOT NULL DEFAULT true,
      -- Mirrors the product's tombstone so a binned product frees its codes
      -- for another product (the partial unique index below), the same way
      -- the tile-era code index was partial.
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT product_variants_weight_check CHECK (weight_kg IS NULL OR weight_kg > 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_code_tenant
      ON product_variants (tenant_id, lower(code)) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_label
      ON product_variants (product_id, lower(coalesce(label, '')));
    CREATE INDEX IF NOT EXISTS idx_product_variants_product
      ON product_variants (tenant_id, product_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_products_category
      ON products (tenant_id, category_id);
  `);

  // --- C. products -----------------------------------------------------------

  await knex.raw(PRODUCTS_SEARCH_REFRESH);
  await knex.raw(VARIANTS_SEARCH_REFRESH);
  await knex.raw(`
    DROP TRIGGER IF EXISTS product_variants_search_trg ON product_variants;
    CREATE TRIGGER product_variants_search_trg
      AFTER INSERT OR UPDATE OR DELETE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION product_variants_search_refresh();

    DROP INDEX IF EXISTS idx_products_code_tenant;
    ALTER TABLE products
      DROP COLUMN IF EXISTS product_code,
      DROP COLUMN IF EXISTS weight_kg,
      DROP COLUMN IF EXISTS color,
      -- The v1.1.0 colour rule (fixed/selectable): a variant is its own colour now.
      DROP COLUMN IF EXISTS colour_policy,
      ADD COLUMN IF NOT EXISTS has_variants BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE products ALTER COLUMN category_id SET NOT NULL;
    DROP SEQUENCE IF EXISTS product_code_seq;
  `);

  // --- D. line_items: one line per variant ---------------------------------

  await knex.raw(`
    DROP TABLE IF EXISTS line_item_quantities;
    ALTER TABLE line_items
      ADD COLUMN IF NOT EXISTS variant_id    TEXT NOT NULL REFERENCES product_variants(id),
      ADD COLUMN IF NOT EXISTS variant_label TEXT;
    ALTER TABLE line_items RENAME COLUMN total_quantity TO quantity;
    ALTER TABLE line_items ALTER COLUMN quantity DROP DEFAULT;
    ALTER TABLE line_items
      ADD CONSTRAINT line_items_quantity_positive CHECK (quantity > 0);
    CREATE INDEX IF NOT EXISTS idx_line_items_variant ON line_items (tenant_id, variant_id);
  `);
  await knex.raw(LINE_ITEMS_SEARCH_REFRESH);

  // --- E. Inventory, keyed by variant ---------------------------------------

  await knex.raw(`
    DROP INDEX IF EXISTS idx_inventory_product_colour;
    DROP INDEX IF EXISTS idx_inventory_variant_code;
    ALTER TABLE inventory_stock
      DROP COLUMN IF EXISTS colour,
      DROP COLUMN IF EXISTS variant_code,
      ADD COLUMN IF NOT EXISTS variant_id TEXT NOT NULL REFERENCES product_variants(id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_variant
      ON inventory_stock (tenant_id, variant_id);

    ALTER TABLE stock_movements
      DROP COLUMN IF EXISTS colour,
      ADD COLUMN IF NOT EXISTS variant_id TEXT NOT NULL REFERENCES product_variants(id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_variant
      ON stock_movements (tenant_id, variant_id);

    DROP INDEX IF EXISTS idx_reservations_product;
    ALTER TABLE stock_reservations
      DROP COLUMN IF EXISTS colour,
      ADD COLUMN IF NOT EXISTS variant_id TEXT NOT NULL REFERENCES product_variants(id);
    CREATE INDEX IF NOT EXISTS idx_reservations_variant
      ON stock_reservations (tenant_id, variant_id) WHERE status = 'active';
  `);

  // --- F. The id counter for the new entity ---------------------------------

  await knex.raw(`
    INSERT INTO id_sequences (tenant_id, entity, next_value)
    SELECT id, 'product_variant', 1 FROM tenants
    ON CONFLICT (tenant_id, entity) DO NOTHING;
  `);
}

export async function down(): Promise<void> {
  throw new Error(
    'Migration 20260323000000_product_variants cannot be rolled back — it wiped the product master and dropped columns; restore from a backup.',
  );
}
