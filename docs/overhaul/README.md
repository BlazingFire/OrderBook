# OrderBook — stability, feature and UI overhaul

## Context

> **2026-09-21:** pricing (rates, amounts, totals, the `field.*Rate.*` permissions and field-level
> masking) has since been removed from the product, and the product master trimmed to name ·
> category · alias · size · colour switch, with variants of code · colour · weight. Where a
> workstream below describes money or the wider product attributes it is historical — see
> `HANDOFF.md` Key decision 15.

The owner reported that the two panels "close automatically sometimes" and asked, in one message, for
a stability fix plus fourteen further changes spanning the Electron shell, the UI system, the data
model, security, performance, an AI section and an external-API layer.

Three exploration passes mapped the repo (~68,600 lines of TypeScript, 3,300 lines of CSS, 61 test
files). Ten workstreams were then designed and each adversarially reviewed against the real code;
the reviewers raised **218 findings, 51 of them blockers, and not one design survived unchanged**.
This plan is the corrected, sequenced result.

Four ambiguous requirements were settled by the owner:

- **Passwords** — the Master panel may show a user's password in plaintext; the Office panel never
  shows any password; a Master setting turns the plaintext view off.
- **External API** — both directions: a keyed REST API *and* a generic outbound connector. "Hermes"
  becomes a saved profile, not code.
- **AI** — Qwen2.5-VL-7B-Instruct via Ollama, LM Studio, or an OpenRouter key; all four capabilities.
- **Minimum screen** — the floor drops to **1024×768**, superseding the 1366×768 project rule.

Miracle (RKIT) inspiration is scoped to the three things the owner named: dense master forms, grid
voucher entry, and report exports. Keyboard work is the full version.

---

## Verified findings

Confirmed by reading the code directly, not inferred.

### 1. The closing bug — diagnosed and **already fixed this session**

[office/electron/main.ts:131](office/electron/main.ts:131) polls `/api/health`. Grepping the whole
`office/` tree, the only occurrences of that path were in the shell file itself. **The Office server
defined no such route.** The request hit the blanket `app.use('/api', requireUser)` gate and returned
401, so `waitForServer` burned its full 60-second deadline and `createWindow` landed on the "did not
start in time" splash, permanently.

A second, independent defect compounded it: `requestSingleInstanceLock()` quit with no dialog and no
log. Run from source, both panels shared Electron's default `userData` directory — which is what the
lock is keyed on — so launching Office while Master ran made Office die instantly and silently.

**Fixed and verified:** Office now serves `/api/health` above the auth gate returning the Master's
`{status, boot}` contract; both panels call `app.setName()` so each owns its own lock; losing the
lock now shows a dialog instead of exiting silently; Office gained the JSON `notFoundHandler` /
`errorHandler` that Master already had. Both panels now boot side by side from source with no
`--user-data-dir` workaround, and Office renders its real pairing screen. Typecheck clean; office
tests 67/68 (the one failure, `storage-path.test.ts:138`, asserts POSIX permission bits on Windows
and pre-dates this session).

### 2. Editing a product or party silently destroys data

[product.repository.ts:323](master/src/repositories/product.repository.ts:323) `columnsFrom()` returns
every column with `?? null`, and [:162](master/src/repositories/product.repository.ts:162) spreads it
into `.update()`. `updateProduct` is a **full record replace, not a patch**. The only product form in
the app exposes 8 of ~20 columns, so every edit nulls `finish`, `series`, `color`, `thickness_mm`,
`pieces_per_box`, `box_coverage_sqft`, `price_per_sqft`, `hsn_code`, `category_id`, `parameters` and
`custom_fields`. [party.repository.ts:252](master/src/repositories/party.repository.ts:252) is
identical; the 5-field party drawer wipes `alt_phone`, `email`, `address_line1/2`, `state`, `pincode`.

Compounding it, `catalog.service.ts:303,:347` pass `fieldHlc: {}` on every online write, emptying the
per-field clock map the sync merge depends on — so `merge.ts:88-116` is dead code today.

**This is a loaded gun, not a smoking one.** `master/web/src/api.ts` has no `put`/`patch` at all and
Master has no product or party screen, so on the evidence it has never fired on a shipped install.
It fires the first time a Master form ships. Damaged rows are **not** recoverable from the activity
log (`action:'updated'` is recorded with no `details`); only a `.obbackup` or an Office snapshot holds
old values.

