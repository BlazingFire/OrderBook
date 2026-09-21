/**
 * The product master trimmed to what the business fills in, and pricing gone.
 *
 * The owner's decision of 2026-09-21: a product is a **name** in a **category**
 * with an optional **alias** and **size**; a variant is a **code**, a **colour**
 * and a **weight**; photos stay. Everything the tile trade and the trade-terms
 * pass had added — brand, barcode, HSN, unit of measure, grade, SIN, product
 * type, the thirteen ceramic attributes, the free-form `parameters` bag — is
 * dropped from `products`, and the same fields' snapshots go from `line_items`
 * and `party_product_variants`.
 *
 * Pricing is removed **whole**, not just the catalogue price: `products.rate`,
 * `mrp`, `purchase_rate`, `gst_rate_pct`, `price_per_sqft`, the line's `rate`
 * and `line_total`, the party-wise `rate`, and `total_amount` on leads and
 * orders. The `pricing.enabled` switch is deleted from `settings`, and the
 * four `field.*Rate.*` permission keys are stripped from every stored role the
 * way `20260322000000_drop_document_designer` stripped the Designer's — the
 * key list inlined and frozen here, never imported from `@orderbook/shared`.
 *
 * One thing is added. Some models are made in every colour of the company's
 * colour list ("all colours available in all items" in the catalogue), and
 * nobody wants sixteen variants per model to say so: `products.multi_colour`
 * marks such a model, and a lead line on it may then carry a `colour` chosen
 * from the `stock.colour` list. The colour is a line attribute frozen onto the
 * order, not a stock key — stock stays per variant.
 *
 * The search-vector functions are redefined **before** the columns they read
 * are dropped; a function body that names a dropped column fails on the next
 * insert, not at drop time. Option lists whose set no longer exists
 * (`product.*`, `line.grade`), connector field maps onto removed fields and
 * unresolved sync conflicts on them are deleted: each would otherwise be a row
 * that no screen can show or resolve.
 *
 * Idempotent: the body is skipped once `products.rate` is gone. `down()`
 * throws — the dropped columns' contents cannot be restored; use a backup.
 */

import type { Knex } from 'knex';

