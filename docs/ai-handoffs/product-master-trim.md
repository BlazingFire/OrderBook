# Product master trim, pricing removed, multi-colour lines

**Owner:** Claude (implemented 2026-09-21, on `main`).
**Reviewer:** the owner, by the walk-through in §6.
**Size:** XL — a data-model change that touches every screen that names a
product, and the removal of a whole feature (pricing).

The owner's brief, given in the session that extracted the Swisware 2026
catalogue into a spreadsheet: *only these fields for a product are required* —
`product_categories` (name), `products` (name, category, alias, size),
`product_variants` (code, colour, weight), `product_images` — *add a multi
colour field* so a lead line on such a product can name another colour, and
*remove other fields completely from backend, frontend and database*. Three
questions were put back and answered (§2).

## 1. What changed

- **`products`** keeps `name`, `category_id`, `alias`, `size`, `has_variants`,
  `custom_fields` and the plumbing (`is_active`, sync columns, `search_vector`,
  recycle-bin columns, timestamps), and gains **`multi_colour`** (boolean, not
  null, default false). Dropped: `sin`, `grade`, `product_type`, `brand`,
  `barcode`, `hsn_code`, `uom`, `rate`, `mrp`, `purchase_rate`, `gst_rate_pct`,
  `price_per_sqft`, the thirteen tile-era attributes (`finish`, `series`,
  `thickness_mm`, `pieces_per_box`, `box_coverage_sqft`, `shade`, `calibre`,
  `water_absorption_pct`, `pei_rating`, `edge_type`, `surface_texture`,
  `application`, `origin_plant`) and the free-form `parameters` bag.
- **`product_variants`** is unchanged: `code`, `label` (the colour or pattern
  — "Colour" on every screen now), `weight_kg`. The owner's "color" is the
  existing `label` column; renaming it would have touched the sync, the
  offline store and the search trigger for no behavioural gain, and the
  column also holds patterns (`Vitrosa 41`).
- **`line_items`** loses `rate`, `line_total`, `sin`, `grade`, `product_type`
  and gains **`colour`** (text, nullable): the colour chosen on a multi-colour
  line, frozen like the rest of the snapshot and copied onto the order.
- **`leads.total_amount`**, **`orders.total_amount`** and
  **`party_product_variants.rate`** (plus its `sin`/`grade`/`product_type`)
  are dropped. A party-wise record is now the party's own *name*, alias, size
  and packaging suggestion for a model.
