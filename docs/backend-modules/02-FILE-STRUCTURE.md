# 02 — File structure: the complete manifest

This is the build's map. It names every file the six backend modules create, every existing file they
touch, and the conventions an implementer must follow so that the files land where the rest of the
repo expects them.

It is deliberately mechanical. The *why* of each module lives in `docs/BACKEND_MODULES.md` and in the
sibling documents of this set; the *what and where* lives here, so that two people building two
modules in parallel cannot collide on a path, a filename, a migration timestamp or an exported
identifier. Three of the four original module designs collided on exactly those four things
(`CRITIQUE.md` findings 1, 2, 4 and 5), which is why this document exists as its own artefact rather
than as a section inside each module's spec.

Every path below was checked against the working tree. Where a claim is about code that exists today
it carries a `path:line` reference.

**Scope reminder — this batch is backend only.** No screen files, no `App.tsx` edits, no tab-table
entries. The only frontend files it touches are the two typed API clients, `master/web/src/api.ts`
and `office/web/src/api.ts`. The ten screens (Master and Office × Logs, Reports, Recycle Bin, Fields,
plus Documents and the Office Dashboard) belong to the UI phase in `docs/UI_REDESIGN.md` §8. §2.6
below lists the files that are deliberately *not* in this batch so they are not mistaken for
oversights.

`shared/src/i18n/` **is** in scope, and its deferral-free half is the whole of it: the catalogues,
the key machinery, `t()`/`tCount()`, the activity tokens and the pseudo-locale are all pure modules
under `shared/src/`, fully exercised by `shared/tests/` with no web file present. The web renderer
half (`{master,office}/web/src/i18n/*`, `LocalePicker.tsx`, `Untranslated.tsx`) is deferred; the
translation layer is **not** left unverified by that deferral.

This document is the sole authority for the FILE manifest and the scope boundary. It is **not** the
authority for wire shapes (`04-API-CONTRACT.md`), schema and migration DDL (`03-DATABASE.md`),
permission keys (`08-PERMISSIONS.md`), the test register (`10-TESTING.md` §8) or stage ordering
(`11-BUILD-SEQUENCE.md`). Where those subjects appear below they appear as a one-line summary plus a
cross-reference, never as a second copy.

---

## 1. Conventions an implementer must follow

These are not style preferences. Each one is load-bearing: breaking it produces either a silent
no-op, a compile error across all four packages, or a file that typechecks and is missing at runtime.

### 1.1 Filenames are kebab-case

Every `.ts` file in `shared/src`, `master/src` and `office/src` is lower-case kebab: `access.ts`,
`stock-key.ts`, `panel-actor.service.ts`, `20260304000000_role_tier_ceiling_repair.ts`. There is not
one camelCase or PascalCase `.ts` filename in any of the three server packages today. PascalCase is
reserved for React components under `web/src/` (`PermissionGrid.tsx`) — and this batch creates none.

`forceConsistentCasingInFileNames` is on (`tsconfig.base.json`), so a casing mistake compiles on
Windows and fails on the CI runner.

### 1.2 Layer suffixes say which layer a file belongs to

| Directory | Suffix | Rule |
|---|---|---|
| `master/src/domain/` | none | Pure. No I/O, no framework import, no Knex, no PDFKit. Importable by any layer, imports none. |
| `master/src/repositories/` | `.repository.ts` | The only place Knex types exist. Every write takes a `TransactionContext` from `repositories/transaction.ts`. |
| `master/src/services/` | `.service.ts` | Orchestration. Permission check first, then domain assertions, then repositories. Never imports Knex. |
| `master/src/http/routes/` | `.routes.ts` | Parse and delegate. No aggregation, no business policy. |
| `master/src/lib/` | none | Dependency-free helpers with no domain knowledge (`errors.ts`, `logger.ts`, `env-file.ts`). |
| `master/src/pdf/` | none | **New layer.** Infrastructure adapter, a peer of `realtime/` and `discovery/` — it imports a framework, so it cannot live in `domain/`. |
| `master/src/db/migrations/` | `<timestamp>_<name>.ts` | See §1.5. |
| `shared/src/domain/`, `shared/src/protocol/`, `shared/src/sync/`, `shared/src/i18n/` | none | Types and pure functions only. |

Three files in this batch sit in `lib/` rather than `repositories/` and the reason is worth stating
once: `master/src/lib/csv.ts` and `master/src/lib/document-files.ts` touch no database. The
repository rule is about Knex, not about I/O in general, so disk access for rendered PDFs belongs in
`lib/`, beside `env-file.ts`.

The Office package uses `.service.ts` for orchestration and `.store.ts` / `-store.ts` for its
file-backed persistence (`office/src/services/credentials.store.ts`,
`office/src/services/user-store.ts`). That inconsistency is pre-existing and this batch does not
touch it, because **the Office adds no new source file at all** — see §3.3.

### 1.3 Relative imports carry a `.js` specifier, always

`module` and `moduleResolution` are both `NodeNext` (`tsconfig.base.json`). Every relative import in
a `.ts` file therefore ends in `.js`, naming the *emitted* file:

```ts
import * as rolesAndUsers from './20260303000000_roles_and_users.js';   // migrations/index.ts:21
export * from './domain/entities.js';                                   // shared/src/index.ts:1
```

This applies to new files without exception, including the new nested barrel
`shared/src/i18n/index.ts`.

### 1.4 The shared barrel is one `export *` line per subsystem

`shared/src/index.ts` is eleven lines today, each an `export *` with a `.js` specifier
(`shared/src/index.ts:1-11`). It gains six lines in this batch, in the order the file already uses
(domain, then protocol, then sync — the i18n line goes last, after `sync/`):

```ts
export * from './domain/activity.js';       // Logs
export * from './domain/documents.js';      // PDF Designer
export * from './domain/fields.js';         // Fields
export * from './domain/recycle-bin.js';    // Recycle Bin
export * from './domain/reports.js';        // Reports
export * from './i18n/index.js';            // i18n — a nested barrel, see below
```

Two consequences an implementer must internalise:

- **`export *` makes every exported name global to four packages.** A name declared twice anywhere
  under `shared/src` is a duplicate-identifier error in `shared`, `master`, `office` *and* both web
  bundles. This is precisely how three designs each minting a `CursorPage<T>` would have broken the
  build (`CRITIQUE.md` finding 1). Before adding an exported name, grep `shared/src` for it.
- **`shared/src/i18n/index.ts` is the only nested barrel.** The i18n subsystem is nine files; giving
  it nine lines in the root barrel would bury the eleven that describe the product. It re-exports
  its own modules with explicit `.js` specifiers and the root barrel points at it once.

`shared/` is consumed as **compiled output**, not source (`HANDOFF.md`, "Traps worth knowing").
Nothing under `master/src` or `office/src` can import a new shared type until `npm run build:shared`
has run. The root `prepare` and `pre*` scripts already handle this; do not remove them.

### 1.5 Migrations: the filename *is* the registry name

`master/src/db/migrations/index.ts` is a hand-maintained array, not a directory scan — its header
says so at lines 1-13. Three facts follow:

1. **A migration file that is written but not imported is a silent no-op.** Nothing turns red. With
   five files landing at once this is the single most likely way to lose a day, which is why
   `master/tests/migration-registry.test.ts` (§4.1) is built before the first migration.
2. **The `name` string must equal the filename minus `.ts`** — `migrations/index.ts:31-36` shows the
   pattern. Knex's `knex_migrations` table keys off that string.
3. **`Migration.down` is a required member of the interface** (`migrations/index.ts:27`). Every new
   file exports one even when it is deliberately empty with a justifying comment — the precedent is
   `20260304000000_role_tier_ceiling_repair.ts`.

