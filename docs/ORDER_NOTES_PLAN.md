# Order notes — Filling note and Dispatch note

Integration plan, written 2026-09-30 from the owner's design artifact
(`https://claude.ai/artifact/M8BRwLB41wrygh9HWrNGMY`, "A4 print notes") and a
survey of the tree at `b6bc70e`. Nothing here is built yet. Read `HANDOFF.md`
and `docs/STRUCTURE.md` first; file references below are to that commit.

---

## 1. What the owner asked for

- An order carries two printable documents: the **Filling note** (for the
  store, to pick and fill the order) and the **Dispatch note** (for loading and
  the driver).
- Two buttons on an order — *Filling note* and *Dispatch note*. Each opens a
  **preview** first. The preview has one **Print** button that prints on the
  printer connected to *that* PC.
- Product lines are laid out in two halves:
  - a product whose sub product has a **name** goes on the **left**, one row per
    line;
  - a product whose sub product is a **code** goes on the **right**, in a dense
    grid, grouped under its product (the "product and its sub-product group").

## 2. The design, as decoded from the artifact

The artifact is an A4 (210 × 297 mm) paged document. Everything below is in CSS
pixels at 96 dpi, so one A4 sheet is 794 × 1123 px; the page padding is
26 px top, 30 px sides, 20 px bottom.

### 2.1 Page furniture per note

| Part | Filling note | Dispatch note |
|---|---|---|
| First-page header | Full, 92 px: party name (28 px bold), party meta line (city · phone · GSTIN), **Dealer** chip with the party code; on the right Order ID, Lead generated, Printed | Slim, 44 px: "Dispatch note" as the big title, "Printed …" on the right |
| Continuation header | 34 px: party name + "— FILLING NOTE · continued", order id · page n, with a 2 px rule | 34 px: "Dispatch note · continued", order id · page n, no rule |
| Totals strip | **Bottom** of every page (74 px) | **Top** of every page (64 px), under the header |
| Strip contents | Quantity (this page / total), Item weight (this page / total, kg), **Dispatch vehicle no.** (blank dotted line to write in), order id + "Page n of N" + "Continued →" / "End of list · N items" | Same four cells; vehicle number printed large |
| Tick box per line | Yes (12 px square after qty) | No |
| Signature row (last page only, 62 px) | Filled by · Checked by · Store in-charge | Loaded by · Checked by · Driver signature |
| Non-last page notes | "c/f <running qty>", "c/f <running kg>" | same |
| Last page notes | "N items · P pages", "Gross of packing" | same |

### 2.2 Left half — "Product lines" (named sub products)

Column header (13 px, 1 px rule): `Product · sub-product | Colour | Qty | [tick]`.
Each row is **32 px**, dotted bottom rule:

- line 1: product (12 px semibold) — the product name and size;
- line 2: sub-product name (11.5 px) followed by small uppercase chips:
  **packaging** (Box / Grass / Paper) and, per the latest catalogue commit,
  **grade** beside it;
- Colour column 64 px; Qty 34 px, 15 px bold, tabular numerals.

Range label top-right: `1–46 / 46`. When there are no coded lines on a page
the left half goes full width and splits into **two** columns.

### 2.3 Right half — "Coded products" (numeric sub products)

A grid of `N` columns (owner picks 3–6; default 4; the artifact's toolbar
offers 3/4/5). Each cell is **50 px**:

- the code, 14 px bold, underlined, centred;
- beneath: `Colour - Grade` (9.5 px) and the qty (10.5 px bold).

When there are no named lines on a page the right half goes full width and
uses `min(9, cols × 2 − 1)` columns. Split when both exist: left 45 %, right
55 %, 1 px black divider.

