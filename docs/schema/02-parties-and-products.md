# Schema — Parties & Products

Covers the master data every lead/order is built from (`PROJECT_PLAN.md` §6.3,
§6.5). PostgreSQL DDL describing the current shape — see `00-overview.md` for the
type/convention rationale and how this was checked, and
`06-tenancy-permissions-and-sync.md` for the sync columns (`version`, `hlc`,
`field_hlc`, `temporary_id`) and the search vectors.

## `parties` (customers)

```sql
CREATE TABLE parties (
  id                  TEXT PRIMARY KEY,                 -- 'PT' + 10 digits
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  party_code          TEXT NOT NULL,                    -- e.g. "P-0001", auto-generated
  name                TEXT NOT NULL,
  phone               TEXT,
  alt_phone           TEXT,
  email               TEXT,
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  state               TEXT,
  pincode             TEXT,
  gst_number          TEXT,                             -- optional, for GST-registered dealers
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  custom_fields       JSONB NOT NULL DEFAULT '{}',      -- values of admin-defined fields
  created_by_user_id  TEXT REFERENCES users(id),
  -- plumbing
  version             INTEGER NOT NULL DEFAULT 1,
  hlc                 TEXT,
  field_hlc           JSONB NOT NULL DEFAULT '{}',
  temporary_id        TEXT,
  search_vector       tsvector,                         -- name, code, phones, email, city
  deleted_at          TIMESTAMPTZ,
  deleted_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_parties_code_tenant ON parties (tenant_id, party_code) WHERE deleted_at IS NULL;
CREATE INDEX        idx_parties_search      ON parties USING GIN (tenant_id, search_vector);
CREATE INDEX        idx_parties_hlc         ON parties (tenant_id, hlc);
CREATE INDEX        idx_parties_deleted     ON parties (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX        idx_parties_tenant      ON parties (tenant_id);
CREATE INDEX        idx_parties_name        ON parties (lower(name));
CREATE INDEX        idx_parties_phone       ON parties (phone);
```

`party_code` is the only display code in the schema separate from a record's id
(`00-overview.md` §2). `insertParty` (`party.repository.ts`) draws it as
`'P-' || lpad(nextval('party_code_seq')::text, 4, '0')` — a sequence rather than
`MAX(code)+1`, because two Office Panels can create a party in the same instant. The
sequence is one per database, not per tenant; the code is unique per tenant **among
live parties**, so a party in the Recycle Bin does not reserve its code. Note that
PostgreSQL's `lpad` truncates as well as pads: from the 10,000th party the generated
code repeats an earlier one (`P-1000` again) and the insert fails on
`idx_parties_code_tenant` while that earlier party is live. That is a defect in the
code, not a schema rule.

`name` and `phone` are not unique: two different customers can legitimately share a
name. Finding a party goes through `search_vector` (the global search and the pickers)
and an `ILIKE '%…%'` filter on name, phone and code (the party list); a b-tree on
`lower(name)` serves neither, so `idx_parties_name` and `idx_parties_phone` — both
from the initial schema, and not tenant-scoped — are not what makes the search box
fast. The field set (`gst_number`, the address split) was the ceramic-trade default
proposed in `PROJECT_PLAN.md` §12, and is what shipped; anything further a company
wants goes in a custom field.

A party can be restricted to particular people through `party_access`
(`06-tenancy-permissions-and-sync.md` §2a).

*History:* the initial schema created `parties` with a UUID `id` and a globally
unique `party_code`. `20260301000000_tenancy_access_and_sync` made the code unique per
tenant; `20260302000000_lead_order_rebuild` moved the id to text and added
`custom_fields`, the sync columns and `search_vector`;
`20260303000000_roles_and_users` re-created `created_by_user_id` as TEXT when user ids
became text; `20260305000000_soft_delete_columns` added soft delete and made the code
index partial.

## `product_categories` (the "main product")

