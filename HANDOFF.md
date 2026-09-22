# HANDOFF — Session Context

Read this first in any new session on this repo. It records what is decided
and what is true *now*. Keep it current, not cumulative: when a session
changes reality, edit the section that describes it and add a short dated
entry under "Session history". The long-form history is in git — the last
cumulative version of this file is `git show 5b8ebe2:HANDOFF.md` — and in the
change log of `docs/AI_COLLABORATION.md`.

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
**no money at all** — no rates, amounts or totals anywhere. The AI assistant
was removed on 2026-09-11 and the PDF Designer (Documents module) on
2026-09-19; the Reports PDF export stays.

### Where the truth lives

| Question | Read |
|---|---|
| Requirements, pairing design, screen flows | `docs/PROJECT_PLAN.md` |
| Where every file lives, and where a change goes | `docs/CODE_MAP.md` |
| Every table, column, index and why | `docs/schema/` (start at `00-overview.md`) |
| Lead → order flow as built | `docs/LEAD_GENERATION_FLOW.md` |
| Roles, users, permissions, tiers | `docs/ROLES_AND_USERS.md` |
| Developer password, reset, test users | `docs/DEVELOPER_MODE.md` |
| Shipping an update, release ordering rule | `docs/UPDATES.md` |
| Shipping to customers under the "never lose data" rule | `docs/PRODUCTION_READINESS.md` |
| Manual QA script | `docs/TESTING_PLAN.md` |
| What to do next | `docs/NEXT_PHASE.md` |
| Open work items (the queue) | `docs/ai-handoffs/README.md` |
| The product master: category → model → variant | `docs/ai-handoffs/product-model-variants.md` |
| The product trim, pricing removed, multi-colour lines | `docs/ai-handoffs/product-master-trim.md` |
| Fields, Logs, Recycle Bin, Reports, i18n design | `docs/BACKEND_MODULES.md` + `docs/backend-modules/` |
| The 2026-08/09 overhaul designs (all implemented) | `docs/overhaul/` |
| Multi-agent workflow and per-session change log | `docs/AI_COLLABORATION.md` |

`docs/overhaul/` and `docs/backend-modules/` are cited from source comments as
design rationale. They were written before the code and several of their
stated facts did not survive contact with the tree — check a design's claim
against the code before acting on it.

## Current state (2026-09-22, after the branch consolidation)

- **Branches:** `main` is the only long-lived branch; `dev` was reset to
  `main` on 2026-09-22 to develop on. Every other branch was merged or
  retired that day (see "Branch consolidation" below) and is **to be deleted
  on GitHub by the owner** — the session's git access could push `main` and
  `dev` but was refused (403) for branch deletion and tags. Work lands on
  `main` (directly or through `dev`); do not branch from an old branch.
- **Version 1.2.0**, the first build meant for customers. It adds the
  **standalone `.exe`** beside each Windows setup file, the **pre-update
  database copy** (`master/src/db/cluster-snapshot.ts`), and the
  **additive-migrations guard** (`master/tests/migration-data-safety.test.ts`).
  The owner's rule from here on: *an update replaces the software and never
  the data.* `docs/PRODUCTION_READINESS.md` §2 lists what only the owner can
  decide before shipping (signing key, what happens to any 1.0.3 data,
  code-signing certificate).
- **Verify gate:** `npm run verify` = `lint` + `typecheck` (all workspaces,
  both Electron shells, the test tsconfigs) + `vitest run`. **Last full run
  2026-09-22 after the consolidation: lint 0, typecheck 0, 140 test files /
  1699 tests passing, integration suites included** (PostgreSQL 16, run as a
  non-root user — see "How to run"). Run the three steps separately and check
  each exit code. As root the integration suites skip (46 files) and the
  summary still reads green.
- **Builds:** `npm run build` is green for shared, both servers and both web
  bundles on every OS: the web workspaces build through `tools/build-web.mjs`
  (resolves `tsc`/`vite` from `node_modules/.bin` by path, points
  `TEMP`/`TMP` at a gitignored `.tmp/` for the Windows esbuild/Defender lock).
