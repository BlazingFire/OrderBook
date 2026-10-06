# Product import and export — the file format and its versions

What a person puts in a spreadsheet to add or change sub products in bulk, and what
the Products screens hand back. The columns are `IMPORT_COLUMNS` in
`master/src/domain/product-import.ts`; the import, export and template are
`master/src/services/product-import.service.ts`; the wire types, limits and the
format version are `shared/src/domain/product-import.ts`. Party files have their
own document, `docs/PARTY_IMPORT_FORMAT.md`.

## The promise (R20, 1.4)

A product file written by **any shipped version** (the newest at the time of writing is
1.2.5; there was never a 1.2.6) imports into 1.4 with no loss; a 1.4 export imports
into 1.4 and reads as unchanged; a 1.4 export with the optional columns left off
imports too; and the other way round, a 1.2.5 Master reads a 1.4 export, because the
columns did not move. Nothing a newer version needs is *required* of an older file.

| Direction | Holds because |
|---|---|
| 1.2.5 file → 1.4 | The ten template columns are the ones 1.2.5 wrote, in the same order (`git diff 5ed91cc` of `master/src/domain/product-import.ts` is empty). A header is matched by name, not position. |
| 1.4 export → 1.4 | The export is the template's own columns; an upsert of an unedited export reports every row `unchanged`. |
| 1.4 export → 1.2.5 | Same columns; the format marker lives in the workbook's Subject, which no reader looks at. A CSV carries no marker at all. |
| Old stock columns | Stock left in 1.4 (R15). A column the importer does not know (`Stock`, `On hand`, `Reserved`, `Free to sell`, or anything else) is **ignored and named**: `ignoredColumns` in the result, shown in the preview ("Ignored columns: …"). It is never an error. |

## The columns

Header row, in template order. Matching ignores case, spaces and punctuation, and
knows trade aliases (`SKU`, `Model`, `Colour`, `Weight`, …; see `HEADER_ALIASES`).

| Column | Required | Notes |
|---|---|---|
| Brand | no | With Main product, makes the pair that names a product. |
| Main product code | no | Names the main product by its code (`OPT`). The code never creates a product: it must exist already. |
| Main product | **yes**, unless the code is filled | Created if absent, when the company allows it (`catalog.importCreatesCategories`). |
| Sub product | **yes** | The printed name, `102` or `DAMRU`. |
| Size | no | |
| Colour rule | no | `fixed`, `dedicated` or `multicolour`. |
| Colour | no | The colour of a `fixed` sub product. |
| Code | **yes** | The sub product software code, unique across the catalogue. |
| Weight (kg) | no | Blank until known. |
| Alias | no | |

The required set is exactly what 1.2.5 required; `product-import-compat.integration.test.ts`
pins it, so adding a required column fails the build.

## Versions

`PRODUCT_FORMAT_VERSION` in `shared/src/domain/product-import.ts` is the format a
1.4 Master writes.

| Version | Written by | Marker |
|---|---|---|
| 1 | 1.2.x and 1.3 | none |
| 2 | 1.4 | `.xlsx`: the workbook's Subject property reads `OrderBook products format 2`. `.csv`: nothing (a CSV has no place for one) |

The marker is optional on the way in. The importer reads it and answers
`formatVersion` in the result (`null` for a file with no marker), so a screen or a
log can say which format arrived. It does not change how the file is read, because
no column changed. **Raise the number only when a column's meaning changes**, and
then add the reader for the old meaning before the writer for the new one.

## Tests and fixtures

- `master/tests/product-import-compat.integration.test.ts` — the promise above.
- `master/tests/fixtures/products-export-1.2.5.csv` / `.xlsx` — files in the 1.2.5
  layout (BOM and CRLF for the CSV, a text-formatted Code column and numeric
  weights for the workbook). They are hand-built to that layout, not exported by a
  1.2.5 Master; the header literal in the test is the contract.
- `master/tests/fixtures/products-export-1.2.5-with-stock.csv` — the same file with
  four stock columns added by hand.
- `master/tests/product-import-roundtrip.integration.test.ts`,
  `product-import.integration.test.ts`, `product-import-domain.test.ts` — the
  catalogue-wide round trip and the row-level rules.
