/**
 * Fields, Stage 3 of `docs/backend-modules/`. Gives `option_lists` its first
 * timestamps (it has none today — "when was this colour added" is currently
 * unanswerable), gives both `option_lists` and `custom_field_definitions`
 * soft-delete plus optimistic-concurrency columns, gives `option_lists` a
 * hex, gives `pipeline_stages` archiving and a deferrable sequence
 * constraint, and completes `FIELD_LIST_KEYS` by seeding the three list keys
 * that are not `lead.sourcePlatform`.
 *
 * Four phases, in order:
 *   A — `option_lists` base timestamps, the two soft-delete pairs, the two
 *       `version` columns, the two partial-unique-index reworks (a partial
 *       unique index changes every `ON CONFLICT` that names it — Phase D's
 *       seed already writes the `WHERE deleted_at IS NULL` form), two Bin
 *       indexes.
 *   B — `option_lists.hex` with its format CHECK; `pipeline_stages.is_archived`
 *       with its archived-not-default CHECK.
 *   C — `idx_pipeline_stages_seq` becomes a deferrable table constraint (a
 *       unique *index* cannot be `DEFERRABLE`, only a constraint can — the
 *       reorder needs deferral to write a transiently-colliding permutation
 *       in one statement group).
 *   D — the three list-key seeds, reading `stock_movements` here (unlike the
 *       runtime "in use by" count, which deliberately does not — a one-time
 *       migration scan and a query run on every Fields screen open are
 *       different questions).
 *
 * **`down()` is deliberately empty.** Same argument as `20260305`'s
 * (dropping `deleted_at` would resurrect every soft-deleted option and
 * definition as live), plus two of its own: the seeded colour rows are
 * user-visible configuration an administrator may have relabelled and given
 * hex values to by the time anyone rolls back, and reverting
 * `pipeline_stages_seq_unique` to a plain unique index would leave the
 * reorder path unimplementable while the application still calls it.
 * Precedent: `20260304000000_role_tier_ceiling_repair.ts`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // --- Phase A -----------------------------------------------------------
  await knex.raw(`
    ALTER TABLE option_lists
      ADD COLUMN created_at TIMESTAMPTZ,
      ADD COLUMN updated_at TIMESTAMPTZ,
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN deleted_by TEXT,
      ADD COLUMN version    INTEGER NOT NULL DEFAULT 1;
  `);

  // Existing rows (the six seeded `lead.sourcePlatform` options) are
  // backdated to the tenant's own `created_at` rather than to "now" — a
  // colour added at first install did not appear at migration time.
  await knex.raw(`
    UPDATE option_lists o
       SET created_at = t.created_at,
           updated_at = t.created_at
      FROM tenants t
     WHERE o.tenant_id = t.id
       AND o.created_at IS NULL;
  `);

  await knex.raw(`
    ALTER TABLE option_lists
      ALTER COLUMN created_at SET NOT NULL,
      ALTER COLUMN created_at SET DEFAULT now(),
      ALTER COLUMN updated_at SET NOT NULL,
      ALTER COLUMN updated_at SET DEFAULT now();
  `);

  await knex.raw(`
    ALTER TABLE custom_field_definitions
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN deleted_by TEXT,
      ADD COLUMN version    INTEGER NOT NULL DEFAULT 1;
  `);

  // A partial unique index changes every `ON CONFLICT` that names it —
  // Postgres only matches an inference specification against a unique index
  // if the statement repeats the index's predicate. Phase D's seed already
  // uses the `WHERE deleted_at IS NULL` form.
  await knex.raw(`
    DROP INDEX idx_option_lists_key_value;
    CREATE UNIQUE INDEX idx_option_lists_key_value
        ON option_lists (tenant_id, list_key, value) WHERE deleted_at IS NULL;

    DROP INDEX idx_custom_fields_key;
    CREATE UNIQUE INDEX idx_custom_fields_key
        ON custom_field_definitions (tenant_id, entity, key) WHERE deleted_at IS NULL;
  `);

  // --- The Bin's keyset indexes, the two branches this stage adds --------
  await knex.raw(`
    CREATE INDEX idx_option_lists_deleted
        ON option_lists (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;

    CREATE INDEX idx_custom_fields_deleted
        ON custom_field_definitions (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
  `);

  // --- Phase B -------------------------------------------------------------
  await knex.raw(`
    ALTER TABLE option_lists ADD COLUMN hex TEXT;
    ALTER TABLE option_lists ADD CONSTRAINT option_lists_hex_format
      CHECK (hex IS NULL OR hex ~ '^#[0-9a-f]{6}$');
  `);

  await knex.raw(`
    ALTER TABLE pipeline_stages ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_archived_not_default
      CHECK (NOT (is_archived AND is_default));
  `);

  // --- Phase C — reordering needs a deferrable constraint -----------------
  await knex.raw(`
    DROP INDEX idx_pipeline_stages_seq;

    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_seq_unique UNIQUE (pipeline_id, sequence)
      DEFERRABLE INITIALLY IMMEDIATE;
  `);

  // --- Phase D — complete FIELD_LIST_KEYS from the data already present ---
  // List key literals are inlined and frozen, never imported from `@orderbook/shared`.
  await knex.raw(`
    INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex, created_at, updated_at)
    SELECT gen_random_uuid(), s.tenant_id, 'stock.colour', s.v, s.v,
           row_number() OVER (PARTITION BY s.tenant_id ORDER BY lower(s.v)),
           true, NULL, now(), now()
      FROM (
            SELECT tenant_id, colour AS v FROM inventory_stock       WHERE colour IS NOT NULL
        UNION SELECT li.tenant_id, q.colour FROM line_item_quantities q
                JOIN line_items li ON li.id = q.line_item_id
             WHERE q.colour IS NOT NULL
        UNION SELECT tenant_id, colour FROM stock_movements          WHERE colour IS NOT NULL
        UNION SELECT tenant_id, colour FROM stock_reservations       WHERE colour IS NOT NULL
        UNION SELECT tenant_id, color  FROM products                 WHERE color  IS NOT NULL
      ) s
     WHERE btrim(s.v) <> ''
     ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;

    INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex, created_at, updated_at)
    SELECT gen_random_uuid(), s.tenant_id, 'product.productType', s.v, s.v,
           row_number() OVER (PARTITION BY s.tenant_id ORDER BY lower(s.v)),
           true, NULL, now(), now()
      FROM (
            SELECT tenant_id, product_type AS v FROM products                WHERE product_type IS NOT NULL
        UNION SELECT tenant_id, product_type    FROM line_items              WHERE product_type IS NOT NULL
        UNION SELECT tenant_id, product_type    FROM party_product_variants  WHERE product_type IS NOT NULL
      ) s
     WHERE btrim(s.v) <> ''
     ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;

    INSERT INTO option_lists (id, tenant_id, list_key, value, label, sequence, is_active, hex, created_at, updated_at)
    SELECT gen_random_uuid(), s.tenant_id, 'line.packaging', s.v, s.v,
           row_number() OVER (PARTITION BY s.tenant_id ORDER BY lower(s.v)),
           true, NULL, now(), now()
      FROM (
            SELECT tenant_id, packaging AS v FROM line_items              WHERE packaging IS NOT NULL
        UNION SELECT tenant_id, packaging     FROM party_product_variants WHERE packaging IS NOT NULL
      ) s
     WHERE btrim(s.v) <> ''
     ON CONFLICT (tenant_id, list_key, value) WHERE deleted_at IS NULL DO NOTHING;
  `);
}

export async function down(): Promise<void> {
  // Deliberately empty — see the file header.
}
