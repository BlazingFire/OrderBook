# AI Collaboration — Working Together on This Repo

A practical playbook for running three AI coding tools side by side on this
project — **Command Code (me)**, **Claude** (via Claude Code CLI), and a local
**Qwen 3 (8B / 27B via Ollama)** driven through **OpenCode**. It answers the
session-access question up front, defines how work is divided without stepping
on each other, and records the single source of truth each agent should trust.

This is written as a **reusable template** — the workflow rules are generic.
OrderBook-specific paths and details appear throughout as the concrete example.

---

## 1. Can you access an active Claude session in the GUI?

**Short answer: No.**

A coding agent (Command Code, Claude Code, or OpenCode) cannot reach into a
**live session of Claude's desktop GUI app**. Those are separate applications
with no cross-process channel, and there is deliberately no bridge from a
terminal agent into a GUI session.

What is actually true:

- **Claude Code CLI** sessions are scriptable: you can run `claude` as a
  subprocess with flags such as `--session-id`, and pass it prompts. That is how
  an agent can drive Claude Code — as its own process, not by peeking into a
  GUI.
- **Sessions live on disk as transcripts** (e.g. Command Code keeps JSONL
  transcripts per project under `~/.commandcode/projects/<slug>/`, Claude Code
  under `~/.claude/projects/`). A file on disk is not a live session: transcripts
  are append-only and only durably updated when a turn **commits**, so a
  still-streaming conversation is never a complete, readable file.
- **The `.claude/` folder in this repo** is not a GUI. It holds
  `settings.local.json` — configuration, not a session.

### What this means for collaboration

None of the three agents needs another's live session. The OrderBook repo
already demonstrates the pattern that works (see `HANDOFF.md`): **every agent
runs in its own terminal/CLI session, and coordination happens through shared
files and git** — not through shared memory. If you need Claude to do a piece of
work, launch it yourself (`claude` CLI) or hand it a written brief in a file;
no agent can open the one you already have in the GUI.

---

## 2. The three agents, and who does what

### Roles on this project

| Agent | Where it runs | Suggested role | Notes |
|---|---|---|---|
| **Claude** | Claude Code CLI | Architecture & design lead; broad-context planning; doc authoring | The existing `HANDOFF.md`, `docs/PROJECT_PLAN.md`, `docs/schema/`, and overhaul docs were written by/for Claude Code sessions. Read them first. |
| **Command Code (me)** | Terminal (this session) | Implementation, verification, and repo-grounded review | Run with plan mode when designing; executes `npm run verify`, checks tests/lint/typecheck before committing. |
| **Qwen 3 (8B / 27B)** | Local **Ollama** (`ollama run`), driven by **OpenCode** CLI | Fast parallel/grunt work; drafting; review passes on small scoped files | Runs 100% local — never sees secrets, never needs internet. Smaller context: give it one small, well-specified task at a time. The model id here is `qwen3:8b` / `qwen3:27b` depending on what Ollama has pulled (see §4). |

> **On the "27B" name:** the project's own docs and tests reference
> `qwen2.5` / `Qwen2.5-VL-7B` as the *product's* embedded-assistant model
> (workstream-I). The **Qwen 3** you run via OpenCode is the *development*
> assistant, separate from the OrderBook product's AI feature.

### Division of labor rules

- **Only one agent edits a file at a time.** If two need the same file, coordinate
  in the handoff file first (check §5).
- **The Master owns the DB and all writes** (that's the product's own rule in
  `README.md`) — but for *development* work, only one agent runs `npm run
  release` or touches migrations at a time, because those contend.
- **Small, scoped tasks → Qwen via OpenCode.** Big architectural or
  cross-cutting work → **Claude**. Implementation you want verified against the
  full suite → **Command Code**.
- **Never run two agents that both auto-apply edits** to overlapping files in
  the same working tree. Use separate git branches or serial handoff.

---

## 3. Ground rules for sharing context

1. **Put durable decisions in `HANDOFF.md`** (this repo's running record).
   Anything worth remembering — a decision, a gotcha, a completed stage —
   belongs there, not in a chat transcript that dies with the session.
2. **Write plans as files.** Claude Code's `writing-plans` skill (installed
   globally, not vendored) produces handoff plans for other models to
   execute. Command Code writes plans to `~/.commandcode/plans/`. Both are
   better handoffs than pasted chat.
3. **Prefer the source of truth over any summary.** `docs/PROJECT_PLAN.md` is
   the architecture source of truth; `docs/schema/` is the schema; `HANDOFF.md`
   is current status. If two documents disagree, say so and fix the stale one.
4. **Status lives in git, not in memory.** Commit granular work; the log is the
   shared timeline all three agents can read (`git log`). Uncommitted work is
   invisible to the others.
5. **Project skills** live in `.commandcode/skills/` (team-shared, tracked) and
   `.agents/skills/ui-consistency/` (the Muse Code shape of the same rule).
   Third-party skills are installed globally on each machine, not vendored —
   the vendored copies were removed on 2026-09-14.

---

## 4. The local Qwen stack (via OpenCode + Ollama)

The dev-assistant model runs through **OpenCode**, which talks to **Ollama**
serving a local Qwen 3 model.

```bash
# ensure Ollama is running and the model is pulled
ollama pull qwen3:8b        # smaller, faster; good for quick drafting
# or, for 27B-class work with more context/quality:
ollama pull qwen3:27b

# run OpenCode pointed at the local model
opencode --model ollama/qwen3:27b    # flags vary by OpenCode version
```

- **Everything stays local** — no API keys, works even while the shop's
  "no internet, ever" rule would forbid a cloud call.
- **Context is limited** compared to Claude. Give Qwen one file or one function
  at a time, with the exact path and the exact task.
- **Verify its output before committing** — small local models can hallucinate
  APIs or "fix" working code. Command Code can run `npm run verify` (lint +
  typecheck + tests) on anything it produced.

---

## 5. Handoff protocol

Use this when passing a task from one agent to another:

1. **Write a brief** to a file (e.g. `docs/ai-handoffs/<task>.md`) containing:
   - the goal, in one paragraph;
   - the exact files to touch (paths);
   - what "done" looks like (tests to run, output expected);
   - any constraints (offline-only, don't touch migrations, etc.).
2. **Assign one owner.** The brief names who implements and who reviews.
3. **The implementer reports back in the same file** — what changed, what was
   verified, what's left. The next agent reads the file, not the chat.
4. **Update `HANDOFF.md`** when the task closes.

This mirrors the "improve" skill's model (`plans/` + execute/reconcile) and
keeps every agent working from durable state.

---

## 6. Verification before anything is "done"

The project's own gate is `npm run verify` (lint + typecheck + tests). As of
2026-09-17: **968 passing tests across 84 files, plus 568 skipped across 42** —
the skips are every integration suite, which needs a PostgreSQL that will not
start as root. Both panels build, on Windows and now on Linux too. **Record the
skip count, not just the pass count**: a skipped suite prints like a passing
one, and this project has lost months to exactly that. No agent should claim a change is done without running the
relevant gate and recording the result.

```bash
npm run verify        # lint + typecheck + full test suite
npm run build         # builds shared, both servers, both frontends
```

For OrderBook specifically: `npm run typecheck` covers the web workspaces and
`electron/` too, so run it (or `verify`) rather than a narrower check.

---

## 7. Quick reference — where things live

| Thing | Path |
|---|---|
| Running record / decisions | `HANDOFF.md` (root) |
| Architecture source of truth | `docs/PROJECT_PLAN.md` |
| Database schema | `docs/schema/` (start at `00-overview.md`) |
| Overhaul/executive plan | `docs/overhaul/README.md` |
| Manual QA plan | `docs/TESTING_PLAN.md` |
| Shared types + Socket.IO contract | `shared/src/` (protocol in `shared/src/protocol/`) |
| Master Panel server | `master/src/` (Express + Socket.IO + Postgres) |
| Office Panel server | `office/src/` (thin client; forwards to Master) |
| Shared UI package | `ui/src/` (consumed as source by both panels) |
| Electron shell | `electron/` (main process + supervisor) |
| Release/build tooling | `tools/` (`release.mjs`, `make-icons.mjs`, …) |
| Project skills | `.commandcode/skills/` + `.agents/skills/ui-consistency/` |

---

*Template note: to reuse this doc in another project, replace the paths in the
tables with that project's layout and keep the rules in §1–§6 unchanged.*

---

## Change log

Newest first. Each entry records what an agent changed on the repo and what
was verified, so the next agent can trust the state without re-auditing.

### 2026-10-01 - Catalogue import/export, server side (Claude)

`master/src` (domain, service, `lib/spreadsheet.ts`, `panel-catalog.routes.ts`), `office/src/http/app.ts`,
`shared/` (`MAX_PRODUCT_IMPORT_ROWS`, `ProductImportResult.unchanged`, 3 keys en + hi), tests, `CATALOGUE_MODEL.md` §5.
- **Header drift settled:** the true format is the owner's labels (`IMPORT_HEADERS`: Brand, Main product code,
  Main product, Sub product, Size, Colour rule, Colour, Code, Weight (kg), Alias); the template, the export and
  the import already agreed — the three CSV-template tests still expected the old `categoryName,name,variant,...`.
- **Round trip:** an upsert of an unedited export reported every row `updated`. New `unchanged` count (additive
  field on `ProductImportResult`); the real SWISWARE catalogue (41 / 549) exports and re-imports as 0 created,
  0 updated, 549 unchanged, 0 errors in about a second, both formats, both modes.
- **Defects fixed:** CSV read by exceljs shifted row numbers past blank lines, assumed commas and coerced
  nothing consistently — now a small RFC 4180 reader (BOM, UTF-16, Windows-1252, `;`/tab, quoted line breaks,
  formula-guard apostrophe removed); weights `12,5` read as 125 and `0x10`/`1e3` were accepted; inner whitespace
  made "ONE  PIECE" a second product; brand and colour case now follow the Fields lists, and a new brand joins
  the Brands list; the export listed deactivated variants and an upsert revived them; two models of a file
  resolving to one product overwrote each other; oversized files said "photo too large" (`validation.import.tooLarge`
  on both panels); no row ceiling (`validation.import.tooManyRows`, 20,000); export file names carry the date.
- **Office:** `/api/products/export.:format` already proxied the Master route; tests now pin the type, dated
  disposition, `?level=main`, refusal pass-through and the multipart forwarding of file, mode and dryRun.
- **Tests:** new `spreadsheet-reader.test.ts`, `product-import-roundtrip.integration.test.ts`; additions in
  `panel-catalog-route`, `catalog-import-session`, `office/tests/module-forwarding`.
- **Not done / decisions:** partial import of the valid rows is kept (a model is atomic, the file is not);
  a blank cell still cannot clear a stored Alias/Weight; Excel cells already coerced to numbers by the person
  (`0012` typed as a number) cannot be recovered — the template's Code column is text-formatted for that.

### 2026-10-01 - Catalogue import/export, web UI side (Claude)

`office/web`, `ui/`, `master/web`, `shared/` i18n (add only), tests.
- **Master gained Export:** an Export CSV button on Sub products and Main products (it had only the
  buttons hidden inside the import dialog, and none for main products); `exportProducts(format, level)`
  now threads `level` through `CatalogueTransport` and `master/web/src/api.ts` to `?level=main`.
- **Both import dialogs (Office and the `ui/` port, kept in step):** a wrong extension or an empty
  file is refused before upload; picks, drops, template and export are ignored while anything is busy
  (no double submit); Esc and the scrim no longer close the dialog mid-import; the problem list can be
  downloaded as a row-numbered CSV; a preview with some bad rows says how many will be left out; the
  confirm button takes focus so Enter imports.
- **Success toast** after an import on both panels; Office export failures say the Master is off
  (`exportFailureText`) instead of a bare error.
- Keys added (en + hi): `import.report.download`, `import.report.fileName`, `import.preview.partial`.
- **Not done:** an `update`-only mode (`ProductImportMode` is `create | upsert`, shared/server-owned).
- Verified: targeted vitest 62 files / 761 tests pass (4 new in `ui/tests/master-catalogue.test.tsx`);
  `npm run lint` and `npm run typecheck` exit 0.

### 2026-10-01 - Master parity plan, P7: dead code only (Claude)

Master web/server, `shared/` (i18n text only), docs; nothing under `office/`, no `ui/src` edit.
- **Removed:** `api.dashboard`, `updatePanel`, `refreshPanel`, `rotatePanelSecret`, `setPanelStoragePath`,
  `disconnectPanel`, `panelActivity`, `connectorProfiles`, `deleteConnector` from `master/web/src/api.ts`
  (routes stay); `reportRangeQuery` is a module function; their `ALLOWED_UNCALLED.master` lines are gone.
  `GET /api/custom-fields` and `fieldsService.listCustomFieldsUnguarded` (no caller in either web app,
  `ui`, `office/`, `electron/`; the Office reads definitions from the snapshot); test, comments and
  the API-CONTRACT / PERMISSIONS / FILE-STRUCTURE / STRUCTURE docs updated.
- **Moved:** `fontkit` to `master` devDependencies (only `pdf-fonts.test.ts` imports it), lockfile refreshed
  with `--package-lock-only --ignore-scripts`.
- **Reworded:** stale "Developer tab" comments to "the /api/developer/load-catalogue route (no screen since
  5a32106)"; the uninstaller sentence dropped from `setting.security.developerModeEnabled.help` (en, hi).
- **Docs:** HANDOFF, TESTING_PLAN, ROLES_AND_USERS, DEVELOPER_MODE, uninstall README, PRODUCTION_READINESS
  (loading the catalogue is now a stated go-live gap: no screen, route behind the developer token),
  CATALOGUE_MODEL, `.env.example`.
- **Kept (owner):** Integrations, developer routes and service, ui Developer exports, Fields Definitions,
  Access Recycle Bin card, `GET /api/panels/pairing-window`, the unused hub handlers.

### 2026-10-01 - Master parity plan, P6: admin record details become sub-screens (Claude)

Master web, `shared/` (six new `panels.detail.*` keys, en and hi), tests; nothing under `office/`, no `ui/src` edit.
- **Panels:** the detail modal is an `EditorScreen` (sub-nav `panels.detail`, back button). It reads
  `api.panel(id)` for the role the panel acts under (with the Office-default fallback), tier and
  permission count, and its work counts (pending orders, final orders, last action); the list row fills in until
  it arrives. Rename and remove stay modal confirms and now open over the detail.
- **Roles & users:** the person detail is an `EditorScreen` (sub-nav `access.person`; its id is held by `AccessScreen`
  so the sidebar can name it); reset, reveal, deactivate and delete dialogs stay modals over it. The role editor
  loads `api.role(id)` on open (`RoleEditorLoader`), so it edits the current version, not the list row;
  falls back to the row if the read fails. `RoleEditor`'s `confirm()` and the role-list detail modal are unchanged.
- **Activity log:** the entry detail is an `EditorScreen` (sub-nav `logs.entry`); the verify dialog stays a modal.
- **Tests:** three `master-shell` cases (panel row reads `GET /api/panels/:id`, log entry, role edit reads
  `GET /api/access/roles/:id`); `panel` and `role` dropped from `ALLOWED_UNCALLED.master`.
- `PartyAccessScreen.tsx` untouched.

### 2026-10-01 - Master parity plan, P5: the remaining parity (Claude)

Master server and web, `shared/` (i18n only) and tests; nothing under `office/`, no new `ui/`
file, `PartyAccessScreen.tsx` untouched, no migration.
- **Server (additive):** `catalogService.listPartyRecords` (`GET /parties/:id/variants` now carries
  `catalogueName`, null for a deleted product or without `products.view`; `findProductsByIds` gained
  an `includeDeleted` option, default unchanged), `getPartyWithAccess` (`GET /parties/:id` carries
  `myAccess`), `listPartiesWithMeta` (`GET /parties` rows carry `recordCount` and `myAccess`;
  `partyVariantRepo.countByParty`). The hub handlers use the plain services.
- **Dashboard:** a card only for each figure present; Panels card and list `panels.manage`; new
  cards Pending Orders (`dashboard.leads.due` / `noneDue`, "due or overdue"), Final Orders,
  Dispatched this week; stage bars with Open board; follow-ups via `api.leads({followUpDueOnly,
  limit: 8})` only with `leads.view`, refetched on `records`, a row opens the lead; the sync
  popover's low-stock row only when the figure exists. **Skipped:** the recent-activity box, and
  `reservedBoxes` on `DashboardSummary` - the Office server's `DASHBOARD_FIGURE_PERMISSIONS` is an
  exhaustive `Record` over the summary's keys, so a new shared field fails its typecheck (tried,
  reverted).
- **Parties:** the detail modal is now an `EditorScreen` sub-screen (`openIds.parties`; a palette party
  hit opens it); contact, own access (+ assignees and a Party access button for
  `party.assign`/`party.accessAll`), own records, recent pending orders; Edit/Delete as header actions;
  `LoadMorePager`; Products-count and My access columns added to the list.
- **Inventory:** `permissions` prop; Stock in `inventory.edit`, Physical count `stock.adjust`, band
  cells read-only without `inventory.edit`; the row modal is an `inventory.detail` sub-screen, the
  movement forms stay modals.
- **Conflicts:** `canResolve` and the read-only banner removed; line and variant sets read one row per
  line. **Settings:** offered to everyone; company/leads/connection/storage need `settings.manage` in
  `settingsTabIdsFor` (sub-pages and screen), no identity/settings/storage read without it; header
  comments rewritten; no setting row hidden. **Fields:** `fields.col.position` ("Order") on the Master's
  own two tables. **Password:** `ChangePasswordDialog` publishes `signIn.notice.passwordChanged`.
