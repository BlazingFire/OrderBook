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

It is order management, not billing: money shows only behind the opt-in
company setting `pricing.enabled` (off by default). The AI assistant was
removed for good on 2026-09-11.

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
| Fields, Logs, Recycle Bin, Reports, PDF Designer, i18n design | `docs/BACKEND_MODULES.md` + `docs/backend-modules/` |
| The 2026-08/09 overhaul designs (stages 0–12, all implemented) | `docs/overhaul/` |
| Multi-agent workflow and per-session change log | `docs/AI_COLLABORATION.md` |
| Where every file lives, and where a change goes | `docs/CODE_MAP.md` |
| What to do next, and the decisions waiting on the owner | `docs/NEXT_PHASE.md` |

`docs/overhaul/` and `docs/backend-modules/` are cited from source comments
as design rationale. They were written before the code and several of their
stated facts did not survive contact with the tree — check a design's claim
against the code before acting on it.

## Current state (2026-09-17)

- **Version 1.1.0.** The work of 2026-09-17 is on
  **`claude/hopeful-lovelace-q6f57v`**, pushed and ahead of `main`
  (`git rev-list --count origin/main..origin/claude/hopeful-lovelace-q6f57v`).
  **It has not been merged.** Merge it to `main` — the standing convention that
  work lands on `main` still holds; this branch exists because the session was
  required to use one. `dev` and the older `claude/*` branches are historical
  and behind — do not branch from them.
- **Every stage of the overhaul programme is implemented**, and as of
  2026-09-17 **fourteen of the nineteen open handoff briefs are closed** —
  including all three that were blocking. See "Recent sessions" and
  `docs/ai-handoffs/README.md`.
- **Nine company settings**, in four groups on the Settings tab. Adding one is
  a single entry in `shared/src/domain/settings.ts` plus two i18n tokens — no
  migration, no column, because the table is one row per key and an absent row
  means the declared `fallback`. The dividing line is written at the top of
  that file: *if two people at the same PC should see it differently it is
  localStorage; if it is a decision the company made once, it is a setting
  here.*
- **Verify gate:** `npm run verify` = `lint` + `typecheck` (all workspaces,
  both Electron shells, the test tsconfigs) + `vitest run`. Run the three steps
  separately and check each exit code.
  **Last run 2026-09-17: lint 0, typecheck 0, 87 files / 1041 tests passing,
  43 files / 583 tests skipped.** The skips are the integration suites: they
  need a real PostgreSQL, and PostgreSQL refuses to run as root. That is the
  only reason they skip, on the owner's PC and in a container alike.
  **A skipped suite prints like a passing one — check the count.**
- **The suite was not green before this session, and not for a code reason.**
  Thirteen tests across `updates.test.ts` and `github-releases.test.ts` failed
  on any non-Windows checkout: their fixtures describe Windows releases while
  the code under test defaults to `process.platform`. Two more (UPD-4, UPD-5)
  passed *vacuously* off Windows — the manifest was discarded for the wrong OS
  before the check under test ran. Fixed by pinning the platform where the test
  is not about platform. If you are on Windows you would never have seen this.
- **Builds:** `npm run build` is green for shared, both servers and both web
  bundles — **and now runs on Linux and macOS too**. The Windows esbuild
  failure (`remove …\esbuild-…: Access is denied`, a Defender lock on the
  helper binary) is still fixed by pointing `TEMP`/`TMP` at a project-local
  `.tmp/` (gitignored), but that fix had been written in `cmd` inside an npm
  script, so `npm run build` died with `sh: 1: Syntax error` anywhere but
  Windows. It is `tools/build-web.mjs` now. Two things that script has to get
  right, both learned the hard way: it resolves `tsc`/`vite` from
  `node_modules/.bin` **by path** (a global TypeScript 6 on PATH rejects the
  side-effect CSS imports TS 5.9 accepts), and it uses `process.cwd()`, not
  `INIT_CWD` — under `--workspace` the latter is the repo root.
