# Product CSV import — and the 500-product ceiling that has to be lifted with it

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** **L. Be honest about this one** — the import parser is the small half.
Do not start it before the two blocking bugs and
`office-write-refusal-visibility.md` have landed; it depends on both.

Owner's item 6: *"Import option for product through csv file"*.

> ## Scope decisions — recorded 2026-09-06, implemented by Claude in the same session
>
> The owner widened the ask to *"bulk product from CSV or Excel, a blank
> CSV/Excel template to download and upload back, a solid UI, unlimited
> product add support"*, and asked for the implementation here rather than by
> handoff. Decisions, in the order the brief asked for them:
>
> 1. **Full scope on the ceiling.** The Office catalogue is a server-paged
>    list over `product:list` when the Master is reachable and a page of the
>    cached snapshot (labelled "cached page") when it is not. `SNAPSHOT_LIMIT`
>    and `PAGING.maxLimit` stay at 500: the snapshot is the offline working set
>    and is pushed whole to every browser on every sync event, so it must not
>    grow with the catalogue. The Add Lead code entry and paste resolve codes
>    past the snapshot through the picker endpoint.
> 2. **The import runs on the Master**, uploaded from the Office through the
>    panel-authenticated HTTP surface (the product-photo path). **Online-only**
>    — 503 `unavailable` offline, and the dialog says so. Nothing is queued: the
>    outbox rewrites its file per mutation and its rejection buffer is replaced
>    per flush, so a bulk import through it would be quadratic on disk and
>    silent on refusal.
> 3. **Excel via `exceljs` 4.4.0**, a `master` dependency (pure JS, no install
>    scripts). It reads `.xlsx` and `.csv` and writes the styled template
>    (frozen header, text format on the code columns, dropdowns on the closed
>    sets, a Guide sheet). SheetJS stays rejected.
> 4. **Two modes.** *Skip them* (default): a row whose code already exists is
>    reported as skipped, so re-uploading a corrected file is idempotent.
>    *Update them*: the row updates the existing product by code, stamping only
>    the touched fields' clocks; needs `products.edit` on top of `products.bulk`.
> 5. **One `catalog` change event per import**, not one per row. It is
>    snapshot-forcing, so every connected panel refreshes once (debounced);
>    a reconnecting panel gets a snapshot because the event is not replayable.
> 6. **Template headers are the wire field keys** (`productCode`, `name`, …),
>    language-neutral and exact on the way back; the matcher also accepts the
>    form's labels and trade shorthand. **Prices are rupees in the sheet**,
>    paise in the database, the same conversion the Add Product form makes.
> 7. A money column the person may not set is **refused per row and named**,
>    never silently dropped — the public API's `WRITE_GUARDS` reasoning.
>
> Per-row reporting lives in the importer, where the row numbers are —
> `office-write-refusal-visibility.md` item 4 is answered that way.

## What exists today

There is **no import of anything, anywhere**. There is one CSV **export** — the
Party Access assignment table (`master/src/services/party-access.service.ts:197-224`,
reached from both panels, with `forwardCsv` on the Office side). That is the
existing precedent for CSV handling in this codebase; match its shape.

## The blocker that has to be scoped with the feature, not after it

**The Office catalogue cannot display more than 500 products.**

```
master/src/services/snapshot.service.ts:35   SNAPSHOT_LIMIT = 500
master/src/services/catalog.service.ts:53    PAGING = { defaultLimit: 100, maxLimit: 500 }   ← hard ceiling
office/web/src/screens/CatalogScreen.tsx:103-114   view.products.filter(...)   ← client-side, no paging, no server search
```

The Office panel's catalogue **is** the sync snapshot: one unpaginated page,
capped at 500 rows. Every product write to date is one product typed by a
person, so the cap has never been reached. **A CSV import is the first feature
whose entire purpose is to exceed it.**

