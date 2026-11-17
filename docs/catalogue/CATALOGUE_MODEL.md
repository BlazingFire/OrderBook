# Catalogue model v2 on the 1.2 product master — Brand → Product → Sub product

Design for the owner's 2026-09-28 catalogue restructure, **ported onto main's
1.2 product master** (category → model → variant, no money; stock was removed in 1.4).
**Amended 2026-11-17:** the variant layer is removed — a sub product carries its
own code, weight, colours and print side (see §2 and `GLOSSARY.md`); the
`product_variants` table stays only as a dormant record of pre-removal lines.
The data lives in [`master/assets/catalogue/swisware-plus-2026.md`](../../master/assets/catalogue/swisware-plus-2026.md)
(shipped with the Master so the `/api/developer/load-catalogue` route can load it in an installed copy; no screen calls it since 5a32106).

The owner's request, in short: load the SWISWARE 2026 catalogue as Brand →
Product → Sub product, allow more than one brand, give every product a software
code, apply the catalogue's colour rules, rebuild lead entry around a product
bar and a sub-product bar, manage lead sources and the default follow-up from a
Leads settings tab, and make a lead PDF follow the same model.

Owner answers this rests on (2026-09-28):

- Double-colour ranges (Diamond / Lauret / Sofiya / Silver / Micra …): the sub
  product *is* the colour; no second colour picker.
- Multicolour products (Orissa Pan, Water Closet): one lead may carry several
  colours of the same sub product, each with its own quantity.
- Numbered designer sub products (1111, 41, 7511 …): no colour is shown
  anywhere.
- Lead PDF: an alphanumeric sub product prints in **Model** (left), a purely
  numeric one in **Code** (right) — unless the sub product sets its own print
  side (2026-11-17, §2).
- Port onto main; keep everything main has (1.2.0, the settings, the Master
  Parties screen, no money).

## 1. Terms and storage

| Owner's term | Stored as | Example |
|---|---|---|
| Brand | option list `product.brand` (value = label = brand name) + `product_categories.brand` | `Swisware+` |
| Product | `product_categories` row | `One Piece Toilet` (code `OPT`) |
| Product code | `product_categories.code` — alphanumeric, unique per tenant among live rows | `OPT` |
| Sub product | a `products` row | `102`, `1111`, `MAGENTA` |
| Sub product software code | `products.code` (tenant-unique among live rows) | `OPT-0001` |
| Size | `products.size` | `L-27, B-15, H-26` |
| Colours offered | `products.colours` — a JSON array of `stock.colour` values (§2) | `["White","Ivory"]` |
| Print side | `products.print_side` — `default`, `left` or `right` | `default` |
| Catalogue order | `product_categories.sort_order`, `products.sort_order` | |

**A product's name never shows its code (1.4, R14).** `OPT` is the Product code: it has its own column and field and still finds the product when typed in a search, but every list, picker, chip, line subtitle, log entry and refusal names the product as `One Piece Toilet` (plus its brand where a picker needs it). The one composer is `productLabel(name, brand?)` in `ui/src/catalogueSummary.ts` (the Office re-exports it) and `categoryLabel` in `master/src/services/catalog.service.ts`; `ui/tests/product-label.test.ts` fails if a screen passes a code to it. This applies to every product code, not only OPT.

UI wording: **Product** = the category, **Sub product** = the model. Code
identifiers stay (`category*`, `product*`); the `variant*` vocabulary went with
the variant layer (2026-11-17) — a line's legacy `variantId` / `variantLabel`
remain only so a pre-removal line still reads and prints.

Brand is an option-list value (add, rename the label, remove to the Recycle
Bin, activity log, sync — all existing). The trim deleted the old
`product.brand` list and the `products.brand` column; brand now lives on the
category and is read through it. No copy on `products`.

## 2. Colours and print side — columns on the sub product (2026-11-17)

The rule is no longer derived: a sub product **stores the colours it is offered
in** (`products.colours`) and **where it prints** (`products.print_side`).

| `products.colours` | Line colour | Shown |
|---|---|---|
| none (designer pieces like `1111`, accessories) | null | never |
| one (White, Black, Magenta, Rustic Coffee Brown) | that colour always | yes, except when it only repeats the sub-product name (`MAGENTA` / `Magenta`) |
| several ("every colour" — Orissa Pan, Water Closet) | the one chosen per line from the sub product's own list | yes |

