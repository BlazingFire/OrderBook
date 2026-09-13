/**
 * The catalogue's colour rule, and the main product a line was sold under.
 *
 * The SWISWARE catalogue is Brand → main product (One Piece Toilet, Water
 * Closet, …) → model (102 (9″), E.W.C. - S TRAP, …). Brand and main product
 * already exist (`products.brand`, `products.category_id`). What nothing could
 * say is the colour rule the printed catalogue states per range: a designer
 * table top IS its printed colour and may never be re-coloured, while the
 * plain Water Closet range is "available in all colours" and the counter
 * chooses one at sale time.
 *
 * `products.colour_policy` is that rule: `'fixed'` locks the model to its base
 * `color`; `'selectable'` lets lead entry choose from the `stock.colour` list.
 * It defaults to `'fixed'` because the overwhelming majority of the catalogue
 * is pre-coloured, and because the safe failure of an unset flag is "the
 * counter cannot change the colour", never "a fixed print got sold in white".
 *
 * `line_items.category_name` snapshots the main product the line was entered
 * under, beside the existing `product_name`/`code` snapshots: renaming or
 * re-categorising the product afterwards must not rewrite what an old order
 * was quoted as (§8.3), and a document printed a year later still names the
 * range the customer asked for.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS colour_policy TEXT NOT NULL DEFAULT 'fixed'
        CHECK (colour_policy IN ('fixed', 'selectable'));

    ALTER TABLE line_items
      ADD COLUMN IF NOT EXISTS category_name TEXT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products DROP COLUMN IF EXISTS colour_policy;
    ALTER TABLE line_items DROP COLUMN IF EXISTS category_name;
  `);
}
