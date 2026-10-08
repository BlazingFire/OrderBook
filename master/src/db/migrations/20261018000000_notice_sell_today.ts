/**
 * "Sell today" (2026-10-08): a kind of notice that pops up once a day with the products to push.
 *
 * Four columns on `notices`, so an entry shares the audience (`notice_audiences`), the version,
 * the soft delete and the Recycle Bin with a notice:
 *
 *  - `kind`: `'notice'` (every row already up, and every row an older panel writes) or
 *    `'sellToday'`. The board, its unread count, the Basic Home notice band and the sign-in
 *    pop-up read `'notice'` rows only.
 *  - `product_ids`: the sub products (`products.id`) to push, in the manager's order. A JSON
 *    array rather than a join table: at most a dozen ids, always read and written whole, and a
 *    product deleted since is simply left off the cards (products are soft-deleted, so an id
 *    never points at a reused row).
 *  - `auto_close_seconds`: null for a notice; for an entry, 0 (only when closed) or 5 to 120.
 *  - `show_from`: the first day an entry applies, in the company's time zone. Null: from the day
 *    it was written. With `show_until` it is the entry's window.
 *
 * Additive only (`migration-data-safety.test.ts`) and safe to run twice: a column that already
 * exists is skipped with its constraint. `down()` drops them, which is allowed there only.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE notices
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'notice'
        CONSTRAINT notices_kind CHECK (kind IN ('notice', 'sellToday')),
      ADD COLUMN IF NOT EXISTS product_ids JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT notices_product_ids CHECK (jsonb_typeof(product_ids) = 'array'),
      ADD COLUMN IF NOT EXISTS auto_close_seconds INTEGER NULL
        CONSTRAINT notices_auto_close CHECK (
          auto_close_seconds IS NULL OR auto_close_seconds = 0 OR auto_close_seconds BETWEEN 5 AND 120
        ),
      ADD COLUMN IF NOT EXISTS show_from DATE NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE notices
      DROP COLUMN IF EXISTS kind,
      DROP COLUMN IF EXISTS product_ids,
      DROP COLUMN IF EXISTS auto_close_seconds,
      DROP COLUMN IF EXISTS show_from
  `);
}
