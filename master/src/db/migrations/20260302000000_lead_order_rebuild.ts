/**
 * The lead-generation rebuild (docs/LEAD_GENERATION_FLOW.md).
 *
 * Four structural changes land together because each depends on the others:
 *
 *  1. **Text record ids.** An offline panel must mint an id before the Master
 *     has seen the record, so syncable business tables move from UUID to the
 *     temporary/permanent text scheme in §7. Infrastructure tables that only
 *     the Master writes keep their UUIDs.
 *  2. **Orders become their own record.** Conversion no longer flips a status
 *     on the lead; it creates an `orders` row, copies the lines unchanged, and
 *     stamps `converted_order_id` on the lead, which survives as history.
 *  3. **One `line_items` table for both**, discriminated by
 *     `(parent_type, parent_id)`, with colour quantities as child rows. That
 *     shared shape is what makes conversion a straight copy.
 *  4. **Reserve, then dispatch.** Stock is reserved per (product, colour) at
 *     conversion and only leaves the ledger at dispatch — so inventory itself
 *     becomes per-colour.
 *
 * Existing data is migrated, not dropped: leads keep their history, and a lead
 * that had already reached `order` is converted into a real order with its
 * reservations already consumed (it had, in the old model, deducted stock).
 */

import type { Knex } from 'knex';

/**
 * Colour bucket for stock that predates per-colour inventory. Products carrying
 * a `color` keep it; the rest land here rather than in an empty string, which
 * would read as "unknown" in the UI.
 */
const DEFAULT_COLOUR = 'Default';

/** Old lead status → new pipeline stage name. */
const STATUS_TO_STAGE: Record<string, string> = {
  new: 'New',
  verified: 'Quoted',
  order: 'Won',
  cancelled: 'Lost',
};

interface IdConversion {
  table: string;
  prefix: string;
  /** Deterministic ordering, so a re-run would produce identical numbering. */
  orderBy: string;
}

const ID_CONVERSIONS: IdConversion[] = [
  { table: 'parties', prefix: 'PT', orderBy: 'created_at, id' },
  { table: 'product_categories', prefix: 'PC', orderBy: 'created_at, id' },
  { table: 'products', prefix: 'PR', orderBy: 'created_at, id' },
];