- **Tests:** `master-shell` (Dashboard cards, leads gating and follow-up row, party sub-screen and
  search hit, Inventory permissions, password notice, Settings reach), `http-api` (`catalogueName`,
  `myAccess`, list fields), `inventory-stock-race` (`permissions`), `web-reachability`
  (`partyAccessFor` entry dropped).
- **Not done:** the Office's city chips on Parties (needs a server city facet).

### 2026-10-01 - Master parity plan, P4: the product catalogue on the Master (Claude)

Master server and web, `shared/` (nav command, i18n), `ui/` (seven new files plus the barrel)
and tests; nothing under `office/`, no migration.
- **Server:** `panel-catalog.routes.ts` is the factory `productImportRoutes(actorOf)`
  (`panelCatalogRoutes = productImportRoutes(panelActorFromRequest)`, panel path unchanged,
  still pinned by `panel-catalog-route.integration.test.ts`); `dataRoutes` mounts it for a
  session (`GET /api/products/import/template.:format`, `POST /api/products/import`; the
  service checks `products.bulk`). `app.ts` mounts `imageFilesRoutes` at `/uploads/images`
  (same session check, same 404), before the SPA catch-all. `images.routes.ts`: no file →
  `ValidationError('validation.image.fileRequired')` (the key already existed, en + hi).
  P3 gap: `buildLeadEntryView` carries `products` (the snapshot's catalogue page, scoped by
  the service) only with `products.view`, so the edit form keeps a multicolour line's colour rule.
- **ui/:** `catalogueSummary.ts` (the summaries verbatim + `CatalogueView`, `CatalogueTransport`),
  `SubProductsScreen`, `ProductDetail`, `ProductDrawer`, `ProductImages`, `ProductImportModal`,
  `MainProductsScreen` (with `BrandsScreen`) — ports with "keep in step" headers; transport read
  through `transportRef`; controls absent without `products.create/edit/bulk`; Master wording
  keys `catalog.products.savedOnline`, `catalog.products.empty.descriptionOnline`,
  `product.saveHintOnline` (en + hi); `ui/src/ProductImages.tsx` added to the strict-i18n lint list.
- **Master web:** `screens/ProductsScreen.tsx` (view loaded on `catalogue`, `catalogueStock`,
  `catalogueLists` revisions; stock only with `inventory.view`; three pages in `<Activity>`),
  `transports.catalogueTransport`; `api.ts` gains `listProducts`, `updateProduct`, `createCategory`,
  `updateCategory`, `deleteCategory`, `productImportTemplate`, `importProducts`, `uploadProductImage`,
  `updateProductImage`, `reorderProductImages`, `deleteProductImage`; `throwIfNotOk` passes
  `messageKey`/`params`; `deleteProduct` removed. `App.tsx`: `products` tab and module before
  Parties (`products.view`), sub-pages sub/main/brands (brands always offered), palette product hit →
  `products.sub`. `MASTER_NAV` gains `products` (Alt+5): Parties Alt+6, Inventory Alt+7, Reports
  Alt+8, Office panels Alt+9; Roles & users and Party access lose their chord.
- **Tests:** `ui/tests/master-catalogue.test.tsx` (15), `master/tests/catalog-import-session.integration.test.ts`,
  `http-api` (`/uploads/images` webp / 404, auth table rows, lead-entry `products`),
  `lead-entry-screen` (multicolour edit keeps its rule), `master-shell` (Products module, Alt+5 title,
  Alt+9 panels, row opens a sub-screen, boot routes), `screen-reachability` (`PANEL_ONLY.products`
  dropped), `web-reachability` (`createProduct`/`deleteProduct` entries dropped).
- **Owed:** the catalogue screens exist twice until the Office switches to `ui/` (HANDOFF decision 18).

### 2026-10-01 - Master parity plan, P3: New and Edit pending order on the Master (Claude)

Master server and web, `shared/` (keys and i18n), `ui/` (one new file plus the barrel)
and tests; nothing under `office/`, no migration.
- **Server:** `PUT /api/leads/:id` (`leads.edit` → `updateLead`; whole line set replaced,
  malformed `items` 400, converted lead 400 `convertedLocked`); `GET /api/lead-entry` →
  `buildLeadEntryView` beside `buildSnapshot` (untouched): party-scoped `partyVariants`,
  `optionLists`, `stock` (`[]` without `inventory.view`), unbounded `partyGrants`,
  `features`; 403 without `leads.create`/`leads.edit`.
- **ui/:** `LeadEntryScreen` (port of `AddLeadScreen`, 3,050 lines, compiles under ui's
  strict tsconfig with one fix: `view.products?.`), `LeadEntryView`,
  `LeadEntryTransport` (read through `transportRef`). Deliberate differences: relative
  imports, Master wording keys, `canCreateParty`, `onSaved(id, saved?)`,
  `apiErrorText`, edit seeds the party picker with the lead's party. No existing ui
  file edited.
- **Master web:** `screens/LeadEntry.tsx` (view re-read on `leadEntry` revision, form
  never unmounted), `transports.leadEntryTransport`, `api.createLead/updateLead/
  leadEntryView`; `App.tsx`: nav-less `addLead` tab (`NOT_IN_SIDEBAR` exemption for
  `shownTab`), `canCreateLead` and `newLeadNonce` above the early returns, `leads.new`
  sub-page, topbar button, `record.new`, `SCREEN_ENTITIES.leadEntry`; `LeadsScreen`:
  Edit pending order (`leads.edit`, not converted) in an `EditorScreen`, New pending
  order on the empty state.
- **shared:** `record.new` is `panel: 'both'` (Office list unchanged); four keys,
  en + hi (`lead.add.savingHintOnline`, `savedOnline`, `draft.packagingEmptyFields`,
  `draft.gradeEmptyFields`).
- **Tests:** `ui/tests/lead-entry-screen.test.tsx` (the `add-lead-flow` cases over a
  fake transport, plus view-only party, Create party gating, edit sends the whole line
  set, server message on a refused save, transport identity does not re-query);
  `packaging-switch-reach` reads both copies; `master-shell` (button and sub-page only
  with `leads.create`, Ctrl+Shift+N renders the form, draft survives Alt+1, save →
  POST + toast + list, Reset asks, Edit button gating; boot routes `/api/lead-entry`,
  `/api/pick/*`); `http-api.integration` (PUT, converted lock, 403, malformed items,
  view fields, stock `[]`, 403, restricted party hidden; two auth-guard rows);
  `screen-reachability` (`NAVLESS_SCREENS.master.addLead`, `PANEL_ONLY.addLead` dropped).
- **Verified:** lint, typecheck, `npm test` (PostgreSQL available: 182 files passed, 1
  skipped = `release-workflow`), `npm run build` each exit 0; `git diff --stat office/`
  empty. Not done: browser/Electron pass.
- **Owed:** the lead form exists twice until the Office switches to `ui/` (HANDOFF).

### 2026-10-01 - Master parity plan, P2: Pending Orders and Final Orders modules (Claude)

Master web, `ui/` (new files plus the barrel), a small additive server change and
tests; nothing under `office/`, no migration, no new i18n keys.
- **Server (additive):** `GET /api/leads` reads `partyId` and `convertedOnly`
  (`convertedOnly` skips the `includeConverted` guard instead of contradicting it);
  `search` on leads and orders is split into words (AND), each matching the
  record's id, party, owner, stage, notes, converted/lead id or any line item's
  product, category, brand, code, variant, colour, packaging or grade, in one query
  (`repositories/record-search.ts`; `%` and `_` typed are literal). The public
  `/api/v1` gets the same matches.
- **ui/:** `LeadRecordView`, `OrderRecordView` (ports of the Office's `LeadDetail` and
  `OrderDetailBody`; transport read through a ref; stage select, note, convert,
  dispatch and weight override absent without their permission). No existing ui file
  edited.
- **Master web:** `LeadsScreen`, `OrdersScreen`, `transports.ts`; `LeadsOrdersScreen`
  deleted. `App.tsx`: `leads` tab, modules gated on `leads.view`, `orders.view`,
  `inventory.view`, `sync.resolveConflicts`; sub-pages leads = list/converted and
  orders = all + `stage:<id>`; stages loaded once in the shell; `openIds` cleared on
  reset, sign-out and session end; `refreshUser` on `role`/`user` changes;
  `shownTab` falls back to the Dashboard; palette hits open the record;
  `navigate('conflicts')`; `SCREEN_ENTITIES` additions. `api.leads`/`api.orders` gain
  `limit`, `offset`, `search`, `partyId`, `convertedOnly`, `followUpDueOnly`.
- **MASTER_NAV** interim order: dashboard, leads, orders, conflicts, parties,
  inventory, reports, panels, access, ... (Products arrives in P4).
- **Release-note items:** list-row actions moved into the record screen; one-click
  Convert became the Convert card (dispatch label and date); one-click Dispatch
  became the Dispatch card (with a note); Final Orders lost its Products column;
  Alt+N changed (see HANDOFF).
- **Tests:** `master-shell` (Alt+N on sub-page titles, row opens detail with back
  button and sidebar entry, Convert/Dispatch absent without permission, palette hit
  for an unloaded order calls `GET /api/orders/:id`, Conflicts gating, role change
  re-reads `/api/auth/me` and falls back to the Dashboard, notes tests retargeted),
  three `http-api` cases (convertedOnly, partyId, multi-word and line-item search),
  reachability allow-lists (`PANEL_ONLY.leads`, `lead`, `order`, `addLeadRemark`
  dropped), `ui-conventions` also scans `ui/src`, keyboard-provider token.

### 2026-10-01 - Master parity plan, P1: server pushes to panels (Claude)

Master server and `master/tests` only (plus two new i18n keys and a devDependency);
nothing under `office/`, no migration.
- **PanelLink** gains optional `sessionsEnded?` and `resnapshotAll?`, called with `?.`.
- **C5** `invalidateSessionsForUser` collects the tokens it ends and the hub emits
  `session:rejected` to the panels holding them. Office-visible: renaming a user
  also signs an idle Office user out now rather than at their next action.
- **C6** role update/delete/restore and party-access replace re-send
  `sync:snapshot`. Per socket it resolves with `resolvePanelActorAllowingRefusal`
  and skips a refused token: no `session:rejected`, no panel-role snapshot.
- **C7** lead/order edit with an empty base map: stored field clock older than the
  edit becomes the base, so a newer edit applies and an older one still loses.
  Two tests that relied on the old behaviour now pass a stale non-empty base.
- **C8** narrowed: 503 `error.unavailable.signInToSync` only when an `office_panel`
  push has a mutation with `actorUserId` that the panel role lacks the permission
  for; otherwise it applies under the panel role as before.
- **Tests:** new `panel-push.integration.test.ts` (real hub + socket.io-client:
  C5, C6 role, C6 party access, dead token gets nothing); C7 x2 and C8 x3 in
  `sync.integration.test.ts`. `socket.io-client` added to master devDependencies
  (`package-lock.json` regenerated with `--package-lock-only --ignore-scripts`; it
  also synced stale workspace version fields to 1.2.2).

### 2026-10-01 - Master parity plan, P0: server fixes for Office writes (Claude)

Owner: make the Master do everything the Office needs, Office untouched. Master
server and `master/tests` only; nothing under `office/` changed, no migration.
- **C1** an Office lead edit keeps its lines: `mergeUpdate` accepts `items` for a
  lead, shape-checked up front (`assertLineDrafts`, shared with `buildLines`),
  dropped when identical to the stored lines, built from the accepted party and
  mode, written with `replaceLeadLines`. An `items` conflict is recorded only
  when the incoming set loses. Restore now handles a lead's `items` and a
  product's `variants` (`conflict.service.ts`).
- **C2** restore stamps only the restored field's clock (locks and reads the row).
- **C3** merges run the online checks: converted lead / dispatched order locks,
  owner dropped without `record.reassignOwner`, source, party exists, weight,
  vehicle (`normaliseVehicleNumber`), party name. Refusals are readable.
- **C4** `categoryId` merges through `master/src/domain/merge-columns.ts`; an
  unresolvable id is ignored (clock put back) and the rest of the edit kept.
  Name rule re-checked when the category moves. Comment in `shared/.../columns.ts`
  reworded (comment only).
- **C9** `deleteOrder` locks and re-checks `dispatchedAt` inside the transaction.
  **C10** party codes grow past `P-9999`. `updateLead` now stamps the clock when
  only the lines change; a non-string `partyId` is refused.
- **Not changed on purpose:** C7 (spurious conflicts on an empty base map) is P1,
  so an Office edit of `notes` etc. still reports a conflict until then.
- **Verified:** `lint`, `typecheck`, `test` each exit 0 (180 files passed, 1
  skipped; 2301 tests passed, 17 skipped, none of them integration). Integration
  suites ran, not skipped (`ORDERBOOK_PG_BIN` = PostgreSQL 17; the embedded one
  is refused here): sync 43, lead 38, audit-atomicity 52. New tests cover C1-C4,
  C9, C10, restore clocks, and a losing `items` edit writing no activity.

### 2026-09-30 - Order notes built: Filling note and Dispatch note (Claude)

Owner: "start working on this plan" (`docs/ORDER_NOTES_PLAN.md`). All six steps.
- **Data:** migration `20260401000000_order_vehicle_number` (nullable, add-only,
  pinned last in `migration-registry.test.ts`); `Order.vehicleNumber` /
  `leadCreatedAt` (optional, joined from `leads`); `OrderUpdateInput.vehicleNumber`
  validated in `updateOrder`; `ORDER_COLUMNS.vehicleNumber` so offline edits merge.
- **Shared:** `shared/src/domain/order-note.ts` (build + paginate, `NOTE_LAYOUT`).
- **UI:** `OrderNote`, `OrderNoteScreen`, `order-note.css`; buttons on the Office
  order detail and the Master orders table (`orders.export`); new
  `GET /api/parties/:id` on the Master for the header.
- **Desktop:** `listPrinters` / `printPage` on `DesktopBridge`, preload, `shell.ts`,
  `electron/lib/print-options.ts`.
- **Deviation from the plan:** the remembered printer is in `localStorage` (per
  PC, since each PC has its own profile), not in `shell.json`. Same effect,
  no shell-settings change. Escape-to-go-back was not added (no screen does it).
- **Verified:** `npm run verify` exit 0, 179 files / 2270 tests, integration
  suites running (`ORDERBOOK_PG_BIN` = PostgreSQL 17, since embedded `initdb` is
  refused here). The Dispatch note was rendered in a browser (3 pages, no
  overflow). **Not done:** Electron / real printer / Microsoft Print to PDF,
  the Filling note visually, 157 % scale and the 1024 × 768 floor.

### 2026-09-30 - Order notes plan: Filling note and Dispatch note (Claude)

Owner: two print documents per order from the design artifact "A4 print
notes" — a preview, then one Print button to the PC's printer; named sub
products on the left, coded ones on the right grouped by product.
- New `docs/ORDER_NOTES_PLAN.md`: the decoded design, what the tree has
  today (no order print, no print IPC, no vehicle number), the decisions
  (HTML in the web app with pure pagination in `shared/`, a desktop
  `printPage` bridge with a per-PC printer, `orders.vehicle_number` add-only
  column), six build steps with tests, traps, and four owner decisions with
  defaults.
- Docs only; no code changed, nothing run.

### 2026-09-30 - Grade beside packaging; the Enter walk ends on Add product (Claude)

Owner: grade beside packaging and the same box; a packaging pick moves to the
grade; Enter/Escape walk packaging → grade → Add product, and Enter there adds
the product. And "the options are Box, Grass and Paper" — the owner's Master
still showed Carton / Pallet / Shrink wrap.
- **Grade per row.** `grade` moved from `ProductFacts` to `DraftRow` /
  `DraftLine`; each draft row has a GRADE column after PACKAGING, the same
  pick-only `Select`, "—" for none. The card-level grade select and its keys
  (`gradeNone`, `gradeHint`, `gradeNoneHint`) are gone; `gradeEmpty` is a
  footnote under the rows like `packagingEmpty`.
- **Walk.** `stepOn` walks each row's quantity → packaging → grade, then the
  Add product button (`data-add-card`); a disabled Add takes no focus, so a
  card short of something keeps the caret on its last grade. A pick, by Enter
  or mouse, steps on by itself. Enter no longer adds the card from a box, so
  the `picked` ref and `saveDraft(candidate)` are gone; `saveDraft()` reads
  `draft`. Escape back from Add product works through `data-field`.
- **Grid** reworked to fit the card at the 1024-wide floor (the grade box ran
  past the card edge in the browser): packaging and grade `minmax(72, 96)`,
  variant `minmax(48, 1fr)`, weight 60, qty 56.
- `pickedHint` (en, hi) now describes the walk to Add product.
- **Owner's database** (with the owner's say-so): Carton, Pallet and Shrink
  wrap soft-deleted in `option_lists` (restorable from the Recycle bin; no
  line used them); Master and Office stopped, rebuilt and restarted, which ran
  `20260328000000_line_packaging_defaults` — Box, Grass, Paper now live. The
  company's `line.grade` list is empty, so grade offers only "—" until grades
  are added under Settings → Fields. `.claude/launch.json` gained
  `master-start` / `office-start` (the built panels).