- **Pricing is gone whole**: the `pricing.enabled` setting, the four
  `field.*Rate.*` permissions and the `pricing` capability group, the
  Master's `pricing-gate.ts`, the field-level masking in `shared/src/domain/
  visibility.ts` and `master/src/domain/visibility.ts`, the money columns on
  reports and their exports, the `rupees_to_paise` / `paise_passthrough`
  connector transforms, `formatMoney` in the UI kit, and every rate control on
  the New lead screen (rate origin, the rate switch, `rateUnset`).
- **Option lists**: `product.productType`, `product.brand`, `product.shade`,
  `product.surfaceTexture`, `product.originPlant` and `line.grade` no longer
  exist; `stock.colour` is now *the company's colour list* — what a variant's
  colour is suggested from, and what a multi-colour line picks from.
- **Import template**: `categoryName`, `name`, `variant`, `code`, `weightKg`,
  `alias`, `size`, `multiColour` (yes/no). `Dimensions`, `All colours`,
  `Model`, `Colour`, `SKU`, `Weight` still match as headers.
- **The catalogue seed** marks the sections the catalogue prints under
  "ALL COLOURS AVAILABLE IN ALL ITEMS" (`WATER CLOSET`, `PLAIN SET`,
  `URINAL`, `ORISSA PAN`) as `multiColour`; `productType`, `brand` and `uom`
  are no longer set. The sample dataset carries no prices; four of its demo
  lines carry a colour.

## 2. Decisions taken with the owner (2026-09-21)

1. **Remove pricing completely**, not just the catalogue price: line rates,
   party-wise rates, lead/order totals, the switch, the permissions and money
   in reports all go. The software carries no amounts anywhere.
2. **Keep custom fields for products.** `custom_fields` stays as the one
   extension point; Settings → Fields still offers the product entity.
3. **A multi-colour line picks its colour from the colour list in Settings**
   (`stock.colour`, seeded with the catalogue's nineteen colours), not from a
   free-text field. The New lead card shows a native select over the list;
   blank means the variant's own colour.

## 3. Design choices made here

- **A colour is a line attribute, not a stock key.** Stock stays per variant;
  a multi-colour line reserves and dispatches the variant it names. This is
  the choice the variant restructure made for patterns, applied to colours.
- **One colour per draft card.** The card that picks a model carries one
  colour, copied onto every line it adds; the same model in a second colour is
  the card added again. Two draft rows of one variant in two colours are two
  lines pointing at one variant.
- **The Master refuses a colour on a product that is not made in colours**
  (`validation.lead.colourUnexpected`, from `LineColourError` in
  `domain/line-items.ts`). It does not check the colour against the option
  list: the list is a vocabulary the UI enforces, and an offline lead raised
  with a colour an administrator has since removed must still land.
- **Search**: `products_search_refresh()` reads name, the variants' codes and
  labels, alias and size; `line_items_search_refresh()` reads the chosen
  colour beside the variant label. Both functions are redefined *before* the
  columns they used to read are dropped.
- **Role rows are cleaned, not just the catalogue**: the migration strips the
  four rate keys from every stored role the way the Designer drop did, with
  the key list frozen in the migration.
- **Reports** rank the top parties by order count only; `orderedBy` and
  `ratesIncluded` are gone from the wire.

## 4. Files (the map, not the diff)

- Migration `master/src/db/migrations/20260324000000_product_master_trim.ts`
  (+ registry, pinned last with the Designer drop; idempotent on
  `products.rate`; `down()` throws).
- `shared/src/domain/{entities,inputs,columns,product-validation,permissions,
  settings,fields,reports,connectors}.ts`; `shared/src/domain/visibility.ts`
  deleted; `shared/src/i18n/{en,hi}.ts` (81 keys removed, 20 added).
- Master — `domain/{line-items,product-import,sample-data,swisware-catalogue,
  connector-mapping}.ts`; `domain/visibility.ts` and
  `services/pricing-gate.ts` deleted; `services/{catalog,lead,order,report,
  search,snapshot,sync,auth,role,panel,connector-run,connector-scheduler,
  product-import,catalogue-seed,sample-data,company-features,
  connector-profiles}.ts`; `repositories/{mappers,product,product-variant,
  party-variant,line-item,lead,order,report,inventory,field-usage}.ts`;
  `http/routes/{public-api,access}.routes.ts`, `http/middleware/
  require-api-key.ts`.
- Office server — `http/app.ts` (no snapshot re-masking; `SNAPSHOT_POLICY`
  has no `mask-rates`), `sync/local-store.ts`, `services/offline-pick.ts`.
- Office web — `components/{ProductDrawer,ProductImportModal}.tsx`,
  `screens/{AddLeadScreen,CatalogScreen,ProductDetail,LeadDetail,
  LeadBoardScreen,OrderBoardScreen,DashboardScreen,PartyDetail}.tsx`,
  `localSearch.ts`, `App.tsx`.
- Master web — `screens/{ReportsScreen,LeadsOrdersScreen,
  IntegrationsScreen}.tsx`, `App.tsx`.
- UI kit — `format.ts` (`formatMoney` removed), `PermissionGrid.tsx`.

## 5. Tests

New: `migration-product-master-trim.integration.test.ts` (columns, the
search functions, idempotency, role and option-list clean-up);
`line-items-domain.test.ts` and `lead.integration.test.ts` carry the colour
rule (kept on a multi-colour product, refused elsewhere, carried onto the
order). Removed: `pricing-gate.integration.test.ts`; the rate/masking
scenarios of `permissions`, `public-api`, `pick`, `reports`, `product-import`,
`product-attributes`, `sync`, `partial-patch`, `mappers`, `outbox`,
`lead-route`, `connector-mapping`, `connector-import`;
`office/tests/snapshot-masking.test.ts` became `snapshot-for-user.test.ts`
(the key-set guard and the permissions replacement stay).

## 6. Live walk-through (the reviewer's checklist)

On the dev machine (`.env` → `order_book_new`, PostgreSQL 18):

1. Start the Master: the migration runs (the log names
   `20260324000000_product_master_trim`). Settings → Developer → *Load the
   Swisware catalogue* → 12 / 251 / 549 / 0.
2. Office → Catalogue → *New product*: name, category, alias, size, the
   variants switch, the *Made in every colour?* switch, photos — and nothing
   else. Save one with the colour switch on; the list shows an *Any colour*
   pill.
3. Office → New lead → pick *WATER CLOSET* › *E.W.C - S TRAP* → the card
   shows *Colour* beside *Packaging*, listing the colour list; pick *Ivory*,
   qty 10 → the line reads `EWC-S-TRAP · E.W.C - S TRAP · Ivory`. Pick *ONE
   PIECE TOILET* › *102* → no colour field. Save.
4. Lead detail, Order detail (after convert) and Master → Leads & orders show
   the colour beside the variant; nothing shows a rate or an amount anywhere.
5. Settings → Access → a role's grid has no *Pricing* group; Settings has no
   *Show rates and amounts* switch; Settings → Fields lists Source platform,
   Colours and Packaging only.
6. Office → Catalogue → *Import* → download the template: eight columns, with
   a yes/no dropdown on `multiColour`.
