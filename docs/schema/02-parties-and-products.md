# Schema — Parties & Products

Covers the master data every lead/order is built from (`PROJECT_PLAN.md` §6.3,
§6.5). PostgreSQL DDL — see `00-overview.md` for the type/convention rationale.

## `parties` (customers)

```sql
CREATE TABLE parties (
  id             UUID PRIMARY KEY,
  party_code     TEXT NOT NULL UNIQUE,             -- e.g. "P-0001", auto-generated
  name           TEXT NOT NULL,
  phone          TEXT,
  alt_phone      TEXT,
  email          TEXT,
  address_line1  TEXT,
  address_line2  TEXT,
  city           TEXT,
  state          TEXT,
  pincode        TEXT,
  gst_number     TEXT,                             -- optional, for GST-registered dealers
  notes          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id  UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_parties_code  ON parties(party_code);
CREATE INDEX        idx_parties_name  ON parties(lower(name));   -- case-insensitive search
CREATE INDEX        idx_parties_phone ON parties(phone);
```

`name` and `phone` are indexed (not unique) because the Add Lead screen's "search
or select existing party" (`PROJECT_PLAN.md` §6.3) needs fast lookup by either, and
two different customers can legitimately share a name. The name index is built on
`lower(name)` (a Postgres expression index) so a search box can do
case-insensitive `WHERE lower(name) LIKE lower($1) || '%'` lookups without a table
scan even once the table is large — this kind of expression index is one of the
concrete "more powerful at scale" advantages Postgres has over a simpler engine.
Exact fields here are flagged as an **open question** in `PROJECT_PLAN.md` §12 —
`gst_number` and the address split are a reasonable ceramic-trade default, confirm
before Phase 1 build.

## `product_categories` (product "type")

Normalized into its own table rather than a free-text column on `products`, so the
set of types stays consistent (no "Floor Tile" vs "floor tile" vs "Floor Tiles"
drift) and can be managed from a settings screen later without a migration.

```sql
CREATE TABLE product_categories (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,                 -- e.g. "Floor Tile", "Wall Tile", "Sanitaryware"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## `products`

```sql
CREATE TABLE products (
  id                UUID PRIMARY KEY,
  product_code      TEXT NOT NULL UNIQUE,            -- printed/scanned code staff search by
  name              TEXT NOT NULL,
  category_id       UUID REFERENCES product_categories(id),
  size              TEXT,                            -- e.g. "600x600mm"
  finish            TEXT,                            -- e.g. glossy / matte / rustic
  series            TEXT,
  color             TEXT,
  thickness_mm      NUMERIC(6,2),
  pieces_per_box    INTEGER,
  box_coverage_sqft NUMERIC(8,2),
  price_per_box     INTEGER,                         -- smallest currency unit
  price_per_sqft    INTEGER,                          -- smallest currency unit
  hsn_code          TEXT,                             -- tax classification code
  parameters        JSONB NOT NULL DEFAULT '{}',      -- extra attributes not yet finalized
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_products_code       ON products(product_code);
CREATE INDEX        idx_products_name       ON products(lower(name));
CREATE INDEX        idx_products_category   ON products(category_id);
CREATE INDEX        idx_products_parameters ON products USING GIN (parameters);
```

The typed columns above (`size`, `finish`, `series`, `color`, `thickness_mm`,
`pieces_per_box`, `box_coverage_sqft`) are a starting guess at real ceramic
attributes so search/filter/reporting works well from day one — `thickness_mm` and
`box_coverage_sqft` use `NUMERIC` rather than floating point since they can feed
into price/quantity math. `parameters` (`JSONB`) absorbs anything the user asks for
that doesn't fit yet, and the `GIN` index on it means Phase 1 can already support
"find all products where `parameters->>'glaze' = 'matte'`"-style queries at full
speed even before that field graduates to a real column — confirm the real field
list with the user (see `PROJECT_PLAN.md` §12) and promote anything used often out
of `parameters` into a typed column in a follow-up migration; that's a cheap,
additive change and not a reason to block Phase 1 on a perfect field list.

### The trade and ceramic attributes (2026-08-29)

`20260315000000_product_trade_and_ceramic_attributes` did exactly the promotion
the paragraph above describes, once the owner named the field set:

```sql
ALTER TABLE products
  ADD COLUMN mrp                  INTEGER,      -- smallest currency unit
  ADD COLUMN purchase_rate        INTEGER,      -- smallest currency unit
  ADD COLUMN gst_rate_pct         NUMERIC(5,2),
  ADD COLUMN uom                  TEXT NOT NULL DEFAULT 'box',  -- box | sqft | piece
  ADD COLUMN barcode              TEXT,         -- partial-unique among live rows
  ADD COLUMN brand                TEXT,         -- option list `product.brand`
  ADD COLUMN shade                TEXT,         -- option list `product.shade`
  ADD COLUMN calibre              TEXT,         -- free-form: plant codes vary
  ADD COLUMN water_absorption_pct NUMERIC(5,2),
  ADD COLUMN pei_rating           SMALLINT,     -- 0–5
  ADD COLUMN edge_type            TEXT,         -- rectified | non_rectified
  ADD COLUMN surface_texture      TEXT,         -- option list `product.surfaceTexture`
  ADD COLUMN application          TEXT,         -- floor | wall | floor_wall | outdoor
  ADD COLUMN origin_plant         TEXT;         -- option list `product.originPlant`
```

The rule it followed: **columns** for anything indexed, constrained, arithmetic
or standard-defined; **option lists** for vocabularies staff extend; **custom
fields** for neither. So `pei_rating` is a constrained column while `brand` is
plain TEXT backed by an option list — a new brand arrives with a new supplier
and must not need a migration. Option-list-backed values are not seeded:
`unlisted` already surfaces the values present in the data, so the company's own
catalogue fills the list the first time somebody looks at it.

Two prices, two permissions. `mrp` is readable by everyone and never masked — it
is printed on the box, so hiding it would be theatre — but writable only under
`field.saleRate.edit`. `purchase_rate` is gated by `field.purchaseRate.view` and
masked by **key absence**, which is why `Product.purchaseRate` is declared
optional: anything writing `purchaseRate ?? 0` would read "may not see cost" as
"cost is zero", so margin arithmetic stays server-side.

**Batch or lot is deliberately not a product column**, and that is a refusal of
the requirement as literally written. One product receives many lots, so the
column is false the second time stock arrives. `stock_movements` gained
`batch_no`, `shade` and `calibre` instead, which answers "which lot is this"
from the ledger — and is the data a true lot-level on-hand model would be built
from. That model means re-keying `inventory_stock` from
`(tenant_id, product_id, colour)` and following it through reservations, line
item quantities, dispatch settlement and the document renderer: a workstream,
not a column.

`inventory_stock` gained `min_stock_level` and `max_stock_level`, both advisory.
The reorder point was **not** renamed — `reorder_level` already carries
`countLowStock`, `mapStockLevel`, a route and a mutation kind — and `isLow` is
still driven by it alone, because a second low-stock rule would make the
dashboard's figure ambiguous.

## `product_images`

```sql
CREATE TABLE product_images (
  id          UUID PRIMARY KEY,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,                         -- relative to data/uploads/
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_images_product ON product_images(product_id);
```

A product can have multiple images (different angles/lighting, common for tiles);
`is_primary` marks which one shows in list/search views. `ON DELETE CASCADE`
here is intentional and safe — image rows have no history value of their own once
the product itself is gone (unlike `leads`, which must survive a product being
deactivated — see `is_active` on `products`, never hard-delete a product that's
been ordered).
