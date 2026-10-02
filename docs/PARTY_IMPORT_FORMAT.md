# Party import and export — the file format

What a person puts in a spreadsheet to add or change parties in bulk, on either
panel, and what comes back. The code is `shared/src/domain/party-import.ts`
(columns, limits, result types), `master/src/domain/party-import.ts` (reading a
row) and `master/src/services/party-import.service.ts` (the import, the export
and the template). The dialog is `ui/src/PartyImportModal.tsx`, on the Master's
Parties screen and the Office's Catalog screen (Parties tab).

It is online-only: the file goes to the Master, which answers a row-numbered
report. An Office with the Master out of reach is told so; nothing is queued.

## Who may

| Action | Needs |
|---|---|
| Template, import | `parties.bulk` (management tier and up), and `parties.create` to add or `parties.edit` to update |
| Export | `parties.view` |

A button is absent, not greyed, without its permission. The Master checks every
one again.

**Party Access holds.** An export lists only the parties the person may view.
Updating a party needs `manage` on it. A Party Code the person cannot view is
reported as "no party has the code" — a row's answer must not confirm that
somebody else's customer exists; one they can view but not manage is reported by
name as out of their access. A bulk add skips a name and city that a party
outside the person's view already holds, so Party Access is not a way to make a
second copy of a customer.

## The file

- CSV (UTF-8 with or without a BOM, UTF-16, or the Windows-1252 an English
  Excel writes; comma, semicolon or tab) or XLSX (the first sheet that holds
  anything; the template's is named `Parties`).
- **At most 5,000 data rows and 5 MB.** Larger is refused whole, before any row
  is read.
- Row 1 is the header. Blank rows are skipped without a word. Row numbers in the
  report are the ones Excel shows.
- Every cell is read as text, so `0731…` keeps its zero.

### Columns, in this order

| Column | Required | Notes |
|---|---|---|
| Party Code | to update | Blank to add a party. To update one, its code, e.g. `P-0001`. |
| Name | to add | The party as it is called in the office. |
| Phone | | |
| Alt Phone | | |
| Email | | Must look like an address. |
| Address Line 1 | | |
| Address Line 2 | | |
| City | | With the name, tells two parties apart. |
| State | | |
| Pincode | | Six digits (a space inside is removed). |
| GST Number | | The 15-character GSTIN; read in upper case. |
| Notes | | Free text; line breaks are kept. |

**Headers** match their name, the template's header, or the usual office word,
ignoring case, spaces and punctuation: `Customer`, `Party name`, `Mobile`,
`Phone No`, `GSTIN`, `PIN`, `Remarks`, `Town` and so on all read. A column
nothing recognises is ignored and listed in the preview as such. A header that
repeats a field already read is ignored too.

## Two modes

The dialog asks which one the file is.

**Adds new parties** (`create`). Needs the Name column.
- A row with a Party Code is an error — codes are given by the Master (`P-0001`…).
- A row with no name is an error.
- A name and city that already exist — case and spacing aside, a missing city
  counting as blank — are **skipped**, not an error: importing the same file twice
  changes nothing the second time.

**Updates parties by Party Code** (`updateByCode`). Needs the Party Code column.
- An unknown code is an error; a row with no code is an error.
- **A blank cell leaves that field as it is.** An import never clears a field.
- A row that says exactly what the party already holds is counted as
  *unchanged*, not as an update: an export uploaded back unedited reads "N need
  no change".

In both modes a code or a name and city that repeats an earlier row of the same
file is an error on the *later* row, pointing at the first.

**A value equal to what the party already holds is not re-checked.** An export
uploaded back must not fail on an old party whose pincode was typed loosely years
ago when nobody changed that cell. A *changed* pincode, GSTIN or email is checked.

## What comes back

A dry run (the preview) and the real import answer the same report:
`created`, `updated`, `unchanged`, `skipped`, `failed`, the first 1,000 issues
(row, column as written in the file, and a message in the person's language), the
ignored columns, and the first rows as understood. The import re-reads the file;
the preview is not trusted.

Rows are written in chunks of 200. A chunk that fails as a whole is replayed one
row at a time, so one bad row costs its chunk the fast path and costs the file
nothing: the rest land, and the bad one is reported by row.

One import is **one activity row** (`party_list` / `imported`, with the file name
and counts) and **one `party_bulk` change event**, not one per party. The event
makes every panel take a fresh snapshot instead of folding in rows; a panel older
than `PARTY_BULK_MIN_PROTOCOL` (5) does not know the event, so the Master sends
it the snapshot directly. An export is one activity row too (`exported`).

## Export

`GET /api/parties/export.csv|xlsx` writes the template's own twelve columns, one
row per party the person may view, in name order. The CSV starts with a BOM so
Excel reads it as UTF-8, and a cell that begins with `=`, `+`, `-` or `@` gets a
leading apostrophe (`master/src/lib/csv.ts`), which the import takes off again.
Edit it and upload it back with *Updates parties by Party Code*.

## Routes

On the Master (`dataRoutes`, mounted **before** `/parties/:id`) and on the panel
surface (`/api/panel`, behind `requirePanel`); the Office proxies its own
`/api/parties/…` to the latter.

| Route | |
|---|---|
| `GET /parties/import/template.csv\|xlsx` | The blank template (the XLSX has a Guide sheet) |
| `GET /parties/export.csv\|xlsx` | The export |
| `POST /parties/import` | Multipart: `file`, `mode` (`create` or `updateByCode`), `dryRun` (`true`) |
