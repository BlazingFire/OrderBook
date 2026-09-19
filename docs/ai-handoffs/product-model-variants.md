# Product model → variant restructure (category → model → variant, weight per variant)

**Owner:** Claude (implemented 2026-09-19, branch `feature/product-variants`).
**Reviewer:** the owner, by the live walk-through in §6.
**Size:** XL — a data-model change that touches every screen that names a product.

The owner's brief is `Product_Flow_Restructure_Requirements.md` (attached to the
session, with the Swisware 2026 catalogue PDF). This file records the decisions
taken and the design the code follows; the schema chapters carry the DDL
(`docs/schema/02-parties-and-products.md` §*Product variants*,
`docs/schema/03-leads-orders-inventory.md` §*And again in 2026-09*), the flow
guide the screen behaviour (`docs/LEAD_GENERATION_FLOW.md` §3.2, §5), the API
contract the wire (`docs/backend-modules/04-API-CONTRACT.md` §10.2a) and the
developer-mode doc the catalogue loader (`docs/DEVELOPER_MODE.md`).

## 1. What the brief asked for

- A real hierarchy **Category → Product model → Product variant**, where every
  *variant* owns the unique code, the colour/pattern text and the weight (KG);
  a model may have one variant or many.
- **Category-first search** on the lead screen: typing "toilet" offers *ONE
  PIECE TOILET* and never a product; products appear only inside the chosen
  category; then the variant; the code and weight resolve automatically; then
  the quantity.
- **One lead line per variant** — White ×5 and Blue ×10 are two lines — with
  line weight = weight × quantity, a lead/order total weight, and snapshots
  frozen on the order.
- Fresh product master data from the catalogue; existing Lead/Order screens
  preserved apart from the product-selection areas; tile-specific product
  fields hidden.

## 2. Decisions taken with the owner (2026-09-19)

1. **Seed the whole catalogue now, weights blank.** Weight is optional in
   storage, flagged *weight missing* everywhere, validated `> 0` when given.
   The catalogue carries no weights and inventing one would put a number on a
   dispatch note nobody measured.
2. **Wipe the product-linked data on this install.** One migration truncates
   products, categories, image rows, party-wise rates, the stock ledger and
   snapshot, reservations, leads, orders, lines and timelines. Users, roles,
   parties, settings, pipelines, option lists and the activity log stay.
   `down()` throws — restore from a backup.
3. **Hide the tile-only fields** (finish, series, thickness, pieces per box,
   coverage, shade, calibre, water absorption, PEI, edge, texture, application,
   origin plant) from the product form and the import template. The columns
   stay; a record that holds them keeps them.

## 3. Design choices made here

- **Every product has ≥ 1 `product_variants` row.** A no-variant product has
  exactly one with `label NULL`, so one partial unique index over
  `(tenant_id, lower(code)) WHERE deleted_at IS NULL` guards every code in the
  shop, and a line, a stock row and a reservation always point at a
  `variant_id`. `products.product_code`, `weight_kg`, `color` and
  `product_code_seq` are dropped; `has_variants` is added; `category_id` is
  `NOT NULL`. Id prefix `VR` (`PV` was already the party variant).
- **Inventory is re-keyed by `variant_id`** on `inventory_stock`,
  `stock_movements` and `stock_reservations`; the free-text `colour` columns
  and the per-colour `variant_code` are gone. `domain/stock-key.ts` is deleted.
- **A line is one variant:** `line_items.variant_id`, `variant_label`,
  `quantity` (renamed from `total_quantity`, `CHECK > 0`);
  `line_item_quantities` is dropped. `code` and `weight_kg` snapshots hold the
  variant's values; `lineWeightKg`, `totalWeightKg`, `linesWithoutWeight` are
  derived.
- **The variant set is one mergeable field.** `updateProduct` and the offline
  merge (`sync.service.ts#mergeUpdate`) replace it whole through
  `replaceVariants` — matched by id, then by label; removed rows deactivated
  if referenced, else deleted; codes and labels parked on a per-row
  placeholder mid-save so two rows can swap them — and stamp
  `fieldHlc.variants` once. An older set on the wire is one `variants`
  conflict, never a row-by-row merge.
