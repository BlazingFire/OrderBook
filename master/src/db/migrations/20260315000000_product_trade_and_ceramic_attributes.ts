/**
 * The trade and ceramic attributes the owner asked for, as columns.
 *
 * The rule this follows, stated once: **columns** for anything indexed,
 * constrained, arithmetic or standard-defined; **option lists** for
 * vocabularies staff extend; **custom fields** for neither. So `pei_rating` is
 * a constrained column and `brand` is a plain TEXT column backed by an option
 * list, exactly as `product_type` already is — a new brand arrives with a new
 * supplier and must not need a migration.
 *
 * **Batch or lot is deliberately not here, and that is a refusal of the
 * requirement as literally written.** One product receives many lots, so a
 * `batch_no` column on `products` is false the second time stock arrives. True
 * lot-level on-hand means re-keying `inventory_stock` from
 * `(tenant_id, product_id, colour)` and following that through
 * `stock_reservations`, `line_item_quantities`, `reservedTotals`,
 * `countLowStock`, dispatch settlement and the document renderer — a workstream,
 * not a column. What ships instead answers "which lot is this" from the
 * movement ledger, which is the data that upgrade would start from anyway.
 *
 * The reorder point is **not** renamed. `reorder_level` already exists and
 * carries `countLowStock`, `mapStockLevel`, a route and a mutation kind; moving
 * it would churn all four for no behaviour change.
 *
 * Cost note: `ADD COLUMN` with a constant default is catalogue-only on PG 11+,
 * so the columns are free. Each `ADD CONSTRAINT CHECK` takes an ACCESS
 * EXCLUSIVE lock and a full scan — milliseconds on a shop's catalogue, which is
 * thousands of rows.
 */

import type { Knex } from 'knex';

/**
 * Inlined and frozen, never imported from `@orderbook/shared`.
 *
 * That import is the `20260301` defect: editing the live catalogue
 * retroactively changed what an already-applied migration had done.
 */
const NEW_KEYS = ['field.purchaseRate.view', 'field.purchaseRate.edit'] as const;