- **Installers:** `C:\OrderBook-Releases` still holds the 1.0.3 setup files.
  `npm run release` (electron-builder) hangs on the owner's PC. Build inputs
  are refreshed; a release run on a healthy machine (or after a reboot /
  Defender exclusion for the repo) should work. **This is still owed.**
- **Hindi is 1,737 strings behind, and is now reachable.** `hi.ts` is a *total*
  record — the type demands it — but `npm run i18n:sync` fills a missing key
  with the English text and a `// TODO(i18n-hi)` marker, and that backlog has
  grown to 1,737 of them. So a Hindi panel is mostly in English today, and no
  test can see it: the parity check only asserts the key exists. `grep -c
  'TODO(i18n-hi)' shared/src/i18n/hi.ts` is the real number. Every key added on
  2026-09-17 was translated by hand rather than added to the pile.
  **Until 2026-09-17 there was no way to select Hindi at all** — `ob.locale`
  was read on every render and written nowhere in the tree. Settings →
  Appearance has a picker now, and a browser profile that has never chosen
  adopts `ORDERBOOK_DEFAULT_LOCALE` once at boot. That makes the backlog
  visible to anyone who tries it, which it was not before.
- **Live database on the owner's PC:** external PostgreSQL via `.env`
  `DATABASE_URL` (database `order_book`). Catalogue currently holds 0
  products and 3 sample parties (P-0001…P-0003) after the 2026-09-12 wipe;
  `npm run reload:catalog --workspace @orderbook/master` re-imports the
  547-row SWISWARE 2026 CSV from `dummy-data/` (untracked, operator-supplied).

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
`wipe:business` (truncate business tables), `reload:catalog`
(`--with-catalog`), `seed:parties`. They talk to the live database — read
`master/src/services/catalog-reload-cli.ts` before running one.

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

- **Layout:** `docs/CODE_MAP.md` is the map — every workspace and directory,
  what each is for, where a given kind of change goes, and which test guards
  what. Read it before hunting for a file.
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
- **A screen both panels need lives in `ui/` and takes a `transport`**, never a
  panel's api client. `NewLeadScreen`, `DocumentsScreen` and `PartyFormModal`
  all do this, and `ui/tests/no-transport-dep.test.ts` holds the line. The two
  clients genuinely differ — the Office's `createParty` resolves to a
  `QueuedResult` carrying an outbox id, the Master's to a whole `Party` — so a
  shared component that knew either one would have to know which panel it was
  on.
- **Errors reach a screen through `apiErrorText`** (`ui/src/errorText.ts`):
  the specific `messageKey`, failing that the coarse `error.<code>` token,
  failing that English. Rendering `caught.message` shows the server's English
  and throws the key away — which is what every screen did until 2026-09-17.
- **A 401 is announced, not just thrown.** `send()` in both clients publishes
  through `ui/src/sessionEnded.ts`; both shells subscribe and drop to sign-in
  with a reason. Anything that invalidates a session should give that reason a
  key.
- **Company switches** (`pricing.enabled`, `inventory.freeToSell`) ride on
  `SignedInUser.features` (Master) and `SyncSnapshot.features` (panels), built
  by `master/src/services/company-features.ts`. Pricing off strips the four
  `field.*Rate.*` keys from every resolved permission set
  (`master/src/services/pricing-gate.ts`) so the existing masking does the rest.

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
- **No pricing by default, no AI.** Do not reintroduce money on a screen
  outside the `pricing.enabled` gate; do not bring the assistant back.
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
   stock; inventory is per (product, colour). One `line_items` table for
   leads and orders. Text record ids (`LD…`, temporary `A3F9K2…`) with an
   `id_map` so an offline panel can mint before the Master has seen it.
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
12. **Product catalogue model:** brand = `products.brand`, main product =
    `product_categories`, `products.colour_policy` (`fixed` | `selectable`),
    `line_items.category_name` snapshot. Lead entry is the shared
    keyboard-first `ui/src/NewLeadScreen.tsx` on both panels.
