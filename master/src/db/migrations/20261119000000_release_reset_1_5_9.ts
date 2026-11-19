/**
 * 1.5.9's one-time catalogue and orders reset — the marker only (owner, 2026-11-19).
 *
 * 1.5.9 removes the variant layer and reshapes every sub product; the owner chose to start
 * the catalogue and the order book again rather than carry the old shape forward: every
 * order, lead, sub product, main product and product photo goes; users, parties and
 * settings stay. **Nothing is deleted here.** An update installs unattended at night, so the
 * deletion waits for an administrator to read the written warning on the Master and confirm
 * it (`release-reset.service.ts`), with a full backup taken first.
 *
 * This migration only adds: the `release_resets` table, and a `pending` row for each company
 * that has something to delete. A fresh install, or one with an empty book, gets a `done`
 * row, so nobody is asked to delete nothing. Additive (`migration-data-safety.test.ts`):
 * CREATE TABLE and INSERT, no rewrite of any existing row. Idempotent: `IF NOT EXISTS` and
 * `ON CONFLICT DO NOTHING`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS release_resets (
      tenant_id     UUID NOT NULL REFERENCES tenants(id),
      release       TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending', 'done')),
      epoch         TEXT NULL,
      backup_path   TEXT NULL,
      confirmed_by  UUID NULL,
      confirmed_at  TIMESTAMPTZ NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, release)
    );
  `);

  await knex.raw(`
    INSERT INTO release_resets (tenant_id, release, status)
    SELECT t.id, '1.5.9',
      CASE WHEN EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = t.id)
             OR EXISTS (SELECT 1 FROM leads l WHERE l.tenant_id = t.id)
             OR EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = t.id)
           THEN 'pending' ELSE 'done' END
    FROM tenants t
    ON CONFLICT (tenant_id, release) DO NOTHING;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS release_resets');
}
