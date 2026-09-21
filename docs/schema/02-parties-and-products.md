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

Since `20260323000000_product_variants` a category is **mandatory** on every
product (`products.category_id` is `NOT NULL`): the lead screen finds products
category-first — typing "toilet" offers *ONE PIECE TOILET*, never a product —
so a product outside every category would be unreachable from the one screen
that sells it. The catalogue's twelve categories are seeded by the Swisware
loader (`docs/DEVELOPER_MODE.md`); a product form that names a category the
Master does not hold creates it.

```sql
CREATE TABLE product_categories (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,                 -- e.g. "Floor Tile", "Wall Tile", "Sanitaryware"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## `products` (the model)

A row is a **model** — DAMRU, 102, HEXA URINAL — the thing a category lists and a
name is typed for. It carries no code and no weight: those belong to its
variants (next section), and a model with no colour or pattern choices has
exactly one variant.

**What a product is, since 2026-09-21** (`docs/ai-handoffs/product-master-trim.md`):

```sql
-- The live shape. Everything below the plumbing line is what a person fills in.
CREATE TABLE products (
  id             TEXT PRIMARY KEY,                       -- 'PR' + 10 digits
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  name           TEXT NOT NULL,                          -- the model: DAMRU, 102, HEXA URINAL
  category_id    TEXT NOT NULL REFERENCES product_categories(id),
  alias          TEXT,                                   -- a short counter name
  size           TEXT,                                   -- free text: '9" · L-27 B-15 H-26', '18x12'
  has_variants   BOOLEAN NOT NULL DEFAULT false,         -- the form's "comes in variants" switch
  multi_colour   BOOLEAN NOT NULL DEFAULT false,         -- made in every colour of the colour list
  custom_fields  JSONB NOT NULL DEFAULT '{}',            -- values of admin-defined fields
  -- plumbing
  is_active      BOOLEAN NOT NULL DEFAULT true,
  version        INTEGER NOT NULL DEFAULT 1,
  hlc            TEXT,
  field_hlc      JSONB NOT NULL DEFAULT '{}',
  temporary_id   TEXT,
  search_vector  tsvector,                               -- name, variant codes + labels, alias, size
  deleted_at     TIMESTAMPTZ,
  deleted_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`multi_colour` marks a model the factory makes in any colour of the company's colour list
(the `stock.colour` option list) — the catalogue prints "ALL COLOURS AVAILABLE IN ALL ITEMS"
over its water closets, pedestal sets, urinals and pans. A lead line on such a model may name a
colour (`line_items.colour`, `03-leads-orders-inventory.md`); the colour is a line attribute,
not a stock key. Everything else that once sat on this table — `sin`, `grade`, `product_type`,
`brand`, `barcode`, `hsn_code`, `uom`, the five money columns, the thirteen tile-era attributes
and the `parameters` bag — was dropped by `20260324000000_product_master_trim` at the owner's
decision that a product is a name, a category, an alias, a size and its variants.

The rest of this section is the history that got here. The DDL immediately below is the
tile-era original; the 2026-09 restructure that removed `product_code`, `weight_kg` and `color`
and added `has_variants` is described under *Product variants*; the trade attributes of
2026-08-29 are described after it and are gone.

```sql
CREATE TABLE products (
  id                UUID PRIMARY KEY,
  product_code      TEXT NOT NULL UNIQUE,            -- printed/scanned code staff search by (DROPPED 2026-09 — see product_variants)
  name              TEXT NOT NULL,
  category_id       UUID REFERENCES product_categories(id),   -- NOT NULL since 2026-09
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

### The trade and ceramic attributes (2026-08-29) — removed 2026-09-21

`20260315000000_product_trade_and_ceramic_attributes` did exactly the promotion
the paragraph above describes, once the owner named the field set. Every one of
these columns was dropped again by `20260324000000_product_master_trim`; the
DDL stays as the record of what the migration in between added:

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

**Batch or lot is deliberately not a product column**, and that was a refusal of
the requirement as literally written. One product receives many lots, so the
column is false the second time stock arrives. `stock_movements` gained
`batch_no`, `shade` and `calibre` instead, which answers "which lot is this"
from the ledger — and is the data a true lot-level on-hand model would be built
from. That model means re-keying `inventory_stock` from
`(tenant_id, product_id, colour)` and following it through reservations, line
item quantities, dispatch settlement and the document renderer: a workstream,
not a column.

`inventory_stock` gained `min_stock_level` and `max_stock_level`, both advisory,
and those two stay. The reorder point was **not** renamed — `reorder_level`
already carries `countLowStock`, `mapStockLevel`, a route and a mutation kind —
and `isLow` is still driven by it alone, because a second low-stock rule would
make the dashboard's figure ambiguous.

### Product variants (2026-09-19)

`20260323000000_product_variants` moved the product master from a tile trade
to a sanitaryware one — category → **model** → **variant** — where a model
(DAMRU) is sold in many coded variants (41, 42, … each a pattern; White;
Rustic Coffee Brown) and every variant owns its own code and its own weight.
The owner's brief (`Product_Flow_Restructure_Requirements.md`) is the source of
the rules; the design choices are recorded in
`docs/ai-handoffs/product-model-variants.md`.

```sql
CREATE TABLE product_variants (
  id         TEXT PRIMARY KEY,                       -- 'VR' + 10 digits (shared/src/sync/ids.ts)
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,                          -- the code staff type; unique across the shop
  label      TEXT,                                   -- the colour (or pattern — "Vitrosa 41"); NULL on a no-variant product
  weight_kg  NUMERIC(10,3) CHECK (weight_kg IS NULL OR weight_kg > 0),
  sequence   INTEGER NOT NULL DEFAULT 0,             -- the order the form shows them in
  is_active  BOOLEAN NOT NULL DEFAULT true,          -- false once removed from the form but still quoted somewhere
  deleted_at TIMESTAMPTZ,                            -- mirrored from products.deleted_at on bin/restore
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_product_variants_code_tenant ON product_variants (tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_product_variants_label       ON product_variants (product_id, lower(coalesce(label, '')));
CREATE INDEX        idx_product_variants_product     ON product_variants (tenant_id, product_id, sequence);
CREATE INDEX        idx_products_category            ON products (tenant_id, category_id);

ALTER TABLE products
  DROP COLUMN product_code, DROP COLUMN weight_kg, DROP COLUMN color,
  ADD COLUMN has_variants BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN category_id SET NOT NULL;
DROP SEQUENCE product_code_seq;
```

**Every product has at least one variant.** A product with no colour or
pattern choices (`has_variants = false`) has exactly one row with `label NULL`
— which is what lets **one** partial unique index guard every code in the shop
whichever kind of product it belongs to, and what lets a lead line, a stock
row and a reservation always point at a `variant_id`. The label index's
`coalesce(label, '')` is what stops a second unlabelled row on one model.

The partial code index (`WHERE deleted_at IS NULL`) is why `deleted_at` is
mirrored from the product: a binned product frees its codes for another
product — the ordinary way a single-code product is regrouped into a model —
and restoring it is refused, naming the codes, while another live product
holds one (`validation.product.restoreCodesTaken`). Codes are what the trade
quotes, so they are never renamed on the way out of the bin the way party
names are.

`is_active = false` is a variant taken off the form that history still quotes
(a line, a movement, a stock row with pieces on it, an active reservation):
`replaceVariants` deactivates such a row rather than deleting it, keeps its
id and its code, and refuses it on new leads (`validation.lead.variantMissing`).
An unreferenced row is simply deleted.

`weight_kg` is nullable on purpose: the catalogue carries no weights and
inventing one would put a number on a dispatch note that nobody measured. A
blank weight is flagged "weight missing" on every screen and left out of every
total (`Lead.totalWeightKg` counts the rest in `linesWithoutWeight`); when
given it must be positive, both here and in `validateProductVariants`.

`products.search_vector` now includes the variants' codes and labels at
weight A: `products_search_refresh()` aggregates them, and an AFTER trigger on
`product_variants` (`product_variants_search_refresh()`) re-fires the product's
own BEFORE UPDATE trigger, so a code edited on a variant is searchable at once
even though the product row itself did not change.

**The migration wipes every product-linked record** — products, categories,
image rows, party-wise rates, the stock ledger and snapshot, reservations,
leads, orders, their lines and timelines — because the owner chose a fresh
product master from the catalogue over migrating tile data that no longer
describes the business, and leads and orders cannot outlive the products they
quote. Users, roles, parties, settings, pipelines and option lists stay;
`activity_log` keeps its history of the wiped ids; image files on disk are left
alone. It is idempotent (skipped once `products.product_code` is gone) and
`down()` throws — restore from a backup.

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
