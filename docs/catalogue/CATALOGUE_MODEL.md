# Catalogue model v2 on the 1.2 product master — Brand → Product → Sub product

Design for the owner's 2026-09-28 catalogue restructure, **ported onto main's
1.2 product master** (category → model → variant, no money; stock was removed in 1.4).
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
  numeric one in **Code** (right). The PDF comes back as a fixed-layout lead PDF
  — no designer, no templates (the PDF Designer stays removed).
- Port onto main; keep everything main has (1.2.0, the settings, the Master
  Parties screen, no money, variants).

## 1. Terms and storage

| Owner's term | Stored as | Example |
|---|---|---|
| Brand | option list `product.brand` (value = label = brand name) + `product_categories.brand` | `Swisware+` |
| Product | `product_categories` row | `One Piece Toilet` (code `OPT`) |
| Product code | `product_categories.code` — alphanumeric, unique per tenant among live rows | `OPT` |
| Sub product | a `products` row (a "model") with **exactly one variant**; its printed identifier is `products.name` | `102`, `1111`, `MAGENTA` |
| Sub product software code | that variant's `product_variants.code` (already tenant-unique) | `OPT-0001` |
| Size | `products.size` | `L-27, B-15, H-26` |
| Catalogue order | `product_categories.sort_order`, `products.sort_order` | |

**A product's name never shows its code (1.4, R14).** `OPT` is the Product code: it has its own column and field and still finds the product when typed in a search, but every list, picker, chip, line subtitle, log entry and refusal names the product as `One Piece Toilet` (plus its brand where a picker needs it). The one composer is `productLabel(name, brand?)` in `ui/src/catalogueSummary.ts` (the Office re-exports it) and `categoryLabel` in `master/src/services/catalog.service.ts`; `ui/tests/product-label.test.ts` fails if a screen passes a code to it. This applies to every product code, not only OPT.

UI wording: **Product** = the category, **Sub product** = the model. Code
identifiers stay (`category*`, `product*`, `variant*`); nothing is renamed.

Brand is an option-list value (add, rename the label, remove to the Recycle
Bin, activity log, sync — all existing). The trim deleted the old
`product.brand` list and the `products.brand` column; brand now lives on the
category and is read through it. No copy on `products`.

## 2. Colour rules — derived, no column

| Rule | Stored as | Line colour | Shown |
|---|---|---|---|
| `fixed` | `has_variants = true`, one variant whose `label` is the colour (White, Black, Magenta, Rustic Coffee Brown) | none (the variant label is the colour) | yes, except when the label only repeats the sub-product name (`MAGENTA` / `Magenta`) |
| `dedicated` | `has_variants = false`, one variant with `label` NULL, `multi_colour = false` | none | never |
| `selectable` ("multicolour") | `multi_colour = true`, `has_variants = false`, one variant with `label` NULL | the chosen colour from `stock.colour` | yes |

`colourRuleOf(product)` in `shared/src/domain/colour-rule.ts` derives it:
`multiColour ? 'selectable' : variants[0]?.label ? 'fixed' : 'dedicated'`, plus
`isNumericSubProduct`, `subProductCells` (Model/Code split) and the "colour
repeats the name" helper. No sentinel colour value.

- **Several colours with a quantity each** = several `line_items` rows on the
  same variant, one per colour. No schema change; screens and the PDF group them.
- **The Master coerces, never refuses:** a colour sent for a product that is not
  multi-colour is dropped (`colour = null`) instead of `LineColourError` — a
  queued offline lead must not bounce on it. This amends HANDOFF decision 15.
- The colour range (catalogue page 2: 16 colours + 5 rustic, with hex) is the
  `stock.colour` list; the loader upserts it.

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
3. `SHIPPED` in `migration-registry.test.ts` gains every name up to and
   including these two.

## 4. Catalogue data and loading

- `master/src/domain/catalogue-markdown.ts` — strict parser of the markdown
  file (brands table, colour range with hex, `### CODE — Name` product blocks
  with `- Brand:` and `| # | Sub product | Size | Colour rule | Colour |`),
  refusing malformed input with a line number. Replaces
  `master/src/domain/swisware-catalogue.ts` (deleted).
- `catalogue-seed.service.ts` → `loadCatalogue(parsed, actor, { replace })`, one
  transaction: upsert brand values and colours (hex, reactivate), products =
  categories with code/brand/sort order, sub products = one-variant models with
  `CODE-0001…` codes in catalogue order, `sort_order`, size, rule per §2,
  weights NULL. Additive mode (the `/api/developer/load-catalogue` route,
  `seed:catalogue`) skips what exists; `replace` (reload) first clears the
  catalogue-dependent data only.
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
  clash inside the category → `ConflictError`; a blank variant code → next
  `CODE-####` for that category. Since 2026-10-09 the bulk import keeps the same
  name rule (`validation.product.nameTaken`) for a create, a rename or a move,
  checked against where every sub product ends up, so two names a file swaps
  both land; twins made before that stay editable. A product backup restore
  reads a sub product under codes the catalogue lacks as the one of that name in
  its main product, recoded (`docs/PRODUCT_IMPORT_FORMAT.md`).