13. **Accepted risks, not solved:** the Master's plaintext password vault
    (owner asked for it knowing the cost; keep the guards in
    `docs/overhaul/workstream-F.md`); no TLS on the LAN (an API key is as
    exposed as the session cookie; the public API is off by default).

## Owed work

**Code:** five briefs remain in `docs/ai-handoffs/` — **that README is the
queue and it is current**. Nothing blocking is left. In order:

1. **There is no way to look at a product photo.** `ProductDetail.tsx` has no
   reference to `product.images` at all, so the `large` (800px) and `master`
   (2048px) variants encoded on every upload are never requested by anything.
   For a ceramics catalogue that is the primary use of a photo. The image UI is
   also entirely untranslated (`ProductImages.tsx` imports no `t`).
2. **The New Product form is still 29 fields** — the owner's own complaint. The
   permission defects around it are fixed; the reorganisation is deliberately
   its own commit so a permission fix is not buried in a layout diff.
3. **No route from a party to its access editor** — the owner's "no option for
   assign party". Assigning is reachable only from a separate admin-tier nav
   entry, so somebody looking at a party record cannot get to "who can see this".
4. **Reset password has no self-exclusion**: an administrator resetting their own
   password signs themselves out with no warning. Also
   `invalidateSessionsForUser` records no *reason*, so the sign-in screen says
   "your session ended" rather than naming the password change — the token
   `signIn.notice.passwordChanged` exists and is waiting for it.
5. **The Recycle Bin has no exit, and that needs an owner decision, not code.**
   Nothing is ever deleted for good: tombstoned rows, the sealed password of a
   deleted user, and the image files of a deleted product all accumulate
   forever. Three coherent options are written up in the brief. **Do not
   implement one until the owner picks.**

**Also owed, and not in a brief:** the Hindi catalogue is 1,737 strings behind
(see "Current state"), and nothing can detect it — the parity test only checks
that a key exists, not that it was translated.

**Manual:**

- Responsive gate: 1024×768 / 1366×768 / 1920×1080 / 3840×2160 at 79 % /
  100 % / 157 %, sidebar in all three modes.
- Keep-alive walk: every Master and Office tab keeps filters, scroll, open
  drawers and half-typed forms across a round trip; Escape closes the
  *visible* overlay only.
- One real lead on each panel through the new-lead flow (focus walk,
  Shift+Q, Ctrl+Enter review), CSV import, one printed quotation.
- PDF Designer click-through: every template type, Narrow/Normal/Wide,
  A4/A5/Letter, drag and click-insert each block, preview vs a real lead,
  save/reload/conflict, Office online, rate-blind user.
- A packaged install-then-uninstall on a real machine (scripts dry-run clean;
  the live path is unexercised).
- Rebuild the 1.1.0 installers on a machine where electron-builder runs.

Open questions still unanswered by the owner: extra party fields (credit terms,
multiple contacts — GST is already a field); concurrent edits of one lead from
two panels (last-write-wins is the default); app name/branding; and the Recycle
Bin retention policy above.

## Traps worth knowing

- **A test fixture pinned to `win32` passes only on Windows, or worse, passes
  vacuously everywhere.** `updates.test.ts` and `github-releases.test.ts`
  published Windows manifests and called APIs that default to
  `process.platform`; thirteen tests failed on Linux and two passed *without
  reaching the check they were about*, because the manifest was discarded for
  the wrong OS first. Pin the platform explicitly in a test that is not about
  platform.
- **A guard can pass against the very bug it was written for.** Two written on
  2026-09-17 did: one searched the whole file for `tab === 'addLead'` and was
  satisfied by an unrelated line fifty lines above the defect; the other listed
  a renamed panel in a fixture the repository's own filter would never return.
  Both were rewritten. Break the code, watch it go red, put the code back —
  and check the assertion is reaching the thing it names.
- **An integration suite that skips is not a suite that passed.** PostgreSQL
  will not start as root, so on a root checkout every one of the 42 integration
  files skips and the summary line still reads green. Check the skip count.

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

