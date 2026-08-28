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

/*
 * Every `ADD COLUMN` carries `IF NOT EXISTS`, and `app_version` is the reason.
 *
 * `dev` shipped that one column separately as
 * `20260313000000_panel_app_version` before the two branches were merged, so a
 * database created on `dev` already has it while this migration has never run
 * there. Without `IF NOT EXISTS` this fails on "column app_version already
 * exists" and takes the other fourteen columns down with it — leaving the
 * panel-administration screen reading columns that do not exist.
 *
 * Editing a migration that has already run elsewhere is normally forbidden, and
 * this is the narrow case where it is safe: `IF NOT EXISTS` cannot change what
 * happened on a database that already ran it (Knex never re-runs a recorded
 * migration), and it is the only thing that lets a pre-merge database converge
 * with a fresh one. The `down` below has always used `IF EXISTS`, so this only
 * makes the two halves symmetric.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE office_panels
      ADD COLUMN IF NOT EXISTS notes              TEXT,
      ADD COLUMN IF NOT EXISTS hostname           TEXT,
      ADD COLUMN IF NOT EXISTS platform           TEXT,
      ADD COLUMN IF NOT EXISTS os_version         TEXT,
      ADD COLUMN IF NOT EXISTS app_version        TEXT,
      ADD COLUMN IF NOT EXISTS node_version       TEXT,
      ADD COLUMN IF NOT EXISTS data_dir           TEXT,
      ADD COLUMN IF NOT EXISTS images_dir         TEXT,
      ADD COLUMN IF NOT EXISTS storage_bytes      BIGINT,
      ADD COLUMN IF NOT EXISTS disk_free_bytes    BIGINT,
      ADD COLUMN IF NOT EXISTS disk_total_bytes   BIGINT,
      ADD COLUMN IF NOT EXISTS local_port         INTEGER,
      ADD COLUMN IF NOT EXISTS panel_started_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS device_reported_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS secret_rotated_at  TIMESTAMPTZ;
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