### 3. The UI-scale hook already exists and is unused

[tokens.css:136](master/web/src/ui/tokens.css:136) declares `--root-size: 14px` and `:192` applies
`html { font-size: var(--root-size) }`. Every type role is rem off it. A continuous scale control
hooks the same variable — no new mechanism needed.

### 4. Twenty-six paths are untracked, including two shipped migrations

`git status` reports 73 modified files and 26 untracked paths, among them:

```
master/src/db/migrations/20260313000000_panel_app_version.ts
master/src/db/migrations/20260313000000_party_access.ts
```

Both are in the `SHIPPED` list of `master/tests/migration-registry.test.ts`, whose docblock records
the 2026-08-27 incident where deleting a shipped migration made Knex refuse to boot with *"The
migration directory is corrupt"*. Neither is gitignored. A `git clean -fd`, a fresh clone or a bad
merge locks every installed database out of its own data — the identical failure, a second time —
**and the registry test cannot catch it because the test file is untracked too.**

Also untracked: the entire desktop layer, the entire Party Access module, and the entire update /
version subsystem. Roughly half the surface this programme depends on exists only in one working
directory.

---

## Stage sequence

Thirteen stages. `∥` may run concurrently with each other; everything else is strictly ordered.

| # | Stage | After | Why here |
|---|---|---|---|
| **0** | Repo safety | — | Two SHIPPED migrations are one `git clean` from gone |
| **1** ∥ | Data-integrity core | 0 | The only live data-loss bug; gates every later write path |
| **2** ∥ | Electron shell | 0 | Requirements 1 & 7 |
| **3** | `@orderbook/ui` + i18n fold + React 19 | 0 | Structural blocker for every UI stage |
| **4** ∥ | Settings + password vault | 0 | Gates AI config, connector secrets, reveal toggle |
| **5** | Screen keep-alive + DataTable | 3 | Requirement 4 |
| **6** | UI scale, 1024→4K, fluency | 5 | Requirements 3 & 10 |
| **7** | Performance and memory | 3, 5 | Requirement 11 |
| **8** | Product & party attributes | 1, 4 | Requirement 8 |
| **9** | Picker, dense forms, grid entry, exports | 6, 7, 8 | Requirements 9 & 15 |
| **10** | Keyboard system | 5, 9 | Requirement 5 |
| **11** | Public API + connectors | 1, 4, 7 | Requirement 13 |
| **12** | AI section | 4, 8, 9 | Requirement 12 |

Requirements 2 (clean the codebase) and 14 (fluent UI) are not stages — 2 is the net deletions in
Stages 1, 3, 5 and 7; 14 is Stage 6.

---

### Stage 0 — Repo safety — *trivial, 30 minutes, highest value in the programme*

One commit, containing nothing else. `git add` every untracked path — do not curate. Then add a
`typecheck` script to `master/web/package.json` and `office/web/package.json`: root `typecheck` is
`npm run typecheck --workspaces --if-present` and **neither web workspace has the script**, so
`npm run verify` has never typechecked a single line of frontend code. Stages 3, 5, 6, 9 and 10 make
~1500 edits under `web/src`.

**Done when:** a fresh clone of `dev` runs `npm ci && npm run verify` green.

### Stage 1 — Data-integrity core — *medium, 2 new / ~18 modified*

New `shared/src/domain/columns.ts`: one `PRODUCT_COLUMNS`/`PARTY_COLUMNS`/… map and a generic
`columnPatch()`. **Contract: `undefined` = not asserted, `null` = clear it.** This deletes
`sync.service.ts`'s COLUMN_MAP, two `columnsFrom` bodies and two other hand-maintained copies — the
`notes:'notes'` bug on a nonexistent column disappears by construction.