### 2026-09-17 — Five company settings, a grouped Settings tab, a language picker (Claude)

Same branch, `claude/hopeful-lovelace-q6f57v`, **not yet merged**. The owner's
"add more necessary settings in settings tab / simplify it".

**The five, and what each replaces:**

| Setting | Was |
|---|---|
| `panels.autoPairingEnabled` | auto pairing always available behind the 5-minute window |
| `security.developerModeEnabled` | developer mode reachable by any signed-in person, always |
| `security.sessionHours` | a hardcoded 12 in `config/index.ts` |
| `inventory.defaultReorderLevel` | `reorder_level` NULL on every row a movement creates, so "Low stock" read 0 until somebody typed a number on each line by hand |
| `leads.quietAfterDays` | a 30 the code itself called "a designer's placeholder, not the owner's number" |

Defaults preserve the previous behaviour exactly, so every test turns its
switch *away* from the default — a suite run at the defaults would pass against
a switch wired to nothing.

**Two traps these hit, worth knowing before adding the tenth setting:**

- **A second independent read wins silently.** `signIn` stamped the session from
  the setting while `auth.routes.ts` set the cookie from `config.session.ttlMs`.
  The service returns `sessionTtlMs` now and the route uses it; neither may read
  the number twice.
- **`Number(null)` is 0.** `countLowStock` filtered `whereNotNull('reorder_level')`
  and then compared in JS. With a company default of 0 that reads "no default"
  and "flag anything empty" as the same thing. The filter is gone and the
  comparison is explicit.

**Simplified:** the tab renders from a declared `control` per setting rather
than from `typeof value` — which deleted a dead branch that printed
`JSON.stringify` beside the words "edited elsewhere" — and groups the settings
under four headings. Numbers save on a button, not per keystroke. Save feedback
is per row. The vault hint was replacing the help text instead of sitting under
it. `.ob-tabs` scrolls: at 157% on a 1366px screen the later tabs could not be
reached at all. The Master opens on Company.

**The language picker is the largest thing here and is not a setting.**
`ob.locale` was read at `ui/src/i18n.ts` and written nowhere in the tree, and
both boot endpoints had served `defaultLocale` since the config was written with
no reader — a complete Hindi catalogue nobody could switch to. Appearance has a
picker; a fresh profile adopts `ORDERBOOK_DEFAULT_LOCALE` once, behind the
splash, and never again (it is a default, not something re-imposed at each
boot). `.env.example` documents both locale variables for the first time.

**A security fix alongside:** `createUser` and `resetPassword` hashed whatever
password arrived, with no length check, while `changeOwnPassword` had enforced
eight characters since it was written. The weaker pair was the one that mints
accounts and the one that resets a locked-out person's password. One
`assertPasswordLongEnough` in `master/src/lib/password.ts` now, applied to the
supplied value and never to the generated fallback — checking after the fallback
would enforce nothing, since a generated password always passes.

Also: 15 dead `settings.appearance.*` keys deleted (zero call sites, two
catalogues); the Office's storage card shows the free space its own endpoint had
been serving to nobody; `PANEL_SCOPED` moved to `shared/src/i18n/panel-scoped.ts`
because the call-site guard had grown a second copy of the list.

Verified: lint 0, typecheck 0, build 0, 87 files / 1041 tests. **Thirteen
deliberate breaks, one per new guard, each watched failing.** The integration
suites still have not run, so the fifteen integration tests added here join the
four from the earlier round as written-but-never-executed. Nothing seen in a
browser or Electron.

### 2026-09-17 — Fourteen briefs closed, four privilege holes, the test suite made portable (Claude)

Branch `claude/hopeful-lovelace-q6f57v`, **not yet merged to `main`**. Read `docs/ai-handoffs/README.md` for what is left.

**The three blocking briefs, all closed:**

