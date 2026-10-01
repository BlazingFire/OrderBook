/**
 * The vehicle an order goes out on, printed on the Dispatch note
 * (docs/ORDER_NOTES_PLAN.md, decision 5).
 *
 * The Filling note leaves the vehicle as a line to write in; the Dispatch note
 * prints it large, so it has to be a real field the office can fill in before
 * the paper is printed rather than something scribbled on afterwards.
 *
 * Additive only (`migration-data-safety.test.ts`): a nullable column, no
 * backfill. `down()` drops it — allowed there, never in `up()`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS vehicle_number TEXT NULL
        CONSTRAINT orders_vehicle_number_len CHECK (char_length(vehicle_number) <= 20)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE orders DROP COLUMN IF EXISTS vehicle_number');
}