Also: `stampFieldHlc()` at seven sites (turns the merge engine back on); `validateProductInput()`
called from **both** the service and `mergeUpdate` (a raw CHECK violation in `mergeUpdate` is recorded
as permanently `rejected` and silently destroys an Office panel's offline work); `setStockLevels`
built from the asserted subset only; two-dimension product masking now rather than at Stage 8; and a
live bug — `search.repository.ts:92,:110` filter `is_active` but soft-delete sets `deleted_at`, so
**deleted products and parties are in universal search today**.

### Stage 2 — Electron shell — *large, ~10 new / ~12 modified, −500 duplicated lines*

Three of the four headline defects are already fixed (§1 above). What remains is the process
lifecycle. One `electron/shell.ts` plus two thin entrypoints, replacing ~250 lines duplicated twice.

- **Module-scope `shutdown(reason)` registered before `main()` runs.** Today handlers register
  *after* `startPostgres()` and `runMigrations()` — 60-90 s on first run with no handler, which is
  exactly the window in which an operator closes the splash. Leave a `disposables` array; Stages 4,
  11 and 12 each register one, instead of three stages re-shaping the same function.
- **Bounded supervisor.** Today *any* child exit including a clean 0 fires an error dialog and quits
  — requirement 1 verbatim. Replace with 3 restarts in 10 minutes, then a choice dialog.
  `updating` becomes `updatingSince` with a 60 s window (today a dead installer suppresses every
  future crash report for the process's life).
- **`minWidth: 1024, minHeight: 640`** — requirement 10's new floor lands here, not in Stage 6.
- `sandbox: true`, `devTools: !app.isPackaged`, and every guard registered immediately after
  `new BrowserWindow` (`createWindow` returns early on a timed-out start today).
- Rotating log file per panel, surfaced in the error dialog and Settings — packaged stdout goes
  nowhere today.
- Menu items for Stage 10 ship here, one-way `webContents.send`. The Help item's current
  `loadURL('#/updates')` is dead: `readHash()` only recognises `'gallery'`.
- Widen `vitest.config.ts` to cover `electron/` — there are zero tests today.

### Stage 3 — `@orderbook/ui` + i18n fold + React 19 — *very large, ~85 files*

**The structural blocker, and the stage most likely to be under-estimated.** 26 of 41 `ui/` entries
are byte-identical; four are **forks, not copies** — `theme.ts`, `icons.tsx`, `PermissionGrid.tsx`,
`base.css`. Copying Master's `theme.ts` over Office's flips every installed Office panel to dark and
orphans its stored preference (`ob.theme` vs `ob.theme.v2`).

Fold both panel dictionaries into the type-safe `shared/src/i18n/` catalogue that nothing currently
imports (1029 + 501 → 1401 keys; 13 conflict and need namespacing; two differ in *placeholder set*).
Five call sites already render a raw key today because of the fork — that bug resolves here.

Move **all 36 components including the Master-only ones**: that single decision deletes two separate
"port X into Office" tasks that later stages had each planned independently.

React 19.2 has exactly three real breakages, all in files that just moved, so one edit each.

First jsdom + `@testing-library/react` harness in this repo (`environmentMatchGlobs` — Vitest 2.1.9
has no `test.projects`, that is Vitest 3).

### Stage 4 — Settings + password vault — *large, 8 new / ~18 modified, 1 migration*

`settings` = one row per declared key. **Every setting is Master-only, gated on `settings.manage`
alone** — an earlier design gated writes on `users.viewPassword`, which deadlocked the installations
it claimed to protect: nobody could turn the feature on, and worse, nobody could turn it **off**,
stranding plaintexts with no purge.

`user_password_vault` sealed with AES-256-GCM, key at `dataDir/secrets/vault.key`. Five write moments,
all already holding the plaintext; seal **after** the transaction using the fingerprint from
`panelCredentialRepo` — `signIn` rewrites bcrypt→scrypt inside its own transaction and setup hashes
the first administrator with bcrypt, so sealing the wrong hash makes the shop's own admin account
report `stale` on its very first reveal.

`POST /api/access/users/:id/reveal-password` — its own route so it can never ride along in a list
response; gates in order: permission → toggle-on → re-authentication → fingerprint match → open →
**audit committed before responding**.

`backup.repository.ts EXCLUDED_TABLES` gains the vault **in the same commit as the table**, or every
backup taken between the two commits carries ciphertext out of the building.

### Stage 5 — Screen keep-alive + DataTable — *large, 4 new / ~25 modified*

Requirement 4, via React 19's `<Activity>` — not a router (none gives keep-alive), not an external
store (41 and 50 `useState`s to enumerate on the two worst screens).

**Three things depend on effect teardown meaning unmount and each needs an explicit fix:** `useSubNav`
clears on teardown and would delete the sidebar entry the feature promises; `useOverlay` picks the
"last dialog" by document order, so a hidden pane's Drawer steals Escape from the visible one (fix:
filter by `checkVisibility()`); and Office's screen switch **is not a switch** — two screens sit above
a `if (!view)` gate, so it needs two tiers.

**The DataTable virtualiser is inert today** — `.ob-tablewrap` has `overflow:auto` but no height
constraint, the real scroller is `.ob-content`, `onScroll` never fires and `visibleCount ≥ rows.length`.
Keep-alive would multiply a 500-row page by every visited screen. Fixed here, along with reading row
height from `offsetHeight` instead of `getComputedStyle('--row-h')` — Stage 6 makes that token rem, and
`parseFloat` returning `2.2857` would render ~10,000 rows.

Reset is a `resetNonce` in the `key`: total reset, zero per-screen code.

**Honest note:** net API effect is *neutral*, not negative — a screen fetches once per mount today and
once per re-show after. The win is that a naive `display:none` keep-alive would have been worse.

### Stage 6 — UI scale, 1024→4K, fluency — *large, ~40 files + ~200 mechanical edits*

Split the two jobs `[data-density]` conflates: `--root-size` becomes the continuous knob (11–22 px,
shown as 79%–157%), and density keeps only the height-to-text *ratios*, in rem — so every preset keeps
its exact current proportions.

Three breakpoints in **physical** CSS px, deliberately: a layout that reorganises while you drag a font
slider reads as a bug. **No upper breakpoint and no shell max-width** — at 4K the app gets more content,
not bigger content.

Modals already survive the new floor: at 1024 px the content area is 969 px collapsed / 813 px pinned,
and the large modal at 840 px + 48 px padding fits with 81 px spare.

**Drop srcset for Retina** — Office serves images from a local cache and returns **503 when offline**;
srcset makes the browser pick among four variants instead of the one normal browsing warms, and a 503
on the chosen candidate does not fall back. Pick one variant at render from
`slotCssPx * devicePixelRatio`.

`styles.css` is trimmed, not deleted; the 165-site className migration is **explicitly out of scope and
has no owner**.

### Stage 7 — Performance and memory — *large, 5 new / ~30 modified*

Four amplifiers turn one action into N×M work. **No cache library and no hand-rolled cache** — Stage 5
removed the reason. This is the single largest scope deletion in the programme.

- **Client:** 15 s timeout, and **refcounted** in-flight GET dedup — without the refcount one
  unmounting screen kills every other consumer's in-flight request. `useResource` replaces every
  `let cancelled = false` block. Per-entity revisions replace the global counter.
- **One query per request** at five sites, via `resolveSessionWithPermissions`. Measured: `GET
  /api/parties` goes 5 → 3.
- **Dashboard broadcast** — currently a full aggregate *per admin socket per change* — gets a 250 ms
  trailing debounce and per-flush memoisation.
- **Delta replay** instead of a full snapshot per reconnect. Three correctness holes, each **silent**
  when wrong: `party_variant`/`sync_conflict`/`reservation` are valid entities with no `applyChange`
  case (replaying and dropping them means staff quote from stale negotiated rates); replay without the
  directory filter hands every panel the whole staff list and every role's permissions; and a delta
  applied into a null snapshot is discarded.
- **Bytes off the socket:** two HTTP routes replace the buffered image commands; `maxHttpBufferSize`
  60 MB → 4 MB; a shared promise gate for the two raster pipelines that contend for one libvips heap.
- **Things that only grow:** sweep the never-swept `failures` map; prune stale update downloads. The
  orphaned-variant sweep runs **at startup only** — on a timer it races the upload pipeline and deletes
  live files.

### Stage 8 — Product & party attributes — *medium-large, 1 migration / ~20 modified*

14 new columns on `products` (MRP, purchase rate, GST %, UOM, barcode, brand, shade, calibre, water
absorption, PEI, edge type, surface texture, application, origin plant); min/max stock on
`inventory_stock` (**reorder point already exists** as `reorder_level`); `batch_no`/`shade`/`calibre`
on `stock_movements`.

**Batch/lot is deliberately not a product column** — one product receives many lots, so a column is
false the second inbound. True lot-level on-hand means re-keying `inventory_stock` through
reservations, line quantities, dispatch settlement and the document renderer: a workstream, not a
column. What ships answers "which lot is this" from the movement ledger. *This is a deliberate refusal
of the requirement as literally written, replaced with the correct model — the owner should know.*

New `field.purchaseRate.view`/`.edit` at management tier — purchase rate is more sensitive than sale
rate. The `products_search_refresh` trigger function must be **written out in full** in both `up` and
`down`, all thirteen `setweight` terms.

### Stage 9 — Picker, dense forms, grid entry, exports — *very large, ~10 new / ~35 modified*

**No migration** — the existing tsvector + GIN index already gives the ranking.

Server-backed prefix search with an `exact_prefix` boost. Two subtleties that decide whether it works:
`false OR NULL` is `NULL` and Postgres `DESC` defaults to NULLS FIRST, which would sort non-matching
rows *above* true prefix hits; and real product codes and tile sizes contain `%` and `_`, so the LIKE
prefix must escape them.

**Office offline pick must call `forCurrentUser(getView())`, never `getView()` raw** — the raw view
leaks another person's restricted parties and leaks `rate` to an actor without permission.

**Three** native selects convert; **22 stay native** — each is a closed enum or a curated list, where a
native select is keyboard- and screen-reader-complete for free.

Dense forms: party → centred modal per the standing rule; product → its own screen with a nested
sub-nav entry. **Office keeps its drawers, converted in place** — they are used by four screens and
have no replacement. The field coverage is the change that matters (product 8 → 22, party 5 → 14);
the container is secondary.

Grid entry reuses the existing colour-quantity grid's stepper and totals footer, and **opts out of
windowing** — windowing an editable grid unmounts the input under the caret.

Report exports: **the money column stays and its cells go empty** for a rate-blind actor — absent-key
is the JSON wire rule, not the tabular one, and a test already pins the header row. `exceljs` ships
last, behind CSV and PDF; SheetJS is rejected (npm `xlsx` frozen at 0.18.5 with two CVEs).

### Stage 10 — Keyboard system — *medium-large, 4 new / ~15 modified*

Pure half in `shared/src/keys/` (DOM-free), React half written **once** in `@orderbook/ui`.

Three matching rules that are not optional: digits and F-keys match on `event.code` (macOS Option+1
delivers `key === '¡'`); letters match on `key` unless Alt is set; an Alt-only chord requires
`ctrlKey === false` (AltGr reports as Ctrl+Alt).

Four composition fixes, including a **live bug in both panels**: `useOverlay` registers Escape at
capture with `stopPropagation()`, so Escape inside a Combobox inside a Modal closes the modal.

**Modality:** while any `[role="dialog"]` is open the resolver skips screen scope entirely — otherwise
F-keys fire on the screen behind the scrim.

Alt+number resolves against a declared `navOrder`, not rendered index (nav items are permission-filtered
to null and removed, so index N is not stable). Nav commands call the existing `navigate(id)` verbatim,
because Alt+N must not be an easier way to lose a half-filled form than the sidebar is.

`useEnterToAdvance` takes a **container ref, not a form** — `grep "<form"` returns exactly three hits
across both apps; every drawer and editor is bare fields.

### Stage 11 — Public API + connectors — *very large, ~18 new / 1 migration*

**The migration's permission grant must be JavaScript.** `role_permissions` was dropped three
migrations after it was created; `INSERT INTO role_permissions` raises `relation does not exist`,
aborts the run, and the Master boots to the failure page — the 2026-08-27 class of incident.

**No per-key party pinning.** Widening only the three *list* predicates leaks on every single-record
read and every write, because `levelForParty` opens with `if (scope.seesAll) return 'manage'` and
`levelFor` returns `'manage'` for any party with zero grants. A key's party scope is its owner's;
narrow keys are made by owning them from a narrow user.

**`PATCH` is read-merge-write against an *unmasked* repository read** — merging through the masked
service read would have `maskProduct` remove `rate` and the writer store `null`, silently zeroing the
catalogue price. Stage 1's patch semantics are the hard gate for this whole surface.

**SSRF guard allows loopback and private ranges** — the shop LAN has no internet and the named target
runs on the shop PC itself. Blocking `127.0.0.0/8` would make the feature useless.

Failed key auth is **not** written to `activity_log` — every insert takes an advisory lock, so
key-spraying would serialise every audited write in the company.

### Stage 12 — AI section — *very large, ~13 new / 1–2 migrations*

All provider calls originate in the Master process. One OpenAI-compatible streaming transport, three
profile constants, **no new dependency** (Node 22 `fetch`).

**Generated SQL is refused.** Party scope and rate masking run *above* the SQL, so a generated query
bypasses both by construction; making it safe means re-expressing the party rule as RLS — the
nine-times duplication the party-access module exists to prevent. Instead: **fifteen read tools**, each
one call to an existing service with the caller's own actor. The control against prompt injection is
**the absence of authority** — no write tools, no free-form string reaching SQL or a path, no network
tool. Worst case is a wrong answer, never an action.

**Transport reuses the two live channels** — no per-run EventSource, no per-run SSE route. `ai:start`
acks the instant the run row is inserted, never on completion: Office rejects every command after 15 s,
so the UI would report the Master offline mid-run.

**Provider capabilities are probed, not assumed** — Ollama exposes tool calls only for models whose
template declares them, and Qwen2.5-VL-7B is not reliably one.

**Insights: SQL computes, the model narrates**, and the figures always render — with AI off the
sentence comes from the string catalogue. Vision operates only on gallery images, sending the 800 px
variant, not the 2048 px one.

---

## Ownership of contended files

Nine files are touched by four or more stages. Full table in the synthesis; the load-bearing rules:

| File | Owner | Everyone else |
|---|---|---|
| `ui/src/base.css` | S5 (`.ob-pane`), S6 (rem sweep) | S9/S10/S12 **append** a commented block; never rewrite a rule |
| `App.tsx` ×2 | S5 structure, S7 revisions, S10 providers | S9/S12 add screen entries, never a switch case |
| `api.ts` ×2 | S7 owns `request<T>` internals | S4/S9/S11/S12 append methods only |
| `DataTable.tsx` | S5 — one edit, three fixes | S6 adds column priority; S9 extracts the windowing seam |
| `master/src/index.ts` | S2 — the `shutdown` collapse + `disposables` seam | S4/S11/S12 register one disposable each |
| `purgeExpiredSessions` | S4 adds re-auth sweep; S7 adds `failures` sweep | Neither deletes the other's |
| `shared/src/i18n/en.ts` | S3 owns the 1401-key fold | All later stages append |
| `roles.permissions` grants | S8, S11, S12 each rewrite | All three inline their literals — never import from shared |

**Fifteen mechanisms were independently reinvented** by two or more workstreams (debounce ×5, request
cancellation ×4, row windowing ×3, secret sealing ×3, a key-value store ×2, `localStorage` helpers ×4).
Each is collapsed to one owner. Two whole "port X into Office" tasks are deleted outright by Stage 3
moving the Master-only components into the shared package.

---

## Migrations

Three workstreams independently claimed the same timestamp. Allocated by stage order:

| Filename | Stage | New tables → `DATA_TABLES` (FK order) |
|---|---|---|
| `20260314000000_settings_and_password_vault` | 4 | vault **before** `users`; `settings` before `master_config` |
| `20260315000000_product_trade_and_ceramic_attributes` | 8 | none |
| `20260316000000_public_api_and_connectors` | 11 | 7 `api_*` tables, after `id_map` |
| `20260317000000_ai_assistant` | 12 | `ai_runs` before `office_panels` |
| `20260318000000_search_extensions` *(conditional)* | 12 | none |

Per migration: the file, an import in `index.ts`, an array entry **after `party_access` and before the
pinned `20260309` entry**, and a `DATA_TABLES` entry per new table. **Do not edit `SHIPPED`** in any of
these stages — a name goes in only after that version has run on a real installation.

`roles.permissions` is rewritten by three of them; each must read-filter-merge-write with inlined
literals. (Note `20260303000000:331` already breaks this rule with a live `allPermissions()` import —
which is why every new capability auto-grants to a fresh install's Administrator.)

**Until Stage 0 lands, the `SHIPPED` guarantee is fiction** — two of its names reference untracked files.

---

## Risk

**1. The repository is not durable, and nothing else survives that.** See finding 4. Stage 0, first,
alone. Do not start any other stage until that commit exists.

**2. The password vault — bluntly.** Once the toggle is on, every password of everyone who signs in
afterwards is recoverable by anyone with Administrator on the shop PC; the key file and the cluster sit
on the same disk. The encryption stops a copied database file and a stolen backup, and nothing else.
Inside the app it is one admin-tier permission — which a fresh install's Administrator **already
holds** — plus a re-typed password away. `fixtures.ts:244` gives that permission to every test actor,
so **no test in the suite proves the permission gates anything**; only the toggle does. People reuse
passwords, so the blast radius is their email and their bank, not this app.
Guards, all mandatory and none sufficient: off by default; every plaintext deleted in the same
transaction that turns it off; re-auth before every reveal; its own POST route with `no-store`; an
immutable audit row per reveal; excluded from backups in the same commit; seven source-reading
invariants. **Misuse is made visible, not prevented. That is the most that can honestly be offered.**

**3. The `<Activity>` bet.** Requirement 4 rests entirely on React 19.2's `<Activity>` behaving as
documented. Guard: a half-day spike immediately after Stage 3's upgrade, verifying it exists, that a
hidden pane's effect cleanup runs, and that `checkVisibility()` returns false under `display:none`. If
any fails, re-plan Stage 5 before Stages 6–12 are scheduled around it.

**4. Stage 3 is where this most likely goes red for a week.** A 1401-key fold, 45 files moved, four
hand-merged forks, three React 19 breakages, and a frontend that has **never once been typechecked**.
Guards: Stage 0's typecheck scripts land first; the fold and the upgrade are two commits; extend the
i18n coverage test with a static scan of every literal `t('...')` *before* deleting the panel
dictionaries.

**5. Partial-patch semantics change the meaning of an omitted key in three protocols at once** — sync,
the REST API and the connector. Any consumer that omits a field expecting it to clear silently stops.

---

## Verification

`npm run verify` every stage, now including both web workspaces and `electron/`.

Seven existing tests are the forcing functions: `migration-registry`, `credential-invariants`,
`party-access-screen-parity`, `i18n-coverage`, `i18n-tokens`, `socket-contract`, and
`snapshot-masking` + the `Record<keyof SyncSnapshot, …>` tripwire. **No stage adds a snapshot
collection — that is deliberate.**

Per-stage gates are listed in the synthesis. End-to-end, on two real machines on one LAN with both
panels packaged: fresh install and pair; Office offline → create party/product/lead → reconnect and
watch a **delta**, not a full snapshot; Master edits two fields of a product and the other twenty
survive; enable reveal → reveal → disable → table empty; API key PATCH with a verifying audit chain;
connector dry-run → import → re-import writes nothing; assistant against Ollama on both a 16 GB and a
marginal machine; and the full display matrix at 1024×768 on the smallest screen in the shop.

---

## Explicitly not being done

- The 165-site `styles.css` className migration — its own workstream, no owner.
- **TLS.** The Master binds `0.0.0.0` with no certificate; a Stage 11 API key is exactly as
  confidential as the session cookie already is, which is to say not at all against a passive LAN
  sniffer. This is a decision the owner should make, not an oversight.
- `hub.ts:86`'s `cors: { origin: true, credentials: true }` — a pre-existing hole no stage opens or
  closes. (Closed on 2026-09-24, outside this plan: the hub has no CORS option now and refuses a
  cross-site handshake, `master/src/realtime/socket-origin.ts`.)
- Lot-level on-hand inventory (Stage 8 ships the ledger an upgrade would start from).
- A macOS build. Stage 2 makes the release script platform-aware and adds entitlements, but no Mac
  panel ships and none is code-signed. Requirement 10's Retina support is a rendering requirement
  Stage 6 satisfies.
- Recovery of already-damaged product/party rows — impossible from the activity log.

---

## Reference material

The full 104k-character synthesis and all ten corrected workstream designs (17k–30k chars each, with
every one of the 218 findings and its fix) are in the session scratchpad:

```
C:\Users\Z\AppData\Local\Temp\claude\C--Users-Z-Desktop-OrderBook\50900d6c-3108-47d0-b0ea-380ba92d3268\scratchpad\
  synthesis.md    ws-A.md ws-B.md ws-C.md ws-D.md ws-E.md
  ws-F.md ws-G.md ws-H.md ws-I.md ws-J.md
```

These should be moved into `docs/overhaul/` in the repo before the scratchpad is cleaned — every stage
above compresses a design that names exact SQL, signatures and line numbers.