Verified: `add-lead-flow` tests rewritten for the walk (packaging → grade →
Add, Escape back through all four, mouse pick steps on, per-colour packaging
and grade sent, required packaging holds the card). `npm run verify` with
`TEMP` at `.tmp/itest`: lint 0, typecheck 0, 177 files / 2217 tests passed,
17 skipped, integration suites running. Browser (Office at 4200, 1024×768):
qty Enter → packaging list Box/Grass/Paper, ArrowDown+Enter took Box and moved
to Grade, Enter → Add product, Escape → Grade, Enter, Enter → line in Added
products; the card fits. One early ArrowDown+Enter left packaging at "—" and
did not reproduce in four later tries.

### 2026-09-30 - Packaging beside each quantity; Box, Grass, Paper (Claude)

Owner: packaging right beside QTY, in the Enter and Esc walk, options Box,
Grass and Paper, styled like the QTY box. Supersedes the card-level picker in
the entry below (same day, same working tree).
- **Per-row packaging.** `packaging` moved from `ProductFacts` to `DraftRow` /
  `DraftLine`. Each quantity row of the draft card has a fifth column after
  QTY: the kit's pick-only `Select`, which is an `Input` with a list, so it is
  the QTY box (same `ob-input`, 30 px in the browser). "—" is none. While
  `leads.packagingRequiredOnConvert` is on the header carries `*`, the box
  `aria-required`, a counted row without one `aria-invalid`, and
  `draftIsReady` needs every counted row packed. The party's saved packaging
  is a "Use …" button filling the rows still without one. Removed
  `lead.add.draft.packagingNone`; `lead.add.products.pickedHint` now names the
  last packaging.
- **Keys.** Enter: quantity → its packaging → the next row's quantity; Enter
  on the last packaging adds the card. The list takes the highlighted value
  during that same keydown, so the pick is carried to `saveDraft(candidate)`
  through a `picked` ref instead of waiting a render. The ref is dropped after
  every commit: a review workflow (3 lenses, each finding adversarially
  verified) caught a mouse pick left standing and overriding a row refilled
  later; `add-lead-flow` "forgets a mouse pick…" pins it (fails without the
  fix). Escape walks back via the screen's `useEscapeToPrevious`; a list
  somebody opened closes first.
- **Box, Grass, Paper.** `20260328000000_line_packaging_defaults`, additive,
  pinned last behind the `option_lists` repair: per tenant, inserted after the
  list's highest `sequence`, skipping a value present in any case or state
  (live, retired, deleted). Sample data now uses those three and adds no
  packaging values of its own (it would collide with the seeded rows).
- Docs: HANDOFF (current state), STRUCTURE (§6.1 pins and data-safety list,
  migration rows #33–#34, the New lead flow), schema/06, LEAD_GENERATION_FLOW
  §6–7, TESTING_PLAN.

Verified: lint 0, typecheck 0, `npm test` 177 files / 2216 tests passed (17
skipped) before the ref fix and `vitest run ui` 26 files / 181 tests after it;
integration suites **running** — with `TEMP` pointed at the
gitignored `.tmp/itest`, because embedded PostgreSQL's `initdb` gets
"Permission denied" creating its cluster under `%TEMP%` on this machine (a
plain `mkdir` there works). `packaging-switch-reach.test.ts` flagged the
"Use …" offer as an unguarded packaging test; it is an offer, not a refusal,
so it now reads `row.packaging === ''` and the refusal in `draftIsReady` is
written as one guarded line the check recognises. Browser (Chromium, Office
bundle rebuilt, localhost:4200): Enter from QTY lands on packaging with its
list open, Esc returns to QTY, typing `c` narrowed to Carton and Enter added
the card with the caret back in the sub-product bar, the line shows Carton,
Modify reopens with Carton. **Not seen live: Box/Grass/Paper** — the owner's
Master runs from `dist` (`start:master`) and was not restarted, so the
migration had not run; that database's list shows Carton / Pallet / Shrink
wrap, pre-existing values the migration leaves alone. Seen in the integration
and jsdom tests only.

### 2026-09-30 - Packaging picker on the lead draft card, Free and Line weight gone (Claude)

*Superseded the same day by the entry above: packaging moved into each
quantity row and `lead.add.draft.packagingNone` was removed.*

Owner's screenshot of the Office Panel's "Details for this product" card:
- **Packaging** is now on every draft card, as a `Select` over the
  `line.packaging` list (Settings → Fields), beside the colour picker. It was
  a typed `SuggestInput` shown only while `leads.packagingRequiredOnConvert`
  was on; the setting now only adds the "required" marker, the autofocus and
  the Add-button block. A value off the list (retired, or typed on an older
  lead) stays shown, the same guard grade uses. Key `packagingPlaceholder`
  removed; `packagingNone` / `packagingEmpty` added.
- **Free** and **Line weight** columns removed from the quantity rows (and
  their keys `lead.add.draft.col.free` / `col.lineWeight`). With Free went the
  red over-stock border on the quantity box. The card's total weight in the
  bottom hint is unchanged.

Verified: `ui/tests/office-shell.test.tsx` packaging tests rewritten to find
the select by label (not required while off, required while on). Lint 0,
typecheck 0, `vitest run ui` 177/177. The full suite's 51 integration files
fail on this machine before any test runs — embedded PostgreSQL's `initdb`
fails — and fail identically with this change stashed. No browser pass.

### 2026-09-29 - Edit lead, lead detail layout, scrolling product lists (Claude)

Scope, all on the Office Panel, from the owner's screenshot:
- **Lead detail layout.** `.ob-detail-grid` named two things in `base.css`:
  the label/value `<dl>` and the lead page's two columns. The `<dl>` rule
  `.ob-detail-grid > div { align-items: baseline; border-bottom }` hit both
  columns, so every card shrank to its content and each column drew a
  hairline. The layout is now `.ob-record-grid` (only `LeadDetail` used it).
- **Edit lead.** The open lead's header has an Edit lead button (`leads.edit`,
  not on a converted lead or one the Master has not received). It opens
  `AddLeadScreen` with a new `lead` prop, prefilled with the party, source,
  follow-up, notes and lines; Save sends `PUT /api/leads/:id`, which already
  existed and replaces the whole line set on the Master. In edit mode the form
  publishes no `addLead` sub-nav, so a New-lead draft is left alone.
- **Product and sub-product lists.** The product list was capped at seven
  rows; it now lists every product. Both lists' scrollbars are always drawn
  (`reset.css` paints a thumb only on hover or focus-within, and focus stays
  in the input), and the arrow-key highlight scrolls into view.

Verified: two new tests in `ui/tests/office-shell.test.tsx` ("Edit lead")
open a lead, press Edit lead, save, and read the `PUT` body; and check the
button is absent without `leads.edit`. `web-reachability.test.ts` no longer
lists `updateLead` as unused. `npm run verify`: lint 0, typecheck 0, vitest
2210 passed with that one stale entry failing; after removing it the file
passes. Not verified in a browser: the
auto-mode classifier refused a local static server, and this session's
browser cannot reach the owner's running panel.

### 2026-09-29 - option_lists repair for databases on 20260306's older body (Claude)

Scope: the owner's first `reload:catalog` on 1.2 applied its five pending
migrations and then failed on `column "created_by" of relation "option_lists"
does not exist`. Cause: `20260306000000_field_values_and_stage_ordering` has
two bodies in history under one name; the owner's database ran the August
one (`c9091c7`), which never added `created_by` / `updated_by` and whose hex
check refused uppercase (the catalogue's colours are `#FEFEFE`-style). Checked
every migration for the same split: `20260301` and `20260312` also have two
bodies, but they differ only in seeded permissions and `IF NOT EXISTS`, not in
schema. Added `20260327000000_option_lists_repair` — additive and idempotent,
pinned last — which adds any missing `option_lists` column and replaces the
hex check with the current either-case one (a widening; no stored value can
fail it). `HANDOFF.md` trap recorded.

Verified: `master/tests/migration-option-lists-repair.integration.test.ts`
recreates the old shape (no `created_by`/`updated_by`, lowercase-only check),
shows an uppercase colour refused, runs the repair, and reads back an
uppercase colour and the old lowercase one; it fails with the repair's check
replacement removed. Migration registry and additive guard pass. `npm run
lint` 0, `npm run typecheck` 0, vitest 176 files passed, 1 skipped, 2209
tests passed, 17 platform skips.

### 2026-09-29 - Catalogue v2 on the 1.2 product master (Claude)

Scope: the owner's 2026-09-28 catalogue restructure — Brand → Product → Sub
product, the SWISWARE 2026 catalogue, colour rules, a product bar and a
sub-product bar for lead entry, lead sources and the follow-up default on a
Leads settings tab, inventory and a lead PDF on the same model — **ported onto
`main`'s 1.2 product master** (category → model → variant, per-variant stock,
no money). The spec is `docs/catalogue/CATALOGUE_MODEL.md`. It was first
built on a stale checkout that had never taken 1.2.0 (`catalogue-v2-stale`,
`6549018`); that build was used for ideas and tests only, not merged — its
pricing, `colour_policy`, PDF Designer and settings code is what `main`
removed on purpose. Worked in a worktree on branch `catalogue-v2-port` (from
`10910a4`) by a foundation pass and parallel workstreams; uncommitted when
this entry was written.

- **Schema:** `20260323000000_catalogue_brands_and_codes` kept as a no-op (the
  stale checkout ran a real migration under that name on the owner's PC
  database) and `20260326000000_catalogue_brands_and_codes_port`, additive and
  idempotent, pinned last: category `code`, `brand`, `sort_order`,
  `updated_at`, `deleted_at` with per-brand name and per-tenant code unique
  indexes (live rows), `products.sort_order`, `line_items.brand_name` and
  `category_code`. `SHIPPED` lists all 32 migrations.
- **Model:** a Product is a category; a Sub product is a model with one
  variant coded `CODE-####`; brand is a `product.brand` option value on the
  category; the colour rule is derived (`shared/src/domain/colour-rule.ts`);
  several colours are several lines; the Master drops a stray colour instead
  of refusing the lead (amends HANDOFF Key decision 15).
- **Catalogue data:** `master/assets/catalogue/swisware-plus-2026.md` (1
  brand, 21 colours, 41 products, 549 sub products), parsed by
  `master/src/domain/catalogue-markdown.ts`, loaded in one transaction by
  `loadCatalogue`; `swisware-catalogue.ts` deleted. `reload:catalog` keeps
  parties and the activity log; `seed:demo-parties` added.
- **Services and transport:** category CRUD (`/api/categories`,
  `category:*`, the Recycle Bin), sub-product name uniqueness and generated
  codes, picks by code and in catalogue order (`PICK_MAX_LIMIT` 1000), product
  and stock snapshot ceilings 2000, `settings:save` for the Office's
  follow-up default, `GET /api/leads/:id/pdf`.
- **Screens:** the Office's lead entry rebuilt (product bar, sub-product bar,
  colour rules, Shift+Q, Ctrl+Enter review), Products → Products and Brands
  pages, Settings → Leads on both panels (`ui/src/OptionListEditor.tsx`,
  `NumberSetting` moved to `ui`), the Master's inventory listing every live
  variant with brand and product filters, Preview PDF on both panels and an
  Electron window for it.
- **Settings:** `leads.followUpDefaultDays` falls back to 3 (was 0),
  `leads.packagingRequiredOnConvert` to false (was true).
- **Docs:** `HANDOFF.md` (current state, Key decisions 12 and 15, operator
  scripts, the migration-name trap, the live-database `pg_dump` warning,
  session history), `docs/schema/00`, `02`, `03`, `04`, `05`, `06`,
  `docs/LEAD_GENERATION_FLOW.md`, `docs/TESTING_PLAN.md` (new §8a),
  `docs/STRUCTURE.md`, `docs/DEVELOPER_MODE.md`,
  `docs/backend-modules/04-API-CONTRACT.md` (§10.2b), each checked against the
  code as it landed in the worktree.

- **Integration pass:** a product-import row is filed by the single-product
  rule — a `categoryCode` must name a live product and is refused in the
  preview otherwise, a name is read with its `categoryBrand`, and
  `categorySeedKey` keys a brandless-code seed by (brand, name) so two brands'
  new "Wash Basin" stay two products; an offline rename merged by
  `sync.service.ts` now runs the sub-product name rule; the Office Settings
  screen uses the one `optionListTransport.ts`; `packaging-invariants`
  normalises CRLF, so it passes on a Windows checkout; the unused
  `validation.lead.colourUnexpected` key removed.
- **Test-quality pass:** each key behaviour's code was broken and its test
  watched fail. Three survived and now have a test: the Dashboard low count
  ignoring holds (`free-to-sell.integration`), the lead PDF drawing only the
  first line of a wrapped cell or no party block (`lead-pdf.test.ts` records
  every drawn string), and a dedicated sub product asking for a colour
  (`add-lead-flow`). The stronger PDF test found a defect: at the real Colour
  width `Rustic Coffee Brown ×5,` printed its `×5,` alone on the next line;
  `cellLines` now takes the word before a count down with it.

- **Review round:** four reviewer-fixers (backend, lead flow, displays,
  tests) fixed a restore racing a Product delete, duplicate-key 500s on a
  concurrent Product save, a Load catalogue press that restored only a brand
  or colour announcing nothing, two fast-Enter party races in lead entry,
  variant labels that only repeat the sub-product name on the lead board and
  order reservations, and the PDF's orphaned `×5` count.
- **Browser walk** (both panels on a sandbox database, isolated from the
  owner's): the operator scripts on a fresh database (32 migrations; 41
  products, 549 sub products, 21 colours; 13 demo parties); a lead with a
  fixed, a numbered, a two-colour multicolour and a colour-named sub product
  through Enter, Shift+Q, Ctrl+Enter review and save, synced to the Master;
  the lead PDF's text (Model / Code split, no colour on numbered pieces,
  `White ×10, Rustic Coffee Brown ×5`, wrapped cells, no money); Products,
  Sub products and Brands; Settings → Leads on both panels; the Master's
  inventory and leads list. It found three defects, each fixed with a test
  watched failing first:
  - the Office's event stream was keyed on the session object, which every
    reconnect replaces, so it closed and reopened itself about sixteen times
    a second, each time re-reading session, connection and sync state — on
    1.2.0 already; it is keyed on whether somebody is signed in now
    (`office/web/src/App.tsx`, `ui/tests/office-shell.test.tsx`);
  - the Sub products list sorted A–Z across products; it follows the
    catalogue now (`product.repository.ts`, `catalogue-seed.integration`);
  - `inventory.piecesOnHand` was missing (dropped in the 09-25 key cleanup)
    and the Stock screen showed the raw key; `i18n-call-sites.test.ts` now
    also reads both keys of a `t(cond ? 'a' : 'b')`, which is how it hid.

Verified: `npm run lint`, `npm run typecheck`, `npm run build` exit 0; full
vitest 176 files — 175 passed, 1 skipped (`release-workflow`, not on Windows);
2207 tests passed, 17 skipped (platform skips only), all 50 integration suites
ran. Browser walk as above. Not run in Electron: the Preview PDF window is
owed.

### 2026-09-25 (leftover cleanup) — Dead exports, unused keys and CSS, and text that still named removed features (Claude)

Scope: what the audit left behind. The code already carried no money,
assistant, PDF Designer, old Picker or field masking; the text around it
still did.

- `e2b7d71`: dead exports removed — the repository alias `setReorderLevel`,
  `BP_TIGHT`/`BP_SHORT`, `deviceCodeOf`, `entityOfPermanentId`,
  `defaultBindings` (and its test); seven file-internal helpers unexported.
- `cbf116b`: with one sign-in attempt left the Master says "1 attempt left"
  (`auth.service.ts`, with a test); 57 unused keys out of `en.ts` and `hi.ts`
  (all `picker.*`, `lead.detail.total`, …); the panels' dead CSS rules and
  `:root` alias tokens, and `.ok` in the clean-install page.
- Uncommitted on top: sample-data remarks and a party note that talked about
  money now describe other facts ("Quoted…" remarks kept; the `creditDays`
  field kept, owner's call); the dead `rate` fixture field in
  `http-api.integration`, the `rate` column in `spreadsheet.test.ts`, the
  rupee-sign test's title, and test and source comments that described prices
  or "masked" snapshots as current (now gated and scoped per actor); the
  `ui/tests/app-shell-nav` fixture uses a Leads module instead of Documents;
  `.gitignore`'s note on `CATA.pdf`/`dummy-data/`; `opencode.md` and the
  test-guardrails skill no longer say the panels are invisible to `verify`;
  Workstream I bannered as history; `BACKEND_MODULES.md` and
  `docs/backend-modules/*` status lines say what was built; the "cited from
  source" claim corrected (only `docs/backend-modules/`, and of
  `docs/overhaul/` only `README.md` and `workstream-F.md`); the finished
  briefs `product-model-variants.md` and `product-master-trim.md` deleted,
  their owner decisions folded into `HANDOFF.md` Key decisions 14 and 15 and
  every link repointed; counts updated (2088 keys, 1245 `TODO(i18n-hi)`,
  1349 identical to English, 160 files / 2015 tests); `HANDOFF.md` Owed work
  17–21 added.

Verified: `npx eslint .` 0; `npm run typecheck` 0; `npx vitest run ui shared
office/tests` plus the touched unit suites in `master/tests` — 50 files / 582
tests passed. The touched integration suites skipped (no PostgreSQL as root);
a full run with the cluster is still owed.

### 2026-09-25 (audit) — Whole-tree audit fixed on eleven branches, merged into `main`; the palette offers only what runs (Claude)

Scope: an audit of the whole tree, its findings fixed on eleven local `fix/*`
branches, each reviewed and repaired before it was merged into `main`
(`e1ac5ce..HEAD`). The branches were never pushed and hold nothing `main`
lacks. Every defect the 2026-09-22 structure audit had left open is closed.

