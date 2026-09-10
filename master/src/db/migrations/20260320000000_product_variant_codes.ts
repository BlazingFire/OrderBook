/**
 * A short, human-typed code for one product in one colour.
 *
 * The new-lead screen is built around it: somebody at the counter types `101`
 * and gets one product in one colour, with its free-to-sell figure, rather than
 * a product they then have to pick a colour on. That is a different identifier
 * from `products.product_code`, which names a product across every colour it
 * comes in.
 *
 * It lives on `inventory_stock` rather than in a table of its own because that
 * table already *is* the product-colour row — it is unique on
 * `(tenant_id, product_id, colour)` and the inventory repository's own header
 * says "a product now has one row per colour". A second table keyed on the same
 * pair would have to be kept in step with this one for no gain.
 *
 * Nullable, and no back-fill: a code is something a person decides, and
 * inventing `1`, `2`, `3` across an existing catalogue would hand out numbers
 * nobody chose and that nothing in the shop matches. Rows without one are still
 * findable by product code, product name and colour, exactly as they were.
 *
 * The unique index is partial so any number of rows may have no code while no
 * two rows in one tenant may share one.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE inventory_stock ADD COLUMN IF NOT EXISTS variant_code TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_variant_code
        ON inventory_stock(tenant_id, variant_code)
        WHERE variant_code IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_inventory_variant_code;
    ALTER TABLE inventory_stock DROP COLUMN IF EXISTS variant_code;
  `);
}