/** What a product is searchable by now: its name, its variants' codes and colours, its alias and size. */
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
      setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C');
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
`;

/** The line snapshot's vector, with the chosen colour beside the variant's own. */
const LINE_ITEMS_SEARCH_REFRESH = `
  CREATE OR REPLACE FUNCTION line_items_search_refresh() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', COALESCE(NEW.product_name, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.code, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.variant_label, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.colour, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.packaging, '')), 'C') ||
      setweight(to_tsvector('simple', COALESCE(NEW.notes, '')), 'D');
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
`;

/** The pricing keys, as `shared/src/domain/permissions.ts` spelled them on 2026-09-21. */
const REMOVED_PERMISSION_KEYS = new Set([
  'field.saleRate.view',
  'field.saleRate.edit',
  'field.purchaseRate.view',
  'field.purchaseRate.edit',
]);

/** The option-list sets whose columns are going. */
const REMOVED_LIST_KEYS = [
  'product.productType',
  'product.brand',
  'product.shade',
  'product.surfaceTexture',
  'product.originPlant',
  'line.grade',
];

/** The product wire fields a connector map or a sync conflict can no longer point at. */
const REMOVED_PRODUCT_FIELDS = [
  'sin',
  'grade',
  'productType',
  'finish',
  'series',
  'thicknessMm',
  'piecesPerBox',
  'boxCoverageSqft',
  'rate',
  'pricePerSqft',
  'hsnCode',
  'mrp',
  'purchaseRate',
  'gstRatePct',
  'uom',
  'barcode',
  'brand',
  'shade',
  'calibre',
  'waterAbsorptionPct',
  'peiRating',
  'edgeType',
  'surfaceTexture',
  'application',
  'originPlant',
  'parameters',
];

interface RoleRow {
  id: string;
  tenant_id: string;
  permissions: unknown;
}

export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{ rows: Array<{ present: boolean }> }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'rate'
     ) AS present`,
  );
  if (!rows[0]?.present) return;

  // --- A. Search functions first, while every column they used to read exists
  await knex.raw(PRODUCTS_SEARCH_REFRESH);
  await knex.raw(LINE_ITEMS_SEARCH_REFRESH);

  // --- B. products -----------------------------------------------------------
  //
  // Dropping a column takes its CHECK constraints and indexes with it
  // (`idx_products_brand`, `idx_products_barcode`, `idx_products_parameters`).
  await knex.raw(`
    ALTER TABLE products
      DROP COLUMN IF EXISTS sin,
      DROP COLUMN IF EXISTS grade,
      DROP COLUMN IF EXISTS product_type,
      DROP COLUMN IF EXISTS finish,
      DROP COLUMN IF EXISTS series,
      DROP COLUMN IF EXISTS thickness_mm,
      DROP COLUMN IF EXISTS pieces_per_box,
      DROP COLUMN IF EXISTS box_coverage_sqft,
      DROP COLUMN IF EXISTS rate,
      DROP COLUMN IF EXISTS price_per_sqft,
      DROP COLUMN IF EXISTS hsn_code,
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
      DROP COLUMN IF EXISTS origin_plant,
      DROP COLUMN IF EXISTS parameters,
      ADD COLUMN IF NOT EXISTS multi_colour BOOLEAN NOT NULL DEFAULT false;
  `);

  // --- C. line_items: the snapshots of the dropped fields, plus the colour ---
  await knex.raw(`
    ALTER TABLE line_items
      DROP COLUMN IF EXISTS rate,
      DROP COLUMN IF EXISTS line_total,
      DROP COLUMN IF EXISTS sin,
      DROP COLUMN IF EXISTS grade,
      DROP COLUMN IF EXISTS product_type,
      ADD COLUMN IF NOT EXISTS colour TEXT;
  `);

  // --- D. Money on leads, orders and the party-wise record -------------------
  await knex.raw(`
    ALTER TABLE leads DROP COLUMN IF EXISTS total_amount;
    ALTER TABLE orders DROP COLUMN IF EXISTS total_amount;
    ALTER TABLE party_product_variants
      DROP COLUMN IF EXISTS rate,
      DROP COLUMN IF EXISTS sin,
      DROP COLUMN IF EXISTS grade,
      DROP COLUMN IF EXISTS product_type;
  `);

  // --- E. Rows that named the removed fields ---------------------------------
  await knex('settings').where({ key: 'pricing.enabled' }).delete();
  await knex('option_lists').whereIn('list_key', REMOVED_LIST_KEYS).delete();
  await knex('api_connector_field_maps').whereIn('local_field', REMOVED_PRODUCT_FIELDS).delete();
  await knex('sync_conflicts')
    .where({ entity: 'product' })
    .whereIn('field', REMOVED_PRODUCT_FIELDS)
    .delete();
  await knex('sync_conflicts').where({ entity: 'party_variant' }).whereIn('field', ['rate', 'sin', 'grade', 'productType']).delete();

  // --- F. The pricing keys, out of every stored role -------------------------
  const roles = await knex('roles').select<RoleRow[]>('id', 'tenant_id', 'permissions');

  for (const role of roles) {
    const stored = Array.isArray(role.permissions)
      ? role.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const kept = stored.filter((permission) => !REMOVED_PERMISSION_KEYS.has(permission));

    // A filter cannot lengthen an array, so a length test is a correct no-op
    // check here — the same reasoning `20260304` gives for its own.
    if (kept.length === stored.length) continue;

    await knex('roles')
      .where({ id: role.id, tenant_id: role.tenant_id })
      .update({ permissions: JSON.stringify(kept) });
  }
}

export async function down(): Promise<void> {
  throw new Error(
    'Migration 20260324000000_product_master_trim cannot be rolled back — it dropped columns and their contents; restore from a backup.',
  );
}
