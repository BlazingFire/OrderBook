# 07 — UI specification for the six new modules

Status: **specification only. No screen in this document is built in this batch, and none may be.**

This is the contract between the backend work planned in `docs/BACKEND_MODULES.md` and the frontend
work planned in `docs/UI_REDESIGN.md` §8 Phase 3. The screens themselves belong to the UI phase, on
the `ui/` component package, after the endpoints are real. What this document does is fix — before a
line of either half is written — **what the backend must serve so that those screens can exist**.

It exists because the two halves are being planned by different passes and would otherwise drift.
Three concrete drifts have already been caught by writing it, and they are listed in §12: a column
in the supplied Logs mockup with no field behind it, two Dashboard subtitles with no figure behind
them, and an Office HTTP client that structurally cannot render any of the failure copy specified
here. Those are cheap to fix now and expensive to discover during Phase 3.

**Scope rules that apply to this document as much as to the rest of the batch.** No screen file, no
`App.tsx` edit, no tab-table entry, no sidebar entry ships in this batch. The single frontend
artefact this batch produces is typed API client wrappers in `master/web/src/api.ts` and
`office/web/src/api.ts` — functions with no UI attached, added to the existing `api` object literal
(`master/web/src/api.ts:110`, `office/web/src/api.ts:108`). Everything below §2 describes screens the
UI phase will build against those wrappers.

Read alongside: the supplied design system spec (summarised in `docs/UI_REDESIGN.md` §1–§4) for
tokens, shells and component inventory; `docs/BACKEND_MODULES.md` for what each endpoint actually
answers.

---

## 1. Rules every screen in this document obeys

These are not per-screen decisions. They are stated once and assumed everywhere after.

### 1.1 A module the role cannot view is **absent** from the sidebar, not greyed out

Both apps already do this and both already say why. `master/web/src/App.tsx:157-163` gates the Access
tab on `roles.view || users.manage` with the comment that *a tab for a permission they can never hold
would be a tease*; `office/web/src/App.tsx:163-173` filters `visibleTabs` through the session's own
permission set, and falls back to the first visible tab rather than landing somebody on a blank
screen. The six new modules extend the same table — they do not invent a second mechanism.

| Sidebar group | Entry | App | Present when the session holds |
|---|---|---|---|
| Output | Documents | Master + Office | `documents.view` |
| Output | Reports | Master + Office | `reports.view` |
| Admin | Fields | Master + Office | `fields.view` |
| Admin | Recycle Bin | Master + Office | `recycleBin.view` |
| Admin | Logs | Master + Office | `logs.view` |
| Admin | Settings | Master + Office | always (the LocalePicker is ungated — §10.2) |

Three consequences worth stating plainly, because each is a place somebody will otherwise "fix" the
behaviour back into a bug:

- **Absent, not disabled.** A disabled nav entry advertises a capability and teaches nothing. The
  design spec's own rule (§8: *"A module the role cannot `view` is absent, not greyed"*) and the
  existing comment in `App.tsx` agree.
- **The permission set is the session's, not the snapshot's.** On the Office Panel that distinction
  is load-bearing: signing in offline means there is no fresh snapshot, and the cached set is exactly
  what the panel is enforcing locally (`office/web/src/App.tsx:154-157`).
- **Hiding the entry is not the enforcement.** Every endpoint below is gated server-side as well. The
  sidebar rule is about not lying to the user, not about security.