- **Releases:** `.github/workflows/release.yml` builds on a three-OS matrix
  (Windows setup + standalone, macOS `.dmg`, Linux AppImage + `.deb`). A push
  to `main` whose `package.json` version has no release yet publishes
  `v<version>`; unsigned (no `RELEASE_KEY` secret) it is a **draft**, which no
  panel installs. A manual run on any branch builds into a draft pre-release
  `build-<version>-<sha>`. Existing releases (1.0.2, 1.0.3, 1.1.0, two 1.2.0
  builds) are all drafts. The clean-install tool (`cleaner/`) is built but
  never published into the releases folder.
- **Company settings: thirteen**, in four groups on the Settings tab
  (`shared/src/domain/settings.ts`): password reveal, free-to-sell, public API,
  auto pairing, developer mode, session hours, default reorder level, offline
  sign-in, adjustment note required, import creates categories, follow-up
  default days, packaging required on convert, quiet-after days. Adding one is
  a single entry there plus two i18n tokens; the screens read switches through
  `resolveCompanyFeatures()`.
- **Product master:** a product is name · category · alias · size · *made in
  every colour* switch · custom fields, with variants of code · colour ·
  weight. Stock, movements and reservations are per **variant**. A lead line
  on a multi-colour product may name a colour from `stock.colour`; a line
  carries a **grade** from `line.grade` (a line attribute, never a catalogue
  one).
- **Hindi is 1,445 strings behind** (`grep -c 'TODO(i18n-hi)'
  shared/src/i18n/hi.ts`). The parity test only checks keys exist, so nothing
  fails on it. Settings → Appearance has a language picker.
- **Live databases:** external PostgreSQL via `.env` `DATABASE_URL` on both of
  the owner's machines (`order_book` on the PC, `order_book_new` on the
  laptop). The first Master started from a pre-1.2 database runs
  `20260323000000_product_variants` (wipes every product-linked table) and
  `20260324000000_product_master_trim` (drops the pricing/tile columns in
  place; `down()` throws). Settings → Developer → *Load the Swisware
  catalogue* (or `npm run seed:catalogue`) loads 12 categories / 251 models /
  549 variants with blank weights.

## Branch consolidation (2026-09-22)

Everything was brought onto `main` and `dev` was reset to `main`. The other
branches below are safe to delete: their work is in `main` or superseded.

| Branch | What it held | Outcome |
|---|---|---|
| `claude/amazing-lovelace-r5851k` | 1.2.0: standalone `.exe`, pre-update DB copy, migration guard, CI fixes | merged |
| `claude/hopeful-lovelace-q6f57v` | 29 commits (09-16..18): company settings, privilege fixes, Master Parties screen, lead/order delete, clean-install tool, Mac/Linux builds | merged onto main's model (see below) |
| `claude/vibrant-ride-tb43f7` | filter strip spacing, category chips dropped | merged (main had already dropped the chips) |
| `claude/serene-hawking-3dee4n`, `claude/zealous-cori-u233hm` | already in main | delete |
| `claude/exciting-brown-ufq4ka` | a TypeScript lib fix | obsolete — main typechecks without it; delete |
| `claude/backend-ui-development-e25geo`, `ceramic-offline-web-app-6wjqq5`, `claude-md-docs-0zohib`, `master-panel-office-admin-wjuqka`, `office-panel-user-signin-0x229o`, `refactor-production-codebase-7gbz9v` | August work on the pre-rewrite history (main was re-rooted since); every feature they carried is in main in later form | delete |
| `dev` | 30 commits behind main, nothing unique | **reset to `main`** (kept) |

The merged three (`amazing-lovelace`, `hopeful-lovelace`, `vibrant-ride`) are
safe to delete too. Deleting the six August branches drops history that exists
nowhere else; if that matters, tag them first
(`git tag archive/<name> origin/<name> && git push origin archive/<name>`).

**How hopeful-lovelace was merged.** It was cut before the variant
restructure and the pricing removal, so it was merged onto main's model:

