/**
 * The variant layer comes off the sub product (owner's decision, 2026-11-16).
 *
 * Until now every sub product (a `products` row) carried exactly one
 * `product_variants` row just to hold its software code, its weight and —
 * as the label — its one fixed colour, while "multicolour" was a boolean
 * meaning "any colour of the company's list". The owner wants the flow he
 * actually works in: Product first, sub product under it, and the sub
 * product's own colour options in a dropdown when it offers more than one.
 * And which half of a printed note a sub product lands on becomes its own
 * setting (Left / Right / Default) instead of being read off whether its
 * name is numeric — Default keeping that original rule, so nothing already
 * printing moves.
 *
 * Additive only (`migration-data-safety.test.ts`): new columns on
 * `products`, filled from the variants every product already has, and the
 * old table left in place, dormant. Nothing is deleted and no column goes:
 *
 * - `code` and `weight_kg` come from the product's first variant (form
 *   order) — the only one the catalogue ever made. A model an older form
 *   gave several variants keeps every variant's label as a colour option,
 *   which is what those rows always meant at the counter.
 * - `colours` is those labels in order for a fixed-colour product, the
 *   tenant's whole live `stock.colour` list for a `multi_colour` one
 *   (copied, so later list edits do not silently change what a sub product
 *   offers), and empty for a dedicated one.
 * - `print_side` starts at `default` for every current sub product, which
 *   resolves exactly as the numeric rule prints today.
 * - `line_items.print_side` is the frozen side new lines carry; old lines
 *   keep NULL and resolve by name when they print, as they always have.
 *   `line_items.variant_id` stops being required — new lines have none —
 *   while its foreign key stays for the lines that quote one.
 *
 * The product search vector is rebuilt from the product's own code and
 * colours, and the trigger that refreshed it on variant writes goes (the
 * table is never written again; a DROP TRIGGER changes structure, not
 * records, which the data-safety gate allows).
 *
 * Idempotent: columns are `IF NOT EXISTS`, and the backfill only fills a
 * product whose `code` is still NULL, so a second run changes nothing.
 *
 * `down()` drops only what this file added.
 */

import type { Knex } from 'knex';

/** What a product is searchable by now: its name, its own code and colours, its alias and size. */
const PRODUCTS_SEARCH_REFRESH = `
  CREATE OR REPLACE FUNCTION products_search_refresh() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.code, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE((
        SELECT string_agg(colour, ' ')
          FROM jsonb_array_elements_text(COALESCE(NEW.colours, '[]'::jsonb)) AS colour
      ), '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
      setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C');
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
`;

interface ProductRow {
  id: string;
  tenant_id: string;
  multi_colour: boolean;
}

interface VariantRow {
  product_id: string;
  code: string;
  label: string | null;
  weight_kg: string | number | null;
}

function cleanColours(values: ReadonlyArray<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS code TEXT,
      ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,3),
      ADD COLUMN IF NOT EXISTS colours JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS print_side TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE line_items
      ADD COLUMN IF NOT EXISTS print_side TEXT;
    ALTER TABLE line_items ALTER COLUMN variant_id DROP NOT NULL;
  `);

  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE products
        ADD CONSTRAINT products_weight_check CHECK (weight_kg IS NULL OR weight_kg > 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE products
        ADD CONSTRAINT products_print_side_check CHECK (print_side IN ('default', 'left', 'right'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE line_items
        ADD CONSTRAINT line_items_print_side_check CHECK (print_side IS NULL OR print_side IN ('left', 'right'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // The tenant colour lists the multicolour products copy, in list order.
  const optionRows = (await knex('option_lists')
    .where({ list_key: 'stock.colour' })
    .whereNull('deleted_at')
    .orderBy(['tenant_id', 'sequence', 'created_at', 'id'])
    .select<Array<{ tenant_id: string; value: string }>>('tenant_id', 'value')) as Array<{
    tenant_id: string;
    value: string;
  }>;
  const tenantColours = new Map<string, string[]>();
  for (const row of optionRows) {
    const list = tenantColours.get(String(row.tenant_id)) ?? [];
    list.push(String(row.value));
    tenantColours.set(String(row.tenant_id), list);
  }

  const products = (await knex('products')
    .whereNull('code')
    .select<ProductRow[]>('id', 'tenant_id', 'multi_colour')) as ProductRow[];

  for (const product of products) {
    const variants = (await knex('product_variants')
      .where({ tenant_id: product.tenant_id, product_id: product.id })
      .orderBy(['sequence', 'created_at', 'id'])
      .select<VariantRow[]>('product_id', 'code', 'label', 'weight_kg')) as VariantRow[];
    const first = variants[0];
    const colours = product.multi_colour
      ? cleanColours(tenantColours.get(String(product.tenant_id)) ?? [])
      : cleanColours(variants.map((variant) => variant.label));

    await knex('products')
      .where({ id: product.id })
      .whereNull('code')
      .update({
        code: first?.code ?? null,
        weight_kg: first?.weight_kg ?? null,
        colours: JSON.stringify(colours),
      });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_code_tenant
      ON products (tenant_id, lower(code)) WHERE code IS NOT NULL AND deleted_at IS NULL;
  `);

  await knex.raw(PRODUCTS_SEARCH_REFRESH);
  await knex.raw(`
    DROP TRIGGER IF EXISTS product_variants_search_trg ON product_variants;
    UPDATE products SET search_vector = search_vector;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_products_code_tenant;
    ALTER TABLE line_items DROP COLUMN IF EXISTS print_side;
    ALTER TABLE products
      DROP COLUMN IF EXISTS print_side,
      DROP COLUMN IF EXISTS colours,
      DROP COLUMN IF EXISTS weight_kg,
      DROP COLUMN IF EXISTS code;
  `);
}
