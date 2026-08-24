# 10 — Testing and acceptance gates

Status: **specification. Nothing in this document is built.** It is the test plan for the six
backend modules in `docs/BACKEND_MODULES.md` plus the Office Dashboard aggregate, and the gate list
the owner ticks before authorising each module as done.

> **This document is the SOLE test register.** §8 is the one list of suites this batch adds — names,
> kinds and projected case counts — and every other document cites it rather than keeping its own.
> `02-FILE-STRUCTURE.md` remains the authority on the **file manifest** and the scope boundary; where
> a suite's *name* is concerned the two must agree, and §8 records where they currently do not.
>
> The other authorities this document defers to, and does not restate: `04-API-CONTRACT.md` for wire
> shapes, type definitions, socket event names and endpoint paths; `03-DATABASE.md` for schema,
> enums, CHECK constraints, indexes and every migration's `down()` policy; `08-PERMISSIONS.md` for
> permission keys, tiers and the grant-migration algorithm; `11-BUILD-SEQUENCE.md` for stage ordering
> and numbering, which is **Stage 0 – Stage 8** everywhere in this document.

Read `docs/BACKEND_MODULES.md` first. Where this document and that one differ, that one wins; the
two places this document *refines* rather than restates it (the register in §8, the harness changes
in §3) say so explicitly.

---

## 1. The warning this document exists for

**A skipped suite reads exactly like a passing one.**

`describe.skipIf(!canRunIntegrationTests)` prints the word *skipped* in a summary line that almost
everybody reads as green. This is not a hypothetical. `master/tests/helpers/db.ts:38-48` records what
actually happened:

> the platform directory is *imported* rather than recomputed: this function used to build its own
> `${process.platform}-${process.arch}`, which on Windows is `win32-x64` while the package installs
> to `windows-x64`. Nothing was found, `canRunIntegrationTests` went false, and every integration
> suite — including the one that is the §15 gate list — reported *skipped*.

Twelve integration files did nothing on the owner's machine for months, and the summary line never
went red. `HANDOFF.md:529-532` lists it among the traps worth knowing, and it is the single most
important fact about testing in this repository.

Three consequences follow, and every one of them is binding on this batch:

1. **Every module ships at least one *pure* suite — no `describe.skipIf` — covering its
   highest-risk logic.** A pure suite runs on any machine, in any checkout, with no database. If the
   integration harness is broken again tomorrow, these still fail loudly. §4 enumerates them.
2. **An acceptance gate is only ticked after the suite is confirmed to have *run*.** Not "was not
   red" — *ran*. §5 gives the procedure and the harness change that makes skipping refusable.
3. **The highest-risk logic is deliberately factored into pure functions so that it *can* be
   pinned by a pure suite.** `report-range.ts`, `document-model.ts`, `cursor.ts`, `field-values.ts`
   and `recycle-bin.ts` (the `domain/` halves) exist in the module designs for exactly this reason.
   Business rules that only exist inside a SQL string can only be tested behind a `skipIf`.

---

## 2. How testing works in this repo

### 2.1 One vitest config, three packages

`vitest.config.ts` at the workspace root is the only test config; there is no per-package one.

| Setting | Value | Why |
|---|---|---|
| `include` (`:7`) | `['{shared,master,office}/tests/**/*.test.ts']` | A new file in any of the three `tests/` directories is picked up with no config edit |
| `fileParallelism` (`:10`) | `false` | Every integration file shares one cluster and one database |
| `testTimeout` (`:11`) | `30_000` | |
| `hookTimeout` (`:15`) | `180_000` | The first integration run pays ~35s for `initdb` on Windows |
| `coverage.exclude` (`:19`) | `['**/migrations/**', '**/migrate-cli.ts']` | **A migration is never coverage-tracked.** Coverage will not flag an untested one |

Naming is uniform and expected of new files: `<subject>.test.ts` for a pure suite,
`<subject>.integration.test.ts` for anything touching PostgreSQL. Both live flat in
`<package>/tests/`; `master/tests/helpers/` is the only subdirectory.

Every existing test file opens with a block comment saying what the suite proves and, where it
applies, the real defect it was written against — often citing a doc section
(`master/tests/audit-trail.integration.test.ts:1-14`, `master/tests/permissions.integration.test.ts:1-11`).
This is uniform across all 21 files and is expected of every file this batch adds. A new suite whose
header does not name the defect it guards is not finished.

### 2.2 Pure suites and integration suites

| | Pure | Integration |
|---|---|---|
| Files today | 9 | 12 |
| Guard | none | `describe.skipIf(!canRunIntegrationTests)`, one call wrapping the whole file |
| Needs | nothing | PostgreSQL binaries on the machine |
| Runs on | any checkout | a machine with a cluster it may build |
| Fails when broken | always | only when the harness is working |

All twelve `skipIf` call sites are in `master/tests/*.integration.test.ts`. There is no other skip
mechanism anywhere in the suite — no `it.skipIf`, no `test.skip`, no environment guard. `office/` and
`shared/` suites are entirely pure and must stay that way: there is no Office-side integration
harness, and building one is not in this batch (§9).

The integration skeleton every new master suite copies, from
`master/tests/audit-trail.integration.test.ts:60-68` — note that **every hook lives inside the
`skipIf`'d describe**:

```ts
describe.skipIf(!canRunIntegrationTests)('<what this proves>', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    tenantId = await testTenantId();
    actor = await testActor();
  });
});
```

`master/tests/helpers/fixtures.ts` supplies `setupDatabase`, `teardownDatabase`, `resetData`,
`testTenantId`, `stageIdByName` (`:124-132`), `ALL_PERMISSIONS` (`:135-140`), `testActor` (`:142-154`)
and `actorWith` (`:157-163`). `actorWith` is how every permission-refusal case in this batch builds
its caller: it returns an **office-tier** actor holding exactly the named keys, which is also the
tier ceiling those cases need to exercise.

### 2.3 The throwaway cluster

Integration suites build a real PostgreSQL in the OS temp directory. They never touch a developer's
`data/` folder and never touch the `order_book` database the owner's dev PC uses.

```
os.tmpdir()/orderbook-test-pg/
  cluster/      the data directory, initdb'd once and reused
  socket/       unix socket dir (not used on win32)
  postgres.log  pg_ctl's log
```

Port `55433` (`ORDERBOOK_TEST_PG_PORT` overrides), user `orderbook_test`, database `orderbook_test`
(`master/tests/helpers/db.ts:26-32`). `startTestPostgres()` (`:87-124`) is idempotent behind a module
flag and does four things in order: discard the cluster if it was built by a different major version
(`:236-257`), `initdb` if there is no `PG_VERSION`, `pg_ctl start` if nothing is running, then create
the database through the `pg` driver — never `psql`, because the embedded distribution ships server
binaries only (`:216-217`).

Two details in that helper are load-bearing and must not be "tidied":

- **`pg_ctl start` is `spawn(..., { stdio: 'ignore' })`, not `execFile`** (`:137-160`). `execFile`
  resolves only when the child's pipes close, and the server `pg_ctl` launches inherits them for its
  whole life — on Windows the promise never settled and the suite hung until the hook timed out,
  with PostgreSQL running perfectly the whole time.
- **`--wait start` is not "ready to answer".** `waitUntilAcceptingConnections()` (`:166-192`) polls a
  real connection every 250ms for up to 30s, because polling is the only honest check.

The test helper *rebuilds* a version-mismatched cluster; production does the opposite and refuses to
touch the data directory (`assertClusterVersionMatches` in `master/src/db/postgres-server.ts`). That
asymmetry is deliberate: test data is disposable, company data is not.

### 2.4 `npm test` vs `npm run verify`

```
npm test         # pretest = build:shared, then `vitest run`
npm run verify   # npm run lint && npm run typecheck && npm run test
```

`pretest` (`package.json:36`) is mandatory, not decorative: `@orderbook/shared` is consumed as
**compiled output**, so a clean checkout cannot even import it until `tsc` has run
(`HANDOFF.md:476-478`). `typecheck` is `tsc --noEmit` per workspace *plus* `tsc -p tsconfig.test.json`
over the three `tests/` trees — which is why a type-level gate (a total `Record<...>`, an exhaustive
fixture) counts as a real gate here: `npm run verify` fails on it without any test running.

