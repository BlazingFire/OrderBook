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
| The whole software and its code: every file, schema, flows, tests, where a change goes | `docs/STRUCTURE.md` |
| Every table, column, index and why | `docs/schema/` (start at `00-overview.md`) |
| Lead → order flow as built | `docs/LEAD_GENERATION_FLOW.md` |
| Roles, users, permissions, tiers | `docs/ROLES_AND_USERS.md` |
| Developer password, reset, test users | `docs/DEVELOPER_MODE.md` |
| Shipping an update, release ordering rule | `docs/UPDATES.md` |
| Shipping to customers under the "never lose data" rule | `docs/PRODUCTION_READINESS.md` |
| Manual QA script | `docs/TESTING_PLAN.md` |
| What to do next | `docs/NEXT_PHASE.md` |
| Open work items (the queue) | `docs/ai-handoffs/README.md` |
| The product master: category → model → variant; pricing removed | Key decisions 12, 14, 15 below; `docs/schema/02-parties-and-products.md` |
| Catalogue v2: Brand → Product → Sub product, colour rules, lead entry, lead PDF | `docs/catalogue/CATALOGUE_MODEL.md` (the spec); the data is `master/assets/catalogue/swisware-plus-2026.md` |
| Fields, Logs, Recycle Bin, Reports, i18n design | `docs/BACKEND_MODULES.md` + `docs/backend-modules/` |
| The 2026-08/09 overhaul designs (implemented; Workstream I, the AI section, removed) | `docs/overhaul/` |
| Multi-agent workflow and per-session change log | `docs/AI_COLLABORATION.md` |

`docs/backend-modules/` is cited from source and test comments as design
rationale (gate ids such as `DSH-3`); of `docs/overhaul/`, only `README.md` and
`workstream-F.md` are cited from source — the rest is history. They were
written before the code and several of their stated facts did not survive
contact with the tree — check a design's claim against the code before acting
on it.

## Current state (2026-09-29, catalogue v2 on the 1.2 product master)