Within a visible screen, a control the actor cannot use is likewise absent rather than disabled —
with one exception: a control whose absence would make the screen unreadable (the Documents
designer's **Show rates** switch, §7.4) renders disabled with a tooltip naming the missing
permission, because its *state* is information.

### 1.2 Cursor pagination only. No page numbers, anywhere, ever

Every list in this document is keyset-paginated and the API has no offset and no total. The shared
primitive is minted once:

```ts
// shared/src/domain/inputs.ts — beside the existing offset-based Paginated<T>
export interface CursorQuery { cursor?: string; direction?: 'older' | 'newer'; limit?: number }
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;   // null for one-directional feeds
  limit: number;
}
```

The UI renders it through one component, `CursorPager`, in exactly two shapes:

| Shape | Used by | Renders |
|---|---|---|
| **Newer / Older** | Logs, Recycle Bin, Documents → History | Two buttons. `Newer` disabled when `prevCursor` is null, `Older` disabled when `nextCursor` is null |
| **Load more** | Documents → Templates | One button, appends to the list, hidden when `nextCursor` is null |

`CursorPager` never renders a count, a page index, or a "1–25 of 812" line, because the API cannot
compute one without a `COUNT` the design deliberately refuses. A screen that wants to say how much
data there is says it about the *filter* ("Last 90 days"), not about the result set.

Enablement comes from the cursor being null, never from `items.length < limit` — the repositories
fetch `n+1` rows precisely so the null is authoritative.

### 1.3 A redacted field renders as an em dash. The cell must handle `undefined`, never `null`

`maskFields()` **deletes** the key. A redacted money field is therefore absent from the JSON, and
every type below declares it optional (`totalValue?: number`) for that reason. Three rules follow:

- The cell tests `value === undefined`, never `value === null` and never `!value` — `!value` would
  turn a genuine zero into an em dash, which is a different and worse lie.
- The redacted cell renders `—` with a Tooltip reading **"Hidden — needs `field.saleRate.view`"**.
  The permission key is shown verbatim, in `--t-mono`, because that is the string an administrator
  types into the permission grid.
- A redacted cell is **never** `0`, never blank, and never omitted from the column set — dropping the
  column entirely would silently change the shape of the table between two users looking at the same
  screen. The column stays; the values are dashes. (In a rendered PDF the rule inverts and the whole
  column is absent — see §7.4. A document is a legal artefact sent to a customer; a table is a screen
  the user is reading with their own permissions in mind.)

`office/web` already has the right instinct here — a hidden rate renders as `—` rather than a
confident ₹0.00 (`HANDOFF.md`, second wave). This generalises it.

### 1.4 Empty, error and offline states: two lines and one action

Per the design spec §9.4. No illustration, no icon over 20px, no apology, and a permission failure
names the permission. Each screen's exact copy is given in its own section; the shared shapes are:

| State | Component | When |
|---|---|---|
| Loading, first paint | `Skeleton` rows matching the table's column widths | request in flight, no prior data |
| Loading, refetch | the logo-mark busy indicator in the FilterBar; the stale table stays visible | request in flight, prior data on screen |
| Empty, unfiltered | `EmptyState` | 0 rows and no filter applied |
| Empty, filtered | `EmptyState` with `[ Clear filters ]` | 0 rows with a filter applied |
| Error | `ErrorState` with `[ Retry ]` | the server answered and refused, or the request failed |
| Offline (Office only) | `OfflineBanner` replacing the content region | the local route answered `503 { error: 'unavailable' }` |

**Empty-filtered and empty-unfiltered are different states with different copy.** Collapsing them is
the most common way an empty screen reads as a broken one.

There is no spinner component. The design spec §6 is explicit: the logo mark inking in on a 700ms
loop is the only busy indicator in the product.

### 1.5 Colour chips, and the value that has no hex

A colour renders as a **14px circle with a 1px `--line-strong` ring**, and the colour **name is
always adjacent text** — the chip is never the only signal, because white-on-white is invisible and
because a name can be read aloud down a phone line. A value with no known hex renders as the ring
alone with its first two letters inside at 9px.

This matters more here than in the reskin work, because the hex is new: `option_lists` gains a
nullable `hex` column back-filled from the distinct colour strings already in the stock tables, and a
colour with no `option_lists` row stays a perfectly normal colour. The two-letter ring is therefore
not an edge case to be designed away — it is the correct rendering for a real and permanent class of
value, and `Fields → Colours` shows it deliberately (§6.3).

The chip's identity is the **exact string** the records hold. It is never case-folded, never
normalised for display, and never re-keyed.

### 1.6 Numbers, identifiers, dates

- Tabular numerals (`--t-data`, `tnum`) on every column where two numbers can be compared: box
  counts, quantities, money, usage counts, page counts, byte sizes.
- Numeric columns are right-aligned **and so is the header**.
- Record ids render through `IdField` in `--t-mono`; hashes and fingerprints through
  `FingerprintField`, grouped four characters at a time with a `0.5ch` gap and wrapping only at a
  group boundary.
- Ids, hashes and numbers are **never translated or reformatted by locale** (design spec §10). They
  are wrapped in `<Untranslated>` so that the fact is documented rather than merely true.
- **Every timestamp is formatted in `config.locale.timeZone`** (default `Asia/Kolkata`). A
  `timestamptz` from the server is safe to format; a value derived from a `DATE` column is not, and
  `toISOString()` is never called on one — that is the IST day-shift defect. Report month buckets
  arrive as `'YYYY-MM'` **text** computed in SQL and are rendered by looking the month name up, never
  by constructing a `Date`.
- Money is `₹` + `en-IN` grouping, from the existing shared `format.ts`, and the locale layer does
  not touch it.

### 1.7 The Office failure contract

Every one of the six modules on the Office Panel is **forwarded live to the Master and fails hard
when the Master is unreachable**. Nothing is queued into the outbox. i18n is the sole exception: both
catalogues are compiled into the panel's bundle, so language switching and every rendered string keep
working with the Master switched off.

The mechanism already exists and invents nothing. `forward()` (`office/src/http/app.ts:438-462`)
answers `503 { error: 'unavailable' }` when `masterConnection` is not connected (`:444`), and passes
the Master's own `code` and named permission through on a refusal (`:451-460`). The routes sit below
the positional `app.use('/api', requireUser)` gate at `:133`.

So an Office screen has three distinct failure modes and must not collapse them:

| HTTP | Meaning | Screen shows |
|---|---|---|
| `503 unavailable` | The Master could not be **asked** | `OfflineBanner`, module-specific copy, `[ Retry ]` |
| `403 forbidden` + `details.permission` | The Master **refused** | `ErrorState` naming the permission |
| `502` / anything else | The Master answered and something else went wrong | `ErrorState` with the message and `[ Retry ]` |

**Offline is decided from that status code, which comes from the transport flag — never from reading
an error message.** A Postgres "canceling statement due to statement timeout" is a message the Master
*sent*; it means refused, not silent.

> **This contract is currently unrenderable on the Office Panel, and fixing it is in scope for this
> batch.** `office/web/src/api.ts:87-100` throws a bare `Error` carrying only
> `body.message` — no `code`, no `details`. The browser therefore cannot tell `503 unavailable` from
> `403 forbidden` from a validation failure, so none of the copy in this document can be selected.
> `master/web/src/api.ts:41-68` already has the right class: `ApiError` with `code`, `details`, and
> the `missingPermission` / `storedVersion` / `diff` accessors. **The Office client must gain the
> same class before any of these screens is built.** It is a client wrapper, not a screen, so it
> lands with the other `api.ts` work in this batch rather than in Phase 3.

Two further prerequisites, both already owned by `docs/BACKEND_MODULES.md` §2.5: the socket ack's
`{ ok: false }` arm must carry `details` (`shared/src/protocol/socket.ts:141-159` has `code?` and
`missingPermission?` and nothing else), and `respond()` must set them for any `AppError` rather than
only `ForbiddenError` (`master/src/realtime/hub.ts:391-406`). Without those, the Recycle Bin's
`blockedBy` list, its rename suggestion, and the Documents designer's `storedVersion` diff arrive on
the Office Panel as a bare English string, and the conflict dialogs specified in §5.5 and §7.5 cannot
be built.

### 1.8 Component vocabulary

Every screen below composes from the `ui/` inventory in `docs/UI_REDESIGN.md` §7 and adds no new
primitive. Where a screen needs something the inventory does not have, that is called out as a
Phase 1 addition rather than invented locally:

`AppShell` · `Sidebar` · `Topbar` · `FilterBar` · `StatusFooter` · `PresenceRail` · `Card` ·
`Section` · `Tabs` · `Drawer` · `Modal` · `Popover` · `Tooltip` · `Toast` · `DataTable` ·
`CursorPager` · `ColourChip` · `StatusPill` · `Timeline` · `IdField` · `FingerprintField` ·
`KeyValueList` · `Skeleton` · `EmptyState` · `ErrorState` · `ConflictBanner` · `OfflineBanner` ·
`Button` · `IconButton` · `Input` · `Select` · `Combobox` · `Switch` · `Checkbox` · `DateField`.

Two additions Phase 1 must carry that the current inventory list does not name:

| Addition | Needed by | Why not composed |
|---|---|---|
| `BarRow` | Reports (§4) | A label, a proportional bar, and two right-aligned numeric cells. The bar is a `div` whose `width` is a static percentage — **never animated**, since `width` is on the banned-to-animate list |
| `DragHandle` on `DataTable` rows | Fields (§6.5) | Reordering sends a complete permutation; a row needs a keyboard-reachable grab affordance (`↑`/`↓` with the handle focused), not a mouse-only one |

No charting library. The Reports bars are CSS, for the same reason there is no icon package.

---

## 2. Which screens exist, on which panel

| # | Screen | Master | Office | Shell |
|---|---|---|---|---|
| §3 | Logs | ✔ | ✔ | List screen with FilterBar + row Drawer |
| §4 | Reports | ✔ | ✔ | Single content column, chart panel + side table |
| §5 | Recycle Bin | ✔ | ✔ | List screen with FilterBar, no drawer |
| §6 | Fields | ✔ | ✔ | List screen with set Tabs + 280px explainer Card |
| §7 | Documents | ✔ | ✔ | Three-pane designer + a History tab |
| §9 | Dashboard | (restyle of the existing one) | **net new** | Card grid |

Ten screens. All ten belong to `docs/UI_REDESIGN.md` §8 Phase 3, not to this batch.

Master's chrome is permanently dark in both themes; the Office's follows the machine's theme setting.
Same tokens, no new ones — the design spec's Developer-Panel differentiation (§3.5) applied to the
app that actually owns the database.

---

## 3. Logs

### 3.1 Purpose

Show the hash-chained audit trail as a readable feed, and let somebody prove it has not been tampered
with. This is the read surface for a table that has existed and been append-only since `20260303` and
has never had an HTTP route.

### 3.2 Shell

List screen. Topbar: title *Logs*, a `StatusPill` carrying the chain state, `[ Verify chain ]`,
`[ Export CSV ]`. FilterBar below it. Content is one `DataTable`, virtualised above 100 rows, with a
`CursorPager` in **Newer / Older** shape pinned below it. Clicking a row opens a **right Drawer at
520px** with the full entry. No route change; the list keeps its scroll position and its filters.

A one-line note sits between the FilterBar and the table, in `--t-small`, `--fg-tertiary`:

> Append-only — the database refuses UPDATE and DELETE on this table.

### 3.3 Columns

Source type: `ActivityLogEntry` from `shared/src/domain/activity.ts`.

| Column | Field | Type | Render | Align |
|---|---|---|---|---|
| When | `createdAt` | `IsoTimestamp` | `dd MMM HH:mm` in `config.locale.timeZone`; full timestamp in a Tooltip | left |
| Actor | `actor.name`, `actor.type`, `actor.id` | `ActivityActor` | `name`; when `name` is null, the `actor.type` token — *Office Panel* or *System* — as a `StatusPill`, never the raw id | left |
| Action | `action` | `string` | `t('log.action.' + action)`, falling back to the raw string (§10.3) | left |
| Record | `entityType`, `entityId` | `string`, `string` | `t('log.entity.' + entityType)` then the id in an `IdField` | left |
| Entry hash | `hash` | `string \| null` | `FingerprintField`, first 12 chars, grouped in fours. Null when `chained` is false | left, mono |

Two things about the last two columns:

- **`hash` is served — this gap is closed.** The designed `ActivityLogEntry` carried
  `{ id, sequence, tenantId, entityType, entityId, action, actor, details, createdAt, chained }` and
  no hash, so the mockup's "Entry hash" column had no field behind it. It now does:
  `ActivityLogEntry` carries `hash: string | null`, owned by `04-API-CONTRACT.md` §2.1. It digests
  data the holder of `logs.view` can already see, so it is covered by `logs.view` and mints no key of
  its own, and it is the only thing on the screen that makes "hash-chained" visible to a person
  rather than merely asserted. The column stays, and §11 no longer lists it as missing.
- **`chained: false` rows are marked, not hidden.** A pre-chain backfilled row renders its hash cell
  as `—` with the Tooltip **"Written before the chain existed — not verifiable"**. It is not an error
  and must not use `--state-conflict`.

The row is `React.memo`'d and keyed on `entry.id`, never the array index.

### 3.4 Row drawer (520px)

Composes `KeyValueList`. Shows: When (full, with the timezone named), Actor (type, name, id), Action,
Record type and `IdField`, Sequence, Entry hash as a full `FingerprintField`, and **Details** — the
`details` JSONB rendered as a `KeyValueList` of its own, values in `--t-mono`, with no attempt to
translate the keys.

`prev_hash` is **not** shown, because it is not served. Verification is what answers the question
"does this chain hold", and it is one button away.

### 3.5 Filters

All in the FilterBar. Options come from `GET /api/logs/facets`, never from a list typed into the
renderer — `action` is free-form `TEXT` with no `CHECK`, so the data is the only enumeration there
is.

| Filter | Control | Source | Notes |
|---|---|---|---|
| Actor | Chip row, `Everyone` first | `facets.actors` | The mockup's shape; degrades to a `Combobox` above 8 actors |
| Record type | `Select` | `facets.entityTypes` | Labels through `log.entity.*` |
| Action | `Select` | `facets.actions` | Labels through `log.action.*` |
| From / To | two `DateField`s | — | Calendar dates, sent as `'YYYY-MM-DD'` strings. **Never** a `Date` |
| Search | `Input`, `/` focuses it, debounced 180ms | — | Maps to `q` |

Default window: the newest entries with no date filter. Facets are bounded by the same 90-day
lookback the list uses, so the dropdowns stay an index range scan as the table grows. The FilterBar
states that: **"Filters cover the last 90 days"** in `--t-small`.

### 3.6 Actions

| Action | Control | Permission | Behaviour |
|---|---|---|---|
| Read the feed | — | `logs.view` | Without it the sidebar entry is absent |
| Verify chain | Topbar `Button` | `logs.verifyChain` | Absent without the key. Opens a Modal (§3.7) |
| Export CSV | Topbar `Button` | `logs.export` | Absent without the key. **Master only for now** — see §8.1 |
| Open an entry | row click | `logs.view` | Drawer |

### 3.7 Verify chain

Expensive and range-limited, so it is a Modal rather than an inline toggle.

Before: **"Verify the newest 10,000 entries"** with the range shown and a `[ Verify ]` /
`[ Cancel ]` pair. During: the logo busy indicator and **"Checking 10,000 entries…"** — never
*Loading…*. After, from `ChainVerification`:

- **Whole:** a `--state-ok` `StatusPill` in the Topbar reading **"Chain verified"**, and a Modal body:
  > **Chain verified**
  > 10,000 entries checked, sequence 41,203 to 51,202. Nothing has been altered.

  Plus, when `truncated` is true, a secondary `[ Verify the previous block ]`.
- **Broken:** a `ConflictBanner` above the table, `--state-conflict`, that persists until dismissed:
  > **Chain broken at sequence 41,884**
  > The stored hash does not match the recomputed one. Every entry after it is unverifiable.
  > `[ Show the entry ]`

  `[ Show the entry ]` scrolls the list to that row and opens its drawer. `firstBreak.kind` selects
  the first line: `hash_mismatch` → *"The stored hash does not match the recomputed one"*;
  `prev_hash_mismatch` → *"This entry does not follow the one before it"*; `sequence_gap` →
  *"An entry is missing from the sequence"*.

A break is a real event, not a UI error state — it does not use `ErrorState` and it does not offer
`[ Retry ]`.

### 3.8 States

- **Loading:** 12 `Skeleton` rows.
- **Empty, filtered:**
  > **No entries match these filters**
  > Widen the date range, or clear the actor filter.
  > `[ Clear filters ]`
- **Empty, unfiltered:** effectively unreachable, since signing in writes an entry — but specified so
  it is not left to chance:
  > **No activity yet**
  > Every change to a record is recorded here from the first sign-in.
  > `[ Refresh ]`
- **Error:**
  > **Couldn't load the log**
  > {message from the server}
  > `[ Retry ]`
- **Permission refused on Verify** (only reachable if the key is revoked between paint and click):
  > **You don't have permission to verify the chain**
  > Ask an administrator for `logs.verifyChain`.
  > `[ Close ]`

### 3.9 Components

`AppShell` · `Topbar` · `FilterBar` · `DataTable` · `CursorPager` · `Drawer` · `KeyValueList` ·
`IdField` · `FingerprintField` · `StatusPill` · `Tooltip` · `Modal` · `ConflictBanner` · `Skeleton` ·
`EmptyState` · `ErrorState` · `Toast`.

---

## 4. Reports

### 4.1 Purpose

Three server-computed analytics views over a bounded date range: dispatches by month, lead outcomes
by month of creation, and top parties by value. First enforcement site anywhere in the codebase for
`reports.view` and `reports.export`, which have rendered as togglable grid cells and gated nothing.

### 4.2 Shell

Not a list screen. Topbar: title *Reports*, `[ Export CSV ]`. FilterBar: report `Tabs`
(*Dispatches* · *Lead outcomes* · *Top parties*) and range chips (*This month* · *3 months* ·
*12 months*). Content is a two-column region inside the scrolling area: a chart `Card` that takes the
remaining width, and a side-table `Card` fixed at 320px. Below 1180px the side table wraps under the
chart.

The chart `Card` header carries the report title, the resolved range label (e.g. *June — August*), and
a one-line note. The note is a **client token per report** (`reports.note.*`, §10.1), not served copy
— the server returns buckets, never prose.

**The mockup's line "Runs on this machine — no server round-trip" is wrong for this product and must
not ship.** See §12.

### 4.3 Chart panel — data per report

Bars are `BarRow`s: label, proportional bar, then right-aligned numeric cells. The bar's width is
`round(value / max * 100)%`, computed from the largest bucket in the visible set, set as a static
style, never transitioned.

**Dispatches** — `DispatchesReport.months: DispatchMonthBucket[]`

| Cell | Field | Type | Redaction |
|---|---|---|---|
| Label | `month` | `string` `'YYYY-MM'` | — |
| Bar | `boxes` | `number` | — |
| Boxes | `boxes` | `number` | — |
| Amount | `totalValue?` | `number \| undefined` | em dash + tooltip when absent |

Every month in the range is present and zero-filled by the service, so a month with no dispatches
renders a zero-height bar and `0`, not a gap. The month label is looked up from `'YYYY-MM'`; nothing
constructs a `Date`.

**Lead outcomes** — `LeadOutcomesReport.months: LeadOutcomeMonthBucket[]`

Bucketed by month of **creation**, four counts per month: `converted` / `lost` / `quiet` / `open`.
The bar is a four-segment stack, each segment a `--fg-*`-neutral tone plus one accent for
`converted`; the legend names all four in words. Classification never keys on a stage *name* —
stages are tenant-configurable rows — and the `Won` stage is not treated as conversion, because
`20260302` deliberately produced leads that are both in `Won` and converted.

**Top parties** — `TopPartiesReport.parties: TopPartyRow[]`

| Cell | Field | Type |
|---|---|---|
| Label | `partyName` | `string` |
| Sub-label | `partyCode`, `city` | `string`, `string \| null` |
| Bar + Orders | `orderCount` | `number` |
| Amount | `totalValue?` | `number \| undefined` |

`TopPartiesReport.orderedBy` is `'value' | 'orderCount'`, and the panel **states which**: a
rate-blind caller gets the leaderboard ordered by `orderCount`, because ordering by a key that is
absent from the payload would be a list the reader cannot make sense of. The header reads
**"Ordered by order count"** in that case, in `--t-small`, always — not only when it differs.

Top-N, clamped 5–50, default 10. Never paged: a leaderboard is not a browsable list, and there is no
`CursorPager` on this screen.

### 4.4 Totals row

From `ReportTotals`, **computed server-side over the same filtered set and masked server-side**. The
client never sums the visible buckets to produce a total, because summing masked buckets produces a
number that is confidently wrong. When `totalValue` is absent the totals cell is an em dash with the
same tooltip as any other redacted cell.

### 4.5 Side table

`DataTable`, three columns, no pager.

| Report | Side table | Columns | Source |
|---|---|---|---|
| Dispatches | *By colour, same period* | Colour (`ColourChip` + name) · Boxes · Amount | `DispatchColourBucket { colour, hex?, boxes, totalValue? }` |
| Lead outcomes | *Conversion* | Outcome · Leads · Amount | see §11 — the per-outcome amount is **not served** |
| Top parties | *By city* | City · Orders · Amount | `TopCityRow` |

The city rollup groups on `lower(btrim(city))`; blank and NULL collapse into one bucket returned as
`city: null`, which the client labels through `reports.city.unknown` — an i18n key, never a server
string.

### 4.6 Actions

| Action | Control | Permission |
|---|---|---|
| View any report | — | `reports.view` |
| Change report / range | FilterBar chips | `reports.view` |
| Export CSV | Topbar `Button` | `reports.export` — **Master only for now**, §8.2 |

The mockup's button says *Export PDF*. It exports **CSV** (`GET /api/reports/:report/export`); the
label is `reports.export.csv` and reads **Export CSV**. Exporting a report as a PDF would be the
Documents module, gated by a different key, and conflating them is exactly the "one control silently
disabling another" trap `documents.render` was kept separate to avoid.

A redacted money column is written into the CSV as an **empty cell**, never `0`.

### 4.7 States

- **Loading:** the chart `Card` shows six `Skeleton` bar rows; the side table three `Skeleton` rows.
- **Empty (a range with no data):**
  > **Nothing dispatched in this period**
  > Change the range, or dispatch an order to see it here.
  > `[ Last 12 months ]`

  Per report: *Nothing dispatched…* / *No leads created in this period* / *No dispatched orders in
  this period*. The action is always the widest range not currently selected.
- **Error:**
  > **Couldn't build this report**
  > {message}
  > `[ Retry ]`

### 4.8 Components

`AppShell` · `Topbar` · `FilterBar` · `Tabs` · `Card` · `BarRow` · `DataTable` · `ColourChip` ·
`Tooltip` · `Skeleton` · `EmptyState` · `ErrorState`.

---

## 5. Recycle Bin

### 5.1 Purpose

One feed of every soft-deleted record, with restore. `RECYCLE_BIN_ENTITIES` ships six members at the
Recycle Bin stage, gains two at the Fields stage and one at the PDF Designer stage — nine at the end
of this batch (see §12). The screen renders whatever member list the server sends, so it needs no
change as the set grows. It **subsumes** the
roles/users-scoped bin that already exists inline in `master/web/src/screens/AccessScreen.tsx:963`
(`function RecycleBin`): those two entity types become two rows in the unified feed, and
`AccessScreen`'s inline section is replaced during Phase 3 by a link into the Bin pre-filtered to
roles and users. The existing `restoreRole` / `restoreUser` services are reused, not reimplemented.

### 5.2 Shell

List screen. Topbar: title *Recycle Bin* and a count `StatusPill`. FilterBar: type chips with counts,
a search `Input`, and — **only when the session holds `recycleBin.viewAll`** — a *Deleted by* `Select`.
Content is one `DataTable` with a `CursorPager` in Newer / Older shape. No drawer: a `BinEntry`
carries label, sublabel and deletion metadata and there is nothing further to show.

A note line under the FilterBar, `--t-small`:

> Nothing here is gone — a restored role reattaches to its users.

### 5.3 Columns

Source type: `BinEntry` from `shared/src/domain/recycle-bin.ts`.

| Column | Field | Type | Render | Align |
|---|---|---|---|---|
| Record | `id` | `string` | `IdField`, mono | left |
| Type | `entityType` | `RecycleBinEntityType` | `StatusPill` labelled from `bin.entity.<type>` | left |
| Name | `label`, `sublabel` | `string`, `string \| undefined` | `label` on line one, `sublabel` in `--t-small` `--fg-tertiary` on line two | left |
| Deleted by | `deletedByName` | `string \| null` | the name; when null, **"Office Panel"** as a `StatusPill` | left |
| When | `deletedAt` | `IsoTimestamp` | `dd MMM HH:mm` in the configured timezone | left |
| — | — | — | `[ Restore ]` `Button`, `sm`, ghost | right |

`deletedByName` is null for anything an unattended Office Panel or the system deleted (`actorUserId`
returns null for panel and system actors). Those rows are visible **only** to holders of
`recycleBin.viewAll`, since the default scope is `deleted_by = me`. The screen says so once, in the
FilterBar, when the actor lacks `viewAll`:

> Showing records you deleted.

### 5.4 Filters and scope

| Filter | Control | Source |
|---|---|---|
| Type | Chip row, *Everything* first, each with a count | `GET /api/recycle-bin/counts` |
| Search | `Input`, debounced 180ms | `search` |
| Deleted by | `Select`, **absent without `recycleBin.viewAll`** | `deletedBy` |

The counts endpoint counts **only over branches the caller may see**, so a chip total and the list it
filters to can never disagree. A chip whose count is 0 is still rendered — a disappearing filter is
disorienting — but it is not clickable.

### 5.5 Restore

`[ Restore ]` is present on a row only when the actor holds `RESTORE_PERMISSION[entityType]` — the
entity's own **delete** key (`leads.delete`, `orders.delete`, `parties.delete`, `products.delete`,
`roles.delete`, `users.manage`, `fields.manage`). Restore is therefore never a back door onto an
entity you may not delete, and **no `recycleBin.restore` key is minted**. The server already filters
those rows out, so the client-side check is belt-and-braces, not the enforcement.

