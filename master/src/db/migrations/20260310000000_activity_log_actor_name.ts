/**
 * Logs, Stage 4 of `docs/backend-modules/`. Adds `activity_log.actor_name`
 * (a denormalised display name, so a deleted user or an unpaired panel
 * still names who did it), extracts the chain's inline digest expression
 * into a reusable `activity_log_row_hash(...)` so the verifier and the
 * trigger cannot drift, reworks `activity_log`'s indexes for tenant-scoped
 * keyset paging, and folds in the Reports indexes (`03-DATABASE.md` §8.2 —
 * Reports has no migration of its own).
 *
 * **Renumbered from `20260307` to `20260310`.** The build sequence
 * (`docs/backend-modules/11-BUILD-SEQUENCE.md` §1.2) reserves `20260307` for
 * this migration, but a concurrent session landed
 * `20260307000000_product_images_pipeline.ts` first — recorded in
 * `HANDOFF.md` rather than silently worked around, since the timestamp is
 * referenced by name throughout the spec set. `20260310` is the next free
 * slot: `20260308` (PDF Designer) and `20260309` (the permission grant,
 * which must run last) are both still reserved.
 *
 * Three phases, in order — the backfill's trigger surgery is folded into
 * Phase A rather than kept as a separate later phase, because the surgery
 * has to *wrap* the two `UPDATE`s it is for: `activity_log_no_update`
 * dropped, the two backfill `UPDATE`s run, the trigger recreated
 * byte-identical, all inside this one transaction. `activity_log_no_delete`
 * is never touched — deletes stay refused throughout.
 *   A — `activity_log.actor_name`, backfilled from `users`/`office_panels`,
 *       bracketed by the trigger drop/recreate above.
 *   B — `activity_log_row_hash()`, and `activity_log_chain()` redefined to
 *       call it (`CREATE OR REPLACE` — the function keeps its OID, so the
 *       existing trigger binding needs no change).
 *   C — the index rework (tenant-scoped keyset/date/actor/action/entity
 *       indexes, a unique index on `sequence`), plus the two Reports
 *       indexes this migration carries because Reports has none of its own.
 *
 * **`down()` is real** — one of two in the batch that gets one (the other
 * is the PDF Designer's). Nothing this migration touches is a tombstone
 * whose removal would resurrect a deleted record, and nothing here is
 * inside the hash digest except by way of columns already restored
 * byte-identical.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // --- Phase A -------------------------------------------------------------
  await knex.raw(`ALTER TABLE activity_log ADD COLUMN actor_name TEXT;`);

  // The backfill below is an UPDATE against an append-only table, so the
  // `activity_log_no_update` trigger must come down first — this is Phase C's
  // "trigger surgery" (see the file header), pulled forward to actually wrap
  // the two statements it names rather than following them.
  await knex.raw(`DROP TRIGGER activity_log_no_update ON activity_log;`);

  await knex.raw(`
    UPDATE activity_log a
       SET actor_name = u.display_name
      FROM users u
     WHERE a.actor_type = 'user' AND a.actor_id = u.id;
  `);

  // The `::text` cast is mandatory: `office_panels.id` is UUID, and
  // `activity_log.actor_id` is TEXT since 20260303 — Postgres will not
  // compare `text` to `uuid` implicitly.
  await knex.raw(`
    UPDATE activity_log a
       SET actor_name = p.name
      FROM office_panels p
     WHERE a.actor_type = 'office_panel' AND a.actor_id = p.id::text;
  `);

  await knex.raw(`
    CREATE TRIGGER activity_log_no_update
      BEFORE UPDATE ON activity_log
      FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();
  `);

  // --- Phase B — extract the digest so the trigger and the verifier share it
  await knex.raw(`
    CREATE FUNCTION activity_log_row_hash(
      prev_hash   TEXT,
      seq         BIGINT,
      entity_type TEXT,
      entity_id   TEXT,
      action      TEXT,
      actor_type  TEXT,
      actor_id    TEXT,
      details     JSONB
    ) RETURNS TEXT AS $$
      SELECT encode(sha256(convert_to(
          prev_hash                    || '|' ||
          seq::text                    || '|' ||
          entity_type                  || '|' ||
          entity_id                    || '|' ||
          action                       || '|' ||
          actor_type                   || '|' ||
          COALESCE(actor_id, '')       || '|' ||
          COALESCE(details::text, ''), 'UTF8')), 'hex');
    $$ LANGUAGE sql IMMUTABLE;
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION activity_log_chain() RETURNS trigger AS $$
    DECLARE
      last_hash TEXT;
      last_seq  BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

      SELECT hash, sequence INTO last_hash, last_seq
        FROM activity_log
       WHERE tenant_id = NEW.tenant_id
       ORDER BY sequence DESC
       LIMIT 1;

      NEW.sequence  := COALESCE(last_seq, 0) + 1;
      NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
      NEW.hash      := activity_log_row_hash(
                         NEW.prev_hash, NEW.sequence, NEW.entity_type, NEW.entity_id,
                         NEW.action, NEW.actor_type, NEW.actor_id, NEW.details);

      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);

  // --- Phase C — index rework -----------------------------------------------
  await knex.raw(`
    DROP INDEX idx_activity_log_created;
    DROP INDEX idx_activity_log_tenant;
    DROP INDEX idx_activity_log_entity;

    CREATE INDEX        idx_activity_log_feed     ON activity_log (tenant_id, id DESC);
    CREATE INDEX        idx_activity_log_at       ON activity_log (tenant_id, created_at DESC);
    CREATE INDEX        idx_activity_log_actor    ON activity_log (tenant_id, actor_type, actor_id, id DESC);
    CREATE INDEX        idx_activity_log_action   ON activity_log (tenant_id, action, id DESC);
    CREATE INDEX        idx_activity_log_entity   ON activity_log (tenant_id, entity_type, entity_id, id DESC);
    CREATE UNIQUE INDEX idx_activity_log_sequence ON activity_log (tenant_id, sequence);

    ALTER TABLE activity_log ALTER COLUMN sequence SET NOT NULL;
  `);

  // Reports indexes — folded in here because Reports (Stage 5) has no
  // migration of its own. `idx_orders_dispatched`'s predicate references
  // `deleted_at`, which is why this migration must run after `20260305`.
  await knex.raw(`
    CREATE INDEX idx_orders_dispatched
        ON orders (tenant_id, dispatched_at)
        WHERE dispatched_at IS NOT NULL AND deleted_at IS NULL;

    DROP INDEX idx_stock_movements_reference;
    CREATE INDEX idx_stock_movements_tenant_ref
        ON stock_movements (tenant_id, reference_type, reference_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX idx_stock_movements_tenant_ref;
    CREATE INDEX idx_stock_movements_reference ON stock_movements (reference_type, reference_id);

    DROP INDEX idx_orders_dispatched;
  `);

  await knex.raw(`
    ALTER TABLE activity_log ALTER COLUMN sequence DROP NOT NULL;

    DROP INDEX idx_activity_log_sequence;
    DROP INDEX idx_activity_log_entity;
    DROP INDEX idx_activity_log_action;
    DROP INDEX idx_activity_log_actor;
    DROP INDEX idx_activity_log_at;
    DROP INDEX idx_activity_log_feed;

    CREATE INDEX idx_activity_log_entity  ON activity_log(entity_type, entity_id);
    CREATE INDEX idx_activity_log_created ON activity_log(created_at);
    CREATE INDEX idx_activity_log_tenant  ON activity_log(tenant_id);
  `);

  await knex.raw(`DROP TRIGGER activity_log_no_update ON activity_log;`);

  // Restore the original inline digest expression, verbatim, keeping the
  // function OID and the trigger binding.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION activity_log_chain() RETURNS trigger AS $$
    DECLARE
      last_hash TEXT;
      last_seq  BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));

      SELECT hash, sequence INTO last_hash, last_seq
        FROM activity_log
       WHERE tenant_id = NEW.tenant_id
       ORDER BY sequence DESC
       LIMIT 1;

      NEW.sequence  := COALESCE(last_seq, 0) + 1;
      NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
      NEW.hash := encode(sha256(convert_to(
          NEW.prev_hash          || '|' ||
          NEW.sequence::text     || '|' ||
          NEW.entity_type        || '|' ||
          NEW.entity_id          || '|' ||
          NEW.action             || '|' ||
          NEW.actor_type         || '|' ||
          COALESCE(NEW.actor_id, '')      || '|' ||
          COALESCE(NEW.details::text, ''), 'UTF8')), 'hex');

      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER activity_log_no_update
      BEFORE UPDATE ON activity_log
      FOR EACH ROW EXECUTE FUNCTION activity_log_immutable();
  `);

  await knex.raw(`DROP FUNCTION activity_log_row_hash(text, bigint, text, text, text, text, text, jsonb);`);

  await knex.raw(`ALTER TABLE activity_log DROP COLUMN actor_name;`);
}