- **Catalogue v2 (2026-09-29):** the owner's Brand → Product → Sub product
  restructure (`docs/catalogue/CATALOGUE_MODEL.md`) is ported onto `main`'s
  1.2 model and merged to `main`. A first build of it on a stale checkout
  that never took 1.2.0 (`catalogue-v2-stale`, `6549018`) was not merged: its
  pricing, `colour_policy`, PDF Designer and settings code is what `main`
  removed on purpose. **Walked in a browser** on both panels against a
  sandbox database (operator scripts, lead entry for every colour rule,
  review and save, the lead PDF's text, Products / Brands / Sub products,
  Settings → Leads on both panels, the Master's inventory and leads list);
  **not yet in Electron** — the PDF window is owed (`docs/AI_COLLABORATION.md`,
  2026-09-29 entry).
- **Branches:** `main` is the only long-lived branch; `dev` was reset to
  `main` on 2026-09-22 to develop on. Every other branch was merged or
  retired that day (see "Branch consolidation" below), and the twelve still
  on GitHub are **to be deleted by the owner**: the cloud sessions' git proxy
  refuses branch deletion and tag pushes (HTTP 403). The 2026-09-24/25 round
  was merged straight into `main` from eleven local `fix/*` branches, which
  were never pushed and hold nothing `main` lacks. On 2026-09-25 `main` and
  `dev` on GitHub were both at `7d6ae68`, the round's last commit; if `main`
  has moved since, bring `dev` level with it before working on it. Work
  lands on `main` (directly or through `dev`); do not branch from an old
  branch.
- **The 2026-09-24/25 round** audited the whole tree and fixed what it found
  on those eleven branches, each reviewed and repaired before the merge.
  Every defect this file listed as open after the 2026-09-22 structure audit
  is fixed (see "Session history"). What is still open, including that
  audit's dispatch-by-stage-name finding (`docs/STRUCTURE.md` §5.11 #7),
  which this file had not listed, is under "Owed work".
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
  2026-09-25 after the audit round: lint 0, typecheck 0, build 0, 160 test
  files / 2015 tests passing, integration suites included** (PostgreSQL
  16, run as a non-root user — see "How to run"). Run the three steps
  separately and check each exit code. As root the integration suites skip
  (the 48 `*.integration.test.ts` files) and the summary still reads green.
- **The web apps under test:** `master/web` and `office/web` still have no
  test files of their own, but `ui/tests/master-shell.test.tsx` and
  `ui/tests/office-shell.test.tsx` boot each panel's `App.tsx` whole in jsdom
  (`ui/tests/panel-harness.ts`: the real `api.ts` against a route table
  standing in for `fetch`). They pin the shell's behaviour: which screen
  Alt+N, a toast action or the gallery link lands on, the Dashboard after a
  sign-out or an ended session, the splash's "could not reach the server",
  refetches on a change event, the New lead form and the order weight
  override. Layout, styling, anything that depends on visibility, a live
  server and the Electron shell still need a browser or Electron pass.
- **Builds:** `npm run build` is green for shared, both servers and both web
  bundles on every OS: the web workspaces build through `tools/build-web.mjs`
  (resolves `tsc`/`vite` from `node_modules/.bin` by path, points
  `TEMP`/`TMP` at a gitignored `.tmp/` for the Windows esbuild/Defender lock).
- **Releases:** `.github/workflows/release.yml` builds on a three-OS matrix
  (Windows setup + standalone `.exe`, macOS universal `.dmg`, Linux
  AppImage + `.deb`). The standalone `.exe` and the `.deb` are published
  beside the setup files with a `.sha256` each (`TARGETS[*].besides` in
  `tools/release.mjs`) and are named by no manifest; the mac `.zip` is no
  longer built (nothing read it). **All three legs were green on 2026-09-25**
  (build-only run #37 on `dev` at `7d6ae68`, draft pre-release
  `build-1.2.0-7d6ae68`), so this round's release changes have built on
  every OS: both standalone `.exe`s and both `.deb`s arrived with their
  `.sha256`, and the mac leg uploaded its `.dmg`s and no `.zip`. The
  `release-workflow`, `packaging-invariants` and `release-folder-besides`
  tests cover the same ground. A push to `main`
  whose `package.json` version has no release yet publishes `v<version>`;
  unsigned (no `RELEASE_KEY` secret) it is a **draft**, which no panel
  installs. A draft counts as a release there, so the push of `7d6ae68` to
  `main` built nothing: `v1.2.0` already exists (see "Owner-only" below). A
  manual run builds into a draft pre-release `build-<version>-<sha>`;
  ticking *publish* creates the real release only on `main`, and anywhere
  else the `check` job warns and builds the draft pre-release. Existing
  releases (1.0.2, 1.0.3, 1.1.0, 1.2.0, and six `build-1.2.0-*`
  pre-releases) are all drafts. The clean-install tool (`cleaner/`) is built
  but never published into the releases folder.
- **Updates on Linux:** an AppImage copy updates in place from the Updates
  screen (the shell replaces the file and relaunches it); a `.deb` install,
  a run from source, or an unpacked copy is told to update by hand
  (`updates.systemPackageBody`). No AppImage update has been run end to end
  on a real Linux PC yet (see "Owed work").
- **Company settings: thirteen**, in four groups on the Settings tab
  (`shared/src/domain/settings.ts`): password reveal, free-to-sell, public API,
  auto pairing, developer mode, session hours, default reorder level, offline
  sign-in, adjustment note required, import creates categories, follow-up
  default days, packaging required on convert, quiet-after days. Adding one is
  a single entry there plus two i18n tokens; the screens read switches through
  `resolveCompanyFeatures()`. Since catalogue v2 two fallbacks changed, so an
  installation that never saved them changes on upgrade, as the owner asked:
  **follow-up default days 3** (was 0, today) and **packaging required on
  convert off** (was on). An Office panel may save the follow-up default from
  its own Settings → Leads tab, as the signed-in user; the Master still checks
  `settings.manage`.
- **Product master (catalogue v2, 2026-09-29):** the owner's **Brand →
  Product → Sub product** on the 1.2 tables. A Product is a
  `product_categories` row with a software `code` (`OPT`), a `brand` (a
  `product.brand` option value) and a catalogue `sort_order`; a Sub product
  is a model (`products`) with **exactly one variant**, whose code is
  `CODE-0001…` in catalogue order. A product is name · category · alias ·
  size · *made in every colour* switch · custom fields, with variants of
  code · colour · weight. The colour rule (`fixed` / `dedicated` /
  `selectable`) is derived from the model and its variant, never stored
  (`colourRuleOf`, `shared/src/domain/colour-rule.ts`). Stock, movements and
  reservations are per **variant**. A lead line on a multi-colour product
  may name a colour from `stock.colour`, several colours being several
  lines; a line snapshots the category's name, code and brand, and carries a
  **grade** from `line.grade` (a line attribute, never a catalogue one). The
  spec is `docs/catalogue/CATALOGUE_MODEL.md`; the SWISWARE data (1 brand,
  21 colours, 41 products, 549 sub products) is
  `master/assets/catalogue/swisware-plus-2026.md`.
- **Master shortcuts moved** (worth a line in the release notes): Parties
  is now Alt+3, its place in the sidebar, and the screens below it move down
  one — Inventory Alt+4, Reports Alt+5, Conflicts Alt+6, Office panels
  Alt+7, Roles & users Alt+8, Party access Alt+9. Fields and everything after
  it are reached from the command palette. Shortcuts a person remapped are
  kept.
- **Hindi is 1,245 strings behind** (`grep -c 'TODO(i18n-hi)'
  shared/src/i18n/hi.ts`). The parity test only checks keys exist, so nothing
  fails on it — except an `activity.*` template, where
  `shared/tests/i18n-coverage.test.ts` fails the English stub until it is
  translated. Settings → Appearance has a language picker.
- **Live databases:** external PostgreSQL via `.env` `DATABASE_URL` on both of
  the owner's machines (`order_book` on the PC, `order_book_new` on the
  laptop). The first Master started from a pre-1.2 database runs
  `20260323000000_product_variants` (wipes every product-linked table) and
  `20260324000000_product_master_trim` (drops the pricing/tile columns in
  place; `down()` throws). Settings → Developer → *Load catalogue* (or
  `npm run seed:catalogue`) loads the SWISWARE catalogue additively: 41
  products, 549 sub products (one variant each) and the 21-colour range, with
  blank weights.