- Picks: `category` matches code prefix, name substring or brand, exact code
  first, then `sort_order`; rows carry `code`, `brand`. `product` with
  `categoryId` returns **every** live sub product of that category in
  `sort_order` order (limit raised; `PICK_MAX_LIMIT` ≥ 200), rows carry size,
  `multiColour`, `hasVariants`, variants.
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
- **Import and export** (`product-import.service.ts`; one handler set, `productImportRoutes`,
  serves the Master session route `/api/products/…` and the paired-panel route `/api/panel/products/…`;
  the Office's `/api/products/…` proxies the latter byte for byte, query string included).
  - *Format.* One header row, in this order, written identically by the template, the Sub product export
    and read by the import: **Brand, Main product code, Main product, Sub product, Size, Colour rule,
    Colour, Code, Weight (kg), Alias** (`IMPORT_HEADERS`). Headers match ignoring case, spaces and
    punctuation, and the field keys (`categoryName`, `name`, `variant`, `code`, `weightKg`…) and trade
    words (`SKU`, `Model`, `Colour`) still read. `GET …/export.:format?level=main` writes the Main
    product list instead (Brand, Main product code, Main product, Sub products) — not importable.
  - *Round trip.* An export re-imported unedited changes nothing: `upsert` reports every row `unchanged`
    (new `unchanged` count; not `updated`), `create` reports every row skipped as existing. Rows are
    folded into the product only for cells the sheet fills — a blank Alias or Weight leaves the stored
    value alone, it cannot clear it. A deactivated variant (history still quotes it) is neither exported
    nor revived by an upsert; Recycle Bin products are neither exported nor matched.
  - *Reading.* CSV is parsed in `lib/spreadsheet.ts` (not by exceljs): UTF-8 with or without BOM, UTF-16
    "Unicode Text", Windows-1252; comma, semicolon or tab; CRLF/LF; quoted commas, quotes and line
    breaks; blank lines keep their row number so reported rows match Excel. The export's formula-guard
    apostrophe (`'=…`, `'-…`) is removed on read. Every cell is text — `0012` and `18x12` are never
    coerced; Excel number cells become their digits, dates `YYYY-MM-DD`; a Guide sheet in front of the
    data is skipped. Weights accept `18.5`, `1,200.50`, `12,5` and `12.5 kg`; `0x10`/`1e3`
    are refused. Since 2026-10-09 a lone comma is the decimal mark whatever the digits after it (`0,125`,
    `1,125` and `1,200` are 0.125, 1.125 and 1.2 kg — a piece's weight), and `1.234,5` reads as 1234.5.
    Inner whitespace in names is folded to one space (codes are left as typed; a product backup restore
    keeps every cell as written).
  - *Matching.* Brand, Main product, Sub product and Colour match case-insensitively. A listed brand or
    colour takes the list's own spelling; an unlisted colour stays as typed; an unlisted brand is a new
    brand and, on a real import, is added to the Brands list in the same transaction.
  - *Limits and errors.* 50 MB (`validation.import.tooLarge`, 400, both panels) and 20,000 data rows
    (`validation.import.tooManyRows`); the issue list is cut at 1,000 (`issuesTruncated`). Every issue
    carries the spreadsheet row, the header as written and a `messageKey`. Two models of one file
    resolving to one existing product → the later is refused (`validation.import.sameProduct`).
  - *Atomicity.* A bad row never half-imports: rows are validated first, a model (all its rows) is
    inserted or not at all, in chunks of 500 products per transaction; a chunk that fails is replayed
    model by model, so one clash costs one model. Valid rows of a file with bad rows do import — the
    report names the rest. One `imported` activity row (count, file, mode, created, updated) and one
    `catalog` change event per real import; none for a dry run or an all-unchanged upsert.
  - *Permissions.* Template and import need `products.bulk` (+ `products.create`; `upsert` also
    `products.edit`); **export needs only `products.view`**. The panel route runs as the signed-in person
    when an acting token is presented, else as the panel's own role.
  - *Files.* Export names are dated: `products-YYYY-MM-DD.csv|xlsx`, `main-products-YYYY-MM-DD.csv|xlsx`
    (the PC's date); the template stays `products-template.csv|xlsx`. CSV exports start with a BOM so
    Excel opens non-ASCII names correctly.
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
   colour or variants (a swatch for colour-named ones) and weight, under a count
   and column header; **Collapse** shrinks it to one short line a row (kept per PC).
6. **Colour / quantity** — `fixed`: colour shown locked + qty; `dedicated`: qty
   only; `selectable`: colour-range list, several colours each with a qty.
   Packaging and grade sit beside each qty, the same box each; grade is
   optional, packaging required only while the company requires it.
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

- Model = the sub product when not purely numeric; Code = the sub product when
  purely numeric (right-aligned). Exactly one is filled.
- Colour: nothing for dedicated; the fixed colour unless it repeats the name;
  multicolour lines of one sub product are grouped as `White ×10, Ivory ×5`.
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