/** The thirteen-term body. `CREATE OR REPLACE` rewrites the whole thing. */
const SEARCH_REFRESH_THIRTEEN = `
  CREATE OR REPLACE FUNCTION products_search_refresh() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.product_code, '')), 'A') ||
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
 * The eight-term body exactly as `20260302000000_lead_order_rebuild.ts` wrote
 * it, written out in full rather than referenced.
 *
 * A `down()` that reconstructed it from memory would silently degrade search:
 * nothing fails, results just get quietly worse.
 */
const SEARCH_REFRESH_EIGHT = `
  CREATE OR REPLACE FUNCTION products_search_refresh() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.product_code, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.sin, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.grade, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.series, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.product_type, '')), 'C');
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
`;

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  // --- A. The fourteen columns, then their constraints ----------------------

  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN mrp                  INTEGER,
      ADD COLUMN purchase_rate        INTEGER,
      ADD COLUMN gst_rate_pct         NUMERIC(5,2),
      ADD COLUMN uom                  TEXT NOT NULL DEFAULT 'box',
      ADD COLUMN barcode              TEXT,
      ADD COLUMN brand                TEXT,
      ADD COLUMN shade                TEXT,
      ADD COLUMN calibre              TEXT,
      ADD COLUMN water_absorption_pct NUMERIC(5,2),
      ADD COLUMN pei_rating           SMALLINT,
      ADD COLUMN edge_type            TEXT,
      ADD COLUMN surface_texture      TEXT,
      ADD COLUMN application          TEXT,
      ADD COLUMN origin_plant         TEXT
  `);

  await knex.raw(`
    ALTER TABLE products
      ADD CONSTRAINT products_uom_check CHECK (uom IN ('box', 'sqft', 'piece')),
      ADD CONSTRAINT products_edge_type_check
        CHECK (edge_type IS NULL OR edge_type IN ('rectified', 'non_rectified')),
      ADD CONSTRAINT products_application_check
        CHECK (application IS NULL OR application IN ('floor', 'wall', 'floor_wall', 'outdoor')),
      ADD CONSTRAINT products_pei_rating_check
        CHECK (pei_rating IS NULL OR (pei_rating >= 0 AND pei_rating <= 5)),
      ADD CONSTRAINT products_gst_rate_check
        CHECK (gst_rate_pct IS NULL OR (gst_rate_pct >= 0 AND gst_rate_pct <= 100)),
      ADD CONSTRAINT products_water_absorption_check
        CHECK (water_absorption_pct IS NULL OR (water_absorption_pct >= 0 AND water_absorption_pct <= 100)),
      ADD CONSTRAINT products_mrp_check CHECK (mrp IS NULL OR mrp >= 0),
      ADD CONSTRAINT products_purchase_rate_check CHECK (purchase_rate IS NULL OR purchase_rate >= 0)
  `);

  // --- B. Indexes ----------------------------------------------------------

  /*
   * Partial-unique, matching `idx_products_code_tenant` as redefined by
   * `20260305000000_soft_delete_columns.ts`. The `deleted_at IS NULL` half is
   * what keeps a barcode reusable after the product carrying it goes to the
   * Recycle Bin — without it, deleting a product would reserve its barcode
   * forever with nothing on screen to explain why.
   */
  await knex.raw(`
    CREATE UNIQUE INDEX idx_products_barcode
      ON products (tenant_id, barcode)
      WHERE barcode IS NOT NULL AND deleted_at IS NULL
  `);

  await knex.raw(`CREATE INDEX idx_products_brand ON products (tenant_id, brand)`);

  // --- C. Stock levels, and the lot fields on the ledger --------------------

  await knex.raw(`
    ALTER TABLE inventory_stock
      ADD COLUMN min_stock_level NUMERIC(12,2),
      ADD COLUMN max_stock_level NUMERIC(12,2),
      ADD CONSTRAINT inventory_stock_levels_check
        CHECK (min_stock_level IS NULL OR max_stock_level IS NULL OR max_stock_level >= min_stock_level)
  `);

  await knex.raw(`
    ALTER TABLE stock_movements
      ADD COLUMN batch_no TEXT,
      ADD COLUMN shade    TEXT,
      ADD COLUMN calibre  TEXT
  `);

  // "What arrived under lot X" is the query this table exists to answer once
  // batches are recorded, and it is only ever asked of rows that have one.
  await knex.raw(`
    CREATE INDEX idx_stock_movements_batch
      ON stock_movements (tenant_id, product_id, batch_no)
      WHERE batch_no IS NOT NULL
  `);

  // --- D. Search ------------------------------------------------------------

  await knex.raw(SEARCH_REFRESH_THIRTEEN);

  /*
   * Backfill through the trigger. `products_search_trg` is
   * `BEFORE INSERT OR UPDATE … FOR EACH ROW` with no `WHEN` clause and there is
   * no competing `updated_at` trigger, so a no-op update rebuilds every vector
   * — the same trick `20260302000000` uses after creating the function.
   */
  await knex.raw(`UPDATE products SET updated_at = updated_at`);

  // --- E. The permission grant ---------------------------------------------

  /*
   * Granted to every role that already holds `field.saleRate.edit` — a role
   * trusted to set what the company charges is the same role that needs to see
   * what it pays. Everyone else receives these keys from an administrator
   * ticking them in the grid, deliberately.
   */
  const roles = await knex('roles').select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    if (!stored.includes('field.saleRate.edit')) continue;

    // "Already holds every new key", never a length comparison — `permissions`
    // is a JSONB array that can legitimately contain duplicates from an older
    // replica, so a union can leave the length unchanged while still having
    // added something.
    if (NEW_KEYS.every((key) => stored.includes(key))) continue;

    const merged = [...new Set([...stored, ...NEW_KEYS])].sort();

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(merged) });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_stock_movements_batch`);
  await knex.raw(`
    ALTER TABLE stock_movements
      DROP COLUMN IF EXISTS batch_no,
      DROP COLUMN IF EXISTS shade,
      DROP COLUMN IF EXISTS calibre
  `);

  await knex.raw(`
    ALTER TABLE inventory_stock
      DROP CONSTRAINT IF EXISTS inventory_stock_levels_check,
      DROP COLUMN IF EXISTS min_stock_level,
      DROP COLUMN IF EXISTS max_stock_level
  `);

  await knex.raw(`DROP INDEX IF EXISTS idx_products_brand`);
  await knex.raw(`DROP INDEX IF EXISTS idx_products_barcode`);

  // The function has to come back to eight terms *before* the columns go, or
  // the backfill below would reference columns that no longer exist.
  await knex.raw(SEARCH_REFRESH_EIGHT);

  await knex.raw(`
    ALTER TABLE products
      DROP CONSTRAINT IF EXISTS products_uom_check,
      DROP CONSTRAINT IF EXISTS products_edge_type_check,
      DROP CONSTRAINT IF EXISTS products_application_check,
      DROP CONSTRAINT IF EXISTS products_pei_rating_check,
      DROP CONSTRAINT IF EXISTS products_gst_rate_check,
      DROP CONSTRAINT IF EXISTS products_water_absorption_check,
      DROP CONSTRAINT IF EXISTS products_mrp_check,
      DROP CONSTRAINT IF EXISTS products_purchase_rate_check,
      DROP COLUMN IF EXISTS mrp,
      DROP COLUMN IF EXISTS purchase_rate,
      DROP COLUMN IF EXISTS gst_rate_pct,
      DROP COLUMN IF EXISTS uom,
      DROP COLUMN IF EXISTS barcode,
      DROP COLUMN IF EXISTS brand,
      DROP COLUMN IF EXISTS shade,
      DROP COLUMN IF EXISTS calibre,
      DROP COLUMN IF EXISTS water_absorption_pct,
      DROP COLUMN IF EXISTS pei_rating,
      DROP COLUMN IF EXISTS edge_type,
      DROP COLUMN IF EXISTS surface_texture,
      DROP COLUMN IF EXISTS application,
      DROP COLUMN IF EXISTS origin_plant
  `);

  await knex.raw(`UPDATE products SET updated_at = updated_at`);

  // The permission grant is deliberately not revoked: by the time a rollback
  // runs an administrator may have granted these keys onward through the grid,
  // and this migration cannot tell its own grant from theirs. A key whose
  // capability no longer exists is filtered out by `effectivePermissions` on
  // every resolution, so leaving it costs nothing.
}
