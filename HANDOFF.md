# HANDOFF — Session Context

Read this first in any new session on this repo. It records what is decided
and what is true *now*; the full day-by-day history up to 2026-09-13 lives in
git (`git show f875360:HANDOFF.md`) and in the change log of
`docs/AI_COLLABORATION.md`. Keep this file current, not cumulative: when a
session changes reality, edit the section that describes it and add a short
dated entry under "Recent sessions"; prune entries older than a few weeks.

## What this project is

**OrderBook** — an offline, LAN-only order and inventory management app for a
ceramic company. No internet at runtime, ever. Two cooperating web apps, each
also shipped in an Electron shell:

- **Master Panel** — one PC, owns the PostgreSQL database and all files. Every
  write goes through it.
- **Office Panel** — other PCs on the same LAN, thin clients used by staff to
  create leads, manage parties/products and promote leads to orders. No
  database of its own; keeps a snapshot cache and an outbox for offline work.

It is order management, not billing: since 2026-09-21 the software carries
**no money at all** — no rates, amounts or totals anywhere (the opt-in
`pricing.enabled` switch and everything behind it were removed at the
owner's decision). The AI assistant was removed for good on 2026-09-11; the
PDF Designer (Documents module) on 2026-09-19 — the Reports PDF export stays.

### Where the truth lives

| Question | Read |
|---|---|
| Requirements, pairing design, screen flows | `docs/PROJECT_PLAN.md` |
| Every table, column, index and why | `docs/schema/` (start at `00-overview.md`) |
| Lead → order flow as built | `docs/LEAD_GENERATION_FLOW.md` |
| Roles, users, permissions, tiers | `docs/ROLES_AND_USERS.md` |
| Developer password, reset, test users | `docs/DEVELOPER_MODE.md` |
| Shipping an update / release ordering rule | `docs/UPDATES.md` |
| Manual QA script | `docs/TESTING_PLAN.md` |
| Fields, Logs, Recycle Bin, Reports, i18n design (the PDF Designer chapters are historical) | `docs/BACKEND_MODULES.md` + `docs/backend-modules/` |
| The product master: category → model → variant, weights, the Swisware seed | `docs/ai-handoffs/product-model-variants.md`, `docs/schema/02`, `03` |
| The product trim, pricing removed, multi-colour lines (2026-09-21) | `docs/ai-handoffs/product-master-trim.md` |
| The 2026-08/09 overhaul designs (stages 0–12, all implemented) | `docs/overhaul/` |
| Multi-agent workflow and per-session change log | `docs/AI_COLLABORATION.md` |

`docs/overhaul/` and `docs/backend-modules/` are cited from source comments
as design rationale. They were written before the code and several of their
stated facts did not survive contact with the tree — check a design's claim
against the code before acting on it.

## Current state (2026-09-21)

- **Version 1.1.0** on `main`, which on 2026-09-19 merged two lines that had
  diverged for eight days: the v1.1.0 line (pricing switch, assistant removed,
  sidebar sub-pages, free-to-sell switch, esbuild fix, dead-code pass) and the
  laptop line (PDF Designer removed, sample data, the product model → variant
  restructure). Where the two decided the same thing differently, the later
  decision won: the product hierarchy is the **variant** model, not
  `colour_policy`; the Designer is gone; the assistant is gone. `main` is the
  working branch; the owner commits and pushes to it directly. `dev` and the
  `claude/*` branches are historical and behind — do not branch from them.
- **Every stage of the overhaul programme is implemented**, plus everything
  listed under "Recent sessions". What is still owed is manual verification
  (below) and the items under "Owed work".
- **Verify gate:** `npm run verify` = `lint` + `typecheck` (all workspaces,
  both Electron shells, the test tsconfigs) + `vitest run`. Last full green
  run: 2026-09-21 (evening) on the laptop, after the product trim — lint and
  typecheck clean, 117 test files / 1401 tests, none skipped — integration
  suites against the embedded PostgreSQL 17 test cluster. On the
  owner's other PC the integration suites could not start that cluster on
  2026-09-14 (`initdb: could not create/change permissions`) — that is the
  machine, not the code. Run the three steps separately and check each exit
  code.
- **Builds:** `npm run build` is green for shared, both servers and both
  web bundles. The esbuild "`remove …\esbuild-…: Access is denied`" failure
  on this PC is fixed at the source: both `web` workspaces' `build` scripts
  point `TEMP`/`TMP` at a project-local `.tmp/` (gitignored) before `vite
  build`, so `start:master` / `start:office` work without any manual step.
  **Fixed 2026-09-21:** that script's `if not exist … mkdir … && …` was
  parsed by cmd as one `if` body, so once `.tmp/` existed every later build
  exited 0 *without running `vite build`* — the bundles on disk were from
  2026-09-19. The `if` is parenthesised now; check the bundle's timestamp
  if a UI change ever seems not to land.
- **Installers:** `C:\OrderBook-Releases` still holds the 1.0.3 setup files.
  `npm run release` (electron-builder) hangs on this PC — same machine-level
  permission sickness as PostgreSQL above. Build inputs are refreshed; a
  release run on a healthy machine (or after a reboot / Defender exclusion
  for the repo) should work.
- **Live databases:** external PostgreSQL via `.env` `DATABASE_URL` on both
  of the owner's machines (`order_book` on the PC, `order_book_new` on the
  laptop). **The first Master started from this `main` runs migration
  `20260323000000_product_variants`, which wipes every product-linked table**
  (products, categories, images, party-wise rates, stock, reservations,
  leads, orders, lines, timelines — the owner's decision of 2026-09-19), and
  then **`20260324000000_product_master_trim`, which drops every product,
  line, lead, order and party-record column that pricing and the tile trade
  had added** (in place, no wipe — the owner's decision of 2026-09-21; `down()`
  throws). Then Settings → Developer → *Load the Swisware catalogue* (or `npm
  run seed:catalogue`) loads the 12 / 251 / 549 catalogue with blank weights.
  The v1.1.0 `reload:catalog --with-catalog` script calls that same loader
  (its CSV path is gone). The laptop's `order_book_new` was migrated on
  2026-09-21.

## How to run

```
npm install
npm run verify                  # lint + typecheck + tests
npm run build                   # shared, both servers, both web bundles
npm run start:master            # → http://localhost:4100
npm run start:office            # → http://localhost:4200
npm run dev:master / dev:office # servers with reload; add dev:shared if editing shared/
npm run build:shell             # compiles electron/ and copies it into both panels
npx electron master/electron/dist/master.main.js
npx electron office/electron/dist/office.main.js
npm run release [version] [-- --panel office]   # NSIS installers (needs internet once)
npm run seed:dummy              # admin/Admin@1234, management/Manage@1234, office/Office@1234
```

Master-only operator scripts (`--workspace @orderbook/master`):
`wipe:business` (truncate business tables, configuration kept),
`reload:catalog` (wipe, then the Swisware catalogue through `seedCatalogue`),
`seed:parties`, and `seed:catalogue` (the loader alone, no wipe). They talk
to the live database — read `master/src/services/catalog-reload-cli.ts`
before running one.

Environment notes: Windows 11, PowerShell 5.1 (`&&` does not work — use `;`).
npm 12 blocks install scripts; approve native modules with
`npm install-scripts approve <pkg>`. Integration tests need PostgreSQL
binaries (`ORDERBOOK_PG_BIN` or an installed 17.x) and skip otherwise — a
skipped suite prints like a green one, so check that it actually ran.

## Where things live

```
shared/        types, Socket.IO event contract, UDP discovery protocol, i18n catalogue (en + hi), column map
ui/            the one shared React kit (49 modules, one barrel, consumed as source), screens shared by both panels
master/        Master server (src/) — domain/ → services/ → repositories/ → http/ + realtime/; migrations in src/db/migrations/
master/web/    Master React frontend
office/        Office server (src/) — sync/, outbox, local snapshot store, forwarding to the Master
office/web/    Office React frontend
electron/      one desktop shell; master.main.ts / office.main.ts are thin configs over shell.ts
tools/         release.mjs, i18n-sync.mjs, make-icons.mjs, uninstall scripts, eslint rules
docs/          all prose; nothing source-of-truth lives in a code comment
.commandcode/skills/   team-shared project skills (tracked); the rest of .commandcode/ is local
.agents/skills/ui-consistency/   the same UI rule in the shape Muse Code discovers
```

- **UI:** import from `@orderbook/ui`; never copy a component into a panel
  (`master/tests/no-duplicate-ui.test.ts` fails if one grows its own kit).
  Per-panel differences (name, default theme, storage key) come from
  `configureUi()` in each `main.tsx`. Vite must not pre-bundle `ui/`
  (`optimizeDeps.exclude`) because `assetsInlineLimit: 0` owns font emission.
- **Strings:** one catalogue `shared/src/i18n/en.ts`, Hindi mirror kept total
  by `npm run i18n:sync`; the twelve keys that differ per panel are
  `master.*` / `office.*`. A bare string in JSX fails lint; a `t('…')` naming
  a missing key fails `master/tests/i18n-call-sites.test.ts`.
- **Scale vs density:** `--root-size` (11–22px slider) is the continuous
  knob; density governs only row/control heights as rem ratios. Lengths
  measured against text use rem; hairlines and radii stay px; breakpoints are
  physical px, never rem/em. `master/tests/ui-conventions.test.ts` enforces it.
- **Sidebar sub-pages:** a module with more than one view declares them in
  its `App.tsx` `subPages` record (`ui/src/subPages.ts`); the screen takes the
  chosen key as a controlled prop. A record opens as a full sub-screen with a
  back button and a nested sidebar entry — not a modal, not a drawer.
  `Ctrl+F` focuses `<Input data-screen-search>` on the visible screen.
- **Company switch** (`inventory.freeToSell`) rides on `SignedInUser.features`
  (Master) and `SyncSnapshot.features` (panels), built by
  `master/src/services/company-features.ts`. There is no pricing switch and
  no field-level masking any more (2026-09-21).
- **Product master:** a product is name · category · alias · size · *made in
  every colour* switch · custom fields, with variants of code · colour ·
  weight. A lead line on a multi-colour product may name a colour from the
  `stock.colour` option list (`line_items.colour`); stock stays per variant.
  A line also carries a **grade** from the `line.grade` list
  (`line_items.grade`, 2026-09-22) — a line attribute, never a catalogue one,
  so the same variant can be sold as two grades on two lines.

## Working agreements

- **Verify before done.** A change is not done until `npm run lint`,
  `npm run typecheck` and `npm run test` each exit 0. `master/web` and
  `office/web` have no test files, so UI defects are invisible to the gate —
  a real browser or Electron pass counts as verification, and a change that
  was not run in the browser should say so.
- **Never delete or rewrite a migration** that may have run anywhere. Make its
  `up` idempotent and keep it; `master/tests/migration-registry.test.ts` pins
  the shipped names.
- **Single-writer.** The Master owns all persistent state; Office panels
  forward writes over Socket.IO and never write their own database.
- **Offline-only runtime.** Nothing loads from a CDN or calls the internet.
  Bundled fonts and assets only.
- **Docs and code live separately.** Prose in `docs/`, source in the
  workspaces. `.env` is gitignored and never committed.
- **Desktop only.** Design floor is 1024×768; "all screen sizes" means
  laptop-to-4K at 79–157 % scale, not a phone layout.
- **No pricing, no AI.** Do not reintroduce money anywhere — no rate, amount
  or total on any screen, document, report or API; do not bring the assistant
  back.
- **Before you stop, `git status` for `??`.** An uncommitted migration is
  indistinguishable from a deleted one to every other machine.
- **Guards must be seen to fail.** Before accepting a test written to catch a
  defect, break the code, watch the test go red, put the code back. Five
  guardrail tests once passed against the exact code they were written to
  catch.
- **Agent self-documentation is a claim, not evidence.** Verify a HANDOFF or
  change-log entry against the code before relying on it.

## Key decisions (do not re-decide without a reason)

1. **Two Node/Express + Socket.IO servers**, one per panel, each serving its
   own built React frontend on localhost.
2. **PostgreSQL, not SQLite** — the owner reaffirmed this when offered a
   switch. Bundled via `embedded-postgres` (server binaries only: `initdb`,
   `pg_ctl`, `postgres`; no `psql`, so use the `pg` driver). Fallbacks:
   `DATABASE_URL` (what the owner's PC uses) or `ORDERBOOK_PG_BIN`.
3. **Knex** query layer; Knex types never leave `repositories/`. Cross-repo
   transactions pass the opaque `TransactionContext` token.
4. **Custom UDP broadcast discovery** (not mDNS) with a manual IP/ID/password
   fallback. Protocol in `docs/PROJECT_PLAN.md` §4.
5. **Orders are their own table**; conversion copies the lines and stamps
   `converted_order_id` on the lead. Reserve at conversion, dispatch moves
   stock; inventory is per **variant**. One `line_items` table for leads and
   orders, one line per variant. Text record ids (`LD…`, temporary `A3F9K2…`)
   with an `id_map` so an offline panel can mint before the Master has seen
   it — and a lead's `partyId` is resolved through it too.
6. **Permissions are one JSONB array on the role**, capped by a tier ceiling
   (`office` / `management` / `admin`) enforced on save and at sign-in.
   scrypt hashes; `activity_log` is hash-chained and append-only; roles and
   users soft-delete; `users.role_id` deliberately has no SQL FK.
7. **Clean architecture on the Master:** pure rules in `domain/` (no I/O),
   services orchestrate against repositories, transport (`http/`,
   `realtime/`) carries no policy. New invariants go in `domain/`.
8. **Configuration from `.env`** (package-level first, then repo root, real
   environment wins) via the dependency-free parser in `src/lib/env-file.ts`.
9. **Column map is one table** (`shared/src/domain/columns.ts`); `undefined`
   = not asserted, `null` = clear. Never re-add a second copy.
10. **Developer mode is a password, not a permission** (see
    `docs/DEVELOPER_MODE.md`). Reset erases through the fresh-install path.
11. **Updates:** NSIS installers published by `tools/release.mjs` to a
    releases folder; the Master serves the office build over the LAN and the
    shell refuses any setup file outside its own updates directory.
12. **Product catalogue model (2026-09-19):** category → **model**
    (`products`, category mandatory) → **variant** (`product_variants`: the
    code, the colour/pattern label and the weight per piece; one unlabelled
    row for a product with no variants; `VR` ids). Lines, stock, movements
    and reservations point at the variant. Weights are nullable and flagged
    *weight missing* until entered. `line_items.category_name` is the main
    product frozen on the line. The v1.1.0 `colour_policy` column was dropped
    by the variant migration. Lead entry is the Office panel's
    `AddLeadScreen` (category → model → a card with one row per variant, one
    line per row filled); the v1.1.0 shared `ui/NewLeadScreen` and the
    Master's New lead page went with the colour-policy model — see "Owed
    work".
13. **Accepted risks, not solved:** the Master's plaintext password vault
    (owner asked for it knowing the cost; keep the guards in
    `docs/overhaul/workstream-F.md`); no TLS on the LAN (an API key is as
    exposed as the session cookie; the public API is off by default).

## Owed work

**Code:** the briefs in `docs/ai-handoffs/` are open or partial (the README
there is the queue). The blocking ones: the Master has no Parties screen
(`createParty` has no caller); a refused acting token on the socket falls
back to a default actor. (The temporary-`partyId` remap on a lead was fixed
on 2026-09-19; the `mrp` gate and the unmasked image mutations went away with
pricing on 2026-09-21.)

**Master-side New lead.** v1.1.0 gave the Master a New lead page through a
shared `ui/NewLeadScreen` built on `colour_policy`; the variant restructure
replaced that model and the screen could not be kept. `POST /api/leads` on
the Master stays. To bring the page back, port the Office `AddLeadScreen`
into `ui/` behind a transport (parties/categories/models picks, option
lists, party records, free stock per variant, create) the way the v1.1.0
adapter did — the Office screen is the one that was walked through.

**Weights.** The catalogue's 549 variants land with no weight; the Office
Catalogue's *Missing weight* filter is the worklist. Uncoded catalogue items
carry slug codes (`HEXA-URINAL`, `DAMRU-WHITE`, …) to replace on the product
form.

**Manual:**

- Responsive gate: 1024×768 / 1366×768 / 1920×1080 / 3840×2160 at 79 % /
  100 % / 157 %, sidebar in all three modes.
- Keep-alive walk: every Master and Office tab keeps filters, scroll, open
  drawers and half-typed forms across a round trip; Escape closes the
  *visible* overlay only.
- One real lead on the Office panel through the new-lead flow (category →
  model → variant rows → Enter walk → save), CSV import (one row per
  variant), one printed report.
- A packaged install-then-uninstall on a real machine (scripts dry-run clean;
  the live path is unexercised).
- Rebuild the 1.1.0 installers on a machine where electron-builder runs.

Open questions still unanswered by the owner: extra party fields (GST/tax
id, credit terms, multiple contacts); concurrent edits of one lead from two
panels (last-write-wins is the default); app name/branding.

## Traps worth knowing

- **An update used to be a full record replace and silently nulled every
  column the form did not show.** Fixed by the one column map; `columnPatch()`
  emits only asserted keys. Pinned by `partial-patch.integration.test.ts`.
- **Both panels shared one Electron single-instance lock when run from
  source.** `app.setName()` must run *before* `requestSingleInstanceLock()`;
  never "fix" it with `app.setPath('userData', …)` — that wipes stored
  preferences.
- **On Windows `child.kill('SIGTERM')` is `TerminateProcess`.** The shell
  sends `{type:'orderbook:shutdown'}` over the IPC stdio slot and waits; keep
  the `'ipc'` slot if you change spawn options. The hard-kill fallback still
  orphans `postgres.exe`; the next launch adopts it.
- **A child that inherits your pipes never lets `execFile` resolve.** `pg_ctl`
  exits but the `postgres` it launched keeps the pipes. `spawn` with
  `stdio: 'ignore'` and wait for `exit`.
- **`shared/` and both `web/dist` are build artefacts.** The `prepare` and
  `pre*` scripts exist so a clean checkout works; do not remove them.
- **Two branches once minted the same migration timestamp** and deleting one
  locked every database that had run it (`knex_migrations` names it, Knex
  validates before running anything). Keep both, make both `IF NOT EXISTS`.
- **A migration must never import a live shared constant.** Inline what it
  writes; a migration is a historical fact.
- **`master/tests/i18n-tokens.test.ts` is load-bearing.** Every literal
  `(entityType, action)` given to `recordActivity` needs an
  `activity.<entity>.<action>` string or the Logs screen renders the raw key.
- **Composite stock keys go through `stockKey()`**
  (`master/src/domain/stock-key.ts`). Two inline builders once produced keys
  that never matched and reservations read as zero.
- **A create stamps `field_hlc` only for fields it actually set**, or the first
  edit of an empty field looks like a conflict.
- **electron-builder runs `npm install --omit=dev` in the workspace** and
  prunes the root `node_modules`. Both `electron-builder.yml` files set
  `npmRebuild: false` and `buildDependenciesFromSource: false`.
- **A build output folder keeps the last build.** Match the exact filename you
  expect and clear the folder first, or you publish old bytes under a new
  manifest.
- **The file that records where the data lives must not live in the data**
  (`config.settingsFile` sits beside the data directory).
- **Party access has nine non-obvious read paths** (search index, dashboard
  counts, report CSVs, recycle-bin union, activity subjects, document ledger
  and download, sync merge, two snapshot collections, `data:changed`).
  `grep applyPartyScope` / `grep partyScopeSql` before adding a scoped entity.
- **The last-administrator guard runs inside the transaction.** Moving it out
  lets two concurrent deactivations lock the company out.
- **An Office panel's acting user is resolved per command, never per
  connection.** Offline sign-in is reachable only when the Master could not be
  *asked* — decided by a transport flag, never by reading the error text.
- **A skipped suite prints like a passing one.** `describe.skipIf` hid a
  broken Windows Postgres lookup for months.
- **A permission that enforces nothing is worse than a missing one.** Wire it
  or delete it from the catalogue; `isPermission` drops retired keys
  (`ai.*`) at resolution so old roles stay editable.
- **`UNION ALL` branches must cast to one type** (`option_lists` and
  `custom_field_definitions` have UUID ids; cast `id::text`).
- **Per-file "seeded row" captures are only correct if every file starts
  from the same database.** Self-heal to a known set before capturing; run
  `vitest` twice without wiping the cluster to see the drift.
- **`request()`'s in-flight GET dedupe is keyed on path + headers.** Keyed on
  path alone it served a pre-unlock answer to a post-unlock developer call.
- **Shift+letter chords never reach the command registry while typing** —
  the new-lead screen's Shift+Q is a plain keydown for that reason.
- **jsdom cannot test visibility** (`checkVisibility` is undefined). Escape
  arbitration among overlays was verified by hand in Chromium; do not write a
  jsdom assertion for it.
- **A token minted as `obk_<base64url>_<base64url>` split on `_`.** Prefix
  is hex now; `parseToken` rejoins everything after the second separator.

## Recent sessions

### 2026-09-22 (latest) — Lead-add trims, the suggest field's keyboard, Grade back on a line (Claude)

Four of the owner's five instructions; see `docs/AI_COLLABORATION.md` for the
full record.

- **The chosen party shows only its name** on the Office New-lead screen. The
  code, phone and town stay in the picker, where they disambiguate — the
  owner chose that split when asked.
- **The follow-up date defaults to today again.** It did on the v1.1.0 shared
  `ui/NewLeadScreen` and was lost when the variant restructure replaced that
  screen with the Office's own.
- **`ui/src/SuggestInput.tsx`'s keyboard was wrong four ways** — this is what
  "Esc and Enter are not working properly in product add" and "when arrow key up
  down in category dropdown box item will also move" were. ArrowDown re-enabled
  filtering, so a chevron-opened list re-narrowed under the highlight; both
  arrows stepped from the unclamped counter, so the highlight could sit still
  for several presses; an arrow on a shut list opened it *and* skipped the top
  row; and Escape was claimed even by a list that had opened itself on focus,
  which is why the first Escape in the product dialog appeared to do nothing.
  Fixed, with the highlighted row scrolled into view, and four tests in
  `ui/tests/suggest-input.test.tsx` — each watched failing against the code it
  was written for.
- **Enter in the product form's variants table** walks colour → code → weight
  now. The row handler was on all three cells, so Enter anywhere jumped a row,
  and on a single blank row it ran the save and produced a validation error
  about a field nobody had reached.
- **Grade is back on a lead line**, as a pick over the `line.grade` option list
  (the owner chose pick-only). Only the *line's* column returns — `products` and
  `party_product_variants` stay trimmed — via migration
  `20260325000000_line_item_grade`, registered **after** the trim that dropped
  it. `line.grade` is a managed set in Settings → Fields again and ships empty.

**Not done, deliberately:** the owner also said an old UI/UX had been applied in
place of one they had updated. Asked which screen, they answered *"Right now
stay as it is."* The product screens were diffed against the live `Product page
UI recreation` artifact first and match it.

Traps this leaves:

- **`20260325000000_line_item_grade` is in `DELIBERATELY_LAST`.** The registry
  test pins the array's tail to that list; the migration has to stay behind
  `20260324000000_product_master_trim`, which is itself pinned last and drops
  `line_items.grade`. Put it in timestamp order and a *fresh* database gains the
  column and loses it a moment later.
- **The `line.grade` list ships empty**, so the card's Grade select offers only
  *No grade* until somebody fills it in under Settings → Fields. The screen says
  so rather than showing an empty dropdown. `master/src/domain/sample-data.ts`
  seeds A/B/C, but that is the demo seed, not a live default.
- **A grade is not validated against the list on the way in**, the same as
  packaging: a panel that was offline for a day may be sending a value an
  administrator has since retired, and that is still what the customer was
  quoted. The picker is what keeps new lines on the list.
- **Integration suites can run in a Linux container** as a non-root user
  (`canRunIntegrationTests` is false for uid 0 because PostgreSQL refuses to
  start as root). With PostgreSQL 16 present, `su postgres -s /bin/bash -c
  'TMPDIR=… HOME=… npx vitest run'` ran all 117 files — worth knowing before
  reporting a green run that actually skipped 45 files.
- **`master/tests/github-releases.test.ts` and `master/tests/updates.test.ts`
  fail on this branch already** (13 tests). Verified by stashing and re-running;
  they are about the releases folder, not any recent change.

### 2026-09-22 (later still) — Crop editor: horizontal, load states, every image format (Claude)

`ImageCropModal` reworked on the owner's instruction:

- **Horizontal.** Photo on the left, its adjustments in a column on the right,
  the dialog widened to `lg`. Stacked, the straighten slider — the one control
  you use *while watching the picture* — could not be on screen at the same
  time as the picture on a laptop.
- **Load states.** `onload` had no `onerror` beside it, so a file the browser
  could not decode left the editor on the word "Loading…" for ever. There is now
  a `status` of loading / ready / failed: a spinner while it decodes, and a
  plain message naming HEIC when it cannot. The right-hand controls are disabled
  rather than hidden in both, so nothing jumps when the photo arrives.
- **Every image extension.** The picker and the pre-upload check both read the
  file *extension* as well as its MIME type. A browser reports `file.type` as an
  empty string for anything it does not recognise, so `.heic`, `.jfif`, `.tif`
  and `.avif` were being rejected as "not an image" before they ever reached the
  server — which has no MIME filter at all and hands everything to sharp.

Traps this leaves:

- **Widening the picker does not make every format croppable.** The editor needs
  the *browser* to decode the file, and Chromium cannot read HEIC or most TIFFs.
  Those now reach the editor and get the "could not be opened" message instead
  of silently vanishing at the picker. Cropping them for real would mean letting
  the Master decode first — `assertCropRect` in `master/src/domain/images.ts`
  rejects an out-of-bounds rect, so the client cannot fake a "whole image" crop
  without knowing the dimensions. Not attempted.
- `ui/src/AvatarPicker.tsx` still has the **old** narrow gate
  (`file.type.startsWith('image/')`, `accept="image/*"`). It was left alone
  deliberately — the instruction was about product photos. If it should match,
  `IMAGE_EXTENSIONS`/`looksLikeImage` need to move from
  `office/web/src/components/ProductImages.tsx` into `ui/` so both can share it.
- After editing `shared/src/i18n/*.ts`, **run `npm run build:shared`** before a
  browser pass. The dev server resolves `@orderbook/shared` to its build output,
  so a new key renders as its own raw name until you do — which is exactly what
  the first screenshot of this change showed.

### 2026-09-22 (later) — Stock off the product detail; the custom scrollbar lands (Claude)

Two corrections the owner made after seeing the redesign running:

- **The variants-and-stock table and the "Stock in" / "Adjust count" forms are
  gone** from the Office product detail. They are not in the artifact. They
  pre-dated the redesign — the first pass kept them because the list had just
  lost its Stock column — but stock is the Master's job: `master/web`'s
  Inventory screen owns the reorder band, the per-variant ledger and both
  movement forms, which is where the single-writer rule puts it. `ProductDetail`
  is now the two cards the artifact draws and nothing else, and no longer takes
  `view` or `onMessage`.
- **The artifact's custom scrollbar is now project-wide**, in `ui/src/reset.css`
  with its colours tokenised in `tokens.css` for both themes. It was the one
  part of the artifact's CSS the repo did not already have.

Traps this leaves:

- The scrollbar states `scrollbar-width`/`scrollbar-color` **only** inside
  `@supports not selector(::-webkit-scrollbar)`. Do not lift them out. Chromium
  — which is what Electron ships — lets `scrollbar-color` beat the
  `::-webkit-scrollbar-*` colours, so stating both flattens the bar to stock
  platform colours and loses the inset rounded thumb and the track hairline.
  Verified headed; **headless Chromium forces overlay scrollbars and reserves
  0px**, so a headless screenshot can never confirm this — use `xvfb-run` with
  `headless: false`.
- `.ob-filterbar` lost its own `scrollbar-width: thin` for the same reason.
- `api.stockInbound` / `api.stockAdjust` now have no caller in `office/web`, and
  roughly ten `product.detail.stock*` message keys are unused. Both were left in
  place — the Master still implements the routes, and the keys describe a
  feature that still exists there.

### 2026-09-22 — Product screens redesigned from the owner's artifact (Claude)

The owner redesigned Products (list), product detail and the add/edit product
form in a Claude Design artifact and asked for it in the codebase. The artifact
bundles this repo's own `ui/src/styles.css` byte for byte, so **the redesign
added no CSS and no tokens** — it rearranges components that already existed.

Decided with the owner before coding, because each removes function:

- **Photos stay multi-image.** The mock draws one photo; the backend has
  primary/sequence/captions. Built as cover-photo-large plus the existing strip.
- **The list drops both the photo thumbnail and the Stock column.** Stock is
  now read only on the detail screen's variants table.
- **The filter chips go.** Category and missing-weight filtering left the UI.

Where things are now: photo editing lives on the **product detail screen**
(`ProductImages` is the Photo card), not in `ProductDrawer` — the drawer is a
form again, with Identity / Codes & weight / Colours and nothing else. The
detail screen is Photo card + Details card side by side, with `Edit product` in
the Details card header; the variants-and-stock table and the stock-movement
forms are unchanged below. The list is six proportional columns — Code,
Product, Category, Size, Weight, Colours.

Traps this leaves:

- `EditorScreen`'s `title` is **optional** now. The product detail omits it
  because the topbar already names the open record via `useSubNav`; party, lead
  and order details still pass one. Do not "fix" the product screen by adding
  it back — that is the duplicate the redesign removed.
- `office/web/src/productSummary.ts` is the only place a product's code or
  weight summary is computed. The list row and the detail card both read it;
  keep it that way or they will drift.
- `StockCell.tsx` was deleted with the Stock column — it had no other caller.
  Restoring the column means restoring the component from git.
- `api.listProducts` is still passed `categoryId`/`missingWeight` by nothing;
  the server side of both is untouched and works, should the chips come back.
- `npm run build` does not run on Linux (the two web build scripts are cmd.exe
  syntax). Use `npx vite build` inside `office/web` / `master/web` there.

### 2026-09-21 — Product master trimmed, pricing removed, multi-colour lines; catalogue PDF extracted (Claude)

The owner extracted the Swisware 2026 catalogue PDF to a spreadsheet (an
8-per-page sample, `SWISWARE 2026 - Sample (8 per page).xlsx` on the laptop's
Desktop, with a `Catalogue` sheet and an `Import` sheet in the app's template
shape), asked how the product Add flow works, and then decided the product
master is too wide: *only* name, category, alias, size, the variants' code,
colour and weight, photos — plus a **multi colour** switch so a lead line on
such a product can name a colour. Asked back, they chose to **remove pricing
completely** (not just the catalogue price), keep custom fields on products,
and have the line's colour come from the colour list in Settings.

Migration `20260324000000_product_master_trim` drops 26 product columns, the
money on lines/leads/orders/party records, adds `products.multi_colour` and
`line_items.colour`, redefines both search functions first, deletes the
`pricing.enabled` row, the `product.*`/`line.grade` option lists, connector
maps and conflicts on the dropped fields, and strips the four rate keys from
every role. Removed with it: `shared/domain/visibility.ts`,
`master/domain/visibility.ts`, `master/services/pricing-gate.ts`, the money
columns of every report, the paise connector transforms, `formatMoney`, the
rate controls of the New lead screen; 81 message keys. The product form is
name · category · alias · size · variants · *Made in every colour?* · photos;
the New lead card offers a *Colour* select on a multi-colour model; the
import template is eight columns. The Swisware seed marks the water closets,
sets, urinals and pans multi-colour. Design record:
`docs/ai-handoffs/product-master-trim.md`; verify gate re-run (see *Verify
gate* above).

### 2026-09-19 — Product model → variant, Swisware catalogue, PDF Designer removed, sample data; merged with the v1.1.0 line (Claude)

On the laptop, from `da9e992`: the Documents module removed at the owner's
request (migration `20260322000000_drop_document_designer`), a sample-data
seed for demos, and the product flow restructure from the owner's brief —
`product_variants` owning every code, label and weight; category mandatory;
one lead line per variant with frozen code/weight and `totalWeightKg` /
`linesWithoutWeight`; inventory keyed by variant; category-first New lead on
the Office; product form with a *Codes & weight* switch; the Swisware
catalogue (12 categories, 251 models, 549 variants) as pure data with an
idempotent loader; bulk import one row per variant; tile-only fields hidden.
Migration `20260323000000_product_variants` wipes product-linked data
(owner's decision) and `down()` throws. Live walk-through on an isolated
database found and fixed a temporary-`partyId` refusal on leads and a
hundred-product cap on the Master's stock form. Design record:
`docs/ai-handoffs/product-model-variants.md`.

Then the merge with `origin/main` (the v1.1.0 line, 11–14 Sep, from the
other PC): everything from that line was kept — pricing switch, assistant
removal, sidebar sub-pages, free-to-sell switch, Office dashboard rebuild,
esbuild temp-dir fix, dead-code pass, handoff rewrite — except the
colour-policy hierarchy, its shared New lead screen and its Documents work,
which the laptop line had superseded. `line_items.category_name` from
v1.1.0 is kept and filled. The merge commit landed on 2026-09-21 once
`npm run verify` was green on the merged tree: lint and typecheck clean,
117 test files / 1427 tests, none skipped.

### 2026-09-14 — Build fix, dead code, bloat removal, handoff rewrite (Claude)

- Root-caused the `esbuild … Access is denied` build failure to a Windows
  temp-folder lock and fixed it in both `web` workspaces' `build` scripts
  (project-local `.tmp/`, gitignored). `start:master` and `start:office`
  verified end to end through real `npm`/`cmd.exe`.
- Removed the vendored third-party skill copies (`.claude/skills/`,
  `.agents/skills/{apple-design,improve,improve-codebase-architecture,
  writing-plans}`, `skills-lock.json`) — 138 files that duplicated skills
  already installed globally on the owner's machine. The project-authored
  `.agents/skills/ui-consistency/` and `.commandcode/skills/` stay.
- Removed `docs/IMAGE_PIPELINE_FRONTEND_BRIEF.md` (one-shot design brief,
  unreferenced). Re-checked all 22 `docs/ai-handoffs/` briefs against the
  tree: only four were done and were deleted; **19 remain open or partial**
  (5 partial, 14 open) and `docs/ai-handoffs/README.md` now lists them in
  order with what specifically is missing. They are real owed code, not
  bloat — see "Owed work".
- Dead-code pass driven by `npx knip`: 43 unreferenced symbols deleted and
  48 un-exported across `master/src`, `office/src` and the two frontends;
  `master/src/domain/i18n-tokens.ts` deleted; the unused `StockCell`
  component removed from `office/web/src/components/StockCell.tsx`
  (`StockByColour` there is still used). Migrations, the electron entry
  points and `SNAPSHOT_POLICY` (a compile-time exhaustiveness guard)
  untouched. Knip ran without a config; its electron "unused file" hits are
  false positives.
- `master/tests/updates.test.ts` UPD-7 published its corrupt build as
  `1.1.0` — the app's own version since the bump — so `isNewer()` refused it
  before the checksum gate ran. Now `9.9.9`, like UPD-8.
- This file rewritten from a 3,100-line log into the current-state document
  above; `AGENTS.md` and `opencode.md` brought in line (branching, no AI, no
  vendored skills). Stale "release hold v1.0.3" banner dropped — 1.1.0 is
  the current version and the hold's conditions were met on 2026-09-06.

### 2026-09-13 — Commit + rebuild checkpoint (Command Code)

Committed the pricing switch, assistant removal, sidebar sub-pages, product
hierarchy + new-lead flow and the catalogue reload script to `main`. Refreshed
all build inputs. Installers not rebuilt — electron-builder and PostgreSQL
both blocked by machine-level permission failures on the owner's PC.

### 2026-09-12 — Product hierarchy, keyboard-first lead entry, PDF Designer shell, Office dashboard, catalogue wipe (Command Code)

Colour policy + main-product model (migration `20260322…`), the shared
`NewLeadScreen` on both panels, `POST /api/leads`, document line columns
`# | Main product | Model | Code | Colour | Packing | Grade | Boxes`, the
Canva-style `DesignerShell` inside the Documents editor, the Office dashboard
rebuilt to the owner's screenshot, product form/table/import reordered to
Brand → Main product → Code → Dimensions → Colour…, and the live catalogue
wiped to 0 products / 3 sample parties.

### 2026-09-11 — Pricing switch, assistant removed, sidebar sub-pages, Documents as a screen (Claude)

`pricing.enabled` and `inventory.freeToSell` company switches; AI assistant
deleted end to end (migration kept); two-tier sidebar with per-module
sub-pages; template editor and starter gallery as full sub-screens; New lead
as Leads' second page; `Ctrl+F` = screen search.

### 2026-09-07 — Developer mode, reset, test users, uninstaller, Settings rebuild (Claude)

Developer password gate on both panels, reset through the fresh-install
path, `npm run seed:dummy`, the uninstall scripts shipped as `extraResources`,
`SettingsLayout` with a shared `AppearanceSettings`. Bulk product import
(CSV/Excel) with templates and the paged catalogue landed the same day.

### 2026-09-06 — v1.0.3 blockers fixed, guardrails rewritten (Claude)

The four release blockers from the 46-agent audit were fixed and the five
guardrail tests rewritten and individually watched to fail against the broken
code. The first attempt had left typecheck red in three workspaces and shipped
guards that passed against the defects they targeted — hence the "guards must
be seen to fail" rule above.