Import 600 rows and all 600 validate, queue, push, and are created correctly in
PostgreSQL. The next snapshot returns the first 500; the other 100 exist in the
database and appear nowhere in the Office panel — not in the catalogue, not in
search, not in the product picker when adding a lead line. Because the Office
panel is the only place products are managed today (the Master has no catalog
screen — see `add-master-party-screen.md`), those 100 products are unreachable
from any UI. Separately, `productsComplete` flips false and the panel silently
stops pruning its cached product images (`office/src/http/app.ts:1873`).

**So there are two honest scopes. Pick one and write it here:**

- **Full:** give the Office catalogue a server-backed, paged list — go through
  `masterConnection.command('product:list', …)` (already declared,
  `shared/src/protocol/socket.ts:477`) when online, snapshot as the offline
  fallback, and page it; `CatalogScreen` already has the search and filter state
  to drive it. Raise or remove `PAGING.maxLimit` for the paged path.
- **Truthful small:** hard-cap the importer at 500 rows total (file rows +
  existing `view.products.length`) and refuse with a token that says exactly
  why. A small feature that tells the truth beats a large one with a silent data
  black hole.

## The importer itself

**Where to parse.** The Office panel is a thin client with no database. Follow
the path product images and avatars already use for panel-originated files
(upload to the Office local server, forward to the Master) rather than inventing
a third pattern — read those routes before deciding. If parsing lands in the
browser instead, the file never leaves the machine and each row becomes an
ordinary queued mutation, which composes with the existing offline story; say
which you chose and why.

**Column mapping.** Derive it from `shared/src/domain/entities.ts` `Product`
and the backend's `validateProductInput` — required versus optional must come
from the validator and the NOT NULL columns, not from taste.

**Permission.** Note that `products.export` and `products.bulk` are already
declared in the frozen permission catalogue and enforced **nowhere**. Use
`products.bulk` rather than minting a new key, and make it actually enforced.

**Per-row error reporting.** A 500-row file with 3 bad rows must say which 3.
Do **not** depend on the global rejection buffer for this: `lastRejections` is
replaced, not accumulated, on every flush
(`office/src/sync/sync.service.ts:99`), and with a batch size of 100
(`office/src/config/index.ts:110`) a 500-row import loses four batches out of
five. The importer should keep its own `mutationId → source row number` map from
the 202 responses (`office/src/http/app.ts:1358` already returns `mutationId`)
and match `MutationResult.error` / `missingPermission`
(`shared/src/sync/mutations.ts:120-129`) back to row numbers itself.

**Offline.** Decide whether a bulk import may queue at all. Two things argue
against it: the outbox rewrites its **entire file on every single mutation**, so
a bulk import is quadratic in disk writes; and a large import floods the
Master's 2000-entry change ring, which can force every *other* panel into a full
snapshot rebuild. Refusing to import while offline is a legitimate, defensible
answer — write down whichever you pick.

**Limits.** Check the multer limits already configured before adding another.

## Done looks like

- Scope decision recorded at the top of this file before implementation starts.
- `npm run verify` green.
- **New tests:** a valid file imports; a file with 3 bad rows reports exactly
  those 3 row numbers; the row cap (or the paged catalogue) behaves as chosen.
- **Manually verified** with a real supplier file of at least 600 rows, and
  confirm every imported product is findable in the catalogue *and* in the Add
  Lead product picker.

---
*Implementer: append what changed and what you verified below this line.*

## Implemented — 2026-09-06 (Claude)

**Shared.** `ProductListQuery` / `ProductListPage` (optional `productTypes`
facet) in `shared/src/domain/inputs.ts`; new `shared/src/domain/product-import.ts`
(result and issue types, `MAX_PRODUCT_IMPORT_BYTES` 50 MiB,
`MAX_PRODUCT_IMPORT_ISSUES` 1000, the two modes); `ChangedEntity` gains
`'catalog'`, listed in `SNAPSHOT_FORCING_ENTITIES`; `product:list` typed with
the new query and page. Tokens: `activity.catalog.imported`,
`validation.import.*`, `import.*`, `catalog.products.{import,loadMore,shown,cachedPage,loadFailed}`,
`error.conflict.barcodeTaken`, `import.skip.codeExists`,
`lead.add.products.lookingUp` — all with real Hindi.

