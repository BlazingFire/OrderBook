# Schema — Leads, Orders & Inventory

Covers the business workflow described in `docs/LEAD_GENERATION_FLOW.md`: raise a lead → move it
through a configurable pipeline → **convert it to an order** → dispatch. PostgreSQL DDL — see
`00-overview.md` for the type/convention rationale, and
`06-tenancy-permissions-and-sync.md` for the tenancy, permission and offline-sync columns every
table here also carries.

> **This chapter was rewritten by the lead-generation rebuild**
> (`20260302000000_lead_order_rebuild`). The previous model had a single `leads` table where a
> `status` column carried the transition to "order", stock deducted at that moment, and inventory
> was per product. All three changed; §7 at the end records why.

## Identifiers

Every table in this chapter uses **text ids**, not UUIDs, because an offline Office Panel must mint
an id before the Master has ever seen the record (`LEAD_GENERATION_FLOW.md` §7):

- temporary — 15 chars, `<6-char device><9-digit counter>`, e.g. `A3F9K2000000123`
- permanent — 12 chars, `<2-char prefix><10-digit sequence>`, e.g. `LD0000000042`

`id_map` keeps a temporary id resolvable forever, so a docket printed offline stays findable.

## `leads`

```sql
CREATE TABLE leads (
  id                 TEXT PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  party_id           TEXT NOT NULL REFERENCES parties(id),
  owner_id           UUID REFERENCES users(id),
  stage_id           UUID NOT NULL REFERENCES pipeline_stages(id),
  source_platform    TEXT,
  follow_up_date     DATE,
  party_wise_mode    BOOLEAN NOT NULL DEFAULT false,
  notes              TEXT,
  custom_fields      JSONB NOT NULL DEFAULT '{}',
  total_amount       BIGINT NOT NULL DEFAULT 0,
  converted_order_id TEXT REFERENCES orders(id),
  converted_at       TIMESTAMPTZ,
  source_panel_id    UUID REFERENCES office_panels(id),
  created_by_user_id UUID REFERENCES users(id),
  version            INTEGER NOT NULL DEFAULT 1,
  hlc                TEXT,
  field_hlc          JSONB NOT NULL DEFAULT '{}',
  temporary_id       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_party    ON leads(tenant_id, party_id);
CREATE INDEX idx_leads_stage    ON leads(tenant_id, stage_id);
CREATE INDEX idx_leads_owner    ON leads(tenant_id, owner_id);
CREATE INDEX idx_leads_followup ON leads(tenant_id, follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX idx_leads_open     ON leads(tenant_id) WHERE converted_order_id IS NULL;
CREATE INDEX idx_leads_created  ON leads(tenant_id, created_at);
```

`stage_id` replaces the old `status` enum: stages are tenant-configurable rows, so the Kanban
columns are data rather than a code change (`pipelines`, `pipeline_stages` in chapter 06).

`converted_order_id` is what makes a lead history rather than a husk. The lead keeps its lines and
its timeline; the partial index `idx_leads_open` is what keeps the board fast while every won deal
stays queryable.

`source_platform` is validated against the `lead.sourcePlatform` option list rather than a CHECK
constraint — it is a reporting dimension a company redefines, and an unknown value is rejected at
the service so a typo cannot quietly become its own category.

## `orders`

```sql
CREATE TABLE orders (
  id                       TEXT PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  lead_id                  TEXT REFERENCES leads(id),
  party_id                 TEXT NOT NULL REFERENCES parties(id),
  owner_id                 UUID REFERENCES users(id),
  stage_id                 UUID NOT NULL REFERENCES pipeline_stages(id),
  dispatch_address_label   TEXT,
  expected_dispatch_date   DATE,
  total_weight_kg          NUMERIC(12,3) NOT NULL DEFAULT 0,
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
```

An order is its own record because it runs its **own pipeline**, independent of the lead's, and
carries fields that only exist once something is a commitment. Both facts are impossible on a row
that also holds the lead's stage.

`total_weight_kg` is always populated from the line weights; `total_weight_kg_override` is set only
when a human disagrees. The computed figure is never discarded, so an override can always be undone
— and the UI labels which one it is showing.

## `line_items` — one table, both parents

```sql
CREATE TABLE line_items (
  id                 TEXT PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  parent_type        TEXT NOT NULL CHECK (parent_type IN ('lead', 'order')),
  parent_id          TEXT NOT NULL,
  product_id         TEXT NOT NULL REFERENCES products(id),

  -- Snapshotted at add time, frozen from then on.
  product_name       TEXT NOT NULL,
  alias              TEXT,
  rate               BIGINT,
  code               TEXT,
  sin                TEXT,
  size               TEXT,
  weight_kg          NUMERIC(10,3),
  grade              TEXT,
  product_type       TEXT,

  packaging          TEXT,
  sequence           INTEGER NOT NULL DEFAULT 0,
  from_party_variant BOOLEAN NOT NULL DEFAULT false,
  image_path         TEXT,
  notes              TEXT,
  total_quantity     NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total         BIGINT,
  search_vector      tsvector,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_line_items_parent  ON line_items(tenant_id, parent_type, parent_id);
CREATE INDEX idx_line_items_product ON line_items(tenant_id, product_id);
CREATE INDEX idx_line_items_search  ON line_items USING GIN (tenant_id, search_vector);
```

