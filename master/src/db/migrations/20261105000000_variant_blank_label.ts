/**
 * A product variant's colour may be left blank (code-only variants).
 *
 * The unique index on (product_id, label) treated a blank label as one value, so a product
 * could hold only one blank-coloured variant. It now guards only the labels that are given.
 * Structure only: no rows are touched.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_product_variants_label');
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_label
      ON product_variants (product_id, lower(label))
      WHERE coalesce(label, '') <> ''
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_product_variants_label');
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_label
      ON product_variants (product_id, lower(coalesce(label, '')))
  `);
}