- **Take a `pg_dump` before main first boots on the owner's PC database.**
  On 2026-09-28 `order_book` was booted by a stale checkout (branch
  `catalogue-v2-stale`, `6549018`) that never took 1.2.0, and it ran that
  checkout's `20260323000000_catalogue_brands_and_codes`. It has therefore
  never run main's `product_variants`, `drop_document_designer`, trim or
  `line_item_grade`. The first time main boots on it, `product_variants`
  **TRUNCATEs products, categories, images, party-wise records, stock,
  movements, reservations, leads, orders, their lines and timelines** —
  everything entered on the stale model — and the trim deletes the stale
  `product.brand` values; then the port migration finds its columns already
  there. With `DATABASE_URL` set the Master takes **no** automatic pre-update
  copy (`master/src/index.ts` skips `snapshotClusterBeforeUpgrade` for an
  external database), so the dump is the only way back. The owner took one on
  2026-09-29 (`pg_dump -Fc` to `C:\OrderBook-Backups\order_book-2026-09-29.dump`,
  165,135 bytes, restorable with `pg_restore --clean --if-exists`); it is only
  a way back if it was taken before main's first boot there. The laptop's
  `order_book_new` history is not recorded here: read its `knex_migrations`
  before booting main on it. After the wipe, `npm run reload:catalog` (Master
  stopped) or *Load catalogue* brings the catalogue back.

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
`wipe:business`, `seed:parties`, `reload:catalog`, `seed:catalogue`,
`seed:demo-parties`. They talk to the live database — read
`master/src/services/catalog-reload-cli.ts` before running one. Run them with
the Master stopped: each starts the database the way the Master does and
stops it when done (with `DATABASE_URL` set it stops nothing).

- `wipe:business` and `seed:parties` wipe the business data first, the whole
  activity log and every connector link with it; `seed:parties` then adds
  three sample parties.
- `reload:catalog` (catalogue v2, `--catalogue`) **keeps parties, party
  access, users, roles, settings, option lists, `id_map` and the activity
  log**, and resets no id counter. It parses
  `master/assets/catalogue/swisware-plus-2026.md` before it starts the
  database (a malformed file is refused with its line number), refuses while
  any other client is connected to the database (`pg_stat_activity` — a
  running Master always is), and warns that every Office outbox must be
  drained first: queued work that quotes the old catalogue is refused
  afterwards. Then `loadCatalogue({ replace: true })`, in one transaction,
  deletes only the catalogue and what quotes it — stock, movements,
  reservations, lines, timelines, leads, orders, their sync conflicts,
  party-wise records, photo rows, product connector links, variants, sub
  products and products — loads the file and writes one `catalog.reloaded`
  activity row. Photo files go at the Master's next boot. The pre-v2
  behaviour (wipe, then load) is `npm run wipe:business -- --with-catalog`.
- `seed:catalogue` loads the same file additively — a product found by code
  or (brand, name), a sub product already live under the same name skipped
  — as Settings → Developer → *Load catalogue* does, and writes one
  `catalog.imported` row when it adds anything.
- `seed:demo-parties` adds 13 demo dealers through `createParty`, wipes
  nothing and skips a name already on the books.

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

- **Layout:** `docs/STRUCTURE.md` is the map — every workspace and file, the
  schema, the main flows end to end. Read it before hunting for a file.
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
- **Copy to the clipboard through `copyText`** (`ui/src/clipboard.ts`), never
  `navigator.clipboard` directly: a browser gives that only to a secure
  context, and the panels run over plain HTTP on the LAN.
- **Tests for the web apps' shells** live in `ui/tests/`
  (`master-shell.test.tsx`, `office-shell.test.tsx`, over `panel-harness.ts`),
  since neither web app has a test directory.
- **Desktop shell pieces:** the Office server's environment is
  `electron/lib/office-env.ts` (the Master's is still inline in
  `master.main.ts`); how a copy updates is `updateMethod()` in
  `electron/lib/installer.ts`; the AppImage replace and relaunch is
  `electron/lib/appimage.ts`.

## Working agreements

- **Verify before done.** `npm run lint`, `npm run typecheck` and
  `npm run test` each exit 0. `master/web` and `office/web` have no test
  files of their own; the jsdom shell tests in `ui/tests/` catch which screen
  a key, toast or link lands on and what a form sends, not layout, styling
  or anything visibility-dependent. For those a real browser or Electron
  pass is the verification, and a change not run in one should say so.
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
    hand, never updated in place; a Linux AppImage is replaced in place by
    the shell; a `.deb` install is updated by installing the newer `.deb` by
    hand. Only `main` publishes a release.
