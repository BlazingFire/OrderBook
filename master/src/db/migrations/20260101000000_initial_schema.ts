/**
 * Initial schema. Implements every table documented in docs/schema/ —
 * see those files for the reasoning behind each column and index.
 *
 * Written as raw SQL rather than Knex's schema builder because the schema docs
 * are already expressed as SQL DDL: keeping them character-comparable makes
 * drift between docs and database obvious during review.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // --- Identity & network (docs/schema/01-identity-and-network.md) ---

  await knex.raw(`
    CREATE TABLE master_config (
      id                    INTEGER PRIMARY KEY CHECK (id = 1),
      master_unique_id      UUID NOT NULL UNIQUE,
      company_name          TEXT,
      lan_ip                TEXT NOT NULL,
      port                  INTEGER NOT NULL,
      pairing_password_hash TEXT NOT NULL,
      setup_completed_at    TIMESTAMPTZ NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await knex.raw(`
    CREATE TABLE users (
      id            UUID PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name     TEXT,
      role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'staff')),
      is_active     BOOLEAN NOT NULL DEFAULT true,
      last_login_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await knex.raw(`
    CREATE TABLE office_panels (
      id           UUID PRIMARY KEY,
      name         TEXT NOT NULL,
      secret_hash  TEXT NOT NULL,
      lan_ip       TEXT,
      mac_address  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'active', 'revoked')),
      paired_at    TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_office_panels_status ON office_panels(status);
  `);

  // --- Parties & products (docs/schema/02-parties-and-products.md) ---

  await knex.raw(`
    CREATE TABLE parties (
      id                 UUID PRIMARY KEY,
      party_code         TEXT NOT NULL UNIQUE,
      name               TEXT NOT NULL,
      phone              TEXT,
      alt_phone          TEXT,
      email              TEXT,
      address_line1      TEXT,
      address_line2      TEXT,
      city               TEXT,
      state              TEXT,
      pincode            TEXT,
      gst_number         TEXT,
      notes              TEXT,
      is_active          BOOLEAN NOT NULL DEFAULT true,
      created_by_user_id UUID REFERENCES users(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_parties_name  ON parties(lower(name));
    CREATE INDEX idx_parties_phone ON parties(phone);
  `);

  await knex.raw(`
    CREATE TABLE product_categories (
      id         UUID PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await knex.raw(`
    CREATE TABLE products (
      id                UUID PRIMARY KEY,
      product_code      TEXT NOT NULL UNIQUE,
      name              TEXT NOT NULL,
      category_id       UUID REFERENCES product_categories(id),
      size              TEXT,
      finish            TEXT,
      series            TEXT,
      color             TEXT,
      thickness_mm      NUMERIC(6,2),
      pieces_per_box    INTEGER,
      box_coverage_sqft NUMERIC(8,2),
      price_per_box     INTEGER,
      price_per_sqft    INTEGER,
      hsn_code          TEXT,
      parameters        JSONB NOT NULL DEFAULT '{}',
      is_active         BOOLEAN NOT NULL DEFAULT true,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_products_name       ON products(lower(name));
    CREATE INDEX idx_products_category   ON products(category_id);
    CREATE INDEX idx_products_parameters ON products USING GIN (parameters);
  `);

  await knex.raw(`
    CREATE TABLE product_images (
      id          UUID PRIMARY KEY,
      product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      file_path   TEXT NOT NULL,
      is_primary  BOOLEAN NOT NULL DEFAULT false,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_product_images_product ON product_images(product_id);
  `);

  // --- Leads, orders & inventory (docs/schema/03-leads-orders-inventory.md) ---

  await knex.raw(`
    CREATE TABLE leads (
      id                 UUID PRIMARY KEY,
      lead_number        TEXT NOT NULL UNIQUE,
      party_id           UUID NOT NULL REFERENCES parties(id),
      status             TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'verified', 'order', 'cancelled')),
      source_panel_id    UUID REFERENCES office_panels(id),
      created_by_user_id UUID REFERENCES users(id),
      notes              TEXT,
      total_amount       INTEGER NOT NULL DEFAULT 0,
      order_date         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_leads_party        ON leads(party_id);
    CREATE INDEX idx_leads_status       ON leads(status);
    CREATE INDEX idx_leads_source_panel ON leads(source_panel_id);
    CREATE INDEX idx_leads_created_at   ON leads(created_at);
  `);

  await knex.raw(`
    CREATE TABLE lead_items (
      id             UUID PRIMARY KEY,
      lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      product_id     UUID NOT NULL REFERENCES products(id),
      quantity_boxes NUMERIC(10,2),
      quantity_sqft  NUMERIC(10,2),
      unit_price     INTEGER,
      line_total     INTEGER,
      parameters     JSONB NOT NULL DEFAULT '{}',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_lead_items_lead    ON lead_items(lead_id);
    CREATE INDEX idx_lead_items_product ON lead_items(product_id);
  `);

  await knex.raw(`
    CREATE TABLE inventory_stock (
      id             UUID PRIMARY KEY,
      product_id     UUID NOT NULL UNIQUE REFERENCES products(id),
      quantity_boxes NUMERIC(10,2) NOT NULL DEFAULT 0,
      quantity_sqft  NUMERIC(10,2) NOT NULL DEFAULT 0,
      reorder_level  NUMERIC(10,2),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await knex.raw(`
    CREATE TABLE stock_movements (
      id                 BIGSERIAL PRIMARY KEY,
      product_id         UUID NOT NULL REFERENCES products(id),
      movement_type      TEXT NOT NULL
                         CHECK (movement_type IN ('inbound', 'outbound', 'adjustment')),
      quantity_boxes     NUMERIC(10,2) NOT NULL,
      reference_type     TEXT,
      reference_id       UUID,
      created_by_user_id UUID REFERENCES users(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
    CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);
  `);

  // --- Activity log (docs/schema/04-activity-log.md) ---

  await knex.raw(`
    CREATE TABLE activity_log (
      id          BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id   UUID NOT NULL,
      action      TEXT NOT NULL,
      actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'office_panel', 'system')),
      actor_id    UUID,
      details     JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_activity_log_entity  ON activity_log(entity_type, entity_id);
    CREATE INDEX idx_activity_log_created ON activity_log(created_at);
  `);

  // Sequences backing the human-friendly display codes (P-0001, L-000123).
  // A dedicated sequence avoids the race a MAX(code)+1 query would have when
  // two Office Panels create records at the same moment.
  await knex.raw(`CREATE SEQUENCE party_code_seq START 1;`);
  await knex.raw(`CREATE SEQUENCE product_code_seq START 1;`);
  await knex.raw(`CREATE SEQUENCE lead_number_seq START 1;`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP SEQUENCE IF EXISTS lead_number_seq;
    DROP SEQUENCE IF EXISTS product_code_seq;
    DROP SEQUENCE IF EXISTS party_code_seq;
    DROP TABLE IF EXISTS activity_log;
    DROP TABLE IF EXISTS stock_movements;
    DROP TABLE IF EXISTS inventory_stock;
    DROP TABLE IF EXISTS lead_items;
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS product_images;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS product_categories;
    DROP TABLE IF EXISTS parties;
    DROP TABLE IF EXISTS office_panels;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS master_config;
  `);
}
