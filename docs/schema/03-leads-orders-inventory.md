# Schema — Leads, Orders & Inventory

Covers the business workflow described in `docs/LEAD_GENERATION_FLOW.md`: raise a lead → move it
through a configurable pipeline → **convert it to an order** → dispatch. PostgreSQL DDL describing
the current shape — see `00-overview.md` for the type/convention rationale and how this was
checked, and `06-tenancy-permissions-and-sync.md` for the tenancy, permission and offline-sync
columns the tables here carry.

> **This chapter was rewritten by the lead-generation rebuild**
> (`20260302000000_lead_order_rebuild`). The previous model had a single `leads` table where a
> `status` column carried the transition to "order", stock deducted at that moment, and inventory
> was per product. All three changed; §7 at the end records why, and the later restructures
> (variants, the trim, the line's grade) after it.

## Identifiers

The records here that an Office Panel can create — leads, orders, line items, timeline entries,
party-wise records and reservations — use **text ids**, not UUIDs, because an offline Office Panel
must mint an id before the Master has ever seen the record (`LEAD_GENERATION_FLOW.md` §7):

- temporary — 15 chars, `<6-char device><9-digit counter>`, e.g. `A3F9K2000000123`
- permanent — 12 chars, `<2-char prefix><10-digit sequence>`, e.g. `LD0000000042`

`id_map` keeps a temporary id resolvable forever, so a docket printed offline stays findable.

The prefixes are the `ENTITY_PREFIX` table in `shared/src/sync/ids.ts`: `PT` party, `PR`
product, `VR` product variant, `PV` party variant (a party's own record of a product — the older
of the two, which is why the product variant could not take `PV`), `LD` lead, `OD` order, `LI`
line item, `TL` timeline entry, `RS` reservation, and so on.

The two inventory tables only the Master writes keep other keys: `inventory_stock` a UUID,
`stock_movements` a `BIGSERIAL`.

## `leads`

```sql
CREATE TABLE leads (
  id                 TEXT PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  party_id           TEXT NOT NULL REFERENCES parties(id),
  owner_id           TEXT REFERENCES users(id),
  stage_id           UUID NOT NULL REFERENCES pipeline_stages(id),
  source_platform    TEXT,
  follow_up_date     DATE,
  party_wise_mode    BOOLEAN NOT NULL DEFAULT false,
  notes              TEXT,
  custom_fields      JSONB NOT NULL DEFAULT '{}',
  converted_order_id TEXT REFERENCES orders(id),
  converted_at       TIMESTAMPTZ,
  source_panel_id    UUID REFERENCES office_panels(id),
  created_by_user_id TEXT REFERENCES users(id),
  version            INTEGER NOT NULL DEFAULT 1,
  hlc                TEXT,
  field_hlc          JSONB NOT NULL DEFAULT '{}',
  temporary_id       TEXT,
  deleted_at         TIMESTAMPTZ,
  deleted_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_party    ON leads (tenant_id, party_id);
CREATE INDEX idx_leads_stage    ON leads (tenant_id, stage_id);
CREATE INDEX idx_leads_created  ON leads (tenant_id, created_at);
CREATE INDEX idx_leads_open     ON leads (tenant_id) WHERE converted_order_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_leads_followup ON leads (tenant_id, follow_up_date)
    WHERE follow_up_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_leads_deleted  ON leads (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

There is no status, `lead_number` or amount column: the permanent id is the docket number and the
stage is the status. `stage_id` replaced the old `status` enum: stages are rows a company renames,
recolours, reorders and archives, so the Kanban columns are data rather than a code change
(`pipelines`, `pipeline_stages` in chapter 06).

`converted_order_id` is what makes a lead history rather than a husk. The lead keeps its lines and
its timeline; the partial index `idx_leads_open` is what keeps the board fast while every won deal
stays queryable. Both `idx_leads_open` and `idx_leads_followup` exclude deleted leads, or a lead in
the Recycle Bin would keep counting as open on the dashboard.

`source_platform` is validated against the `lead.sourcePlatform` option list rather than a CHECK
constraint — it is a reporting dimension a company redefines, and an unknown value is rejected at
the service so a typo cannot quietly become its own category.

There is no index on `owner_id`. The rebuild created `idx_leads_owner` and `idx_orders_owner`;
`20260303000000_roles_and_users` dropped and re-created every column referencing `users(id)` as
TEXT, which took both indexes with it, and they were not re-created.

*History:* `total_amount` sat on leads and orders until the trim (2026-09-21); pricing is gone
whole. `20260305000000_soft_delete_columns` added `deleted_at`/`deleted_by` and the Bin index.

## `orders`

```sql
CREATE TABLE orders (
  id                       TEXT PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  lead_id                  TEXT REFERENCES leads(id),
  party_id                 TEXT NOT NULL REFERENCES parties(id),
  owner_id                 TEXT REFERENCES users(id),
  stage_id                 UUID NOT NULL REFERENCES pipeline_stages(id),
  dispatch_address_label   TEXT,
  expected_dispatch_date   DATE,
  total_weight_kg          NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_weight_kg_override NUMERIC(12,3),
  notes                    TEXT,
  custom_fields            JSONB NOT NULL DEFAULT '{}',
  dispatched_at            TIMESTAMPTZ,
  source_panel_id          UUID REFERENCES office_panels(id),
  created_by_user_id       TEXT REFERENCES users(id),
  version                  INTEGER NOT NULL DEFAULT 1,
  hlc                      TEXT,
  field_hlc                JSONB NOT NULL DEFAULT '{}',
  temporary_id             TEXT,
  deleted_at               TIMESTAMPTZ,
  deleted_by               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_party      ON orders (tenant_id, party_id);
CREATE INDEX idx_orders_stage      ON orders (tenant_id, stage_id);
CREATE INDEX idx_orders_created    ON orders (tenant_id, created_at);
CREATE INDEX idx_orders_dispatched ON orders (tenant_id, dispatched_at)
    WHERE dispatched_at IS NOT NULL AND deleted_at IS NULL;          -- Reports
CREATE INDEX idx_orders_deleted    ON orders (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
```

An order is its own record because it runs its **own pipeline**, independent of the lead's, and
carries fields that only exist once something is a commitment. Both facts are impossible on a row
that also holds the lead's stage. An order is created only by converting a lead; `lead_id` and
`leads.converted_order_id` point at each other (a circular pair of foreign keys, which is why the
two tables can only be truncated together).

`total_weight_kg` is computed from the lines when conversion creates the order
(`computeTotalWeightKg`); `total_weight_kg_override` is set only when a human disagrees. The
computed figure is never discarded, so an override can always be undone — and the UI labels which
one it is showing.

## `line_items` — one table, both parents

```sql
CREATE TABLE line_items (
  id                 TEXT PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  parent_type        TEXT NOT NULL CHECK (parent_type IN ('lead', 'order')),
  parent_id          TEXT NOT NULL,                              -- leads.id or orders.id; no FK
  product_id         TEXT NOT NULL REFERENCES products(id),
  variant_id         TEXT NOT NULL REFERENCES product_variants(id),   -- since 2026-09: a line is one variant

  -- Snapshotted at add time, frozen from then on.
  product_name       TEXT NOT NULL,
  category_name      TEXT,                       -- the category the line was entered under
  alias              TEXT,
  code               TEXT,                       -- the variant's code as it was
  variant_label      TEXT,                       -- the variant's colour or pattern as it was
  colour             TEXT,                       -- since 2026-09-21: the colour chosen on a multi-colour line
  size               TEXT,
  weight_kg          NUMERIC(10,3),              -- the variant's weight as it was, per piece

  packaging          TEXT,
  grade              TEXT,                       -- since 2026-09-22: the grade this line is sold as
  sequence           INTEGER NOT NULL DEFAULT 0,
  from_party_variant BOOLEAN NOT NULL DEFAULT false,
  image_path         TEXT,
  notes              TEXT,
  quantity           NUMERIC(12,2) NOT NULL,     -- was total_quantity
  search_vector      tsvector,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT line_items_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX idx_line_items_parent  ON line_items (tenant_id, parent_type, parent_id);
CREATE INDEX idx_line_items_product ON line_items (tenant_id, product_id);
CREATE INDEX idx_line_items_variant ON line_items (tenant_id, variant_id);
CREATE INDEX idx_line_items_search  ON line_items USING GIN (tenant_id, search_vector);
```

Leads and orders share this table, discriminated by `(parent_type, parent_id)`. That is what makes
conversion a **straight copy** rather than a translation between two shapes — and what lets one
search index cover both. The parent cannot carry a foreign key because it points at one of two
tables; the services keep it valid. A lead edit that includes the lines replaces them as a set
(`replaceLines` deletes and re-inserts them with fresh ids — lines carry no client-stable
identity), so a lead line's id is not stable across such an edit. An order's lines are copied once,
at conversion.

The snapshot columns are the heart of the design: editing a product afterwards must not rewrite
what an order was quoted as. Every snapshot column is copied at add time and never re-read.

`packaging` is nullable in the schema but required by policy before conversion. It is deliberately
never derived — not from the product, not from a party variant, not during conversion.

`image_path` is carried through the input contract and stored as given; no screen in either panel
sets it today.

**A line is one variant** (2026-09). White ×5 and Blue ×10 of the same model are two lines,
each with its own code and its own weight. The `line_item_quantities` child table of the
tile-era model (one line, many colour rows) is gone: the colour is now the variant, and the
variant is what stock is keyed by, so a line and a reservation are the same grain. `code`,
`variant_label` and `weight_kg` are copied off the variant when the line is added and never
re-read — a weight entered on the product later does not move an order's line.
`Lead.totalWeightKg` and `Order.totalWeightKg` sum `weight_kg × quantity` over the lines that
have a weight; `linesWithoutWeight` counts the rest, because an unentered weight is a fact to
show, not a zero to add. The CHECK on `quantity` is what makes "a line with nothing on it"
impossible to store; the service refuses it first with `validation.lead.quantityRequired`.

**`colour` is the exception to "the colour is the variant"** (2026-09-21). Some models are made
in every colour of the company's colour list — the catalogue prints "ALL COLOURS AVAILABLE IN
ALL ITEMS" over its water closets, pedestal sets, urinals and pans — and nobody wants sixteen
variants per model to say so. Such a model carries `products.multi_colour = true`, and a line on
it may name a colour from the `stock.colour` option list; the line still points at the variant it
quotes, stock stays per variant, and the colour is frozen and copied onto the order like the rest
of the snapshot. A colour on any other product is refused (`validation.lead.colourUnexpected`).

**`grade` is a line attribute, not a catalogue one** (2026-09-22). The trim of 2026-09-21 dropped
grade from `products`, `party_product_variants` *and* `line_items`; a day later the owner asked for
it back on the lead's product card, and `20260325000000_line_item_grade` restores the line's column
alone. The catalogue's stay dropped deliberately: the same variant goes out as one grade on one
line and another on the next, so a grade is what was *sold*, never what the article *is*. Like
`packaging` it is never derived — not from the product, not from a party variant, not during
conversion — and the values come from the `line.grade` option list, which ships empty for a company
to fill under Settings → Fields. It is not in the line's search vector: nobody searches lines by
grade, and adding a term would mean rewriting `line_items_search_refresh` and reindexing every row
for it.

There is no money on a line (2026-09-21): `rate` and `line_total` went with pricing, together
with `leads.total_amount` and `orders.total_amount`.

## `timeline_entries`

```sql
CREATE TABLE timeline_entries (
  id            TEXT PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  parent_type   TEXT NOT NULL CHECK (parent_type IN ('lead', 'order')),
  parent_id     TEXT NOT NULL,                   -- no FK, as on line_items
  kind          TEXT NOT NULL CHECK (kind IN ('system', 'remark')),
  message       TEXT NOT NULL,
  from_stage_id UUID REFERENCES pipeline_stages(id),
  to_stage_id   UUID REFERENCES pipeline_stages(id),
  actor_user_id TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_timeline_parent ON timeline_entries (tenant_id, parent_type, parent_id, created_at);
```

Append-only. System entries (stage changes) and typed remarks share one table so the record's
history reads as one story. Nothing updates or deletes here — a history you can edit is not one.
That is a rule of the code (`timeline.repository.ts` only inserts), not of the database: unlike
`activity_log`, no trigger enforces it.

## `party_product_variants`

A party's own record of a product — what they call it, and how it ships to them — used when a
lead is in `party_wise_mode`. It carried the party's negotiated rate until pricing was removed
(2026-09-21).

```sql
CREATE TABLE party_product_variants (
  id           TEXT PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  party_id     TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name TEXT, alias TEXT, size TEXT, weight_kg NUMERIC(10,3),
  packaging    TEXT,
  version INTEGER NOT NULL DEFAULT 1, hlc TEXT,
  field_hlc JSONB NOT NULL DEFAULT '{}', temporary_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_party_variants_pair ON party_product_variants (tenant_id, party_id, product_id);
```

One row per (party, **product**) — not per product variant, despite the name, which predates
`product_variants`. No soft delete.

`packaging` here is a **suggestion only**. The UI offers it as a chip the user must click; nothing
copies it automatically, because `LEAD_GENERATION_FLOW.md` §3.2 says packaging is chosen by hand
every time.

## Inventory — reserve, then dispatch

Three tables, and the split between them is the point.

```sql
CREATE TABLE inventory_stock (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  product_id      TEXT NOT NULL REFERENCES products(id),           -- denormalised; the variant's product
  variant_id      TEXT NOT NULL REFERENCES product_variants(id),   -- since 2026-09 (was colour TEXT)
  quantity_boxes  NUMERIC(12,2) NOT NULL DEFAULT 0,                -- pieces, despite the name
  reorder_level   NUMERIC(12,2),
  min_stock_level NUMERIC(12,2),                                   -- advisory
  max_stock_level NUMERIC(12,2),                                   -- advisory
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_stock_levels_check
    CHECK (min_stock_level IS NULL OR max_stock_level IS NULL OR max_stock_level >= min_stock_level)
);
CREATE UNIQUE INDEX idx_inventory_variant ON inventory_stock (tenant_id, variant_id);

CREATE TABLE stock_reservations (
  id           TEXT PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_item_id TEXT NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL REFERENCES products(id),
  variant_id   TEXT NOT NULL REFERENCES product_variants(id),   -- since 2026-09 (was colour TEXT)
  quantity     NUMERIC(12,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'released', 'consumed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ
);
CREATE INDEX idx_reservations_order   ON stock_reservations (tenant_id, order_id);
CREATE INDEX idx_reservations_variant ON stock_reservations (tenant_id, variant_id)
    WHERE status = 'active';

CREATE TABLE stock_movements (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  product_id         TEXT NOT NULL REFERENCES products(id),
  variant_id         TEXT NOT NULL REFERENCES product_variants(id),   -- since 2026-09 (was colour TEXT)
  movement_type      TEXT NOT NULL CHECK (movement_type IN ('inbound','outbound','adjustment')),
  quantity_boxes     NUMERIC(10,2) NOT NULL,   -- signed delta, never an absolute
  reference_type     TEXT,                     -- 'purchase', 'manual' or 'order'
  reference_id       TEXT,                     -- the order id when reference_type = 'order'
  note               TEXT,                     -- why a manual adjustment happened
  batch_no           TEXT,                     -- lot fields: see below
  shade              TEXT,
  calibre            TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_variant    ON stock_movements (tenant_id, variant_id);
CREATE INDEX idx_stock_movements_tenant_ref ON stock_movements (tenant_id, reference_type, reference_id);
CREATE INDEX idx_stock_movements_batch      ON stock_movements (tenant_id, product_id, batch_no)
    WHERE batch_no IS NOT NULL;
CREATE INDEX idx_stock_movements_tenant     ON stock_movements (tenant_id);
CREATE INDEX idx_stock_movements_created    ON stock_movements (created_at);
```

**Everything is keyed per variant.** A white basin in stock does not satisfy a reservation for a
blue one, so aggregating to a product total would be wrong rather than merely imprecise. Until
2026-09 the key was `(product_id, colour)` with the colour as free text that a stock movement
happened to create; now it is the `product_variants` row the code belongs to, which is also what
the lead line points at — so a reservation, a movement and a line are the same grain and there is
nothing to match up by name. `product_id` stays on all three, denormalised, for the product-level
listings and the delete guard. `idx_stock_movements_variant` serves the per-variant ledger the
inventory screen opens; `idx_stock_movements_tenant_ref` serves "has this order already moved
stock", which dispatch asks before writing.

`stock_movements` is the append-only ledger of signed deltas (append-only by convention: no
trigger enforces it); `inventory_stock` is the derived snapshot, moved by the same amount in the
same transaction (`applyMovement` in `inventory.repository.ts`); `stock_reservations` is what is
committed but not yet gone. Together they let the system say "40 on the floor, 30 spoken for, 10
free to sell" — which a single running total cannot.

| Event | What is written | Effect |
|---|---|---|
| Stock arrives | `inbound` movement, `reference_type = 'purchase'` | Adds pieces |
| Physical count | `adjustment` movement, `reference_type = 'manual'`, signed difference | Corrects the figure |
| Lead **converted** | one `stock_reservations` row per line (= per variant) | Reduces *free to sell*; the ledger is untouched |
| Order **dispatched** | `outbound` movement per variant (lines of one variant summed), `reference_type = 'order'`; reservations → `consumed` | Pieces actually leave |
| Order cancelled | reservations → `released` | Hold disappears, ledger never involved |

Three rules the implementation depends on:

- **Reservations and the order commit together**, and so do the dispatch movements and the
  reservation consumption. Either half alone leaves stock disagreeing with itself.
- **The ledger is the idempotency check.** Dispatch asks whether a movement already exists for the
  order before writing one, so a repeated dispatch cannot double-count.
- **"Low" is judged on free-to-sell, not on what is on the floor.** Stock already promised to an
  order cannot answer the next one.

**Stock is allowed to go negative, and an order is never blocked by insufficient stock.** A ceramic
dealer routinely sells against a factory order that has not arrived; the shortfall is surfaced
instead. A variant that is reserved but has no stock row at all is synthesised into the
inventory view at zero, precisely because that is the case worth seeing.

**The stock levels and the lot fields** came with `20260315000000_product_trade_and_ceramic_attributes`
and outlived the rest of it:

- `min_stock_level` and `max_stock_level` are advisory. The reorder point was **not** renamed —
  `reorder_level` already carried `countLowStock`, `mapStockLevel`, a route and a mutation kind —
  and `isLow` is still driven by it alone, because a second low-stock rule would make the
  dashboard's figure ambiguous.
- **Batch or lot is deliberately not a product column**, and that was a refusal of the
  requirement as literally written: one product receives many lots, so the column is false the
  second time stock arrives. `stock_movements` gained `batch_no`, `shade` and `calibre` instead, so
  "which lot is this" is answered from the ledger — the data a true lot-level on-hand model would
  be built from. That model means keying `inventory_stock` (one row per variant today) by lot as
  well and following it through reservations and dispatch settlement: a workstream, not a column.
  No write path fills the three columns yet — `applyMovement` inserts none of them — so they read
  back as null.

## 7. What changed from the previous model, and why

History: what `20260302000000_lead_order_rebuild` changed. Several of its results were changed again
later — the sections after this one say how.

| Before | After the rebuild | Why |
|---|---|---|
| `leads.status` enum carried `'order'` | Separate `orders` table, `leads.converted_order_id` | An order runs its own pipeline and has its own fields; both are impossible on the lead's row |
| `lead_items` with scalar `quantity_boxes` | `line_items` + `line_item_quantities` | A line covers several colours, and stock is reserved per colour |
| Stock deducted at conversion | Reserved at conversion, deducted at dispatch | "Committed" and "gone" are different states; only the second is a ledger event |
| `inventory_stock` per product | Per (product, colour) | A reservation for one colour must not draw on another |
| UUID primary keys | Text ids, temporary → permanent | An offline panel has to mint an id before the Master sees the record |
| `leads.lead_number` (`L-000001`) | The permanent id itself (`LD0000000042`) | Two human-facing numbers for one record is one too many |
| `products.price_per_box` | `products.rate` | One name for one number; both gone with pricing on 2026-09-21 |

Migration `20260302000000_lead_order_rebuild` performed all of this on existing data: leads kept
their history, and a lead that had already reached `order` became a real order whose reservations
were recorded as **consumed**, since it had already taken its stock under the old rules.

### And again in 2026-09: the variant restructure

| Before | Now | Why |
|---|---|---|
| `products.product_code`, `weight_kg`, `color` | `product_variants` rows — one per colour/pattern, one for a plain product | A sanitaryware model is sold in many coded variants, each with its own code and weight (`02-parties-and-products.md`) |
| `line_items` + `line_item_quantities` (one line, many colour rows) | One line per variant: `variant_id`, `variant_label`, `quantity` | The colour *is* the variant, and the variant is what stock is keyed by |
| `inventory_stock` / `stock_reservations` / `stock_movements` keyed by `(product_id, colour)` text | Keyed by `variant_id` | A line, a hold and a movement share one grain; nothing is matched by a typed colour name |
| `products.category_id` optional | `NOT NULL` | The lead screen finds products category-first |
| Pick kinds `product`, `variant`, `party` | `category`, `product` (scoped by `categoryId`), `party` | The two-stage search the brief asked for |

Migration `20260323000000_product_variants` does **not** convert tile data: it wipes every
product-linked table (the owner's decision — a fresh master from the Swisware catalogue) and
`down()` throws. The catalogue is loaded through Settings → Developer or `npm run
seed:catalogue`; the sample dataset is built on top of it (`docs/DEVELOPER_MODE.md`).

### And once more on 2026-09-21: the trim, and pricing gone

| Before | Now | Why |
|---|---|---|
| `line_items.rate`, `line_total`; `leads.total_amount`, `orders.total_amount`; `party_product_variants.rate` | Gone | The owner removed pricing whole: the software carries no amounts (`docs/ai-handoffs/product-master-trim.md`) |
| `line_items.sin`, `grade`, `product_type`; the same on `party_product_variants` | Gone | Snapshots of product columns that no longer exist |
| — | `line_items.colour` | The colour chosen on a line of a `multi_colour` model, frozen with the rest of the snapshot |

Migration `20260324000000_product_master_trim` drops the columns in place — no wipe — and
`down()` throws.

### And a correction on 2026-09-22: the line's grade comes back

| Before | Now | Why |
|---|---|---|
| `line_items.grade` dropped by the trim | Back, as a line attribute only | The owner asked for a Grade pick on the lead's product card; a grade is what a line was sold as, not a property of the article |
| `line.grade` option list deleted by the trim | A managed set again, shipped empty | The pick has to come from somewhere a person can maintain — Settings → Fields |

Migration `20260325000000_line_item_grade` adds the column back and seeds nothing. It is
registered **after** the trim rather than in timestamp order, because on a fresh database the
trim — itself pinned near the end — would otherwise drop the column a moment after this added it.
`products.grade` and `party_product_variants.grade` stay gone.