`shared/src/domain/colour-rule.ts` is the one deep module for this behaviour:
`resolveLineColour(colours, chosen)` picks a line's colour (0/1/several),
`printSideOf(name, setting)` resolves `default` / `left` / `right` (a purely
numeric name prints right, anything else left, so a catalogue nobody has
re-sided prints exactly as it always did), `normalizeColours`, `subProductCells`
(the Model/Code split) and the "colour repeats the name" helpers. `colourRuleOf`
and the `fixed` / `dedicated` / `selectable` vocabulary are gone — nothing may
re-derive a rule from columns.

`printSideOf` gives the side; a **line freezes its resolved side at add time**
(`line_items.print_side`), so re-siding a sub product never reprints history.
Lines written before the setting have `print_side` NULL and resolve by name.

- **Several colours with a quantity each** = several `line_items` rows on the
  same sub product, one per colour. No schema change; screens and the PDF group them.
- **The Master coerces, never refuses:** a colour sent for a sub product that
  offers none is dropped (`colour = null`) instead of `LineColourError` — a
  queued offline lead must not bounce on it. A *chosen* colour of a
  several-colours sub product that is not on its list is refused readably.
- The colour range (catalogue page 2: 16 colours + 5 rustic, with hex) is the
  `stock.colour` list; the loader upserts it. The colours copied onto the 13
  former multicolour sub products are the list's values on the day of the
  removal, not a live reference to it.

## 3. Schema

Never edit a shipped migration.

1. `20260323000000_catalogue_brands_and_codes` — **same name, no-op body.**
   A stale checkout of this repository ran a real migration with this name on
   the owner's PC database; knex refuses to boot a database whose
   `knex_migrations` names a file the registry lacks. Its real body cannot run
   on 1.2 (it touches `products.colour_policy`, which 1.2 dropped). The
   `panel_app_version` precedent: keep the name, do nothing. Registered in
   timestamp order next to `20260323000000_product_variants`.
2. `20260326000000_catalogue_brands_and_codes_port` — **additive, idempotent**,
   appended after `20260325000000_line_item_grade` and pinned in
   `DELIBERATELY_LAST`. It brings a fresh database, a 1.2 database and the stale
   one to the same schema:
   - `product_categories`: `code TEXT`, `brand TEXT`, `sort_order INTEGER`,
     `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `deleted_at TIMESTAMPTZ`;
     unique `idx_categories_brand_name (tenant_id, lower(coalesce(brand,'')),
     lower(name)) WHERE deleted_at IS NULL`, then `DROP INDEX IF EXISTS
     idx_categories_name_tenant`; unique `idx_categories_code (tenant_id,
     lower(code)) WHERE code IS NOT NULL AND deleted_at IS NULL`.
   - `products.sort_order INTEGER`.
   - `line_items.brand_name TEXT`, `line_items.category_code TEXT` (snapshots
     beside `category_name`).
   - No data, no DROP COLUMN / DELETE / TRUNCATE (the additive guard).
4. `20261116000000_sub_product_code_colours_print_side` — **additive,
   idempotent** (2026-11-17). `products.code TEXT`, `weight_kg NUMERIC(10,3)`,
   `colours JSONB NOT NULL DEFAULT '[]'`, `print_side TEXT NOT NULL DEFAULT
   'default'` with its CHECK, unique `idx_products_code_tenant (tenant_id,
   lower(code)) WHERE code IS NOT NULL AND deleted_at IS NULL`; `line_items.print_side
   TEXT` plus its CHECK and `variant_id` dropped from NOT NULL (the FK stays, for
   the lines that quote one). Backfilled from each sub product's first variant —
   a former multicolour one takes the tenant's live `stock.colour` values, a
   several-variant one keeps every label as a colour, every row prints `default`.
   `products_search_refresh()` is rewritten to read the product's own code and
   colours and the `product_variants` search trigger is dropped. `product_variants`
   itself is left in place, dormant (`docs/schema/02-parties-and-products.md`).
5. `SHIPPED` in `migration-registry.test.ts` gains every name up to and
   including these.

## 4. Catalogue data and loading

- `master/src/domain/catalogue-markdown.ts` — strict parser of the markdown
  file (brands table, colour range with hex, `### CODE — Name` product blocks
  with `- Brand:` and `| # | Sub product | Size | Colours | Print side |`),
  refusing malformed input with a line number. Replaces
  `master/src/domain/swisware-catalogue.ts` (deleted). `All` in the Colours
  column means the whole colour range (§2), expanded at parse time.
- `catalogue-seed.service.ts` → `loadCatalogue(parsed, actor, { replace })`, one
  transaction: upsert brand values and colours (hex, reactivate), products =
  categories with code/brand/sort order, sub products carrying their own code
  (`CODE-0001…` in catalogue order), sort order, size, colours and print side
  per §2, weights NULL. Additive mode (the `/api/developer/load-catalogue` route,
  `seed:catalogue`) skips what exists and never reuses a binned code; `replace`
  (reload) first clears the catalogue-dependent data only.