And the rule that cost this repo a defect once already: **a migration must never import a live shared
constant.** `20260301` imported `allPermissions()` from `@orderbook/shared`, so editing the
catalogue later changed what an already-applied migration had done (`HANDOFF.md`, "Traps worth
knowing"). Every key string, list key and tier in the five new migrations is **inlined and frozen**.

### 1.6 Assets live outside `src/`, because `tsc` does not copy them

`master/assets/fonts/` is a new top-level directory in the master package, a peer of `src/`, `tests/`
and `web/`. Fonts must not live under `src/`: `tsc` copies only TypeScript output into `dist/`, so a
font under `src/` typechecks in development and is **missing at runtime on the shop PC**.

`config.packageRoot` resolves to `master/` in both layouts — it is
`path.resolve(dirname(import.meta.url), '..', '..')` (`master/src/config/index.ts:12`), which is
`master/` from `master/src/config/` and also `master/` from `master/dist/config/`. So
`path.join(config.packageRoot, 'assets', 'fonts')` is correct under `tsx` and under `node dist/`
alike.

### 1.7 Test file naming decides whether a suite can lie to you

`vitest.config.ts:7` includes `['{shared,master,office}/tests/**/*.test.ts']`. A test file anywhere
else — under `tools/`, for instance — never runs. There is no test under `tools/` in this batch for
that reason.

Within those three directories the naming split is binding:

| Pattern | Meaning |
|---|---|
| `*.integration.test.ts` | Drives a real PostgreSQL cluster. Wrapped in `describe.skipIf(!canRunIntegrationTests)`. |
| `*.test.ts` (no `.integration`) | **Pure.** No database, no `skipIf`. Runs on every machine, every time. |

This matters more here than it reads. *"A skipped test suite looks exactly like a passing one"*
(`HANDOFF.md`, "Traps worth knowing") — the Windows Postgres lookup was broken for months and every
integration gate silently did nothing. Thirteen of this batch's twenty new suites are therefore pure,
and they cover the highest-risk logic deliberately: the cursor codec, the date arithmetic, the
Devanagari shaping, the redaction masking, the permission-enforcement sweep, and the migration
registry itself. The suite names, kinds and case counts are `10-TESTING.md` §8's register — this
document counts files, it does not maintain a second list.

---

## 2. New files — the annotated tree

Directories marked **new** do not exist in the working tree today.

### 2.1 `shared/`

```
shared/
├── src/
│   ├── domain/
│   │   ├── activity.ts            Logs wire types. id/sequence are STRING (BIGINT via node-postgres)
│   │   ├── documents.ts           PDF wire types + TEMPLATE_DEFAULTS
│   │   ├── fields.ts              FieldCatalogue descriptor, frozen list_key literals
│   │   ├── recycle-bin.ts         RECYCLE_BIN_ENTITIES, BinEntry, BinBlocker, RESTORE_PERMISSION
│   │   └── reports.ts             Report wire types — every money field OPTIONAL
│   └── i18n/                                                                              ** new **
│       ├── en.ts                  THE source of truth. EN_MESSAGES = {...} as const
│       ├── hi.ts                  Devanagari. Record<MessageKey, string> — TOTAL, not Partial
│       ├── keys.ts                MessageKey, Placeholders<S>, ParamsFor<K>
│       ├── locales.ts             LOCALES / Locale / isLocale / LOCALE_LABELS
│       ├── translate.ts           t(), tCount(), createTranslator(locale). NO number formatting
│       ├── activity.ts            activityMessageKey(entityType, action); ACTIVITY_TOKENS
│       ├── errors.ts              ErrorPayload — one wire shape for HTTP envelope AND socket ack
│       ├── pseudo.ts              dev-only en-XA, pads to 1.4x
│       └── index.ts               nested barrel, explicit .js specifiers
└── tests/                         suite names and kinds per 10-TESTING.md §8
    ├── i18n-coverage.test.ts      PURE — makes the labelToken contract load-bearing
    ├── permissions.test.ts        PURE — a NEW file; shared/tests/ holds only discovery.test.ts
    │                              and sync.test.ts today, so this is not an extension
    └── activity-tokens.lock.json  committed snapshot, read by readFileSync, never imported
```

`shared/tests/` needs no web file to run any of this. That is the point of keeping the i18n engine in
`shared/src/` while the renderer half waits for the UI phase (§2.6).

### 2.2 `master/`

```
master/
├── assets/                                                                                ** new **
│   └── fonts/                                                                             ** new **
│       ├── Inter-Regular.ttf              SIL OFL 1.1, ~310KB
│       ├── Inter-SemiBold.ttf             SIL OFL 1.1, ~310KB
│       ├── IBMPlexMono-Regular.ttf        SIL OFL 1.1, ~130KB
│       ├── NotoSansDevanagari-Regular.ttf SIL OFL 1.1, ~230KB — the hard requirement
│       └── LICENSES.md                    three OFL texts + upstream versions, auditable offline
├── src/
│   ├── domain/
│   │   ├── cursor.ts              THE one opaque base64url codec. All module cursors build on it
│   │   ├── document-model.ts      masked record + template -> pure DocumentModel (the seam)
│   │   ├── document-template.ts   assertTemplateValid, assertDefaultSwap
│   │   ├── document-text.ts       splitByScript(), formatDateForDocument(), formatMinorUnits()
│   │   ├── field-values.ts        normaliseOptionValue (no case-fold), assertCompleteReorder
│   │   ├── i18n-tokens.ts         assertActivityTokenExists — the audited-action invariant
│   │   ├── lead-outcome.ts        classifyLeadOutcome — the "went quiet" rule
│   │   ├── log-cursor.ts          Logs keyset PAYLOAD on top of cursor.ts. Not a second codec
│   │   ├── recycle-bin.ts         PARENT_LINKS, assertParentsLive, suggestRestoredName, bin cursor
│   │   └── report-range.ts        THE date-safety module. Never constructs a Date
│   ├── lib/
│   │   ├── csv.ts                 dependency-free CSV writer, shared by Logs and Reports
│   │   └── document-files.ts      disk I/O for PDFs: temp -> fsync -> rename; sweepOrphanTemporaries
│   ├── pdf/                                                                               ** new **
│   │   ├── fonts.ts               registers the four vendored faces with PDFKit once per process
│   │   ├── primitives.ts          table(), colourChip(), watermark(), runText()
│   │   └── renderer.ts            DocumentModel -> Buffer. No business rule, no permission check
│   ├── repositories/
│   │   ├── dashboard.repository.ts        leadCountsByStage, dispatchedBetween, countRecentMutations
│   │   ├── document-asset.repository.ts   logo/signature metadata (bytes live on disk)
│   │   ├── document-export.repository.ts  export history, keyset on id DESC
│   │   ├── document-template.repository.ts template CRUD, keyset on (lower(name), id)
│   │   ├── field-usage.repository.ts      "In use by" counts — one query per SET, never per value
│   │   ├── recycle-bin.repository.ts      the ONLY cross-table SQL: UNION ALL — six branches at
│   │   │                                  Stage 2, eight after Fields, nine after PDF (§3.3)
│   │   └── report.repository.ts           five raw-SQL GROUP BY functions
│   ├── services/
│   │   ├── document-render.service.ts     the only importer of pdf/
│   │   ├── document.service.ts            template CRUD
│   │   ├── fields.service.ts              every Fields use case
│   │   ├── log.service.ts                 list / facets / verifyChain / export
│   │   ├── recycle-bin.service.ts         list + restore, delegating writes to entity repositories
│   │   └── report.service.ts              three reports + export
│   ├── http/routes/
│   │   ├── document.routes.ts     /api/documents
│   │   ├── fields.routes.ts       /api/fields
│   │   ├── log.routes.ts          /api/logs
│   │   ├── recycle-bin.routes.ts  /api/recycle-bin
│   │   └── report.routes.ts       /api/reports
│   └── db/migrations/
│       ├── 20260305000000_soft_delete_columns.ts
│       ├── 20260306000000_field_values_and_stage_ordering.ts
│       ├── 20260307000000_activity_log_actor_name.ts
│       ├── 20260308000000_document_templates_and_exports.ts
│       └── 20260309000000_new_module_permission_grant.ts
└── tests/                                  suite names and kinds per 10-TESTING.md §8
    ├── cursor.test.ts                      PURE — the one opaque codec, four modules depend on it
    ├── migration-registry.test.ts          PURE — directory vs registry guard
    ├── i18n-tokens.test.ts                 PURE — source-reading, credential-invariants style
    ├── recycle-bin-domain.test.ts          PURE
    ├── field-values-domain.test.ts         PURE
    ├── report-range.test.ts                PURE — first coverage toIsoDate has ever had
    ├── document-fonts.test.ts              PURE — THE Devanagari gate
    ├── document-model.test.ts              PURE — rate columns ABSENT, not zero, not null
    ├── permission-enforcement.test.ts      PURE — source-reading; every key enforces something
    ├── recycle-bin.integration.test.ts
    ├── fields.integration.test.ts
    ├── logs.integration.test.ts
    ├── reports.integration.test.ts
    ├── document-template.integration.test.ts
    ├── document-render.integration.test.ts
    └── migration-grant.integration.test.ts
```

The Master-side Dashboard gates that need a real cluster (`DSH-4`…`DSH-9` — per-figure gating,
`dispatchedThisWeekCount`'s timezone boundary, the converted-lead exclusion) live in
`master/tests/dashboard.integration.test.ts` (§3.9), not on the Office side. `10-TESTING.md` §8 owns
the placement.

Every new router copies `access.routes.ts` — the only existing router that mounts
`requirePermissionMiddleware` — and never `data.routes.ts`, which mounts no permission middleware at
all. All five are mounted in `master/src/http/app.ts` **between** line 40 (`/api/access`) and line 41
(`app.use('/api', dataRoutes)`); below that bare `/api` mount they would be shadowed.

### 2.3 `office/`

**The Office adds no new source file.** All six modules reach it through the existing forwarding
mechanism: one event on `ClientToServerEvents`, one line in the Master hub's `registerCommands()`,
and one `forward(res, '<event>', payload)` route in `office/src/http/app.ts` registered *after* the
positional `app.use('/api', requireUser)` gate at `office/src/http/app.ts:133`. `forward()` already
maps an unreachable Master to 503 `{ error: 'unavailable' }` (`office/src/http/app.ts:438-462`).

Nothing is queued into the outbox — every module fails hard offline. i18n is the sole exception: both
catalogues are compiled into the panel's bundle and it needs nothing from the Master.

```
office/
└── tests/                            suite names and kinds per 10-TESTING.md §8
    ├── module-forwarding.test.ts     PURE — 503 offline, details/messageKey passthrough, nothing
    │                                 queued; the Office half of the Stage 0 ack prerequisite
    ├── snapshot-masking.test.ts      PURE — every SyncSnapshot key is accounted for in
    │                                 forCurrentUser() — masked, replaced, gated or explicit
    │                                 pass-through. There is no such test today, so a newly
    │                                 added collection is a silent leak
    └── dashboard-staleness.test.ts   PURE — the panel renders a correct figure online and an
                                      honestly-labelled stale one offline, with no live Master
```

Three separate files, not one, because they prove three different things and only one needs a real
cluster. `office/tests/snapshot-masking.test.ts` is the guard `BACKEND_MODULES.md` §8.1 requires. It
does **not** close the module-filtering gap — `forCurrentUser()` (`office/src/http/app.ts:395-407`)
still re-masks only `field.saleRate.view` and replaces `permissions`. It stops this batch from
widening it. `office/tests/dashboard-staleness.test.ts` is Office-local (mocked transport, no
cluster) and proves the offline half of the Dashboard contract; the online half, which needs real
data behind real permissions, is `master/tests/dashboard.integration.test.ts` (§3.9).

### 2.4 Web packages

The two typed API clients are the only frontend files in scope. They are edits, not new files, and
appear in the touched manifest (§6) rather than here.

### 2.5 `tools/`

```
tools/                                                                                    ** new **
├── i18n-sync.mjs      appends every MessageKey missing from HI_MESSAGES with the English
│                      text and a // TODO(i18n-hi) marker. Wired as `npm run i18n:sync`
└── eslint-rules/                                                                         ** new **
    ├── no-untranslated-jsx-text.js   flags a JSX text node not wrapped in t() or <Untranslated>
    └── index.js                      flat-config plugin entry point
```

`tools/` does not exist in the repo today. It holds no test file, because `vitest.config.ts:7` would
not discover one there.

**The eslint rule ships registered as `'off'`, not deferred.** The two rule files land in this batch
so the plugin wiring is proven and reviewable; `eslint.config.js` registers the rule scoped to
`['{master,office}/web/src/**/*.tsx']` with severity `'off'`, and it is promoted to `'error'` screen
by screen in the UI phase. `lint` is the first step of `npm run verify` and roughly 4,000 lines of
existing JSX are unswept, so `'error'` today makes `verify` fail before a single test runs. Detail in
`05-EXISTING-CODE-CHANGES.md` §8.1.

### 2.6 Deliberately deferred to the UI phase — do not build these now

**This is the ruling, not an open question.** The batch is backend only. The web i18n files are
deferred to the UI phase; the **only** web files in this batch are `master/web/src/api.ts` and
`office/web/src/api.ts`. `BACKEND_MODULES.md` §4.3 lists the `{master,office}/web/src/i18n/` files
inside the i18n module's tree; that listing is superseded — §3 of the same document, the narrower and
later statement, scopes the batch as backend only, and this manifest is the authority on the scope
boundary. Listed below so they are not mistaken for oversights, and so the UI phase inherits a
written list.

| Deferred file | Why it waits |
|---|---|
| `master/web/src/i18n/{LocaleProvider.tsx,storage.ts,useErrorMessage.ts}` | The renderer half of i18n. There is no screen to host a locale picker yet. |
| `office/web/src/i18n/{LocaleProvider.tsx,storage.ts,useErrorMessage.ts}` | Same. |
| `{master,office}/web/src/components/{LocalePicker.tsx,Untranslated.tsx}` | Same. |
| `master/web/src/screens/DocumentsScreen.tsx` | UI phase (`docs/UI_REDESIGN.md` §8). |
| `office/web/src/screens/{DashboardScreen,DocumentsScreen}.tsx` | UI phase. |
| Master + Office screens for Logs, Reports, Recycle Bin, Fields (8 files) | UI phase. |

Correspondingly deferred *edits*: both `App.tsx` tab tables, both `main.tsx` provider wrappers,
`master/web/src/components/PermissionGrid.tsx`, `master/web/src/screens/AccessScreen.tsx` (deleting
the inline `RecycleBin` at ~line 963), both `format.ts` and both `styles.css`.

`tools/eslint-rules/*` and `eslint.config.js` are **not** on this list: the rule lands now at
severity `'off'` (§2.5), and only its promotion to `'error'` waits for the screens.

**The deferral does not leave i18n unverifiable.** Everything the translation layer is — the
catalogues, the key types, `t()`/`tCount()`, the activity tokens, the pseudo-locale — lives under
`shared/src/i18n/` and is covered end to end by `shared/tests/i18n-coverage.test.ts` and
`master/tests/i18n-tokens.test.ts`, neither of which imports a web file. What waits is the React
plumbing that reads a locale out of `localStorage` and puts a picker on a screen.

---

## 3. Per-module manifests

`Layer` uses the vocabulary of §1.2. `Depends on` names only what is architecturally significant —
every file additionally depends on `@orderbook/shared` types.

Stage numbers below are `11-BUILD-SEQUENCE.md`'s Stage 0–8 — that document owns the ordering and this
one only says which files each stage creates.

### 3.0 Stage 0 — the socket ack must carry `details`

No new source file. ~15 lines across four existing files, built **first**, because two modules depend
on structured conflict data reaching the Office browser. Detail in `05-EXISTING-CODE-CHANGES.md`. Its
one new test-directory file is `office/tests/module-forwarding.test.ts` (`10-TESTING.md` `PRE-8`),
which drives the real `forward()` with `masterConnection` mocked.

### 3.1 Stage 1 — cross-module foundation

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `master/src/domain/cursor.ts` | domain (pure) | The single opaque base64url cursor codec. BIGINT keys stay STRINGS — `Number()` loses precision on what node-postgres returns as text. Throws `ValidationError` on a malformed token rather than falling back to "newest", because a silently ignored cursor makes the Older button loop forever on page one. | `encodeCursor`, `decodeCursor`, `clampCursorLimit` | `lib/errors.ts`; mirrors the clamps in `domain/paging.ts` |
| `master/tests/cursor.test.ts` | test (PURE) | Round-trip, tamper rejection and BIGINT precision for the one codec four modules build on. Gates in `10-TESTING.md` §6.1. | — | `domain/cursor.ts` |
| `master/tests/migration-registry.test.ts` | test (PURE) | Reads `master/src/db/migrations/` and asserts every `*.ts` file except `index.ts` appears in the `migrations` array with `name` equal to its filename minus `.ts`, and that the array is in ascending timestamp order. | — | reads source, `credential-invariants.test.ts` style |

**`recordActivity` changes shape here, in Stage 1 — not at the Logs stage.** The signature becomes
`recordActivity(entry, actor, trx)` before Recycle Bin or Fields writes its first call site, so both
are written once against the final form instead of being swept later. The `actor` argument is
harmless before `activity_log.actor_name` exists: it is simply not persisted until `20260307`
(Stage 4) adds the column and starts writing it. `recordDetachedActivity` stays untouched and remains
forbidden in new modules. See §6.2 item 21 and `05-EXISTING-CODE-CHANGES.md`.

The matching shared type is minted once in `shared/src/domain/inputs.ts` beside the existing
offset-based `Paginated<T>` at `inputs.ts:268`:

```ts
export interface CursorQuery { cursor?: string; direction?: 'older' | 'newer'; limit?: number }
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;   // null for one-directional feeds
  limit: number;
}
```

`Paginated<T>` stays. It is offset-based and still correct for the existing list endpoints; the new
type is a sibling, not a replacement. There are no page numbers anywhere in the new surface.

### 3.2 Stage 1 — i18n / translation layer

Built with the foundation, because `AppError`'s constructor signature is a dependency of every other
module. Entirely under `shared/src/i18n/` and `master/src/domain/` — no web file, and none needed to
test it (§2.6).

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `shared/src/i18n/en.ts` | shared (pure) | The source of truth. One flat object, dotted keys, NAMED `{placeholders}`, never concatenation. `as const` so every value keeps its literal type. Namespaces: `permission.*`, `module.*`, `action.*`, `capabilityGroup.*`, `roleTemplate.*`, `error.*`, `validation.*`, `activity.*`, `common.*`. | `EN_MESSAGES` | none |
| `shared/src/i18n/hi.ts` | shared (pure) | Devanagari, typed `Record<MessageKey, string>` — **total, not partial**, so adding an English key turns the build red until Hindi exists. | `HI_MESSAGES` | `keys.ts` |
| `shared/src/i18n/keys.ts` | shared (pure) | The type machinery that makes a missing or misspelt key a compile error. `Placeholders<S>` is a recursive template-literal type; `ParamsFor<K>` resolves to `[]` for a no-placeholder message. | `MessageKey`, `MessageParams`, `Placeholders`, `ParamsFor` | `en.ts` |
| `shared/src/i18n/locales.ts` | shared (pure) | `LOCALES`/`Locale`/`isLocale` in the house `as const` + guard style; `LOCALE_LABELS` names each language in its **own** script and is deliberately not translatable. | `LOCALES`, `Locale`, `isLocale`, `LOCALE_LABELS` | none |
| `shared/src/i18n/translate.ts` | shared (pure) | `t()` substitutes named placeholders with `String(value)` and applies **no** number formatting — the rule that numbers, IDs and fingerprints are never localised is enforced by `t()` simply not having the capability. `tCount()` uses `Intl.PluralRules` to pick a `.one`/`.other` sub-key so a count never concatenates. A missing key returns a readable fallback and never throws or renders blank. | `t`, `tCount`, `createTranslator`, `Translator` | `keys.ts`, `en.ts`, `hi.ts` |
| `shared/src/i18n/activity.ts` | shared (pure) | The contract the Logs module renders against. Returns `activity.<entityType>.<action>` when the catalogue holds it, otherwise `null` so the caller renders the raw pair honestly. `ACTIVITY_TOKENS` is frozen and **append-only**, mirroring the table: `activity_log` refuses UPDATE and DELETE by trigger, so a retired token would orphan permanent rows. | `activityMessageKey`, `ACTIVITY_TOKENS` | `keys.ts` |
| `shared/src/i18n/errors.ts` | shared (pure) | One wire shape for the HTTP envelope **and** the socket ack, so the two cannot drift again. | `ErrorPayload`, `errorMessageKey` | `keys.ts` |
| `shared/src/i18n/pseudo.ts` | shared (pure) | Dev-only `en-XA`: pads every string to 1.4x and brackets it, making the design spec's "survive 1.4x expansion" testable rather than aspirational. Excluded from production bundles by a build-time guard. | `PSEUDO_MESSAGES`, `pseudoLocalise` | `en.ts` |
| `shared/src/i18n/index.ts` | shared (barrel) | Re-exports the eight modules above with explicit `.js` specifiers. | — | all of the above |
| `master/src/domain/i18n-tokens.ts` | domain (pure) | Holds the invariant that every `(entityType, action)` pair any service writes to `activity_log` has a catalogue token. In `domain/` per decision 12, not inline in a service. | `assertActivityTokenExists` | `@orderbook/shared` i18n |
| `tools/i18n-sync.mjs` | tool | Keeps `hi.ts` a total `Record` without making mid-development builds unworkable: appends missing keys with the English text and a `// TODO(i18n-hi)` marker. | — | reads `en.ts`/`hi.ts` |
| `tools/eslint-rules/no-untranslated-jsx-text.js` | tool | Flags a JSX text node not wrapped in `t()` or `<Untranslated>`. Registered at severity **`'off'`** in this batch and promoted to `'error'` in the UI phase — `lint` is the first step of `verify` and ~4,000 JSX lines are unswept (`05-EXISTING-CODE-CHANGES.md` §8.1). | the rule object | none |
| `tools/eslint-rules/index.js` | tool | Flat-config plugin entry point, so `eslint.config.js` registers one plugin rather than a path. | plugin | the rule file |
| `shared/tests/i18n.test.ts` | test (PURE) | The **renderer** suite — `t()`/`tCount()` themselves, not the catalogue: named-placeholder substitution, `Intl.PluralRules` plural selection, the readable missing-key fallback, and that a record id or a hash passed as a param survives untouched (never reformatted, never localised). | — | `translate.ts` |
| `shared/tests/i18n-coverage.test.ts` | test (PURE) | The **catalogue-contract** suite, and the gate that makes the existing `labelToken` contract load-bearing rather than decorative: every `PERMISSIONS` key has a `permission.<key>` token; every module, action, capability group and role template has its token; HI covers every EN key **with an identical placeholder set per key** (the translator-dropped-a-`{name}` case the compiler cannot catch); no EN string carries a pre-formatted number or a `₹`. Two files, not one — the renderer and the catalogue fail for different reasons and a broken renderer should not hide a missing key. | — | catalogue + i18n |
| `shared/tests/activity-tokens.lock.json` | fixture | Committed snapshot of the `activity.*` surface, read by `readFileSync` and never imported — so it cannot be caught by the "tsc does not copy JSON" trap. Removing a token fails the test; adding one requires updating the lockfile deliberately. | — | — |
| `master/tests/i18n-tokens.test.ts` | test (PURE) | Source-reading invariant in the established `credential-invariants.test.ts` style: scans `master/src/services/*.ts` for `recordActivity` call sites, extracts every literal `entityType`/`action` pair, and asserts each has a catalogue token. This is what stops the sibling modules shipping audited actions that render blank. | — | reads source |

### 3.3 Stage 2 — Recycle Bin

**`RECYCLE_BIN_ENTITIES` grows across stages; it does not ship frozen at nine.** Stage 2 ships
**six** — `lead`, `order`, `party`, `product`, `role`, `user`. Stage 3 (Fields) adds
`option_list_item` and `custom_field_definition`. Stage 6 (PDF Designer) adds `document_template`.
Nine at the end. Each addition is one tuple entry, one `RESTORE_PERMISSION` entry, one `UNION ALL`
arm and a normal `shared` rebuild — no route change. The entity literal is `custom_field_definition`,
never `custom_field`. `04-API-CONTRACT.md` §4.1 owns the tuple and the map.

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `shared/src/domain/recycle-bin.ts` | shared (pure) | The Bin's wire vocabulary, shared because both panels render it and the Master filters by it. `RESTORE_PERMISSION` maps each entity to the **existing** delete key that governs restoring it — party→`parties.delete`, product→`products.delete`, lead→`leads.delete`, order→`orders.delete`, role→`roles.delete`, user→`users.manage`, then (Stage 3) option_list_item→`fields.manage`, custom_field_definition→`fields.manage`, then (Stage 6) document_template→`documents.delete`. No restore permission is minted, so restore can never be a back door onto an entity you may not delete. Shapes per `04-API-CONTRACT.md` §4.1. | `RECYCLE_BIN_ENTITIES`, `RecycleBinEntityType`, `isRecycleBinEntityType`, `BinEntry`, `BinBlocker`, `BinCounts`, `RESTORE_PERMISSION` | permission keys |
| `master/src/domain/recycle-bin.ts` | domain (pure) | Every Bin invariant. `PARENT_LINKS` declares the upward-only restore graph (lead→party, order→party, order→lead, user→role) as the single statement of the referential hazard. `assertParentsLive` throws `ConflictError` with `{ blockedBy: BinBlocker[] }`. `suggestRestoredName` is deterministic so the UI's offer and the server's acceptance cannot disagree. The composite cursor `deletedAt|entityType|id` carries the timestamp half as the SQL-rendered text it arrived as, never re-formatted through a JS `Date`. | `PARENT_LINKS`, `assertParentsLive`, `suggestRestoredName`, `encodeBinCursor`, `decodeBinCursor`, `visibleBinScopes` | `domain/cursor.ts`, `lib/errors.ts` |
| `master/src/repositories/recycle-bin.repository.ts` | repository | The only cross-table SQL in the module: a `UNION ALL` over the soft-deletable tables — **six branches when it ships at Stage 2**, eight once Fields lands, nine once the PDF Designer does — each branch projecting into a common envelope and carrying its own `ORDER BY` and `LIMIT` so Postgres can Append index scans rather than sort whole tables. Branches the caller may not see are omitted from the SQL entirely — that is the permission filter, the type filter *and* the optimisation. `deleted_by` display names resolve in one follow-up query over the page's distinct ids, not one LEFT JOIN per branch. A gate asserting an eight- or nine-branch UNION belongs to the stage where that many branches exist. | `listBinEntries`, `binCounts` | `transaction.ts`, `mappers.ts` |
| `master/src/services/recycle-bin.service.ts` | service | `list` checks `recycleBin.view`, intersects requested types with the delete keys the actor holds, then narrows to `deleted_by = actor.userId` unless the actor holds `recycleBin.viewAll`. An empty intersection returns an empty page, not a 403 — the "filter, do not refuse" pattern from `search.service.ts`. `restore` checks `RESTORE_PERMISSION[entityType]`, runs `assertParentsLive`, resolves the name collision, then row-update + rename + `recordActivity` in **one** transaction, publishing after commit. Delegates writes to each entity's own repository, so the Bin owns no table. | `listBin`, `binCounts`, `restoreEntity` | Bin domain + repository, entity repositories, `activity-log.repository.ts` |
| `master/src/http/routes/recycle-bin.routes.ts` | routes | `/api/recycle-bin`. Copies `access.routes.ts`: `.use(requireAuth)`, a local `const needs = requirePermissionMiddleware`, one `needs(...)` per handler, `actorFromRequest(req)` for identity. | `recycleBinRoutes` | service, `require-auth.ts` |
| `master/src/db/migrations/20260305000000_soft_delete_columns.ts` | migration | Adds `deleted_at`/`deleted_by` to `leads`, `orders`, `parties`, `products`; adds the partial Bin index `(tenant_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL` to the **six** tables the Bin can list at this stage — `leads`, `orders`, `parties`, `products`, `roles`, `users` (roles and users have none today). The remaining Bin indexes follow their entities: two in `20260306` (`option_lists`, `custom_field_definitions`) and one in `20260308` (`document_templates`). Also converts the party/product code uniqueness to partial indexes so a soft-deleted party cannot reserve its code forever. **`down()` is deliberately empty with a justifying comment**, following the `20260304` precedent — dropping `deleted_at` would resurrect every soft-deleted row. DDL per `03-DATABASE.md`. | `up`, `down` | none — all literals inlined |
| `master/tests/recycle-bin-domain.test.ts` | test (PURE) | Cursor round-trip at microsecond precision, `suggestRestoredName` determinism, `PARENT_LINKS` completeness, `visibleBinScopes`. DB-free deliberately: the cursor is the one piece a silent skip would hide. | — | Bin domain |
| `master/tests/recycle-bin.integration.test.ts` | test | The cursor under real data, the parent hazard, the name collision, the ownership scope, and that a soft delete stamps `hlc` and `field_hlc.deleted_at`. | — | `helpers/db.ts` |

**`PARENT_LINKS` is the RESTORE graph, and only that.** It is upward-only (lead→party, order→party,
order→lead, user→role) and answers "may this row come back". The separate question — "may this row be
deleted at all" — is the four DELETE routes' per-entity 409 policy, which lives in
`04-API-CONTRACT.md` and `06-WORKFLOWS.md`. The two are different rules over different directions and
neither file may implement the other's.

Two DDL corrections carried from `CRITIQUE.md` finding 9 that the migration must honour: the
party/product code uniqueness is enforced by unique **indexes**, not table constraints
(`20260301000000_tenancy_access_and_sync.ts:144-150`), so the DDL is `DROP INDEX
idx_parties_code_tenant` then `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL` — `ALTER TABLE …
DROP CONSTRAINT` fails.

And the sync rule, because it is a file-level obligation on four repositories: **soft-deleting a
syncable entity stamps `hlc` and `field_hlc.deleted_at`**, not just `version`. Mirroring
`softDeleteRole` exactly would bump `version` without advancing `hlc`, leaving a state the merge
engine cannot interpret. No delete/restore `MutationKind`s are added — deletes are Master-online-only
and propagation uses the existing `publishChange`/`ChangedEntity` path with a new `'restored'`
`ChangeAction`.

### 3.4 Stage 3 — Fields

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `shared/src/domain/fields.ts` | shared (pure) | The Fields catalogue, modelled on `buildPermissionCatalogue()`: the screen renders from a served descriptor rather than a hard-coded list, which is the drift the permission-catalogue restructure exists to prevent. Declares the four `option_lists` list keys as frozen literals — `FIELD_LIST_KEYS = ['lead.sourcePlatform', 'stock.colour', 'product.productType', 'line.packaging']`, of which only `stock.colour` carries a hex — plus which entities reference each, as `labelToken`s only. Pipeline stages appear as a fifth set flagged `storage: 'pipeline_stages'`, because they do not share a code path with the four string sets. | `FIELD_LIST_KEYS`, `FieldCatalogue`, `FieldSetDescriptor` | `MessageKey` |
| `master/src/domain/field-values.ts` | domain (pure) | `normaliseOptionValue` trims and **deliberately does not case-fold** — a colour's identity is its exact string inside `stockKey()` and two case-sensitive unique indexes, so folding would split or merge live stock rows. `assertOptionValueChange(previous, next, isValid)` validates only when the value **changes**, so a record resubmitting a value it already holds is never rejected because the value was since removed. `assertCompleteReorder` rejects anything that is not a permutation of the set's current live ids — a full permutation is idempotent and detects staleness; a delta silently corrupts order when two people drag at once. | `normaliseOptionValue`, `assertHexColour`, `assertOptionValueChange`, `assertCompleteReorder`, `resequence` | `lib/errors.ts` |
| `master/src/repositories/field-usage.repository.ts` | repository | The "In use by" counts: one query per **set** (a UNION ALL of grouped subqueries), never one per value, so a 40-value colour list costs one round trip. Joins `line_items` for the tenant filter because `line_item_quantities` has no `tenant_id` of its own. `REFERENCING_COLUMNS` is the one hand-written map in the module, carrying the comment explaining that it cannot be derived from `information_schema` the way `userReferences()` derives FK columns — these sets are referenced by name string with no foreign keys, and `products.color` is US-spelled. | `usageForListKey`, `usageForStages` | `transaction.ts` |
| `master/src/services/fields.service.ts` | service | Every Fields use case: `catalogue`, `listValues`, `usage`, `create/update/removeValue`, `reorderValues`, the same four for custom-field definitions, and `listStages`/`updateStage`/`reorderStages`/`archiveStage`/`restoreStage`. Reads open with `fields.view`, writes with `fields.manage` — the first enforcement sites either key has ever had. Updating a value or a definition takes a **mandatory** `expectedVersion` through `assertVersionMatches` (`master/src/domain/access.ts:183-192`), refusing a stale save with 409 and `storedVersion`. Every write is one transaction containing the row change **and** `recordActivity`, then cache invalidation, then `publishChange` using the already-declared `ChangedEntity` values `'option_list' | 'custom_field' | 'pipeline'` that nothing has ever emitted (`shared/src/protocol/socket.ts:173-175`). Also exports an **unguarded** read pair for the existing catalogue endpoints. | `fieldsCatalogue`, `listValues`, `fieldUsage`, value/definition/stage writers, `listPipelinesUnguarded`, `listOptionListsUnguarded` | field domain, `custom-field.repository.ts`, `pipeline.repository.ts`, `field-usage.repository.ts` |
| `master/src/http/routes/fields.routes.ts` | routes | `/api/fields`. Same `access.routes.ts` shape. A **separate** surface from the three existing unguarded reads. | `fieldsRoutes` | service |
| `master/src/db/migrations/20260306000000_field_values_and_stage_ordering.ts` | migration | Timestamps and soft-delete columns for `option_lists` (which has none today, so "when was this colour added" is currently unanswerable) and `custom_field_definitions`; the two remaining partial Bin indexes on those two tables; `version INTEGER NOT NULL DEFAULT 1` on both, which is what makes `expectedVersion` mandatory on the two Fields `PUT`s; `option_lists.hex`; `pipeline_stages.is_archived`; drops `idx_pipeline_stages_seq` and re-adds it as a **DEFERRABLE table constraint** (a unique *index* cannot be deferrable, only a constraint can, and the reorder needs deferral); seeds **all four** `FIELD_LIST_KEYS` from `SELECT DISTINCT` preserving exact case. Every list key literal inlined and frozen. **`down()` is deliberately empty with a justifying comment**, per the `20260304`/`20260305` precedent. DDL per `03-DATABASE.md`. | `up`, `down` | none |
| `master/tests/field-values-domain.test.ts` | test (PURE) | The no-case-fold rule, `assertOptionValueChange`'s only-on-change behaviour, `assertCompleteReorder` rejecting a non-permutation, hex normalisation. | — | field domain |
| `master/tests/fields.integration.test.ts` | test | Reorder under the deferrable constraint, default-stage swap under the partial unique index, removal not touching the records that used the value, usage counts, the `fields.view` / `fields.manage` enforcement, and the concurrency gate: a stale `expectedVersion` is refused 409 with `storedVersion`. Register in `10-TESTING.md` §6.4. | — | `helpers/db.ts` |

Two locked decisions this module must not drift from. **`fields.manage` moves `admin` → `management`**:
Fields *reading* is ungated (`fields.view`, no `MINIMUM_TIER` entry), Fields *editing* is
management-and-above. Lowering a ceiling never strips a stored key, so no tier-repair migration is
needed. And **`stock_movements` is dropped from the usage count** — it is the append-only ledger,
projected into the millions, with no index leading on `colour`; the other three sources answer "is
this colour in use" adequately.

The existing reads — `GET /api/pipelines`, `/api/option-lists` — stay
gated by `requireAuth` only. Routing them through a `fields.view` check would make `buildSnapshot`'s
`Promise.all` reject for anyone lacking the key, and a rejected `buildSnapshot` produces **no
snapshot at all**, swallowed into a log line.

### 3.5 Stage 4 — Logs

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `shared/src/domain/activity.ts` | shared (pure) | Read-side wire types, the counterpart to the Master-internal `ActivityEntry` which stays a write-side type in the repository. `ActivityActor` is a structured `{type,id,name}`, never a pre-rendered label — the client owns the wording. `id` and `sequence` are declared `string`, not `number`: node-postgres returns BIGINT as a string and a cursor built with `Number()` loses precision. `ActivityLogEntry` carries `hash: string | null` — the Logs screen's Entry-hash column is the only thing that makes "hash-chained" visible to a person, and it is covered by `logs.view` like the rest of the row. Field-by-field shape in `04-API-CONTRACT.md`. | `ActivityLogEntry`, `ActivityActor`, `ActivityLogQuery`, `ActivityLogFacets`, `ChainVerification`, `ChainBreak` | `CursorPage` |
| `master/src/domain/log-cursor.ts` | domain (pure) | The Logs keyset **payload** on top of `domain/cursor.ts` — not a second codec. Encodes `v1|<id>` with the id kept a STRING end to end. Also `LOG_PAGING` and `clampLogPage`. | `encodeLogCursor`, `decodeLogCursor`, `LOG_PAGING`, `clampLogPage` | `domain/cursor.ts` |
| `master/src/services/log.service.ts` | service | `listLogs`, `listLogFacets`, `verifyLogChain`, `exportLogs`. House body order: permission, then validate, then repository, then map. Nothing is masked — a log row carries no money. `verifyLogChain` is the only one that writes: an audit entry recording that a verification ran. The service names are these four exactly; the repository functions they call are named differently and are listed in §6.2 item 21. | `listLogs`, `listLogFacets`, `verifyLogChain`, `exportLogs` | `activity-log.repository.ts` (`listEntries`, `listFacets`, `verifyChain`, `chainBounds`, `streamForExport`), `log-cursor.ts`, `lib/csv.ts` |
| `master/src/http/routes/log.routes.ts` | routes | `/api/logs`. A **new** file rather than routes added to `access.routes.ts`, because `master/tests/credential-invariants.test.ts:73-89` asserts a guard-count-to-handler-count identity in that file with exactly two exemptions. | `logRoutes` | service |
| `master/src/lib/csv.ts` | lib | Dependency-free CSV writer for both export paths. CRLF endings; quotes any field containing comma/quote/CR/LF; prefixes an apostrophe to any field starting with `= + - @` (formula injection — this is a shop PC where the file opens in Excel). A redacted money column is written as an **empty** cell, never `0`. | `toCsv`, `csvCell` | none |
| `master/src/db/migrations/20260307000000_activity_log_actor_name.ts` | migration | Adds `activity_log.actor_name TEXT` and back-fills it, dropping and re-creating the `activity_log_no_update` trigger around the backfill (the table refuses UPDATE by trigger, `20260303000000_roles_and_users.ts:305-318`). Safe because `actor_name` sits **outside** the hash input, which covers `prev_hash|sequence|entity_type|entity_id|action|actor_type|actor_id|details`. Extracts the trigger's inline digest into an IMMUTABLE `activity_log_row_hash(...)` so the trigger and the verifier cannot drift — byte-identical, so no existing hash changes. Adds `(tenant_id, created_at DESC)` and the pager/facet/verifier indexes, **plus the Reports range indexes** (Reports has no migration of its own). | `up`, `down` | none |
| `master/tests/logs.integration.test.ts` | test | Keyset pagination both directions, filters, facets, actor-name survival after the user is soft-deleted, and chain verification including a deliberately tampered row and a pre-chain row. | — | `helpers/db.ts` |

**Chain verification runs in SQL.** The digest covers `details::text` — Postgres's own JSONB
rendering — so Node cannot reproduce the bytes. The `SET LOCAL statement_timeout`, the read-only
transaction and the ordered walk all live inside `activityLogRepo.verifyChain(...)`; the service
clamps the window and checks the permission (`CRITIQUE.md` finding 17).

`activity-log.repository.ts` is **extended, not replaced** — see §6. Two of its additions are easy to
conflate and are not the same function: **`chainBounds`** returns the first and last sequence and hash
in a window so the verifier knows what it is walking, while **`streamForExport`** is the export
reader that feeds `lib/csv.ts`. Both exist; neither substitutes for the other.

`20260307`'s `down()` is real — it drops `actor_name`, the new indexes and
`activity_log_row_hash()`, restoring the inline trigger digest. Unlike `20260305`/`20260306` it
resurrects nothing, so there is no reason to leave it empty (`03-DATABASE.md`).

### 3.6 Stage 5 — Reports

No migration of its own; its indexes fold into `20260307000000`.

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `shared/src/domain/reports.ts` | shared (pure) | Wire types for the three reports. Every money field is declared **optional** (`totalValue?: number`), exactly as `Order.totalAmount` already is, because redaction *deletes* the key rather than nulling it. `ReportRange` carries the resolved `{fromDate, toDateExclusive, timeZone}` back to the client, so a printed report states which day boundary produced it. | `DispatchReport`, `LeadOutcomeReport`, `TopPartiesReport`, `ReportRange`, `ReportPeriod` | none |
| `master/src/domain/report-range.ts` | domain (pure) | **The date-safety module.** Resolves a `ReportPeriod` into calendar date STRINGS, half-open `[from, to)`. Takes `today` as `{year, month, day}` components — it reads no clock and never constructs a `Date` or calls `toISOString()`. Also mints the complete ordered month-label list so the service can zero-fill months with no data; a chart with missing months lies about the shape of the year. | `resolveReportRange`, `monthLabels`, `ReportPeriod` | none |
| `master/src/domain/lead-outcome.ts` | domain (pure) | The "went quiet" rule as a pure classifier, so Reports and any future stale-leads view cannot disagree about it. Takes the four facts the repository can supply plus `asOf` and returns exactly one of converted / lost / quiet / open. | `classifyLeadOutcome`, `QUIET_AFTER_DAYS` | none |
| `master/src/repositories/report.repository.ts` | repository | All report SQL: five raw `GROUP BY` functions returning plain row shapes. **Top-parties anchors on `orders.dispatched_at`**, not `created_at` — the report is "dispatched value in the selected period", goods that left rather than business won — so its range predicate is served by `idx_orders_dispatched (tenant_id, dispatched_at) WHERE dispatched_at IS NOT NULL AND deleted_at IS NULL`, which `20260307` creates. `idx_orders_party` does **not** serve it — its second column is the grouping key, not the filtered one — and it is neither changed nor replaced (`03-DATABASE.md` §8.2). Follows `search.repository.ts` exactly — `runner.raw<{rows:T[]}>` with positional bindings, `tenant_id = ?` first. Month buckets are computed **in SQL** against the configured timezone and returned as `'YYYY-MM'` TEXT. Its header writes out the `AT TIME ZONE` direction asymmetry in full, because that is the trap. | `dispatchesByMonth`, `dispatchesByColour`, `leadOutcomesByMonth`, `topPartiesByValue`, `topPartiesByCity` | `transaction.ts` |
| `master/src/services/report.service.ts` | service | Per report: `requirePermission(actor, 'reports.view')`, resolve the range from local date components, call the repository, zero-fill the month list, then redact money with `maskFields` from `@orderbook/shared`. Computes the totals row itself from the SQL totals query and masks that too — a client must never sum masked buckets. | `dispatchReport`, `leadOutcomeReport`, `topPartiesReport`, `exportReport` | `report.repository.ts`, `report-range.ts`, `lead-outcome.ts`, `lib/csv.ts` |
| `master/src/http/routes/report.routes.ts` | routes | `/api/reports`. Same shape as `log.routes.ts`. The export handler sets `text/csv` + `Content-Disposition` and streams the string the service produced — no library, nothing fetched. | `reportRoutes` | service |
| `master/tests/report-range.test.ts` | test (PURE) | Pins `resolveReportRange`, `monthLabels`, and — for the first time in this repo — `toIsoDate` (`master/src/repositories/mappers.ts:79-90`), which has zero test references today despite being the fix for the shipped IST defect. | — | `report-range.ts`, `mappers.ts` |
| `master/tests/reports.integration.test.ts` | test | The three reports with timezone boundaries as first-class cases: an order dispatched at 23:30 IST on the last of the month belongs to that month, not the next. | — | `helpers/db.ts` |

`reports.view` and `reports.export` **already exist** in the catalogue with no `MINIMUM_TIER` entry,
so they already default to `office` tier and are already available to every user. This module is
their first enforcement site anywhere in the codebase.

Redaction rule, restated because it is easy to get wrong at the SQL boundary: a user without
`field.saleRate.view` gets money columns **absent**, not zeroed and not null. `maskFields()` already
deletes.

### 3.7 Stage 6 — PDF Designer

The largest module, and the one previously deferred on purpose (`docs/LEAD_GENERATION_FLOW.md` §11).

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `shared/src/domain/documents.ts` | shared (pure) | Wire types for the whole module plus `TEMPLATE_DEFAULTS` — the value the designer prefills with and the in-memory fallback used when a tenant has no template. Deliberately a constant, not a seeded row, for the same reason `ROLE_TEMPLATES` are templates rather than seeded roles. Member lists are `04-API-CONTRACT.md`'s and must match the CHECKs in `03-DATABASE.md`: `DocumentType` has **three** members (no `'invoice'`), `PaperSize` is `'A4' | 'A5' | 'Letter'`. `DocumentLayout` carries **only** block order and per-block options — the eight visibility toggles are typed BOOLEAN columns on `document_templates`, not JSONB. | `DocumentType`, `PaperSize`, `PageOrientation`, `DocumentBlockKind`, `DocumentBlock`, `DocumentLayout`, `DocumentTemplate`, `DocumentAsset`, `DocumentExport`, `DocumentRenderResult`, `TEMPLATE_DEFAULTS` | none |
| `master/src/domain/document-template.ts` | domain (pure) | Template invariants: name non-empty; paper size and orientation known; margins 5–50mm with top+bottom leaving >100mm of body; `accentColour` matches `#RRGGBB` (the `pipeline_stages.colour` convention); watermark text required when the watermark is on. It also owns the `layout` **block grammar**: every `kind` at most once, `lines` mandatory, `header` first if present, `signature` last if present, `terms.text` at most 500 characters — a violation is a 400 carrying `{ field: 'layout', block: n, reason }`. `assertDefaultSwap` enforces that promoting a template names the one being demoted, so the partial unique index cannot be hit mid-statement. | `assertTemplateValid`, `assertDefaultSwap` | `lib/errors.ts` |
| `master/src/domain/document-model.ts` | domain (pure) | **The architectural seam.** An already-masked Lead or Order plus a template plus the `MasterIdentity` becomes a pure `DocumentModel`. This is where rate redaction becomes a *layout* fact: when `ratesIncluded` is false the rate and line-total **columns are omitted from `model.columns`** and the totals block is omitted entirely, rather than rendered as 0. No PDF library in scope. | `buildDocumentModel`, `DocumentModel` | `document-text.ts` |
| `master/src/domain/document-text.ts` | domain (pure) | `splitByScript(text)` tags runs `'body' \| 'devanagari' \| 'mono'` by codepoint range so a mixed line can switch face mid-line — PDFKit binds one font per `text()` call, so the split must happen before the ink. `formatDateForDocument` takes an ISO date STRING and formats from its components with no `Date` arithmetic, which structurally cannot reproduce the IST defect. | `splitByScript`, `ScriptRun`, `formatDateForDocument`, `formatMinorUnits` | none |
| `master/src/repositories/document-template.repository.ts` | repository | The only SQL for `document_templates`. Keyset-paginated on `(lower(name), id)`; `findTemplateById` takes `{ includeDeleted }` in the `findRoleById` position; `defaultTemplateFor` is the render path's lookup. Every write takes a required `TransactionContext`; every read leads with `tenant_id`. | `listTemplates`, `findTemplateById`, `defaultTemplateFor`, `clearDefaultFor`, `insertTemplate`, `updateTemplate`, `softDeleteTemplate`, `restoreTemplate` | `transaction.ts`, `domain/cursor.ts` |
| `master/src/repositories/document-export.repository.ts` | repository | The only SQL for `document_exports`. Keyset on `id DESC` (BIGSERIAL — an append-mostly feed wants `WHERE id < :cursor`; an offset pager over a DESC feed shifts under every new row). `insertExport` takes a required `TransactionContext` so the row commits with its audit entry. It also **writes `superseded_by`**: `markSuperseded` finds the most recent non-superseded export for `(subjectKind, subjectId, documentType)` and stamps it in the same transaction as the new row — a column nothing writes is the same defect as a permission nothing enforces. Reads accept a permitted-subject-kinds list so the service can filter rather than refuse. | `listExports`, `findExportById`, `insertExport`, `markSuperseded` | `transaction.ts`, `domain/cursor.ts` |
| `master/src/repositories/document-asset.repository.ts` | repository | Logo and signature images. Stores **metadata only** (mime, byte size, sha256, storage path); the bytes live on disk under `config.documents.assetsDir`, never in the database and never under `uploadsDir` — `/uploads` is unauthenticated static (`master/src/http/app.ts:44`). | `insertAsset`, `findAssetById`, `listAssets`, `deleteAsset` | `transaction.ts` |
| `master/src/services/document.service.ts` | service | Template CRUD. Permission, then domain assertions, then one transaction threading `trx` into the repository write plus `recordActivity` — atomic, following the `role.service.ts` precedent. `updateTemplate`/`deleteTemplate` take a **mandatory** `expectedVersion` through `assertVersionMatches` (`master/src/domain/access.ts:183-192`). Promoting a default clears the previous one in the same transaction. | `listTemplates`, `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate` | template repository, `document-template.ts` |
| `master/src/services/document-render.service.ts` | service | The render use case, separate from CRUD because it orchestrates different collaborators and is the **only importer of `pdf/`**. `documents.render` → the subject's own view key (`leads.view` / `orders.view`) → read the subject through the existing service so it arrives already masked → resolve template → `ratesIncluded = template.showRates && canSeeRates(actor)` → `buildDocumentModel` → `renderPdf` → write `.tmp` and fsync → one transaction `{ markSuperseded, insertExport, recordActivity }` → commit → rename → `publishChange`. `previewDocument` runs the identical path with `persist:false`, so a preview can never diverge from the real document. | `renderDocument`, `previewDocument`, `listExports`, `fetchExportFile` | `pdf/renderer.ts`, `lib/document-files.ts`, export repository |
| `master/src/pdf/renderer.ts` | pdf (infrastructure) | `DocumentModel` → `Buffer`. Owns page setup, the line-item table, colour chips, watermark, page numbers, logo and signature placement. **No business rule and no permission check**: if a column is not in `model.columns` it is not drawn, full stop. | `renderPdf` | PDFKit, `pdf/fonts.ts`, `pdf/primitives.ts` |
| `master/src/pdf/fonts.ts` | pdf (infrastructure) | Registers the four vendored OFL faces with PDFKit once per process and maps a `ScriptRun` tag to a face. Resolves them from `config.documents.fontsDir`. Fails loudly at startup if a face is absent rather than silently substituting Helvetica, which would render Devanagari as blank boxes. | `registerFonts`, `assertFontsPresent`, `faceFor` | PDFKit, fontkit, config |
| `master/src/pdf/primitives.ts` | pdf (infrastructure) | `table()`, `colourChip()` (14px swatch with the two-letter ring fallback when a colour has no hex — Fields owns the hex, this reads it), `watermark()`, `pageFooter()`, `keyValueBlock()`, and `runText()` which walks a `ScriptRun[]` switching faces so a mixed-script line stays on one baseline. | as listed | PDFKit, `pdf/fonts.ts` |
| `master/src/lib/document-files.ts` | lib | Disk I/O, outside `repositories/` because that layer's rule is about Knex and this touches no database. Temp → fsync → rename, mirroring the Office outbox's durability convention. `sweepOrphanTemporaries()` runs at startup to delete `.tmp` files left by a crash between the write and the commit. Paths derive from config, never from client input, so a subject id can never traverse out of the export directory. | `writeExportFile`, `readExportFile`, `sweepOrphanTemporaries` | `node:fs`, config |
| `master/src/http/routes/document.routes.ts` | routes | `/api/documents`. Copies `access.routes.ts` exactly, with **zero** guard exemptions. | `documentRoutes` | both document services |
| `master/src/db/migrations/20260308000000_document_templates_and_exports.ts` | migration | DDL only: `document_templates`, `document_assets`, `document_exports` with indexes and CHECK constraints — including the eight typed BOOLEAN toggle columns, the `layout` JSONB, and the ninth and last partial Bin index, on `document_templates`. Seeds **nothing** — no default template row, so `master/tests/helpers/fixtures.ts` needs no seeded-id bookkeeping and the first render works off `TEMPLATE_DEFAULTS`. `down()` is real: it drops the three tables, which resurrects nothing. DDL per `03-DATABASE.md`. | `up`, `down` | none |
| `master/assets/fonts/*.ttf` (4 files) | asset | See §5. | — | — |
| `master/assets/fonts/LICENSES.md` | asset | See §5. | — | — |
| `master/tests/document-fonts.test.ts` | test (PURE) | **The Devanagari gate.** Runs fontkit's `layout()` directly against the vendored face and asserts real shaping happened: a conjunct must produce fewer glyphs than codepoints, and an i-matra must be positioned before its consonant. A library that only maps codepoints in order fails both — which is precisely how a WinAnsi-only or shaping-free renderer gets caught before it ships. | — | fontkit, the vendored font |
| `master/tests/document-model.test.ts` | test (PURE) | Rate and line-total columns **absent** (not present-and-zero, not present-and-null) when `ratesIncluded` is false; totals block omitted with them; `splitByScript` segments a mixed line correctly; `formatDateForDocument` returns the same day for an input `toISOString()` would shift. | — | `document-model.ts` |
| `master/tests/document-template.integration.test.ts` | test | Duplicate name is 409 with details; `expectedVersion` mandatory and a stale one refused with `storedVersion`; promoting a second default demotes the first in one transaction; a soft-deleted template frees its name; row and audit entry commit or roll back together. | — | `helpers/db.ts` |
| `master/tests/document-render.integration.test.ts` | test | An actor without `field.saleRate.view` gets a PDF whose extracted text contains no rate and no total; a preview writes neither file nor export row; export row and audit entry are atomic; another tenant's export id is a 404, not a 403; a render for a subject the actor may not view is refused before any file is written. | — | `helpers/db.ts` |

**This stage is where the Bin reaches nine entities.** `document_template` joins
`RECYCLE_BIN_ENTITIES` here with `RESTORE_PERMISSION['document_template'] = 'documents.delete'`, one
`UNION ALL` arm and the `20260308` partial index. Independently of the Bin,
`POST /api/documents/templates/:id/restore` exists from this stage — the module's own restore route
is not conditional on the Bin branch.

**Rendering is server-side, in the Master, with bundled PDFKit + fontkit.** The permission rule
settles it: rate redaction is decided from the `ActorContext`, the rate column must be absent from
the document rather than zeroed, and the export must land in `document_exports` **and**
`activity_log` in one transaction — none of which a client-side renderer can be trusted with or is
able to do.

**The rate-redaction key is `field.saleRate.view`.** `products.rate.view` does not exist in the
catalogue. `reports.export` is deliberately not reused: overloading it would make unticking one
silently disable the other.

### 3.8 Stage 8 — Office Dashboard

**No new endpoints.** The existing `DashboardSummary` / `dashboard.service` / `dashboard:changed`
triple is reused, extended with three figures, made per-figure permission-gated (absent, never `0`),
and carried into `SyncSnapshot.dashboard`. `openConflictCount` and `pendingSyncCount` are **optional
and gated on `sync.resolveConflicts`**, like every other figure; `pipelineBreakdown`'s element is
`{ stageId, stageName, sequence, colourHex, leadCount }`. `04-API-CONTRACT.md` owns the type.

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `master/src/repositories/dashboard.repository.ts` | repository | Two grouped queries the dashboard has nowhere to live today — `leadCountsByStage` (GROUP BY `stage_id` joined to `pipeline_stages`, converted leads excluded) and `dispatchedBetween` — plus `countRecentMutations`, which today runs `db()('applied_mutations')` **from the service layer** (`master/src/services/dashboard.service.ts:51`), the one standing violation of decision 12. The week boundary is computed in SQL as `date_trunc('week', now() AT TIME ZONE :tz)` with the timezone passed in explicitly, never assembled in Node. | `leadCountsByStage`, `dispatchedBetween`, `countRecentMutations` | `transaction.ts` |
| `master/tests/dashboard.integration.test.ts` | test (integration) | `DSH-4`…`DSH-9` (`10-TESTING.md` §8): a figure the actor may not see is **absent** rather than `0`; `dispatchedThisWeekCount` respects the configured timezone across the week boundary; the pipeline breakdown excludes converted leads; `SyncSnapshot.dashboard` equals what `dashboard:get` returns for the same actor. Needs a real cluster — the timezone and permission facts it proves cannot be faked with a mock. | — | `helpers/db.ts` |
| `office/tests/snapshot-masking.test.ts` | test (PURE) | Every `SyncSnapshot` key is accounted for in `forCurrentUser()` — masked, replaced, gated or explicitly pass-through. There is no such test today, so a newly added collection is a silent leak; this is the guard `BACKEND_MODULES.md` §8.1 requires. It does **not** close the module-filtering gap on its own — `forCurrentUser()` still re-masks only `field.saleRate.view` — it stops this batch from widening it. | — | reads `office/src/http/app.ts` |
| `office/tests/dashboard-staleness.test.ts` | test (PURE) | The panel renders a correct figure online and an honestly-labelled stale one offline, with the Master mocked unreachable. Office-local — no cluster, no live dashboard data. | — | mocked `master-connection.ts` |

Counting client-side from the snapshot was rejected for a concrete reason: the snapshot is capped at
`SNAPSHOT_LIMIT = 500` and excludes converted leads, so client-side counts would be silently wrong at
scale. Online the panel gets a correct figure; offline it gets an honestly-labelled stale one.

### 3.9 Stage 7 — shared permission grant, one migration

| Path | Layer | Purpose | Key exports | Depends on |
|---|---|---|---|---|
| `master/src/db/migrations/20260309000000_new_module_permission_grant.ts` | migration | Grants **every** new key from all six modules to `tier = 'admin'` **only**, in one file, last. Union-and-sort against the stored array rather than replace, skipping rows where nothing changed, so it converges on a fresh install *and* on the owner's already-migrated database. The no-op test is `NEW_KEYS.every((key) => stored.includes(key))` — **never** a length comparison, because a stored array holding a duplicate makes a length test skip a role that still needs the grant (`08-PERMISSIONS.md` owns the algorithm). Key strings **inlined and frozen**, never imported from `@orderbook/shared`. Empty `down()` with a justifying comment: re-revoking on rollback would be a silent capability change. | `up`, `down` | none — deliberately |
| `shared/tests/permissions.test.ts` | test (PURE) | A **new** file — `shared/tests/` holds only `discovery.test.ts` and `sync.test.ts` today, so this is not an extension of anything. The new keys are in `PERMISSIONS`; `minimumTierFor` returns the ruled tier for each; `allowedForTier('office')` excludes `documents.delete` and `recycleBin.viewAll` and includes `fields.view`. | — | `shared/src/domain/permissions.ts` |
| `master/tests/permission-enforcement.test.ts` | test (PURE) | Source-reading, `credential-invariants.test.ts` style: every key in `PERMISSIONS` appears in at least one `requirePermission(` call under `master/src/services/`, or in a named indirect-enforcement helper (`canSeeRates`, `canEditRates`, `RESTORE_PERMISSION`, `REQUIRED_PERMISSION`), with an explicit allow-list so an exemption is a visible act. | — | reads source |
| `master/tests/migration-grant.integration.test.ts` | test | Running `20260309` twice is idempotent; an admin role holding a hand-added key keeps it (union, not replace); a management-tier role gains nothing; a soft-deleted admin role is granted too. | — | `helpers/db.ts` |

Non-admin roles receive new keys through the permission grid, by an administrator who chooses them.
Granting `recycleBin.view` to a role nobody re-approved is the act the no-wildcard rule exists to
prevent (`shared/src/domain/permissions.ts:224-232`), with extra steps.

---

## 4. Migrations — the exact five filenames

| Order | Filename (under `master/src/db/migrations/`) | Registry `name` | Owner | Adds |
|---|---|---|---|---|
| 7 | `20260305000000_soft_delete_columns.ts` | `20260305000000_soft_delete_columns` | Recycle Bin | `deleted_at`/`deleted_by` on 4 tables; the **first six** partial Bin indexes; party/product code uniqueness → partial. `down()` deliberately empty |
| 8 | `20260306000000_field_values_and_stage_ordering.ts` | `20260306000000_field_values_and_stage_ordering` | Fields | option-list timestamps + soft delete; two more partial Bin indexes; `version` on `option_lists` and `custom_field_definitions`; `option_lists.hex`; `pipeline_stages.is_archived`; deferrable sequence constraint; seeds all four `FIELD_LIST_KEYS`. `down()` deliberately empty |
| 9 | `20260307000000_activity_log_actor_name.ts` | `20260307000000_activity_log_actor_name` | Logs (+ Reports indexes) | `activity_log.actor_name` and the start of persisting it; `activity_log_row_hash()`; pager/facet/verifier/date indexes; the Reports range indexes incl. `idx_orders_dispatched`. Real `down()` |
| 10 | `20260308000000_document_templates_and_exports.ts` | `20260308000000_document_templates_and_exports` | PDF Designer | `document_templates` (eight BOOLEAN toggles + `layout` JSONB), `document_assets`, `document_exports`; the ninth partial Bin index. Real `down()` |
| 11 | `20260309000000_new_module_permission_grant.ts` | `20260309000000_new_module_permission_grant` | **Shared — last** | union-grants every new key to `tier = 'admin'`. `down()` deliberately empty |

Positions 1–6 are the existing files, ending at `20260304000000_role_tier_ceiling_repair.ts`
(`migrations/index.ts:31-36`). All five new entries append to the **end** of the array, in the order
above; nothing already in it is reordered or edited.

**Three of the five have a deliberately empty `down()`, and that is not laziness.** `20260305` and
`20260306` follow the `20260304` precedent: dropping `deleted_at` would resurrect every soft-deleted
row, so the rollback is worse than the state it rolls back to, and the file says so in a comment.
`20260309` is empty because re-revoking would be a silent capability change. `20260307` and `20260308`
have real `down()` implementations — neither resurrects anything. `03-DATABASE.md` is the authority
for each migration's `down()` policy and this table only records which is which.

> **One conflict, one recorded decision.** `20260303000000_roles_and_users.ts:21` still does
> `import { allPermissions } from '@orderbook/shared'` and spends it at line 331. That is live, and it
> is exactly the trap the registry header forbids — but the same header also forbids editing an applied
> migration. Both rules cannot hold. **Decision: leave it.** The union-based grant migration makes the
> outcome correct on every install regardless, and editing an applied migration is the more dangerous
> of the two rules to break. This is recorded in `HANDOFF.md` so it is not rediscovered as a bug a
> third time.

---

## 5. Vendored fonts

| File | Face | Licence | Approx. size |
|---|---|---|---|
| `master/assets/fonts/Inter-Regular.ttf` | Body | SIL OFL 1.1 | ~310 KB |
| `master/assets/fonts/Inter-SemiBold.ttf` | Headings / emphasis | SIL OFL 1.1 | ~310 KB |
| `master/assets/fonts/IBMPlexMono-Regular.ttf` | Codes, ids, quantities | SIL OFL 1.1 | ~130 KB |
| `master/assets/fonts/NotoSansDevanagari-Regular.ttf` | Devanagari | SIL OFL 1.1 | ~230 KB |
| `master/assets/fonts/LICENSES.md` | — | — | the three OFL texts, each font's copyright line and upstream version |

All four are SIL OFL 1.1, which explicitly permits embedding in a document. `LICENSES.md` ships
alongside so the vendored binaries are auditable with **no network access** — which is the whole
point, since this product never touches the internet.

Devanagari support is a hard requirement and it eliminates several popular PDF libraries that ship
WinAnsi encoding only. Party names, addresses and terms in Hindi are unrenderable without it.
fontkit subsets each face per document, so the embedded copy is a fraction of the file size above.

---

## 6. Existing files touched

One line each on the nature of the change. **Detail, rationale and exact diffs live in
`05-EXISTING-CODE-CHANGES.md`** — this table exists so an implementer can see the blast radius at a
glance and so two people editing the same file know they must coordinate.

Files marked ● are edited by **three or more** modules and are the coordination hot spots.

### 6.1 `shared/`

| # | Path | Nature of change |
|---|---|---|
| 1 | ● `shared/src/index.ts` | Six new `export *` lines (activity, documents, fields, recycle-bin, reports, i18n barrel). |
| 2 | ● `shared/src/domain/inputs.ts` | Mint `CursorQuery` and `CursorPage<T>` once, beside `Paginated<T>` (`inputs.ts:268`); add the module input types (`RecycleBinQuery`, `RestoreInput`, the Fields inputs, the document inputs). |
| 3 | ● `shared/src/domain/permissions.ts` | New `logs` and `documents` modules and their actions; `logs.verifyChain`, `recycleBin.view`, `recycleBin.viewAll`, `fields.view` capabilities; `MINIMUM_TIER` gains `recycleBin.viewAll` and `documents.delete` at `management`; **`fields.manage` lowered `admin` → `management`**; `labelToken` narrowed from `string` to `MessageKey`. |
| 4 | `shared/src/domain/entities.ts` | `DashboardSummary` counters become optional + three new figures + `asOf`, with `openConflictCount`/`pendingSyncCount` gated on `sync.resolveConflicts` and `pipelineBreakdown` elements shaped `{ stageId, stageName, sequence, colourHex, leadCount }` (`04-API-CONTRACT.md` owns the type); `OptionListItem` gains `hex`/`deletedAt`/`createdAt`/`updatedAt`; `CustomFieldDefinition` gains `deletedAt`; `PipelineStage` gains `isArchived`; `Role`/`User` gain `deletedBy`. |
| 5 | ● `shared/src/protocol/socket.ts` | **Prerequisite:** `details`, `messageKey`, `params` on the `{ ok: false }` arm of `CommandResult<T>` (`socket.ts:142-159`). Then `'restored'` on `ChangeAction` (`socket.ts:180`); `document_template`/`document_export` on `ChangedEntity`; `dashboard` on `SyncSnapshot`; **46** new `ClientToServerEvents` commands — the itemised list is `04-API-CONTRACT.md`'s, which is also where the `fields:` / `logs:` / `bin:` event names are fixed. |
| 6 | `shared/package.json` | Add `"sideEffects": false` so the web bundlers can tree-shake the two catalogues. |

### 6.2 `master/src/`

| # | Path | Nature of change |
|---|---|---|
| 7 | ● `master/src/config/index.ts` | One `locale` block: `timeZone` from `ORDERBOOK_TIMEZONE` (default `'Asia/Kolkata'`) and `defaultLocale`. Plus the `documents` block (dirs, size caps, `fontsDir` under `packageRoot/assets/fonts`). One timezone key, not two. |
| 8 | `master/src/index.ts` | After `runMigrations()`, validate the zone once with `SELECT now() AT TIME ZONE $1` and abort naming `ORDERBOOK_TIMEZONE` on `invalid_time_zone`; `mkdir` the export and asset dirs beside the existing `uploadsDir` mkdir (`index.ts:28`); call `assertFontsPresent()` and `sweepOrphanTemporaries()` before `listen`. |
| 9 | `master/src/lib/errors.ts` | `AppError` gains `messageKey` and `params`; `message` becomes derived from the EN catalogue at throw time so existing tests asserting English text stay byte-identical. |
| 10 | `master/src/http/middleware/error-handler.ts` | Emit `messageKey` and `params` alongside the `details` it already spreads (`error-handler.ts:28-32`). |
| 11 | `master/src/http/middleware/require-auth.ts` | `actorFromRequest` populates `actorName` from `req.user.displayName`. |
| 12 | `master/src/http/app.ts` | Five `app.use` lines between `/api/access` (line 40) and `app.use('/api', dataRoutes)` (line 41). Below the bare `/api` mount they are shadowed. |
| 13 | `master/src/http/routes/access.routes.ts` | The four deleted-roles/deleted-users/restore bodies delegate to `recycleBinService`. Paths, handler count and `needs(...)` guard per handler all preserved — `credential-invariants.test.ts:73-89` asserts the identity. |
| 14 | `master/src/http/routes/data.routes.ts` | `DELETE /leads/:id`, `/orders/:id`, `/parties/:id`, `/products/:id`, each with a locally aliased `needs('<module>.delete')` guard — the **first enforcement sites** those four frozen keys have ever had. Re-point the three catalogue reads at the unguarded `fieldsService` exports. |
| 15 | `master/src/http/routes/auth.routes.ts` | `GET /me` additionally returns `defaultLocale`. |
| 16 | ● `master/src/realtime/hub.ts` | `respond()` (`hub.ts:391`) sets `code`, `details`, `messageKey`, `params` for any `AppError`, not only `ForbiddenError`. **46** `socket.on` lines inside `registerCommands()` (`hub.ts:204`), one per command in `04-API-CONTRACT.md`'s itemised list, each using the existing `run(ack, actor => …)` shape with `actorFor()` resolved **per command**. `DIRECTORY_ENTITIES` (`hub.ts:114`) gains `document_export`. `broadcastDashboard` re-derives per socket. |
| 17 | `master/src/domain/actor.ts` | `ActorContext` gains `actorName: string | null`; `systemActor` supplies `null`. |
| 18 | `master/src/domain/access.ts` | Guards pass a `messageKey` + params instead of composing an English sentence. The 409/`{field,value}` and mandatory-`expectedVersion` behaviour (`access.ts:160-169`, `183-192`) is already correct and is **not** re-done. |
| 19 | `master/src/domain/pipeline.ts` | `Stage` gains `isArchived`; `assertStageMove` refuses a move into an archived stage; `defaultStage` skips archived stages. |
| 20 | `master/src/domain/custom-fields.ts` | Comment only, on `evaluateCompleteness`: it is called with live definitions, so removing a required definition makes records complete again — and that is correct, because completeness is a statement about today's configuration. |
| 21 | ● `master/src/repositories/activity-log.repository.ts` | **Extended, not replaced.** Signature becomes `recordActivity(entry, actor, trx)` so `actor_name` cannot be forgotten at the ~24 call sites (`BACKEND_MODULES.md` §5.1); the required `trx` stays required. **This lands in Stage 1, not at the Logs stage** — `actor` is simply not persisted until `20260307` adds the column, and introducing it early means Recycle Bin and Fields are written once against the final signature instead of swept later. Adds five functions: `listEntries`, `listFacets`, `verifyChain`, **`chainBounds`** (the window's first/last sequence and hash) and **`streamForExport`** (the CSV reader) — two different functions, not two names for one. `recordDetachedActivity` is untouched, remains the narrow failed-operation path, and is forbidden in new modules. |
| 22 | ● `master/src/repositories/mappers.ts` | `mapActivityEntry`, `mapBinEntry`, `mapDocumentTemplate/Export/Asset`, `mapStageCount`; existing mappers gain `hex`, `deletedAt`, `isArchived`, `deletedBy`. BIGINT ids map through `String()`, never `Number()`. |
| 23 | `master/src/repositories/party.repository.ts` | `softDeleteParty` / `restoreParty`; `deleted_at` filters with `includeDeleted` on the reads. Stamps `hlc` + `field_hlc.deleted_at`. |
| 24 | `master/src/repositories/product.repository.ts` | Same pair and filters, including `findProductByCode` and `countProducts`. |
| 25 | `master/src/repositories/lead.repository.ts` | Same pair and filters, including `countOpenLeads` and `countFollowUpsDue`. |
| 26 | `master/src/repositories/order.repository.ts` | Same pair and filters, including `countOrders`. |
| 27 | `master/src/repositories/custom-field.repository.ts` | Becomes read **and** write: option and definition insert/update/soft-delete/restore/reorder, each requiring `trx` and invalidating the field cache. Reads gain `{ includeDeleted }` and exclude deleted rows by default, while still returning `is_active = false` rows unchanged. |
| 28 | `master/src/repositories/pipeline.repository.ts` | Stage writes, `reorderStages` under `SET CONSTRAINTS … DEFERRED`, `setDefaultStage` as clear-then-set, archive/restore. `stagesFor()` filters archived; `listPipelines` keeps returning them. |
| 29 | ● `master/src/db/migrations/index.ts` | Five imports with `.js` specifiers and five entries appended to the end of the array, `name` matching each filename minus `.ts`. |
| 30 | `master/src/services/catalog.service.ts` | `deleteParty` / `deleteProduct` (+ internal restores) — each one transaction containing the soft delete **and** `recordActivity`, then `publishChange` after commit. |
| 31 | `master/src/services/lead.service.ts` | `deleteLead` / `restoreLead`; `assertSourcePlatform` rewritten onto `assertOptionValueChange` so a removed value only blocks a value that actually changes. |
| 32 | `master/src/services/order.service.ts` | `deleteOrder` / `restoreOrder`; `deleteOrder` calls `reservationRepo.releaseForOrder` inside the same transaction — which finally gives that dead function a caller — then publishes stock after commit. |
| 33 | `master/src/services/role.service.ts` | `restoreRole` gains `renameTo`; the collision branch returns `ConflictError` carrying `suggestRestoredName`'s answer in `details`; the published action becomes `'restored'`. |
| 34 | `master/src/services/user.service.ts` | `restoreUser` gains `renameTo` and runs `assertParentsLive` first (a user's `role_id` must resolve to a live role); published action becomes `'restored'`. |
| 35 | `master/src/services/sync.service.ts` | `assertOptionValueChange` on the merged-update path so both transports agree; `route()` rejects a mutation whose target row has `deleted_at` set, recorded like any other refusal. |
| 36 | `master/src/services/dashboard.service.ts` | Per-figure gating with `actorCan` returning `undefined` (never `0`) when not held; three new figures; the inline `db()('applied_mutations')` at line 51 moves into `dashboard.repository.ts`; stamps `asOf`. |
| 37 | `master/src/services/snapshot.service.ts` | Adds the dashboard summary to the second `Promise.all` batch and returns it as `snapshot.dashboard`. |
| 38 | `master/src/services/storage.service.ts` | Measures `config.documents.dir` and reports it on `StorageUsage`. |
| 39 | `master/src/services/panel-actor.service.ts` | Populates `actorName` from the resolved user, and from the panel's own name on the `office_panel` fallback. |
| 40 | `master/package.json` | Dependencies `pdfkit` and `fontkit`; devDependency `@types/pdfkit`. Declared by editing this file directly, then `npm install`, then checking the lockfile changed (`HANDOFF.md`, "Traps worth knowing"). |

### 6.3 `master/tests/`

| # | Path | Nature of change |
|---|---|---|
| 41 | `master/tests/helpers/fixtures.ts` | `DATA_TABLES` gains `document_exports`, `document_assets`, `document_templates`, children before parents (`fixtures.ts:25-46`). `setupDatabase` captures the migration-seeded `option_lists` and `custom_field_definitions` ids and `resetData` preserves them — the exact treatment seeded roles already get (`fixtures.ts:90-92`). |
| 42 | `master/tests/credential-invariants.test.ts` | Extends the guard-count identity to the five new routers, each with **zero** exemptions. |
| 43 | `master/tests/mappers.test.ts` | Extended with the `toIsoDate` cases (`10-TESTING.md` `RPT-5`) — its first coverage since the IST fix shipped. |
| 44 | `master/tests/http-api.integration.test.ts` | Extended with the cross-cutting route cases `10-TESTING.md` §8 registers against it. |

### 6.4 `office/`

| # | Path | Nature of change |
|---|---|---|
| 45 | `office/src/config/index.ts` | Additive `ui.defaultLocale`, matching the Master's precedence convention. |
| 46 | ● `office/src/http/app.ts` | **Prerequisite:** `forward()` (`app.ts:438-462`) passes `details`, `messageKey` and `params` through beside the permission it already forwards. Then ~46 `forward(res, '<event>', payload)` routes — one per socket command, minus the handful with no Office surface, every one registered **after** `app.use('/api', requireUser)` (`app.ts:133`) and every one forward-only — nothing queued. `GET /api/session` returns `defaultLocale`. `forCurrentUser()` (`app.ts:395-407`) strips dashboard figures the current session lacks. |
| 47 | `office/src/realtime/master-connection.ts` | `MasterCommandError` carries `details`, `messageKey`, `params`; the ack unwrapper copies them off `CommandResult`. `applyChange` treats `'restored'` as an upsert and requests a fresh snapshot for `option_list`/`custom_field`/`pipeline` rather than patching in place. |

### 6.5 Web API clients and repo root

| # | Path | Nature of change |
|---|---|---|
| 48 | `master/web/src/api.ts` | `ApiError` gains `messageKey`/`params` and accessors for `details.blockedBy` and `details.suggestion`; typed wrappers for every new endpoint; `deletedRoles`/`deletedUsers`/`restoreRole`/`restoreUser` reduce to thin wrappers over the unified Bin calls. **No JSX, no screen.** |
| 49 | `office/web/src/api.ts` | The same additive error fields and the typed wrappers for the Office's forwarded routes; documents that render/preview return a `Blob`, not JSON. |
| 50 | `master/web/package.json` | `"prebuild": "npm run build --workspace @orderbook/shared"` — the api.ts wrappers consume new shared types, and `shared/` is consumed as compiled output. |
| 51 | `office/web/package.json` | Same `prebuild` script. |
| 52 | `package.json` (root) | `"i18n:sync": "node tools/i18n-sync.mjs"`. |
| 53 | `eslint.config.js` | Register the in-repo flat-config plugin from `tools/eslint-rules/` and add `no-untranslated-jsx-text` **as `'off'`**, scoped to `['{master,office}/web/src/**/*.tsx']`; promoted to `'error'` in the UI phase. Do not narrow the existing `varsIgnorePattern: '^_'` — it is how redaction drops a key. |

### 6.6 Documentation

| # | Path | Nature of change |
|---|---|---|
| 54 | `HANDOFF.md` | Record: the `20260303` `allPermissions()` decision; server-side PDF rendering and why Devanagari eliminated the alternatives; the snapshot-carried Dashboard; the new trap *"`/uploads` is unauthenticated static — never put permission-gated files there"*. |
| 55 | `docs/UI_REDESIGN.md` | Reconcile §4.1/§5/§9, which still scope all five modules as `master/web` admin-only, with the owner's both-panels decision and the tier ceilings these modules mint. |
| 56 | `docs/LEAD_GENERATION_FLOW.md` | Amend §11: the PDF Designer and `Order.exports[]` move from "Not built" to built, noting exports are cross-entity (`document_exports` over leads and orders) rather than an array embedded on the order. |

---

## 7. File counts

Recounted after the reconciliation pass. Stage numbers are `11-BUILD-SEQUENCE.md`'s; suite names,
kinds and case counts are `10-TESTING.md` §8's.

### 7.1 New files

| Stage / module | Source | Migrations | Assets | Tests + fixtures | Total |
|---|---:|---:|---:|---:|---:|
| Stage 0 — socket ack `details` | 0 | 0 | 0 | 1 | **1** |
| Stage 1 — cross-module foundation | 1 | 0 | 0 | 2 | **3** |
| Stage 1 — i18n / translation layer | 13 | 0 | 0 | 4 | **17** |
| Stage 2 — Recycle Bin | 5 | 1 | 0 | 2 | **8** |
| Stage 3 — Fields | 5 | 1 | 0 | 2 | **8** |
| Stage 4 — Logs | 5 | 1 | 0 | 1 | **7** |
| Stage 5 — Reports | 6 | 0 | 0 | 2 | **8** |
| Stage 6 — PDF Designer | 14 | 1 | 5 | 4 | **24** |
| Stage 7 — shared permission grant | 0 | 1 | 0 | 3 | **4** |
| Stage 8 — Office Dashboard | 1 | 0 | 0 | 3 | **4** |
| **Total** | **50** | **5** | **5** | **24** | **84** |

The i18n "source" count includes all three files under `tools/` — `i18n-sync.mjs` and the two
eslint-rule files, which ship registered at `'off'` (§2.5). Of the 24 test-directory files, 23 are
suites and one (`shared/tests/activity-tokens.lock.json`) is a committed fixture.

By package: `shared/` 14 source (5 domain + 9 i18n) + 4 test-directory files = **18**; `master/`
33 source + 5 migrations + 5 assets + 17 tests = **60**; `office/` 0 source + 3 tests = **3**;
`tools/` **3**. 18 + 60 + 3 + 3 = 84.

### 7.2 New test suites — see `10-TESTING.md` §8

`10-TESTING.md` §8 is the register: which suites exist, whether each is pure or integration, which
module owns it and how many cases it is projected to carry. This document does not keep a second
list; it keeps the count, because the count is a file count.

| | Pure (cannot silently skip) | Integration (`describe.skipIf`) | Total |
|---|---:|---:|---:|
| Count | 15 | 8 | **23** |

Fifteen pure of twenty-three is deliberate — the highest-risk logic in the batch is the cursor codec,
the date arithmetic, the Devanagari shaping, the redaction masking, the i18n renderer and catalogue,
the permission-enforcement sweep and the migration registry, and none of those may be allowed to skip
silently (§1.7). The two Dashboard gates that genuinely need a real cluster — the timezone boundary
and the converted-lead exclusion — are the one integration file in Stage 8; the module-filtering
snapshot guard and the offline-staleness rendering do not, and stay pure.

> `BACKEND_MODULES.md` §9 estimates "roughly 12 files, of which 7 are pure". The real figure is 23,
> of which 15 are pure — the estimate predates the cursor codec suite, the migration registry guard,
> the `SyncSnapshot` key-accounting guard, the Office forwarding suite and the three permission
> suites `08-PERMISSIONS.md` proposes. `npm run verify` is **333 tests across 21 files** today
> (`HANDOFF.md`); 21 existing + 23 new = this batch takes it to **44 files**, ≈584 cases.
> `10-TESTING.md` §8 carries the case-count projection and is the sole authority on both figures.

### 7.3 Existing files touched

| Area | Files |
|---|---:|
| `shared/` | 6 |
| `master/src/` | 34 |
| `master/tests/` | 4 |
| `office/src/` | 3 |
| Web API clients, package manifests, `eslint.config.js` | 6 |
| Documentation | 3 |
| **Total** | **56** |

Five files are edited by three or more modules and need a single owner sequencing them:
`shared/src/index.ts`, `shared/src/domain/inputs.ts`, `shared/src/domain/permissions.ts`,
`shared/src/protocol/socket.ts`, `master/src/realtime/hub.ts` — plus
`master/src/db/migrations/index.ts`, `master/src/repositories/mappers.ts`,
`master/src/repositories/activity-log.repository.ts`, `master/src/config/index.ts` and
`office/src/http/app.ts`.

### 7.4 Grand total

**137 files** — 81 created, 56 modified. Excluding the five vendored font/licence assets and the
three documentation files, **129 files of code**.

---


## 8. Open questions on structure

Placement decisions this document cannot settle alone. Two that used to sit here have been ruled and
are recorded below as decided, not re-opened. The batch-wide open-question register is `README.md` §8
and `11-BUILD-SEQUENCE.md` §2; only the structural ones are repeated here.

**Decided — the web-side i18n files are deferred.** `BACKEND_MODULES.md` §4.3 lists them inside the
i18n module's tree; §3 of the same document and the locked scope decision exclude them, and the
narrower, later statement governs. The only web files in this batch are the two `api.ts` clients
(§2.6). `shared/src/i18n/` is in scope and fully testable through `shared/tests/` with no web file,
so the deferral costs no verification.

**Decided — `tools/eslint-rules/*` ships now, at `'off'`.** It is not deferred; only its promotion to
`'error'` is (§2.5, `05-EXISTING-CODE-CHANGES.md` §8.1).

1. **`DIRECTORY_ENTITIES`: `document_export` alone, or `document_template` too?** `CRITIQUE.md`
   endorses gating `document_export`, because it names a lead or order the recipient may not be
   entitled to see. A template is company configuration with the same character as an option list,
   and this manifest therefore adds only `document_export`. If templates should also be per-recipient
   gated, the line changes in `master/src/realtime/hub.ts:114`.
2. **Where do large CSV and PDF payloads go?** Every export currently returns as one value through
   `masterConnection.command`'s 15-second ack. Cap the Office-side export far lower, chunk it, or
   declare export Master-only — the answer changes whether `office/src/` gains an assembly module,
   which is the only thing that would give this batch an Office source file. Listed in
   `BACKEND_MODULES.md` §8.2 and **still open**. Its sibling — what a CSV export does when it fails
   mid-stream, after bytes are already on the wire — is open too and is registered in `README.md` §8.
3. **Should `party_product_variants` be soft-deletable?** It is not in `RECYCLE_BIN_ENTITIES` and no
   file above gives it a `deleted_at`. The row carries a negotiated rate, so deleting one silently
   changes what a future line quotes — which is the argument for a Bin branch, and the reason this is
   listed rather than assumed. **Open**, registered in `README.md` §8.
4. **Should Logs also surface `timeline_entries`?** The Logs module reads `activity_log` only. If the
   answer is yes, it is a second source in `log.service.ts` and a second projection in the repository,
   not a new file. **Open**, registered in `README.md` §8.

Known-open and explicitly **not** addressed by any file above: `applied_mutations` atomicity;
`panel:revoked` never being emitted; the audit trail's 14 best-effort call sites across six existing
services; module-level filtering of the Office cached snapshot; retention/pruning for `activity_log`
and `document_exports`; `QUIET_AFTER_DAYS = 30`, which needs a number from the owner rather than a
default; and the Devanagari font fallback question. All are in the `README.md` §8 register.
