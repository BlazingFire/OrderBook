/**
 * Inventory groundwork (Phase 2).
 *
 * - `note` lets staff record why a manual adjustment happened ("breakage",
 *   "counted after stock take"), which is the whole value of keeping an
 *   append-only ledger rather than just a running total.
 * - The reference index backs the check for whether a given order has already
 *   moved stock, which runs on every lead status change.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE stock_movements ADD COLUMN note TEXT;`);
  await knex.raw(`
    CREATE INDEX idx_stock_movements_reference
        ON stock_movements(reference_type, reference_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_stock_movements_reference;`);
  await knex.raw(`ALTER TABLE stock_movements DROP COLUMN IF EXISTS note;`);
}
