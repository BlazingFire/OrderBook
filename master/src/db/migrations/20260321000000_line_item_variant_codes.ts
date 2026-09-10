/**
 * The product-and-colour code, frozen onto the line that used it.
 *
 * `20260320000000_product_variant_codes` put a short code on the
 * product-colour row so somebody at the counter can type `101` and get one
 * product in one colour. The new-lead screen searches by it and shows it as the
 * line's identity — but nothing kept it. `line_items.code` is the *product*
 * code, which names the product across every colour it comes in, so it cannot
 * say which colour was ordered. The code read down the phone was therefore
 * unrecoverable the moment the lead was saved, and a reprinted docket could not
 * show it.
 *
 * It goes on `line_item_quantities` rather than `line_items` because the code
 * names a colour, and colours are already child rows here — one line routinely
 * carries several. Snapshotted like every other line field (§8.3): renaming a
 * variant code afterwards must not rewrite what an old order was quoted as.
 *
 * Nullable, no back-fill, no unique index. Existing lines genuinely had no code
 * at the time, and inventing one now would put a number on a docket that nobody
 * chose. Uniqueness belongs on `inventory_stock`, where the code is *assigned*;
 * here it is a copy of what that row said on the day, and two lines quoting the
 * same code are the normal case.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE line_item_quantities ADD COLUMN IF NOT EXISTS variant_code TEXT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE line_item_quantities DROP COLUMN IF EXISTS variant_code;
  `);
}