- **Bin frees codes, restore may be refused.** `deleted_at` is mirrored onto
  the variants; `restoreProduct` refuses with
  `validation.product.restoreCodesTaken` while another live product holds a
  code. Codes are never renamed on the way out of the bin.
- **Pick kinds are `category` · `product` (scoped by `categoryId`) · `party`.**
  `pickProducts` matches variant codes (prefix-boosted) and labels and
  hydrates `variants[]`; the offline picker does the same over the snapshot.
- **Search:** `products.search_vector` aggregates the variants' codes and
  labels at weight A; an AFTER trigger on `product_variants` re-fires the
  product's own trigger. `line_items.search_vector` gains `variant_label`.
- **Import is one sheet row per variant**, grouped by (category, model) into
  one product; mixed blank/non-blank labels in a group is a per-row error;
  codes split across products is an error; a code clash names the row.
- **The catalogue is pure data** (`domain/swisware-catalogue.ts`: 12
  categories, 251 models, 549 variants) loaded by
  `catalogue-seed.service.ts` through the ordinary services as the first
  administrator, idempotent by model, one `catalog` change event, and it seeds
  the `stock.colour` palette. Grouping follows the catalogue's own model names
  only — never picture similarity. Uncoded items get a transparent name slug
  (`HEXA-URINAL`) for the administrator to replace.
- **The sample dataset is rebuilt on the catalogue**: it loads it first, then
  enters prices and illustrative weights on the sixteen models it trades in,
  stock per variant code, and one-variant lines. Its "already seeded" marker is
  the first sample party's phone, not a product code.
- **Screens.** Office: New lead (three stages, draft card with one row per
  variant, one line per filled row, weight column and footer), product form
  (required category via suggest; *Codes & weight* switch: one code, or a
  colour · code · weight table), Catalogue (category chips, *Missing weight*
  chip, codes/weight columns), product detail (variants table, stock per
  variant), lead/order detail and boards (per-variant lines, weights). Master:
  Inventory per variant (read-only code, inline reorder/min/max, ledger scoped
  by variant), Leads with a weight column, Settings → Developer → *Load the
  Swisware catalogue*, connector mapping on `code`/`categoryName`/`weightKg`.
  UI kit: `formatKg`, `SuggestInput` `id`, `ColourQuantityGrid` deleted.

## 4. Files (the map, not the diff)

- Migration `master/src/db/migrations/20260323000000_product_variants.ts`
  (+ registry, idempotent, `down()` throws).
- `shared/src/` — `sync/ids.ts`, `domain/{entities,inputs,pick,columns,
  product-validation,fields,developer}.ts`, `sync/apply-change.ts`,
  `protocol/socket.ts`, `i18n/{en,hi}.ts`.
- Master — `repositories/product-variant.repository.ts` (new),
  `product.repository.ts`, `mappers.ts`, `line-item.repository.ts`,
  `reservation.repository.ts`, `inventory.repository.ts`,
  `search.repository.ts`, `recycle-bin.repository.ts`,
  `field-usage.repository.ts`, `report.repository.ts`, `backup.repository.ts`;
  `domain/{line-items,conversion,product-import,sample-data,
  swisware-catalogue}.ts`; `services/{catalog,lead,order,inventory,search,
  sync,recycle-bin,product-import,sample-data,catalogue-seed,connector-run}.ts`,
  `connector-profiles.ts`; `http/routes/{data,developer}.routes.ts`,
  `public-api-contract.ts`; `db/seed-catalogue-cli.ts` (`npm run
  seed:catalogue`).
- Office server — `http/app.ts`, `sync/local-store.ts`,
  `services/offline-pick.ts`.