export async function up(knex: Knex): Promise<void> {
  const tenant = await firstTenantId(knex);

  // ======================================================================
  // Phase A — stage the new text ids alongside the old UUIDs
  // ======================================================================

  for (const { table, prefix, orderBy } of ID_CONVERSIONS) {
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN new_id TEXT;`);
    await knex.raw(`
      WITH numbered AS (
        SELECT id,
               '${prefix}' || lpad((ROW_NUMBER() OVER (ORDER BY ${orderBy}))::text, 10, '0') AS nid
          FROM ${table}
      )
      UPDATE ${table} t SET new_id = n.nid FROM numbered n WHERE t.id = n.id;
    `);
  }

  // ======================================================================
  // Phase B — product columns the guide's line snapshot needs
  // ======================================================================

  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN alias        TEXT,
      ADD COLUMN sin          TEXT,
      ADD COLUMN grade        TEXT,
      ADD COLUMN product_type TEXT,
      ADD COLUMN weight_kg    NUMERIC(10,3),
      ADD COLUMN custom_fields JSONB NOT NULL DEFAULT '{}';

    -- price_per_box *is* the guide's "rate". Renaming rather than adding a
    -- second column avoids two names for one number drifting apart.
    ALTER TABLE products RENAME COLUMN price_per_box TO rate;

    ALTER TABLE parties ADD COLUMN custom_fields JSONB NOT NULL DEFAULT '{}';
  `);

  // ======================================================================
  // Phase C — sync bookkeeping on every syncable table
  // ======================================================================

  for (const table of ['parties', 'products']) {
    await knex.raw(`
      ALTER TABLE ${table}
        ADD COLUMN version      INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN hlc          TEXT,
        ADD COLUMN field_hlc    JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN temporary_id TEXT;
      CREATE INDEX idx_${table}_hlc ON ${table}(tenant_id, hlc);
    `);
  }

  // ======================================================================
  // Phase D — the new tables
  // ======================================================================

  await knex.raw(`
    CREATE TABLE leads_new (
      id                 TEXT PRIMARY KEY,
      tenant_id          UUID NOT NULL REFERENCES tenants(id),
      party_id           TEXT NOT NULL,
      owner_id           UUID REFERENCES users(id),
      stage_id           UUID NOT NULL REFERENCES pipeline_stages(id),
      source_platform    TEXT,
      follow_up_date     DATE,
      party_wise_mode    BOOLEAN NOT NULL DEFAULT false,
      notes              TEXT,
      custom_fields      JSONB NOT NULL DEFAULT '{}',
      total_amount       BIGINT NOT NULL DEFAULT 0,
      converted_order_id TEXT,
      converted_at       TIMESTAMPTZ,
      source_panel_id    UUID REFERENCES office_panels(id),
      created_by_user_id UUID REFERENCES users(id),
      version            INTEGER NOT NULL DEFAULT 1,
      hlc                TEXT,
      field_hlc          JSONB NOT NULL DEFAULT '{}',
      temporary_id       TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Dropped at the end of this migration. Exists only so the rows that
      -- referenced the old UUID can find their new home.
      legacy_id          UUID
    );

    CREATE TABLE orders (
      id                       TEXT PRIMARY KEY,
      tenant_id                UUID NOT NULL REFERENCES tenants(id),
      lead_id                  TEXT,
      party_id                 TEXT NOT NULL,
      owner_id                 UUID REFERENCES users(id),
      stage_id                 UUID NOT NULL REFERENCES pipeline_stages(id),
      dispatch_address_label   TEXT,
      expected_dispatch_date   DATE,
      -- Always populated by summing line weights.
      total_weight_kg          NUMERIC(12,3) NOT NULL DEFAULT 0,
      -- Set only when a human overrode the computed figure; the UI labels the
      -- weight "manual" whenever this is non-null.
      total_weight_kg_override NUMERIC(12,3),
      notes                    TEXT,
      custom_fields            JSONB NOT NULL DEFAULT '{}',
      total_amount             BIGINT NOT NULL DEFAULT 0,
      dispatched_at            TIMESTAMPTZ,
      source_panel_id          UUID REFERENCES office_panels(id),
      created_by_user_id       UUID REFERENCES users(id),
      version                  INTEGER NOT NULL DEFAULT 1,
      hlc                      TEXT,
      field_hlc                JSONB NOT NULL DEFAULT '{}',
      temporary_id             TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One table for both parents. This is what makes conversion a straight
    -- copy rather than a translation between two shapes.
    CREATE TABLE line_items (
      id                 TEXT PRIMARY KEY,
      tenant_id          UUID NOT NULL REFERENCES tenants(id),
      parent_type        TEXT NOT NULL CHECK (parent_type IN ('lead', 'order')),
      parent_id          TEXT NOT NULL,
      product_id         TEXT NOT NULL,

      -- Snapshotted at add time and frozen from then on. Editing the product
      -- afterwards must not rewrite what an order was quoted at.
      product_name       TEXT NOT NULL,
      alias              TEXT,
      rate               BIGINT,
      code               TEXT,
      sin                TEXT,
      size               TEXT,
      weight_kg          NUMERIC(10,3),
      grade              TEXT,
      product_type       TEXT,

      -- Chosen manually on every line; never auto-filled, not even on convert.
      packaging          TEXT,
      sequence           INTEGER NOT NULL DEFAULT 0,
      from_party_variant BOOLEAN NOT NULL DEFAULT false,
      image_path         TEXT,
      notes              TEXT,
      total_quantity     NUMERIC(12,2) NOT NULL DEFAULT 0,
      line_total         BIGINT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_line_items_parent  ON line_items(tenant_id, parent_type, parent_id);
    CREATE INDEX idx_line_items_product ON line_items(tenant_id, product_id);

    -- Colour quantities are child rows, not columns: a line routinely carries
    -- several colours and the count is not known in advance.
    CREATE TABLE line_item_quantities (
      id           UUID PRIMARY KEY,
      line_item_id TEXT NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
      colour       TEXT NOT NULL,
      quantity     NUMERIC(12,2) NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_line_item_qty_colour ON line_item_quantities(line_item_id, colour);

    CREATE TABLE timeline_entries (
      id            TEXT PRIMARY KEY,
      tenant_id     UUID NOT NULL REFERENCES tenants(id),
      parent_type   TEXT NOT NULL CHECK (parent_type IN ('lead', 'order')),
      parent_id     TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('system', 'remark')),
      message       TEXT NOT NULL,
      from_stage_id UUID REFERENCES pipeline_stages(id),
      to_stage_id   UUID REFERENCES pipeline_stages(id),
      actor_user_id UUID REFERENCES users(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_timeline_parent ON timeline_entries(tenant_id, parent_type, parent_id, created_at);

    CREATE TABLE party_product_variants (
      id           TEXT PRIMARY KEY,
      tenant_id    UUID NOT NULL REFERENCES tenants(id),
      party_id     TEXT NOT NULL,
      product_id   TEXT NOT NULL,
      product_name TEXT,
      alias        TEXT,
      rate         BIGINT,
      size         TEXT,
      sin          TEXT,
      grade        TEXT,
      product_type TEXT,
      weight_kg    NUMERIC(10,3),
      -- Recorded for reference. Never copied onto a line automatically — the
      -- UI offers it as a suggestion the user must accept.
      packaging    TEXT,
      version      INTEGER NOT NULL DEFAULT 1,
      hlc          TEXT,
      field_hlc    JSONB NOT NULL DEFAULT '{}',
      temporary_id TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_party_variants_pair ON party_product_variants(tenant_id, party_id, product_id);

    -- Stock committed to an order but not yet dispatched. Per (product, colour)
    -- because a white basin does not satisfy a reservation for a blue one.
    CREATE TABLE stock_reservations (
      id           TEXT PRIMARY KEY,
      tenant_id    UUID NOT NULL REFERENCES tenants(id),
      order_id     TEXT NOT NULL,
      line_item_id TEXT NOT NULL,
      product_id   TEXT NOT NULL,
      colour       TEXT NOT NULL,
      quantity     NUMERIC(12,2) NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'released', 'consumed')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at   TIMESTAMPTZ
    );
    CREATE INDEX idx_reservations_order   ON stock_reservations(tenant_id, order_id);
    CREATE INDEX idx_reservations_product ON stock_reservations(tenant_id, product_id, colour)
        WHERE status = 'active';

    CREATE TABLE inventory_stock_new (
      id             UUID PRIMARY KEY,
      tenant_id      UUID NOT NULL REFERENCES tenants(id),
      product_id     TEXT NOT NULL,
      colour         TEXT NOT NULL,
      quantity_boxes NUMERIC(12,2) NOT NULL DEFAULT 0,
      reorder_level  NUMERIC(12,2),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_inventory_product_colour
        ON inventory_stock_new(tenant_id, product_id, colour);
  `);

  // ======================================================================
  // Phase E — migrate existing leads
  // ======================================================================

  const stageIdByName = await stageMap(knex, tenant, 'lead');
  const orderStageIdByName = await stageMap(knex, tenant, 'order');
  const leadStage = requireStage(stageIdByName, 'lead');
  const orderStage = requireStage(orderStageIdByName, 'order');
  const fallbackOwner = await firstAdminUserId(knex);

  await knex.raw(
    `
    INSERT INTO leads_new (
      id, tenant_id, party_id, owner_id, stage_id, notes, custom_fields,
      total_amount, source_panel_id, created_by_user_id, created_at, updated_at,
      legacy_id
    )
    SELECT
      'LD' || lpad((ROW_NUMBER() OVER (ORDER BY l.created_at, l.id))::text, 10, '0'),
      l.tenant_id,
      p.new_id,
      COALESCE(l.created_by_user_id, ?::uuid),
      (?::jsonb ->> l.status)::uuid,
      l.notes,
      '{}'::jsonb,
      l.total_amount,
      l.source_panel_id,
      l.created_by_user_id,
      l.created_at,
      l.updated_at,
      l.id
    FROM leads l
    JOIN parties p ON p.id = l.party_id;
  `,
    [
      fallbackOwner,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(STATUS_TO_STAGE).map(([status, stage]) => [status, leadStage(stage)]),
        ),
      ),
    ],
  );

  // Line items, carrying the old lead's id across via a join on the old UUID.
  await knex.raw(`
    INSERT INTO line_items (
      id, tenant_id, parent_type, parent_id, product_id, product_name, alias,
      rate, code, sin, size, weight_kg, grade, product_type, packaging,
      sequence, from_party_variant, image_path, notes, total_quantity,
      line_total, created_at, updated_at
    )
    SELECT
      'LI' || lpad((ROW_NUMBER() OVER (ORDER BY li.created_at, li.id))::text, 10, '0'),
      li.tenant_id,
      'lead',
      ln.id,
      pr.new_id,
      pr.name,
      pr.alias,
      li.unit_price,
      pr.product_code,
      pr.sin,
      pr.size,
      pr.weight_kg,
      pr.grade,
      pr.product_type,
      NULL,
      ROW_NUMBER() OVER (PARTITION BY li.lead_id ORDER BY li.created_at, li.id),
      false,
      NULL,
      NULL,
      COALESCE(li.quantity_boxes, 0),
      li.line_total,
      li.created_at,
      li.updated_at
    FROM lead_items li
    JOIN products pr ON pr.id = li.product_id
    JOIN leads_new ln ON ln.legacy_id = li.lead_id;
  `);

  // Every migrated line gets one colour bucket — the product's own colour where
  // it has one, so per-colour stock lines up with what is physically on the floor.
  await knex.raw(`
    INSERT INTO line_item_quantities (id, line_item_id, colour, quantity)
    SELECT gen_random_uuid(), li.id,
           COALESCE(NULLIF(pr.color, ''), '${DEFAULT_COLOUR}'),
           li.total_quantity
      FROM line_items li
      JOIN products pr ON pr.new_id = li.product_id
     WHERE li.total_quantity > 0;
  `);

  // ======================================================================
  // Phase F — leads that had already become orders get a real order record
  // ======================================================================

  await knex.raw(
    `
    INSERT INTO orders (
      id, tenant_id, lead_id, party_id, owner_id, stage_id, total_amount,
      dispatched_at, source_panel_id, created_by_user_id, created_at, updated_at
    )
    SELECT
      'OD' || lpad((ROW_NUMBER() OVER (ORDER BY ln.created_at, ln.id))::text, 10, '0'),
      ln.tenant_id,
      ln.id,
      ln.party_id,
      ln.owner_id,
      ?::uuid,
      ln.total_amount,
      NULL,
      ln.source_panel_id,
      ln.created_by_user_id,
      ln.created_at,
      ln.updated_at
    FROM leads_new ln
    WHERE ln.stage_id = ?::uuid;
  `,
    [orderStage('In Progress'), leadStage('Won')],
  );

  await knex.raw(`
    UPDATE leads_new ln
       SET converted_order_id = o.id,
           converted_at       = o.created_at
      FROM orders o
     WHERE o.lead_id = ln.id;
  `);

  // Copy the lines across, exactly as a live conversion would.
  await knex.raw(`
    INSERT INTO line_items (
      id, tenant_id, parent_type, parent_id, product_id, product_name, alias,
      rate, code, sin, size, weight_kg, grade, product_type, packaging,
      sequence, from_party_variant, image_path, notes, total_quantity,
      line_total, created_at, updated_at
    )
    SELECT
      'LI' || lpad(((SELECT COALESCE(MAX(substring(id from 3)::bigint), 0) FROM line_items)
                    + ROW_NUMBER() OVER (ORDER BY li.id))::text, 10, '0'),
      li.tenant_id, 'order', o.id, li.product_id, li.product_name, li.alias,
      li.rate, li.code, li.sin, li.size, li.weight_kg, li.grade, li.product_type,
      li.packaging, li.sequence, li.from_party_variant, li.image_path, li.notes,
      li.total_quantity, li.line_total, li.created_at, li.updated_at
    FROM line_items li
    JOIN orders o ON o.lead_id = li.parent_id
    WHERE li.parent_type = 'lead';
  `);

  await knex.raw(`
    INSERT INTO line_item_quantities (id, line_item_id, colour, quantity)
    SELECT gen_random_uuid(), dst.id, q.colour, q.quantity
      FROM line_items dst
      JOIN orders o ON o.id = dst.parent_id AND dst.parent_type = 'order'
      JOIN line_items src ON src.parent_type = 'lead'
                         AND src.parent_id = o.lead_id
                         AND src.product_id = dst.product_id
      JOIN line_item_quantities q ON q.line_item_id = src.id;
  `);

  await knex.raw(`
    UPDATE orders o SET total_weight_kg = COALESCE(w.total, 0)
      FROM (
        SELECT li.parent_id AS order_id,
               SUM(COALESCE(li.weight_kg, 0) * li.total_quantity) AS total
          FROM line_items li
         WHERE li.parent_type = 'order'
         GROUP BY li.parent_id
      ) w
     WHERE w.order_id = o.id;
  `);

  // These orders already took their stock in the old deduct-on-conversion
  // model, so their reservations are recorded as consumed rather than active —
  // re-reserving would double-count against the ledger.
  await knex.raw(`
    INSERT INTO stock_reservations (
      id, tenant_id, order_id, line_item_id, product_id, colour, quantity, status, settled_at
    )
    SELECT
      'RS' || lpad((ROW_NUMBER() OVER (ORDER BY li.id, q.colour))::text, 10, '0'),
      li.tenant_id, li.parent_id, li.id, li.product_id, q.colour, q.quantity,
      'consumed', now()
    FROM line_items li
    JOIN line_item_quantities q ON q.line_item_id = li.id
    WHERE li.parent_type = 'order';
  `);

  // ======================================================================
  // Phase G — inventory becomes per (product, colour)
  // ======================================================================

  await knex.raw(`
    INSERT INTO inventory_stock_new (id, tenant_id, product_id, colour, quantity_boxes, reorder_level, updated_at)
    SELECT gen_random_uuid(), s.tenant_id, pr.new_id,
           COALESCE(NULLIF(pr.color, ''), '${DEFAULT_COLOUR}'),
           s.quantity_boxes, s.reorder_level, s.updated_at
      FROM inventory_stock s
      JOIN products pr ON pr.id = s.product_id;
  `);

  await knex.raw(`
    ALTER TABLE stock_movements
      ADD COLUMN colour TEXT,
      ADD COLUMN product_id_new TEXT;

    UPDATE stock_movements m
       SET product_id_new = pr.new_id,
           colour = COALESCE(NULLIF(pr.color, ''), '${DEFAULT_COLOUR}')
      FROM products pr
     WHERE pr.id = m.product_id;

    ALTER TABLE stock_movements DROP COLUMN product_id;
    ALTER TABLE stock_movements RENAME COLUMN product_id_new TO product_id;
    ALTER TABLE stock_movements ALTER COLUMN product_id SET NOT NULL;
    UPDATE stock_movements SET colour = '${DEFAULT_COLOUR}' WHERE colour IS NULL;
    ALTER TABLE stock_movements ALTER COLUMN colour SET NOT NULL;
    ALTER TABLE stock_movements ALTER COLUMN reference_id TYPE TEXT USING reference_id::text;
  `);

  await knex.raw(`
    ALTER TABLE product_images ADD COLUMN product_id_new TEXT;
    UPDATE product_images pi SET product_id_new = pr.new_id FROM products pr WHERE pr.id = pi.product_id;
    ALTER TABLE product_images DROP COLUMN product_id;
    ALTER TABLE product_images RENAME COLUMN product_id_new TO product_id;
    ALTER TABLE product_images ALTER COLUMN product_id SET NOT NULL;
  `);

  await knex.raw(`ALTER TABLE activity_log ALTER COLUMN entity_id TYPE TEXT USING entity_id::text;`);

  // ======================================================================
  // Phase H — retire the old tables and swap the staged ids into place
  // ======================================================================

  await knex.raw(`
    DROP TABLE lead_items;
    DROP TABLE leads;
    DROP TABLE inventory_stock;
    ALTER TABLE leads_new RENAME TO leads;
    ALTER TABLE inventory_stock_new RENAME TO inventory_stock;
  `);

  await knex.raw(`
    ALTER TABLE products ADD COLUMN category_id_new TEXT;
    UPDATE products p SET category_id_new = c.new_id
      FROM product_categories c WHERE c.id = p.category_id;
    ALTER TABLE products DROP COLUMN category_id;
    ALTER TABLE products RENAME COLUMN category_id_new TO category_id;
  `);

  for (const { table } of ID_CONVERSIONS) {
    await knex.raw(`
      ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey;
      ALTER TABLE ${table} DROP COLUMN id;
      ALTER TABLE ${table} RENAME COLUMN new_id TO id;
      ALTER TABLE ${table} ALTER COLUMN id SET NOT NULL;
      ALTER TABLE ${table} ADD PRIMARY KEY (id);
    `);
  }

  // ======================================================================
  // Phase I — the foreign keys, now that every referenced id is text
  // ======================================================================

  await knex.raw(`
    ALTER TABLE products            ADD CONSTRAINT products_category_fk     FOREIGN KEY (category_id)   REFERENCES product_categories(id);
    ALTER TABLE product_images      ADD CONSTRAINT product_images_product_fk FOREIGN KEY (product_id)   REFERENCES products(id) ON DELETE CASCADE;
    ALTER TABLE stock_movements     ADD CONSTRAINT stock_movements_product_fk FOREIGN KEY (product_id)  REFERENCES products(id);
    ALTER TABLE inventory_stock     ADD CONSTRAINT inventory_product_fk      FOREIGN KEY (product_id)   REFERENCES products(id);
    ALTER TABLE leads               ADD CONSTRAINT leads_party_fk           FOREIGN KEY (party_id)     REFERENCES parties(id);
    ALTER TABLE orders              ADD CONSTRAINT orders_party_fk          FOREIGN KEY (party_id)     REFERENCES parties(id);
    ALTER TABLE orders              ADD CONSTRAINT orders_lead_fk           FOREIGN KEY (lead_id)      REFERENCES leads(id);
    ALTER TABLE leads               ADD CONSTRAINT leads_order_fk           FOREIGN KEY (converted_order_id) REFERENCES orders(id);
    ALTER TABLE line_items          ADD CONSTRAINT line_items_product_fk    FOREIGN KEY (product_id)   REFERENCES products(id);
    ALTER TABLE party_product_variants ADD CONSTRAINT variants_party_fk     FOREIGN KEY (party_id)     REFERENCES parties(id) ON DELETE CASCADE;
    ALTER TABLE party_product_variants ADD CONSTRAINT variants_product_fk   FOREIGN KEY (product_id)   REFERENCES products(id) ON DELETE CASCADE;
    ALTER TABLE stock_reservations  ADD CONSTRAINT reservations_order_fk    FOREIGN KEY (order_id)     REFERENCES orders(id) ON DELETE CASCADE;
    ALTER TABLE stock_reservations  ADD CONSTRAINT reservations_line_fk     FOREIGN KEY (line_item_id) REFERENCES line_items(id) ON DELETE CASCADE;
    ALTER TABLE stock_reservations  ADD CONSTRAINT reservations_product_fk  FOREIGN KEY (product_id)   REFERENCES products(id);

    CREATE INDEX idx_leads_party     ON leads(tenant_id, party_id);
    CREATE INDEX idx_leads_stage     ON leads(tenant_id, stage_id);
    CREATE INDEX idx_leads_owner     ON leads(tenant_id, owner_id);
    CREATE INDEX idx_leads_followup  ON leads(tenant_id, follow_up_date) WHERE follow_up_date IS NOT NULL;
    CREATE INDEX idx_leads_open      ON leads(tenant_id) WHERE converted_order_id IS NULL;
    CREATE INDEX idx_leads_created   ON leads(tenant_id, created_at);
    CREATE INDEX idx_orders_party    ON orders(tenant_id, party_id);
    CREATE INDEX idx_orders_stage    ON orders(tenant_id, stage_id);
    CREATE INDEX idx_orders_owner    ON orders(tenant_id, owner_id);
    CREATE INDEX idx_orders_created  ON orders(tenant_id, created_at);
  `);

  // ======================================================================
  // Phase J — full-text search (docs/LEAD_GENERATION_FLOW.md §9)
  // ======================================================================

  // btree_gin lets a GIN index carry the plain tenant_id column alongside the
  // tsvector, so the tenant filter and the match are served by one index.
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS btree_gin;`);

  await knex.raw(`
    ALTER TABLE products   ADD COLUMN search_vector tsvector;
    ALTER TABLE parties    ADD COLUMN search_vector tsvector;
    ALTER TABLE line_items ADD COLUMN search_vector tsvector;
  `);

  // The vector is rebuilt by a trigger on the base table, never written by the
  // service layer — application-side maintenance is exactly how a search index
  // drifts from the data it claims to describe.
  await knex.raw(`
    CREATE FUNCTION products_search_refresh() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.product_code, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.sin, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.grade, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.series, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.product_type, '')), 'C');
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE FUNCTION parties_search_refresh() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.party_code, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.phone, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.alt_phone, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.email, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.city, '')), 'C');
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    -- Indexes the *snapshot*, not the live product. That is the whole point:
    -- searching a product name that has since changed must still find the
    -- historical leads and orders that were quoted under the old name.
    CREATE FUNCTION line_items_search_refresh() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.product_name, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.code, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.alias, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.sin, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.size, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.grade, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.packaging, '')), 'C') ||
        setweight(to_tsvector('simple', COALESCE(NEW.notes, '')), 'D');
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    CREATE TRIGGER products_search_trg   BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION products_search_refresh();
    CREATE TRIGGER parties_search_trg    BEFORE INSERT OR UPDATE ON parties
      FOR EACH ROW EXECUTE FUNCTION parties_search_refresh();
    CREATE TRIGGER line_items_search_trg BEFORE INSERT OR UPDATE ON line_items
      FOR EACH ROW EXECUTE FUNCTION line_items_search_refresh();
  `);

  // Backfill through the triggers, then index. Composite on (tenant_id, vector)
  // so the tenant filter is served by the same index as the match — never by
  // ranking, which would let one tenant's rows influence another's results.
  await knex.raw(`
    UPDATE products   SET updated_at = updated_at;
    UPDATE parties    SET updated_at = updated_at;
    UPDATE line_items SET updated_at = updated_at;

    CREATE INDEX idx_products_search   ON products   USING GIN (tenant_id, search_vector);
    CREATE INDEX idx_parties_search    ON parties    USING GIN (tenant_id, search_vector);
    CREATE INDEX idx_line_items_search ON line_items USING GIN (tenant_id, search_vector);
  `);

  // ======================================================================
  // Phase K — seed the id counters past everything just migrated
  // ======================================================================

  for (const [entity, table] of [
    ['lead', 'leads'],
    ['order', 'orders'],
    ['line_item', 'line_items'],
    ['party', 'parties'],
    ['product', 'products'],
    ['product_category', 'product_categories'],
    ['party_variant', 'party_product_variants'],
    ['timeline_entry', 'timeline_entries'],
    ['reservation', 'stock_reservations'],
  ] as const) {
    const [row] = await knex.raw<{ rows: Array<{ next: string }> }>(
      `SELECT COALESCE(MAX(substring(id from 3)::bigint), 0) + 1 AS next
         FROM ${table} WHERE tenant_id = ? AND id ~ '^[A-Z]{2}[0-9]{10}$'`,
      [tenant],
    ).then((result) => result.rows);

    await knex('id_sequences').insert({
      tenant_id: tenant,
      entity,
      next_value: Number(row?.next ?? 1),
    });
  }

  await knex.raw(`
    ALTER TABLE leads DROP COLUMN legacy_id;
    DROP SEQUENCE IF EXISTS lead_number_seq;
  `);
}

export async function down(): Promise<void> {
  // Deliberately irreversible. Rolling back would mean collapsing orders back
  // onto their leads, re-aggregating per-colour stock into per-product totals,
  // and inventing UUIDs to replace text ids — each of which loses information
  // that the forward migration created. Restore from a backup instead.
  throw new Error(
    'Migration 20260302000000_lead_order_rebuild cannot be rolled back — restore from a backup.',
  );
}

async function firstTenantId(knex: Knex): Promise<string> {
  const [row] = await knex.select<Array<{ id: string }>>('id').from('tenants').limit(1);
  if (!row) throw new Error('No tenant found — 20260301000000_tenancy_access_and_sync must run first');
  return row.id;
}

async function firstAdminUserId(knex: Knex): Promise<string | null> {
  const [row] = await knex
    .select<Array<{ id: string }>>('users.id')
    .from('users')
    .join('roles', 'roles.id', 'users.role_id')
    .where('roles.tier', 'admin')
    .orderBy('users.created_at')
    .limit(1);
  return row?.id ?? null;
}

/**
 * Stage lookup that fails loudly. A missing stage here means the tenancy
 * migration's seed changed, and silently inserting NULL into a NOT NULL column
 * would surface as a confusing constraint error several statements later.
 */
function requireStage(
  stages: Record<string, string>,
  kind: string,
): (name: string) => string {
  return (name) => {
    const id = stages[name];
    if (!id) throw new Error(`Seeded ${kind} pipeline has no "${name}" stage`);
    return id;
  };
}

async function stageMap(
  knex: Knex,
  tenantId: string,
  kind: 'lead' | 'order',
): Promise<Record<string, string>> {
  const rows = await knex
    .select<Array<{ id: string; name: string }>>('pipeline_stages.id', 'pipeline_stages.name')
    .from('pipeline_stages')
    .join('pipelines', 'pipelines.id', 'pipeline_stages.pipeline_id')
    .where({ 'pipelines.tenant_id': tenantId, 'pipelines.kind': kind });

  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
}