Leads and orders share this table, discriminated by `(parent_type, parent_id)`. That is what makes
conversion a **straight copy** rather than a translation between two shapes — and what lets one
search index cover both.

The snapshot columns are the heart of the design: editing a product afterwards must not rewrite
what an order was quoted at. `rate` is copied at add time and never re-read.

`packaging` is nullable in the schema but required by policy before conversion. It is deliberately
never derived — not from the product, not from a party variant, not during conversion.

```sql
CREATE TABLE line_item_quantities (
  id           UUID PRIMARY KEY,
  line_item_id TEXT NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
  colour       TEXT NOT NULL,
  quantity     NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_line_item_qty_colour ON line_item_quantities(line_item_id, colour);
```

Colours are child rows, not columns: one line routinely covers several and the count is not known
in advance. The unique index stops a line carrying two rows for the same colour, which would
reserve stock twice.

## `timeline_entries`

```sql
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
```

Append-only. System entries (stage changes) and typed remarks share one table so the record's
history reads as one story. Nothing updates or deletes here — a history you can edit is not one.

## `party_product_variants`

A party's negotiated rate and spec for a product, used when a lead is in `party_wise_mode`.

```sql
CREATE TABLE party_product_variants (
  id           TEXT PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  party_id     TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name TEXT, alias TEXT, rate BIGINT, size TEXT, sin TEXT,
  grade TEXT, product_type TEXT, weight_kg NUMERIC(10,3),
  packaging    TEXT,
  version INTEGER NOT NULL DEFAULT 1, hlc TEXT,
  field_hlc JSONB NOT NULL DEFAULT '{}', temporary_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_party_variants_pair ON party_product_variants(tenant_id, party_id, product_id);
```

`packaging` here is a **suggestion only**. The UI offers it as a chip the user must click; nothing
copies it automatically, because §3.2 says packaging is chosen by hand every time.

## Inventory — reserve, then dispatch

Three tables, and the split between them is the point.

```sql
CREATE TABLE inventory_stock (
  id             UUID PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  colour         TEXT NOT NULL,
  quantity_boxes NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_level  NUMERIC(12,2),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_inventory_product_colour ON inventory_stock(tenant_id, product_id, colour);

CREATE TABLE stock_reservations (
  id           TEXT PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_item_id TEXT NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL REFERENCES products(id),
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

CREATE TABLE stock_movements (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  product_id         TEXT NOT NULL REFERENCES products(id),
  colour             TEXT NOT NULL,
  movement_type      TEXT NOT NULL CHECK (movement_type IN ('inbound','outbound','adjustment')),
  quantity_boxes     NUMERIC(10,2) NOT NULL,   -- signed delta, never an absolute
  reference_type     TEXT,
  reference_id       TEXT,
  note               TEXT,
  created_by_user_id UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Everything is keyed per (product, colour).** A white basin in stock does not satisfy a
reservation for a blue one, so aggregating to a product total would be wrong rather than merely
imprecise.

`stock_movements` is the append-only ledger of signed deltas; `inventory_stock` is the derived
snapshot; `stock_reservations` is what is committed but not yet gone. Together they let the system
say "40 on the floor, 30 spoken for, 10 free to sell" — which a single running total cannot.

| Event | What is written | Effect |
|---|---|---|
| Stock arrives | `inbound` movement, `reference_type = 'purchase'` | Adds boxes |
| Physical count | `adjustment` movement, signed difference | Corrects the figure |
| Lead **converted** | one `stock_reservations` row per (line, colour) | Reduces *free to sell*; the ledger is untouched |
| Order **dispatched** | `outbound` movement per (product, colour), reservations → `consumed` | Boxes actually leave |
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
instead. A (product, colour) that is reserved but has no stock row at all is synthesised into the
inventory view at zero, precisely because that is the case worth seeing.

## 7. What changed from the previous model, and why

| Before | Now | Why |
|---|---|---|
| `leads.status` enum carried `'order'` | Separate `orders` table, `leads.converted_order_id` | An order runs its own pipeline and has its own fields; both are impossible on the lead's row |
| `lead_items` with scalar `quantity_boxes` | `line_items` + `line_item_quantities` | A line covers several colours, and stock is reserved per colour |
| Stock deducted at conversion | Reserved at conversion, deducted at dispatch | "Committed" and "gone" are different states; only the second is a ledger event |
| `inventory_stock` per product | Per (product, colour) | A reservation for one colour must not draw on another |
| UUID primary keys | Text ids, temporary → permanent | An offline panel has to mint an id before the Master sees the record |
| `leads.lead_number` (`L-000001`) | The permanent id itself (`LD0000000042`) | Two human-facing numbers for one record is one too many |
| `products.price_per_box` | `products.rate` | The guide's name for the same number; one name, not two |

Migration `20260302000000_lead_order_rebuild` performs all of this on existing data: leads keep
their history, and a lead that had already reached `order` becomes a real order whose reservations
are recorded as **consumed**, since it had already taken its stock under the old rules.