**Authorising a module requires `npm run verify`, not `npm test`.** Two of this batch's gates
(`i18n-coverage`'s totality of `hi.ts`, the snapshot-policy map in §6.8) are enforced by the
compiler, and `npm test` alone would not notice them.

### 2.5 Windows: `ORDERBOOK_PG_BIN`, and the `win32`/`windows` trap

`findPostgresBinDir()` (`master/tests/helpers/db.ts:49-68`) looks in this order:

1. `process.env.ORDERBOOK_PG_BIN`, **returned verbatim with no existence check** (`:50`) — see §3.2
2. `<cwd>/node_modules/@embedded-postgres/<platformDir>/native/bin`, and the same one directory up
   (workspace-root hoisting)
3. `/usr/lib/postgresql/<v>/bin`, `/usr/pgsql-<v>/bin`, `C:\Program Files\PostgreSQL\<v>\bin` for
   v17/16/15/14 (`:59-64`)
4. `/usr/local/pgsql/bin`, `/opt/homebrew/opt/postgresql/bin`

Since candidate 3 gained its Windows entry, the suite runs on the owner's PC with no environment
variable at all. The variable remains the override:

```powershell
$env:ORDERBOOK_PG_BIN = 'C:\Program Files\PostgreSQL\17\bin'; npm run verify
```

```bash
ORDERBOOK_PG_BIN="/c/Program Files/PostgreSQL/17/bin" npm run verify
```

`platformDir` comes from `embeddedPostgresPackageDir()`
(`master/src/db/postgres-server.ts:42-45`), **imported** by the test helper at `db.ts:22` rather than
recomputed:

```ts
export function embeddedPostgresPackageDir(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}
```

`process.platform` is `win32`; the npm package directory is `windows`
(`@embedded-postgres/windows-x64`). Interpolating the former into a package path silently finds
nothing — `HANDOFF.md:533-534`. **No file this batch adds may build a platform path of its own.** If
a new suite needs one, it imports this function.

`canRunIntegrationTests` (`db.ts:74`) is a module-level `const`, evaluated at import time:
`findPostgresBinDir() !== null && !isRoot()`. It cannot be changed per-file or per-test.

### 2.6 Source-reading invariant suites

`master/tests/credential-invariants.test.ts` reads files under `master/src` with `readFileSync` and
asserts on their **text**. Its header calls this "unusual and… the point" (`:13`). It is an accepted
pattern here, for one specific class of rule: an invariant that has been *written down as something a
grep should prove*.

Two current examples, and what each is for:

```ts
// :43 — "If it ever returns two, one of them is a leak."
expect(countCalls(auth, 'readCredentialForVerification')).toBe(1);

// :88 — every access route carries its own permission guard, minus two
//        deliberate exceptions (the static catalogue, and /me/password)
expect(guards.length).toBe(handlers.length - 2);
```

`countCalls` (`:27-34`) filters out `//` and `*` lines so a comment naming a function is not counted
as a caller. Any source-reading test this batch adds copies that helper rather than re-inventing it.

This batch uses the pattern **five** times — `i18n-tokens`, `migration-registry`, the table-registry
guard, `permission-enforcement` (§6.9, from `08-PERMISSIONS.md`), and the extension of the
route-guard count to five new routers. It is the right tool when the
alternative is a rule that only a reviewer's memory enforces. It is the wrong tool for behaviour: a
source-reading test proves a line exists, not that it works.

> **`master/tests/credential-invariants.test.ts` is untracked in git.** `git status --porcelain`
> reports `??`, and `git log` for the path is empty. The 21-file baseline in §8 includes it, but a
> fresh clone of `dev` runs **20** files and has no route-guard invariant at all. **Commit it before
> extending it** (§3.3) — otherwise five new routers get "guarded" by a file that does not exist on
> the branch.

### 2.7 What a new table or a new cache costs the harness

Three pieces of bookkeeping, all in `master/tests/helpers/fixtures.ts`, all of which fail as silent
cross-test pollution rather than as an error:

- **A new business table must be added to `DATA_TABLES`** (`:25-46`). The list is ordered children
  before parents so `TRUNCATE ... RESTART IDENTITY CASCADE` works. Nothing detects an omission today
  — §6.9 adds a guard that does.
- **A new repository-level cache must be invalidated in `resetData()`** (`:111-114`, beside
  `invalidateRoleCache`, `invalidatePipelineCache`, `invalidateFieldCache`, `resetAuthState`). The
  comment there is exact: "a stale role would let a later test pass with permissions the database no
  longer grants." The Fields module invalidates pipeline and field caches on every write, so its
  suite depends on this being right.
- **A migration that *seeds* configuration survives every `TRUNCATE`.** Seeded rows are visible to
  every test, and a test creating a row with the same natural key collides. The roles precedent is
  the pattern to copy and it is three separate pieces: capture the seeded ids in `setupDatabase()`
  (`:57-69`), delete only non-seeded rows in `resetData()` (`:90-92`), and recompute the id counter
  *past* the survivors (`:97-106`).

And one cost with no fix: **every integration file adds serial time.** `fileParallelism: false`, one
cluster, one database. Prefer adding cases to an existing suite over creating a new file when the
setup is identical — which is why this batch adds eight integration files (§8), not fifteen, and
folds the Reports cases into a suite that shares the Logs seed data only where the seed genuinely
differs.

---

## 3. Harness changes this batch requires, before any module starts

Four changes. None is a module; all of them are prerequisites, in the same sense as the socket
`details` fix (`BACKEND_MODULES.md` §2.5).

### 3.1 Make skipping refusable — `ORDERBOOK_REQUIRE_INTEGRATION`

The trap in §1 is a *reporting* defect: the harness has no way to say "these suites were supposed to
run." Give it one.

```ts
// master/tests/helpers/db.ts
const required = process.env.ORDERBOOK_REQUIRE_INTEGRATION === '1';
const binDir = findPostgresBinDir();

if (required && binDir === null) {
  throw new Error(
    'ORDERBOOK_REQUIRE_INTEGRATION=1 but no PostgreSQL binaries were found. ' +
      'Set ORDERBOOK_PG_BIN, or unset ORDERBOOK_REQUIRE_INTEGRATION to allow skipping.',
  );
}

export const canRunIntegrationTests = binDir !== null && !isRoot();
```

Throwing at module scope is deliberate: it fails at import, before any suite is collected, with a
message naming the fix — the same shape as production's `resolveBinDir()`
(`master/src/db/postgres-server.ts:75-81`). Add the root script:

```json
"verify:integration": "cross-env-free — set ORDERBOOK_REQUIRE_INTEGRATION=1 then npm run verify"
```

Since the repo has no `cross-env` dependency and must not gain one for this, the script is declared
per-shell in the gate procedure (§5) rather than in `package.json`. **Open question (minor):** whether
to add the script at all, or to leave it as the two-line invocation in §5. Recommended: leave it as
the invocation; a `package.json` script that only works in one shell is worse than a documented
command that works in both.

### 3.2 Verify `ORDERBOOK_PG_BIN` instead of trusting it

`db.ts:50` returns the environment variable verbatim. A typo'd path therefore makes
`canRunIntegrationTests` **true**, and `startTestPostgres()` then throws in the middle of a
`beforeAll` — a confusing failure instead of either a clean skip or a clear error. Production checks
the same variable and throws a message naming the directory
(`postgres-server.ts:76-81`). Mirror it:

```ts
if (process.env.ORDERBOOK_PG_BIN) {
  const dir = process.env.ORDERBOOK_PG_BIN;
  if (!existsSync(path.join(dir, binName('pg_ctl')))) {
    throw new Error(`ORDERBOOK_PG_BIN is set but pg_ctl was not found in ${dir}`);
  }
  return dir;
}
```

Small, and it removes the one case where the harness lies about being able to run.

### 3.3 Commit `credential-invariants.test.ts`

See §2.6. It is on disk, vitest collects it, and it is not on the branch. Commit it unchanged first,
so the five-router extension in §6.9 is a diff against something rather than a new file that quietly
carries someone else's work.

### 3.4 Fixture bookkeeping for the new tables

This batch creates tables in two migrations. Every one of them needs its `DATA_TABLES` entry before
its suite is written, or the suite passes for the wrong reason:

| Table | From | `DATA_TABLES`? | Note |
|---|---|---|---|
| `document_templates` | `20260308000000` | yes | placed before `document_exports` is irrelevant — no FK between them and the truncate cascades |
| `document_exports` | `20260308000000` | yes | |
| `document_assets` | `20260308000000` | yes | if the design lands one; the asset repository implies it |
| `option_lists.hex` | `20260306000000` | n/a | a column on an existing seeded configuration table |
| `option_lists.version`, `custom_field_definitions.version` | `20260306000000` | n/a | `INTEGER NOT NULL DEFAULT 1`. Columns, not tables — but the fixture must **not** hard-code `version: 1` when seeding, or `FLD-21`'s concurrency case passes for the wrong reason |
| `option_lists.deleted_at`, `custom_field_definitions.deleted_at` | `20260306000000` | n/a | These are what make `option_list_item` and `custom_field_definition` Bin entities at Stage 3 (§6.3). `resetData()` must clear soft-deleted seeded rows too, or a Bin gate sees a previous test's tombstone |

`option_lists` is **seeded configuration** and is deliberately *not* in `DATA_TABLES`. The Fields
suite therefore inherits the roles problem: a test that adds a colour must clean it up, or capture
the seeded ids in `setupDatabase()` the way `seededRoleIds` is captured. **Decide this once, in the
Fields suite header, and copy the roles precedent** — it is the only pattern in the tree that works.

If the PDF migration seeds a default template, the same three pieces apply to `document_templates`
and it stops being a plain `DATA_TABLES` entry. That is a genuine open item for the PDF module owner:
`BACKEND_MODULES.md` §5.5 does not say whether a default template is seeded.

---

## 4. The rule: every module ships a pure suite

Non-negotiable, and the direct answer to §1. Each module's highest-risk logic is pinned by a suite
with **no `describe.skipIf`**, which therefore runs in every checkout on every machine.

| Stage / concern | Pure suite | Pins |
|---|---|---|
| Stage 0–1 prerequisites | `master/tests/cursor.test.ts` | The one opaque base64url codec: round-trip, tamper rejection, precision |
| Stage 1 — i18n | `shared/tests/i18n.test.ts` | The renderer: substitution, plurals, missing-key fallback, ids byte-identical |
| Stage 1 — i18n | `shared/tests/i18n-coverage.test.ts` | `hi.ts` totality; every catalogue key has a token; placeholder-set parity |
| Stage 1 — i18n | `master/tests/i18n-tokens.test.ts` | Every `recordActivity` `(entityType, action)` pair has a token |
| Stage 2 — Recycle Bin | `master/tests/recycle-bin-domain.test.ts` | Cursor precision, parent graph, name escalation |
| Stage 3 — Fields | `master/tests/field-values-domain.test.ts` | Value normalisation, permutation validation, hex |
| Stage 5 — Reports | `master/tests/report-range.test.ts` | Every calendar boundary. **The IST day-shift gate** |
| Stage 6 — PDF Designer | `master/tests/document-model.test.ts` | **Rate columns absent, not zero, not null** |
| Stage 6 — PDF Designer | `master/tests/document-fonts.test.ts` | **Devanagari shaping. The hard requirement** |
| Stage 7 — permissions | `shared/tests/permissions.test.ts` | The eleven new keys and their tiers. **A NEW file** — `shared/tests/` holds only `discovery.test.ts` and `sync.test.ts` today |
| Stage 7 — permissions | `master/tests/permission-enforcement.test.ts` | Every catalogue key is enforced somewhere, or is on an explicit allow-list |
| Cross-cutting | `master/tests/migration-registry.test.ts` | Every migration file is registered; every new table is truncatable |
| Stage 8 — Office | `office/tests/snapshot-masking.test.ts` | Every `SyncSnapshot` key is accounted for |
| Stage 8 — Office | `office/tests/dashboard-staleness.test.ts` | The cached dashboard, staleness labelling, per-figure stripping |
| Office (all six modules) | `office/tests/module-forwarding.test.ts` | 503 offline, `details` passthrough, nothing queued |

**Fifteen pure suites**, all of which fail loudly on a machine that has never seen PostgreSQL. The
integration suites prove the SQL; these prove the rules.

**Three of the fifteen are the i18n layer, and that is the point of §5's scope ruling.** The web
i18n files — `{master,office}/web/src/i18n/*`, `LocalePicker.tsx`, `Untranslated.tsx`, `main.tsx`,
`styles.css`, `format.ts`, `PermissionGrid.tsx`, `AccessScreen.tsx` — are **deferred to the UI
phase** and are not in this batch. `shared/src/i18n/` **is** in scope, and `shared/tests/i18n.test.ts`
and `shared/tests/i18n-coverage.test.ts` verify it **completely, with no web file involved**:
catalogue totality, EN/HI placeholder parity, plural selection, missing-key fallback, and byte-identical
passthrough of ids and hashes are all pure assertions over compiled TypeScript. The deferral costs
this batch no i18n coverage. What it defers is the screen that displays the strings, not the strings.

---

## 5. Proving a suite ran

Ticking a gate requires the pass count, not the absence of red.

**The procedure, once per module, on the owner's machine:**

```powershell
# 1. Baseline — record both numbers from the summary line before you start.
npm run verify

# 2. After the module lands, with skipping refused.
$env:ORDERBOOK_REQUIRE_INTEGRATION = '1'; npm run verify
```

```bash
# bash equivalent
ORDERBOOK_REQUIRE_INTEGRATION=1 npm run verify
```

**The rule: the summary line must read `Test Files N passed (N)` and `Tests M passed (M)` with
nothing skipped.** Vitest prints skips as a separate segment (`21 passed | 6 skipped`). If that
segment is present, the gate is not met, whatever colour the line is.

Then check the arithmetic: the file count must have risen by exactly the number of files the module
added, and the test count by the number of cases. §8 gives both figures per module. A file count that
rose by 6 and a test count that rose by 89 means an integration file collected nothing.

**Do not attempt to force a skip by pointing `ORDERBOOK_PG_BIN` at a bogus directory.** Today that
makes `canRunIntegrationTests` *true* and fails mid-hook (§3.2); after §3.2 it throws at import. In
neither case does it demonstrate the skip path. The skip path is verified once, on a machine with no
PostgreSQL at all, and its only correct outcome is that the fifteen pure suites still run and still
pass.

---

## 6. Per-module test plan

Each subsection gives the pure suites, the integration suites, and the gates. Gate IDs are used in
the checklist in §7.

### 6.1 Stages 0–1 prerequisites — the socket ack and the cursor codec

Built before any module. Stage numbering throughout this section is `11-BUILD-SEQUENCE.md`'s
**Stage 0 – Stage 8**: 0 = the socket-ack `details` prerequisite, 1 = i18n foundation,
2 = Recycle Bin, 3 = Fields, 4 = Logs, 5 = Reports, 6 = PDF Designer, 7 = the permission grant
migration, 8 = Office Dashboard.

**`master/tests/cursor.test.ts` — pure.** `master/src/domain/cursor.ts` is one codec for four
modules, so a defect in it is a defect in four places at once.

| Gate | Proves |
|---|---|
| `PRE-1` | A payload round-trips through `encode`/`decode` unchanged |
| `PRE-2` | A **microsecond** timestamp survives — six fractional digits in, six out. A JS `Date` round-trip loses the last three and would fail this |
| `PRE-3` | A BIGINT id past 2^53 round-trips as a string, not a `number` |
| `PRE-4` | A truncated, re-encoded or foreign cursor is **rejected**, not silently treated as "start from the newest page" |
| `PRE-5` | The encoding is base64url — no `+`, `/` or `=` reaches a query string |
| `PRE-6` | The codec is opaque: `decode` of a hand-written JSON string fails |

`PRE-4` is the one that matters operationally. A malformed cursor that silently restarts the feed
looks like a UI glitch and is actually a paging engine that can loop forever.

**The socket `details` fix.** `respond()` is module-private (`master/src/realtime/hub.ts:391`) and
**no test in this repo has ever opened a Socket.IO connection** — I checked; there is no
`socket.io-client` import anywhere under `{master,office,shared}/tests`. Standing up a socket harness
is not in this batch. So the ~15-line change is gated in two halves:

| Gate | Where | Proves |
|---|---|---|
| `PRE-7` | `credential-invariants.test.ts` (source-reading) | `hub.ts` `respond()` references `error.details` and `error.code` on the general `AppError` path, not only inside the `ForbiddenError` branch |
| `PRE-8` | `office/tests/module-forwarding.test.ts` (pure) | A `MasterCommandError` carrying `code` + `details` becomes a 403/409 whose body contains those `details`, through the real `forward()` (`office/src/http/app.ts:438-462`) with `masterConnection` mocked |

This is honest about its limit: `PRE-7` proves a line exists, not that the ack carries it over a real
socket. The end-to-end socket path stays untested — §9 records it as a gap with an owner-level
decision attached, rather than pretending a source grep closes it.

### 6.2 Stage 1 — i18n

The foundation, and the module whose gates are almost entirely compile-time.

**Scope note, because it decides what these gates can be.** The web i18n files are **deferred to the
UI phase** (`09-I18N.md` §5, §5.6): `{master,office}/web/src/i18n/*`, `LocalePicker.tsx`,
`Untranslated.tsx`, `main.tsx`, `styles.css`, `format.ts`, `PermissionGrid.tsx` and
`AccessScreen.tsx` are all out of this batch, and the only web files in it are
`master/web/src/api.ts` and `office/web/src/api.ts`. **`shared/src/i18n/` is in scope and is fully
testable through `shared/tests/`** — every gate below runs with no browser, no DOM and no database,
which is why the deferral leaves the translation layer verified rather than unverifiable. The two
things it *does* defer are component tests (§9.7 — `vitest.config.ts` includes `.ts`, not `.tsx`)
and the judgement that a hand-written token reads better than the humaniser it replaces, which needs
a rendered screen.

**`shared/tests/i18n.test.ts` — pure. The renderer.**

| Gate | Proves |
|---|---|
| `I18N-5` | No EN string contains a pre-formatted number, a thousands separator or `₹`. Numbers arrive as params, always |
| `I18N-6` | `t()` leaves a record id, a device code and a chain hash **byte-identical** — identifiers are never localised or reformatted |
| `I18N-7` | A `MessageKey` absent from a catalogue at runtime renders a readable fallback derived from the key, and does not throw or return empty |
| `I18N-8` | `tCount()` selects one/other for both `en` and `hi`, and never concatenates a number onto a sentence |

**`shared/tests/i18n-coverage.test.ts` — pure. The contract.**

| Gate | Proves |
|---|---|
| `I18N-1` | **`hi.ts` is total.** Typed `Record<MessageKey, string>`, so a missing key is a `tsc` failure — the test additionally asserts key-set equality so the failure is legible when it happens |
| `I18N-2` | Every key in `PERMISSIONS` has a `permission.<key>` token. *This is what makes the existing `labelToken` contract load-bearing rather than decorative* |
| `I18N-3` | Every `MODULES`, `ACTIONS`, `CAPABILITY_GROUPS` and `ROLE_TEMPLATES` entry has its token |
| `I18N-4` | Every EN key and its HI translation carry an **identical placeholder set**. A translator dropping `{name}` is invisible to the compiler and renders a sentence with a hole in it |

`shared/tests/activity-tokens.lock.json` is the committed fixture `I18N-10` reads. It is a **fixture,
not a suite** — read with `readFileSync` and never imported, because `tsc` does not copy JSON into
`dist` and an import would resolve in the IDE and fail in the built output.

**`master/tests/i18n-tokens.test.ts` — pure, source-reading, in the `credential-invariants.test.ts`
style.**

| Gate | Proves |
|---|---|
| `I18N-9` | Every literal `(entityType, action)` pair passed to `recordActivity` across `master/src/services/**` has a catalogue token |
| `I18N-10` | `ACTIVITY_TOKENS` is a superset of a committed `tests/activity-tokens.lock.json` — a token is never *retired*, mirroring the append-only table |
| `I18N-11` | `renderActivity()` falls back to the raw `entity_type`/`action` pair for an action no catalogue has seen. `action` is free-form `TEXT` with no `CHECK`, so this **will** happen |

`I18N-9` is the gate that keeps `BACKEND_MODULES.md` §8.6 honest: the 13 real action values plus
whatever the new modules mint have to be enumerated by somebody, and this is what notices when they
are not.

**The regression gate for the 129-throw-site sweep.**

The count is **129 across `master/src`, 0 in `office/src`** — 126 by naive grep, plus 4 in
`master/src/domain/conversion.ts` which grep skips because the file contains a literal NUL byte and
is therefore classified as binary, minus a 1-count correction. **Verify with `grep -a`**, or read the
tree with `readFileSync` the way `credential-invariants.test.ts` does. The number of hand-written
tokens is **68**, not 129, because many sites share one — `05-EXISTING-CODE-CHANGES.md` holds the
per-class breakdown. Both numbers matter here: 129 is how many call sites the sweep must not miss,
68 is how many catalogue entries `I18N-13` has to check.

| Gate | Proves |
|---|---|
| `I18N-12` | **The 333 existing cases pass with no assertion edited.** `AppError.message` is *derived* from the EN catalogue, so `access.integration.test.ts` and `permissions.integration.test.ts` — both of which assert on English message text — must stay byte-identical |
| `I18N-13` | `AppError.message === t(messageKey, params)` against EN for every subclass, so the English fallback cannot drift from the token |

`I18N-12` is a gate on a *diff*, not on a file: if the sweep required editing an existing expectation,
the derivation is wrong and the error text changed under somebody.

### 6.3 Stage 2 — Recycle Bin

**`RECYCLE_BIN_ENTITIES` grows across stages, and so do these gates.** Stage 2 ships **six**
entities — `lead`, `order`, `party`, `product`, `role`, `user` — from `20260305`'s six `deleted_at`
columns and six partial indexes. Stage 3 adds **two**, `option_list_item` and
`custom_field_definition`, from `20260306`. Stage 6 adds **one**, `document_template`, from
`20260308`. Final total nine. **A gate asserting an N-branch `UNION` belongs to the stage where N
branches exist**: `BIN-5` is a six-branch gate here, re-run at eight in Stage 3 (`FLD-19`) and at
nine in Stage 6 (`PDF-24`). Asserting eight or nine at Stage 2 would fail against a schema that is
correct. The entity literal is `custom_field_definition`, not `custom_field`.

**`master/tests/recycle-bin-domain.test.ts` — pure.**

| Gate | Proves |
|---|---|
| `BIN-1` | A cursor round-trips at **microsecond precision**. `deleted_at` is `TIMESTAMPTZ`; a batch delete gives many rows an identical millisecond, and a JS `Date` round-trip would silently drop or repeat rows |
| `BIN-2` | `suggestRestoredName` escalates deterministically past every taken name |
| `BIN-3` | `PARENT_LINKS` names a parent for every entity that has one — a new soft-deletable entity added with no parent rule fails here. **`PARENT_LINKS` is the upward-only RESTORE graph and nothing else**; the DELETE-side 409 rule is a separate per-entity policy table (`BIN-21`), and a test that conflates them passes for the wrong reason |
| `BIN-4` | An actor holding no `*.delete` keys gets an **empty page**, not a refusal |

**`master/tests/recycle-bin.integration.test.ts`.**

| Gate | Proves |
|---|---|
| `BIN-5` | Paging across the **six**-table `UNION ALL` neither drops nor repeats a row when many rows share one `deleted_at`. Delete a batch in one transaction so every row carries an identical timestamp, page with `limit 3`, assert the union of pages equals the set exactly. Re-run at eight branches in Stage 3 and nine in Stage 6 |
| `BIN-6` | The feed sorts by deletion time across heterogeneous tables |
| `BIN-7` | Filtering by type omits the other branches from the query entirely |
| `BIN-8` | **Ownership scope:** an office-tier user sees only their own deletions; `recycleBin.viewAll` reveals another user's; a deletion by an unattended panel (`deleted_by IS NULL`) is invisible without `viewAll` |
| `BIN-9` | The list hides entity types whose delete key the caller does not hold |
| `BIN-10` | **Parent hazard:** restoring a lead whose party is still deleted is refused with 409 and *names the party*; `cascadeParents` restores both in one transaction |
| `BIN-11` | Restoring a user whose role is still deleted is refused, rather than producing an account that cannot sign in — a **new** gate over an existing unguarded defect |
| `BIN-12` | Restoring a role reattaches the users still pointing at it (the existing `access.integration.test.ts` assertion, moved to the unified path) |
| `BIN-13` | **Name collision:** a party deleted and recreated under the same name returns 409 carrying the suggestion; the same call with `renameTo` succeeds |
| `BIN-14` | A soft-deleted party frees its `party_code` for reuse, and restore does not collide on it — the partial-unique-index rework, exercised |
| `BIN-15` | Deleting an order releases its active reservations and free-to-sell recovers |
| `BIN-16` | A soft-deleted party is absent from `listParties`, from search **and** from the panel snapshot |
| `BIN-17` | **`hlc` is stamped.** Delete and restore advance `hlc` and set `field_hlc.deleted_at`; a mutation arriving over sync for a deleted record is rejected and replays to the same rejection |
| `BIN-18` | Restore publishes `ChangeAction` `'restored'`, not `'updated'` (`shared/src/protocol/socket.ts:180` gains the value) |
| `BIN-19` | Restore is audited atomically — a failed restore leaves no `activity_log` entry |
| `BIN-20` | There is no endpoint that hard-deletes anything |
| `BIN-21` | **The four DELETE routes' 409 policy, one case per row of the table `04-API-CONTRACT.md` owns.** `party` refuses while a live (not soft-deleted) lead or order references it; `product` refuses while a live `line_items` row references it **or** an `inventory_stock` row has non-zero on-hand or reserved; `lead` refuses once it carries a `converted_order_id`, and otherwise soft-deletes cascading to its line items; `order` refuses once dispatched, and otherwise soft-deletes releasing active reservations in the same transaction. Every refusal is `ConflictError` 409 with `{ blockedBy: BinBlocker[] }` **naming the blocking records** — a 409 with an empty `blockedBy` is a dead end for the person holding the mouse |
| `BIN-22` | The delete policy and `PARENT_LINKS` are **not** the same rule: deleting a lead whose party is live succeeds, and restoring that lead while its party is deleted still fails. One is a downward reference check at delete time, the other an upward liveness check at restore time |

`BIN-17` is the correction the critique forced (`CRITIQUE.md` #8): a `version` bump with no `hlc`
movement is a state the merge engine cannot interpret, and the failure mode — a queued offline edit
winning every field against a tombstone — is invisible until data is already wrong.

### 6.4 Stage 3 — Fields

**`master/tests/field-values-domain.test.ts` — pure.**

| Gate | Proves |
|---|---|
| `FLD-1` | `normaliseOptionValue` trims and **never case-folds**. `White` and `white` are two values, because a value's identity is the exact string the records already carry |
| `FLD-2` | `assertOptionValueChange` passes a value a record already holds, even after the option was removed |
| `FLD-3` | `assertCompleteReorder` rejects a list that is not a permutation |
| `FLD-4` | A hex is normalised to lowercase; a malformed one is rejected |

**`master/tests/fields.integration.test.ts`.**

| Gate | Proves |
|---|---|
| `FLD-5` | **Reorder under the deferrable constraint:** reordering stages one drag at a time never violates the sequence uniqueness. This fails without `SET CONSTRAINTS ... DEFERRED`, which is only possible because `idx_pipeline_stages_seq` is dropped and re-added as a table constraint |
| `FLD-6` | **Default-stage swap:** moving the default to another stage does not violate `idx_pipeline_stages_one_default`, a *partial* unique index that cannot be deferred — so clear-then-set ordering is the only route |
| `FLD-7` | Reorder rejects a stale permutation missing a stage added since the screen loaded |
| `FLD-8` | Reordering changes what both Kanban boards render, through the invalidated cache |
| `FLD-9` | **Removal does not touch records:** removing a colour leaves every `line_item_quantities`, `inventory_stock`, `stock_reservations` and `stock_movements` row byte-identical |
| `FLD-10` | A lead already carrying a removed source can still be edited over HTTP **and** over sync — asserted on both transports |
| `FLD-11` | Archiving a stage holding live leads is refused and names the count; an archived stage still resolves in the timeline and is not a legal move target |
| `FLD-12` | In-use counts are **one query per set** regardless of value count, asserted by counting statements rather than by timing; three lines in one colour count once |
| `FLD-13` | The usage count does **not** read `stock_movements` — the unbounded-scan correction (`CRITIQUE.md` #13) |
| `FLD-14` | A colour on stock but absent from the list reports as *unlisted*, not as an error; stock inbound still accepts a colour on no list — the list stayed advisory |
| `FLD-15` | **`fields.manage` is management+**, refused for a role without it over HTTP and over the socket; `fields.view` gates the management read but **not** `GET /api/option-lists` |
| `FLD-16` | A panel user lacking `fields.view` still receives a **complete snapshot** — the `buildSnapshot` all-or-nothing gate. A rejected `Promise.all` produces no snapshot at all, swallowed into a log line |
| `FLD-17` | Every Fields write leaves an `activity_log` entry in the same transaction |
| `FLD-18` | A removed value appears in the Recycle Bin and restores; one whose name was taken meanwhile restores under the offered name |
| `FLD-19` | **Re-run `BIN-5` at eight branches.** `option_lists` and `custom_field_definitions` gain `deleted_at` and their partial indexes in `20260306`, so `option_list_item` and `custom_field_definition` join `RECYCLE_BIN_ENTITIES` here. The eight-way `UNION` is this stage's assertion, not Stage 2's |
| `FLD-20` | **Optimistic concurrency, the write half.** `option_lists` and `custom_field_definitions` carry `version INTEGER NOT NULL DEFAULT 1` (`20260306`), and `expectedVersion` is **mandatory** on `PUT /api/fields/values/:id` and `PUT /api/fields/definitions/:id`. An omitted `expectedVersion` is **400**; a stale one is **409 carrying `storedVersion`** — the shapes `assertVersionMatches` (`master/src/domain/access.ts:183-192`) already produces for roles and users. Assert against that function's actual output rather than a hand-written envelope, so the two cannot drift |
| `FLD-21` | **Optimistic concurrency, the race.** Two saves read version 1; the first commits and the row becomes version 2; the second is refused 409 and **does not overwrite**. Assert the stored value is the first writer's. Without this the version column is decoration — it would be read, compared, and the losing write would land anyway |

`FLD-16` is the quiet one. It is not about Fields at all — it is about not breaking every panel while
adding a permission check to a read that `buildSnapshot` depends on.

### 6.5 Stage 4 — Logs

**`master/tests/logs.integration.test.ts`.** No pure suite of its own: the cursor codec (`PRE-*`) and
the activity tokens (`I18N-9..11`) are its pure halves, and both are owned elsewhere.

The service functions under test are `listLogs`, `listLogFacets`, `verifyLogChain` and `exportLogs`;
the repository additions are `listEntries`, `listFacets`, `verifyChain` and `chainBounds`, with
`streamForExport` as the export reader. `chainBounds` and `streamForExport` are **two different
functions** and a gate that exercises one has not exercised the other. `02-FILE-STRUCTURE.md` is the
authority on those names.

**`recordActivity` already has its three-argument form by the time this stage runs.** The signature
became `recordActivity(entry, actor, trx)` in **Stage 1**, before Recycle Bin and Fields were
written; `20260307` adds `activity_log.actor_name` and starts persisting the argument that has been
arriving all along. `LOG-6` is therefore a gate on the *column being written*, not on call sites
being updated — those were updated two stages ago.

| Gate | Proves |
|---|---|
| `LOG-1` | **Keyset pagination both directions:** the feed pages newest-first and returns the same rows walking Older then Newer back |
| `LOG-2` | The cursor round-trips a BIGINT id past 2^53 without losing precision (the integration half of `PRE-3`) |
| `LOG-3` | A malformed cursor is rejected rather than silently restarting at the newest page |
| `LOG-4` | Filters by actor, action, entity type and date range; free-text matches actor name, action and record id |
| `LOG-5` | **Actor name survives user deletion:** a soft-deleted user's name still renders in the Actor column |
| `LOG-6` | Every row written *after* the migration carries `actor_name` — the gate that catches the 24-call-site hazard. Assert on a row created by an ordinary service call, not by a hand-built insert |
| `LOG-7` | A system actor and a `NULL` `actor_id` row render without an empty cell |
| `LOG-8` | **Chain verification detects a tampered row:** verify reports the first break and its `sequence` when a stored hash is altered. Tampering requires `ALTER TABLE activity_log DISABLE TRIGGER activity_log_no_update` around the write and re-enabling it after — `activity_log_immutable()` raises on any UPDATE (`20260303000000_roles_and_users.ts:306-318`) |
| `LOG-9` | Verify reports a `prev_hash` break when a row is unlinked from its predecessor |
| `LOG-10` | Verify reports ok over an untampered chain and counts the rows it checked |
| `LOG-11` | Verify seeds a partial range from the predecessor row rather than assuming genesis; counts pre-chain rows as *unverifiable*, not as broken; truncates an over-cap range and says so |
| `LOG-12` | **Verification runs in SQL.** The digest covers `details::text` — Postgres's own JSONB rendering — so a Node re-computation cannot reproduce the bytes. Assert by verifying a row whose `details` contains key ordering and unicode that JS would serialise differently |
| `LOG-13` | Verifying writes exactly one audit entry, *after* the scan; listing the log writes none — otherwise the trail becomes mostly about itself |
| `LOG-14` | Refusals name the missing permission (`logs.view`, `logs.verifyChain`, `logs.export`) |
| `LOG-15` | **`ActivityLogEntry.hash` is populated and is `string \| null`.** The Logs screen has an Entry-hash column and it is the only thing that makes "hash-chained" visible to a person rather than a claim in a document. It is covered by `logs.view` — no separate key — so assert it is present for a `logs.view` holder and that a pre-chain row returns `null` rather than an empty string or a fabricated digest |

`LOG-12` is the one an implementer is most likely to get wrong by being helpful. The chain input is
`prev_hash|sequence|entity_type|entity_id|action|actor_type|actor_id|details`
(`20260303000000_roles_and_users.ts:268-276`); `actor_name` sits outside it, which is exactly why
adding the column is safe.

### 6.6 Stage 5 — Reports

**`master/tests/report-range.test.ts` — pure. The date-safety gate, and the highest-risk single
detail in the batch.**

| Gate | Proves |
|---|---|
| `RPT-1` | `report-range.ts` resolves "this month" from `{year, month, day}` **components** and never constructs a `Date` |
| `RPT-2` | The range is half-open, so the first of the next month is excluded |
| `RPT-3` | Every month in the range is listed, including months with no data |
| `RPT-4` | A range longer than `MAX_RANGE_MONTHS` is refused |
| `RPT-5` | **`toIsoDate` keeps the day the user typed on an IST machine.** Added to `master/tests/mappers.test.ts`. `toIsoDate` (`master/src/repositories/mappers.ts:79-90`) is the *existing fix* for the shipped DATE-a-day-early defect and **has no test coverage whatsoever today** — I verified it is not even imported by `mappers.test.ts`. This would be its first |

**`master/tests/reports.integration.test.ts`.**

| Gate | Proves |
|---|---|
| `RPT-6` | **An order dispatched at 23:30 IST on the last day of the month buckets into that month, not the next.** Seeded as an explicit `TIMESTAMPTZ`, bucketed in SQL against `config.locale.timeZone`. This is the gate the whole date-safety design exists for |
| `RPT-7` | The month label is a `'YYYY-MM'` string returned by SQL and is never re-derived from a `Date` anywhere on the way out |
| `RPT-8` | Dispatched boxes report positive even though the ledger delta is negative |
| `RPT-9` | BIGINT totals sum as numbers, not by string concatenation |
| `RPT-10` | A converted lead whose lines exist under both parent types is not double-counted; a lead in the Won stage without `converted_order_id` is **not** counted as converted; a lead in a terminal stage is lost, decided by `is_terminal` and never by the stage name |
| `RPT-11` | The SQL outcome `CASE` and the pure `classifyLeadOutcome` agree at the 29/30/31-day boundary, with a future follow-up date and with a past one |
| `RPT-12` | **Rate redaction:** a caller without `field.saleRate.view` gets buckets with **no `totalValue` key at all** — `expect('totalValue' in bucket).toBe(false)`, matching the existing idiom at `permissions.integration.test.ts:184-186`. Not null. Not zero |
| `RPT-13` | The totals row is computed **server-side** over the same filtered set and carries no money key for a rate-blind caller — never summed by the client from masked buckets |
| `RPT-14` | Top parties order by `orderCount` and say so when value is hidden |
| `RPT-17` | **The top-parties date anchor is `orders.dispatched_at`, not `created_at`.** The report is "dispatched value in the selected period" — goods that left, not business won. Seed an order **created in March and dispatched in April** and assert it lands in April and is absent from March. This is the only gate that can tell the two anchors apart; both produce plausible reports, and the wrong one is wrong by an amount nobody notices. Confirm `idx_orders_party` serves the predicate, or that the index `03-DATABASE.md` specifies does |
| `RPT-15` | Cities group case- and whitespace-insensitively (`Morbi`, `morbi`, `"Morbi "` are one); blank and null are one *unknown* bucket |
| `RPT-16` | `reports.view` and `reports.export` refusals name the missing permission — the **first enforcement site anywhere in the codebase** for two keys that have shipped as togglable grid cells gating nothing |

`RPT-12` deserves its own sentence because the failure mode is a lie rather than a crash:
`totalValue: 0` is a factual claim that the month had no value, and a client will happily chart it.

### 6.7 Stage 6 — PDF Designer

**`master/tests/document-fonts.test.ts` — pure. THE Devanagari gate.**

Devanagari support is a hard requirement — party names, addresses and terms in Hindi are otherwise
unrenderable — and it is what eliminates the popular PDF libraries that ship WinAnsi encoding only.
The gate runs fontkit's `layout()` against the vendored face **directly**, with no PDF, no database
and no `skipIf`, so it cannot silently skip.

| Gate | Proves |
|---|---|
| `PDF-1` | `layout('हिन्दी')` returns **fewer glyphs than codepoints** — six codepoints, fewer glyphs — proving conjunct formation, i.e. real shaping rather than codepoint-order mapping |
| `PDF-2` | `layout('कि')` places the i-matra **before** its consonant: `run.glyphs[0].codePoints` contains `0x093F`. That is reordering, the second half of the requirement, and a font loaded without shaping fails it while passing `PDF-1` |
| `PDF-3` | All four faces (Inter Regular, Inter SemiBold, IBM Plex Mono, Noto Sans Devanagari) resolve under `master/assets/fonts/` from disk, with no network access of any kind |
| `PDF-4` | The renderer fails **at startup**, not at first print, when a vendored font file is missing |
| `PDF-5` | `master/assets/fonts/LICENSES.md` exists and names every vendored binary. All four are SIL OFL 1.1, which explicitly permits PDF embedding — the licence has to be auditable on a machine with no internet |

Pin the exact glyph-id expectations against the face as vendored, and record the observed ids in a
comment: glyph ids are face-specific, and an assertion written from memory will be wrong. Declare
`fontkit` explicitly in `master/package.json` rather than relying on it being hoisted as a PDFKit
transitive dependency — a test that depends on hoisting is a test that breaks on someone else's
`npm install`.

**`master/tests/document-model.test.ts` — pure. The redaction gate.**

| Gate | Proves |
|---|---|
| `PDF-6` | **The `rate` and `lineTotal` columns are ABSENT from `DocumentModel.columns`** when the template asks for rates and the actor lacks `field.saleRate.view`. `expect('rate' in column).toBe(false)`. Not present-and-zero. Not present-and-null |
| `PDF-7` | A template with `showRates: false` produces no rate column **even for** an actor who holds `field.saleRate.view` |
| `PDF-8` | `buildDocumentModel` is pure: given a masked record and a template it imports no PDF library, touches no disk and reads no config |
| `PDF-9` | `splitByScript()` partitions a mixed Hindi/Latin/numeric string into `body`/`devanagari`/`mono` runs without reordering or dropping a character |
| `PDF-10` | An `expectedDispatchDate` of the 1st renders as the 1st on an IST machine — the `toISOString` regression gate, at the document layer |
| `PDF-24` | **`assertTemplateValid` enforces the `DocumentLayout` grammar**, one case per rule: a `kind` appearing twice is rejected; a layout with no `lines` block is rejected; a `header` that is not first is rejected; a `signature` that is not last is rejected; `terms.text` at 501 characters is rejected and at 500 accepted. Every violation is a **400** carrying `{ field: 'layout', block: n, reason }` — assert `block` is the *index of the offending block*, because a grammar error that cannot point at a block is a form the person cannot fix |
| `PDF-25` | **The eight toggles are COLUMNS, not `layout`.** `show_rates`, `show_colour_chips`, `show_terms`, `show_logo`, `show_signature`, `show_page_numbers`, `show_watermark` and `show_party_block` are typed BOOLEAN columns on `document_templates` (`03-DATABASE.md`); `layout` JSONB holds **only** block order and per-block options. Assert that a template saved with every toggle off round-trips with `layout.blocks` unchanged, and that writing a toggle name into `layout` does not turn anything off. `07-UI-SPEC.md` is wrong where it says the nine toggles write into `layout`, and this gate is what would have caught it |

The permission key is **`field.saleRate.view`**. `products.rate.view` does not exist in the catalogue;
the design brief invented it.

**`master/tests/document-template.integration.test.ts`.**

| Gate | Proves |
|---|---|
| `PDF-11` | A duplicate template name is **409** with `details { field: 'name' }`, not 400 |
| `PDF-12` | `updateTemplate` without `expectedVersion` is 400; with a stale one it is 409 carrying `storedVersion` and the diff |
| `PDF-13` | Promoting a second template to default demotes the first in one statement and never trips `document_templates_one_default` |
| `PDF-14` | A soft-deleted template frees its name; restore refuses with 409 when the name has been taken since |
| `PDF-15` | `documents.view/create/edit/delete` refusals name the missing permission; `documents.delete` is management+ |
| `PDF-26` | **The Bin's ninth branch.** `document_template` joins `RECYCLE_BIN_ENTITIES` at this stage, with its partial index in `20260308`, and `POST /api/documents/templates/:id/restore` exists from here regardless of the Bin feed. **Re-run `BIN-5` at nine branches** — this is the stage where a nine-branch `UNION` assertion is correct. `document_exports` is deliberately **not** a tenth branch: a document that was sent to a customer is a record of what was sent |

**`master/tests/document-render.integration.test.ts`.**

| Gate | Proves |
|---|---|
| `PDF-16` | A render by an actor without `field.saleRate.view` produces a PDF whose **extracted text** contains no rate and no total — the end-to-end companion to `PDF-6` |
| `PDF-17` | The export row and its `activity_log` entry commit together, through `recordActivity` with the transaction; neither survives a rolled-back render |
| `PDF-18` | A failed disk write leaves no export row; a crash between write and commit leaves only a `.tmp` the startup sweep removes |
| `PDF-19` | `previewDocument` writes no file, no export row and no activity entry, and stamps the PREVIEW watermark even when the template disables it |
| `PDF-20` | A stored export is unreachable through `/uploads` and reachable only through the authenticated route; an export id belonging to another tenant answers **404, not 403** |
| `PDF-21` | Rendering a document for a lead the actor may not view (`leads.view`) is refused **before any PDF work begins** — document access can never exceed record access |
| `PDF-22` | Export history omits rows for subject kinds the caller may not view, rather than refusing the whole request |
| `PDF-23` | The export cursor round-trips a BIGINT id as a string and pages a feed being written to concurrently without repeating or skipping a row |
| `PDF-27` | **`document_exports.superseded_by` has a writer, and it runs in the render transaction.** `POST /api/documents/render` looks up the most recent non-superseded export for `(subjectKind, subjectId, documentType)` and stamps it. Render twice for one lead and assert the first row's `superseded_by` names the second and the second's is `NULL`; render a *different* `documentType` for the same subject and assert neither is superseded; assert a rolled-back render leaves the earlier row un-stamped. **A column nothing writes is the same defect as a permission nothing enforces** — it reads as working history right up until somebody asks which quotation is current |

### 6.8 Stage 8 — Office Dashboard, and the snapshot completeness gate

> **Correction: `DSH-5` … `DSH-8` were assigned to a suite declared pure, and they cannot live
> there.** `dispatchedThisWeekCount` bucketing against a timezone, a pipeline breakdown read from
> `pipeline_stages`, `buildSnapshot` surviving an actor missing permissions, and `SyncSnapshot.dashboard`
> agreeing with `dashboard:get` are every one of them **statements about what SQL returns**. They need
> a real cluster. A pure suite cannot seed a dispatched order at 00:30 on a Monday, and a "pure" suite
> that reaches for a database is either a lie in its header or a suite that silently skips — which is
> the exact defect §1 of this document exists for.
>
> They move to **`master/tests/dashboard.integration.test.ts`**, the file `02-FILE-STRUCTURE.md`
> already lists for this stage. `DSH-1` and `DSH-2` stay pure in `office/tests/snapshot-masking.test.ts`
> because they are compile-time totality and a masking assertion over a fixture. `DSH-3` moves to
> `office/tests/dashboard-staleness.test.ts`, which is where `forCurrentUser`'s stripping behaviour
> is exercised with a mocked link.
>
> **The snapshot guard has one name: `office/tests/snapshot-masking.test.ts`**, matching
> `02-FILE-STRUCTURE.md`. An earlier draft of this document called it `snapshot-filtering.test.ts`.
> That name is retired — and it was the more misleading of the two anyway, since the suite proves
> **masking**, and *filtering* is precisely the half of the hole it does not close.

**`office/tests/snapshot-masking.test.ts` — pure.** This is the gate `BACKEND_MODULES.md` §8.1
mandates, and it needs a mechanism, because a TypeScript interface does not exist at runtime and
`Object.keys()` comparison proves nothing about masking.

**Requirement on the implementation:** `forCurrentUser` (`office/src/http/app.ts:395-407`) must be
driven by a map that is **total over `keyof SyncSnapshot`**:

```ts
type SnapshotPolicy = 'mask-rates' | 'replace' | 'gate' | 'passthrough';

/** Total by construction: a new SyncSnapshot key that is not listed is a compile error. */
export const SNAPSHOT_POLICY: Record<keyof SyncSnapshot, SnapshotPolicy> = { … };
```

`SyncSnapshot` has fourteen keys today (`shared/src/protocol/socket.ts:198-215`) and gains
`dashboard` as the fifteenth. The compiler is the gate; the test makes the failure legible and pins
the behaviour.

| Gate | Suite | Proves |
|---|---|---|
| `DSH-1` | `office/tests/snapshot-masking.test.ts` — pure | **Every `SyncSnapshot` key is accounted for.** The policy map is total; an exhaustive fixture typed `SyncSnapshot` compiles only when every key is present, and `forCurrentUser` returns exactly those keys |
| `DSH-2` | `office/tests/snapshot-masking.test.ts` — pure | Every key marked `mask-rates` actually loses its gated field for a rate-blind session — asserted by absence, per `shared/src/domain/permissions.ts:300-312`, where `maskFields()` **deletes** rather than nulls |
| `DSH-3` | `office/tests/dashboard-staleness.test.ts` — pure | `forCurrentUser` strips dashboard figures the current session does not hold from a snapshot fetched for someone else; a disconnected panel labels every card stale except the sync card |
| `DSH-4` | `master/tests/dashboard.integration.test.ts` | `DashboardSummary` omits `leadCount` entirely for an actor without `leads.view` — the key is **absent**, not `0` |
| `DSH-5` | `master/tests/dashboard.integration.test.ts` | `dispatchedThisWeekCount` uses `config.locale.timeZone` and does not shift a Monday-morning dispatch into the previous week. Seed an explicit `TIMESTAMPTZ` at 00:30 IST on a Monday — this needs a cluster, which is why it is not in a pure suite |
| `DSH-6` | `master/tests/dashboard.integration.test.ts` | The pipeline breakdown excludes converted leads and names stages from `pipeline_stages`, never from a hardcoded list. Its element is `{ stageId, stageName, sequence, colourHex, leadCount }` — `04-API-CONTRACT.md` owns the type |
| `DSH-7` | `master/tests/dashboard.integration.test.ts` | `buildSnapshot` still succeeds for an actor missing several module permissions — adding the dashboard must not make the snapshot all-or-nothing |
| `DSH-8` | `master/tests/dashboard.integration.test.ts` | `SyncSnapshot.dashboard` equals what `dashboard:get` returns for the same actor |
| `DSH-9` | `master/tests/dashboard.integration.test.ts` | **`openConflictCount` and `pendingSyncCount` are optional and gated on `sync.resolveConflicts`** — present for a holder, **absent** (not `0`) for everyone else, asserted as `'openConflictCount' in summary === false`. They are per-figure gated like every other number on the card, because a count of unresolved conflicts is a statement about company data, not an ungated operational reading |

`DSH-1` closes exactly half of a known hole and no more. `forCurrentUser` today re-masks only
`field.saleRate.view` — correctly, for whoever is signed in *now* — and does **no module-level
filtering**: `/api/snapshot` and the SSE `snapshot` event hand the browser every lead and order row
regardless of `leads.view`. The tab is hidden; the data is not. This batch must not widen that hole,
and `DSH-1` makes a *newly added collection* a compile error rather than a silent leak. Closing the
module-filtering half needs its own owner (§9).

**`office/tests/module-forwarding.test.ts` — pure**, driving `createApp()` with supertest and a
mocked `masterConnection` in the established `office/tests/user-session.test.ts` style (`vi.mock` of
`../src/config/index.js` and `../src/realtime/master-connection.js`, with `MasterCommandError`
reproduced faithfully because mocking the module replaces every export).

| Gate | Proves |
|---|---|
| `OFF-1` | **Every Office route for all six modules answers 503 `{ error: 'unavailable' }` when the Master is unreachable** — decided from `MasterCommandError.unreachable`, the transport flag, never from the message text |
| `OFF-2` | **None of them enqueues a mutation.** The outbox is asserted empty after every offline refusal. A queued render would emit a legally-shaped quotation hours later against a lead whose lines had since changed |
| `OFF-3` | A refusal the Master *sent* surfaces as 403 with `error: 'forbidden'` and `details.permission`, not as 503 — refused is not silent |
| `OFF-4` | Structured conflict data (`blockedBy`, the rename `suggestion`, `storedVersion`) survives the hop into the response body (with `PRE-8`) |
| `OFF-5` | i18n is the sole module with no Master round-trip: the locale picker and `t()` work with the link down, because both catalogues are compiled into the bundle |

### 6.9 Cross-cutting guards

**`master/tests/migration-registry.test.ts` — pure, source-reading. The guard that five simultaneous
migrations make necessary.**

`master/src/db/migrations/index.ts` is an explicit hand-maintained array (`:30-38`). A migration file
written but **not imported does not exist** — Knex never runs it, no schema appears, and *nothing
turns red*. With five files landing at once (`20260305` … `20260309`) against a hand-maintained list,
this is the most likely silent failure in the batch.

| Gate | Proves |
|---|---|
| `GRD-1` | **Every `.ts` file in `master/src/db/migrations/` except `index.ts` appears as a `name` in the `migrations` array** |
| `GRD-2` | Every `name` in the array has a file on disk, and each `name` equals its filename minus `.ts` |
| `GRD-3` | The array is in strictly increasing timestamp order — the registry header's "add to the end, never reorder" stated mechanically |
| `GRD-4` | **Every table any migration creates is either in `DATA_TABLES` or in an inlined, justified configuration allowlist.** Scan the migration sources for `CREATE TABLE <name>`, subtract tables a later migration renames or drops, compare against `fixtures.ts` |

`GRD-4` needs an honest caveat written into the test: the tree contains `leads_new` and
`inventory_stock_new`, created and then renamed inside `20260302`, so the scan needs an explicit
exception list with a comment per entry. That is a feature — an unexplained exception is a thing a
reviewer asks about.

`GRD-1` should read the *imported array*, not the text of `index.ts`: importing catches a `name`
string that does not match its import, which a text scan comparing two regexes would not. It also
means `pretest`'s `build:shared` must have run, which it always has.

**`shared/tests/permissions.test.ts` — pure. A NEW file, from `08-PERMISSIONS.md` §7.**

`shared/tests/` holds exactly two files today, `discovery.test.ts` and `sync.test.ts`. There is no
permissions suite to extend, and calling this an extension would hide a whole new file from the
register and from the file-count check in §5.

| Gate | Proves |
|---|---|
| `PRM-1` | The eleven new keys are present in `PERMISSIONS` |
| `PRM-2` | `minimumTierFor` returns the tier `08-PERMISSIONS.md` §2 states, for **every** new key — that document is the authority on tiers and this test is what binds the code to it |
| `PRM-3` | `allowedForTier('office')` excludes `documents.delete` and `recycleBin.viewAll`, and includes `fields.view` |

**`master/tests/permission-enforcement.test.ts` — pure, source-reading. A NEW file, from
`08-PERMISSIONS.md` §7.**

| Gate | Proves |
|---|---|
| `PRM-4` | Every key in `PERMISSIONS` appears in at least one `requirePermission(` call under `master/src/services/`, **or** in a named indirect-enforcement helper (`canSeeRates`, `canEditRates`, `RESTORE_PERMISSION`, `REQUIRED_PERMISSION`), **or** on an explicit inlined allow-list. The allow-list is the point: adding to it is a visible act in a diff, whereas a key that enforces nothing is invisible. This is the automated form of `HANDOFF.md`'s "a permission that enforces nothing" rule, in the `credential-invariants.test.ts` style — `readFileSync`, never `grep` (§2.6) |

**`master/tests/migration-grant.integration.test.ts` — integration. A NEW file, from
`08-PERMISSIONS.md` §7.** The gates for `20260309` (Stage 7):

| Gate | Proves |
|---|---|
| `PRM-5` | Running `20260309` twice grants the same set — idempotent by union, not by replace |
| `PRM-6` | An admin role holding a hand-added key **keeps** it: the merge is a union, and a replace would silently strip an administrator's deliberate grant |
| `PRM-7` | A management-tier role gains nothing; no role below `admin` gains a key |
| `PRM-8` | A soft-deleted admin role is granted too — otherwise restoring it later produces an administrator missing half the batch, and nothing turns red |
| `PRM-9` | **A role whose stored `permissions` array contains a duplicate is still granted.** The no-op test is `NEW_KEYS.every((key) => stored.includes(key))` and **never** a length comparison: `permissions` is JSONB with no uniqueness constraint, so one duplicate makes the merged set no longer than the stored array and a length test skips a role that needs the grant. This gate is the reason the rule is written that way, and it fails against the length form |
| `PRM-10` | Every key the batch minted appears in the migration's frozen inlined list — the test reads the catalogue **and** the migration source and compares, so a key minted at Stage 6 and forgotten at Stage 7 turns red |

**Extensions to existing suites** — no new files:

| Gate | File | Proves |
|---|---|---|
| `GRD-5` | `credential-invariants.test.ts` | Every handler in `log.routes.ts`, `report.routes.ts`, `fields.routes.ts`, `recycle-bin.routes.ts` and `document.routes.ts` carries a `needs(...)` guard: `expect(guards.length).toBe(handlers.length)` per router, with **no** `- 2` — the two exemptions are specific to `access.routes.ts` (the static catalogue, and `/me/password`) and must not be copied |
| `GRD-6` | `credential-invariants.test.ts` | The existing `access.routes.ts` assertion (`credential-invariants.test.ts:73-89`, the `expect` at `:88`) still holds unchanged. Every new router is a *new* file, precisely so this count does not move |
| `GRD-7` | `credential-invariants.test.ts` | No new module calls `recordDetachedActivity` — a grep over the new services returns zero. The detached variant swallows failures into a warning and belongs only to a *failed* operation with no transaction to be atomic with |
| `GRD-8` | `http-api.integration.test.ts` | `/api/logs`, `/api/reports/dispatches`, `/api/recycle-bin`, `/api/fields` and `/api/documents` are added to the `guarded` array (`:108-122`) and return 401 when signed out |
| `GRD-9` | `mappers.test.ts` | `toIsoDate` cases (`master/src/repositories/mappers.ts:79-90`) — see `RPT-5` |
| `GRD-10` | `access.integration.test.ts` | The tier change: a management-tier role can now be saved holding `fields.manage` (`shared/src/domain/permissions.ts:163`); an office-tier role still cannot, and the whole save is rejected naming the key |
| `GRD-11` | `permissions.integration.test.ts` | For each new endpoint, a role lacking the key is refused **with the key named in the error** — the pattern already at `permissions.integration.test.ts:82`. A route answering 404 or 500 instead of a 403 naming the key is indistinguishable from a broken screen |

`GRD-7` is worth stating as a gate rather than a convention because the failure is invisible: a trail
with holes reads as a working trail until the day somebody needs it.

---

## 7. The acceptance gates — the checklist

Tick a row only when the suite has been confirmed to have **run** (§5). Grouped by
`11-BUILD-SEQUENCE.md`'s **Stage 0 – Stage 8**, because a gate for Stage 5 cannot be met before
Stage 1. The old "build step 1–9" numbering is retired; if a heading below reads *Step N*, it is
stale and this scheme wins.

### Harness (§3) — before anything

- [ ] `HRN-1` `credential-invariants.test.ts` is committed to `dev`
- [ ] `HRN-2` `ORDERBOOK_REQUIRE_INTEGRATION=1` makes a missing cluster an import-time error
- [ ] `HRN-3` `ORDERBOOK_PG_BIN` is verified, not trusted; a bogus path throws with the directory named
- [ ] `HRN-4` Baseline recorded: `npm run verify` reports 21 files / 333 tests, 0 skipped

### Stages 0–1 — the socket ack, the cursor codec, and i18n

- [ ] `PRE-1`…`PRE-6` cursor codec: round-trip, microsecond precision, BIGINT-as-string, tamper rejection, base64url, opacity
- [ ] `PRE-7` `respond()` passes `code` and `details` for any `AppError`, not only `ForbiddenError`
- [ ] `PRE-8` `forward()` surfaces `details` into the response body
- [ ] `I18N-1` `hi.ts` is total (fails `npm run typecheck`, not just `npm test`)
- [ ] `I18N-2` every `PERMISSIONS` key has a token
- [ ] `I18N-3` every module, capability group, action and role template has a token
- [ ] `I18N-4` placeholder sets are identical per key across EN and HI
- [ ] `I18N-5`…`I18N-8` no formatted numbers in strings; ids byte-identical; missing-key fallback; plural selection
- [ ] `I18N-9` every `recordActivity` `(entityType, action)` pair has a token — source-reading
- [ ] `I18N-10` `ACTIVITY_TOKENS` never retires a token
- [ ] `I18N-11` unknown action renders a fallback rather than an empty cell
- [ ] `I18N-12` **the 333 existing cases pass with no assertion edited** across the **129**-site sweep
- [ ] `I18N-13` `AppError.message === t(messageKey, params)` against EN, for all **68** tokens
- [ ] `recordActivity` is `recordActivity(entry, actor, trx)` **from this stage**, and no new module calls `recordDetachedActivity`
- [ ] `no-untranslated-jsx-text` is registered in `eslint.config.js` at **`'off'`**, and `npm run lint` is clean

### Stage 2 — Recycle Bin (`20260305000000`)

- [ ] `GRD-1`…`GRD-4` migration registry and table registry guards (land these **before** the migration)
- [ ] `BIN-1`…`BIN-4` pure: cursor precision, name escalation, parent graph totality, empty-page-not-refusal
- [ ] `BIN-5`…`BIN-9` paging across **six** tables, ordering, type filter, ownership scope, key-based hiding
- [ ] `BIN-10`…`BIN-14` parent hazard, user-without-role, role reattachment, name collision, code reuse
- [ ] `BIN-15`…`BIN-20` reservation release, invisibility everywhere, `hlc` stamping, `'restored'`, atomic audit, no hard delete
- [ ] `BIN-21`, `BIN-22` the four DELETE routes' 409 policy table, with `blockedBy` naming records; and that it is **not** `PARENT_LINKS`

### Stage 3 — Fields (`20260306000000`)

- [ ] `FLD-1`…`FLD-4` pure: no case-folding, existing-value tolerance, permutation check, hex
- [ ] `FLD-5`…`FLD-8` reorder under the deferrable constraint, default swap, stale permutation, cache invalidation
- [ ] `FLD-9` **removal does not touch a single record row**
- [ ] `FLD-10`…`FLD-14` removed value still editable on both transports; archive rules; one query per set; no `stock_movements` scan; list stays advisory
- [ ] `FLD-15` `fields.manage` is management+; `fields.view` does not gate `GET /api/option-lists`
- [ ] `FLD-16` a panel user lacking `fields.view` still gets a complete snapshot
- [ ] `FLD-17`, `FLD-18` atomic audit; removed values restore through the Bin
- [ ] `FLD-19` **re-run `BIN-5` at eight branches** — `option_list_item` and `custom_field_definition` join here
- [ ] `FLD-20`, `FLD-21` `expectedVersion` mandatory (400 when omitted, 409 with `storedVersion` when stale); the losing writer of a concurrent save does not overwrite

### Stages 4–5 — Logs (`20260307000000`) and Reports

- [ ] `LOG-1`…`LOG-4` keyset paging both directions, BIGINT cursor, malformed-cursor rejection, filters and search
- [ ] `LOG-5`, `LOG-6` actor name survives user deletion, **and is populated for rows written after the migration**
- [ ] `LOG-7` system and null-actor rows render
- [ ] `LOG-8`…`LOG-12` chain verification detects a tampered hash and a broken link; partial ranges; pre-chain rows; cap; **runs in SQL**
- [ ] `LOG-13`, `LOG-14` verification is audited once and listing is not; refusals name the permission
- [ ] `LOG-15` `ActivityLogEntry.hash` is populated, is `string | null`, and is covered by `logs.view`
- [ ] `RPT-1`…`RPT-4` pure range arithmetic, no `Date` constructed
- [ ] `RPT-5` **`toIsoDate` gains its first test coverage ever**
- [ ] `RPT-6` **23:30 IST on the last of the month buckets into that month**
- [ ] `RPT-7`…`RPT-11` SQL month labels; sign of dispatches; BIGINT sums; conversion and loss rules; classifier agreement
- [ ] `RPT-12`, `RPT-13` money keys **absent** for a rate-blind caller, totals computed server-side
- [ ] `RPT-14`…`RPT-16` top-parties ordering, city grouping, first enforcement of `reports.*`
- [ ] `RPT-17` **top parties anchor on `orders.dispatched_at`** — an order created in March and dispatched in April lands in April

### Stage 6 — PDF Designer (`20260308000000`)

- [ ] `PDF-1` **conjunct formation** — fewer glyphs than codepoints
- [ ] `PDF-2` **matra reordering** — the i-matra precedes its consonant
- [ ] `PDF-3`…`PDF-5` four faces load from disk with no network; missing font fails at startup; `LICENSES.md` covers every binary
- [ ] `PDF-6` **rate and lineTotal columns ABSENT** — not zero, not null
- [ ] `PDF-7`…`PDF-10` `showRates: false` wins; model purity; script splitting; IST date at the document layer
- [ ] `PDF-11`…`PDF-15` 409 on duplicate name; `expectedVersion` semantics; default promotion; name freeing; permission refusals
- [ ] `PDF-16`…`PDF-23` redaction end to end; atomic export+audit; crash/tmp sweep; preview writes nothing; storage reachability and 404-not-403; pre-flight subject check; filtered history; concurrent cursor
- [ ] `PDF-24`, `PDF-25` the `DocumentLayout` block grammar (400 with `{ field, block, reason }`); **the eight toggles are COLUMNS, not `layout`**
- [ ] `PDF-26` **re-run `BIN-5` at nine branches** — `document_template` joins here; `POST /api/documents/templates/:id/restore` exists regardless
- [ ] `PDF-27` **`document_exports.superseded_by` is written**, in the render transaction, per `(subjectKind, subjectId, documentType)`

### Stages 7–8 — permission grant (`20260309000000`) and Office Dashboard

- [ ] `GRD-5`…`GRD-11` route-guard counts for five new routers; `access.routes.ts` unchanged; no `recordDetachedActivity`; 401 gates; `toIsoDate`; the `fields.manage` tier change; per-endpoint refusals naming the key
- [ ] `PRM-1`…`PRM-3` the eleven new keys, their tiers, and `allowedForTier('office')` (**`shared/tests/permissions.test.ts`, a NEW file**)
- [ ] `PRM-4` every catalogue key is enforced somewhere, or is on the explicit allow-list
- [ ] `PRM-5`…`PRM-10` grant idempotence; union not replace; nothing below `admin`; soft-deleted admin roles too; **the duplicate-in-`permissions` case that a length comparison skips**; every minted key present in the frozen list
- [ ] `DSH-1`, `DSH-2` **every `SyncSnapshot` key is accounted for** (compile-time totality) and masking is by absence — pure, `office/tests/snapshot-masking.test.ts`
- [ ] `DSH-3` `forCurrentUser` strips figures the session does not hold; staleness labelling — pure, `office/tests/dashboard-staleness.test.ts`
- [ ] `DSH-4`…`DSH-9` per-figure gating; timezone-correct week; stages from the table; snapshot not all-or-nothing; parity with `dashboard:get`; `openConflictCount`/`pendingSyncCount` gated on `sync.resolveConflicts` — **`master/tests/dashboard.integration.test.ts`, not a pure suite**
- [ ] `OFF-1`…`OFF-5` 503 offline on every module route; nothing queued; refused ≠ silent; `details` survive; i18n needs no Master
- [ ] The grant migration grants **only** to `tier = 'admin'`, unions rather than replaces, inlines every key string, and no-ops with `NEW_KEYS.every((key) => stored.includes(key))` — **never a length comparison**

### Final

- [ ] `npm run verify` green with `ORDERBOOK_REQUIRE_INTEGRATION=1`, **0 skipped**, file and test counts matching §8

---

## 8. Baseline and projected additions

**Baseline: 333 tests across 21 files**, `npm run verify` green (`BACKEND_MODULES.md` §9,
`HANDOFF.md`). Files break down as master 16, office 3, shared 2; of the master 16, twelve are
integration suites carrying `describe.skipIf`. One of the 21 — `credential-invariants.test.ts` — is
untracked, so a fresh clone of `dev` runs 20 (§2.6, §3.3).

**This table is THE register.** No other document keeps a second copy of it. `02-FILE-STRUCTURE.md`
places these files in the manifest and must use exactly the names below; `11-BUILD-SEQUENCE.md` §5.2
cites the counts rather than restating them.

This batch adds **23 suites — 15 pure and 8 integration — plus one committed fixture**, and cases
inside five existing files.

| File | Kind | Stage | Cases (projected) |
|---|---|---|---|
| `master/tests/cursor.test.ts` | pure | 0–1 prerequisites | 8 |
| `shared/tests/i18n.test.ts` | pure | 1 — i18n (renderer) | 6 |
| `shared/tests/i18n-coverage.test.ts` | pure | 1 — i18n (contract) | 8 |
| `shared/tests/activity-tokens.lock.json` | **fixture, not a suite** | 1 — i18n | — |
| `master/tests/i18n-tokens.test.ts` | pure | 1 — i18n | 5 |
| `master/tests/migration-registry.test.ts` | pure | cross-cutting, before `20260305` | 6 |
| `master/tests/recycle-bin-domain.test.ts` | pure | 2 — Recycle Bin | 9 |
| `master/tests/recycle-bin.integration.test.ts` | integration | 2 — Recycle Bin | 24 |
| `master/tests/field-values-domain.test.ts` | pure | 3 — Fields | 8 |
| `master/tests/fields.integration.test.ts` | integration | 3 — Fields | 25 |
| `master/tests/logs.integration.test.ts` | integration | 4 — Logs | 20 |
| `master/tests/report-range.test.ts` | pure | 5 — Reports | 11 |
| `master/tests/reports.integration.test.ts` | integration | 5 — Reports | 17 |
| `master/tests/document-fonts.test.ts` | pure | 6 — PDF | 6 |
| `master/tests/document-model.test.ts` | pure | 6 — PDF | 9 |
| `master/tests/document-template.integration.test.ts` | integration | 6 — PDF | 16 |
| `master/tests/document-render.integration.test.ts` | integration | 6 — PDF | 13 |
| `shared/tests/permissions.test.ts` | pure — **NEW file** | 7 — permissions | 5 |
| `master/tests/permission-enforcement.test.ts` | pure — **NEW file** | 7 — permissions | 3 |
| `master/tests/migration-grant.integration.test.ts` | integration — **NEW file** | 7 — the grant | 4 |
| `master/tests/dashboard.integration.test.ts` | integration | 8 — Dashboard | 6 |
| `office/tests/snapshot-masking.test.ts` | pure | 8 — Dashboard | 6 |
| `office/tests/dashboard-staleness.test.ts` | pure | 8 — Dashboard | 5 |
| `office/tests/module-forwarding.test.ts` | pure | Office path, all six modules | 9 |
| *(extension)* `master/tests/mappers.test.ts` | pure | 5 — Reports | +4 |
| *(extension)* `master/tests/credential-invariants.test.ts` | pure | cross-cutting | +6 |
| *(extension)* `master/tests/http-api.integration.test.ts` | integration | cross-cutting | +5 |
| *(extension)* `master/tests/access.integration.test.ts` | integration | 3 / 7 — the `fields.manage` tier change | +2 |
| *(extension)* `master/tests/permissions.integration.test.ts` | integration | 7 — per-endpoint refusals | +5 |

**Projected: ≈ 251 new cases, taking the suite to ≈ 584 across 44 files.** Both figures are planning
estimates derived by counting the gates in §6, not measurements — the file count is exact, the case
count will move as gates split or merge. Use the file count as the hard check in §5 and the case
count as a sanity check.

**Serial cost.** Eight new integration files, each paying `setupDatabase`/`teardownDatabase` and a
`TRUNCATE` per case. The cluster is built once and reused, so the marginal cost is per-file setup
plus per-case truncation — but it is monotonic, and it is the reason to add cases to an existing
suite when the seed is identical rather than minting a file per gate.
`master/tests/migration-grant.integration.test.ts` is the one that most deserves scrutiny on this
count: it exists as its own file because it runs a migration mid-suite, which no other file does.

---

## 9. What this plan deliberately does not test, and open questions

Stated so they are not mistaken for oversights.

1. **The Socket.IO path end to end.** No test in this repo has ever opened a socket connection. The
   ack contract is gated by a source read on the Master side (`PRE-7`) and a mocked-transport test on
   the Office side (`PRE-8`), which together prove the shape but not the wire. Building a socket
   harness — a hub on an ephemeral port plus a real `socket.io-client` — is perhaps 60 lines and
   would retire `PRE-7` properly. **Open question: is it wanted in this batch, or after it?**
   Recommended: after. It is a harness project, not a module, and it earns more once there are ten
   commands to exercise rather than one.
2. **No Office-side integration harness exists.** `canRunIntegrationTests` and the cluster helper
   live in `master/tests/helpers/` and have never been imported from `office/tests`. Every Office
   gate here is therefore a pure suite with a mocked link. That is adequate for what the Office does
   (forward, refuse, or fail) and inadequate for anything that would need a live Master.
3. **Module-level filtering of the Office cached snapshot.** `DSH-1` prevents the hole widening; it
   does not close it. Leads and orders are still served in full to a session lacking `leads.view`.
   Needs its own owner, independently of this batch.
4. **Large CSV/PDF payloads over the 15-second socket ack.** `masterConnection.command` times out at
   15s (`office/src/realtime/master-connection.ts:239-245`) and buffers the whole value on both
   sides. No gate here tests a 250,000-row export over that path, because the decision — cap, chunk,
   or declare export Master-only — has not been made. **A gate cannot be written for an undecided
   behaviour**, and writing one against a guess would be worse than the gap.
5. **Retention and pruning** for `activity_log` and `document_exports` are undesigned, so untested.
   Note that `activity_log_no_delete` means a pruner cannot simply `DELETE`.
6. **`applied_mutations` atomicity** and **`panel:revoked` never being emitted** are pre-existing and
   untouched. The Recycle Bin's new sync-rejection path inherits the former.
7. **Frontend component tests do not exist** and none are added — this batch is backend only, and the
   ten screens belong to `docs/UI_REDESIGN.md`. The typed API client wrappers in
   `master/web/src/api.ts` and `office/web/src/api.ts` are exercised only by `tsc`, and they are the
   **only** web files in the batch: the web i18n layer (`{master,office}/web/src/i18n/*`,
   `LocalePicker.tsx`, `Untranslated.tsx`, `main.tsx`, `styles.css`, `format.ts`,
   `PermissionGrid.tsx`, `AccessScreen.tsx`) is deferred with the screens. The mechanical reason a
   component test could not be written even if the files were here: `vitest.config.ts:7` includes
   `**/*.test.ts` — **`.ts`, not `.tsx`** — and there is no DOM environment configured. **None of
   this touches i18n coverage**: `shared/src/i18n/` is in scope and `shared/tests/i18n.test.ts` plus
   `shared/tests/i18n-coverage.test.ts` verify it completely without a browser (§4, §6.2). What is
   untested is the *rendering* of translated strings, not the strings.
8. **Migrations are excluded from coverage** (`vitest.config.ts:19`). A migration's correctness is
   only ever proved by an integration suite that runs it and asserts on the resulting schema — the
   coverage report will never flag an untested one. `GRD-1`…`GRD-4` prove a migration is *registered*,
   not that it is *right*.
9. **`activity_log` appends serialise per tenant.** `activity_log_chain()` takes
   `pg_advisory_xact_lock(hashtext(tenant_id::text))` on every insert
   (`20260303000000_roles_and_users.ts:256-258`). A test that bulk-inserts thousands of log rows to
   build a paging fixture will serialise behind it and will be slow. Seed the minimum a gate needs.
10. **The `no-untranslated-jsx-text` lint rule is registered `'off'` in this batch** and promoted in
    the UI phase (`09-I18N.md` §8). `lint` is the first step of `verify` and there are ~4,000 unswept
    lines of JSX behind it, so an enabled rule would bury the two numbers §5 requires an implementer
    to read. Its own unit test invokes the rule **directly**, which is the only way to gate a rule
    that is deliberately not firing. **This is not a gap in this batch's gates** — it is a gate
    scheduled for the phase that can meet it.