- `npm run reload:catalog` — parse, refuse while another connection to the
  database is open (stop the Master first), warn to drain Office outboxes,
  `loadCatalogue({replace:true})`. Deletes leads, orders, lines, party variants,
  any rows left in the retired stock tables (for FK safety), product images, products and
  categories; **keeps parties, users, roles, settings, option lists and the
  activity log**; one `catalog.reloaded` activity row.
- `npm run seed:demo-parties` — adds 13 demo dealers, wipes nothing, skips a
  name already on the books. `wipe:business` and `seed:parties` unchanged.
- `sample-data` resolves products by (category code, sub-product name) or the
  new codes.

## 5. Master services and transport

- Category (Product) CRUD: list (with sub-product count, brand/search filter,
  sort order), create, update (name, code, brand, sort order), delete (soft;
  refused with `ConflictError` while live sub products exist), restore via the
  Recycle Bin. Activity `product_category.created|updated|deleted|restored`
  with `{field:{from,to}}` on update; `publishChange('product_category')`. REST
  `/api/categories`, socket `category:*`, Office forwards online-only (list falls
  back to `snapshot.categories` offline).
- Sub product create/update: category by id, then `categoryCode`, then (brand,
  name) — never silently creates a category when a code was given; a live name
  clash inside the category → `ConflictError`; a blank code → next `CODE-####`
  for that category, a typed code that another live sub product holds →
  `error.conflict.productCodeTaken` (the partial unique index is the
  enforcement). Colours and print side are ordinary columns; `validateProductInput`
  (`shared/src/domain/product-validation.ts`) is the one validator for the
  service and the offline merge. Since 2026-10-09 the bulk import keeps the same
  name rule (`validation.product.nameTaken`) for a create, a rename or a move,
  checked against where every sub product ends up, so two names a file swaps
  both land; twins made before that stay editable. A product backup restore
  reads a sub product under codes the catalogue lacks as the one of that name in
  its main product, recoded (`docs/PRODUCT_IMPORT_FORMAT.md`).
- Picks: `category` matches code prefix, name substring or brand, exact code
  first, then `sort_order`; rows carry `code`, `brand`. `product` with
  `categoryId` returns **every** live sub product of that category in
  `sort_order` order (limit raised; `PICK_MAX_LIMIT` ≥ 200), rows carry the
  whole sub product — its code, weight, `colours` and `printSide` — so the
  entry screen needs no second round trip.
- **The Master's own Products module** (parity plan P4, 2026-10-01): Products /
  Sub products / Brands over the same routes — `GET /api/products` (limit up to
  2000), `/api/categories` CRUD, `/api/products/:id/images…` for photos — plus
  two the Master gained for a signed-in user: the **import** (`GET
  /api/products/import/template.:format`, `POST /api/products/import`, the
  `productImportRoutes` handlers the panel path also uses; `products.bulk` is
  checked by the service) and the **photo files** (`/uploads/images/:id/:variant`,
  the same permission-checked router as `/api/images`, 404 for a product the
  caller may not see). The screens are the `ui/` ports `SubProductsScreen`,
  `MainProductsScreen`, `BrandsScreen`, `ProductDetail`, `ProductDrawer`,
  `ProductImages`, `ProductImportModal`.
- **Import and export** — *removed 2026-11-05 (`bb8d0326`)*: the product sheet
  import/export and the product backup zip are no longer in the software. The
  format is kept as the record in `docs/PRODUCT_IMPORT_FORMAT.md`; the Rust
  sheet-importer (`rust/crates/orderbook-core/src/import.rs`) went with it on
  2026-11-17. Whole-software backup/restore and the bulk Photo import stayed.
  The Sub product export that remains is the plain sheet
  (`GET …/export.:format`, `products.view`). The removed importer's own rules
  (format, round trip, reading, matching, limits, atomicity) are kept in
  `docs/PRODUCT_IMPORT_FORMAT.md`; the columns an old file meets are **Brand,
  Main product code, Main product, Sub product, Size, Colour rule, Colour,
  Code, Weight (kg), Alias**.
- Snapshot and list caps rise so 549+ sub products reach
  panels complete.
- Settings: main's existing `leads.followUpDefaultDays` — **fallback 3**
  (was 0), range kept. `leads.packagingRequiredOnConvert` fallback **false**
  (lead entry no longer asks for packaging). Office panels may write
  `leads.followUpDefaultDays` only, through `PUT /api/settings/:key` → socket
  `settings:save`, as the signed-in user only (refused for the panel's own role
  actor); the Master still enforces `settings.manage`.