- Office web — `screens/{AddLeadScreen,CatalogScreen,ProductDetail,LeadDetail,
  LeadBoardScreen,OrderBoardScreen,DashboardScreen}.tsx`,
  `components/{ProductDrawer,StockCell,ProductImportModal}.tsx`,
  `localSearch.ts`, `api.ts`.
- Master web — `screens/{InventoryScreen,LeadsOrdersScreen,SettingsScreen,
  IntegrationsScreen}.tsx`, `api.ts`.
- `ui/src/{format,SuggestInput,index,base.css}`.

## 5. Tests

New: `migration-product-variants`, `product-variants`, `catalogue-seed`
(integration). Every suite that builds products, lines or stock was moved to the
new shape; `search`, `reports`, `pick`, `lead`, `inventory`, `sync`,
`product-import(-domain)`, `line-items-domain`, `mappers`, `offline-pick`,
`lead-route`, `module-forwarding` carry the variant cases. The brief's ten
scenarios map to `lead.integration.test.ts` (one line per variant; qty ≤ 0,
foreign and inactive variants refused; totals and `linesWithoutWeight`;
conversion keeps variant/code/weight; a later weight edit leaves the order
alone) and `product-variants.integration.test.ts` (the set rules). `npm run
verify` is the gate: green on 2026-09-19 — 117 files / 1459 tests.

## 6. Live walk-through (the reviewer's checklist)

On the dev machine (`.env` → `order_book_new`, PostgreSQL 18):

1. Settings → Developer → unlock → *Load the Swisware catalogue* → 12 / 251 /
   549 / 0; press again → 0 / 0 / 0 / 251.
2. Office → Catalogue: categories as chips, DAMRU shows *N variants*, every
   row *weight missing*; *Missing weight* filter lists everything. Edit DAMRU →
   enter weights on Vitrosa 41 and 42 → save.
3. Office → New lead → type "toilet" → only *ONE PIECE TOILET* offered → pick →
   type "102" → the row shows code 102 → pick → qty 10 → line weight is
   10 × weight (or *weight missing*). Change category → *ONE PIECE BASIN* →
   DAMRU → Vitrosa 41 ×5, Vitrosa 42 ×3 → *Add product* → two lines, footer
   total weight, no *lines without weight* for these two.
4. Save → Lead detail shows both lines with weights → convert → Order detail
   shows code · product · variant · qty · line weight.
5. Edit Vitrosa 41's weight on the product → the order's line is unchanged.
6. Master → Inventory: one row per variant, codes read-only, min/max inline.

## 6a. What the walk-through found (2026-09-19, isolated `order_book_variants` DB, ports 4110/4210)

All six steps passed on the build after these fixes, which the same session made:

- **A lead raised on a party created from the lead screen was refused** by the
  Master ("The selected party no longer exists"): the lead's payload names the
  party by its temporary id and only a mutation's own `entityId` was resolved
  through `id_map`. Pre-existing, not from this restructure, but the first
  thing the walk-through hit. `lead.service.ts` now resolves `partyId` on
  create and update; `sync.integration.test.ts` covers the two-push order.
- **The Master's Stock-in/Physical-count product select listed the first 100
  products** (`api.products()` is one page), so DAMRU at position 57-by-id but
  past the page by name was unreachable. It is now a search box over the
  `product` pick endpoint, so any catalogue size works.
- The draft card's six-column variant grid overflowed the form column and hid
  the variant name; the weight-pill columns clipped "weight missing"; a few
  strings still said boxes, colours or tiles (`Rate / box`, `by colour`,
  `each colour`, the sample-data blurb, the product search's label).

## 7. Left open

- Weights: the catalogue's 549 variants land blank; entering them is the
  administrator's job, helped by the *Missing weight* filter.
- Slug codes (`HEXA-URINAL`, `DAMRU-WHITE`, …) for the catalogue's uncoded
  items are placeholders to be replaced with the real codes on the product
  form.
- The public API's stock summaries are by variant; a consumer of `/api/v1`
  written against `productCode` needs the `variants[]` shape.