12. **Product catalogue:** category → model (`products`) → variant
    (`product_variants`: code, colour/pattern label, weight). Lead entry is
    the Office panel's `AddLeadScreen`; the Master has no New lead page.
    **Catalogue v2 (owner, 2026-09-28; `docs/catalogue/CATALOGUE_MODEL.md`)**
    maps the owner's Brand → Product → Sub product onto those tables without
    renaming them: a **Product** is a category, which gains a software
    `code` (alphanumeric, unique per tenant among live rows), a `brand` (an
    option value of `product.brand`; brand is read through the category and
    never copied onto `products`), a catalogue `sort_order` and a soft
    delete; a **Sub product** is a model with **exactly one variant**, its
    printed name on `products.name` and its software code `CODE-####` on the
    variant. The colour rule is **derived, not stored**: `multi_colour` →
    `selectable`; a labelled variant → `fixed` (the label is the colour);
    otherwise `dedicated` (no colour anywhere). The screens say Product and
    Sub product; the code keeps `category*` / `product*` / `variant*`.
13. **Accepted risks:** the Master's plaintext password vault (owner asked for
    it; keep the guards in `docs/overhaul/workstream-F.md`); no TLS on the LAN
    (the public API is off by default).
14. **The product restructure (owner, 2026-09-19):** seed the whole catalogue
    with weights blank (optional in storage, flagged *weight missing*, `> 0`
    when given — nobody invents a weight for a dispatch note); wipe the
    product-linked data on that install; hide the tile-only fields (the
    columns stay).
15. **The product trim (owner, 2026-09-21):** pricing removed whole — line and
    party-wise rates, totals, the switch, the rate permissions, money in
    reports. Custom fields stay on products. A multi-colour line picks its
    colour from the Settings colour list; the colour is a line attribute, not
    a stock key, and a colour missing from the list is never refused (an
    offline lead must still land). **Amended by catalogue v2 (2026-09-28):** the
    Master **coerces, never refuses** — a colour sent for a product that is
    not multi-colour is dropped (`colour = NULL`) instead of refused with
    `LineColourError`, so a queued lead cannot bounce on it; and **several
    colours of one sub product are several lines** on the same variant, one
    per colour with its own quantity (no schema change; the screens and the
    lead PDF group them as `White ×10, Ivory ×5`). Stock stays per variant.
    The two briefs that recorded these (`docs/ai-handoffs/product-model-variants.md`,
    `product-master-trim.md`) were deleted on 2026-09-25 as done; git history
    has them.

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
5. Whether to harden the uninstall scripts (`tools/uninstall/`): *Uninstall,
   delete data* removes the folder the shell's pointer names, whole
   (`Remove-Item -Recurse` / `rm -rf`). Deleting only a panel's own entries
   from a relocated folder would also cover the Master's first-run chooser,
   so it was left to the owner. The Office storage move now refuses a drive
   root, a home folder and a folder holding anything that is not a panel's
   own, which closes the path the audit found.

**Owner-only** — a cloud session cannot do these: its git proxy refuses
branch deletion and tag pushes (HTTP 403), and the last needs real Macs:

