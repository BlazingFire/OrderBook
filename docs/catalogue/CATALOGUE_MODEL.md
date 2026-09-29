# Catalogue model v2 on the 1.2 product master — Brand → Product → Sub product

Design for the owner's 2026-09-28 catalogue restructure, **ported onto main's
1.2 product master** (category → model → variant, per-variant stock, no money).
The data lives in [`master/assets/catalogue/swisware-plus-2026.md`](../../master/assets/catalogue/swisware-plus-2026.md)
(shipped with the Master so the Developer tab can load it in an installed copy).

The owner's request, in short: load the SWISWARE 2026 catalogue as Brand →
Product → Sub product, allow more than one brand, give every product a software
code, apply the catalogue's colour rules, rebuild lead entry around a product
bar and a sub-product bar, manage lead sources and the default follow-up from a
Leads settings tab, and make inventory and a lead PDF follow the same model.

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
| Product | `product_categories` row | `OPT — One Piece Toilet` |
| Product code | `product_categories.code` — alphanumeric, unique per tenant among live rows | `OPT` |
| Sub product | a `products` row (a "model") with **exactly one variant**; its printed identifier is `products.name` | `102 (9")`, `1111`, `MAGENTA` |
| Sub product software code | that variant's `product_variants.code` (already tenant-unique) | `OPT-0001` |
| Size | `products.size` | `L-27, B-15, H-26` |
| Catalogue order | `product_categories.sort_order`, `products.sort_order` | |

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
- Stock stays per variant (a multicolour sub product has one stock row, not
  one per colour).
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
  weights NULL. Additive mode (Settings → Developer → Load catalogue,
  `seed:catalogue`) skips what exists; `replace` (reload) first clears the
  catalogue-dependent data only.
- `npm run reload:catalog` — parse, refuse while another connection to the
  database is open (stop the Master first), warn to drain Office outboxes,
  `loadCatalogue({replace:true})`. Deletes leads, orders, lines, stock,
  movements, reservations, party variants, product images, products and
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
  `CODE-####` for that category.
- Picks: `category` matches code prefix, name substring or brand, exact code
  first, then `sort_order`; rows carry `code`, `brand`. `product` with
  `categoryId` returns **every** live sub product of that category in
  `sort_order` order (limit raised; `PICK_MAX_LIMIT` ≥ 200), rows carry size,
  `multiColour`, `hasVariants`, variants.
- Snapshot and list caps rise so 549+ sub products and their stock rows reach
  panels complete.
- Settings: main's existing `leads.followUpDefaultDays` — **fallback 3**
  (was 0), range kept. `leads.packagingRequiredOnConvert` fallback **false**
  (lead entry no longer asks for packaging). Office panels may write
  `leads.followUpDefaultDays` only, through `PUT /api/settings/:key` → socket
  `settings:save`, as the signed-in user only (refused for the panel's own role
  actor); the Master still enforces `settings.manage`.

## 6. Lead entry (Office `AddLeadScreen`; the Master keeps no New lead page)

1. **Party** — typeahead; the list appears only once something is typed.
2. **Source** — active `lead.sourcePlatform` values; the free-text "Other" path
   is removed (the Master refuses unlisted sources).
3. **Follow-up** — today + `followUpDefaultDays` (3), re-seeded when the setting
   changes and after a save; quick chips stay.
4. **Product bar** — product name or code; rows `CODE · Name · Brand`.
5. **Sub product bar** — every sub product of the product in catalogue order,
   filtered as you type; rows show the printed name, size, and a swatch for
   colour-named ones.
6. **Colour / quantity** — `fixed`: colour shown locked + qty; `dedicated`: qty
   only; `selectable`: colour-range list, several colours each with a qty.
   Grade stays optional and out of the Enter path; packaging shows only when
   the company requires it.
7. **Enter** on the last qty adds the sub product and returns to the sub-product
   bar. **Shift+Q** or **Complete sub product** adds a pending valid sub product
   and moves to the product bar; with nothing pending and an empty sub-product
   box it just finishes the product. A capital Q still types anywhere else.
8. **Ctrl+Enter** opens a review when the lead is ready; Ctrl+Enter again saves;
   one save only (guarded against key repeat). The form resets after a save.

## 7. Inventory (Master screen)

Rows: Brand, Product (`CODE · Name`), Sub product, Size, Colour (the fixed
colour; blank for dedicated and multicolour), Code, on hand / reserved / free,
reorder, status. **Every live variant is listed**, stocked or not; deleted or
inactive products never; the dashboard low count uses the same rule. Filters:
search (also brand and product code), brand chips, product filter, low only.
Stock-in / count: product bar → sub-product bar → the variant.

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

## 9. Change log

Activity rows for: brand values (existing `option_list_item.*`), products
(`product_category.*`), sub products (`product.*` naming the product, with
diffs), `catalog.reloaded`, settings (existing).
