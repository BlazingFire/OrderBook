/**
 * What version each Office Panel is running.
 *
 * A panel reports it in the socket handshake, so the Master can say which
 * machines on the shop floor are behind without anybody walking to them. Kept
 * on the panel row rather than derived at read time because a panel that is
 * switched off still has a last-known version worth showing — "offline, and it
 * was on 0.1.0 when we last saw it" is the useful answer, not a blank.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('office_panels', (table) => {
    table.text('app_version').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('office_panels', (table) => {
    table.dropColumn('app_version');
  });
}