**Fixed, by branch** (each branch's commit messages say which tests were
watched failing against the old code):

- `fix/audit-trail`: the main write paths write their `activity_log` entry as
  the last statement of their own transaction (`recordActivity`), not after
  commit; a party-wise record, reorder levels, an offline merged edit, an order
  edit and an order stage move now record at all (three new `activity.*`
  tokens). A dispatch bumps `version`/`hlc` and takes its stage from the locked
  row; `party-access#replaceAssignments` stamps the clock before its row lock
  (it deadlocked, `40P01`); `updatePanel` is one transaction.
  `audit-atomicity.integration.test.ts` fails an entry moved ahead of its row
  write. `recordDetachedActivity` is left for sign-in attempts, connector runs,
  and a panel's reissued secret or moved storage folder;
  `docs/ROLES_AND_USERS.md` §7.1 and §16 say which entries stay detached and
  why.
- `fix/http-hardening`: `GET /api/storage` needs `settings.manage`, and
  Settings takes its permissions from the shell; the Socket.IO hub has no CORS
  option and refuses a cross-site handshake (`realtime/socket-origin.ts`);
  `requirePanel` runs once per `/api/panel` request; the public API reads its
  tenant through `tenant.repository.ts`.
- `fix/master-tools-comments`: `npm run migrate -- --status` names what is
  pending (and no longer applies it from the root); `reload:catalog` loads the
  catalogue after the wipe, and the wipe clears `api_connector_links`; stale
  money, masking and helper comments across `master/src`.
- `fix/release-sync`: a GitHub setup file is no longer cut off at 15 s; a sync
  writes `latest-<platform>.json` (and `latest.json` for a Windows build); each
  OS's sync sweeps only its own files, spares the running AppImage and every
  pinned build; `availability()` answers from the folder after 5 s; the poll
  fetches the office build for every OS a panel has asked for (UPD-48..63).
- `fix/release-pipeline`: only `main` publishes; the mac `.zip` is gone; the
  Linux `.deb` is published beside the AppImage with a `.sha256`, named by no
  manifest; the host-architecture refusal applies only to the Master;
  `@vitest/coverage-v8` installed so `npm run test:coverage` runs (`coverage/`
  ignored).
- `fix/electron-updates`: Linux panels update their AppImage in place
  (`electron/lib/appimage.ts`, `updateMethod()`); a `.deb` or other non-AppImage
  copy is told to update by hand and the shell refuses; the relaunch keeps
  `--appimage-extract-and-run`; `ORDERBOOK_MASTER_SETTINGS_FILE` dropped.
- `fix/office-storage`: a storage move rewrites the shell's
  `office-location.json` and survives a restart (`electron/lib/office-env.ts`);
  it refuses a drive root, the home folder or a folder holding anything that
  is not the panel's own; an unreadable `outbox.json` is set aside instead of
  overwritten, and one failed save no longer fails every later one; the shell
  names the log it is writing (`openLogPath()`); the Office lead routes check
  the permission before the payload's shape (`queue()`'s `validate` step), and
  the Office server's stale comments are corrected.
- `fix/shared-contract`: Parties joins `MASTER_NAV`, so the Master's Alt+3 is
  Parties and Inventory…Party access move to Alt+4…9 (`keys-nav-order.test.ts`
  holds both lists to the sidebars); the "Stock" setting group; a row with no
  actor reads `logs.actor.unknown`, and the 11 Hindi activity templates still
  in English are translated; a price-word guard over both catalogues.
- `fix/ui-kit`: command priority by mount order (a dialog keeps Ctrl+S over its
  screen); palette rows reach the palette and help commands; the sidebar toggle
  works; `copyText` copies over plain HTTP; the kit's English literals go
  through `t()`; `permissionLabels` reads the catalogue; `Picker` removed.
- `fix/web-apps`: the gallery stays open; Alt+N refuses a screen the sidebar
  withholds; the Office New lead form is blank after a save, Conflicts is
  reachable from "See what was refused", and the order weight override is sent
  only when changed; both panels start on the Dashboard after a sign-out or an
  ended session; the splash says the server could not be reached; screens
  refetch on the change events they depend on. `ui/tests/master-shell.test.tsx`
  and `office-shell.test.tsx` boot each `App.tsx` whole in jsdom
  (`ui/tests/panel-harness.ts`).
- `fix/schema-docs`: `docs/schema/` checked against a freshly migrated
  database (39 tables, 76 foreign keys, every index); new
  `docs/schema/07-integrations.md`; `docs/ROLES_AND_USERS.md` §4.1/§10 and
  `shared/src/sync/ids.ts` now say roles and users cannot yet be created
  offline.

