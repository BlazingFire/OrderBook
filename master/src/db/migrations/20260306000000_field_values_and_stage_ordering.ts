/**
 * Fields, Stage 3 of `docs/backend-modules/`. Makes `option_lists`,
 * `custom_field_definitions` and `pipeline_stages` editable for the first
 * time — until now the three feeding `GET /api/pipelines`,
 * `/api/option-lists` and `/api/custom-fields` were read-only, seeded once by
 * `20260301` and never written to again.
 *
 * Four phases, in order:
 *   A — `option_lists` and `custom_field_definitions` both gain their
 *       soft-delete pair, a `version` column, a partial unique index in place
 *       of the plain one, and a Bin keyset index — the same shape
 *       `20260305000000_soft_delete_columns.ts` gave the six Stage 2 tables.
 *   B — `option_lists.hex` with its format `CHECK`; `pipeline_stages.is_archived`
 *       with its own `CHECK` refusing an archived default.
 *   C — `idx_pipeline_stages_seq` becomes a deferrable table constraint. A
 *       unique *index* cannot be `DEFERRABLE`, and dragging a stage above
 *       another means writing sequences that transiently collide — with an
 *       immediate check, the first `UPDATE` of a reorder fails outright.
 *   D — the three list keys `20260301` did not seed (`stock.colour`,
 *       `product.productType`, `line.packaging`), backfilled from the
 *       distinct strings already present in the data, one insert per tenant.
 *
 * **`down()` is deliberately empty**, for three reasons, not one:
 *   - same argument as `20260305`: dropping `deleted_at` would resurrect every
 *     soft-deleted option and definition as live, with no trace anyone removed
 *     it;
 *   - the seeded colour rows are user-visible configuration an administrator
 *     may have relabelled and given hex values to by the time anyone rolls
 *     back — deleting them by `list_key` on the way down discards that work
 *     silently;
 *   - reverting `pipeline_stages_seq_unique` to a plain unique index would
 *     leave the reorder endpoint unimplementable while the application still
 *     calls it.
 * Precedent: `20260304000000_role_tier_ceiling_repair.ts`,
 * `20260305000000_soft_delete_columns.ts`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // --- Phase A — soft delete, version, partial indexes, Bin indexes --------

  await knex.raw(`
    ALTER TABLE option_lists
      ADD COLUMN hex        TEXT,
      ADD COLUMN created_by TEXT,
      ADD COLUMN updated_by TEXT,
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN deleted_by TEXT,
      ADD COLUMN version    INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    ALTER TABLE custom_field_definitions
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN deleted_by TEXT,
      ADD COLUMN version    INTEGER NOT NULL DEFAULT 1;
  `);

  // The six seeded `lead.sourcePlatform` rows would otherwise claim they were
  // created the day this migration ran, which is false and would sort them to
  // the top of any "recently changed" view. `custom_field_definitions` has no
  // rows to backfill on any installation — nothing has ever written one.
  await knex.raw(`
    UPDATE option_lists o
       SET created_at = t.created_at, updated_at = t.created_at
      FROM tenants t
     WHERE t.id = o.tenant_id;
  `);

  await knex.raw(`
    DROP INDEX idx_option_lists_key_value;
    CREATE UNIQUE INDEX idx_option_lists_key_value
        ON option_lists (tenant_id, list_key, value) WHERE deleted_at IS NULL;
    CREATE INDEX idx_option_lists_deleted
        ON option_lists (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;

    DROP INDEX idx_custom_fields_key;
    CREATE UNIQUE INDEX idx_custom_fields_key
        ON custom_field_definitions (tenant_id, entity, key) WHERE deleted_at IS NULL;
    CREATE INDEX idx_custom_fields_deleted
        ON custom_field_definitions (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
  `);

  // --- Phase B — hex format, and a stage that cannot be both archived and default ---

  await knex.raw(`
    ALTER TABLE option_lists
      ADD CONSTRAINT option_lists_hex_format
      CHECK (hex IS NULL OR hex ~ '^#[0-9A-Fa-f]{6}$');
  `);

  await knex.raw(`
    ALTER TABLE pipeline_stages
      ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_archived_not_default
      CHECK (NOT (is_archived AND is_default));
  `);

  // --- Phase C — reordering needs a deferrable constraint -------------------
  //
  // A unique index cannot carry DEFERRABLE, only a table constraint can, so the
  // old index is dropped and rebuilt as one. INITIALLY IMMEDIATE keeps every
  // ordinary write checked at once; only a reorder transaction opts into
  // `SET CONSTRAINTS pipeline_stages_seq_unique DEFERRED`.

  await knex.raw(`
    DROP INDEX idx_pipeline_stages_seq;

    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_seq_unique UNIQUE (pipeline_id, sequence)
      DEFERRABLE INITIALLY IMMEDIATE;
  `);

  // --- Phase D — the three list keys 20260301 did not seed ------------------
  //
  // `lead.sourcePlatform` already exists (20260301:315-323). Case is preserved
  // exactly and nothing is trimmed or folded: 'White' and 'white' are already
  // two `inventory_stock` rows, two reservations and two `stockKey()` values,
  // so folding them here would merge or orphan live stock. `label` starts equal
  // to `value` so a rename later never touches the identity a record holds.
  //
  // This seed reads `stock_movements` once, at migration time, to find every
  // colour ever used — the runtime usage-count query deliberately does not
  // (`field-usage.repository.ts`), because that query runs on every screen
  // open and no index on the ledger leads with `colour`.
  const tenants = await knex<{ id: string }>('tenants').select('id');

  for (const tenant of tenants) {
    await knex.raw(
      `
      INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex)
      SELECT gen_random_uuid(), ?, 'stock.colour', v,
             v,
             row_number() OVER (ORDER BY lower(v)),
             true,
             NULL
        FROM (
              SELECT DISTINCT colour AS v FROM inventory_stock       WHERE tenant_id = ?
          UNION SELECT DISTINCT q.colour FROM line_item_quantities q
                  JOIN line_items li ON li.id = q.line_item_id AND li.tenant_id = ?
          UNION SELECT DISTINCT colour FROM stock_movements          WHERE tenant_id = ?
          UNION SELECT DISTINCT colour FROM stock_reservations       WHERE tenant_id = ?
          UNION SELECT DISTINCT color  FROM products                 WHERE tenant_id = ?
        ) s
       WHERE v IS NOT NULL AND btrim(v) <> ''
       ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;
      `,
      [tenant.id, tenant.id, tenant.id, tenant.id, tenant.id, tenant.id],
    );

    await knex.raw(
      `
      INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex)
      SELECT gen_random_uuid(), ?, 'product.productType', v,
             v,
             row_number() OVER (ORDER BY lower(v)),
             true,
             NULL
        FROM (
              SELECT DISTINCT product_type AS v FROM products                 WHERE tenant_id = ?
          UNION SELECT DISTINCT product_type    FROM line_items               WHERE tenant_id = ?
          UNION SELECT DISTINCT product_type    FROM party_product_variants   WHERE tenant_id = ?
        ) s
       WHERE v IS NOT NULL AND btrim(v) <> ''
       ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;
      `,
      [tenant.id, tenant.id, tenant.id, tenant.id],
    );

    await knex.raw(
      `
      INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex)
      SELECT gen_random_uuid(), ?, 'line.packaging', v,
             v,
             row_number() OVER (ORDER BY lower(v)),
             true,
             NULL
        FROM (
              SELECT DISTINCT packaging AS v FROM line_items             WHERE tenant_id = ?
          UNION SELECT DISTINCT packaging    FROM party_product_variants WHERE tenant_id = ?
        ) s
       WHERE v IS NOT NULL AND btrim(v) <> ''
       ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;
      `,
      [tenant.id, tenant.id, tenant.id],
    );
  }
}

export async function down(): Promise<void> {
  // Deliberately empty — see the file header.
}
