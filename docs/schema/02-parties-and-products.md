# Schema — Parties & Products

Covers the master data every lead/order is built from (`PROJECT_PLAN.md` §6.3,
§6.5).

## `parties` (customers)

```sql
CREATE TABLE parties (
  id             TEXT PRIMARY KEY,                -- UUID
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
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by_user_id  TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_parties_code  ON parties(party_code);
CREATE INDEX        idx_parties_name  ON parties(name);
CREATE INDEX        idx_parties_phone ON parties(phone);
```

`name` and `phone` are indexed (not unique) because the Add Lead screen's "search
or select existing party" (`PROJECT_PLAN.md` §6.3) needs fast lookup by either, and
two different customers can legitimately share a name. Exact fields here are
flagged as an **open question** in `PROJECT_PLAN.md` §12 — `gst_number` and the
address split are a reasonable ceramic-trade default, confirm before Phase 1 build.

## `product_categories` (product "type")

Normalized into its own table rather than a free-text column on `products`, so the
set of types stays consistent (no "Floor Tile" vs "floor tile" vs "Floor Tiles"
drift) and can be managed from a settings screen later without a migration.

```sql
CREATE TABLE product_categories (
  id         TEXT PRIMARY KEY,                     -- UUID
  name       TEXT NOT NULL UNIQUE,                 -- e.g. "Floor Tile", "Wall Tile", "Sanitaryware"
  created_at TEXT NOT NULL
);
```

## `products`

```sql
CREATE TABLE products (
  id                TEXT PRIMARY KEY,               -- UUID
  product_code      TEXT NOT NULL UNIQUE,            -- printed/scanned code staff search by
  name              TEXT NOT NULL,
  category_id       TEXT REFERENCES product_categories(id),
  size              TEXT,                            -- e.g. "600x600mm"
  finish            TEXT,                            -- e.g. glossy / matte / rustic
  series            TEXT,
  color             TEXT,
  thickness_mm      REAL,
  pieces_per_box    INTEGER,
  box_coverage_sqft REAL,
  price_per_box     INTEGER,                         -- smallest currency unit
  price_per_sqft    INTEGER,                          -- smallest currency unit
  hsn_code          TEXT,                             -- tax classification code
  parameters        TEXT,                             -- JSON — extra attributes not yet finalized
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_products_code     ON products(product_code);
CREATE INDEX        idx_products_name     ON products(name);
CREATE INDEX        idx_products_category ON products(category_id);
```

The typed columns above (`size`, `finish`, `series`, `color`, `thickness_mm`,
`pieces_per_box`, `box_coverage_sqft`) are a starting guess at real ceramic
attributes so search/filter/reporting works well from day one. `parameters` (JSON)
absorbs anything the user asks for that doesn't fit yet — confirm the real field
list with the user (see `PROJECT_PLAN.md` §12) and promote anything used often
from `parameters` into a real column in a follow-up migration; that's a cheap,
additive change and not a reason to block Phase 1 on a perfect field list.

## `product_images`

```sql
CREATE TABLE product_images (
  id          TEXT PRIMARY KEY,                     -- UUID
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,                         -- relative to data/uploads/
  is_primary  INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL
);

CREATE INDEX idx_product_images_product ON product_images(product_id);
```

A product can have multiple images (different angles/lighting, common for tiles);
`is_primary` marks which one shows in list/search views. `ON DELETE CASCADE`
here is intentional and safe — image rows have no history value of their own once
the product itself is gone (unlike `leads`, which must survive a product being
deactivated — see `is_active` on `products`, never hard-delete a product that's
been ordered).