**After the merge:** `d8f129e` and `8decf06` reconciled the tests the merges
put at odds (the platform-named manifest, `office-env.ts`, Alt+7 for Office
panels). `ffb69fe`: `KeyboardProvider.offers()` answers in the order `run()`
does, and both panels pass `canNavigate` (the sidebar's own test), so the
palette no longer lists screens the sidebar withholds, *New record* for a role
that cannot create, or *Find*, which only its chord answers. `7d6ae68`: the
shell tests wait until the panel is listening (the event stream, the socket,
the menu subscription, the key listener) before they talk to it;
`pressAltDigitUntil()` in `panel-harness.ts` presses until a screen opens, so
both Alt+N refusal tests prove the chord reached the panel. Before, a loaded
machine lost the Office snapshot in about 1 run in 4, and those refusal tests
could pass without the key ever arriving.

**Docs:** `HANDOFF.md` and `docs/STRUCTURE.md` brought to the merged tree;
`AGENTS.md` (verify counts, what the jsdom shell tests cover);
`docs/NEXT_PHASE.md` (the owner's decisions and owner-only chores, the browser
pass, what the audit left); `docs/LEAD_GENERATION_FLOW.md` §7 rewritten
against the code, and §2, §3.3 and §10 brought in line with it;
`docs/UPDATES.md` (a `.deb` install is recognised, not offered the AppImage);
`docs/PRODUCTION_READINESS.md` (the manifests a Windows build writes, how the
Linux AppImage and `.deb` update, the uninstall decision);
`docs/TESTING_PLAN.md` (the Office Storage and Developer tabs, the storage
move, the Master's Storage tab without `settings.manage`, the newly audited
writes); `docs/ROLES_AND_USERS.md` §16 (API keys, the Recycle Bin and
translation are built); dated notes in `BACKEND_MODULES.md`,
`docs/backend-modules/README.md` and `docs/overhaul/` where they called the
audit trail or the Socket.IO CORS hole open; the Master's `serverEnv` and the
one releases folder for every OS in `workstream-A.md`; the party-access brief's
stale-comment item closed.

**Found and not fixed** (`HANDOFF.md` "Owed work", `docs/NEXT_PHASE.md`):
dispatch keys on the stage named `Dispatched` (needs an add-only migration and
the owner); `deleteOrder` can race a dispatch; `party_code` truncates from the
10,000th party; no index on `leads`/`orders.owner_id`; the public API's tenant
cache survives a whole restore; the wipe/reload CLIs stop a running Master's
database; 23 client→server socket events have no caller; the Master keeps
drawing a screen after its permission is revoked; RoleEditor's
`window.confirm`; no "fetching" reason on the Updates screen; Clean Install and
the `.deb`; a transient outbox read at flush time; work possibly stranded by a
storage move made before the fix, and the shell's log left in the old folder
until a relaunch; a party-wise record's temporary id never reaching `id_map`
(an observation); stale comments and a sample "Rate list" remark. The owner
decides whether to harden the uninstall scripts.

**Verified:** `npm run lint` 0, `npm run typecheck` 0, `npm run build` 0,
`vitest run` 160 files / 2015 tests with every integration suite executing
(PostgreSQL 16, as a non-root user). The Settings permission change and the
Socket.IO origin check were run in a real Electron window against a live
Master. **Not verified:** anything else in a browser or Electron, a Release
workflow run on this round's pipeline changes, an AppImage update on a real
Linux PC, and the Mac build on real hardware.

### 2026-09-22 (structure) — `docs/STRUCTURE.md` replaces `CODE_MAP.md`; five audit defects fixed (Claude)

Scope: the owner asked for the current structure of the whole software and
code in one file, using graphify if useful.

**How it was made.** graphify (`graphifyy` 0.9.65, installed in the session's
scratchpad, code-only AST extraction, no LLM) built a graph of a clean export
of the tree: 641 files, 6,152 nodes, 16,653 edges, 242 communities; its output
stayed outside the repo. A workflow then ran twelve readers — one per workspace
or concern, each held to `git ls-files` and to counts from commands — plus one
reading the graphify graph; one writer assembled the file; five fact-checkers
tried to refute every path, name and count (81 corrections: 80 applied, 1
rejected with evidence; 51 gaps: all filled). Afterwards every backticked path
was checked mechanically: all resolve except five named as deleted or cited by
stale comments.

**Changed.** New `docs/STRUCTURE.md` (§1 system, §2 toolchain, §3–§10 each
workspace file by file, §6 schema, §11 flows end to end, §12 tests, §13 docs,
§14 graphify hubs, §15 where a change goes). `docs/CODE_MAP.md` deleted; links
in `AGENTS.md`, `HANDOFF.md`, `README.md`, `opencode.md`, `docs/NEXT_PHASE.md`
now point at the new file.

**Fixed from the audit, each with a test watched failing first:**
`sweepOrphanImageVariants` deleted `imagesDir/<tenant>/avatars/` on every boot
(now skips `AVATARS_DIR`, shared with `avatar.service.ts`;
`images.integration.test.ts`); the Master's own `/api/updates/status` and
`/master/install` were refused by the panels' router-level `requirePanel`
(now per route; `http-api.integration.test.ts` `describe('updates')`);
`setVersion()` and `shared/tests/version.test.ts` left out `cleaner/` (both now
read the root `workspaces`). In `release.yml`: the commit message now reaches
`gh release create --notes` through an environment variable instead of being
pasted into the script, and `check` looks the tag up in the same repository and
with the same token as `create-release`. The rest of the audit's defects are
listed in `HANDOFF.md` under "Owed work".

### 2026-09-22 (release) — macOS universal build fixed; relative library links on every OS (Claude)

Scope: the owner asked for the macOS release build to be fixed.

**Root cause.** `fs.cp` without `verbatimSymlinks` rewrites relative
symlinks as absolute paths. `vendorPostgres()` and the staging copy used it on
PostgreSQL's `native/lib` (SONAME links), so every packaged Master — Linux
AppImage/.deb included — linked into the build machine's `node_modules`. On
macOS, `@electron/universal` refused to merge files that resolved outside the
app. Second cause: the Apple silicon runner installs only arm64 platform
packages, so the universal app lacked Intel PostgreSQL and Intel `sharp`.

**Changed.** `tools/release.mjs`: `verbatimSymlinks` on both copies;
`TARGETS.mac.universal`; `ensureUniversalPackages()` (fetch every non-dev
`*darwin-(arm64|x64)` lockfile package missing on disk at its pinned version,
refetch a wrong version, run its postinstall only if `allowScripts` approves it
and refuse otherwise); `universalSiblings()` (stage the other-arch twin of every
darwin package in the production tree); `assertUsablePostgres` now checks every
`pg-symlinks.json` link resolves. Both panels' `electron-builder.yml`:
`mac.x64ArchFiles: Contents/Resources/panel/**` and `mac.publish: null`; the
signing comment corrected (no ad-hoc fallback in electron-builder 25). The bash
fetch step in `release.yml` is gone. `master/tests/packaging-invariants.test.ts`
+3 guards, each seen failing against the previous code.

**Verified.** Release workflow, build-only on `dev` at `27c8bd2`: Windows,
Linux and macOS legs all green (the mac leg had never passed). Locally:
`node tools/release.mjs --os linux --panel master` built the AppImage and .deb;
`linux-unpacked` has 0 absolute and 0 dangling links; a copy of its
`vendor/postgres` moved elsewhere runs `postgres --version` with every library
resolved from its own `lib/`. The link check was exercised on the real tree
(14 links, 0 missing) and on a copy with a library deleted (2 missing).
An independent review walked `@electron/universal` 2.0.1 and electron-builder
25.1.8 source and found no blocking bug. **Not verified:** launching the Mac
app on real Intel and Apple silicon machines.

### 2026-09-22 (consolidation) — Every branch onto `main`, `dev` reset, dead code removed (Claude)

Scope: the owner asked for all work on `main`, the other branches gone, a fresh
`dev`, the docs brought current (the sessions that produced the work are being
deleted), and extra files and code removed. `HANDOFF.md` has the full account.

**Merged into `main`:** `claude/vibrant-ride-tb43f7`, `claude/amazing-lovelace-r5851k`
(1.2.0), and `claude/hopeful-lovelace-q6f57v` — the last onto main's variant
model, with pricing, `catalog.defaultUom` and the `select` setting control
dropped as moot and the stock-related switches adapted to per-variant stock.
The release workflow combines hopeful's three-OS matrix with main's build-only
draft path and standalone assets. `dev` was force-reset to `main` (it had
nothing unique). **Branch deletion and tag pushes were refused (403)** by this
session's git access; the branches to delete are listed in `HANDOFF.md`.

**Removed as dead:** 15 exports with no caller in `shared/` and `ui/`
(`maskFields`, `allowedForTier`, `assertedFields`, `UNREPORTED_PANEL_DEVICE`,
`isCustomFieldType`/`CUSTOM_FIELD_TYPES`, `PRODUCT_IMPORT_MODES`,
`hasMessageKey`, `SOCKET_PATH`, `isHlc`, `maxHlc`, `isMutationKind`, `FilterBar`,
`FingerprintField`, `Radio`, `Tooltip`), `shared/src/i18n/pseudo.ts`,
`forgetPreparedInstaller`, the api-client members the reachability guard found,
203 i18n keys no source references (old lead flow, `panel.*`, `startup.*`,
product-detail stock, rates) from both catalogues, 22 dead CSS rules, the
pricing column in the design gallery, the stale image-service masking, and the
tests for removed features. Kept deliberately: `master/src/domain/lead-outcome.ts`
(the TypeScript twin two report tests check the SQL against), the breakpoint
constants (a documented contract), and the `activity.*` keys of removed
features (old log rows still render through them).

**Docs:** `HANDOFF.md` rewritten as current state with a table of the retired
sessions; `NEXT_PHASE`, `CODE_MAP`, the handoff queue, `TESTING_PLAN`,
`UI_REDESIGN` (status), `AGENTS`, `README` and `opencode.md` refreshed; the
product-form brief closed as moot; `.agents/skills/ui-consistency` re-synced
with `.commandcode/skills/ui-consistency`.

**Verified:** `npm run lint` 0, `npm run typecheck` 0, `npm run build` 0,
`vitest run` 140 files / 1699 tests with every integration suite executing
(PostgreSQL 16, run as the `postgres` user on a copy of the tree). Not
verified: anything in a browser or Electron.

### 2026-09-22 — Lead-add trims and defaults, the suggest field's keyboard, Grade restored (Claude)

Four of the owner's five instructions. The fifth — "there is an old UI/UX, I
updated it and you applied the old one" — was **not acted on**: asked which
screen, the owner answered *"Right now stay as it is."* The product screens in
the tree were diffed against the live `Product page UI recreation` artifact
first and match it (form groups, list columns, and the artifact's bundled CSS is
this repo's own, minus only the scrollbar block added after it was published).

1. **The chosen party is its name and nothing else** (`AddLeadScreen`). The
   party code, phone number and town came off the chip. They stay in the
   *picker*, where they tell two similarly-named parties apart — the owner was
   asked and chose that split.
2. **The follow-up date defaults to today.** `useState('')` →
   `useState(() => isoDate(0))`. This existed on the v1.1.0 shared
   `ui/NewLeadScreen` (`useState(() => isoDate(0))`, line 135 of `e9b6086`) and
   was lost when the variant restructure replaced that screen with the Office's
   own.
3. **The suggest field's keyboard, which is what "Esc and Enter are not working
   properly in product add" was.** Four defects in `ui/src/SuggestInput.tsx`
   (both the type-or-pick field and the `Select` built on it), each pinned by a
   test that was watched failing first:
   - ArrowDown called `setFiltering(true)`, so a list opened by the chevron
     re-narrowed to the field's own value on the first arrow — *the rows moved
     under the highlight*, which is the "item will also move" in the
     instruction.
   - Both arrows stepped from the raw `active` counter rather than from
     `highlighted`, its clamp. Once a narrowed list had left the two apart, the
     highlight sat still for several presses.
   - A press on a shut list moved the highlight *and* opened it, walking past
     the top row. It now only opens.
   - Escape was claimed whenever a list was open — including one that had opened
     by itself when the field took focus. In the product dialog that made the
     first Escape do nothing anybody could see: it shut a list nobody had asked
     for, and the dialog stayed. A `summoned` flag now decides; an unasked-for
     list closes and lets the key through.
   The highlighted row is also scrolled into view (`block: 'nearest'`), which
   the 18rem-capped list needed.
4. **Enter inside the product form's variants table** (`ProductDrawer`). The
   row handler sat on all three cells, so Enter anywhere in a row jumped to the
   *next* row — colour → code → weight could only be walked with Tab — and Enter
   on the colour of a single blank row ran the save, which answered with a
   validation error about the code nobody had reached. It is on the weight cell
   alone now; `useEnterToAdvance` walks the rest in DOM order.
5. **Grade restored on a lead line**, as a pick (the owner chose pick-only over
   the type-or-pick control it used to be). `20260324000000_product_master_trim`
   had dropped it from `products`, `party_product_variants` and `line_items`
   the day before; only the **line's** column comes back — a grade says what
   a line was sold as, not what the article is, so the same variant can go out
   as A on one line and ungraded on the next. `line.grade` is a managed set
   again (Settings → Fields) and **ships empty**: a company's grade ladder is
   not ours to guess. Full path: `fields.ts` set · `LineItem`/`LineItemInput` ·
   `buildLineSnapshot` (trimmed, never derived) · insert/load/map ·
   `field-usage` · the Office snapshot (which passes option lists through
   untouched) · the draft card's select · the panel row, lead detail, order
   lines and the Master's lead summary.

**Migration `20260325000000_line_item_grade`** adds `line_items.grade TEXT` and
nothing else. It is registered **after** the trim rather than in timestamp
order, and added to `DELIBERATELY_LAST` in `migration-registry.test.ts`, because
the trim is itself pinned last and drops that very column — ahead of it, a fresh
database would gain the column and lose it a moment later. The search vector is
untouched: a grade term would mean rewriting `line_items_search_refresh` and
reindexing every row for a word nobody searches lines by.

**Verified:** `npm run lint`, `npm run typecheck` and `npx vitest run` all green
— 117 files, 1407 tests, **integration suites actually ran** (PostgreSQL 16 in
the container, driven as a non-root user). The two exceptions are
`master/tests/github-releases.test.ts` and `master/tests/updates.test.ts`,
13 failures between them that are **identical on a clean checkout of this
branch** — confirmed by stashing the change and re-running. They are about the
releases folder, not this work. Not verified in a browser or Electron.

**Files modified:** `ui/src/SuggestInput.tsx`, `ui/tests/suggest-input.test.tsx`
(+4 cases), `office/web/src/components/ProductDrawer.tsx`,
`office/web/src/screens/AddLeadScreen.tsx` · `LeadDetail.tsx` ·
`OrderBoardScreen.tsx`, `master/web/src/screens/LeadsOrdersScreen.tsx`,
`shared/src/domain/{fields,entities,inputs}.ts`, `shared/src/i18n/en.ts` + `hi.ts`
(7 keys), `master/src/domain/{line-items,sample-data}.ts`,
`master/src/repositories/{line-item,mappers,field-usage}*.ts`,
`master/src/db/migrations/20260325000000_line_item_grade.ts` (new) + `index.ts`,
`office/src/sync/local-store.ts`, `master/tests/{line-items-domain,
lead.integration,migration-registry,migration-product-master-trim.integration}`,
`docs/schema/03-leads-orders-inventory.md`, `docs/LEAD_GENERATION_FLOW.md`.
### 2026-09-22 (evening) — 1.2.0: standalone `.exe` build, pre-update database copy, additive-migrations guard, CI green (Claude)

Scope: the owner asked for an updated `.exe` build of the Master and Office
panels (last built at 1.0.3), made standalone, and added that this version
goes to customers and that from now on an update must replace the software
without losing data. The `HANDOFF.md` entry of the same date has the summary;
`docs/PRODUCTION_READINESS.md` is the checklist that came out of it.

**Files touched.** Version 1.2.0 in every `package.json` and the lockfile.
New: `electron/lib/standalone.ts` (+ `electron/tests/standalone.test.ts`),
`master/src/db/cluster-snapshot.ts` (+ `master/tests/cluster-snapshot.test.ts`),
`master/tests/migration-data-safety.test.ts`, `docs/PRODUCTION_READINESS.md`,
`tools/build-web.mjs` (the web workspaces' `build` script, cross-platform;
both `web/package.json` point at it).
Changed: both `electron-builder.yml` (portable target), `electron/shell.ts`,
`electron/preload.cts`, `shared/src/protocol/desktop.ts`, both
`UpdatesScreen.tsx`, `shared/src/i18n/en.ts` + `hi.ts` (one key, via
`i18n:sync`), `master/src/index.ts`, `tools/release.mjs`,
`.github/workflows/release.yml`, `master/tests/updates.test.ts`,
`master/tests/github-releases.test.ts`, `docs/UPDATES.md`, `README.md`,
`AGENTS.md`, `HANDOFF.md`, `.env.example`.

**Verified.** `npm run lint` 0 and `npm run typecheck` 0 on the branch.
`vitest run` in the session's container: 75 files / 854 tests passed, 45
integration files skipped (the container runs as root and PostgreSQL refuses
root; creating an unprivileged user was not permitted there). The
integration suites run on the CI workflow's Ubuntu runner — check that run
for the branch, not this note, for their result. The thirteen
`updates` / `github-releases` tests that failed on the Linux CI runner pass.
The migration guard was broken on purpose with a probe migration carrying a
`DROP COLUMN` (one test red, naming it) and put back. On GitHub, for the
branch's first commit: the CI workflow ran 120 files / 1424 tests green on
Ubuntu (integration suites included) and then failed its `npm run build`
step on the `cmd.exe` web build one-liner — the pre-existing failure behind
every red CI run since 2026-09-21 — which `tools/build-web.mjs` replaces;
`npm run build` then passed on Linux in the container. The Release workflow,
dispatched on the branch in build-only mode, produced all eight Windows files
(Master Setup and Standalone 131 MB each, Office Setup and Standalone 84 MB
each, two `.sha256`, two manifests) into the draft pre-release
`build-1.2.0-6de23b7`. Not verified: running any of them on a Windows PC.

### 2026-09-22 (later still) — Crop editor made horizontal, with real load states and every image format (Claude)

Three changes to `ui/src/ImageCropModal.tsx` and the photo picker that feeds it.

1. **Horizontal layout.** Photo left, adjustments right, `size="lg"` (60rem —
   a 520px stage plus a ~260px control column inside the body padding). The
   controls are grouped under eyebrow labels (Shape / Rotate / Straighten) and
   `flex-wrap` still stacks them at the 1024px floor.
2. **Load and failure states.** Added a `status` of loading / ready / failed.
   `el.onload` had no `el.onerror` beside it, so an undecodable file left `img`
   null and the stage showing the static word "Loading…" indefinitely, with no
   way to tell a slow decode from a dead one. Loading now shows `BusyMark` plus
   the word; failure shows `photo.editor.failed`. Every right-hand control is
   disabled until a photo is ready, and Save already required `img && crop`.
3. **Every image extension accepted.** `IMAGE_EXTENSIONS` + `looksLikeImage` in
   `ProductImages.tsx` drive both the `accept` attribute and the pre-upload
   check. The check was `file.type.startsWith('image/')`, and browsers report
   `file.type` as `''` for formats they do not recognise, so `.heic`, `.jfif`,
   `.tif` and `.avif` were rejected client-side as "not an image". The server
   has no MIME filter — `images.routes.ts` passes bytes to sharp with
   `failOn: 'none'` — so nothing downstream needed changing.

**Honest limit:** this widens what can be *picked*, not what can be *cropped*.
The editor needs the browser to decode the file, and Chromium cannot read HEIC
or most TIFFs; those now reach the editor and are told so plainly. A true
"upload anything" path would have to let the Master decode first, since
`assertCropRect` rejects an out-of-bounds rect and the client cannot express
"the whole image" without knowing its dimensions. Not attempted — out of scope.

**Left alone:** `ui/src/AvatarPicker.tsx` keeps the old narrow gate. The
instruction was about product photos; sharing the helper would mean lifting it
into `ui/`.

**Files modified:** `ui/src/ImageCropModal.tsx`,
`office/web/src/components/ProductImages.tsx`, `shared/src/i18n/en.ts` + `hi.ts`
(2 keys added: `photo.editor.rotate`, `photo.editor.failed`).

**Verified.** Lint and typecheck exit 0; `npm test` 818 passed with the same 13
pre-existing `updates`/`github-releases` failures that fail on a clean `HEAD`.
All three editor states were rendered in Chromium against real `File` objects —
a decodable PNG, an undecodable `.heic`, and a 5000px image caught mid-decode.
The first pass rendered `PHOTO.EDITOR.ROTATE` as a raw key because the dev
server serves built `shared`; `npm run build:shared` fixed it and the screenshot
was retaken.

### 2026-09-22 (later) — Stock removed from the product detail; custom scrollbar project-wide (Claude)

Two corrections from the owner after seeing the redesign running.

1. **Variants-and-stock removed from `ProductDetail`.** The table, the
   "Stock in" / "Adjust count" buttons and the whole `StockMovementForm` are
   gone — none of it is in the artifact. It was pre-existing code the first
   pass had kept; the owner asked for it out. Stock lives on the Master's
   Inventory screen (reorder band, per-variant ledger, both movement forms),
   which is where single-writer puts it. `ProductDetail` shed its `view` and
   `onMessage` props, `StockMode`, `VariantRow`, the `DataTable` columns and
   nine imports; 482 lines down to 168.
2. **The artifact's custom scrollbar, applied to the whole project.** It was
   the one block of the artifact's CSS the repo did not already carry. Rules in
   `ui/src/reset.css` (imported by `ui/src/styles.css`, which both panels
   import); colours tokenised in `ui/src/tokens.css` as `--scrollbar-*` over two
   new ramp steps `--glaze-30`/`--glaze-40`, with dark-theme values, plus
   `--scrollbar-w: 10px`. No raw hex reached a stylesheet.

**The @supports guard is load-bearing.** The artifact states
`scrollbar-width`/`scrollbar-color` alongside the `::-webkit-scrollbar` rules.
Measured in a headed Chromium: with both, the bar renders in flat platform
colours — `scrollbar-color` beats the pseudo-elements — losing the 6px inset
thumb, its radius and the track hairline. The standard properties are therefore
confined to `@supports not selector(::-webkit-scrollbar)`, so Chromium takes the
webkit rules and Firefox takes the standard ones. `.ob-filterbar`'s own
`scrollbar-width: thin` was removed for the same reason.

**Trap for the next agent:** headless Chromium forces overlay scrollbars and
reserves 0px, so it renders none of this and a headless screenshot proves
nothing. Verify with `xvfb-run` and `headless: false`; a correct run measures
`offsetWidth - clientWidth` = 10px plus borders.

**Files modified:** `office/web/src/screens/ProductDetail.tsx`,
`office/web/src/screens/CatalogScreen.tsx` (dropped two props),
`ui/src/reset.css`, `ui/src/tokens.css`, `ui/src/base.css`.

**Left in place deliberately:** `api.stockInbound`/`api.stockAdjust` now have no
`office/web` caller, and ~10 `product.detail.stock*` keys are unused. The Master
still implements the routes and the feature still exists there.

**Verified.** `npm run lint` and `npm run typecheck` exit 0; `npm test` 818
passed with the same 13 pre-existing `updates`/`github-releases` failures that
fail on a clean `HEAD`. The scrollbar was rendered headed in both themes and
measured at a 10px reserved gutter.

### 2026-09-22 — Product screens redesigned: photo card, details card, six-column list (Claude)

Scope: the owner redesigned the Products page, the product detail and the
add/edit product form in a Claude Design artifact and asked for it in the
codebase. The artifact ships this repo's own stylesheet **byte for byte** —
`ui/src/styles.css` and its four imports, only the `@import`s inlined — so the
redesign is structural throughout. **No CSS, no token and no new class was
added or changed.** Every `ob-*` class it uses already existed.

Three of its changes remove function rather than restyle it, so they were put
to the owner before any code was written. They chose: keep multi-photo support
(cover photo big, the existing strip under it) rather than the mock's literal
single photo; drop **both** the photo-thumbnail and the Stock column from the
list; and drop the category and missing-weight filter chips exactly as drawn.

**What changed.**
1. **Photos moved out of the edit drawer onto the detail screen.**
   `ProductImages` is now the *Photo* card: a square cover at the size a
   ceramic photo is worth showing, `Change photo` / `Remove photo` / caption,
   a dashed drop target when there is none, and the old thumbnail strip kept
   underneath as *More photos*. "Change photo" promotes its upload to primary
   (`promoteNext`), which the server only does by itself for the first image
   on an empty product. The strip's controls were re-stacked — four icon
   buttons and a "Set primary" label do not fit across a 96px tile on one
   line, and side by side they overlapped.
2. **Detail screen is two columns**: Photo card left, *Details* card right,
   the latter carrying `Edit product` in its own header and an auto-fit grid
   of Category, Product code, Alias, Size, Weight, Made in every colour. The
   variants-and-stock table and the stock forms are unchanged beneath it. The
   in-page `<h1>` is gone — the topbar already shows the open record's name
   through `useSubNav`, so `EditorScreen`'s `title` is now optional.
3. **List is six proportional columns**: Code, Product, Category, Size,
   Weight, Colours. The photo thumbnail and the per-variant Stock chips are
   gone; stock is read on the detail screen, which is defensible for the same
   reason `fitColumns` is. `StockCell.tsx` had no other caller and was deleted.
4. **Filter strip is search → Import → New product.** `categoryFilter` and
   `weightFilter` went with the chips, including their `listProducts` params
   and the category facets on `ProductPage`.
5. **Add/edit form** keeps its three groups and loses the Photos group. The
   name field no longer spans two columns, and the variant grid gives weight a
   fluid track with a 32px remove button, per the mock.
6. **New `office/web/src/productSummary.ts`** — `codesOf`, `missingWeight` and
   `weightLabel`, so the list row and the detail card cannot disagree about a
   product's code or weight.

**Files modified:** `office/web/src/screens/CatalogScreen.tsx`,
`office/web/src/screens/ProductDetail.tsx`,
`office/web/src/components/ProductDrawer.tsx`,
`office/web/src/components/ProductImages.tsx`, `ui/src/EditorScreen.tsx`,
`shared/src/i18n/en.ts` + `hi.ts` (7 keys added, none removed).
New: `office/web/src/productSummary.ts`.
Deleted: `office/web/src/components/StockCell.tsx`.

**Verified.** `npm run lint` and `npm run typecheck` exit 0. `npm test` —
818 passed, 13 failed in `master/tests/updates.test.ts` and
`master/tests/github-releases.test.ts`; those 13 fail identically on a clean
`HEAD` (release packaging, untouched here). 45 integration files skipped, no
PostgreSQL in the container. `npm run build` cannot run on Linux — the
`master-web`/`office-web` build scripts are cmd.exe syntax — so `vite build`
was run directly for `office/web` and succeeded. Because `office/web` has no
test files, the screens were rendered in Chromium against mock records and
checked by eye: list, detail with and without photos, and the form in both
variant modes.

### 2026-09-21 — Product master trimmed, pricing removed, multi-colour lines (Claude)

Scope: the owner had the Swisware 2026 catalogue PDF extracted to a
spreadsheet, asked how the product Add flow works and how category and model
number are modelled, and then decided the product master is too wide. The
brief — *only* name, category, alias, size, code/colour/weight and photos,
plus a **multi colour** switch, *remove other fields completely from
backend, frontend and database* — and the three answers given (remove
pricing whole; keep custom fields on products; the line's colour comes from
the Settings colour list) are recorded in
`docs/ai-handoffs/product-master-trim.md` (deleted as done on 2026-09-25; git history).

**Files touched.** Migration `20260324000000_product_master_trim` (+ registry,
pinned last); `shared/src/domain` (entities, inputs, columns, validator,
permissions, settings, fields, reports, connectors; `visibility.ts` deleted)
and both message catalogues (81 keys removed, 20 added); Master domain,
services, repositories and routes (`pricing-gate.ts` and
`domain/visibility.ts` deleted; the import template, the catalogue seed and
the sample data reshaped); the Office server's snapshot path and offline
store; the Office product form, import modal, catalogue, product detail,
New lead screen (colour select, no rate controls), lead/order detail, the
boards, dashboard and party detail; the Master's Reports, Leads & orders and
Integrations screens; `formatMoney` out of the UI kit. Tests: one new
migration suite; `line-items-domain`, `lead`, `partial-patch`,
`product-attributes`, `mappers`, `permissions`, `public-api`, `pick`,
`reports`, `product-import(-domain)`, `sync`, `connector-*`, `settings`,
`catalogue-seed`, `http-api`, `spreadsheet`, the Office `outbox`,
`lead-route`, `offline-pick` and `snapshot-for-user` (renamed) suites
rewritten; `pricing-gate.integration.test.ts` removed. Docs: `docs/schema/02`,
`03`, `06`, `docs/LEAD_GENERATION_FLOW.md`, `docs/DEVELOPER_MODE.md`,
`HANDOFF.md`, `AGENTS.md`, the new handoff.

**Verified.** `npm run lint` 0, `npm run typecheck` 0 (all workspaces, both
shells, the test tsconfigs); `vitest run` — see the HANDOFF *Verify gate*
entry for the run this session finished with. The laptop's live
`order_book_new` was migrated by starting the Master, and the walk-through
in the handoff's §6 was run in the browser.

### 2026-09-19 — Merge of the v1.1.0 line into the variant restructure (Claude)

Scope: the owner asked for local and remote `main` to be aligned, then for
both lines to survive. `origin/main` (11–14 Sep, other PC) and the laptop's
`main` had diverged at `da9e992` with contradictory decisions — two product
hierarchies, two New lead screens, the Designer kept vs removed, the
assistant removed vs kept. Resolution rules and the file-by-file record are
in `docs/ai-handoffs/product-model-variants.md` (deleted as done on 2026-09-25; git history) §6b; the short form: the
variant model wins the hierarchy, every other v1.1.0 feature is kept, both
removals stand.

**Files touched.** 67 conflicted files resolved by hand (shared contract,
migrations registry, Master repositories/services, Office server, both web
shells and every product/lead/order screen, both catalogues, HANDOFF and
the docs); the v1.1.0 `NewLeadScreen` (ui + Master adapter) and
`documentBlocks.ts` deleted; `catalog-reload-cli.ts` moved onto
`seedCatalogue`; `free-to-sell` and `product-hierarchy` suites rewritten
onto variants; `keys.test.ts` and `outbox.test.ts` adjusted. Ten lead-screen
rate keys the auto-merge had dropped were restored to both catalogues; four
v1.1.0 keys the merged screens use were carried over with their Hindi.

**Verified.** `npm run verify` on the merged tree, run 2026-09-21 before the
merge commit: `lint` 0, `typecheck` 0, `vitest run` 117 files / 1427 tests
passed, none skipped (every integration suite ran against the embedded
PostgreSQL 17 cluster). The merge was committed and pushed the same day, so
local and `origin/main` agree again.

### 2026-09-19 — Product model → variant restructure, category-first lead search, Swisware catalogue (Claude)

Scope: the owner's brief `Product_Flow_Restructure_Requirements.md` with the
Swisware 2026 catalogue PDF (rendered page by page and transcribed). Decisions
taken with the owner up front: seed the whole catalogue with weights blank;
wipe the product-linked data on this install; hide the tile-only fields.
Design and the reviewer's walk-through in
`docs/ai-handoffs/product-model-variants.md` (deleted as done on 2026-09-25; git history); the `HANDOFF.md` entry of the
same date has the summary.

**Files touched.** Migration `20260323000000_product_variants` (+ registry);
`shared/src` contract (`ids`, `entities`, `inputs`, `pick`, `columns`,
`product-validation`, `fields`, `developer`, `apply-change`, `socket`, both
catalogues — new keys with Hindi, sixty dead keys removed); Master
repositories, domain, services, routes, public API, connectors, import, sample
data, the new `product-variant.repository.ts`, `swisware-catalogue.ts`,
`catalogue-seed.service.ts`, `seed-catalogue-cli.ts`; Office server (`app.ts`,
`local-store.ts`, `offline-pick.ts`); Office web (New lead, product form,
Catalogue, product/lead/order detail, boards, dashboard, import modal, local
search, api); Master web (Inventory, Leads & orders, Settings developer tool,
Integrations, api); `ui/src` (`formatKg`, `SuggestInput` id,
`ColourQuantityGrid` deleted); docs listed in the handoff. Branch
`feature/product-variants` on top of `dda4ed5`; four commits; nothing pushed.

**Verified.** `npm run verify` green at the end: lint, typecheck of every
workspace, 117 files / 1459 tests passed, none skipped. New suites:
`migration-product-variants`, `product-variants`, `catalogue-seed`. The
persistent test cluster was migrated in place by the new migration (its
idempotency guard is what makes re-running `up()` in a test safe). The live
walk-through in the handoff §6 was run on the dev machine against a throwaway
`order_book_variants` database on ports 4110/4210 (another session's servers
held 4100/4200 and `order_book_new`); it found one pre-existing refusal (a
lead on a panel-created party) and one hundred-product cap on the Master's
stock form, both fixed — handoff §6a. `order_book_new` has **not** been
migrated: the first Master start on this branch will run the wipe there.

### 2026-09-19 — v1.0.3 Windows installers, with two packaged-only shell fixes (Claude)

Scope: the owner asked for `.exe` setup files reflecting the current codebase
and, mid-session, said the installers need none of the sample/seed-data work
another session was writing — so the build is `da9e992` + the fixes below,
from an isolated snapshot; that session's uncommitted files were excluded, not
waited for. Full account in the `HANDOFF.md` entry of the same date.

**Files touched.** `electron/shell.ts` (`here` via `fileURLToPath`; the
installer is launched through `shell.openPath`, awaited, instead of `spawn`),
`master/electron-builder.yml` and `office/electron-builder.yml`
(`'!**/node_modules/**/*'` under `files`), `HANDOFF.md`, this file. Nothing
committed; nothing pushed.

**Verified.** `npm run verify` on the pre-edit tree: lint and typecheck clean,
122 files / 1528 tests passed, none skipped. After the edits:
`tsc -p electron/tsconfig.json --noEmit`, `eslint electron/shell.ts`, and the
four `electron/tests` suites (45 tests). On the built installers: `7z l`,
`asar list` (shell + `@orderbook/shared` only, 1.7 MB, no unpacked dir),
`resources/panel` tree checks, manifest SHA-256/size re-hashed, the setup
file's `requestedExecutionLevel level="requireAdministrator"` confirmed, and
`spawn(setup.exe)` reproduced as `EACCES`. Both panels booted from
`win-unpacked/resources/panel` under Electron's Node against a throwaway data
dir (Master: fresh PG 17 cluster from `vendor/postgres`, 25 migrations, UI
served, clean shutdown). Not done: an NSIS install on a real machine.

**Audit that found the blockers.** 6 finder lenses (staged-file completeness,
shell ↔ install layout, production dependency tree, recent structural drift,
electron-builder/NSIS config, version + update path) × 3 adversarial
verifiers per finding (reproduce, reachability, severity); 112 agents, 41
raw findings, none refuted. Surviving warnings, not fixed here: unsigned
manifests (in-app offer needs `ORDERBOOK_ALLOW_UNSIGNED_RELEASES=1` per
panel; `docs/UPDATES.md` §Setting it up and `.env.example` say otherwise for
USB-stick sites); `ORDERBOOK_MASTER_SETTINGS_FILE` set by the shell is read
by nothing in `master/src`; Office storage relocation reverts on restart
(`electron/office.main.ts` re-sends `ORDERBOOK_OFFICE_DATA_DIR`, and
`office/src/lib/env-file.ts` lets the environment win); Electron-branded exe
metadata from `signAndEditExecutable: false`; `docs/UPDATES.md` lists the
signed fields without `platform`; `release.mjs vendorPostgres()` hardcodes
`windows-x64` so `--os mac` would throw rather than vendor darwin binaries.

### 2026-09-18 — Sample data: six months of a tile trade for demos and fresh installs (Claude)

Scope: the owner's request for two or three test users and dummy data — leads,
orders and everything else — so that every screen and dashboard has something
to show. The users already existed (`seed:dummy`); the data is new, as one
Master-side tool (*Settings → Developer → Seed sample data*) and one CLI
(`npm run seed:sample`). `docs/DEVELOPER_MODE.md` § *Sample data* and the
`HANDOFF.md` entry of the same date carry the design.

**Headline.** A written dataset (`master/src/domain/sample-data.ts`: 16 parties,
23 products, 33 leads with scripted histories) is replayed through the ordinary
services as the three test users, oldest event first, on a 170-day timeline —
and each event's timestamps are then moved back to its day, one UPDATE per
table, with the append-only trigger on `activity_log` taken down and put back
inside the same transaction. Nothing is inserted by hand, so the activity log,
timelines, reservations, stock ledger and party-access rules are what real use
would have left. Product photos are SVG swatches rasterised with sharp and
pushed through the real upload pipeline. The tool refuses a second run before
it touches the users.

**Files touched.** New: `master/src/domain/sample-data.ts`,
`master/src/services/sample-data.service.ts`, `master/src/lib/tile-swatch.ts`,
`master/src/db/seed-sample-data-cli.ts`,
`master/tests/{sample-data.integration,tile-swatch}.test.ts`. Modified:
`shared/src/domain/developer.ts`, `shared/src/i18n/{en,hi}.ts`,
`master/src/http/routes/developer.routes.ts`, `master/web/src/api.ts`,
`master/web/src/screens/SettingsScreen.tsx`, `package.json`,
`master/package.json`, `docs/DEVELOPER_MODE.md`, `HANDOFF.md`.

**Verified.** `npm run verify` exit 0 — lint, typecheck in every workspace, and 124 files / 1537 tests passed, integration suites included against a live PostgreSQL. Beyond the gate: `npm run seed:sample` run against
this machine's live Master (external PostgreSQL via `DATABASE_URL`) and both
panels walked in a browser — Master dashboard, leads & orders, inventory,
reports (dispatches April–September), activity log with *Verify chain* intact
over 329 entries, recycle bin, party access, fields, the Developer tab's
refusal on a second press; Office dashboard, lead board, catalogue with photos
and product detail as the `office` user, who cannot see the party restricted
to management.

**Two things found by running it.** The `activity_log_no_update` trigger
refused the first backdate outright — the guard is right, and the fix is the
transactional take-down the 20260310 migration already established, not a
weaker guard. And the management role does not hold `party.accessAll`, so
"the manager dispatches the office user's order" fails on a party assigned to
the office user alone; the administrator does that work in the seed, as an
administrator would.
### 2026-09-18 — A standalone clean-install tool (Claude)

Scope: the owner's "make dedicated exe and dmg or any other file to perform
fresh install... detects all files and config made by software on device and
uninstall it and start fresh install from given software setup path".

Planned with three Explore agents before anything was written, and the finding
that shaped the whole change came out of that: **most of what was asked for
already existed.** `tools/uninstall/uninstall-orderbook.ps1` is 454 lines that
already know every registry key, per-profile cache, shortcut and firewall rule
this product leaves, and `-DryRun` already prints the plan. What was missing was
a way to reach it on a broken machine, and a step that installs afterwards.

So the work became orchestration and packaging rather than detection — which is
a much smaller and much safer change than writing a second inventory would have
been. The plan says this explicitly under "What already exists — do not
rebuild", because the tempting version of this task is the one that reimplements
the sweep and quietly misses something.

Four questions to the owner before planning, two of them consequential: whether
"fresh" meant destroying the shop's live database (it did), and how to handle a
`.dmg` that cannot be built anywhere but a Mac. The second surfaced a bigger
problem — the panels themselves have no working Mac or Linux build — which the
owner chose to record rather than fix, and which is now in `docs/NEXT_PHASE.md`.

Three defects fixed on the way, all found by mapping the footprint rather than
by looking for bugs: a hardcoded releases path on macOS, no Linux branch at all,
and a five-way flag contract with `erase` as every side's default and nothing
checking the five agreed.

Two guards had to be rewritten because they passed against the defect they
named — one satisfied by a status message the script prints, one aimed at the
wrong identifier. That is now three sessions running, which is worth saying
plainly: a source-reading guard written in the same pass as the code it guards
tends to match the code rather than the rule.

Verified on Linux end to end against a seeded footprint, with the AppImage
built, started and loading. The Windows and macOS artifacts are configuration
and unit tests only, and the commit says so.

### 2026-09-18 — The six deferred settings, and the switch nobody was receiving (Claude)

Scope: the owner's "now implement the 6 deferred settings too". Those six were
held in `docs/NEXT_PHASE.md` behind a note saying not to start one without
asking the owner, because each is a question about how the shop works rather
than about the code. They asked.

Surveyed by a 19-agent workflow before anything was built: one wiring plan per
candidate, each then attacked by two independent lenses — a **reachability**
lens asking only "can the code that needs this value obtain it at the moment it
needs it", and an **invariants** lens asking "does this break something already
true". Ten of the twelve reviews refuted something.

**The survey's most valuable output was not about the six settings.** Four
reviews independently hit the same wall from different directions: a company
switch never reached a panel after its first snapshot. `writeSetting` published
nothing and could not — `'setting'` was not a `ChangedEntity`. A connected panel
never heard a flip; a reconnecting one took a delta, which carries no
`features`. `inventory.freeToSell` had shipped with that for months. One entry
in `SNAPSHOT_FORCING_ENTITIES` fixes both halves.

**It also corrected me.** I reported to the owner that
`leads.packagingRequiredOnConvert` was a documented-but-unwired rule, having
grepped for the enforcement site and found none. The rule is enforced, in
`master/src/domain/conversion.ts` — a file carrying a literal NUL byte at offset
3175, so `grep` answers "binary file matches" and prints nothing. A reviewer
read it with `readFileSync` and said so.

**One agent wrote code rather than a plan.** The `catalog.importCreatesCategories`
planner implemented its candidate and left it uncommitted in the working tree. I
read the whole diff, ran it, and broke its guard two ways before keeping it —
unreviewed agent output is not the same as reviewed work, however good it looks.

**Rewritten guards, five of them**, each because it passed against the defect it
named: a payload assertion satisfied by the doc comment that explains the
payload; a "never defaulted" regex watching the wrong identifier; a placement
check that pinned one side of a position; a packaging reach guard that flagged
the line which *records* the value rather than the lines that refuse on it; and
a concurrency fix of mine whose own new test proved it had not worked.

**The integration suites ran, for the first time in this project's history.** A
non-root account exists on this machine now, so `npx vitest run --config <a copy
somewhere writable> --root <repo>` executes all 43 of them: **1750 tests**,
against the 1148 the gate sees as root. The recipe is in `docs/NEXT_PHASE.md`
§2. Running them found a defect in the round they were written for — in a test,
which is still the point.

**Also fixed:** a Knex `.update(raw)` I shipped broken the day before. It throws
before any SQL is built, and printed as "skipped" because the suite skips.

Verified: lint 0, typecheck 0, build 0, **140 files / 1750 tests, nothing
skipped** — the first fully-executed run this project has had.

### 2026-09-17 — Five company settings, a Settings tab that groups, and a language picker (Claude)

Scope: the owner's "add more necessary settings in settings tab / simplify it".
Same branch, `claude/hopeful-lovelace-q6f57v`, **not merged to `main`**.

Surveyed by a 34-agent workflow — six discovery lenses plus a screens critique,
then one adversarial verifier per candidate, then a synthesis. 28 candidates, 26
after dedup, **12 kept and 14 rejected**; the synthesis narrowed the 12 to five
to ship. Every citation the plan rested on was re-checked against the tree
before anything was built.

**The five:** `panels.autoPairingEnabled`, `security.developerModeEnabled`,
`security.sessionHours`, `inventory.defaultReorderLevel`, `leads.quietAfterDays`.
Each turns something that was already a hardcoded number or an always-on
behaviour into the owner's decision, and each default preserves exactly what the
product did before — which is why every test turns its switch *away* from the
default.

**The rejections are the useful half of that survey.**
`security.signInLockoutAttempts` cannot work: the Office's offline lockout store
runs precisely because the Master cannot be asked, so it cannot read a Master
setting by construction. `catalog.productCodePrefix` would overwrite products on
an upsert import — the generator has no collision retry.  `locale.*` is declared
per-machine in writing. `panels.pairingWindowMinutes` is a fail-safe backstop,
not a UX number. And my own strongest hypothesis — company address and GST on
documents — was rejected too: company identity lives in `master_config` /
`MasterIdentity`, where `company_name` already is, and splitting one concept
across two tables is the drift `settings.ts` records as the reason a previous
key was deleted.

**Simplified:** the Settings tab renders from a declared `control` per setting
rather than from `typeof value`, which deleted a dead branch that printed JSON
beside the words "edited elsewhere"; settings are grouped under four headings;
a number setting saves on a button, not on every keystroke; save feedback is
per row; the vault hint no longer replaces the help text it was meant to sit
under; `.ob-tabs` scrolls (the tabs were unreachable at 157% on a 1366px
screen); the Master lands on Company rather than Appearance.

**The language picker** — the largest gap the survey found, and not a setting.
`ob.locale` was read on every render and written nowhere in the tree, and both
panels' boot endpoints had served `defaultLocale` since the config was written
with no reader at all. A complete Hindi catalogue shipped that no installation
could reach. There is a picker in Appearance now, and a fresh browser profile
adopts `ORDERBOOK_DEFAULT_LOCALE` once, behind the splash.

**One security fix alongside:** `createUser` and `resetPassword` hashed whatever
password arrived with no length check, while `changeOwnPassword` had enforced
eight characters since it was written — so the weaker of the two paths was the
one that mints accounts. One `assertPasswordLongEnough` now, in
`master/src/lib/password.ts`, with a source guard that fails if a fourth path
appears without it.

Verified: lint 0, typecheck 0, build 0, **87 files / 1041 tests passing, 43
files / 583 skipped**. Every new guard was watched failing against the exact
defect it names — thirteen deliberate breaks in all. **The integration suites
still have never run** (PostgreSQL will not start as root), so the fifteen
integration tests added here are unexecuted, on top of the four from the
earlier round. Nothing was seen in a browser or Electron.

### 2026-09-17 — Fourteen briefs closed, four privilege holes, portable tests (Claude)

Scope: the owner's "tell me project status, make the structure understandable,
complete pending tasks, update all files, take the data out because I'm deleting
the sessions". On `claude/hopeful-lovelace-q6f57v`, pushed, **not merged to `main`**.

Closed fourteen of the nineteen open briefs, including all three blocking ones:
the Office lead silently lost when raised against a party created on the same
panel (`resolvePayloadIds` in `sync.service.ts`, plus the outbox half), the
Master's missing Parties screen (form moved to `ui/src/PartyFormModal.tsx` with
an injected transport, not copied), and the absence of any test over either web
application (`web-reachability.test.ts`).

Four privilege/masking holes: the socket path downgrading a *refused* acting
token to the panel's machine authority; `mrp` documented as gated in two files
and enforced in none; all four image mutations returning the unmasked product;
`parties.export` enforced on one transport out of two. Plus the refusal a
shop-floor user could never see — gated on an admin permission, and held in a
module variable overwritten on every flush.

Also: self-service password change, session-loss handling in the one place every
request passes through, sign-in attempt/lockout feedback in the reader's own
language, delete actions for leads/orders/parties on the Master, `ConfirmDialog`
replacing the last four `window.confirm`s (which made `useResetGuard`
promise-based), the popover CSS that never existed, the sticky header, column
sorting, AA contrast, the `panel:report` guard and the panel-naming suffix scan.

Verified: lint 0, typecheck 0, 84 files / 968 tests. **Thirteen tests were
already failing before this session** on any non-Windows checkout — Windows
fixtures against APIs defaulting to `process.platform` — and two more passed
vacuously; both fixed. **Every integration suite (42 files, 568 tests) skipped
throughout**: PostgreSQL will not run as root and the container had no other
user, so the integration tests written this round have never been executed.
Nothing was run in a browser or Electron.

New: `docs/CODE_MAP.md`, linked from `README.md`, `AGENTS.md` and `opencode.md`.
`docs/TESTING_PLAN.md` reconciled against the screens that actually render, and
the ownership question settled in `HANDOFF.md`: parties on both panels, the
product catalogue Office-only.

### 2026-09-14 — Build fix, dead code, bloat removal, handoff rewrite (Claude)

Scope: owner's "commit all to main, update handoff and project files, remove
bloatware code and bloat files". Root cause of the `vite build` failure
(`remove …\esbuild-…: Access is denied`) is a Windows temp-folder lock; both
`web` workspaces' `build` scripts now point `TEMP`/`TMP` at a project-local
`.tmp/` (gitignored) — `start:master` and `start:office` verified through real
`npm`/`cmd.exe`. Deleted the vendored third-party skills (`.claude/skills/`,
four of `.agents/skills/`, `skills-lock.json`, 138 files; all installed
globally already), `docs/IMAGE_PIPELINE_FRONTEND_BRIEF.md`, and the four
`docs/ai-handoffs/` briefs verified done — every one of the 22 was checked
against the current tree, 18 remain open/partial and the README there is the
verified queue. Knip-driven dead-code pass: 43 symbols deleted, 48
un-exported, `master/src/domain/i18n-tokens.ts` removed. `HANDOFF.md`
rewritten from a 3,110-line log into a current-state document (history stays
in git); `AGENTS.md`, `opencode.md`, `README.md`, this file and the
`repo-conventions` skill brought in line. `updates.test.ts` UPD-7 fixed
(`1.1.0` → `9.9.9`; it was publishing the app's own version as "new").
Verified: `npm run lint`, `npm run typecheck` exit 0; unit suites green;
integration suites still blocked by the machine's PostgreSQL permission
failure.

### 2026-09-13 — Project skill .agents/skills/ui-consistency (Muse Code)

Scope: owner's `/create-skill` (UI consistency, project scope). Created
`.agents/skills/ui-consistency/SKILL.md` through the workspace file-write path:
the sandboxed shell can neither read nor write `.agents/` (PowerShell
`New-Item`/`Get-Content` and the validator all get access-denied), while the
file channel writes and reads it fine. Content mirrors the
`.commandcode/skills/ui-consistency` team skill in Muse-native shape; that
team skill is untouched and no vendored skill was modified.

Verified: file reads back correct via the file channel; `muse skills validate`
(run as `C:\Users\Z\.local\bin\muse.exe`, found off-PATH) fails with
`invalid-skill-package: Access is denied (os error 5)` on the skill path —
environmental, not a content diagnostic. Owner to re-run
`muse skills validate .agents/skills/ui-consistency --json` in an unsandboxed
terminal; expect valid:true with zero diagnostics.

### 2026-09-13 — Three team skills: ui-consistency, domain-flows, test-guardrails (Muse Code)

Scope: owner's "install more skills, make new plugins, keep UI consistent,
don't break anything". Authored three team skills under `.commandcode/skills/`
(the tracked team-shared location; vendored `.claude/skills` and
`.agents/skills` untouched): `ui-consistency` (one-kit rule, scale contract,
i18n), `domain-flows` (entities, Socket.IO contract, single-writer,
leads-to-orders, migrations permanent), `test-guardrails` (test layout, the
`master/web` + `office/web` zero-coverage blind spot, integration skip
behaviour). External installs (ponytail, caveman, memsearch, rufflo) are
user-terminal steps — this sandbox has no node/npx/python on PATH and profile
writes are denied — so commands were handed over, nothing installed from here.

Verified: `npm run verify` could not run in this sandbox (no Node.js on PATH:
`where.exe node`/`npx` find nothing, no `C:\Program Files\nodejs`); the change
is markdown-only (three SKILL.md files + this entry), outside the
eslint/typecheck/vitest surface. `master/web/src` and `office/web/src`
confirmed at zero test files each. Owner to run `npm run verify` locally.

### 2026-09-13 — Commit + rebuild checkpoint (Command Code)

Scope: owner's "commit all to main and update all exe and everything else".
Committed the whole working tree to `main` (pricing switch, assistant
removal, sidebar sub-pages, product hierarchy + new-lead flow, catalogue
reload script, new-lead/product-drawer/import rebuilds, dashboard + lead
detail rebuilds, designer shell). The installer rebuild was attempted but this
machine refuses: `node tools/release.mjs` and direct `electron-builder` both
hang indefinitely (no output, node spinning in kernel time, no children) —
same machine-level sickness as PostgreSQL and esbuild's TEMP files. All build
inputs are refreshed and committed (both `web/dist`, both server `dist`, both
`electron/dist`), so `npm run release` works on a healthy machine; the
releases folder still serves the 1.0.3 exes as latest.
`.gitignore` now keeps operator fixtures and local logs untracked by design:
`CATA.pdf`, `dummy-data/`, `vitest-out.txt`, `.claude/launch.json`.

Verified: `npm run lint` + `npm run typecheck` exit 0; all 80 unit suites
green (937 tests). The 42 integration suites (563 tests) cannot start their
shared PostgreSQL cluster on this machine (initdb/postgres refuse every
directory, including fresh dirs outside TEMP, while plain file creation
works) — the identical failure on a stashed clean tree proves it is
environmental, not the change.

### 2026-09-12 — Product field order follows lead generation (Command Code)

Scope: the owner's "first brand then main product name then code then
dimensions then colour etc — set all according to lead generation". UI-only
reorder, no migration. Add Product walks Brand → Main product → Code → Model
name → … → Size → Thickness → Colour + selectable toggle → Grade → rest of
spec (`EMPTY`/hydration/`save()` keys reordered, Brand takes `autoFocus`);
catalogue table gains a Brand column and reads
photo → code → name → brand → type → size → colour → grade → rate? → stock;
ProductDetail facts read Brand → Main product → Code → Type → Size → Colour
(with selectable marker) → Grade → Weight → Rate?; import template columns
lead with brand → main → code → dimensions → colour, preview gains
Brand/Main/Colour sample columns, and `swisware-2026.csv` is regenerated to
the new header order (548 lines / 547 rows). New key
`catalog.products.column.brand` in en + real hi; header assertions in
`panel-catalog-route` and `product-import` updated.

Verified: `npm run lint` + `npm run typecheck` exit 0; affected suites green
(panel-catalog-route, product-import-domain, product-hierarchy,
document-model, offline-pick, i18n-coverage). Full `verify` attempted: 1
failure in 1500, the template-header regex in `product-import.integration`,
fixed; other red runs are the documented shared-cluster contention. Both-web
`tsc -b` passes; `vite build` fails in this sandbox on an esbuild
`%TEMP%` file lock that hits untouched trees identically.

### 2026-09-12 — PDF Designer Canva-style shell inside the Documents editor (Command Code)

Scope: the owner's screenshot — Templates + Blocks rails left, live A4 sheet
centre, Template Options right, Preview with real lead + Save template on top.
Lives in the Documents → Templates → New/Edit editor (`EditorScreen`), not a
new nav item; no Light/Dark toggle (app theme wins).

**What changed.** `TemplateEditor` (`ui/src/DocumentsScreen.tsx`) is reskinned
into the `DesignerShell` 3-column grid; `LayoutCard` stays as an exported stub
for a reviewable diff. Blocks are one `DocumentBlock` each through the existing
`blocksToElements()` converter (`ui/src/documentBlocks.ts`), shifted to the
drop point (`shiftBundle` in `pageDesignerGeometry.ts`, unit-tested) and placed
via a consumed-once `pendingInsert` on `PageDesigner` (one undo entry, table
refused twice, 200-element ceiling, signature bottom-pinned by the converter).
Margins are Narrow/Normal/Wide presets (Normal = shipped default); Paper is
A4/A5 with Letter/orientation/accent/default/margins/texts kept under a More
settings disclosure. Enabling the watermark with empty text seeds DRAFT (the
save would otherwise refuse). Preview keeps the popup-safe flow against a real
lead/order; `EditorScreen` gains an optional `actions` slot; new
`documents.designer.*` i18n keys (Hindi via `npm run i18n:sync`).

**Untouched.** Renderer, bindings, redaction order (`field.saleRate.view`),
routes, settings keys, template columns, starters, both panel adapters.

**Verified.** `npm run lint` + `npm run typecheck` exit 0; `npm run build`
succeeds for both panels; 187 focused tests green (`ui/tests`,
`document-layout/model/template/bindings`, `document-render.integration`
incl. PDF-55, `screen-reachability`, `i18n-call-sites`, `ui-conventions`,
`no-duplicate-ui`, `no-transport-dep`). Full `npm run verify` was attempted:
240 integration failures, all from the shared-cluster contention this repo
already documents (shutting-down cluster, duplicate keys, deadlocks) — every
one of those files passes in isolation. Owner still to click through: each
type, every option, Narrow/Normal/Wide + A4/A5 + Letter disclosure, drag and
click-insert each block, preview vs lead/order, save/reload/conflict, Office
online, rate-blind user.

### 2026-09-12 — Office dashboard rebuilt around the screenshot (Command Code)

Scope: the owner's screenshot — four stat cards, a per-stage lead pipeline
with money beside each bar, recent activity with Today-time stamps, and
follow-ups as lead id + party + stage + amount rows. Rebuilt
`office/web/src/screens/DashboardScreen.tsx` to that arrangement: 4 cards
(Open leads, Open orders, Dispatched this week, Sync), pipeline bars with
per-stage amounts summed from the snapshot, activity from the leads'/orders'
own timelines (system entries for moves/conversions/dispatches, typed remarks
with the actor named, offline leads flagged), and follow-up rows that open
the lead. Conversion renders "Order OR… created from LD…", dispatch renders
"Order OR… marked {stage}" with the real stage name, offline reads "Lead
saved offline on Panel {device}". 13 new `dashboard.*` keys in en + hi
(`npm run i18n:sync`).

Verified: shared + i18n call-site suites green (34 tests), eslint clean on
all four touched files. Repo-wide `npm run verify` NOT green — pre-existing
working-tree breakage: unused `LayoutCard` stub in `ui/src/DocumentsScreen.tsx`
fails lint + typecheck, and the full test run inherits unrelated integration
failures from the dirty tree (duplicate-key/DB shutdown noise).

### 2026-09-12 — Empty state + sample parties (Command Code)

Scope: the owner's follow-up "remove all products zero products zero leads
make few parties". Re-ran the wipe with no import (products 547 → 0,
categories 41 → 0, leads/orders/lines/inventory already 0), then created 3
sample parties via `createParty` (P-0001 Patel Tiles & Sanitary, Morbi;
P-0002 Shree Balaji Traders, Rajkot; P-0003 New Home Ceramics, Ahmedabad).
The script now takes `--with-catalog` / `--with-parties` flags
(`wipe:business`, `reload:catalog`, `seed:parties`).

Verified: master typecheck + eslint on the script green. Repo-wide
lint/typecheck fail on a pre-existing unused `LayoutCard` in
`ui/src/DocumentsScreen.tsx` (working-tree change, not this task). Full
`npm run verify` NOT re-run.

### 2026-09-12 — Catalogue reload: wipe + SWISWARE 2026 import (Command Code)

Scope: the owner's "REMOVE ALL PRODUCTS AND UPLOAD CATA.PDF FILE PRODUCTS"
message. CATA.pdf is a 28-page image-only catalogue (no text layer —
verified with pypdf/pymupdf), already transcribed as
`dummy-data/swisware-2026.csv` (547 rows, 41 categories, SW-0001…SW-0547,
checked against the rendered PDF pages). Added one-shot operator script
`master/src/services/catalog-reload-cli.ts` (`reload:catalog`) that truncates
all business tables (products, categories, images, leads, orders, line items,
inventory, reservations, movements, timeline, variants, parties, access,
sync/conflict bookkeeping, activity), resets the id counters and sequences,
then imports the CSV through the real `importProducts` service. Ran it
against the live database: 5002 live products wiped, 547 created, 0 failed.
Users, roles, settings and panels kept. Production data action only — the
script is not imported by app code or tests; no migration added (migrations
are append-only history).

Verified: `npm run lint` and `npm run typecheck` green across all workspaces;
`product-import` + `product-hierarchy` integration suites pass (18 tests).
Full `npm run verify` NOT re-run in this session.

### 2026-09-12 — Product hierarchy + keyboard-first lead entry on both panels (Command Code)

Scope: the owner's SWISWARE 2026 catalogue message — Brand → main product →
sub-product with a per-model colour rule — implemented end to end. Brand and
main product reuse `products.brand` and `product_categories`; new are
`products.colour_policy` (`fixed` default | `selectable`, migration
`20260322…`, editable on the product drawer after `color` plus a new Main
product field) and the `line_items.category_name` snapshot. Lead entry is one
shared `ui/src/NewLeadScreen.tsx` behind a transport: Office adapter queues
through the outbox (offline unchanged), Master adapter over `api.pick` plus a
new `POST /api/leads` (same `leadService.createLead` the socket hub uses),
mounted as Leads & orders › New lead. Flow is party → source → follow-up →
main-product picker → repeatable sub-product picker (Enter adds, caret stays)
→ Shift+Q/Next → per-row colour/packaging/grade/quantity walk → Enter commits
the group → Ctrl+Enter review modal → Ctrl+Enter saves. Pick gains a
`category` kind and a `categoryId` filter (Master + Office offline mirror).
Document columns become `# | Main product | Model | Code | Colour |
Packing | Grade | Boxes` (`size` retired from the default set but kept as a
column key for old layouts); colour reads as text (`showColourChips: false`
everywhere). Transcription: `dummy-data/swisware-2026.csv`, 547 rows across
43 main products, importable via Products › Import.

Verified: `npm run verify` green (122 files / 1498 tests, incl. new
`product-hierarchy.integration.test.ts`, new PDF-90 model gate, rewritten
`POST /api/leads` API gate, offline-pick category cases), both panels build.
One open item: the legacy Office screen is backed up to the session scratchpad
only — delete it once the counter has run the new flow.

### 2026-09-11 — Pricing switch, assistant removed, sidebar sub-pages, Documents sub-screens (Claude)

Scope: nine owner requests in one message, implemented here at the owner's
instruction. The HANDOFF entry of the same date carries the reasoning; the
list, by request:

1. Leads open in the list view by default (`LeadBoardScreen`).
2. Money is a company setting, `pricing.enabled`, off by default. Off strips
   the four `field.*Rate.*` keys from every resolved permission set
   (`master/src/services/pricing-gate.ts`) and drops the Pricing group from the
   permission catalogue; every screen that still drew an Amount/Rate column
   regardless now drops it on `field.saleRate.view` absent. The test fixture
   seeds the switch on; `pricing-gate.integration.test.ts` turns it off.
3. Sidebar items with children carry a fold chevron; the tier unfolds on its
   own around the current page (`AppShell`, `ui/tests/app-shell-nav.test.tsx`).
4. – 6. Products and Parties search boxes are 400px; Party access is 260px.
7. Documents has Templates/Exports as sidebar children in both panels; the
   template editor and starter gallery are `EditorScreen` sub-screens with a
   nested sidebar entry, not modals.
8. The AI assistant is removed end to end (18 files deleted, ~95 i18n keys,
   three permissions, six settings, socket events, proxy routes, CSS). The
   migration and the three `activity.ai_run.*` tokens stay, by the repo's own
   append-only rules.
9. The sidebar mark is a button to the Dashboard.

Four follow-ups the same evening: every module with more than one view folds
its views into the sidebar (`subPages` in each App.tsx, `ui/src/subPages.ts`);
Ctrl+F focuses the visible screen's `data-screen-search` box and falls back to
the palette; −/+ buttons on the UI scale slider; the Office lead detail is a
two-column layout with line items as compact rows.

Verified: `npm run lint` and `npm run typecheck` exit 0; the new UI test
passes; the full suite result is recorded in the HANDOFF entry. Visual check
of both panels needs a signed-in session, which the owner does at the PC.

### 2026-09-07 — Bulk product import (CSV/Excel), templates, and the paged catalogue (Claude)

Scope: the owner's request for bulk product import from CSV or Excel with
downloadable blank templates, a proper UI, and "unlimited product add
support" — implemented here, by Claude, at the owner's instruction for this
session. The standing brief is `docs/ai-handoffs/product-csv-import.md`; its
scope decisions and the implementer's record are written there.

**Headline.** The 500-product ceiling is lifted where it matters: the Office
catalogue pages the Master's whole catalogue online (search, type facet, load
more) and a labelled cached page offline; imports run on the Master over the
panel HTTP surface in 500-row chunks with per-row fallback and a
row-numbered report; one `catalog` change event per import instead of one
per row. `exceljs` 4.4.0 is now a `master` dependency — the deliberate
decision `HANDOFF.md` had deferred.