## 6. Lead entry (`ui/LeadEntryScreen`, a port of the Office `AddLeadScreen`; both panels mount it — the Master since 2026-10-01 as New / Edit pending order)

1. **Party** — typeahead; the list appears only once something is typed.
2. **Source** — active `lead.sourcePlatform` values; the free-text "Other" path
   is removed (the Master refuses unlisted sources).
3. **Follow-up** — today + `followUpDefaultDays` (3), re-seeded when the setting
   changes and after a save; quick chips stay.
4. **Product bar** — product name or code; rows `CODE · Name · Brand`.
5. **Sub product bar** — every sub product of the product in catalogue order,
   filtered as you type; rows show the photo, code, printed name with its size,
   colour (a swatch) and weight, under a count and column header; **Collapse**
   shrinks it to one short line a row (kept per PC).
6. **Colour / quantity** — no colours: qty only; one: colour shown locked + qty;
   several: a dropdown of *that sub product's* colours, several colours each
   with a qty. Packaging and grade sit beside each qty, the same box each;
   grade is optional, packaging required only while the company requires it.
7. **Enter** walks colour → qty → packaging → grade, row by row, each pick list
   open as the walk reaches it (2026-10-08), then lands on **Add sub product**,
   whose Enter adds the sub product and returns to the sub-product bar. **Shift+Q** or **Complete sub product** adds a pending valid sub product
   and moves to the product bar; with nothing pending and an empty sub-product
   box it just finishes the product. A capital Q still types anywhere else.
8. **Ctrl+Enter** opens a review when the lead is ready; Ctrl+Enter again saves;
   one save only (guarded against key repeat). The form resets after a save.

## 7. Inventory (Master screen)

Removed in 1.4 (stock and inventory).

## 8. Lead PDF (fixed layout, no designer)

`GET /api/leads/:id/pdf` (permission `leads.export`), forwarded by the Office.
Built with the existing report-table renderer extended to wrap text cells.
Company header, party block, then:
`# | [Brand] | Main product | Model | Size | Colour | Code | Qty`.

- Model = the sub product when it prints on the left; Code = the sub product
  when it prints on the right (right-aligned). Exactly one is filled. The side
  is the line's frozen `printSide`; a line from before the setting resolves by
  the Default rule (a purely numeric name → Code).
- Colour: nothing when the sub product offers none; its one colour unless it
  repeats the name; several colours of one sub product are grouped as
  `White ×10, Ivory ×5`, printed in the order the lines hold them.
- Left-aligned cells wrap and grow the row; figures stay on one line.
- Brand only when the lines span more than one brand. No money anywhere.
- **Preview PDF** on the Master leads list and the Office lead detail; the
  Electron shell allows that one same-origin URL to open a PDF window.

### PDF window allowlist

The desktop shell opens no window of its own except a PDF one, and that window
gets the PDF viewer (`plugins: true`), so the rule is exact paths, tested in
`electron/tests/lead-pdf.test.ts` (`isPdfWindowUrl` in `electron/lib/lead-pdf.ts`):

- **A lead's PDF:** `<origin>/api/leads/<id>/pdf`, matching
  `^/api/leads/[^/?#]+/pdf$`, **no query**.
- **A final order's PDF** (2026-10-25, the order record's third button):
  `<origin>/api/orders/<id>/pdf`, matching `^/api/orders/[^/?#]+/pdf$`,
  **no query**.
- **A report's PDF** (1.3, Preview PDF on Reports): `<origin>/api/reports/<kind>/pdf`,
  `<kind>` one of the 15 report ids, matching `^/api/reports/(<the 15>)/pdf$`.
  The query is parsed with `URLSearchParams` and may hold only `period`,
  `fromMonth`, `toMonth`, `fromDate`, `toDate`, `subjectId`, `limit`, `columns`,
  `totals`, `paperSize`, `orientation`, `lang`, each at most once, each value
  `[A-Za-z0-9._,:+-]` after decoding. `format` is not allowed: the route is a PDF
  whatever it is asked.
- **No fragment, ever.** Another origin, a look-alike host (`localhost:4100.evil`),
  a longer or nested path, the `/export` route and an unknown report id are refused.

All three routes answer `application/pdf` with `Content-Disposition: inline`, so a
query cannot turn the window into anything else. A LAN browser opens the same
links in a new tab. The report route needs `reports.view` and `reports.export`
and applies the export's subject rule and Party Access
(`GET /api/reports/:report/pdf`, proxied by the Office, online-only).

## 9. Change log

Activity rows for: brand values (existing `option_list_item.*`), products
(`product_category.*`), sub products (`product.*` naming the product, with
diffs), `catalog.reloaded`, settings (existing).
