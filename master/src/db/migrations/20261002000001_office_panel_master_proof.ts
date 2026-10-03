/**
 * The key a Master proves itself with to a panel that found it at a new
 * address (1.3 batch, migration #2a; `shared/src/protocol/discovery.ts`).
 *
 * HMAC-SHA256 of the panel's secret, hex. The Master stores only the secret's
 * bcrypt hash, so it cannot work this out for an existing panel: the column
 * starts empty and `panel.service.ts#authenticatePanel` fills it the next time
 * that panel connects with its secret. Rediscovery therefore works for a panel
 * once it has connected one time after the update.
 *
 * Additive: a nullable column, no backfill. `down()` drops it — allowed there,
 * never in `up()`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE office_panels ADD COLUMN IF NOT EXISTS master_proof_key TEXT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE office_panels DROP COLUMN IF EXISTS master_proof_key');
}