**There is no purge, no "empty bin", and no permanent delete anywhere on this screen.** Not because
it was forgotten — because the audit table refuses `DELETE` by trigger and the product has decided a
soft delete is the end of the line.

Three outcomes:

- **Success.** `Toast`, bottom-left, 4s: **"Restored — {id} is back in {type}"**. The row leaves the
  list; the type chip's count decrements.
- **Name taken (409 with `details.suggestion`).** A `Modal`:
  > **That name is in use**
  > *Party 9* was recreated after this one was deleted. Restore it as **Party 9 (restored)**?
  > `[ Restore as Party 9 (restored) ]` `[ Cancel ]`

  The suggested name comes from the server's `suggestRestoredName`; the client never invents one.
- **Parent deleted (409 with `details.blockedBy: BinBlocker[]`).** A `Modal`:
  > **Its party was deleted too**
  > This lead belongs to *Party 9*, which is also in the bin. Restore both?
  > `[ Restore both ]` `[ Cancel ]`

  `[ Restore both ]` re-sends with `cascadeParents: true`. The response's `alsoRestored: BinEntry[]`
  drives the Toast: **"Restored — 2 records are back"**.

Both dialogs depend on `details` reaching the browser, which is why §1.7's socket-ack prerequisite is
built first. Without it an Office user gets an English sentence and no button.

