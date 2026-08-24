/**
 * Recycle Bin, Stage 2 of `docs/backend-modules/`. Gives `leads`, `orders`,
 * `parties` and `products` their first delete path — there is no
 * `deleteLead`/`deleteOrder`/`deleteParty`/`deleteProduct` anywhere in the
 * product today — and gives `roles`/`users` (which have carried `deleted_at`
 * since `20260303` with no supporting index) a keyset index to be paged by.
 *
 * Four phases, in order:
 *   A — `deleted_at`/`deleted_by` on the four business tables.
 *   B — one partial keyset index per soft-deletable table (six today; Fields
 *       and the PDF Designer append two more and one more at their own
 *       stages — a Bin `UNION ALL` gate belongs to the stage at which that
 *       many branches exist, never to this one).
 *   C — `idx_leads_open` / `idx_leads_followup` gain `deleted_at IS NULL`,
 *       or a deleted lead keeps counting as open on the dashboard.
 *   D — `parties`/`products` code-uniqueness becomes partial, so a
 *       soft-deleted row does not reserve its code forever. `DROP INDEX`,
 *       not `ALTER TABLE … DROP CONSTRAINT` — `20260301` already converted
 *       these from constraints to plain indexes, so the constraint names no
 *       longer exist and the `ALTER TABLE` form fails outright.
 *
 * **`down()` is deliberately empty.** Dropping `deleted_at` would not undo a
 * delete — it would resurrect every soft-deleted lead, order, party and
 * product as a live record with no trace anyone ever removed it, and
 * recreating the non-partial unique indexes can fail outright once two live
 * rows legitimately share a code the partial index permitted. Leaving the
 * columns in place costs nothing: with no code reading them (until this
 * migration's own release) they are four nullable columns and six
 * tombstone-only indexes. Precedent: `20260304000000_role_tier_ceiling_repair.ts`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // --- Phase A ---------------------------------------------------------
  await knex.raw(`
    ALTER TABLE leads    ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
    ALTER TABLE orders   ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
    ALTER TABLE parties  ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
    ALTER TABLE products ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN deleted_by TEXT;
  `);

  // --- Phase B — the Bin's keyset indexes, on all six soft-deletable tables at this stage ---
  await knex.raw(`
    CREATE INDEX idx_leads_deleted    ON leads    (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
    CREATE INDEX idx_orders_deleted   ON orders   (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
    CREATE INDEX idx_parties_deleted  ON parties  (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
    CREATE INDEX idx_products_deleted ON products (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
    CREATE INDEX idx_roles_deleted    ON roles    (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
    CREATE INDEX idx_users_deleted    ON users    (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
  `);

  // --- Phase C — dashboard predicates must exclude tombstones too ------
  await knex.raw(`
    DROP INDEX idx_leads_open;
    CREATE INDEX idx_leads_open
        ON leads (tenant_id) WHERE converted_order_id IS NULL AND deleted_at IS NULL;

    DROP INDEX idx_leads_followup;
    CREATE INDEX idx_leads_followup
        ON leads (tenant_id, follow_up_date)
        WHERE follow_up_date IS NOT NULL AND deleted_at IS NULL;
  `);

  // --- Phase D — code uniqueness is over LIVE rows only -----------------
  await knex.raw(`
    DROP INDEX idx_parties_code_tenant;
    CREATE UNIQUE INDEX idx_parties_code_tenant
        ON parties (tenant_id, party_code) WHERE deleted_at IS NULL;

    DROP INDEX idx_products_code_tenant;
    CREATE UNIQUE INDEX idx_products_code_tenant
        ON products (tenant_id, product_code) WHERE deleted_at IS NULL;
  `);
}

export async function down(): Promise<void> {
  // Deliberately empty — see the file header.
}