- *Kept:* the settings above, the auth/panel privilege fixes, offline sign-in
  switch, the Master Parties screen with the shared `ui/PartyFormModal`
  (Office's `PartyDrawer` moved there), lead and order delete on the Master,
  the clean-install tool, the release matrix, the web-reachability guard.
- *Dropped as moot:* `pricing.enabled` and every money-field gate,
  `catalog.defaultUom` and the `select` setting control (units are gone), the
  masked image responses, and the tests written for them.
- *Adapted to per-variant stock:* the default reorder level, the
  adjustment-note check, and the import category gate.
- *Removed as dead code the guard found:* the Master api client's
  `customFields`/`partyVariants`/`products`/`createLead` and the Office's
  `stockInbound`/`stockAdjust`.

**Not on GitHub and not merged:** the local CLI session "UI improvement"
committed `a3fa9e4` (Phase 6.0 standalone flavour, 69 files) on a branch
`feat/marcwares-design-system` on the owner's machine. It was never pushed, so
it is not part of this consolidation — push it before deleting that clone if
it is still wanted.

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
npm run release [version] [-- --panel office] [-- --os win|mac|linux]
npm run seed:dummy              # admin/Admin@1234, management/Manage@1234, office/Office@1234
```

Master-only operator scripts (`--workspace @orderbook/master`):
`wipe:business`, `reload:catalog`, `seed:parties`, `seed:catalogue`. They
talk to the live database — read `master/src/services/catalog-reload-cli.ts`
before running one.

**Integration tests as a non-root user** (PostgreSQL refuses to start as
root). In a Linux container with PostgreSQL 16 installed: copy the checkout
somewhere the `postgres` user owns, then
`su postgres -s /bin/bash -c 'cd <copy> && TMPDIR=<copy>/.tmp HOME=<copy>/.home npx vitest run'`.
`docs/NEXT_PHASE.md` §2 has the longer recipe.

Owner's environment: Windows 11, PowerShell 5.1 (`&&` does not work — use
`;`). npm 12 blocks install scripts; approve native modules with
`npm install-scripts approve <pkg>`.

## Where things live

```
shared/        types, Socket.IO event contract, UDP discovery protocol, i18n catalogue (en + hi), column map, settings
ui/            the one shared React kit (one barrel, consumed as source), screens/forms both panels share
master/        Master server (src/) — domain/ → services/ → repositories/ → http/ + realtime/; migrations in src/db/migrations/
master/web/    Master React frontend
office/        Office server (src/) — sync/, outbox, local snapshot store, forwarding to the Master
office/web/    Office React frontend
electron/      one desktop shell; master.main.ts / office.main.ts / cleaner.main.ts are thin configs over shell.ts
cleaner/       packaging for the standalone clean-install tool (logic in electron/lib/cleaner/)
tools/         release.mjs, build-web.mjs, i18n-sync.mjs, make-icons.mjs, uninstall scripts, eslint rules
docs/          all prose; nothing source-of-truth lives in a code comment
.commandcode/skills/   team-shared project skills (tracked)
.agents/skills/        the UI-consistency skill in the shape Muse Code discovers
```

- **Layout:** `docs/CODE_MAP.md` is the map. Read it before hunting for a file.
- **UI:** import from `@orderbook/ui`; never copy a component into a panel
  (`master/tests/no-duplicate-ui.test.ts`). A screen or form both panels need
  lives in `ui/` and takes a `transport`, never a panel's api client
  (`ui/tests/no-transport-dep.test.ts`) — `PartyFormModal` is the example.
- **Strings:** one catalogue `shared/src/i18n/en.ts`, Hindi mirror kept total
  by `npm run i18n:sync`. A bare string in JSX fails lint; a `t('…')` naming a
  missing key fails `master/tests/i18n-call-sites.test.ts`.
- **Errors reach a screen through `apiErrorText`** (`ui/src/errorText.ts`);
  a 401 is announced through `ui/src/sessionEnded.ts`.
- **Company switches** ride on `SignedInUser.features` (Master) and
  `SyncSnapshot.features` (panels), built by
  `master/src/services/company-features.ts` and resolved by
  `resolveCompanyFeatures()`. A setting change forces a panel resnapshot.
- **Dead api-client members fail the build**
  (`master/tests/web-reachability.test.ts`): delete them, or add them to its
  allow-list with a reason.

## Working agreements

- **Verify before done.** `npm run lint`, `npm run typecheck` and
  `npm run test` each exit 0. `master/web` and `office/web` have no test
  files, so a real browser or Electron pass is verification, and a change not
  run in the browser should say so.
- **Never delete or rewrite a migration** that may have run anywhere;
  `master/tests/migration-registry.test.ts` pins the names.
- **Migrations after 1.2.0 only add.** `migration-data-safety.test.ts` fails
  on TRUNCATE / DROP TABLE / DROP COLUMN / DELETE FROM in `up()`; an exemption
  is the owner's decision. It is a tripwire, not a proof — read a migration
  for what it loses.
- **Single-writer.** The Master owns all persistent state; Office panels
  forward writes and never write their own database.
- **Offline-only runtime.** Nothing loads from a CDN or calls the internet.
- **Docs and code live separately.** `.env` is gitignored and never committed.
- **Desktop only.** Design floor 1024×768; laptop-to-4K at 79–157 % scale.
- **No pricing, no AI.** Do not reintroduce money anywhere; do not bring the
  assistant back.
- **Before you stop, `git status` for `??`.** An uncommitted migration is
  indistinguishable from a deleted one to every other machine.
- **Guards must be seen to fail.** Break the code, watch the test go red, put
  the code back — and check the assertion reaches the thing it names.
- **Agent self-documentation is a claim, not evidence.** Verify a HANDOFF or
  change-log entry against the code before relying on it.

## Key decisions (do not re-decide without a reason)

1. **Two Node/Express + Socket.IO servers**, one per panel, each serving its
   own built React frontend on localhost.
2. **PostgreSQL, not SQLite**, bundled via `embedded-postgres` (server
   binaries only). Fallbacks: `DATABASE_URL` or `ORDERBOOK_PG_BIN`.
3. **Knex** query layer; Knex types never leave `repositories/`.
4. **Custom UDP broadcast discovery** (not mDNS) with a manual IP/ID/password
   fallback (`docs/PROJECT_PLAN.md` §4).
5. **Orders are their own table**; conversion copies the lines and stamps
   `converted_order_id`. Reserve at conversion, dispatch moves stock;
   inventory is per variant. Text record ids with an `id_map` so an offline
   panel can mint before the Master has seen a record; ids inside a payload
   (`partyId`, `ownerId`, `productId`) are resolved through it too.
6. **Permissions are one JSONB array on the role**, capped by a tier ceiling
   (`office` / `management` / `admin`). scrypt hashes; `activity_log` is
   hash-chained and append-only.
7. **Clean architecture on the Master:** pure rules in `domain/`, services
   orchestrate, transport carries no policy.
8. **Configuration from `.env`** via `master/src/lib/env-file.ts`.
9. **Column map is one table** (`shared/src/domain/columns.ts`); `undefined` =
   not asserted, `null` = clear.
10. **Developer mode is a password, not a permission** (`docs/DEVELOPER_MODE.md`).
11. **Updates:** setup files published by `tools/release.mjs`; the Master
    serves the office build over the LAN. A standalone `.exe` is replaced by
    hand, never updated in place.
12. **Product catalogue:** category → model (`products`) → variant
    (`product_variants`: code, colour/pattern label, weight). Lead entry is
    the Office panel's `AddLeadScreen`; the Master has no New lead page.
13. **Accepted risks:** the Master's plaintext password vault (owner asked for
    it; keep the guards in `docs/overhaul/workstream-F.md`); no TLS on the LAN
    (the public API is off by default).

## Owed work

**Owner decisions** (blocking a customer release — `docs/PRODUCTION_READINESS.md` §5):

1. What happens to any machine still on 1.0.3: updating to 1.2.0 runs the
   variant and trim migrations, which lose its products, leads and orders. The
   automatic pre-update copy keeps the old cluster; nothing brings the rows
   forward.
2. Create the release signing key (`npm run release:keygen`) and the
   `RELEASE_KEY` secret; until then no installed panel offers an update by
   itself.
3. Buy a code-signing certificate, or accept the SmartScreen warning.
4. The Recycle Bin has no exit — three options in
   `docs/ai-handoffs/recycle-bin-delete-actions-and-purge.md`. Do not
   implement one until the owner picks.

**Code** — the queue is `docs/ai-handoffs/README.md`:

1. **No way to look at a product photo.** `ProductDetail.tsx` never reads
   `product.images`, so the `large` and `master` sizes are never requested.
2. **No route from a party to its access editor** (the owner's "no option for
   assign party").
3. **Password-change tail:** `invalidateSessionsForUser` records no reason, and
   Reset password has no self-exclusion warning.
4. **Master-side New lead:** port the Office `AddLeadScreen` into `ui/` behind
   a transport if the Master should create leads again (`POST /api/leads`
   still exists).
5. **Offline product + lead in one session:** a lead line needs a variant id,
   which a panel cannot know for a product the Master has not created yet, so
   a lead cannot reference a product created offline in the same session. The
   temporary-`productId` remap in `sync.service.ts` is kept for when variants
   get temporary ids.
6. **Weights:** the catalogue's 549 variants have none; the Office
   Catalogue's *Missing weight* filter is the worklist.

**Manual:**

- A browser and Electron pass of both panels on 1.2.0 (nothing since the
  consolidation has been run in a browser).
- An install / update / uninstall rehearsal on a real Windows PC, and a run of
  the standalone `.exe` (`docs/PRODUCTION_READINESS.md` §2 item 4).
- The macOS build — configured and guarded by
  `master/tests/packaging-invariants.test.ts`, never executed.
- Responsive gate: 1024×768 / 1366×768 / 1920×1080 / 3840×2160 at 79 % /
  100 % / 157 %, sidebar in all three modes.

Open questions still unanswered by the owner: extra party fields (credit
terms, multiple contacts); concurrent edits of one lead from two panels
(last-write-wins is the default); app name/branding.

## Traps worth knowing

- **An integration suite that skips is not a suite that passed.** As root
  every integration file skips and the summary reads green. Check the count.
- **Release-test fixtures publish for the host platform.** `updates.test.ts`
  publishes each fixture for `process.platform` unless the test is about
  platform; `github-releases.test.ts` pins `win32` for its duration. Either
  way a fixture's OS must match the platform the code under test defaults to,
  or a test fails off Windows or passes without reaching its check.
- **An optional `CompanyFeatures` field left unresolved typechecks cleanly.**
  `master/tests/company-features-complete.test.ts` is the only catcher. Use
  `??`, never `||` — several switches default to `true`.
- **An update used to be a full record replace** and nulled every column the
  form did not show. `columnPatch()` emits only asserted keys
  (`partial-patch.integration.test.ts`).
- **Both panels shared one Electron single-instance lock when run from
  source.** `app.setName()` must run before `requestSingleInstanceLock()`.
- **On Windows `child.kill('SIGTERM')` is `TerminateProcess`.** The shell sends
  `{type:'orderbook:shutdown'}` over the IPC stdio slot and waits.
- **A child that inherits your pipes never lets `execFile` resolve.** Spawn
  `pg_ctl` with `stdio: 'ignore'` and wait for `exit`.
- **`shared/` and both `web/dist` are build artefacts.** The `prepare` and
  `pre*` scripts exist so a clean checkout works.
- **Two branches once minted the same migration timestamp;** deleting one
  locked every database that had run it. Keep both, make both idempotent.
- **A migration must never import a live shared constant.** Inline what it
  writes.
- **`20260325000000_line_item_grade` is registered after the trim** (and in
  `DELIBERATELY_LAST`), because the trim drops `line_items.grade`; in
  timestamp order a fresh database would gain the column and lose it.
- **`master/tests/i18n-tokens.test.ts` is load-bearing:** every
  `(entityType, action)` given to `recordActivity` needs an
  `activity.<entity>.<action>` string.
- **electron-builder runs `npm install --omit=dev`** and prunes the root
  `node_modules`; both `electron-builder.yml` set `npmRebuild: false`.
- **A build output folder keeps the last build.** Match the exact filename and
  clear the folder first. macOS `universal` needs both architectures'
  PostgreSQL vendored (`extraResources` is identical in both halves).
- **The file that records where the data lives must not live in the data.**
- **Party access has many read paths** — `grep applyPartyScope` /
  `grep partyScopeSql` before adding a scoped entity.
- **The last-administrator guard runs inside the transaction.**
- **An Office panel's acting user is resolved per command**, never per
  connection. Offline sign-in is reachable only when the Master could not be
  asked, and only while `security.offlineSignInEnabled` is on.
- **`UNION ALL` branches must cast to one type** (`id::text`).
- **`request()`'s in-flight GET dedupe is keyed on path + headers.**
- **Shift+letter chords never reach the command registry while typing.**
- **jsdom cannot test visibility** (`checkVisibility` is undefined).
- **A token minted as `obk_<base64url>_<base64url>` split on `_`.** The
  prefix is hex; `parseToken` rejoins everything after the second separator.

## Session history

Condensed. The full entries are in `git show 5b8ebe2:HANDOFF.md` and in
`docs/AI_COLLABORATION.md`.

- **2026-09-22 — Branch consolidation and cleanup (Claude).** Merged
  amazing-lovelace, hopeful-lovelace and vibrant-ride into `main`, reset `dev`
  to `main`, and listed the rest for the owner to delete. Removed dead code: 15
  unused exports in `shared/` and `ui/` (`maskFields`, `Tooltip`, `Radio`, …),
  `shared/src/i18n/pseudo.ts`, 203 unused i18n keys in both catalogues, 22
  dead CSS rules, and the pricing leftovers in the design gallery and image
  service. Refreshed the stale docs and rewrote this file. Verified: lint 0,
  typecheck 0, build 0, 140 files / 1699 tests with integration suites.
- **2026-09-22 — 1.2.0 standalone builds (Claude, amazing-lovelace).**
  Standalone `.exe`, pre-update database copy, additive-migrations guard,
  cross-platform web build, CI green; the Release workflow built all eight
  Windows files into a draft pre-release. Left three owner decisions (above).
- **2026-09-22 — Lead-add and product add (Claude, serene-hawking).** Party
  shows its name alone, follow-up defaults to today, the suggest field's
  keyboard fixed, Enter walks the variants table, Grade back on a line as a
  pick (`20260325000000_line_item_grade`), a compact added-product row, and
  Modify/Remove as icons.
- **2026-09-22 — Product page UI (Claude, zealous-cori).** Product screens
  redesigned from the owner's artifact; stock dropped from the product detail;
  the crop editor made horizontal with load states and every image format
  (HEIC/AVIF/TIFF accepted client-side).
- **2026-09-21 — Product master trimmed, pricing removed (Claude).**
  Multi-colour lines, the catalogue PDF extracted into a spreadsheet.
- **2026-09-21 — Filter strip (Claude, vibrant-ride).** Category chips dropped,
  the strip given vertical room.
- **2026-09-19 — Product model → variant (Claude).** Swisware catalogue, PDF
  Designer removed, sample data; merged with the v1.1.0 line.
- **2026-09-16..18 — Settings, security, packaging (Claude, hopeful-lovelace).**
  Fourteen briefs closed; four privilege holes; eleven company settings and
  the forced resnapshot on a setting change; the clean-install tool; Mac and
  Linux panel builds (verified on Linux: packaged Master created its cluster
  and answered `/api/health`).
- **2026-09-14 — Build fix, dead code, bloat removal (Claude).**
- **2026-09-06..13 — v1.0.3 blockers, developer mode, uninstaller, pricing
  switch (later removed), product hierarchy, keyboard-first lead entry
  (Claude, Command Code).**

### Claude sessions retired on 2026-09-22

The owner is deleting these sessions; this is what each one was and where its
work went.

| Session | What it did | Where the work is |
|---|---|---|
| Repository cleanup and branch reset (this one) | Consolidation and cleanup above | `main` and `dev` |
| Orderbook standalone version | 1.2.0 standalone `.exe`, backup on first boot | merged to `main`; the three owner decisions are under "Owed work" |
| Lead and product add improvements | lead-add trims, suggest keyboard, Grade, icons | already on `main` (`ecd5f8b`) |
| Product page UI/UX implementation | product redesign, image picker formats and load states | already on `main` |
| Top bar filter removal and spacing | filter strip | merged to `main` |
| Project status and structure review | settings, privilege fixes, clean-install tool, Mac/Linux builds | merged to `main` |
| UI improvement (local CLI) | Phase 6.0 standalone flavour, `a3fa9e4` on `feat/marcwares-design-system` | **only on the owner's machine** — not on GitHub |
| Windows bloatware removal script (local CLI, archived) | unrelated to this repo | — |
| desktop-… sessions and "Install Andrej Karpathy skills repository" (archived) | early setup on `dev` | nothing outstanding |
