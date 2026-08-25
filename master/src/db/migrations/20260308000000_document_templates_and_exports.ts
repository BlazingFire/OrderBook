/**
 * PDF Designer, Stage 6 of `docs/backend-modules/` (DDL per `03-DATABASE.md`
 * §5.1–5.3). Three new tables and nothing else — no existing table is read or
 * written, and nothing is seeded.
 *
 * Three phases, in dependency order:
 *   A — `document_assets`, first because the templates table has two foreign
 *       keys into it.
 *   B — `document_templates`, including the ninth and last partial Recycle Bin
 *       index (`idx_document_templates_deleted`) — created here rather than in
 *       `20260305` because `'document_template'` only joins
 *       `RECYCLE_BIN_ENTITIES` at this stage.
 *   C — `document_exports`.
 *
 * **There is deliberately no default template row.** The renderer falls back
 * to `TEMPLATE_DEFAULTS` in memory (`shared/src/domain/documents.ts`), for the
 * same reason `ROLE_TEMPLATES` are templates rather than seeded roles: a
 * seeded row is a row somebody can edit into something the code did not
 * expect, and a constant cannot drift per installation.
 *
 * Every string literal below — the three document types, the three paper
 * sizes, the two asset kinds, the two subject types — is **inlined and frozen
 * as of 2026-08-25**, never imported from `@orderbook/shared`. A migration is
 * a fixed historical fact; `20260301` imported the live permission catalogue
 * and editing that catalogue later silently changed what an already-applied
 * migration had done.
 *
 * **`down()` is real** and drops the three tables in reverse dependency order,
 * which resurrects nothing because no other table references them. It
 * deliberately does **not** delete anything under `data/documents/` — a
 * migration must not delete a company's rendered quotations. A rollback
 * followed by a re-migration will therefore find orphaned files on disk; that
 * is intended, and `sweepOrphanTemporaries()` does not touch them either
 * (it only removes `.tmp` files, which are crash debris, not documents).
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // --- Phase A — assets, referenced by the templates table -------------
  await knex.raw(`
    CREATE TABLE document_assets (
      id           UUID PRIMARY KEY,
      tenant_id    UUID NOT NULL REFERENCES tenants(id),
      kind         TEXT NOT NULL CHECK (kind IN ('logo', 'signature')),
      filename     TEXT NOT NULL,
      mime_type    TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
      byte_size    BIGINT NOT NULL CHECK (byte_size > 0),
      sha256       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      storage_path TEXT NOT NULL,
      uploaded_by  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX        idx_document_assets_tenant ON document_assets (tenant_id, kind);
    CREATE UNIQUE INDEX idx_document_assets_sha    ON document_assets (tenant_id, sha256);
  `);

  // --- Phase B — templates ---------------------------------------------
  //
  // The eight visibility switches are typed BOOLEAN columns, never keys inside
  // `layout`. A typed column means the renderer reads `template.showRates`; a
  // JSONB key means it reads `layout.showRates ?? true` forever, and the
  // default is then a fact nothing declares.
  //
  // `logo_asset_id`/`signature_asset_id` are left at ON DELETE NO ACTION on
  // purpose: an asset row is shared between templates (`sha256` is unique per
  // tenant), so deleting one a template still points at must be refused by
  // PostgreSQL rather than by a service check somebody can forget to write.
  await knex.raw(`
    CREATE TABLE document_templates (
      id                  UUID PRIMARY KEY,
      tenant_id           UUID NOT NULL REFERENCES tenants(id),

      document_type       TEXT NOT NULL
                          CHECK (document_type IN ('quotation', 'order_confirmation', 'dispatch_note')),
      name                TEXT NOT NULL,
      is_default          BOOLEAN NOT NULL DEFAULT false,

      paper_size          TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'A5', 'Letter')),
      orientation         TEXT NOT NULL DEFAULT 'portrait'
                          CHECK (orientation IN ('portrait', 'landscape')),
      margin_top_mm       INTEGER NOT NULL DEFAULT 18 CHECK (margin_top_mm    BETWEEN 0 AND 100),
      margin_right_mm     INTEGER NOT NULL DEFAULT 15 CHECK (margin_right_mm  BETWEEN 0 AND 100),
      margin_bottom_mm    INTEGER NOT NULL DEFAULT 18 CHECK (margin_bottom_mm BETWEEN 0 AND 100),
      margin_left_mm      INTEGER NOT NULL DEFAULT 15 CHECK (margin_left_mm   BETWEEN 0 AND 100),

      show_rates          BOOLEAN NOT NULL DEFAULT true,
      show_colour_chips   BOOLEAN NOT NULL DEFAULT true,
      show_terms          BOOLEAN NOT NULL DEFAULT true,
      show_logo           BOOLEAN NOT NULL DEFAULT true,
      show_signature      BOOLEAN NOT NULL DEFAULT false,
      show_page_numbers   BOOLEAN NOT NULL DEFAULT true,
      show_watermark      BOOLEAN NOT NULL DEFAULT false,
      show_party_block    BOOLEAN NOT NULL DEFAULT true,
      watermark_text      TEXT,
      terms_text          TEXT,
      footer_text         TEXT,
      accent_colour       TEXT CHECK (accent_colour IS NULL OR accent_colour ~ '^#[0-9A-Fa-f]{6}$'),
      locale              TEXT,

      logo_asset_id       UUID REFERENCES document_assets(id),
      signature_asset_id  UUID REFERENCES document_assets(id),

      layout              JSONB NOT NULL DEFAULT '{"blocks":[{"kind":"lines","groupByProduct":false}]}',

      created_by          TEXT,
      updated_by          TEXT,
      deleted_at          TIMESTAMPTZ,
      deleted_by          TEXT,
      version             INTEGER NOT NULL DEFAULT 1,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX document_templates_name_unique
        ON document_templates (tenant_id, lower(name)) WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX document_templates_one_default
        ON document_templates (tenant_id, document_type) WHERE is_default AND deleted_at IS NULL;

    CREATE INDEX idx_document_templates_type
        ON document_templates (tenant_id, document_type) WHERE deleted_at IS NULL;

    CREATE INDEX idx_document_templates_deleted
        ON document_templates (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
  `);

  // --- Phase C — the export ledger --------------------------------------
  //
  // `subject_id` is deliberately polymorphic TEXT with no foreign key — it
  // holds an `LD…` or an `OD…` id and only `subject_type` is constrained.
  //
  // `rates_included` has no default: every insert must state whether the file
  // it describes carried prices, because that is the audit-grade fact somebody
  // will eventually need about the copy a customer received.
  //
  // `storage_key` is a second, opaque UUID distinct from the BIGSERIAL `id` —
  // it is the only handle the API hands out, so an export cannot be probed for
  // by counting.
  await knex.raw(`
    CREATE TABLE document_exports (
      id                   BIGSERIAL PRIMARY KEY,
      tenant_id            UUID NOT NULL REFERENCES tenants(id),

      subject_type         TEXT NOT NULL CHECK (subject_type IN ('lead', 'order')),
      subject_id           TEXT NOT NULL,
      document_type        TEXT NOT NULL
                           CHECK (document_type IN ('quotation', 'order_confirmation', 'dispatch_note')),

      template_id          UUID REFERENCES document_templates(id),
      template_name        TEXT NOT NULL,

      storage_key          UUID NOT NULL,
      storage_path         TEXT NOT NULL,
      byte_size            BIGINT NOT NULL CHECK (byte_size > 0),
      sha256               TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      page_count           INTEGER NOT NULL CHECK (page_count > 0),

      rates_included       BOOLEAN NOT NULL,
      locale               TEXT,

      rendered_by_user_id  TEXT REFERENCES users(id),
      rendered_by_panel_id UUID REFERENCES office_panels(id),
      superseded_by        BIGINT REFERENCES document_exports(id),

      deleted_at           TIMESTAMPTZ,
      deleted_by           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX        idx_document_exports_feed    ON document_exports (tenant_id, id DESC);
    CREATE INDEX        idx_document_exports_subject ON document_exports (tenant_id, subject_type,
                                                                          subject_id, id DESC);
    CREATE UNIQUE INDEX idx_document_exports_key     ON document_exports (storage_key);
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Reverse dependency order. Dropping a table drops its indexes with it.
  // Files under `data/documents/` are deliberately left alone — see the header.
  await knex.raw(`
    DROP TABLE IF EXISTS document_exports;
    DROP TABLE IF EXISTS document_templates;
    DROP TABLE IF EXISTS document_assets;
  `);
}