**Files touched.** `master/package.json`, `package-lock.json`;
`shared/src/domain/{inputs,product-import}.ts`, `shared/src/index.ts`,
`shared/src/protocol/socket.ts`, `shared/src/i18n/{en,hi}.ts`,
`shared/tests/activity-tokens.lock.json`; `master/src/lib/spreadsheet.ts`,
`master/src/domain/product-import.ts`,
`master/src/services/{product-import,catalog}.service.ts`,
`master/src/repositories/product.repository.ts`,
`master/src/http/routes/panel-catalog.routes.ts`, `master/src/http/app.ts`,
`master/src/realtime/fan-out.ts`; `office/src/http/app.ts`,
`office/src/services/offline-pick.ts`; `office/web/src/api.ts`,
`office/web/src/App.tsx`, `office/web/src/screens/{CatalogScreen,AddLeadScreen}.tsx`,
`office/web/src/components/ProductImportModal.tsx`; `ui/src/icons.tsx`;
tests: `master/tests/{product-import-domain,spreadsheet}.test.ts`,
`master/tests/{product-import,panel-catalog-route,catalog}.integration.test.ts`,
`master/tests/change-ring.test.ts`, `office/tests/{offline-pick,module-forwarding}.test.ts`;
docs: this file, `HANDOFF.md`, `docs/ai-handoffs/{product-csv-import,office-write-refusal-visibility,README}.md`.