1. Delete the twelve old branches on GitHub (listed under "Branch
   consolidation").
2. **Rebuild the v1.2.0 draft before publishing it.** Its Linux files were
   built before the library-link fix (they carry absolute links into the
   build machine and cannot start PostgreSQL elsewhere) and it has no macOS
   files. Delete the draft `v1.2.0` release on GitHub, then run the Release
   workflow on `main` with *publish* ticked.
3. **Launch the macOS app on real hardware** — it has been built, never run.
   CI produces the universal `.dmg`, unsigned (electron-builder 25 has no
   ad-hoc fallback, so without an identity nothing is signed and a
   downloaded copy needs a right-click Open). Launch it on an Intel and an
   Apple silicon Mac: first boot must create the database, and a product
   photo upload exercises `sharp`.

**Code** — the queue is `docs/ai-handoffs/README.md`:

1. **Product photos: no full-size view, and an offline upload's raw error.**
   The product screen does show the cover photo now (`ProductImages` on
   `ProductDetail.tsx`, the `large` size) and the photo UI is translated, but
   nothing opens a photo full size, so the 2048 px `master` size is still
   requested by nothing. An upload while the Master is unreachable answers the
   raw Node error text with no `messageKey` (`office/src/http/app.ts`, the
   `/api/products/:productId/images` route), and its "Choose an image file" is
   English only. Brief: `office-product-image-flow.md` §2 and §4.
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

**Found by the 2026-09-24/25 audit and not fixed.** Each was confirmed by
reading the code, not in a running app. Every defect the 2026-09-22 structure
audit listed here is fixed (see "Session history").

*Server and data:*

1. **Dispatch keys on the stage named `Dispatched`**
   (`order.service.ts#dispatchOrder`), so a stage renamed on the Fields
   screen leaves a dispatched order where it was. Nothing on
   `pipeline_stages` says which stage means dispatched (`is_terminal` is also
   true of Cancelled); the fix needs a stage flag added by an add-only
   migration, a way to set it, and the owner's input.
2. **`deleteOrder` can race a dispatch:** it checks `dispatchedAt` on a read
   before its transaction and does not lock the row, so an order dispatched
   in between can still be deleted.
3. **`party_code` truncates from the 10,000th party:** `lpad(…, 4, '0')` cuts
   as well as pads, so the code repeats an earlier one (`P-1000` again) and
   the insert fails while that party is live (`docs/schema/02-parties-and-products.md`).
4. **No index on `leads.owner_id` or `orders.owner_id`:**
   `20260303000000_roles_and_users` re-created the columns as TEXT, which took
   both indexes with it (`docs/schema/03-leads-orders-inventory.md`). Needs an add-only migration.
5. **The public API's tenant cache is stale after a whole restore:**
   `resetPublicApiTenantCache()` is called by Developer mode's erase only, so
   until a restart the public API reads the switch of a tenant that is gone.
6. **The wipe/reload CLIs stop the database they start**
   (`catalog-reload-cli.ts`; `seed-catalogue-cli.ts` does the same), which
   pulls it out from under a running Master unless `DATABASE_URL` is set.
   The first one's header says to run it with the Master stopped. Since
   catalogue v2 `reload:catalog` checks — it refuses while any other client
   is connected — but `wipe:business`, `seed:parties`, `seed:demo-parties`
   and `seed:catalogue` still do not.
7. **22 of the 84 client→server socket events have no caller** in
   `office/src`; the Master still registers handlers for them
   (`docs/STRUCTURE.md` lists them).
8. *Observation:* a `partyVariant.upsert`'s temporary id never reaches
   `id_map`.

*Office Panel and desktop shell:*

9. **Work may be stranded after an early storage move.** An Office panel
   that moved its storage before this round came back up in the old folder,
   so anything saved after the move sits in the move target.
10. **After a storage move the shell's log stays in the old folder** until
    the app is relaunched. Every "where is the log" answer names that file
    (`openLogPath()`), so nothing points at the wrong one.
11. **A transient outbox read at flush time:** a flush that meets a moment's
    read error (`load()` in `office/src/sync/outbox.store.ts`) sees an empty
    queue and sends nothing that pass. A save refuses in the same case. A
    queue that reads but is not a list (corrupt, not just busy for a
    moment) is set aside beside `outbox.json` as
    `outbox.json.unreadable-<time>`, and the log names it: look there for
    queued work that never reached the Master.
12. **The Updates screen has no "fetching" reason.** While the Master
    fetches the build for a panel's OS, the panel is told "nothing new yet"
    (`docs/UPDATES.md`, "When a new build shows up").
13. **Clean Install runs a `.deb` as if it were an AppImage.** It accepts one
    as a Linux setup file (`EXTENSIONS` in `electron/lib/cleaner/setup-file.ts`,
    the file dialog in `electron/cleaner.main.ts`) but can never verify it,
    since no manifest names a `.deb`; and on Linux `cleaner:install` spawns
    the chosen file directly, which does not install a package (that takes
    `apt install ./<file>`).

*Master UI:*

14. **AccessScreen's RoleEditor asks with `window.confirm`** before
    discarding an edit, not the themed ConfirmDialog.
15. **The Master keeps drawing a screen after the person's permission for it
    is revoked.** `ScreenHost` draws the tab whatever the sidebar offers; only
    navigation checks. Sign-out and an ended session do reset to the
    Dashboard.

*Stale text:*

16. Two stale comments. `master/src/services/inventory.service.ts:179` says
    `isBlankNote` is shared with both panels' forms: only this service calls
    it (the Master's Inventory form makes its own `trim()` test, and the
    Office has no stock-correction form). The `electron/preload.cts` header
    says the shell refuses anything outside "that panel's updates folder":
    the Master's installer comes from its releases folder
    (`releaseDirFor('master')`), and an AppImage is replaced, not run.

*Found by the 2026-09-25 leftover cleanup (none is a defect today):*

17. **`ROLE_TEMPLATES`** (`shared/src/domain/permissions.ts`) are defined and
    their `roleTemplate.*` names translated, but no screen offers them when a
    role is created. Wire them into the role editor or drop them.
18. **`signIn.notice.passwordChanged` is never sent** — it exists only in the
    two catalogues (the password-change tail in *Code* item 3 above is why).
19. **`fontkit` is a Master runtime dependency used only by
    `master/tests/pdf-fonts.test.ts`** (PDFKit brings its own); it could move to
    `devDependencies`.
20. **The `ai_runs` table and stored `ai.*` role keys remain** from the removed
    assistant. Migrations only add, so taking them out is the owner's decision.
21. **The sample data's `creditDays` party field is payment terms** — money by
    another name. Kept on purpose; whether it stays is the owner's call.

Deliberate, not defects: three kinds of audit entry are still written after
the fact (`recordDetachedActivity` in `activity-log.repository.ts` says why).
A sign-in attempt, accepted ones included, although an accepted one stamps
`last_sign_in` in a transaction it could join: joining would make signing
in fail whenever the trail cannot be written. A connector run, whose one
entry sums up many transactions. And a panel's reissued secret or moved
storage folder, which has already happened on the panel's machine.

**Manual:**

- **Catalogue v2 in Electron:** the Preview PDF window (`electron/lib/lead-pdf.ts`)
  has only been exercised by its unit test; the browser pass on 2026-09-29
  read the PDF's bytes, not the window. Also look at the Master's Leads
  table at 1366 px: the Preview PDF button widens the actions column and
  the Party and Products columns are cut short — which columns give way is
  the owner's call.
- A browser and Electron pass of both panels on 1.2.0. Since the
  consolidation only the Settings permission change and the Socket.IO
  Origin check (both in `d7481f7`'s run against a live Master) have been
  exercised in a real Electron window; the jsdom shell tests cover
  navigation and forms, not layout.
- An install / update / uninstall rehearsal on a real Windows PC, and a run of
  the standalone `.exe` (`docs/PRODUCTION_READINESS.md` §2 item 4).
- **An AppImage update end to end on a real Linux PC:** download, verify,
  replace, relaunch, including a copy started with
  `--appimage-extract-and-run`. Only unit tests have run it so far.
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
- **It happened again with a name, not a timestamp (2026-09-29).** The stale
  `catalogue-v2-stale` checkout ran `20260323000000_catalogue_brands_and_codes`
  on the owner's PC database; Knex refuses to boot a database whose
  `knex_migrations` names a migration the registry lacks ("The migration
  directory is corrupt"). Its real body cannot come across either: it
  touches `products.colour_policy`, which 1.2's `product_variants` drops, so
  every 1.2.0 installation would fail on it. So main keeps the **name as a
  no-op** (registered beside `product_variants`, the `panel_app_version`
  precedent) and **`20260326000000_catalogue_brands_and_codes_port` does the
  work**, every statement `IF NOT EXISTS`, pinned last in
  `DELIBERATELY_LAST`: a fresh, a 1.2.0 and the stale database all end on the
  same schema. Do not "tidy" the stub away.
- **A migration must never import a live shared constant.** Inline what it
  writes.
- **`20260325000000_line_item_grade` is registered after the trim** (and in
  `DELIBERATELY_LAST`), because the trim drops `line_items.grade`; in
  timestamp order a fresh database would gain the column and lose it.
- **`master/tests/i18n-tokens.test.ts` is load-bearing:** every
  `(entityType, action)` given to `recordActivity` needs an
  `activity.<entity>.<action>` string.
- **An audit entry is the last statement of its change's transaction.** A
  write stamps the clock (`nextHlc`) first, then takes its row locks, then
  calls `recordActivity(…, trx)`; the chain trigger's per-tenant advisory
  lock is taken last, so its holder only ever waits to commit. The other
  order deadlocks (`40P01`): `party-access#replaceAssignments` did.
  `master/tests/audit-atomicity.integration.test.ts` fails an entry moved
  ahead of its row write. `recordDetachedActivity` is only for the three
  kinds its comment names; it swallows a failed insert.
- **A Hindi `activity.*` template needs a postposition after `{actor}`.** A
  row with no actor reads `किसी`, which only works as `किसी ने …`.
  `shared/tests/i18n-coverage.test.ts` fails the English stub that
  `npm run i18n:sync` writes for a new activity key until it is translated,
  and keeps price words out of both catalogues (Hindi matched on letter
  boundaries, so `गोदाम` passes).
- **electron-builder runs `npm install --omit=dev`** and prunes the root
  `node_modules`; both `electron-builder.yml` set `npmRebuild: false`.
- **`fs.cp` rewrites a relative symlink as an absolute one** unless given
  `verbatimSymlinks: true`. PostgreSQL's `native/lib` is mostly SONAME links,
  so every packaged Master once carried links into the build machine's
  `node_modules`: it worked where it was built and nowhere else. Both copies
  in `tools/release.mjs` now keep links verbatim, and `assertUsablePostgres`
  checks every link in `pg-symlinks.json` resolves.
- **A build output folder keeps the last build.** Match the exact filename and
  clear the folder first. macOS `universal` needs both architectures'
  PostgreSQL vendored (`extraResources` is identical in both halves).
- **`npm run release` refuses a Windows or Linux Master build on a machine
  that is not x64** (`assertHostArch()` in `tools/release.mjs`): staging
  copies the build machine's own `sharp` and PostgreSQL into the Master. The
  Office panel and Clean Install carry nothing native and build their x64
  files anywhere; a Mac build is universal and is never refused.
- **One manifest, three names.** A GitHub release carries
  `latest-<panel>.json` (Windows) and `latest-<panel>-<platform>.json`
  (`manifestAsset()`); in a releases folder the same file is
  `latest-<platform>.json`, plus `latest.json` for a Windows build only (the
  one name older panels read). `readManifest` prefers the platform name, so
  a writer that leaves it out leaves the folder on a stale manifest. Each
  OS's sync sweeps only that OS's files, so one folder holds every OS's
  build.
- **A Linux AppImage is the running program, not an installer.** The
  Master's releases-folder sweep spares the file `APPIMAGE` names (compared
  by real path) as well as every pinned build; the shell trusts `APPIMAGE`
  only when its own executable runs inside `APPDIR`; the relaunch puts
  `--appimage-extract-and-run` back first when the old copy was started
  that way. `electron/tests/appimage.test.ts` skips its replace block on
  Windows (it needs POSIX file semantics), so the owner's `npm run verify`
  never runs it; CI (ubuntu-latest) does.
- **Node on Windows opens files sharing delete**, so removing a file that is
  being written or streamed succeeds on every OS. A sweep that relies on
  Windows locking it is wrong; pin what must survive.
- **The file that records where the data lives must not live in the data.**
- **An Office storage move rewrites the shell's pointer.** Under the desktop
  shell the next start reads `office-location.json`, not the settings file,
  so `relocateDataDir()` writes the pointer named by
  `ORDERBOOK_OFFICE_LOCATION_FILE`, which only `officeServerEnv`
  (`electron/lib/office-env.ts`) passes. Drop that line and every other
  server test stays green; `electron/tests/office-env.test.ts` and
  `office/tests/storage-path.test.ts` (which starts the server with
  `officeServerEnv`) catch it.
  *Uninstall, delete data* removes the pointer's folder whole, so a move
  refuses a drive root, the home folder and a folder holding anything that is
  not a panel's own. The shell's log stays where it was opened until the next
  launch: name it with `openLogPath()`, not `logPath()`
  (`electron/tests/shell-log.test.ts`).
- **A `serverEnv` variable its server never reads fails the build**
  (`electron/tests/server-env.test.ts`).
- **Party access has many read paths** — `grep applyPartyScope` /
  `grep partyScopeSql` before adding a scoped entity.
- **The last-administrator guard runs inside the transaction.**
- **An Office panel's acting user is resolved per command**, never per
  connection. Offline sign-in is reachable only when the Master could not be
  asked, and only while `security.offlineSignInEnabled` is on.
- **An Office queued write checks its shape in `queue()`'s `validate`
  step** (`office/src/http/app.ts`), which runs after the permission check.
  A shape check placed ahead of `queue()` answers a caller without the
  permission with a 400 that describes a well-formed payload.
- **`UNION ALL` branches must cast to one type** (`id::text`).
- **`request()`'s in-flight GET dedupe is keyed on path + headers.**
- **Shift+letter chords never reach the command registry while typing.**
- **The palette lists only what `offers()` says.** `KeyboardProvider`'s
  `offersCommand` answers in the same order `runCommand` does: palette and
  help commands, then a mounted registration, then a nav command only if the
  panel's `canNavigate` (the sidebar's own test) says yes, then a shell
  command only if the panel supplies one. A command `runCommand` learns to
  answer needs the same branch in `offersCommand`, or the palette hides it.
  `view.find` is left out on purpose: only the chord answers it.
- **The sidebars and `MASTER_NAV`/`OFFICE_NAV` must agree**
  (`shared/src/keys/commands.ts`; `shared/tests/keys-nav-order.test.ts` reads
  both `App.tsx` sidebars). A Master screen added above the ninth moves every
  Alt+N below it; say so in the release notes.
- **Socket.IO has no CORS; the handshake checks the Origin.**
  `isAllowedSocketOrigin` (`master/src/realtime/socket-origin.ts`) admits no
  Origin (an Office server in Node) or a page served from exactly the Host it
  connected to. A page on another port of the same machine is refused and
  logged; in development go through the Vite proxy.
- **`requirePanel` runs once, at the `/api/panel` mount** in
  `master/src/http/app.ts`. A router mounted there must not `.use` it again:
  a router's `.use` runs for every request that enters it, so the request
  pays the bcrypt compare twice. Under `/api/updates`, which the Master's own
  Updates screen shares, it sits on each panel route instead, never on the
  router.
- **jsdom cannot test visibility** (`checkVisibility` is undefined).
- **A shell test must wait until the panel is listening.** A panel opens its
  event stream, its Socket.IO link, the desktop-menu subscription and its
  key listener in effects, which React may not have run when the shell is
  first on screen; an event or chord sent then reaches nobody. Send through
  the helpers that wait: `sendSnapshot()` (`office-shell.test.tsx`),
  `changed()` (`master-shell.test.tsx`) and `pressAltDigitUntil()`
  (`panel-harness.ts`). A test that expects a chord to be refused opens a
  screen with a chord first, or it passes without the chord reaching the
  panel. The first test to open a screen also pays for compiling it, which
  under a full run outlasts `findBy`'s one-second default.
- **`ui/tests/panel-harness.ts` imports each `App.tsx` through a variable
  path** on purpose: a literal import pulls both web apps into
  `ui/tests/tsconfig.json`'s stricter program and fails the typecheck for
  reasons that belong to their own `tsc -b`.
- **A token minted as `obk_<base64url>_<base64url>` split on `_`.** The
  prefix is hex; `parseToken` rejoins everything after the second separator.

## Session history

Condensed. The full entries are in `git show 5b8ebe2:HANDOFF.md` and in
`docs/AI_COLLABORATION.md`.

- **2026-09-29 — Catalogue v2 ported onto the 1.2 product master (Claude).**
  The owner's 2026-09-28 restructure — Brand → Product → Sub product from the
  SWISWARE 2026 catalogue (`docs/catalogue/CATALOGUE_MODEL.md`) — had first
  been built on a checkout that never took 1.2.0 (`catalogue-v2-stale`,
  `6549018`), which also ran its migration on the owner's PC database. It was
  re-done on `main`'s model in a worktree on `catalogue-v2-port`: the no-op
  stub plus the idempotent `20260326` port migration (see "Traps"), the
  Markdown catalogue and its parser and one-transaction loader
  (`swisware-catalogue.ts` deleted), category CRUD with a Recycle Bin, derived
  colour rules, dropped stray colours, line brand/code snapshots, picks by
  code in catalogue order, the rebuilt Office lead entry, Products and Brands
  pages, Settings → Leads on both panels, the inventory listing every live
  variant, the fixed-layout lead PDF with its Electron window,
  `reload:catalog` keeping parties and the log, `seed:demo-parties`, and two
  changed setting fallbacks. Docs: this file, `docs/schema/`,
  `LEAD_GENERATION_FLOW.md`, `TESTING_PLAN.md` §8a, `STRUCTURE.md`,
  `DEVELOPER_MODE.md`, `backend-modules/04-API-CONTRACT.md` §10.2b.
  Walked in a browser on both panels; that walk found and fixed three
  defects — the Office's event stream reopening itself about sixteen times a
  second (already on 1.2.0), the sub-product list sorted A–Z instead of by
  catalogue, and a missing `inventory.piecesOnHand` string. Electron pending.

- **2026-09-25 — Leftover cleanup (Claude).** Dead exports went (`e2b7d71`);
  "1 attempt left" is singular now, and 57 unused message keys and the panels'
  dead CSS went (`cbf116b`). Text that still named removed features — money,
  the assistant, the PDF Designer, the old Picker, field "masking" — was
  reworded in sample data, test fixtures and comments; the two finished
  product briefs were deleted; status lines and counts brought up to date.
  Owed items 17–21 are what it found and left.
- **2026-09-24/25 — Audit of the whole tree, eleven fix branches (Claude).**
  The findings were fixed on `fix/schema-docs`, `audit-trail`,
  `http-hardening`, `master-tools-comments`, `release-sync`,
  `release-pipeline`, `electron-updates`, `office-storage`,
  `shared-contract`, `ui-kit` and `web-apps`; each was reviewed and repaired
  before it was merged into `main`. `d8f129e` and `8decf06` reconciled the
  tests the merges put at odds. Closed every defect this file had listed from
  the 2026-09-22 audit: audit entries written inside the change's transaction, and the
  writes that recorded nothing now record (a dispatch also bumps `version`
  and `hlc`); `GET /api/storage` needs `settings.manage`; a cross-site
  Socket.IO handshake is refused; `migrate --status` names what is pending
  and `reload:catalog` loads the catalogue (the wipe now clears connector
  links too); a GitHub setup file is no longer cut off at 15 s and a sync
  writes the platform-named manifests; Linux panels update their AppImage in
  place; an Office storage move survives a restart; the release publishes
  from `main` only, ships the `.deb` and drops the mac `.zip`; the kit's
  command priority is by mount order and Copy works over plain HTTP. Also:
  the schema docs checked against the migrated schema (new
  `docs/schema/07-integrations.md`), Parties on the Master's Alt+3, Hindi
  activity templates, an Office outbox that cannot be read no longer
  written over (a corrupt one is set aside as
  `outbox.json.unreadable-<time>`, a busy one is read again) and one failed
  save no longer blocking every later one, and the web apps' shell defects,
  pinned by booting both panels in jsdom. `ffb69fe` made the command palette
  list only commands that would do something (`offers()`, `canNavigate`):
  screens the sidebar withholds, "New record" for a role that cannot create
  one, and the Find row that did nothing are gone (the chord still works).
  Last, `7d6ae68` made the shell tests wait until the panel is listening
  (event stream, socket, menu subscription, key listener) before sending it
  anything; under load they had lost that race one run in four, and the
  Alt+N refusal tests could pass without the chord reaching the panel. The
  documentation pass rewrote `docs/LEAD_GENERATION_FLOW.md` §7 (ID handling)
  against the code. What the audit found and left is under "Owed work".
  Verified: lint 0, typecheck 0, build 0, 160 files / 2015 tests with
  integration suites; Release run #37 (build-only, `dev` at `7d6ae68`) green
  on all three OSes.

- **2026-09-22 — `docs/STRUCTURE.md`: the whole software in one file (Claude).**
  Twelve readers mapped every workspace against `git ls-files` (one from a
  graphify code graph: 641 files, 6,152 nodes, 242 communities), one writer
  assembled the file, five fact-checkers raised 81 corrections (80 applied, 1
  rejected with evidence) and 51 gaps (all filled). It replaces
  `docs/CODE_MAP.md`. Five of the audit's defects were fixed with tests the
  same day, and the ones this file then listed in the 2026-09-24/25 round;
  dispatch keying on the stage name (§5.11 #7) is still open, as item 1 of
  the audit list under "Owed work".
- **2026-09-22 — macOS build fixed, library links fixed on every OS
  (Claude).** Vendored PostgreSQL links kept relative (`verbatimSymlinks`);
  the universal Mac build fetches and stages both architectures of every
  native package (`ensureUniversalPackages`, `universalSiblings`) and leaves
  the staged panel out of the lipo (`x64ArchFiles`). All three Release legs
  green; a local Linux build has 0 absolute links and a relocated copy of its
  PostgreSQL loads every library.
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
