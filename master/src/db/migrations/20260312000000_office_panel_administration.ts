/**
 * What the Master keeps on file about each Office Panel's own machine.
 *
 * The Master cannot discover any of this by looking: an Office Panel binds its
 * HTTP server to loopback (`office/src/config/index.ts`), so nothing on the LAN
 * — the Master included — can ask it a question. The panel volunteers it over
 * the socket it already holds (`panel:report`), and these columns are where the
 * last thing it said is kept, so the administration screen still has something
 * to show for a panel that is switched off.
 *
 * Every column is nullable and none is backfilled. A panel paired before this
 * migration has reported nothing, and "unknown" has to stay distinguishable
 * from "zero" — a `disk_free_bytes` defaulted to 0 would read as a full disk on
 * every panel in the company until each one next connected.
 *
 * `secret_rotated_at` is here rather than derived from `updated_at`: renaming a
 * panel also touches `updated_at`, and "when did this panel's credentials last
 * change" is a question an administrator asks about exactly one event.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE office_panels
      ADD COLUMN notes              TEXT,
      ADD COLUMN hostname           TEXT,
      ADD COLUMN platform           TEXT,
      ADD COLUMN os_version         TEXT,
      ADD COLUMN app_version        TEXT,
      ADD COLUMN node_version       TEXT,
      ADD COLUMN data_dir           TEXT,
      ADD COLUMN images_dir         TEXT,
      ADD COLUMN storage_bytes      BIGINT,
      ADD COLUMN disk_free_bytes    BIGINT,
      ADD COLUMN disk_total_bytes   BIGINT,
      ADD COLUMN local_port         INTEGER,
      ADD COLUMN panel_started_at   TIMESTAMPTZ,
      ADD COLUMN device_reported_at TIMESTAMPTZ,
      ADD COLUMN secret_rotated_at  TIMESTAMPTZ;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE office_panels
      DROP COLUMN IF EXISTS notes,
      DROP COLUMN IF EXISTS hostname,
      DROP COLUMN IF EXISTS platform,
      DROP COLUMN IF EXISTS os_version,
      DROP COLUMN IF EXISTS app_version,
      DROP COLUMN IF EXISTS node_version,
      DROP COLUMN IF EXISTS data_dir,
      DROP COLUMN IF EXISTS images_dir,
      DROP COLUMN IF EXISTS storage_bytes,
      DROP COLUMN IF EXISTS disk_free_bytes,
      DROP COLUMN IF EXISTS disk_total_bytes,
      DROP COLUMN IF EXISTS local_port,
      DROP COLUMN IF EXISTS panel_started_at,
      DROP COLUMN IF EXISTS device_reported_at,
      DROP COLUMN IF EXISTS secret_rotated_at;
  `);
}