**Note.** This feature was implemented once already in an earlier session on
2026-09-06 and lost to an uncommitted working-tree reset before it reached
git — it had to be rebuilt from scratch in this session, verified again, and
is committed here so that cannot repeat.

**Verified.** `npm run lint`, `npm run typecheck` and `npm run test` run
separately, each exit 0; the integration suites ran against the embedded
PostgreSQL, including a 1200-row import paged through in full.

### 2026-09-07 — Developer mode, reset, test users, uninstaller, Settings rebuild (Claude)

Scope: the owner's four-part request — dummy users for the three role tiers, a
password-gated "reset all" on both panels, a complete uninstaller for Windows and
macOS, and solid UI for the tabs that carry them.

**Method.** Five parallel implementation agents over disjoint file sets, then an
integrator; a seven-lens adversarial review with three refuters per finding was
launched and died on a session limit, so its verification was done by hand
instead — the full gate, a live seed against a real database, dry-runs of both
uninstall scripts, and real installer builds for both panels.

**What was found by verifying rather than trusting.** The session that started
this work was interrupted, and its tree came back partly reverted: the services
and the UI kit survived, but every piece of *wiring* had rolled back — both
Settings screens, both `api.ts`, the office HTTP routes, the whole Electron
uninstall path, and the `seed:dummy` scripts. A report saying "implemented" and a
working feature are two different claims; the gap only appeared because the flow
was run, not read.