Normalized into its own table rather than a free-text column on `products`, so the
set of categories stays consistent (no "Water Closet" vs "water closet" vs "Water
Closets" drift) and is managed from the product form rather than by a migration.

```sql
CREATE TABLE product_categories (
  id          TEXT PRIMARY KEY,                       -- 'PC' + 10 digits
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,                          -- e.g. "ONE PIECE TOILET", "WATER CLOSET"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_categories_name_tenant    ON product_categories (tenant_id, lower(name));
CREATE INDEX        idx_product_categories_tenant ON product_categories (tenant_id);
```

A category carries no sync bookkeeping and no soft delete, so it is not in the
Recycle Bin; its name is unique per tenant, case-insensitively.

Since `20260323000000_product_variants` a category is **mandatory** on every
product (`products.category_id` is `NOT NULL`): the lead screen finds products
category-first — typing "toilet" offers *ONE PIECE TOILET*, never a product —
so a product outside every category would be unreachable from the one screen
that sells it. The catalogue's twelve categories are seeded by the Swisware
loader (`docs/DEVELOPER_MODE.md`); a product form that names a category the
Master does not hold creates it.

*History:* created by the initial schema with a UUID `id` and a globally unique
`name`; unique per tenant since `20260301`, text ids since `20260302`.

## `products` (the model)

A row is a **model** — DAMRU, 102, HEXA URINAL — the thing a category lists and a
name is typed for. It carries no code and no weight: those belong to its
variants (next section), and a model with no colour or pattern choices has
exactly one variant.

**What a product is, since 2026-09-21** (`HANDOFF.md` Key decision 15):

```sql
-- The live shape. Everything above the plumbing line is what a person fills in.
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
  search_vector  tsvector,                               -- name, live variant codes + labels, alias, size
  deleted_at     TIMESTAMPTZ,
  deleted_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_category ON products (tenant_id, category_id);
CREATE INDEX idx_products_search   ON products USING GIN (tenant_id, search_vector);
CREATE INDEX idx_products_hlc      ON products (tenant_id, hlc);
CREATE INDEX idx_products_deleted  ON products (tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_products_tenant   ON products (tenant_id);
CREATE INDEX idx_products_name     ON products (lower(name));   -- from the initial schema; not tenant-scoped
```

`multi_colour` marks a model the factory makes in any colour of the company's colour list
(the `stock.colour` option list) — the catalogue prints "ALL COLOURS AVAILABLE IN ALL ITEMS"
over its water closets, pedestal sets, urinals and pans. A lead line on such a model may name a
colour (`line_items.colour`, `03-leads-orders-inventory.md`); the colour is a line attribute,
not a stock key. Everything else that once sat on this table — `sin`, `grade`, `product_type`,
`brand`, `barcode`, `hsn_code`, `uom`, every price column, the tile and ceramic attributes and
the `parameters` bag — was dropped by `20260324000000_product_master_trim` at the owner's
decision that a product is a name, a category, an alias, a size and its variants. Nothing makes
a model's name unique — the codes that must be unique are on its variants.

### History: how the product master got here

| Migration | What it did to `products` |
|---|---|
| `20260101000000_initial_schema` | Tile-trade original: UUID `id`, a globally unique `product_code`, optional `category_id`, `size`, `finish`, `series`, `color`, `thickness_mm`, `pieces_per_box`, `box_coverage_sqft`, two price columns, `hsn_code`, and a `parameters` JSONB bag (GIN-indexed) for attributes not yet decided. |
| `20260301000000_tenancy_access_and_sync` | `tenant_id`; the code unique per tenant. |
| `20260302000000_lead_order_rebuild` | Text ids (`PR…`); `alias`, `sin`, `grade`, `product_type`, `weight_kg`, `custom_fields`, the sync columns, `search_vector`; renamed the box price to `rate`. |
| `20260305000000_soft_delete_columns` | `deleted_at`/`deleted_by`; the code index partial on live rows. |
| `20260315000000_product_trade_and_ceramic_attributes` | Fourteen trade and ceramic columns (MRP, purchase rate, GST rate, unit of measure, barcode, brand, shade, calibre, water absorption, PEI rating, edge type, surface texture, application, origin plant), the `field.purchaseRate.*` permission keys, and — surviving — `inventory_stock.min_stock_level`/`max_stock_level` and `stock_movements.batch_no`/`shade`/`calibre` (`03-leads-orders-inventory.md`). |
| `20260322000000_product_colour_policy_and_line_category` | `colour_policy` (`fixed`/`selectable`); gone again one migration later. |
| `20260323000000_product_variants` | Dropped `product_code`, `weight_kg`, `color` and `colour_policy`, added `has_variants`, made `category_id` NOT NULL — see *Product variants* below. |
| `20260324000000_product_master_trim` | Dropped 26 columns, every price among them, and the permission keys and option lists that went with them; added `multi_colour`. |

One rule from the trade-attribute pass still governs any attribute added later:
**columns** for anything indexed, constrained, arithmetic or standard-defined;
**option lists** for vocabularies staff extend; **custom fields** for neither. A new
brand arrives with a new supplier and must not need a migration.

### Product variants (2026-09-19)

`20260323000000_product_variants` moved the product master from a tile trade
to a sanitaryware one — category → **model** → **variant** — where a model
(DAMRU) is sold in many coded variants (41, 42, … each a pattern; White;
Rustic Coffee Brown) and every variant owns its own code and its own weight.
The owner's brief (`Product_Flow_Restructure_Requirements.md`, supplied outside the
repository) is the source of the rules; the owner's decisions are `HANDOFF.md` Key
decision 14 (the full design brief was deleted as done on 2026-09-25; git history has it).

