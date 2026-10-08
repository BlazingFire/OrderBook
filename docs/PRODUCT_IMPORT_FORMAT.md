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

## The product backup zip (2026-10-08)

One file for the whole catalogue, photos included, that a person can open, edit and put
back; the Master works out what changed. **Products → Sub products → Backup products
(.zip)** writes it (`products.view` + `products.export`); **Restore from .zip** reads it
(`products.bulk` + `products.create` + `products.edit`). Master only: the Office has
neither button. Code: `master/src/services/product-zip.service.ts`; wire types:
`ProductZipReport` and `ProductRestoreJob` in `shared/src/domain/product-import.ts`.
It is also what a build can ship as the catalogue of a new install (`release
--catalogue`, `docs/UPDATES.md`).

### What is in it

`OrderBook-Products-<company>-<YYYY-MM-DD>.zip`:

| Entry | What it is |
|---|---|
| `products.csv` | The sub product export above (`level=sub`): the ten template columns, one row per live variant, catalogue order, UTF-8 with a BOM. The import reads it as an **upsert** |
| `main-products.csv` | `Brand, Main product code, Main product, Order`: every main product, `Order` being its place in the catalogue (1, 2, …) |
| `colours.csv` | `Colour, Hex`: the colours in use, with their hex (`#1A2B3C`) |
| `images/<CODE>.webp`, `images/<CODE>_<N>.webp` | Every product photo, as the stored `master.webp`, byte for byte. `CODE` is photo 1 (the main photo) and `CODE_N` photo N, in gallery order. `CODE` is the code of the variant whose colour the photo's caption names, else the sub product's first code — the name the bulk photo import reads back (§11.13 of `docs/STRUCTURE.md`) |
| `README.txt` | The same rules in plain English, for whoever opens the zip |

Brands are not a file of their own: they come from the `Brand` columns.

### Editing it

- Change a cell to change that value. The `Code` is how a row finds its sub product,
  so a changed code reads as a new sub product.
- A new row with a new `Code` adds a sub product. A new main product code in
  `products.csv` (with its name in `Main product`) is created too; listing it in
  `main-products.csv` as well sets its order.
- A main product is renamed, or its brand changed, in `main-products.csv` (a code
  listed there wins over what `products.csv` says about it).
- A photo is replaced by a file with the same name (`OPT-0001.jpg` replaces
  `OPT-0001.webp`; delete the old file, or the two are duplicates and one is left out);
  `OPT-0001_2.jpg` adds photo 2. jpg, jpeg, png and webp are read.
- Excel can turn a size like `10-12` into a date and drop leading zeros: check those
  cells and save as **CSV UTF-8**.

### Reading it back

Entries are found by their name, wherever they sit: a zip of the unpacked folder (with
the folder inside it) reads the same, and so does one written by PowerShell's
`Compress-Archive` with backslashes in its names. An absolute or climbing (`..`) name
refuses the whole zip (`validation.productZip.entryRejected`), as does a file that is no
zip, a zip with no `products.csv`, or one with two `products.csv` (or two of either other
CSV). Photos are the files
in a folder named `images`; anything else is not looked at.

The preview is the restore run as a dry run, so what it lists is what Apply does:

1. **Main products** — a code no live main product has, whose brand and name do not
   match one either, is **added** with its code, brand and order; one whose name or
   brand differs is **renamed** (through the ordinary edit, its checks and its event).
2. **Colours** — a value the list lacks, or has binned or switched off, is added; a
   different hex is a change (`catalog.lists.manage`).
3. **Sub products** — `products.csv` through the upsert import: rows added, rows
   changed with each changed cell old → new, rows unchanged, the row problems. A new
   row takes its place in the file as its catalogue order.
4. **Photos** — compared by sha256 with the photo's stored checksum: the same is
   **unchanged**, any other **replaced**, an empty slot **new**; also listed, files
   that match no code, duplicates and files that are no image. A replaced photo keeps
   its slot.
5. **Missing** — sub products none of whose codes are in `products.csv`, and photos of
   the file's sub products with no file, are **listed only**. Two opt-ins, both off,
   act on them: *Move sub products missing from the file to the Recycle Bin* (the
   ordinary delete, so it can be undone; `products.delete`) and *Remove photos missing
   from the zip* (deleted; a photo cannot be restored). A zip carrying only
   `products.csv` therefore never removes a photo unless asked.

The real run is a job on the Master (minutes for a few hundred new photos, each
encoded like an upload), followed by the dialog's progress bar; one runs at a time. It
writes one activity row and one catalogue change event.

**Photos are compared by their exact bytes.** A Master that restores a zip stores its
photos again through the image pipeline, so their bytes, and checksums, are its own:
take a new backup on that Master before editing again, or the old zip's photos read
as replaced there.

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
- `master/tests/product-zip.integration.test.ts` — the zip: an unedited export reads
  as unchanged, photos included; an edited cell, a swapped and an added photo are
  found and applied exactly; missing rows and photos are only reported unless opted
  in; an emptied catalogue comes back whole; top folders and backslash names; the
  refusals; the job; the routes.