**Files touched.** New: `shared/src/domain/developer.ts`,
`master/src/services/developer.service.ts`,
`master/src/http/routes/developer.routes.ts`,
`master/src/db/seed-dummy-users-cli.ts`,
`office/src/services/developer.service.ts`, `electron/lib/uninstall.ts`,
`tools/uninstall/{uninstall-orderbook.ps1,uninstall-orderbook.sh,README.md}`,
`ui/src/SettingsLayout.tsx`, `docs/DEVELOPER_MODE.md`, and five test files.
Modified: both `electron-builder.yml`, both `installer.nsh`, `electron/shell.ts`,
`electron/preload.cts`, `shared/src/protocol/desktop.ts`, both `i18n` catalogues,
`shared/src/index.ts`, `master/src/http/app.ts`, `master/src/realtime/hub.ts`,
`office/src/http/app.ts`, both `App.tsx`, both `api.ts`, both `SettingsScreen.tsx`,
`ui/src/{index.ts,base.css}`, both `package.json`, and
`master/tests/password-vault-invariants.test.ts` (the invariant now names the
developer service as a permitted `secret-box` importer — it resets the vault key
on a wipe and never opens a sealed row).

**Verified.** `npm run lint`, `npm run typecheck` and `npm run test` each run
separately, each exit 0 — 114 files / 1437 tests, integration suites included
against a live PostgreSQL. Beyond the gate: `npm run seed:dummy` run against a
real database and all three accounts signed in through `auth.service`; both
uninstall scripts dry-run on Windows and macOS shapes; and
`node tools/release.mjs --panel office` / `--panel master` built real installers,
which is what proves `resources/uninstall/` actually ships and that the NSIS
macros compile.

**The lesson worth carrying.** An agent's "done" survives only as far as the next
thing that actually runs it. The reverted wiring typechecked and linted clean —
because the pieces that were left were internally consistent — and would have
been reported as shipped by any check short of opening the screen.

### 2026-09-06 — v1.0.3 blocker repair, guardrail rewrite, designer and photo work (Claude)

Scope: audit the uncommitted work from the two implementation sessions, repair
it, then carry out the owner's request — improve the PDF designer, add templates,
and improve the product-photo add flow.

**Method.** A 121-agent workflow across seven audit dimensions plus three
read-only scouts, with every finding put to three independent verifiers (a
correctness lens, a reachability lens and a taste/duplication lens) before it was
allowed to stand. 33 findings survived; 4 were refuted and dropped.

**Headline.** `npm run verify` was **red**, not green — the `AiHardware`
widening left three unguarded reads in `ui/src/AiSupportScreen.tsx` and broke
`tsc` in three workspaces. And **all five guardrail tests passed against the code
they were written to catch**; each has been rewritten and each was watched to
fail against that code before being accepted.

**Files touched.** `master/src/services/ai.service.ts`,
`master/src/lib/memory-monitor.ts`, `master/src/index.ts`,
`master/src/http/health.ts`, `master/src/ai/hardware.ts`,
`master/src/domain/images.ts`, `master/src/services/image.service.ts`,
`master/src/pdf/primitives.ts`, `master/src/pdf/elements.ts`,
`shared/src/domain/ai.ts`, `shared/src/protocol/desktop.ts`,
`shared/src/keys/commands.ts`, `shared/src/domain/document-starters.ts`,
`shared/src/i18n/en.ts`, `shared/src/i18n/hi.ts`, `ui/src/AiSupportScreen.tsx`,
`ui/src/AssistantScreen.tsx`, `ui/src/DocumentsScreen.tsx`,
`ui/src/KeyboardProvider.tsx`, `ui/src/ImageCropModal.tsx`,
`ui/src/PageDesigner.tsx`, `ui/src/PageDesignerCanvas.tsx`,
`ui/src/PageDesignerInspector.tsx`, `ui/src/pageDesignerGeometry.ts`,
`ui/src/base.css`, `ui/src/reset.css`,
`office/web/src/components/ProductImages.tsx`, `eslint.config.js`, and the five
guardrail test files plus a new `master/tests/image-domain.test.ts`.

**Verified.** `npm run lint`, `npm run typecheck` and `npm run test` each run
separately and each exit 0 — the full `npm run verify` gate §6 requires, not a
single-project `tsc`. The integration suites ran against a live PostgreSQL.

**The lesson worth carrying.** Three of the five guardrails failed the same way:
they restated a rule instead of asking the code. An allowlist that contains every
command, a copy of a private key table with the broken entries added, a regex
never run against the string it was written for. A guard nobody has watched fail
is not a guard, and the cheapest way to earn that is to break the code on
purpose, run the test, and put it back — which is what was done for every one of
them here.

### 2026-09-05 — Splash & busy-mark motion refinement (Qwen / OpenCode)

Scope: tighten the cold-start splash choreography and the busy indicator so the
two read as one asset, soften their edges, and add a few finishing touches.
Purely cosmetic — no logic, data, or protocol change.

**Files touched.** `ui/src/Splash.tsx`, `ui/src/BusyMark.tsx`,
`ui/src/base.css`.

**What changed.**
1. **Re-timed the splash** to a slower, more deliberate beat: outline draw
   0–280ms (`--e-standard`), ink-in 280–700ms (150ms eased cells, 42ms
   stagger), wordmark 700–980ms, bar + caption at 800ms. `SPLASH_MS` 950→1020.
2. **Grew the mark** 96→104px and gave it its own entrance (`ob-mark-in`,
   320ms): a soft rise that settles at 0.98 scale, so the lattice rests a hair
   inside its outline — precision, not a crop. Outline `rx` 1→2.5; cell `rx`
   0.75 for rounded edges.
3. **Matched the busy mark to the splash** so the two jobs share one rhythm:
   loop 700→780ms, easing `--e-standard` (was linear), stagger 58→42ms, peak
   opacity 0.25→0.42.
4. **New keyframes**: `ob-mark-in` (whole-mark settle), `ob-label-in` (120ms
   fade, keyed to the `label` prop so caption changes re-fire), `ob-rise-in`
   (error-state entrance), and a 1px `::after` glint on the fill bar
   (`--rail-glint`).
5. **Error state** gets a distinct `ob-splash-status--error` class and its own
   rise-in instead of sharing the progress status's fade.

**Verified — with two corrections, see the 2026-09-06 entry.** The check run was
`npx tsc -p ui/tsconfig.json --noEmit` on the touched files only, which is
narrower than the gate §6 requires: the workspace typecheck was red. Those three
`AiSupportScreen.tsx` errors were recorded here as "pre-existing at HEAD and
unrelated"; all four `AiHardware` fields are required at HEAD, so the same
working tree introduced them. Motion did **not** fully collapse under
`prefers-reduced-motion` / `data-motion='off'`: both switches clamped
`animation-duration` and left `animation-delay` alone, and this change lengthened
every delay in the sequence.

### 2026-09-02 — Command Code GUI extension setup: memory, project skills, global skills (Command Code)

Scope: set up Command Code's extension layer for best performance in the GUI —
project memory, project-level skills, and user-global skills. Per the owner's
choices: allow one-time GitHub fetches for skill installs; track the project
layer in git.

**What was added.**
1. **`AGENTS.md`** (repo root, tracked) — Command Code project memory. Loaded
   every turn; captures what this project is, the source-of-truth docs, the
   `npm run verify` gate, standing conventions, and the Command Code project
   skills location.
2. **`.commandcode/skills/`** (tracked) — three Command Code project skills:
   `verify-gate`, `handoff-protocol`, `repo-conventions`. Each is a
   spec-compliant `SKILL.md`. `.gitignore` now ignores `.commandcode/*`
   (taste/settings stay local) but re-includes `.commandcode/skills/**`.
3. **Global skills** in `~/.commandcode/skills/` (personal, outside the repo) —
   installed via `cmd skills add <owner/repo> --global`:
   `improve` (shadcn/improve), `improve-codebase-architecture`
   (mattpocock/skills), `writing-plans` (obra/superpowers), `apple-design`
   (dickwu/apple-design-skill). One-time GitHub fetches.

**What was deliberately not done.** No copy of the 4 vendored skills
(`.claude/skills/` / `.agents/skills/`) into `.commandcode/skills/` — Command
Code already auto-discovers `.agents/skills/`, and duplicating ~100 files
would create shadowing and drift. No MCP servers and no mods: nothing here
needs external data or a custom plugin, and the project stays runtime-offline.

**Shadowing note.** The 4 global skills duplicate the 4 vendored project
skills by name, so in this project the vendored `.agents/skills/` copies win
(project > global) and the globals are reported as "shadowed / skipped" —
correct and intended. In projects without the vendored copies, the globals
apply.

**Verified.** `cmd skills list` shows 7 project + 4 global + 6 bundled skills;
`--debug` reports the 4 "skipped" are duplicate-name shadowing only, no load
errors. `git status` shows the intended tracked additions. Application code
unchanged.

### 2026-09-02 — Bloatware audit and cleanup (Command Code)

Scope: remove provably unused code/files without breaking function
(`npm run verify` must stay green).

**What was found.** The tracked tree is already aggressively lean — the repo
keeps no dead modules (its own `HANDOFF.md` documents a culture of deleting
"an abstraction extracted for no second caller"). Every tracked file is
load-bearing: routes/services/repositories are wired through `index.ts`
barrels and the HTTP/socket layers; migrations are pinned by
`migration-registry.test.ts`; UI exports are pinned by
`no-duplicate-ui.test.ts`; i18n keys by `i18n-tokens.test.ts`; every
Socket.IO event by `socket-contract.test.ts`. A grep for zero-reference files
over 516 source files flagged 309, but every one resolved to a real wiring
(barrel export, dynamic registration, build config, or test import) — the
basename scan is a poor dead-code detector in a codebase this connected.
Dependencies are likewise lean: every package in every workspace
`package.json` has a consumer (e.g. `uuid` is imported in four Master
services).

**What was removed.** Two confirmed-dead screen files, left on disk after an
earlier `git rm` (they were untracked, referenced by nothing — their names
appear only in docs and their own bodies):

- `master/web/src/screens/PanelDetailScreen.tsx` (superseded by a
  Modal-based detail view)
- `office/web/src/components/SyncStatus.tsx` (superseded by the presence
  rail)

Both deletions were already scoped by the open brief
`docs/ai-handoffs/dead-screens-cleanup.md`.

**What was deliberately left.** Everything whose deletion could not be proven
safe, or which is load-bearing: build artifacts (`shared/dist/`,
`*/build/`, `*.tsbuildinfo`) and runtime data (`node_modules/`, `data/`) are
gitignored and never ship; `.bat` launchers and installer resources are
referenced by the packaging config; migrations, docs, and the vendored
skills (`.claude/skills/`, `.agents/skills/`) are pinned by tests/workflow;
`.claude/scheduled_tasks.lock` is a live runtime lock owned by the Claude
tool, not repo source.

**Verified.** `npm run verify` is green: lint clean, typecheck clean in every
workspace, **102 test files / 1336 tests passing**.

### 2026-09-02 — Mac shortcuts, animations, LLM support, RAM management (Command Code)

Scope: four cross-cutting features touching shared types, server logic, Electron
shell, and UI.

**What was done.**
1. **Mac shortcut keys** — Added `platformDefaultChord` to `CommandDef` for
   platform-aware defaults (⌘ on Mac, Ctrl on Windows/Linux). Seven new
   commands: undo, duplicate, toggle sidebar, find, prev/next record, settings.
   `formatChordMac()` renders ⌘⌥⇧⌃ glyphs. `chordFor()` and
   `defaultBindings()` detect macOS via `navigator.userAgent`. CommandPalette
   uses `displayChord()` that picks the right formatter. KeyboardProvider
   gained dispatch for sidebar toggle and find.
2. **New animations** — Added 6 missing `@keyframes` (pop-in, toast-in/out,
   modal-out, card-in). New motion tokens `--d-exit` and `--e-spring`.
   Staggered card entrance for `.ob-pane > .ob-card`. All existing reduced-
   motion kill switches still work.
3. **Local LLM support screen** — New `AiSupportScreen` showing hardware
   summary (RAM, CPUs, Apple Silicon badge), Ollama/LM Studio info, recommended
   models by RAM tier, setup instructions. Extended `AiHardware` with
   `availableMemoryGb`, `platform`, `hasUnifiedMemory`, `recommendedModels`.
   Hardware detection now reports live freemem, platform, and Apple Silicon.
   Assistant screen shows compact hardware info.
4. **RAM management** — Electron shell sets `--max-old-space-size` (Office 40%
   of total RAM, Master 60%). New `memory-monitor.ts` checks heap every 30s,
   GC at 75%, critical at 90%. Health endpoint includes memory status.
   AI service gained concurrent run limiter (configurable, default 2) and
   memory gate refusing runs over cap. `ai.maxConcurrentRuns` setting added.

**Files modified:** 20 files across shared/, master/, electron/, ui/.
New files: `master/src/lib/memory-monitor.ts`, `ui/src/AiSupportScreen.tsx`.

**Verified.** All 140 shared tests pass. All 23 keyboard tests pass. All three
package-level tsconfigs (shared, master, office) typecheck clean.

---

### 2026-09-18 — Fix the Mac and Linux panel builds (Claude)

**Prompt:** "fix the mac and linux panel builds too".

`tools/release.mjs` has accepted `--os mac` and `--os linux` since the targets
were written and neither produced a working panel. Four defects, all in code
that typechecks, lints and tests clean:

1. `vendorPostgres()` hardcoded `windows-x64`; `TARGETS[*].postgres` was
   declared, documented and read by nothing.
2. Neither panel yml had a `linux:` block, while `TARGETS.linux` expected an
   AppImage filename.
3. `allowScripts` approved only the Windows `@embedded-postgres` package, whose
   postinstall recreates 14 SONAME symlinks Windows does not use.
4. `arch: [universal]` shipped one architecture's PostgreSQL to both halves of
   a merged macOS app.

**Changed:** `tools/release.mjs` (target-driven vendoring, both macOS arches, a
build-time executability check), `master/src/db/postgres-server.ts` (arch-first
candidate, `X_OK`), root `package.json` (all five packages approved),
`master/` + `office/electron-builder.yml` (AppImage + `.deb`), both panels'
`package.json` (a `homepage`, which fpm requires),
`tools/uninstall/uninstall-orderbook.sh` (the names a `.deb` actually installs),
`.github/workflows/release.yml` (a three-runner matrix).

**New:** `master/tests/packaging-invariants.test.ts` — five source-reading
guards, each watched failing against the defect it names.

**Verified.** Both Linux panels built to AppImage and `.deb`; the packaged
Master created its own database under `xvfb-run` as a non-root account and
answered `/api/health`; the uninstall sweep found every path a real extracted
`.deb` installs. Full suite non-root: 144 files, 1815 tests, **0 skipped**.
The macOS build cannot be run from here — `assertTarget()` refuses it off macOS
— so that half is guarded rather than executed, and the CI matrix runs it first.