```sql
CREATE TABLE product_variants (
  id         TEXT PRIMARY KEY,                       -- 'VR' + 10 digits (shared/src/sync/ids.ts)
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,                          -- the code staff type; unique across the shop
  label      TEXT,                                   -- the colour (or pattern — "Vitrosa 41"); NULL on a no-variant product
  weight_kg  NUMERIC(10,3),                          -- per piece
  sequence   INTEGER NOT NULL DEFAULT 0,             -- the order the form shows them in
  is_active  BOOLEAN NOT NULL DEFAULT true,          -- false once removed from the form but still quoted somewhere
  deleted_at TIMESTAMPTZ,                            -- mirrored from products.deleted_at on bin/restore
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_weight_check CHECK (weight_kg IS NULL OR weight_kg > 0)
);
CREATE UNIQUE INDEX idx_product_variants_code_tenant ON product_variants (tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_product_variants_label       ON product_variants (product_id, lower(coalesce(label, '')));
CREATE INDEX        idx_product_variants_product     ON product_variants (tenant_id, product_id, sequence);
```

A variant has no sync bookkeeping and no `deleted_by`: it is only ever written as part
of its product — the product form (`replaceVariants`), a product import, a bin or a
restore — never on its own.

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

`products.search_vector` includes the codes and labels of the product's **live**
variants (active and not deleted) at weight A: `products_search_refresh()` aggregates
them, and an AFTER INSERT/UPDATE/DELETE trigger on `product_variants`
(`product_variants_search_refresh()`) re-fires the product's own BEFORE UPDATE
trigger, so a code edited on a variant is searchable at once even though the product
row itself did not change.

The same migration re-keyed everything that pointed at a product-and-colour pair onto
the variant: `products` lost `product_code`, `weight_kg` and `color`, gained
`has_variants` and a NOT NULL `category_id` (with `idx_products_category`), and
`product_code_seq` was dropped; lines, stock, movements and reservations moved to
`variant_id` (`03-leads-orders-inventory.md`).

**The migration wiped every product-linked record** — products, categories,
image rows, party-wise records, the stock ledger and snapshot, reservations,
leads, orders, their lines and timelines — because the owner chose a fresh
product master from the catalogue over migrating tile data that no longer
describes the business, and leads and orders cannot outlive the products they
quote. Users, roles, parties, settings, pipelines and option lists stayed;
`activity_log` keeps its history of the wiped ids; image files on disk were left
alone. It is idempotent (skipped once `products.product_code` is gone) and
`down()` throws — restore from a backup.

## `product_images`

```sql
CREATE TABLE product_images (
  id           UUID PRIMARY KEY,                     -- generated by the Master; images are never minted offline
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  caption      TEXT,
  sequence     INTEGER NOT NULL DEFAULT 0,           -- gallery order
  width        INTEGER NOT NULL,                     -- of the stored `master` variant
  height       INTEGER NOT NULL,
  checksum     TEXT NOT NULL,                        -- sha256 of the `master` variant's bytes
  blurhash     TEXT NOT NULL,                        -- placeholder while the image loads
  byte_size    INTEGER NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_images_product_seq ON product_images (product_id, sequence);
CREATE INDEX idx_product_images_tenant      ON product_images (tenant_id);
```

Metadata only: the files are `<dataDir>/uploads/images/<tenantId>/<id>/<variant>.webp`
(`00-overview.md` §4), a path derived from the ids rather than stored. The id stays a
UUID rather than joining the text-id scheme because images are uploaded online-only,
directly against the Master, so they need no temporary-id promotion path.

A product can have multiple images (different angles/lighting); `is_primary` marks
which one shows in list/search views, and the gallery is ordered primary first, then
by `sequence`. Anyone who can see a product sees its gallery — there is no separate
`images.view` permission; changing a gallery needs `products.edit`.

`ON DELETE CASCADE` here is intentional and safe — image rows have no history value of
their own once the product itself is gone. An image is not a Recycle Bin entity:
deleting one hard-deletes the row and removes its files. Deleting a *product* is a
soft delete, which keeps its image rows, so restoring the product restores its gallery;
only a hard delete of the product row would cascade, and no code path hard-deletes a
product (the catalogue reload script, `catalog-reload-cli.ts`, truncates the business
tables wholesale instead, and Developer mode's **Erase everything** drops the whole
schema).

*History:* the initial schema stored a relative `file_path` and nothing else about the
image. `20260307000000_product_images_pipeline` dropped `file_path` and added the
metadata columns — safe because no code had ever written a row.