- **An Office lead raised against a party created on the same panel was
  silently lost.** `route()` in `sync.service.ts` resolved only
  `mutation.entityId` through `id_map`, so `payload.partyId` arrived as the
  temporary id the panel minted; `createLead` threw `validation.lead.
  partyMissing`; `applyOne` recorded that as a **permanent** rejection, so a
  replay returned the same refusal forever while the panel settled it out of
  the outbox with the optimistic overlay. `resolvePayloadIds()` now maps
  `partyId`/`ownerId`/`productId` and `items[].productId` for every mutation
  kind before the switch, so a kind added later cannot forget.
- **The Master had no Parties screen.** `api.createParty` had zero callers
  since the repo restructure, so an administrator at the PC that owns the
  database had to walk to an Office panel. The form moved to
  `ui/src/PartyFormModal.tsx` with an injected transport rather than being
  copied — a copied `PartyAccessScreen` already drifted in four places within a
  day.
- **Nothing tested either web application.** Neither `web` workspace matches
  the vitest glob and neither held a test file. `web-reachability.test.ts` adds
  the two invariants the existing `screen-reachability.test.ts` does not cover,
  and both were watched failing against the unfixed code.

**Four privilege/masking holes:** the socket path downgraded a *refused* acting
token to the panel's own machine authority instead of refusing it (the HTTP
path already refused, and said so in its own comment); `mrp` was documented as
gated in two files and enforced in none; all four image mutations returned the
unmasked product, so a photo upload leaked `purchaseRate` in its 201; and
`parties.export` was enforced on one transport out of two.

**A refused Office write was invisible to whoever wrote it.** The toast was
gated on an admin-tier permission the shop-floor staff whose writes get refused
do not hold, and `lastRejections` was a module variable overwritten on every
flush including empty ones. Refusals are durable now, in their own file beside
the outbox, with a section on the Conflicts screen anyone can read and dismiss.

**Also:** self-service password change (the endpoint shipped audited with no UI
caller); session-loss handling at the one place every request passes through;
sign-in now says how many attempts are left and how long a lockout has to run,
in the reader's own language — `apiErrorText` is the client the three-tier
error pipeline was built for and never had; delete actions for leads, orders
and parties on the Master, so all nine Recycle Bin entity types are finally
reachable; `ConfirmDialog` replacing the last four `window.confirm` calls,
which made `useResetGuard` promise-based; `.ob-popover`/`.ob-menu` given the
CSS they never had; the sticky table header made to stick; column sorting in
`DataTable`; contrast tokens at 3:1 and the amber pill at AA; a guard against a
malformed `panel:report` 500ing the panel admin screen; and a suffix scan so
two panels cannot be minted with the same name.

**Two things worth knowing about the tests.** Thirteen were failing before any
of this, on any non-Windows checkout, for a fixture reason rather than a code
one — and two more passed *vacuously* off Windows. And every guard written this
round was watched failing against the defect it targets; two were rewritten
after they passed against broken code, which is exactly the trap this file's
"guards must be seen to fail" rule exists for.

**New:** `docs/CODE_MAP.md` — the repo's layout, what each directory is for, and
where a given kind of change goes. Linked from `README.md`, `AGENTS.md` and
`opencode.md`.

**Decided, so it stops being re-litigated:** *parties live on both panels, the
product catalogue is Office-only.* `docs/TESTING_PLAN.md` is reconciled against
the screens that actually render — its §5 asked the tester to create products
and upload images on the Master, where no such screen exists or will, which is
how four of the owner's ten QA findings arrived as bug reports for features
nobody had built. Its AI Assistant section is gone; the feature was deleted on
2026-09-11.

**Not verified, and it matters:** every integration suite (42 files, 568 tests)
skipped for this entire session. PostgreSQL will not run as root and the
container had no other user account. The integration tests written this round —
the temporary-id resolution, the image masking, PA-14 and PA-15 — **have never
been executed.** Run them on a normal checkout before trusting them. Nothing
was run in a browser or in Electron either, so every UI change here is
typechecked and unseen.

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