### 5.6 States

- **Loading:** 8 `Skeleton` rows.
- **Empty, unfiltered** (the mockup's copy, kept verbatim):
  > **The bin is empty**
  > Deleted records land here and can be restored any time.

  No button. The design spec's "one action" is satisfied by the type chips already on screen, and a
  `[ Refresh ]` here would be a control that changes nothing.
- **Empty, filtered:**
  > **Nothing deleted of this type**
  > Choose another type, or clear the search.
  > `[ Everything ]`
- **Error:**
  > **Couldn't open the bin**
  > {message}
  > `[ Retry ]`

### 5.7 Components

`AppShell` · `Topbar` · `FilterBar` · `DataTable` · `CursorPager` · `StatusPill` · `IdField` ·
`Modal` · `Toast` · `Skeleton` · `EmptyState` · `ErrorState`.

---

## 6. Fields

### 6.1 Purpose

Edit the lists every form draws from: colours, product types, packaging, lead sources, pipeline
stages, and custom-field definitions. Reading is ungated by tier (`fields.view`); **editing is
management-and-up** (`fields.manage`, lowered from `admin` to `management` by this batch).

That split is deliberate and worth its sentence: letting any office-tier user rename a pipeline stage
would reorder every board in the company. Lowering a ceiling never strips a stored key, so no
tier-repair migration follows.

### 6.2 Shell

List screen. Topbar: title *Fields*, subtitle *The lists every form draws from*. Below it a `Tabs`
row of value sets — **rendered from `GET /api/fields/catalogue`, not from four names typed into the
renderer** — each with a count. `FIELD_LIST_KEYS` has four members
(`lead.sourcePlatform`, `stock.colour`, `product.productType`, `line.packaging`) and only
`stock.colour` carries a hex; see `03-DATABASE.md`. Pipeline stages and custom-field definitions are
their own tabs, not option-list sets. Content is two columns: a `DataTable` taking the remaining width, and
a 280px explainer `Card` on the right.

A note line under the tabs, `--t-small`:

> Values are data — removing one never touches the records that used it.

That is a factual claim the backend makes true: remove sets `deleted_at`, records keep their exact
string, and the UI still renders it.

### 6.3 Columns

Source type: `OptionListItem`. The column set is **driven by the catalogue's `FieldSetDefinition`**,
not by a `switch` on the set name.

| Column | Present when | Field | Type | Render |
|---|---|---|---|---|
| Chip | `set.carriesHex` | `hex` | `string \| null` | `ColourChip`: 14px circle, 1px ring. `null` → ring with the value's first two letters at 9px |
| Value | always | `label` (falling back to `value`) | `string` | text |
| Hex | `set.carriesHex` | `hex` | `string \| null` | `--t-mono`; `—` when null |
| Order | `set.ordered` | `sequence` | `number` | tnum, right-aligned, with a `DragHandle` |
| In use by | always | usage | `FieldUsage` | see below |
| — | always | — | — | `[ Edit ]`, `[ Remove ]` — absent without `fields.manage` |

**"In use by" is a second request and must render as one.** `GET /api/fields/usage` is deliberately
separate from `/api/fields/values` so the cheap read is not dragged down by grouped scans. So:

- while it is in flight, each usage cell is a `Skeleton`, not a `0`;
- if it fails, the cell is `—` with the Tooltip **"Usage count unavailable"**, never `0`. A confident
  zero next to a `[ Remove ]` button is how somebody deletes a value that is in use.

`stock_movements` is excluded from the count by design (it is the append-only ledger and no index
leads with `colour`), so the number answers *"is this in use"* rather than *"how many times has this
ever been touched"*. The column header carries that in a Tooltip: **"Counts live records, not
historical stock movements."**

`includeUnlisted` surfaces values present in the data with no `option_lists` row yet. Those render in
`--fg-tertiary` with a `[ Add ]` in place of `[ Edit ]` — the list is self-healing and never blocks a
write.

### 6.4 The explainer Card

280px, right column, one `Card` per set: a title and one paragraph. **These strings are client i18n
tokens (`fields.set.<listKey>.title` / `.body`), not served copy** — the catalogue serves
`labelToken`, `carriesHex`, `ordered` and `referencedBy`, and the prose belongs to the renderer.

Below it, on the Colours set only, a small legend showing both chip renderings side by side:

> **Known hex** ●  ·  **No hex — two-letter ring** ⟨CE⟩
> The chip is never the only signal — the colour name is always adjacent text.

### 6.5 Actions

| Action | Control | Permission | Notes |
|---|---|---|---|
| Read any set | — | `fields.view` | Sidebar entry absent without it |
| Add a value | inline row at the table's foot: `Input` + `[ Add ]` | `fields.manage` | Whole row absent without the key |
| Edit label / hex / active | row `[ Edit ]` → `Drawer` 520px | `fields.manage` | |
| Remove a value | row `[ Remove ]` → confirm `Modal` | `fields.manage` | |
| Reorder | `DragHandle`, or `↑`/`↓` with it focused | `fields.manage` | Sends the **complete ordered list**, not a delta |
| Archive a stage | `[ Retire ]` in the stage drawer | `fields.manage` | |
| Restore a stage | `[ Restore ]` on an archived row | `fields.manage` | |

**`value` is not editable, and the drawer must say why.** Editing the underlying string would
silently orphan every record holding the old one. The drawer shows `value` as read-only text in
`--t-mono` with the helper line: **"Records hold this exact text. Change the label instead."** The
same rule applies to a custom field's `key` and `entity`.

**Remove confirm:**
> **Remove {name}?**
> Records that already use it keep it. It stops being offered on new forms.
> `[ Remove ]` `[ Cancel ]`

**Retire a stage that is in use (409):**
> **12 leads are still in Quoted**
> Move them to another stage first, then retire this one.
> `[ Move them to Contacted ]` `[ Cancel ]`

The count and the offered target both come from the server's `details`. The client does not guess a
target stage.

**Add success Toast:** **"Added — syncs to every panel"**.

### 6.6 States

- **Loading:** 6 `Skeleton` rows, and a `Skeleton` on each tab's count.
- **Empty (a set with no values):**
  > **No colours yet**
  > Add one and it is available in every form the moment it syncs.
  > `[ Add colour ]`

  Per set, with the set's own noun. Without `fields.manage` the action is absent and the second line
  reads **"An administrator adds these."**
- **Error:**
  > **Couldn't load this list**
  > {message}
  > `[ Retry ]`

### 6.7 Components

`AppShell` · `Topbar` · `Tabs` · `DataTable` · `DragHandle` · `ColourChip` · `Card` · `Drawer` ·
`Input` · `Switch` · `Modal` · `Toast` · `Tooltip` · `Skeleton` · `EmptyState` · `ErrorState`.

---

## 7. Documents (PDF Designer)

### 7.1 Purpose

Design the templates that produce quotations, order confirmations and dispatch notes; preview one
against a real record; render and record the result. The largest module in the batch and the one
deliberately deferred once (`docs/LEAD_GENERATION_FLOW.md` §11).

Sidebar label: **Documents**. The screen carries two `Tabs` — *Designer* and *History* — and
"PDF Designer" names only the first. Flagged in §13 in case the owner wants the mockup's label kept.

### 7.2 Shell — Designer tab

Three panes inside the content region, and **not** a list screen (no FilterBar):

```
┌──────────────┬────────────────────────────────┬─────────────────┐
│ Templates    │  PREVIEW                       │ Template        │
│ 240px        │  A4 aspect, centred, scrolls   │ options 280px   │
│              │                                │                 │
│ Quotation    │  [ the document ]              │ Show rates  [•] │
│ Order conf.  │                                │ Colour chips[•] │
│ Dispatch     │                                │ Terms block [•] │
│              │                                │ …               │
│ Blocks       │                                │ Margins  ▭▭▭    │
│ ⋮⋮ Header    │                                │ Paper  A4  A5   │
│ ⋮⋮ Lines     │                                │ (A4 · A5 · Ltr) │
└──────────────┴────────────────────────────────┴─────────────────┘
```

Topbar: template name, `[ Preview with real lead ]`, `[ Save template ]` (primary).

### 7.3 Template list and blocks (left, 240px)

`DocumentTemplate` rows: `name`, and a sub-label from `documentType` (*From a lead* · *From an order*
· *At dispatch, no rates*). The default template for a type carries a `StatusPill` reading
**Default**. `CursorPager` in **Load more** shape at the foot — keyset on `(lower(name), id)`,
`prevCursor` always null.

Below the list, **Blocks** — the ordered layout sections (Header · Party block · Lines table ·
Totals · Terms · Signature), each with a `DragHandle`. Reordering writes `layout.blocks`, which is
the *only* thing `layout` holds (§7.4), so it is a normal edit and needs `documents.edit`. Selecting
a block expands its own options inline beneath it; the per-block option controls are listed in §7.4.

### 7.4 Options panel (right, 280px) — and the rate rule

Every control here is gated by `documents.edit`. **None of them writes into `layout`.** An earlier
draft of this section said the toggles were `layout` JSONB keys; that was wrong. The split is fixed
by `03-DATABASE.md` §5.2 (`document_templates`) and typed by `04-API-CONTRACT.md` §6.1
(`DocumentTemplate`, `DocumentLayout`):

- **Eight typed `BOOLEAN` columns** carry the on/off options. Each is `NOT NULL` with a default, so
  every template has an answer for every toggle — not a key that may or may not be present in a blob,
  where absent and false are indistinguishable.
- **Four `INTEGER` millimetre columns** carry the margins, and one `TEXT` column with a `CHECK`
  carries the paper size.
- **`layout` JSONB carries only block order and per-block options** — the drag list in §7.3, nothing
  else.

| Control | Type | Where it is stored | Column / field |
|---|---|---|---|
| Show rates | `Switch` | column | `show_rates` → `showRates` |
| Colour chips | `Switch` | column | `show_colour_chips` → `showColourChips` |
| Terms block | `Switch` | column | `show_terms` → `showTerms` |
| Company logo | `Switch` | column | `show_logo` → `showLogo` |
| Signature line | `Switch` | column | `show_signature` → `showSignature` |
| Party block | `Switch` | column | `show_party_block` → `showPartyBlock` |
| Page numbers | `Switch` | column | `show_page_numbers` → `showPageNumbers` |
| Draft watermark | `Switch` | column | `show_watermark` → `showWatermark` |
| Margins | segmented `Narrow / Normal / Wide` | columns | the four `margin_*_mm` columns → `margins` |
| Paper | segmented `A4 / A5 / Letter` | column | `paper_size` → `paperSize` |

`PaperSize` is `'A4' | 'A5' | 'Letter'`, matching the `paper_size` `CHECK` — see
`04-API-CONTRACT.md` §6.1. The segmented control therefore has three positions, not the two the
mockup draws. `DocumentType` has three members and **no `'invoice'`**, so the template list in §7.3
shows three sub-labels and never a fourth.

**What `layout` does hold**, and the only thing the options panel does *not* own, is the block list:
`{ blocks: DocumentBlock[] }`, one entry per section, carrying that section's own options —
`header.align`, `lines.groupByProduct`, `totals.showBoxCount`, `terms.text`, `signature.label`. The
type is owned by `04-API-CONTRACT.md` §6.1 and is not restated here.

That has a UI consequence worth stating, because it puts a second editor on this screen: a block's
own options are edited **on the block**, in the §7.3 drag list, not in this panel. Selecting a block
expands an inline sub-panel beneath it — a `Select` for `header.align`, a `Switch` for
`lines.groupByProduct`, a `Switch` for `totals.showBoxCount`, a `Textarea` for `terms.text`, an
`Input` for `signature.label`. Putting them in the right-hand panel would mix per-document options
with per-block options in one column and make the distinction invisible.

**Grammar violations are a 400, and the screen must be able to point at one.** `assertTemplateValid`
enforces that every `kind` appears at most once, that `lines` is mandatory, that `header` if present
is first, that `signature` if present is last, and that `terms.text` is at most 500 characters. The
refusal carries `{ field: 'layout', block: n, reason }`, so the screen resolves `block: n` to the
nth row of the drag list and attaches a `FieldError` to **that row** rather than showing a banner
over the whole pane. The grammar is stated in `04-API-CONTRACT.md` §6.1; the copy per `reason` lives
in the `documents.*` namespace (§10.1).

Client-side, the drag list enforces the same grammar as it drags — `header` cannot be dropped below
another block, `signature` cannot be dropped above one, and `lines` has no remove control — so the
400 is a backstop for a stale client, not the normal path.

**The rate rule, stated exactly.** `showRates` is a template *preference*. `field.saleRate.view` is
the *authority*, and it is evaluated server-side from the `ActorContext` at render time. A renderer
without the key produces a document with **no rate and no amount columns at all** — the columns are
absent from the page, not zeroed and not dashed, because a customer-facing document showing `₹0.00`
is worse than one showing no prices.

So the panel must show that, not hide it. When the signed-in user lacks `field.saleRate.view`:

- **Show rates** renders **off and disabled**, with a Tooltip: **"You can't see rates — needs
  `field.saleRate.view`"**. This is the one place §1.1's absent-not-disabled rule inverts, because the
  switch's *state* is the information.
- The preview renders the no-rates layout.
- The footnote under the panel reads:
  > Rates honour role redaction: a user without `field.saleRate.view` generates this PDF without the
  > rate columns.

  **The supplied mockup names `products.rate.view` here. That string does not exist in the permission
  catalogue and the copy must not ship with it.**

### 7.5 Save, and the version conflict

`expectedVersion` is **mandatory** on a template edit (`master/src/domain/access.ts:183-192` throws
when it is omitted, with `storedVersion` attached). `[ Save template ]` always sends the version it
loaded.

- **Stale (409 with `details.storedVersion` and `details.diff`).** A `ConflictBanner` above the
  preview — never an auto-apply, never a silent overwrite:
  > **Somebody else saved this template**
  > Margins and Show rates differ from what you have open.
  > `[ Reload theirs ]` `[ Overwrite with mine ]`

  The differing field names come from `details.diff`. This mirrors the role editor's behaviour added
  in the second wave of audit fixes, and reuses the same component.
- **Duplicate name (409 with `details.field` and `details.value`).** Inline `FieldError` on the name
  `Input`: **"A template called {value} already exists."**

### 7.6 Preview — two different things, labelled as two different things

| | Live approximation | Real preview |
|---|---|---|
| Trigger | any toggle change | `[ Preview with real lead ]` |
| Source | client-side HTML mock of the layout | `POST /api/documents/preview`, real PDF bytes |
| Fidelity | layout only | exact — same renderer as a real export |
| Cost | none | a server render |

The live approximation is labelled **"Approximate — fonts, rates and totals come from the Master"** in
`--t-small` at the top of the preview pane. Without that label the mockup implies WYSIWYG, and it is
not: Devanagari shaping, real line data and rate redaction all happen on the Master.

The real preview forces the **PREVIEW** watermark on, writes no file, creates no `document_exports`
row and writes no activity entry. It is rendered from the returned bytes via an object URL in an
`<object type="application/pdf">`; if the embedded viewer is unavailable the pane falls back to
`[ Open preview ]`, which opens the same object URL in a new window. Nothing is fetched over the
network — the bytes are already in the page.

Preview needs `documents.render` **and** the subject's own view key (`leads.view` / `orders.view`).
Without either, `[ Preview with real lead ]` is absent.

### 7.7 History tab

`DataTable` over `GET /api/documents/exports`, `CursorPager` in Newer / Older shape.

| Column | Field | Type | Render | Align |
|---|---|---|---|---|
| When | `createdAt` | `IsoTimestamp` | `dd MMM HH:mm` | left |
| Document | `templateName` | `string` | text — denormalised, so a deleted template still reads correctly | left |
| Subject | `subjectKind`, `subjectId` | `string` | type token + `IdField` | left |
| Rates | `ratesIncluded` | `boolean` | `StatusPill`: **With rates** / **No rates**. **Never blank** | left |
| Pages | `pageCount` | `number` | tnum | right |
| Size | `byteSize` | `number` | `KB` / `MB`, tnum | right |
| — | — | — | `[ Download ]` | right |

`ratesIncluded` is the audit-grade fact that the copy sent to this customer carried no prices. It is
a `StatusPill` in both states, never an empty cell, because an empty cell reads as unknown.

Rows whose subject kind the caller may not view are **filtered out server-side** rather than the
request being refused, so a dispatch clerk with `orders.view` and no `leads.view` sees a coherent
list instead of a 403. The screen does not need to explain that, and must not invent a "hidden rows"
count it cannot compute.

### 7.8 Actions

| Action | Control | Permission |
|---|---|---|
| See templates, previews, history | — | `documents.view` |
| Create a template | `[ New template ]` | `documents.create` |
| Edit / reorder blocks / upload logo | options panel, drag handles | `documents.edit` |
| Delete a template | `[ Delete ]` in the template's overflow | `documents.delete` (management+) |
| Restore a template | via the Recycle Bin | `documents.delete` |
| Preview | `[ Preview with real lead ]` | `documents.render` + subject view key |
| Render | `[ Generate ]` from a lead or order screen | `documents.render` + subject view key |
| Download an export | `[ Download ]` | `documents.view` + subject view key |

Logo and signature upload is a JSON body carrying a base64 data URL, PNG/JPEG only, 512KB cap. The
upload control states the limit before the user picks a file — **"PNG or JPEG, up to 512 KB"** — and
an over-size file is rejected client-side with that same sentence rather than round-tripping to a
server refusal.

### 7.9 States

- **No templates:**
  > **No templates yet**
  > A template decides what a quotation or a dispatch note looks like.
  > `[ New template ]`
- **No exports:**
  > **Nothing printed yet**
  > Every document you generate is recorded here, with whether it carried rates.
  > `[ Open templates ]`
- **Rendering:** the logo busy indicator over the preview pane with **"Rendering the quotation…"** —
  naming what is loading, per the design spec §14.
- **Render failed:**
  > **Couldn't render the document**
  > {message}
  > `[ Try again ]`

### 7.10 Components

`AppShell` · `Topbar` · `Tabs` · `Card` · `DataTable` · `CursorPager` · `DragHandle` · `Switch` ·
`Input` · `StatusPill` · `IdField` · `ConflictBanner` · `Modal` · `Toast` · `FieldError` ·
`Tooltip` · `Skeleton` · `EmptyState` · `ErrorState`.

---

## 8. The Office equivalents

Same screens, same components, same tokens, same copy — with the differences below and no others.
Building them as forks of the Master screens would guarantee drift; they are the same screen
components with a different data client.

**What is identical:** every column, every filter, every permission gate, every empty state, every
conflict dialog.

**What differs, for all five:**

1. **Chrome.** The Office follows the machine's theme; the Master is permanently dark.
2. **Transport.** Every request goes to a loopback route in `office/src/http/app.ts` that
   `forward()`s to the Master, and can answer `503 { error: 'unavailable' }`.
3. **The offline state exists.** On the Master these screens have no offline state at all; the Master
   *is* the server. On the Office each one has the state specified below, and it replaces the content
   region entirely — a half-populated screen is worse than an honest one.
4. **Nothing is queued.** Not a delete, not a restore, not a field edit, not a render. The outbox is
   for writes that can be merged; none of these can. A queued render would emit a legally-shaped
   quotation hours later against a lead whose lines had since changed.

### 8.1 Office Logs

Offline:
> **Logs need the Master Panel**
> The audit trail lives on the Master. Nothing is stored on this panel.
> `[ Retry ]`

`[ Export CSV ]` is **absent on the Office Panel** for now. A 250,000-row CSV returns as one value in
a single socket ack, buffered whole on both sides, through a 15-second timeout
(`office/src/realtime/master-connection.ts:237-245`) — `docs/BACKEND_MODULES.md` §8.2 lists this as
needing a decision before
the export endpoints ship. Rendering the button before that decision would be a control that fails.
`logs.export` still gates the Master path. See §13.

### 8.2 Office Reports

Offline:
> **Reports need the Master Panel**
> Totals are computed on the Master so they cover every record — not the 500 this panel caches.
> `[ Retry ]`

That second line is the actual reason and is worth saying: `SNAPSHOT_LIMIT` is 500 rows per
collection and excludes converted leads, so a 12-month total computed from the cache would be
silently and confidently wrong. An honest "cannot reach the Master" is strictly better.

`[ Export CSV ]` absent for now, same reason as §8.1.

### 8.3 Office Recycle Bin

Offline:
> **The Recycle Bin needs the Master Panel**
> Deleted records live on the Master and are restored there.
> `[ Retry ]`

Restore cannot be queued: a restore that fires two hours later can collide with a name created since,
and the rename-on-collision decision needs a human looking at the answer.

### 8.4 Office Fields

Offline:
> **Fields need the Master Panel**
> Colours and stages you already have keep working in forms — this screen edits the master list.
> `[ Retry ]`

The second line is precise and matters. The panel's `SyncSnapshot` still carries `optionLists`,
`customFields` and `pipelines`, so pickers, custom-field forms and the Kanban columns all render
offline exactly as today — and because a colour's hex now rides on the `option_lists` rows already in
that snapshot, **colour chips work offline for free**, with no snapshot growth. What the *management*
screen needs and the snapshot does not have is usage counts, archived values, and values present in
the data with no row yet. Falling back to the snapshot would produce a management screen that is
silently missing three of its five columns.

Editing controls follow §1.1: an office-tier user holds `fields.view` but not `fields.manage`, so
they see the table with no `[ Add ]` row, no `[ Edit ]`, no `[ Remove ]` and no drag handles — a
clean read-only screen, not a wall of disabled buttons.

### 8.5 Office Documents

Offline:
> **Printing needs the Master Panel**
> Documents are rendered on the Master so rates match your permissions and every copy is recorded.
> `[ Retry ]`

Preview and download bytes come back through the socket ack as a `Uint8Array` (Socket.IO sends binary
as a separate attachment, avoiding base64's 33% inflation) and the Office server streams them to its
own browser as `application/pdf`. Two UI consequences:

- The busy indicator is the logo mark, never a progress bar — the ack gives no progress events and a
  fake progress bar is a lie.
- **A timeout and a disconnection arrive as the same status, and the screen must separate them.**
  `masterConnection.command` rejects a 15-second timeout with `unreachable: true`
  (`office/src/realtime/master-connection.ts:237-245`), so `forward()` answers `503 unavailable` for
  both "not connected" and "connected but did not answer". The screen disambiguates from the panel's
  own connection state (`GET /api/connection` → `state`), which is local and always available: if the
  state is `connected` and the request still came back 503, it was a timeout, and the copy says so
  rather than claiming the Master is unreachable when the rail says it is not.
  > **The Master didn't answer in time**
  > The document may be too large to send to this panel. Try generating it on the Master.
  > `[ Try again ]`

  This is the only place in the batch where 503 needs disambiguating, because it is the only forwarded
  call that can legitimately take fifteen seconds.

---

## 9. Office Dashboard

### 9.1 Purpose

The Office Panel has no dashboard today. This is the one net-new screen for a user who is not an
administrator, and it is the screen that has to make the offline promise legible: every card is
either live, or honestly stale, and the difference is visible without opening anything.

### 9.2 Shell

Card grid, no FilterBar. Topbar: title *Dashboard*, today's date, `[ New lead ]` (primary, gated
`leads.create`). Content: a row of four small `Card`s, then a 2×2 grid of four panel `Card`s.

### 9.3 The data behind it

`DashboardSummary` (`shared/src/domain/entities.ts:567-580`) is **extended, not replaced**: every
counter becomes optional so a figure the actor may not see is **absent, never `0`**, plus
`openOrderCount?`, `dispatchedThisWeekCount?`, `pipelineBreakdown?` and `asOf`. It rides on
`SyncSnapshot.dashboard`, computed **per actor** on the Master, so the panel's normal path costs zero
new Office routes — `/api/snapshot` and the SSE `snapshot` event already carry it, and
`forCurrentUser()` (`office/src/http/app.ts:395-407`) re-filters it for whoever is signed in now.

Counting client-side from the snapshot was rejected for a concrete reason: `SNAPSHOT_LIMIT` is 500 and
converted leads are excluded, so client-side counts would be silently wrong at scale. Online the panel
gets a correct figure; offline it gets an honestly-labelled stale one.

### 9.4 The eight cards

| # | Card | Shows | Source | Permission | When the Master is unreachable |
|---|---|---|---|---|---|
| 1 | Open leads | count, plus *“{n} due for follow-up today”* | `leadCount`, `followUpsDueCount` | `leads.view` | Last cached figure, dimmed, with the staleness line |
| 2 | Open orders | count | `openOrderCount` | `orders.view` | Last cached figure, dimmed |
| 3 | Dispatched this week | boxes | `dispatchedThisWeekCount` | `orders.view` | Last cached figure, dimmed |
| 4 | Sync | state word + pending count | the **panel itself** (`SyncState`, `pendingCount`, `lastSyncedAt`) | none | **Stays live and authoritative** — it is a fact about this machine |
| 5 | Lead pipeline | one `BarRow` per stage: name, count, value | `pipelineBreakdown` | `leads.view`; value additionally `field.saleRate.view` | Last cached breakdown, dimmed |
| 6 | Follow up today | the count, and `[ Open leads due today ]` | `followUpsDueCount` | `leads.view` | Last cached figure, dimmed; the action still works offline (it filters the cached list) |
| 7 | Low stock | product · colour chip · free boxes, top 5 | the snapshot's own stock levels | `inventory.view` | **Renders from cache and says so** — this is the one panel card that is genuinely useful offline |
| 8 | Recent activity | last 5 log entries | `GET /api/logs?limit=5`, forwarded live | `logs.view` | The one card that empties: *“Recent activity needs the Master Panel.”* |

Card 4 is the anchor of the whole screen. It never shows a stale value, because it is computed from
the panel and nothing else, and it agrees with the presence rail and the status footer by
construction.

Cards 1–3 and 5–6 render from the cached `DashboardSummary`; card 7 from the cached snapshot; card 8
alone requires the Master.

### 9.5 How staleness is communicated

Three signals, in increasing specificity, and all three are always consistent:

1. **The presence rail** — a 3px full-height strip on the extreme left, `--state-offline` solid when
   there is queued work and at 40% opacity when there is not. Peripheral, permanent, no dialog.
2. **The status footer** — *Offline* / *Offline — 4 pending*.
3. **Per-card, on cards 1–3 and 5–7**: the value dims to `--fg-secondary` and a line appears beneath
   it in `--t-small` `--fg-tertiary`:
   > As of Today 12:41

   `asOf` comes from the summary. When the Master is reachable that line is absent — a card that is
   current says nothing, because saying "live" on every card teaches nothing and steals a line.

**A stale figure is never hidden and never replaced by a spinner.** The number the panel had at
12:41 is the truest thing it knows, and blanking it in favour of a dash would make an offline panel
look broken rather than offline.

**A figure the actor may not see is absent, not zero.** Card 2 without `orders.view` is not rendered
at all and the row reflows to three cards. This is the same rule as §1.3, applied to a whole card
instead of a cell.

### 9.6 States

- **First paint, never synced:** all cards `Skeleton`, card 4 already live.
- **Empty pipeline** (card 5):
  > **No open leads**
  > Leads you create appear here, online or off.
  > `[ New lead ]`
- **Empty low stock** (card 7):
  > **Nothing low on stock**
  > Products at or below their reorder level show up here.
- **Card 8 offline:**
  > **Recent activity needs the Master Panel**
  > `[ Retry ]`

### 9.7 Components

`AppShell` · `Topbar` · `Card` · `BarRow` · `ColourChip` · `StatusPill` · `Timeline` (card 8) ·
`PresenceRail` · `StatusFooter` · `Skeleton` · `EmptyState`.

Card 8 is the only place `Timeline` appears in this batch: message, then `when · actor` in
`--t-small`, with a 6px state dot at the left (`--state-ok` for a completed action, `--state-offline`
for something saved offline, `--line-strong` otherwise).

---

## 10. The i18n surface

The server never renders a user-facing sentence. It returns a stable `messageKey` plus named params;
the client renders. That is forced rather than chosen — locale is per-machine and never synced, so a
Master serving several panels has no recipient locale to render for.

Both catalogues are compiled TypeScript, bundled into each panel before it ever contacts a Master.
`hi.ts` is typed `Record<MessageKey, string>` — **total, not partial** — so **every token listed below
turns the build red until Hindi exists**. That interlock is the point, and it is why the tokens are
enumerated here rather than discovered screen by screen during Phase 3.

**Where the i18n work actually lands in this batch.** `shared/src/i18n/` — the `MessageKey` union, the
`en` and `hi` catalogues, `activityMessageKey()` and the `en-XA` pseudo-locale — **is in scope**, and
it is **fully testable through `shared/tests/` without a single web file**: the catalogues are plain
compiled TypeScript, so totality, key coverage and the `activityMessageKey` contract are all pure
assertions. Nothing about the deferral below leaves i18n unverified.

What is **deferred to the UI phase** is the wiring, not the catalogue: `master/web/src/i18n/*`,
`office/web/src/i18n/*`, `components/LocalePicker.tsx`, `components/Untranslated.tsx`, `main.tsx`,
`styles.css` and `format.ts` are all UI-phase files. The only two web files in this batch remain
`master/web/src/api.ts` and `office/web/src/api.ts`. §10.2 and §10.3 therefore specify behaviour the
UI phase must implement; they do not describe files this batch writes.

### 10.1 Namespaces per screen

Each row is marked **batch** or **UI phase**. The rule behind the split is mechanical: a namespace
whose keys are determined by a backend constant — a catalogue entry, an enum member, an `AppError`
code, a server-minted discriminant — is minted now in `shared/src/i18n/`, because the shared test that
asserts its coverage is a backend test and would otherwise have nothing to assert against. A namespace
that exists only to label a control or a copy block waits for the screen that carries it.

| Namespace | Minted | Owned by | Contains |
|---|---|---|---|
| `module.*` | **batch** | sidebar | `module.logs`, `module.reports`, `module.recycleBin`, `module.fields`, `module.documents`, `module.dashboard` |
| `permission.*` | **batch** | permission grid | one per new key — `permission.logs.view`, `.logs.export`, `.logs.verifyChain`, `.recycleBin.view`, `.recycleBin.viewAll`, `.fields.view`, `.documents.view`, `.documents.create`, `.documents.edit`, `.documents.delete`, `.documents.render` |
| `log.action.*` | **batch** | Logs, Dashboard card 8 | one per value of `activity_log.action` — the 13 real ones (`created`, `updated`, `deleted`, `restored`, `deactivated`, `password_reset`, `password_changed`, `sign_in`, `sign_in_failed`, `stage_changed`, `dispatched`, `inbound`, `adjusted`) plus whatever the new modules mint (`exported`, `rendered`, `verified`, `archived`) |
| `log.entity.*` | **batch** | Logs, Recycle Bin, Documents history | one per `entity_type` written to the log |
| `log.chain.*` | **batch** | Logs verify | `verified`, `broken.hashMismatch`, `broken.prevHashMismatch`, `broken.sequenceGap`, `unverifiable` |
| `bin.entity.*` | **batch** | Recycle Bin | one per `RecycleBinEntityType` |
| `bin.restore.*` | **batch** | Recycle Bin | `success`, `nameTaken`, `parentDeleted`, `cascade` |
| `fields.set.*` | UI phase | Fields | per `listKey`: `.label`, `.title`, `.body`, `.addPlaceholder`, `.emptyNoun` |
| `fields.value.*` | UI phase | Fields | `immutableValue`, `usageUnavailable`, `usageCountsLive`, `removeConfirm`, `stageInUse` |
| `reports.*` | UI phase, except `outcome.*` (**batch** — keyed off `LeadOutcome`) | Reports | `dispatches`, `leadOutcomes`, `topParties`, `range.thisMonth`, `range.3m`, `range.12m`, `outcome.converted`, `.lost`, `.quiet`, `.open`, `city.unknown`, `orderedBy.value`, `orderedBy.orderCount`, `note.*` per report |
| `documents.*` | UI phase, except `type.*` (**batch** — keyed off `DocumentType`), `block.*` (**batch** — keyed off `DocumentBlockKind`) and the `assertTemplateValid` `reason` values (**batch**) | Documents | `type.quotation`, `.orderConfirmation`, `.dispatchNote`, `block.*` (six, one per `DocumentBlockKind`), `option.*` (ten, one per §7.4 control), `layout.reason.*` (one per `assertTemplateValid` violation), `rates.included`, `rates.excluded`, `preview.approximate`, `preview.rendering` |
| `dashboard.*` | UI phase | Dashboard | one per card title, one per subtitle, `asOf`, `stale` |
| `state.*` | UI phase | shared, all screens | `empty.*`, `error.*`, `offline.*` — one per exact copy block in §3–§9 |
| `error.*` | **batch** | shared | one per `AppError` code, including the Office's own `error.unavailable` |
| `month.*` | UI phase | Reports | twelve month names, looked up from the `'YYYY-MM'` label. **Never** produced by formatting a `Date` |

`activityMessageKey(entityType, action)` is the contract Logs and Dashboard card 8 both render
against. `master/tests/i18n-tokens.test.ts` scans the services' `recordActivity(entry, actor, trx)`
call sites and asserts every `(entityType, action)` pair has a catalogue entry — which is what keeps
the `log.action.*` list honest as new modules mint new verbs. Both that suite and the shared coverage
suite are **batch** work; neither needs a screen to run.

`bin.entity.*` is the one **batch** namespace that grows *during* the batch rather than landing whole:
`RECYCLE_BIN_ENTITIES` ships six members at the Recycle Bin stage, gains two at the Fields stage and
one at the PDF stage — see `11-BUILD-SEQUENCE.md`. The coverage assertion is therefore "one token per
member of today's `RECYCLE_BIN_ENTITIES`", which stays true at every stage, rather than a hard count
of nine.

### 10.2 The LocalePicker

`components/LocalePicker.tsx` is a **UI-phase file**, on both panels, and is not written in this
batch. What follows is the contract it must satisfy — including the ungated ruling, which is a
permission decision and therefore settled now (`08-PERMISSIONS.md` §3.2) rather than at render time.

Lives in **Settings → Appearance**, beside Theme and Density, on **both** panels. Per-machine, never
synced — exactly like theme and density.

- A `Select`, not a `Switch` — a switch implies two options forever and the third will arrive.
- Each label is written **in its own script**: `English`, `हिन्दी`. That comes from
  `LOCALE_LABELS` and is never translated into the current locale.
- **Ungated.** No permission key. Gating it behind `settings.manage` (tier `admin`) would stop an
  office-tier user reading their own screen in Hindi, which inverts the module's purpose. This is the
  one surface in the batch that is correctly ungated, and that is a decision, not an omission.
- Changing it re-renders immediately: no reload, no server call, and **it works with the Master
  switched off**, because both catalogues are already in the bundle.
- It sets `lang` on `<html>` so `:lang(hi)`'s `+2px` line-height applies at every scale step, and
  persists to `localStorage`.
- The initial value comes from `defaultLocale` on `/api/auth/me` (Master) and `/api/session`
  (Office), so a fresh browser profile on a Hindi-deployed machine starts in Hindi. The Office's
  `/api/session` is registered **before** the `requireUser` gate at `office/src/http/app.ts:133`, so
  the sign-in screen renders in the right language before anyone has signed in.

### 10.3 Rules the screens must not break

- **No string concatenation.** Every message is one keyed template with named placeholders. *"2 due
  for follow-up today"* is one key with `{count}`, not two spans.
- **Layouts survive 1.4× expansion.** Buttons size to content; no fixed-width labels; the dev-only
  `en-XA` pseudo-locale pads every string to 1.4× and brackets it, so this is testable rather than
  aspirational.
- **Never bake text into an SVG.** The logo mark is a lattice, not a word.
- **Numbers, ids and fingerprints are never translated or reformatted.** They are wrapped in
  `<Untranslated>`, which documents that a string is an identifier rather than prose.
- **A server-minted value with no token falls back to the raw string, visibly.** `action` and
  `entity_type` are free-form `TEXT`. An unknown one renders as its raw value in `--t-mono` rather
  than as a missing-key placeholder — a raw `stage_changed` is readable, `⟦log.action.stage_changed⟧`
  is not. The `i18n-tokens` test is what stops that fallback becoming the normal case.

---

## 11. What the backend must serve that the plan does not yet

Each of these was a column or a card in this document with no field behind it. Two are now closed by
a ruling and are kept in the table, marked, so the decision is visible rather than silently absorbed;
the rest still need a decision before Phase 3 starts, and all of them are cheap now.

| # | Screen | Missing | Recommendation |
|---|---|---|---|
| 1 | Logs, Entry hash column (§3.3) | **CLOSED — no longer missing.** `ActivityLogEntry` now carries `hash: string \| null`; see `04-API-CONTRACT.md` §2.1 | **Done.** It digests data the holder of `logs.view` already sees, so it needs no key of its own, and it is the only thing that makes "hash-chained" visible to a person rather than asserted |
| 2 | Reports, Lead outcomes side table (§4.5) | `LeadOutcomeMonthBucket` is `{ month, converted, lost, quiet, open }` — four **counts** and no money field at all (`04-API-CONTRACT.md` §3.1). An earlier draft of this row claimed it carried a single `totalValue?`; it does not, and the correction makes the gap wider, not narrower. The *Conversion* table's Amount column has nothing behind it | Unchanged by the correction: either add `valueByOutcome?: Record<LeadOutcome, number>` to the bucket, gated on `field.saleRate.view` like every other money key, or **drop the Amount column** from that one side table. Do not sum it client-side from months — the months are counts, so there is nothing to sum |
| 3 | Reports, Top parties bars (§4.3) | The mockup's bars are **boxes** per party; `TopPartyRow` carries `orderCount` and `totalValue?` and no box count | **Draw the bar from `orderCount`** and label it *Orders*. Adding a box count means another join on `stock_movements` for a leaderboard |
| 4 | Dashboard card 2 (§9.4) | The mockup's subtitle is *“840 boxes reserved”*; no such figure exists on `DashboardSummary` | **Drop the subtitle.** A reserved-box total is a fourth figure, and the batch is scoped to three |
| 5 | Dashboard card 3 (§9.4) | The mockup's subtitle is *“₹76,400 across 1 order”*; `dispatchedThisWeekCount` is a box count only | **Drop the subtitle**, or add `dispatchedThisWeekValue?` + `dispatchedThisWeekOrders?` and gate the money half on `field.saleRate.view` |
| 6 | Office, everything (§1.7) | `office/web/src/api.ts:87-100` throws a bare `Error` with no `code` and no `details`, so the browser cannot distinguish 503 from 403 | **Add an `ApiError` mirroring `master/web/src/api.ts:41-68`.** Without it, none of the offline or permission copy in this document can be selected. In scope for this batch — it is a client wrapper, not a screen |
| 7 | Fields, explainer prose (§6.4) | The mockup serves per-set title and body text | **No backend work.** These are client tokens `fields.set.<listKey>.title` / `.body`; the served catalogue needs only `labelToken`, `carriesHex`, `ordered`, `referencedBy` |

Item 1 is closed by ruling. Items 2–5 are backend decisions still open. Item 6 is a client wrapper —
`master/web/src/api.ts` and `office/web/src/api.ts` are the only two web files in this batch, so it is
in scope. Item 7 is closed by stating it.

---

## 12. Where the supplied design disagrees with this specification

Listed the way `docs/UI_REDESIGN.md` §4 and `docs/ROLES_AND_USERS.md` §16 list their divergences —
so none of them is later mistaken for an oversight in either direction.

1. **Reports: *“Runs on this machine — no server round-trip.”*** False here, and the copy must not
   ship. Aggregation is server-side in the Master precisely because the panel's cache is capped at 500
   rows per collection; a locally-computed total would be silently and confidently wrong.
2. **PDF Designer: the permission key `products.rate.view`.** That string does not exist in the
   catalogue. The real key is **`field.saleRate.view`**, and the footnote must name it.
3. **`docs/UI_REDESIGN.md` §5 scopes Fields, Logs, Recycle Bin, Reports and PDF Designer as
   `master/web` admin-only.** Superseded: the owner's decision is that **all six modules are
   permission-gated and reachable from both panels**. That doc's §5 table and §9 open questions need
   reconciling when Phase 3 starts.
4. **The design spec assumes one unified 13-module shell and a headless Master** (*“Master Panel:
   headless, do not build one”*, §8). The real product is two apps with different users, and the
   Master has a full UI it keeps. The sidebar groups are adopted; the single-shell assumption is not.
5. **The design spec's Developer Panel** does not exist as a third app. Its permanently-dark chrome
   is applied to `master/web` instead, at zero token cost — the owner's decision.
6. **Recycle Bin scope.** The mockup shows one flat list. The real scope is `deleted_by = me` unless
   the actor holds `recycleBin.viewAll`, and the screen says so (§5.3). The mockup also implies every
   row is restorable by whoever is looking; restore is gated by the entity's own delete key.
7. **Fields: the mockup's `Edit` is the only row action.** The real screen needs `Remove` and, on
   ordered sets, a keyboard-reachable drag handle — and all three are absent, not disabled, for a
   reader without `fields.manage`.
8. **The per-screen Light/Dark buttons and the "Demo — set connection state" popover controls** in
   every mockup are Claude Design preview affordances. Neither ships. Theme lives once, in Settings;
   the presence rail reflects real sync state.

---

## 13. Open questions

Genuinely open. Each is flagged rather than answered, and each blocks a specific piece of Phase 3.

1. **How should a large CSV or PDF export reach the Office Panel?** `docs/BACKEND_MODULES.md` §8.2:
   250,000 rows in one socket ack, buffered whole on both sides, through a 15-second timeout. This
   document specifies `[ Export CSV ]` as **absent on the Office Panel** until it is decided (§8.1,
   §8.2). Cap it far lower, chunk it, or declare export Master-only — but a control that times out is
   worse than one that is not there.
2. **Sidebar label: *Documents* or *PDF Designer*?** The screen carries a Designer tab and a History
   tab, and the mockup's label names only the first. Recommended: **Documents**, with the Designer tab
   keeping the name the owner already knows.
3. **Items 2–5 in §11** — the lead-outcome per-outcome value, the top-parties bar metric, and the two
   Dashboard subtitles. Each is a one-line answer that determines whether a column exists. Item 1, the
   Logs `hash` field, is **no longer open**: `ActivityLogEntry` carries `hash: string | null` and the
   Entry-hash column is backed.
4. **Does the Office Dashboard's *Follow up today* card need row data, or is the count enough?**
   Specified here as a count plus an action into the cached leads list (§9.4, card 6), because the
   batch extends `DashboardSummary` by three figures and a row list is a fourth thing. Confirm.
5. **Should the Fields management screen fall back to the snapshot when offline?** Specified here as
   **no** (§8.4), because usage counts, archived values and unlisted values are not in the snapshot
   and a screen missing three of five columns is worse than an honest banner. Confirm.
6. **Module-level filtering of the Office cached snapshot** remains open
   (`docs/BACKEND_MODULES.md` §8.1): `forCurrentUser()` (`office/src/http/app.ts:395-407`) re-masks
   `field.saleRate.view` for whoever is signed in now — that half is fixed — but still hands the
   browser every lead and order row regardless of `leads.view`. **This batch must not widen it.** No
   screen in this document adds a collection to `SyncSnapshot`; the Dashboard adds one
   permission-filtered object and nothing else.
