# Schema — Leads, Orders & Inventory

Covers the actual business workflow: Add Lead → verify → promote to Order
(`PROJECT_PLAN.md` §6.3–6.4), plus the inventory tables that back the "inventory
management" half of the product brief. Inventory tables are schema-ready in
Phase 1 but the stock-tracking *UI* is Phase 2 (`PROJECT_PLAN.md` §11) — having the
tables now avoids a painful migration once orders already exist. PostgreSQL DDL —
see `00-overview.md` for the type/convention rationale.

## `leads` (a lead *is* an order — status carries the transition)

```sql
CREATE TABLE leads (
  id                  UUID PRIMARY KEY,
  lead_number         TEXT NOT NULL UNIQUE,          -- e.g. "L-000123", human-friendly sequence
  party_id            UUID NOT NULL REFERENCES parties(id),
  status              TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'verified', 'order', 'cancelled')),
  source_panel_id     UUID REFERENCES office_panels(id),
  created_by_user_id  UUID REFERENCES users(id),
  notes               TEXT,
  total_amount        INTEGER NOT NULL DEFAULT 0,    -- denormalized sum of lead_items.line_total
  order_date          TIMESTAMPTZ,                    -- set when status becomes 'order'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_leads_number       ON leads(lead_number);
CREATE INDEX        idx_leads_party        ON leads(party_id);
CREATE INDEX        idx_leads_status       ON leads(status);
CREATE INDEX        idx_leads_source_panel ON leads(source_panel_id);
CREATE INDEX        idx_leads_created_at   ON leads(created_at);
```

Why one table instead of separate `leads` and `orders` tables: the product brief
explicitly describes moving a lead to the order tab as a state change on the same
record ("if all verification done finalize order then he can move that lead to
order tab" — not "create a new order from a lead"). A single table with a `status`
column matches that mental model exactly, keeps history intact (an order's full
lead lineage is just itself), and avoids a copy step that could desync line items.
The Office Panel's "Leads" and "Orders" tabs are simply two filtered views of this
one table (`WHERE status IN ('new','verified')` vs `WHERE status = 'order'`), and
`idx_leads_status` keeps both views fast regardless of table size.

`total_amount` is a deliberate denormalization (computable from `lead_items`) kept
in sync by the application layer on every line-item write, so list screens can
sort/filter by amount without summing line items per row on every page load —
worth it once the table has thousands of rows (see
`05-scaling-and-operations.md`).

## `lead_items` (line items — a lead/order can contain multiple products)

```sql
CREATE TABLE lead_items (
  id             UUID PRIMARY KEY,
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(id),
  quantity_boxes NUMERIC(10,2),
  quantity_sqft  NUMERIC(10,2),
  unit_price     INTEGER,                            -- smallest currency unit, snapshot at time of add
  line_total     INTEGER,                             -- unit_price * quantity, smallest currency unit
  parameters     JSONB NOT NULL DEFAULT '{}',          -- per-line custom specs/requests
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_items_lead    ON lead_items(lead_id);
CREATE INDEX idx_lead_items_product ON lead_items(product_id);
```

Modeled as a **one-to-many** line-item table rather than a single `product_id` on
`leads` itself, even though the brief describes adding one product while creating
a lead — real ceramic orders routinely cover several products/sizes for one
customer, and a single-product lead is just the `n = 1` case of this table. Doing
it this way now avoids a schema change (and a data migration of every historical
lead) the first time someone asks to add a second product to an existing order.

`unit_price` is copied onto the line item at the moment it's added rather than
always read live from `products.price_per_box` — so a later price change on the
product doesn't silently rewrite the amount on an order that already went out.

## `inventory_stock` (current stock snapshot, one row per product)

```sql
CREATE TABLE inventory_stock (
  id              UUID PRIMARY KEY,
  product_id      UUID NOT NULL UNIQUE REFERENCES products(id),
  quantity_boxes  NUMERIC(10,2) NOT NULL DEFAULT 0,
  quantity_sqft   NUMERIC(10,2) NOT NULL DEFAULT 0,
  reorder_level   NUMERIC(10,2),                        -- optional low-stock threshold
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_inventory_stock_product ON inventory_stock(product_id);
```

## `stock_movements` (append-only ledger — the source of truth `inventory_stock` is derived from)

```sql
CREATE TABLE stock_movements (
  id                  BIGSERIAL PRIMARY KEY,           -- sequential log, no cross-table reference needs UUID
  product_id          UUID NOT NULL REFERENCES products(id),
  movement_type       TEXT NOT NULL CHECK (movement_type IN ('inbound', 'outbound', 'adjustment')),
  quantity_boxes      NUMERIC(10,2) NOT NULL,
  reference_type      TEXT,                             -- e.g. 'order', 'purchase', 'manual'
  reference_id        UUID,                              -- e.g. the leads.id this outbound movement came from
  created_by_user_id  UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_created ON stock_movements(created_at);
```

`inventory_stock` is a fast-read cache; `stock_movements` is the append-only,
never-edited audit trail every quantity change is computed from. This split
(ledger + derived snapshot) is the standard pattern for anything money- or
stock-adjacent: it means "why is stock at 42 boxes?" always has a reconstructible
answer, and a bug that corrupts the snapshot can be fixed by replaying the ledger
instead of losing history. Once `stock_movements` grows large, it's also a natural
candidate for the date-range **partitioning** described in
`05-scaling-and-operations.md` — Postgres supports this natively.
