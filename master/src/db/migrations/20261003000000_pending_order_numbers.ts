/**
 * Pending order numbers (1.3 batch, migration #3): `PO/2026-27/00001`.
 *
 * Four steps, all additive and all safe to run twice:
 *
 *  1. `leads.po_number`, nullable, with a CHECK on its shape. The sequence is
 *     at least five digits and grows past them.
 *  2. Every existing lead gets a number, soft-deleted ones included, per
 *     company and per financial year (1 April to 31 March), in
 *     `(created_at, id)` order. UPDATE only. A re-run numbers only the rows
 *     still without one, after the highest number or counter already there.
 *  3. A partial UNIQUE index on `(tenant_id, po_number)`. It covers deleted
 *     leads too, so a deleted pending order's number is never handed out again.
 *  4. One `id_sequences` row per company and year, `po:<fy>`, set past the
 *     numbers just given. `identity.repository.ts#allocatePendingOrderNumber`
 *     takes the next number from it.
 *
 * The time zone is frozen here as 'Asia/Kolkata', the product's default,
 * rather than read from the Master's config: a migration must not change
 * meaning with a setting. `identity.repository.ts#backfillPendingOrderNumbers`
 * holds a frozen copy of steps 2 and 4 for a restore of a backup made before
 * this migration existed.
 */

import type { Knex } from 'knex';

const BACKFILL = `
  WITH src AS (
    SELECT id, tenant_id, created_at,
           (CASE WHEN EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Kolkata') >= 4
                 THEN EXTRACT(YEAR FROM created_at AT TIME ZONE 'Asia/Kolkata')
                 ELSE EXTRACT(YEAR FROM created_at AT TIME ZONE 'Asia/Kolkata') - 1 END)::int AS fy0
      FROM leads
     WHERE po_number IS NULL
  ), labelled AS (
    SELECT id, tenant_id, created_at, fy0 || '-' || lpad(((fy0 + 1) % 100)::text, 2, '0') AS fy
      FROM src
  ), base AS (
    SELECT tenant_id, fy, max(top) AS top
      FROM (SELECT tenant_id, split_part(po_number, '/', 2) AS fy, split_part(po_number, '/', 3)::bigint AS top
              FROM leads
             WHERE po_number IS NOT NULL
            UNION ALL
            SELECT tenant_id, substring(entity from 4) AS fy, next_value - 1 AS top
              FROM id_sequences
             WHERE entity LIKE 'po:%') taken
     GROUP BY tenant_id, fy
  ), numbered AS (
    SELECT l.id, l.tenant_id, l.fy,
           coalesce(b.top, 0) + row_number() OVER (PARTITION BY l.tenant_id, l.fy ORDER BY l.created_at, l.id) AS n
      FROM labelled l
      LEFT JOIN base b ON b.tenant_id = l.tenant_id AND b.fy = l.fy
  )
  UPDATE leads
     SET po_number = 'PO/' || numbered.fy || '/' || lpad(numbered.n::text, greatest(5, length(numbered.n::text)), '0')
    FROM numbered
   WHERE leads.id = numbered.id AND leads.tenant_id = numbered.tenant_id`;

const SEED_COUNTERS = `
  INSERT INTO id_sequences (tenant_id, entity, next_value)
  SELECT tenant_id, 'po:' || split_part(po_number, '/', 2), max(split_part(po_number, '/', 3)::bigint) + 1
    FROM leads
   WHERE po_number IS NOT NULL
   GROUP BY tenant_id, split_part(po_number, '/', 2)
  ON CONFLICT (tenant_id, entity) DO UPDATE
    SET next_value = greatest(id_sequences.next_value, EXCLUDED.next_value)`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE leads ADD COLUMN IF NOT EXISTS po_number TEXT NULL');
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_po_number_format') THEN
        ALTER TABLE leads ADD CONSTRAINT leads_po_number_format
          CHECK (po_number IS NULL OR po_number ~ '^PO/[0-9]{4}-[0-9]{2}/[0-9]{5,}$');
      END IF;
    END
    $$`);
  await knex.raw(BACKFILL);
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS leads_po_number_uq ON leads (tenant_id, po_number) WHERE po_number IS NOT NULL',
  );
  await knex.raw(SEED_COUNTERS);
}

export async function down(knex: Knex): Promise<void> {
  // Allowed in down() only. The `po:<fy>` counters are left: a number once
  // handed out is never handed out again, even across a rollback.
  await knex.raw('DROP INDEX IF EXISTS leads_po_number_uq');
  await knex.raw('ALTER TABLE leads DROP COLUMN IF EXISTS po_number');
}