**Addition to the artifact** (the owner's words, "with product and its
sub-product group"): coded cells are grouped under their **product**. A group
header row (18 px, product name + size, uppercase 8 px, full column width)
opens each group; a group that runs into the next column or page repeats its
header with "cont.". The artifact shows only bare numbers, which cannot tell
`OPT 102` from `PRM 102`.

## 3. What the tree has today (facts, with references)

- **No order print of any kind.** The only document is the lead PDF, built on
  the Master with pdfkit (`master/src/domain/lead-pdf.ts:22`,
  `master/src/pdf/table-renderer.ts:76`), opened in a sandboxed Chromium PDF
  window (`electron/shell.ts:431-457`, allowed by `electron/lib/lead-pdf.ts:11`).
  No `window.print`, `webContents.print`, `@media print` or `@page` anywhere.
- **Electron bridge** is `window.orderbook` (`electron/preload.cts:20`), typed
  as `DesktopBridge` (`shared/src/protocol/desktop.ts:25-120`); the web apps
  reach it through `desktopBridge()` (`master/web/src/api.ts:391`,
  `office/web/src/api.ts:439`). No print or printer IPC exists.
- **Order** (`shared/src/domain/entities.ts:739-778`) has `id`, `leadId`,
  `partyId`, `partyName`, `totalWeightKg`, `totalWeightKgOverride`,
  `linesWithoutWeight`, `dispatchedAt`, `customFields`, `items`, `sync`.
  **No vehicle number, no lead date** on the order.
- **LineItem** (`entities.ts:621-676`): `categoryName` / `categoryCode` (the
  owner's *Product*), `productName` (the *Sub product*), `brandName`, `size`,
  `variantLabel` (fixed colour), `colour` (picked colour), `grade`,
  `packaging`, `quantity` (**pieces**), `weightKg` (per piece),
  `lineWeightKg`, `variantId`.
- **Named vs coded** is not stored; it is derived by
  `isNumericSubProduct(name)` = `/^\d+$/` (`shared/src/domain/colour-rule.ts:65`),
  already used by the lead PDF through `subProductCells()` (:74-85). `102 (9")`
  therefore counts as a *name*.
- **Party** (`entities.ts:377-398`) has `partyCode` (e.g. `P-0001`), `name`,
  `phone`, `city`, `gstNumber` — enough for the header and the Dealer chip.
- **Ids** are `OD0000000318` (permanent) or a 15-character temporary offline
  id (`shared/src/sync/ids.ts:8-9`). The artifact's `ORD-0000000318` is a
  mock-up; print the real id.
- **Order screens.** Office has an order detail sub-screen
  (`office/web/src/screens/OrderBoardScreen.tsx:184-219`, an `EditorScreen`
  with no `actions` prop yet), built from the local snapshot — so it works
  offline. The Master has **no order detail**; orders are rows in
  `master/web/src/screens/LeadsOrdersScreen.tsx` with an actions column
  (:349-396, Dispatch and Delete).
- **Writes to an order** go through `order:update` with `OrderUpdateInput`
  (`shared/src/domain/inputs.ts:248-255`) — the path the weight override uses.
- **Permission** `orders.export` already exists (`shared/src/i18n/en.ts:49`).
- **Fonts** are bundled: Inter and IBM Plex Mono woff2 in `ui/src/fonts/`
  (`ui/src/fonts.css`) — exactly the artifact's two faces, offline.

## 4. Decisions this plan makes (and why)

1. **Render in the web app as HTML, not on the server with pdfkit.** The notes
   need the artifact's layout (flex columns, chips, fixed-height rows) and the
   fonts are already bundled for the web. The Office order detail comes from
   the local snapshot, so an HTML note prints **offline**; a pdfkit route would
   need the Master online (the lead PDF does). One renderer serves both panels.
2. **Pagination is a pure function in `shared/`**, not DOM measurement. Every
   row and cell has a fixed height and ellipsis overflow, so page breaks are
   arithmetic (the artifact already does it this way). That makes it testable
   under `verify` and identical in preview and on paper.
3. **Preview is a sub-screen, not a modal**, with a back button and a nested
   sidebar entry (the standing rule for opening a record).
4. **Print** goes through a new desktop bridge call that prints the current
   window to the PC's printer; the browser fallback is `window.print()`. The
   printer chosen is remembered **per PC** in the shell settings, because a
   printer belongs to the machine, not the company.
5. **Vehicle number becomes a real order field** (`orders.vehicle_number`,
   nullable, add-only migration), editable from the Dispatch note preview and
   saved through `order:update`. The filling note leaves it as a blank line to
   write in, as the artifact does.
6. **Lead generated date** is shipped on the order as an optional
   `leadCreatedAt` (joined on the Master), so Office never needs the lead
   itself — a converted lead may not be in its snapshot.
7. **Same-line merging.** Lines with the same `variantId`, colour, grade and
   packaging print as one row with the summed quantity (the lead PDF sums per
   variant, `lead-pdf.ts:86-94`); different colour/grade/packaging stay
   separate rows because the store fills them separately.
8. **Sort order.** Left: brand → product → sub-product name. Right: brand →
   product → numeric code ascending (`102` before `1111`).

## 5. Build plan, in order

Each step ends green on its own; `npm run verify` after each.

### Step 1 — Data: vehicle number and lead date

- `master/src/db/migrations/2026MMDD000000_order_vehicle_number.ts`:
  `ALTER TABLE orders ADD COLUMN vehicle_number TEXT NULL` with a `CHECK
  (char_length(vehicle_number) <= 20)`. `down()` drops the column (allowed in
  `down`, not in `up`). Register it; `migration-registry.test.ts` and
  `migration-data-safety.test.ts` must pass.
- `shared/src/domain/entities.ts` `Order`: `vehicleNumber?: string | null`,
  `leadCreatedAt?: IsoDateTime | null` — **optional**, or
  `shared/tests/wire-optionality.test.ts` fails.
- `shared/src/domain/inputs.ts` `OrderUpdateInput`: `vehicleNumber?: string | null`;
  validate (trim, upper-case, ≤ 20, `[A-Z0-9 -]`) in the order update schema
  beside the weight override's.
- Master order repository/mapper: select `vehicle_number`; join
  `leads.created_at AS lead_created_at` on `orders.lead_id`.
- `docs/schema/03-leads-orders-inventory.md`: the new column and why.
- Tests: extend the order update integration test (sets, clears, rejects a
  21-character value); mapper unit test for both new fields.

### Step 2 — Shared model: build and paginate a note

New file `shared/src/domain/order-note.ts`, exported from `shared/src/index.ts`:

```ts
export type NoteKind = 'filling' | 'dispatch';

export interface NoteLine {          // one printed row or cell
  key: string;                       // variantId|colour|grade|packaging
  brand: string | null;
  product: string;                   // categoryName + ' ' + size
  subProduct: string;                // productName (a name, or a code)
  colour: string | null;             // colour ?? variantLabel
  grade: string | null;
  packaging: string | null;
  quantity: number;                  // summed
  weightKg: number | null;           // summed lineWeightKg, null if any part lacks weight
}

export interface NoteGroup { product: string; lines: NoteLine[] }   // coded side

export interface OrderNoteModel {
  named: NoteLine[];                 // left
  coded: NoteGroup[];                // right
  totalQuantity: number;
  totalWeightKg: number | null;      // order override if set, else sum
  linesWithoutWeight: number;
}

export function buildOrderNote(order: Order): OrderNoteModel;
export function paginateOrderNote(model: OrderNoteModel, kind: NoteKind, codeColumns: number): NotePage[];
```

- `buildOrderNote` merges lines (decision 7), splits them with
  `isNumericSubProduct(line.productName)` — **reuse**, do not re-derive — and
  sorts (decision 8).
- `paginateOrderNote` ports the artifact's `paginate()` with its constants
  (`INNER 1076`, header `92`/`118`, continuation `34`/`108`, caption `16`,
  footer `74`/`0`, signature `62`, row `32`, label `13`, cell `50`) plus the
  group header (`18`). A coded column is filled top-down against its height
  budget; a group header never sits alone at a column's foot; a split group
  repeats its header. The last page reserves the signature row. `NotePage`
  carries `left` (one or two column groups), `right` (columns of
  `{header} | {line}` slots), per-page and running qty/weight, `isFirst`,
  `isLast`, `pageNo`, `pageCount`, and the ranges (`1–46 / 46`).
- Tests `shared/tests/order-note.test.ts`:
  - every input line appears exactly once across pages (both halves);
  - page count is 1 for a short order, grows for 46 + 430 and 120 + 1100
    (the artifact's presets);
  - per-page quantities sum to the grand total; running c/f is monotonic;
  - only the last page carries the signature row;
  - left goes full width (two columns) when a page has no coded lines, right
    uses `min(9, cols×2−1)` columns when it has no named lines;
  - `102 (9")` lands left, `102` lands right;
  - weight is `null` when any merged line lacks it, and the order override
    wins for the total.

### Step 3 — UI kit: the note and its preview

- `ui/src/OrderNote.tsx` renders `NotePage[]` as `<section class="ob-note-page">`
  sheets at 794 × 1123 px with the artifact's typography (Inter, IBM Plex
  Mono via `ui/src/fonts.css`). All strings from i18n.
- `ui/src/order-note.css`:
  - screen: sheets centred on a grey (`#E9ECEE`) scrolling canvas with a
    shadow and 24 px gap;
  - `@page { size: A4; margin: 0 }`;
  - `@media print`: hide everything except `.ob-note-print-root`
    (`body * { visibility: hidden }` plus the root and its children visible,
    positioned at 0,0), `break-after: page` on each sheet, no shadow, and
    `print-color-adjust: exact` so rules and chips print;
  - the sheets must **not** inherit the UI scale (79–157 %): pin their size in
    px and reset `zoom` on the print root, or a 125 % UI prints a clipped page.
- `ui/src/OrderNoteScreen.tsx` — the preview sub-screen:
  - toolbar: segmented **Filling note / Dispatch note** (switchable without
    going back), **Columns 3·4·5·6** for the coded grid, a readout
    (`N items · named + coded · P pages`), the **printer** select (desktop
    only), and the primary **Print** button;
  - on the Dispatch note, a **Vehicle no.** input that saves through
    `order:update` on blur/Enter (disabled when the user lacks `orders.edit`,
    or when the Office is offline and the write would queue — queued is fine,
    show the queued state like other order edits);
  - keys: `Ctrl+P` prints, `Escape` goes back, `Alt+F` / `Alt+D` switch notes;
  - a temporary (unsynced) order id prints with a "not yet synced" tag beside
    the id, so a paper note never shows an id that later changes silently.
- Column choice and last note kind are remembered in `localStorage`
  (per-viewer convenience; try/catch).

### Step 4 — Desktop printing

- `shared/src/protocol/desktop.ts` `DesktopBridge`: add **optional**
  `listPrinters?(): Promise<{ name: string; displayName: string; isDefault: boolean }[]>`
  and `printPage?(opts: { deviceName?: string }): Promise<{ ok: boolean; error?: string }>`.
  Optional so a web app served to an older shell falls back.
- `electron/preload.cts`: expose both, via `ipcRenderer.invoke`.
- `electron/shell.ts`:
  - `ipcMain.handle('orderbook:listPrinters', e => e.sender.getPrintersAsync())`;
  - `ipcMain.handle('orderbook:printPage', ...)` → `e.sender.print({ silent:
    Boolean(deviceName), deviceName, printBackground: true, pageSize: 'A4',
    margins: { marginType: 'none' } }, cb)` wrapped in a promise. No
    `deviceName` shows the Windows print dialog; a remembered printer prints
    straight to it. Only the main window's own `webContents` may call it
    (check `e.sender === mainWindow.webContents`).
- `electron/lib/print-options.ts`: the pure decision (silent or dialog, the
  printer name validated against the listed printers, falling back to the
  dialog when a remembered printer has gone). Tests in `electron/tests/`.
- Shell settings: add `printerName?: string` to the shell settings the
  `getShellSettings`/`setShellSettings` pair already stores, so the choice is
  per PC.
- Web side (`ui`): `print()` = `bridge?.printPage ? bridge.printPage({ deviceName }) :
  window.print()`; toast on `{ ok: false }` with the error.

### Step 5 — Buttons on both panels

- **Office** `office/web/src/screens/OrderBoardScreen.tsx`: give the order
  `EditorScreen` an `actions` prop with **Filling note** and **Dispatch note**
  (gate: `can('orders.export')`), opening `OrderNoteScreen` as a nested
  sub-screen of the order (register in `App.tsx` `subPages`, back returns to
  the order). Data: the order and its party from the local snapshot — works
  offline.
- **Master** `master/web/src/screens/LeadsOrdersScreen.tsx`: two actions in
  the orders' actions column (same gate), opening the same preview sub-screen,
  fed by `api.order(id)` and the party. When the Master gains an order detail
  screen, move the buttons there.
- i18n (`shared/src/i18n/en.ts` and `hi.ts`): `orderNote.filling`,
  `orderNote.dispatch`, `orderNote.print`, `orderNote.printer`,
  `orderNote.printerDialog` ("Ask each time"), `orderNote.columns`,
  `orderNote.vehicleNo`, `orderNote.productLines`, `orderNote.codedProducts`,
  `orderNote.productSubProduct`, `orderNote.colour`, `orderNote.qty`,
  `orderNote.dealer`, `orderNote.orderId`, `orderNote.leadGenerated`,
  `orderNote.printed`, `orderNote.continued`, `orderNote.page` ("Page {n} of
  {total}"), `orderNote.endOfList`, `orderNote.carriedForward`,
  `orderNote.qtyThisPage`, `orderNote.qtyTotal`, `orderNote.weightThisPage`,
  `orderNote.weightTotal`, `orderNote.grossOfPacking`, `orderNote.unsynced`,
  the six signature labels, and `orderNote.printFailed`.
- `ui/tests/office-shell.test.tsx` and `master-shell.test.tsx`: open an order,
  click *Dispatch note*, assert the preview sub-screen and page count; click
  *Print* with a stubbed bridge and assert `printPage` was called with the
  remembered printer; without a bridge assert `window.print`.

### Step 6 — Documentation

- `docs/STRUCTURE.md`: the new files, and an "Order notes" flow (order →
  preview → print) under the main flows.
- `HANDOFF.md`: current state and the traps in section 7.
- `docs/AI_COLLABORATION.md` change log.

## 6. Verification

- `npm run verify` — lint, typecheck, full suite; confirm the order
  integration suites **ran** (not skipped).
- Browser pass (Office and Master): Short / Typical / Long orders, both notes,
  3–6 columns, at 100 % and 157 % UI scale, and at the 1024 × 768 floor.
- Electron pass on the owner's PC: *Microsoft Print to PDF* as the printer,
  then a real printer. Check: one sheet per page, no browser header/footer,
  no clipped right edge, grey rules and chips printed, Hindi text renders.
  Unplug or rename the remembered printer — the dialog must come back.

## 7. Traps

- **UI scale leaks into print.** The app scales 79–157 %; if the sheets
  inherit it, pages clip or break early. Pin sheet size, reset zoom in print.
- **Pagination constants and CSS must agree.** Change a row height in the CSS
  and not in `order-note.ts` and pages overflow silently. Keep the constants
  in one exported object that the CSS reads through CSS custom properties set
  inline from it.
- **`isNumericSubProduct` is the only rule** for left vs right. Don't add a
  second test (e.g. "has a code column") that can disagree.
- **Quantities are pieces** on order lines (`LineItem.quantity`); stock is in
  boxes. The note prints what the line holds.
- **Offline Office**: the preview must not call the Master. Saving the vehicle
  number offline queues like any order edit.
- **Old shells**: the bridge members are optional; never assume them.

## 8. Owner decisions (defaults used until told otherwise)

1. **Quantity unit** on the notes: the artifact says "box", order lines hold
   pieces. *Default: "pcs".*
2. **Coded-side grouping** by product (section 2.3). *Default: grouped, with
   header rows.*
3. **Print behaviour**: straight to the remembered printer, or the Windows
   dialog every time. *Default: dialog until a printer is picked in the
   preview, then straight to it.*
4. **Dispatch note without a vehicle number**: print with a blank line, or
   refuse. *Default: print with a blank line to write in.*

## 9. Not in this plan

- A PDF file of the notes (save/share). Printing to *Microsoft Print to PDF*
  covers it today; a Master-side pdfkit route can follow if a file is needed
  without a printer.
- An audit entry ("Dispatch note printed by …") in the order timeline.
  Printing is not a data change; add it if the owner wants proof of printing.
- Company logo or address on the notes — the artifact has none.