**Master.** `master/src/lib/spreadsheet.ts` (exceljs: read either format as
strings, indexed by spreadsheet row; write the template);
`master/src/domain/product-import.ts` (pure: column spec, header matching
with aliases, row parsing with rupees→paise, enum synonyms, per-row permission
refusals, in-file duplicate detection, the Guide rows);
`master/src/services/product-import.service.ts` (`productImportTemplate`,
`importProducts` — `products.bulk` + `products.create` (+ `products.edit` for
upsert); chunks of 500 rows per transaction with one HLC, one id block, one
category pass and one multi-row INSERT; a failing chunk replays row by row
through the single-row repository path and classifies the pg error per row;
one `recordActivity` catalog/imported and one `catalog` `publishChange`);
`product.repository.ts` gains `nextProductCodes`, `findLiveByCodes`,
`findLiveBarcodes`, `ensureCategories`, `insertProductRows`, and `listProducts`
gains the `productType` filter, the facet and `product_type` in the search;
`panel-catalog.routes.ts` mounted at `/api/panel` (`GET
/products/import/template.:format`, `POST /products/import` with `dryRun` and
`mode` fields); `fan-out.ts` gates `catalog` on `products.view`.

**Office server.** `GET /api/products` (forwards `product:list`; offline pages
the cached, re-masked view through `listProductsFromView` in
`offline-pick.ts` and answers `offline: true`); `GET
/api/products/import/template.:format` and `POST /api/products/import`
proxied to the Master with `masterFetch`, 503 `unavailable` when it is off.

**Office web.** `CatalogScreen` products tab is server-paged: debounced
search, type chips from the facet, "Load more", "Showing N of M", a
cached-page pill offline, pending (unacknowledged) rows on top, snapshot
overlay for queued edits, refetch on a fingerprint of `view.products` only.
New `ProductImportModal` (templates → drop zone → preview with sample rows and
a virtualised problems table → import → result), opened from an Import button
gated on `products.bulk` (`App.tsx` passes `canImport`). `AddLeadScreen`'s
code entry and paste resolve unknown codes through `api.pick`. Icons `upload`
and `download`.

**Tests.** Pure: `master/tests/product-import-domain.test.ts`,
`master/tests/spreadsheet.test.ts`, `office/tests/offline-pick.test.ts`
(catalogue page), `office/tests/module-forwarding.test.ts` (paged list online
and offline, import 503/400). Integration:
`master/tests/product-import.integration.test.ts` (valid file; exactly the bad
rows named; idempotent re-upload; upsert stamps only touched clocks; barcode
clash; in-file duplicate; permissions; per-row money refusal; dry run predicts
the real run and writes nothing; file-level refusals; chunk fallback on a
clash the pre-check missed; **1200-row import paged fully with the facet**;
both templates), `master/tests/panel-catalog-route.integration.test.ts`
(401/403/400 paths, both templates, dry run then import as the signed-in
person). `catalog.integration.test.ts` covers the type filter and facet.
`change-ring.test.ts` lists the new entity; `activity-tokens.lock.json` gains
the token.

**Verified.** `npm run lint`, `npm run typecheck`, `npm run test` run
separately, each exit 0, integration suites against the embedded PostgreSQL.

**Known limits.** The offline snapshot still holds 500 products (offline
picker, palette search and `PartyDetail` see a page and say so;
`productsComplete=false` keeps the image-cache sweep off — pre-existing). The
catalogue's stock column reads `view.stock`, itself a 500-row page, so a
product past it shows no stock chips until inventory is paged the same way.
Generated codes burn sequence numbers on a dry run (display strings; the
single-product path already burns one per failed attempt). One HLC per chunk.
CSV is parsed with a comma delimiter only.

**Fixture.** `dummy-data/products-5000.{json,csv,xlsx}` (untracked) — the
CSV and XLSX carry prices in rupees, the JSON in paise.

**Note (2026-09-07):** this implementation was lost once to an uncommitted
working-tree reset between sessions and had to be rebuilt from scratch
line-for-line. It is now committed to `main` — see the commit for the full
file list.
