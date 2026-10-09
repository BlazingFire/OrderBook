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
| Colour | no | The colour of the row's code. A `fixed` sub product has one; a sub product with several colours has one row per colour, a `multicolour` one too (the form allows both, and the export writes them since 2026-10-09). Ignored for `dedicated`. |
| Code | **yes** | The sub product software code, unique across the catalogue. |
| Weight (kg) | no | Blank until known. A dot or a lone comma is the decimal mark, whatever the digits after it: `0,125`, `1,125` and `1,200` are 0.125, 1.125 and 1.2 kg (a piece's weight, kept to three decimals). `1,200.50` reads as 1200.5 and `1.234,5` as 1234.5; `12.5 kg` reads; `0x10` and `1e3` are refused. |
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

## The product backup zip (2026-10-08; restore rebuilt 2026-10-09)

One file for the whole catalogue, photos included, that a person can open, edit and put
back; the Master works out what changed. **Products → Sub products → Backup products
(.zip)** writes it (`products.view` + `products.export`); **Restore from .zip** reads it
(`products.bulk` + `products.create` + `products.edit`; the opt-ins below ask for more).
Master only: the Office has neither button. Code: `master/src/services/product-zip.service.ts`,
which sends `products.csv` through `importProducts` with `restore`
(`master/src/services/product-import.service.ts`); wire types: `ProductZipReport`,
`ProductRestoreOptions` and `ProductRestoreJob` in `shared/src/domain/product-import.ts`.
It is also what a build can ship as the catalogue of a new install (`release
--catalogue`, `docs/UPDATES.md`).

**What a restore promises.** The file is a backup of the stored catalogue, not a sheet a
person typed, so a restore puts back what it holds as it holds it: names, sizes,
aliases, weights, colour rules, every colour and code, the main products' codes, brands
and Order, the colour and brand lists, photos, their captions and their order. An
unedited backup restored over the catalogue it came from reads as nothing to do, and
restoring the same zip a second time changes nothing. A file combined from two installs'
backups restores as one catalogue: a sub product the catalogue already holds under other
codes is matched by its name, never created a second time. Onto a new install, **Make the catalogue exactly this file** leaves
nothing of the shipped catalogue beside it.

### What is in it

`OrderBook-Products-<company>-<YYYY-MM-DD>.zip`:

| Entry | What it is |
|---|---|
| `products.csv` | The sub product export above (`level=sub`): the ten template columns, one row per live code (a sub product with three colours is three rows), catalogue order, UTF-8 with a BOM |
| `main-products.csv` | `Brand, Main product code, Main product, Order`: every main product, one with no sub product too. `Order` is the stored Order, blank when it has none (a blank lists after the numbered ones, by name); not a 1, 2, … position |
| `colours.csv` | `Colour, Label, Hex, Active`: the whole colour list in its order, switched-off colours included (`Active` is `yes` or `no`) |
| `brands.csv` | `Brand, Label, Active`: the whole Brands list in its order, switched-off and unused brands included |
| `photos.csv` | `File, Caption`: the caption of each photo in `images/`, by its file name |
| `images/<CODE>.webp`, `images/<CODE>_<N>.webp` | Every product photo, as the stored `master.webp`, byte for byte. `CODE` is photo 1 (the main photo) and `CODE_N` photo N, in gallery order. `CODE` is the code of the variant whose colour the photo's caption names, else the sub product's first code — the name the bulk photo import reads back (§11.13 of `docs/STRUCTURE.md`). A character no file name can hold (`/ \ : * ? " < > \|`, and `%` itself) is written as `%` and its two hex digits: `SW/101` is `SW%2F101.webp`, read back as `SW/101` |
| `README.txt` | The same rules in plain English, for whoever opens the zip; it also lists any photo left out (below) |

Two values of one list can share a sequence number (a delete and then an add on the
Fields screen leave one); they are listed oldest first, here and on every screen
(`listOptionsForKey` orders by sequence, created_at, id).

Photo N whose `CODE_N` is another sub product's code (with `OPT-0002` and `OPT-0002_2`
both in use, `OPT-0002_2.webp` is the latter's photo 1) goes out under the sub product's
next live code instead. It is left out, and listed in the README under NOT IN THIS ZIP,
only when no name would bring it back to its own sub product: its sub product has no
live code, or every name it could take is another sub product's code — always the case
for a sub product with one code. A photo whose `master.webp` is missing when the backup
is taken is listed there too, "(its file is missing)". A restore leaves such a photo as
it is, and never lists it as missing.

### Older files it reads

- **A bare products sheet**, `.csv` or `.xlsx`: the Products export of 1.2.4–1.4.6
  (`products-YYYY-MM-DD.csv|xlsx`, and 1.2.4's `products.csv`) or a filled-in import
  template. It is read as a zip holding only `products.csv`, so it says nothing about
  main products' Order, colours, brands or photos, and those stay as they are.
- **Inside a zip**, `products-YYYY-MM-DD.(csv|xlsx)` and `main-products-YYYY-MM-DD.(csv|xlsx)`
  are read when the exact names are missing: the files those versions downloaded,
  zipped as they were. The 1.2.5–1.4.6 main products export has no `Order` column (its
  `Sub products` column is not read).
- **A `colours.csv` of only `Colour, Hex`** (the first build of the zip, never released)
  reads as it did: a blank hex leaves the colour's own, and every colour it lists is
  switched on.

An upload whose first bytes are `PK` is opened as a zip (an empty zip too, which is then
refused as having no `products.csv`); anything else is read as a sheet. An `.xlsx` is a
zip itself, and is told apart by its `[Content_Types].xml` with no products file beside
it.

### Editing it

- Change a cell to change that value; empty an Alias, Size or Weight cell to clear it.
  Leave the `Code` column as it is: the code is how a row finds its sub product.
- A new row with a new `Code` adds a sub product, where the file lists it. A new main
  product code in `products.csv` (with its name in `Main product`) is created too.
- A main product is renamed, recoded, given another brand or another Order in
  `main-products.csv`. A code listed there wins over what `products.csv` says about it,
  and the preview lists a `Main product` or `Brand` cell of `products.csv` that
  disagrees (`validation.productZip.mainDiffers`). Without a `Brand` column every brand
  stays as it is, and an empty `Brand` cell clears that one; without an `Order` column
  every Order stays as it is.
- `colours.csv` and `brands.csv` are those lists: change a Label, a Hex or Active there,
  or the order of the rows. A blank Label is the value itself.
- A photo is replaced by a file with the same name (`OPT-0001.jpg` replaces
  `OPT-0001.webp`; delete the old file, or the two are duplicates and one is left out);
  `OPT-0001_2.jpg` adds photo 2; a caption is changed in `photos.csv`. jpg, jpeg, png
  and webp are read.
- Excel can turn a size like `10-12` into a date and drop leading zeros: check those
  cells and save as **CSV UTF-8**.

### What a restore takes as the truth

`products.csv` is read as stored values (`importProducts` with `restore`,
`parseImportRow(…, { restore: true })`):

- **A cell is the value exactly**: its ends trimmed, its inner spacing kept (a double
  space, a line break, a non-breaking space), a colour in its own spelling, on the
  colour list or not.
- **A blank cell clears.** A blank Alias or Size clears the stored one, and so does a
  blank Weight (kg) when the file has that column.
- **Colours and the colour rule.** `dedicated` carries no colour; `fixed` its one;
  `multicolour` keeps the colours it is given. Whether a sub product has colours
  follows the file once the file names every live code of it, so a `fixed` one the file
  calls `dedicated` or `multicolour` becomes that, with no colour named "Standard";
  "Standard" names the unlabelled code only while codes the file does not name remain.
- **The rows of one sub product agree.** A row whose Sub product spelling, Size, Alias,
  Colour rule, Brand or Main product differs from the first row of the same sub product
  is a second sub product the file cannot tell apart from it, so it is reported
  (`validation.import.subProductCellsDiffer`) and not imported.
- **Order of sub products.** The rows' order is the catalogue order. A sub product the
  restore adds, brings back from the Recycle Bin or moves into a main product lands
  where the file lists it: after every one already there, it takes the numbers after the
  main product's last; otherwise the main product is renumbered 1..n in the file's order,
  the sub products the file does not name after them (`rows.reordered`). It is compared
  as an order, never as numbers, so an unedited export, gaps and blank orders included,
  changes nothing.
- **Order of main products.** With an `Order` column, each listed main product takes the
  file's Order (blank is none), listed as a change. With none (1.2.5–1.4.6), main
  products already there keep theirs, and new ones go after the highest, in file order.
  An Order that is not a whole number from 0 to 2147483647 is reported
  (`validation.category.sortOrder`) and read as no Order.
- **The colour and brand lists.** For each value `colours.csv` or `brands.csv` lists,
  matched case aside (an exact match first, the list's own spelling kept), the file wins:
  one the list lacks is added with its label, hex, Active and place; one in the Recycle
  Bin comes back; one there takes the file's label, hex and Active, each listed as
  `<value> — Label|Hex|Active`. When the values it lists stand in another order than
  the list's, the list is numbered in the file's order with the others after, listed
  once ("Put in the order of the file"); the decision is made on places, not sequence
  numbers. A value the file leaves out stays as it is (unless the catalogue is made
  exactly the file). A hex is stored as written and compared case aside. A file with no
  `Colour` (or `Color`) column, or no `Brand` column, is reported
  (`validation.import.missingColumn`) and read as no file at all. Changing either list
  needs `catalog.lists.manage`; a brand only a main product names is still added without
  it (`registerBrands`).
- **Brands on main products.** A restore puts back a main product's brand even when the
  Brands list holds it switched off (the screens still refuse such a brand). A brand
  `brands.csv` adds is written on the main products in `brands.csv`'s spelling. A brand
  that differs from one already on the install only in capital letters takes the
  install's spelling (an open owner question, `HANDOFF.md`).

### How a row finds what it already is

**Main products** (each `main-products.csv` row, and each main product code
`products.csv` names that `main-products.csv` does not list):

1. the live main product of its code;
2. else the live one of its brand and name that no other row names by code (for a row
   with no brand: a brandless one first, else the only one of that name), which takes
   the file's code, listed as "Main product code old → new";
3. else the one in the Recycle Bin under its code, brought back as the Bin's own
   Restore does (`catalog.restoreCategory`). That needs `products.delete`; without it
   the row is a problem (`validation.import.binnedNeedsDelete`). One that comes back
   under another brand first returns under its old one, so if that brand already has a
   live main product of the name it takes, it is refused
   (`error.conflict.restoreCollision`), in the preview as in the run;
4. else a new one, with its code, brand and Order.

Two rows naming one main product, by code or by brand and name, are reported
(`validation.productZip.mainDuplicate`) and only the first is read. A row with a code and
no name is reported (`validation.category.nameRequired`); that main product is left as
it is and counts as named. Renames, recodes, brand and Order changes are made one by one
in an order that never meets a clash; one that can never land (two main products that
swap names, or a name held by a main product the file leaves alone) is refused
(`error.conflict.categoryNameTaken` / `categoryCodeTaken`) in the preview and the run
alike. So is a new brandless main product whose name a live one holds under any brand.
Under **Make the catalogue exactly this file**, a name or code held by a main product the
run takes out before it writes is free (below, "How the exact run clears the way").

**Sub products** (the rows of `products.csv` grouped by main product and Sub product
name, case aside):

1. by code: the codes sit on one live sub product, which is that one (on two or more:
   `validation.import.codesSplit`);
2. else, a code only a sub product in the Recycle Bin carries: that sub product comes
   back from the Bin with all its codes, as the Bin's own Restore brings it
   (`rows.restoredFromBin`, counted as updated). It needs `products.delete`
   (`validation.import.binnedNeedsDelete` otherwise), and is refused
   (`validation.product.restoreCodesTaken`), in the preview too, when one of its codes is
   on another sub product now or on another row of the file. A refused one stays in the
   Bin, and no copy is made beside it;
3. else by name: the live sub product of that name in that main product, unless a row
   already names it by its own codes. It is updated with the file's rows, so one sub
   product numbered differently on two installs restores as one: a row whose colour a
   live code of it has takes that code over (recodes it), a row of another colour adds
   its code, and the live codes its rows leave out are kept and listed
   (`rows.variantsNotInFile`), as a code-matched sub product's are. Only **Make the
   catalogue exactly this file** removes them (since 2026-10-10; before, they were
   dropped with nothing ticked);
4. else a new one.

No two live sub products of one name in one main product (`docs/catalogue/CATALOGUE_MODEL.md`
§5): the import refuses a create, rename or move that would make two
(`validation.product.nameTaken`), checked against where every sub product ends up, so
two whose names the file swaps both land. **Twins** made before the import kept that
rule stay editable. Over the catalogue that has them, an unedited backup reads as
unchanged. Into a catalogue without them, a `dedicated` twin is reported as a duplicate
row, a twin with another Size, Alias or Colour rule as `subProductCellsDiffer`, and
coloured twins whose other cells are all the same come back as one sub product holding
both twins' colours (no code, colour or weight is lost; an open owner question). Run
Products → Duplicates before taking a backup.

### Photos

- **Matching, by content first.** A file under `images/` finds its sub product by name:
  a name that is itself a code is that code's photo 1, before any `_N` is read as a photo
  number (the bulk photo import reads names the same way). It is then matched by its
  sha256 against every photo of that sub product, in three passes: its own slot's photo,
  then any photo whose stored master is those bytes (`checksum`), then any photo made
  from those bytes (`source_checksum`). A match is unchanged and kept, at the zip's slot,
  whatever slot it holds now. Only a file that matches nothing is compared by slot: it
  replaces the photo in that slot (the replaced photo is deleted), or is added beside it
  when the slot is empty or another file already keeps or replaces that photo.
- **Order and main photo.** After the run each gallery is in the zip's order, the zip's
  photo 1 the main photo, photos the zip does not name after them. A sub product whose
  main photo or order the zip's differs from is listed ("Main photo or photo order put
  back", `photos.reordered`) and counts as a change, so a zip that differs only there can
  be applied.
- **Captions** come from `photos.csv`, found by the file name without its ending
  (`OPT-0001.jpg` put in for `OPT-0001.webp` takes the row for `OPT-0001.webp`). An
  uploaded photo takes it; a kept photo whose caption differs gets it back ("Caption put
  back from photos.csv", `photos.recaptioned`). A zip with no `photos.csv` captions as
  before: a photo matched through a colour's code takes that colour's label, else none.
- **Exact bytes, Master to Master.** A photo the product restore puts in that is a
  whole, unrotated, still, lossy WebP carrying no EXIF, ICC or XMP, ending where its RIFF
  payload ends and 2048 px or less on its long edge — a `master.webp` the pipeline wrote
  — is stored as the new `master.webp` byte for byte, the smaller sizes made from it. So
  a backup restored on another Master keeps its checksums there, and a backup of that
  Master reads as unchanged on the first. Only the product restore asks for this
  (`UploadImageRequest.keepWebpMaster`, passed by `runPhotos`; the shipped `products.zip`
  load is one): since 2026-10-10 a single upload, the bulk Photo import and the heal
  encode every file, such a WebP saved from anywhere else too. Any other file in a zip
  (a jpg, a png, a webp a person made) is encoded like every upload, and the row keeps
  the sha256 of the file it came from
  (`product_images.source_checksum`, migration `20261017000000`), so that file reads as
  unchanged the next time, on that Master. A photo uploaded before that migration has no
  source hash and matches only by its export. So does one cropped or rotated on screen:
  its stored picture is not what a restore would make from the file it came from, so that
  file in the zip reads as **replaced** and a restore puts the whole, unrotated picture in.
- **Missing photos.** A photo of a sub product the file names that no file in the zip is
  is listed (`photos.notInZip`), by the name it would have after the restore, behind the
  zip's photos. **A file with no photo at all** — a bare products sheet, or a zip of
  `products.csv` alone — says nothing about photos: nothing is listed as missing, neither
  opt-in can take a photo out, and the preview says the photos stay as they are
  (`photos.noFile`).

### What is missing, and the three opt-ins

Missing is reported, not removed. The preview lists sub products none of whose codes
`products.csv` names and that no row reads by name (`rows.notInFile`); codes of a sub
product the file names that its rows leave out (`rows.variantsNotInFile`; kept); photos
(`photos.notInZip`); main products neither CSV names that would hold no sub product
after the run (`mainProducts.notInFile`); and colours and brands the files do not list
(`colours.notInFile`, `brands.notInFile`). Three opt-ins, all off, act on them:

| Opt-in | Needs | What it takes out |
|---|---|---|
| *Move sub products missing from the file to the Recycle Bin* (`binMissingProducts`) | `products.delete` | the sub products in `rows.notInFile`, through the ordinary delete: **Recycle Bin**, so they can be brought back |
| *Remove photos missing from the zip* (`removeMissingPhotos`) | — | the photos in `photos.notInZip`: **removed for good**; a photo cannot be brought back |
| *Make the catalogue exactly this file* (`exactCatalogue`) | `products.delete`; `catalog.lists.manage` too when a colour or brand would be taken out | both of the above, and then, through the ordinary deletes: the main products in `mainProducts.notInFile` (one still holding a sub product, kept by a refused row, is refused and reported); the colours `colours.csv` does not list (switched off instead for a person without `fields.manage`, one already off then not listed; with no `colours.csv` it can read, the colours stay as they are, an open owner question); and the brands `brands.csv` does not list (with no `brands.csv`, the brands no remaining main product has, a main product `products.csv` names by name alone counting with its row's brand) — all to the **Recycle Bin**. The codes in `rows.variantsNotInFile` are **removed for good**: deleted, or switched off while history quotes one; never in the Recycle Bin |

The modal offers the third only to a person with `products.delete`; ticking it ticks and
locks the other two. When the preview says that person lacks `catalog.lists.manage` and
the option would take a colour or brand out (`exactNeedsLists`), it is shown switched
off with a note. With it, a photo in `images/` named by a code the option removes (a
colour row left out of `products.csv`) is kept or replaced as the preview listed it,
never removed unlisted. A bare 1.2.4–1.4.6 products sheet restored with it moves the
main products and sub products it does not name, and unused brands, to the Recycle Bin,
and leaves the colours and the photos as they are; under the box the modal says so, one
note for a file with no `colours.csv` (the colour list stays) and one for a file with no
photos (the photos stay).

**The preview takes the opt-ins** (since 2026-10-10). Ticking or unticking the third
reads the file again with it (the dialog says it is reading; the other two ticks are
kept, and a refused preview leaves the ticks and the list as they were), so with it
ticked the lists and counts are the exact run's: a sub product whose only change is
losing codes counts as changed, and what the run takes out first reads as gone. The
other two change nothing the preview lists. "Nothing is removed unless you tick it
below" is shown only where a box is; with none (no `products.delete` and no missing
photos) the dialog says that nothing is removed, offering no tick.

### How the exact run clears the way

Under **Make the catalogue exactly this file** a name or a code the file gives one thing
may be held by another the same run takes out. So the exact run first does a dry run of
the import, which tells it which live sub products the file reads, and then, before it
writes anything else, moves to the Recycle Bin the sub products it takes out
(`rows.notInFile`) and the main products no row of either file names whose sub products
all go with them (`clearedFirst`): none has a code in the file (a switched-off one
included, which the import still reads) or is quoted by a live lead or order. Only
then does it write the lists, the main products, the rows and the photos, and last the
rest of what it takes out: the main products the rows emptied (one whose first bin was
refused is tried again), brands, colours and photos. A main product renamed onto the name
of one the file leaves out (`categoryNameTaken` before), or a sub product renamed onto
the name of one the file leaves out (`nameTaken` before), lands in one run, and a second
run changes nothing. The exact preview reads those names as free the same way
(`restore.leaving`), except one a live lead or order quotes: the ordinary delete refuses
that sub product, so its name stays taken, in the preview as in the run.

**Known limit.** A main product the file leaves out whose sub products the file moves to
other main products is not empty until the rows are written, so it is binned only at the
end. A main product renamed onto its name is refused on the first run (the preview says
so too) and lands on a second run of the same file (an open owner question, `HANDOFF.md`).

### Refusals and problems

Refused as a whole, before anything is written:

- a file over 1 GB (`validation.productZip.tooLarge`), or a products sheet over 50 MB
  (`validation.import.tooLarge`);
- a file starting `PK` that cannot be opened as a zip (`validation.productZip.notAZip`);
  a file that is no zip is read as a sheet, and refused by its missing columns;
- an entry with an absolute or climbing (`..`) name (`validation.productZip.entryRejected`);
- no `products.csv` (`validation.productZip.noProductsCsv`), two of it or of another
  fixed file (`validation.productZip.manyFiles`), a `products.csv` missing a required
  column (`validation.import.missingColumn`), or one with a header and no rows
  (`validation.import.emptyFile`);
- a missing permission, checked before the first write. The preview is checked with
  the opt-ins it is sent, the same way: refused when the file changes a list, and the
  exact preview without `products.delete`, or without `catalog.lists.manage` when it
  would take a colour or brand out. The preview without the exact option reports that
  last need instead (`exactNeedsLists`), and the modal keeps the box switched off.

Listed under "Could not be done" or as row problems, while the rest is restored: a
`products.csv` main product cell that disagrees with `main-products.csv`; a main product
listed twice, with a bad code, with no name or with an Order out of range; a main
product change that would clash; a hex that is no `#1A2B3C` (`validation.productZip.hexInvalid`,
that hex left as it is); a `colours.csv` or `brands.csv` with no value column; a CSV or
XLSX outside `images/` that is none of the files above (`validation.productZip.unknownFile`;
not for the `._name` a Mac or the `~$name` an open Excel sheet leaves); a sub product
in the Bin without `products.delete`, or whose codes are taken; rows of one sub product
that disagree; the import's own row problems; and a photo that could not be added.
Entries are found by their name wherever they sit, so a zip of the unpacked folder
(with the folder inside it) reads the same, and so does one written by PowerShell's
`Compress-Archive`, with backslashes in its names. Photos are the files in a folder
named `images`, at any depth; a file there that is no image is listed as such.

### The preview and the run

The preview is the restore run as a dry run (one function, `runZip`), with the opt-ins
ticked in the dialog, so what it lists is what Apply does. Its report
(`ProductZipReport`) holds: main products added, changed
(name, code, brand or Order, old → new), back from the Recycle Bin and not in the file;
sub product rows added, changed cell by cell (old → new), unchanged, back from the Bin,
not in the file, their codes not in the file, main products put in the file's order, and
the import's row problems; the colour and brand lists (added, changed, put in order, not
in the file); photos added, replaced, unchanged, captions put back, order put back,
unmatched, duplicates, not an image, not in the zip; and the problems. The modal shows
each in a list and counts them; Apply is off when nothing would change.

The real run is a job on the Master (minutes for a few hundred new photos, each encoded
like an upload), followed by the dialog's progress bar; one runs at a time, and never
beside a full backup restore (Settings → Storage), which replaces the database:
whichever starts second is refused. It first stops the shipped photos still being
attached on a new install and waits for the photo it is on; at its first write it
retires them for good, so a restore refused before writing leaves them to carry on at
the next boot (`docs/UPDATES.md`). Under the exact option it then takes out what clears
the way (above). Then it writes the Brands list, the main products one by one (Bin
returns, then edits through `catalog.updateCategory`), the new main products, the colour
list, the sub products, the photos (uploads, captions, order) and last what the opt-ins
take out (sub products unless the exact run took them first, main products, brands,
colours, then photos). One `catalog.imported` activity row (its details count each kind
of change, every main product change in `mainProductsRenamed`) and one catalogue change
event. The done screen says what the exact option took out only when it took something.

The dialog says "file", not "zip", wherever the upload may be a products sheet (reading
it, nothing to change, no `colours.csv`, what is only listed), and the codes a file sub
product's rows leave out read "Codes in the catalogue but not in products.csv", beside
the sub products' "In the catalogue but not in products.csv".

### Where the plain Import differs

Products → Import reads a sheet a person typed with the same columns, through the same
`importProducts`, without `restore`:

| | Restore from .zip | Products → Import |
|---|---|---|
| Inner spacing | kept as written | folded to one space; a stored name, alias, size, colour, main product or brand that differs only in spacing reads as unchanged |
| A blank Alias, Size or Weight | clears the stored value | leaves the stored value |
| Colour spelling | the file's | one the colour list has is kept as written; another spelling takes the list's, the first in list order when two differ only in case |
| A sub product name its main product already has, under new codes | that sub product, its codes taken over by colour, the others kept | refused (`validation.product.nameTaken`), for a create, a rename or a move |
| A code only a sub product in the Recycle Bin has | that sub product comes back | not matched: Recycle Bin products are neither exported nor matched |
| Rows of one sub product that disagree | reported | the first row wins |
| Sub product order | the file's (above) | not read from the file |
| Moving a sub product to a main product | — | files it under the main product the preview matched (spacing and case aside), never a second one of that name, whatever the "import creates main products" switch says |

Both read the Colour of a `multicolour` row as one of its colours, both read the decimal
comma the same way, and both take the export's formula-guard apostrophe off again, one
exactly, so a value that starts with its own apostrophe before `-`, `=`, `+` or `@`
comes back as written (`lib/csv.ts`, `lib/spreadsheet.ts`).

Both read a sheet with **no Colour column** (say `Main product code, Sub product, Code,
Weight (kg)`, to change weights) as saying nothing about colours (since 2026-10-10;
`MergeRules.colours`): each code keeps its colour and each sub product whether it has
colours, where before a one-colour sub product lost its colour and the second code of a
two-colour one was refused. Two rows of one sub product are duplicates only by their
codes when every row of it names a live code; a new code beside them is still checked by
its blank colour, so the later of the two rows is refused
(`validation.import.duplicateInFile`) and the sub product is left as it is, no live code
recoded onto the new one (`findDuplicatesInFile(…, byCode)`), in the restore of such a
sheet too.

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
  found and applied exactly; photos a restore brought in from other files read back
  as unchanged and a second run uploads nothing; missing rows and photos are only
  reported unless opted in; an emptied catalogue comes back whole; top folders and backslash names; the
  refusals; the job; the routes.
- 2026-10-09, the restore rebuilt (`master/tests/product-backup-*`):
  `product-backup-import-domain.test.ts` (a restore's cells, the colour rule, the
  decimal comma, twins, the formula guard); `product-backup-import.integration.test.ts`
  (fidelity: spacing, blanks that clear, colour spelling, a sub product under other
  codes, twins, the Recycle Bin, sub product order); `product-backup-zip.integration.test.ts`
  (old files, main products: Order, recode, duplicates, clashes, the Bin, switched-off
  brands; the colour and brand lists); `product-backup-photos.integration.test.ts`
  (content-first matching, order, captions, Master-to-Master bytes, the `CODE_N`
  fallback, missing files); `product-backup-exact.integration.test.ts` (the owner's
  backup onto a new install comes back exactly and a second run changes nothing, a bare
  1.2.4–1.4.6 sheet, the exact option and its permissions); and
  `product-backup-boot.integration.test.ts` (the update boot, the shipped photos once per
  install, a restore stopping them). "The product backup zip" in
  `ui/tests/master-catalogue.test.tsx` covers the modal.
- 2026-10-10, the fix round: `product-backup-exact` adds a rename onto the name of a main
  product or a sub product the file leaves out (one run, preview alike, a second run
  writes nothing), a sub product a live lead quotes read as staying, a switched-off code
  keeping its main product, a name-only main product's brand, and the codes of a sub
  product read by name; `product-backup-import` a sheet with no Colour column (weights
  only, and a new code beside live ones in three cases); `product-backup-photos` the WebP
  kept only for the product restore; `product-zip` the exact preview's `products.delete`
  check on the route; the modal tests a preview again on the exact box, its two notes,
  and the done line only when something went.
