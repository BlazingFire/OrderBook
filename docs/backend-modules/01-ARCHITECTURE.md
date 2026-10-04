# 01 — Architecture

The rules every module in this specification set obeys, and the reasoning behind the decisions that
had to be settled once rather than six times.

`docs/BACKEND_MODULES.md` is the canonical plan; this document does not re-decide anything in it. It
exists because four independent module designs collided on five shared resources, and because a
module built without the layering rule in front of the implementer will land as a service full of
SQL. Everything here is verified against the code as it stands, with a `path:line` reference for
every claim, so a reviewer who was not in the room can check it.

**Scope reminder: this batch is backend only.** No screen files, no `App.tsx` edits, no tab-table
entries. The only frontend files any module may touch are the typed API client wrappers in
`master/web/src/api.ts` and `office/web/src/api.ts`. The ten screens belong to the UI phase in
`docs/UI_REDESIGN.md` §8, and so do the **web** i18n files — `{master,office}/web/src/i18n/*`,
`LocalePicker.tsx`, `Untranslated.tsx`, `main.tsx`, `styles.css`, `format.ts`, `PermissionGrid.tsx`
and `AccessScreen.tsx`. That defers the *renderer*, not i18n: **`shared/src/i18n/` is in scope** and
is fully testable through `shared/tests/` without a single web file existing. `02-FILE-STRUCTURE.md`
is the sole authority for the manifest and the scope boundary.

---

## 1. The layering as it actually is

Decision 12 in `HANDOFF.md` states the rule; the 2026-08-21 refactor made it true of the Master
server. It is four layers plus infrastructure, and the boundaries are enforced by what each layer is
allowed to import rather than by any tooling.

| Layer | Directory | Owns | Must never |
|---|---|---|---|
| Domain | `master/src/domain/` | Pure rules, invariants, types | Import Knex, Express, Socket.IO, or any repository/service. No I/O of any kind |
| Services | `master/src/services/` | Use cases: permission checks, ordering, the transaction boundary | Build a query. Import `Knex`. Know that Socket.IO exists |
| Repositories | `master/src/repositories/` | Every SQL statement in the product | Check a permission, or decide policy |
| Transport | `master/src/http/`, `master/src/realtime/` | Parse, delegate, serialise | Aggregate, branch on business state, or query the database |
| Infrastructure | `master/src/lib/`, `master/src/db/`, `master/src/pdf/` | Framework-facing helpers with no business rule | Hold a rule that belongs in `domain/` |

`master/src/domain/access.ts` is the reference for what "pure" means in this repository. Its entire
import list is `@orderbook/shared`, `../lib/errors.js` and `./actor.js` (`domain/access.ts:14-18`),
and every export is an `assertX` named after the guard it implements. It throws the shared `AppError`
subclasses, so the same rule produces a 409 over HTTP and a `{ ok: false }` ack over the socket with
no branch anywhere in the rule itself.

The Office server has no repository layer because it has no database. Its directories are
`config/`, `discovery/`, `http/`, `lib/`, `realtime/`, `services/`, `sync/` — the same rule applies
with `sync/` (the local store and outbox) standing in for persistence.

### 1.1 `TransactionContext`, and why Knex never leaves repositories

```ts
// master/src/repositories/transaction.ts:13
export type TransactionContext = Knex.Transaction;
```

The alias is the whole mechanism. A service receives the token, threads it into every repository call
in the unit of work, and never inspects it — so the query builder stays an implementation detail of
one directory instead of appearing in every service signature
(`repositories/transaction.ts:1-13`).

The rule has one precise edge that is easy to state wrongly. **Services do open transactions**:
`role.service.ts:73` is `await db().transaction(async (trx) => { … })`, and `db` is imported from
`../db/knex.js` at `role.service.ts:24`. That is deliberate — the transaction *boundary* is a
use-case decision, so the service must own it, and the `trx` parameter's type is inferred from the
callback rather than written out. What a service must never do is **use** that handle as a query
builder. The moment `trx('some_table')` or `db()('some_table')` appears in a service, the layer has
been crossed. `dashboard.service.ts:51-54` is exactly that mistake, live today (§6.1).

Repositories declare the two halves differently, on purpose:

```ts
// reads — the same function serves a pooled read and an in-transaction read
type Runner = Knex | Knex.Transaction;                       // role.repository.ts:25
export async function listRoles(tenantId: string, runner: Runner = db()): Promise<Role[]>
                                                             // role.repository.ts:43

// writes — required, so "forgot to pass the transaction" is a compile error
export async function insertRole(role: NewRole, trx: TransactionContext): Promise<string>
                                                             // role.repository.ts:178
```

Every new repository copies that split. `type Runner` is declared privately per file (it appears
identically in eighteen repositories, e.g. `party.repository.ts:15`, `user.repository.ts:26`) rather
than exported from one place — that is the existing convention and new files should match it rather
than "improve" it mid-batch.

### 1.2 Two-layer permission checks

A permission is checked twice, and both are required:

- **Route middleware** — `requirePermissionMiddleware` (`http/middleware/require-auth.ts:65-73`),
  mounted between the path and the handler in `access.routes.ts` (`access.routes.ts:36`, then
  `:48`, `:56`, `:64`, `:72`, …). It refuses early so a doomed request never opens a transaction.
- **Service** — `requirePermission(actor, key)` as the first statement of the function
  (`role.service.ts:58`, `:116`, `:205`, `:258`).

The service check is the load-bearing one. **Office Panel commands arrive through
`master/src/realtime/hub.ts` and never touch Express**, so the middleware is bypassed entirely on
that path. A module whose permission check lives only in the route is unprotected for every Office
Panel user — and since every module in this batch is reachable from both panels, that is not a
theoretical exposure.

`data.routes.ts` applies `requireAuth` only and relies on the service check alone. **New routers copy
`access.routes.ts`, not `data.routes.ts`.** `master/tests/credential-invariants.test.ts:73-89` pins
`access.routes.ts`'s handler and guard counts by reading the source, because
`requirePermissionMiddleware` was once defined, exported and mounted nowhere; a new module must not
add handlers to that file and break the count.

---

## 2. Worked example: `POST /api/access/roles`, end to end

This is the shape every module in this batch copies. Read it once with the files open; it is faster
than re-deriving the convention from six module documents.

```
HTTP request
  │
  ├─ app.ts:23-25       express.json({limit:'2mb'}) → cookieParser() → attachSession
  │                      attachSession never rejects: an unauthenticated request simply
  │                      arrives with req.user undefined
  │
  ├─ app.ts:40          app.use('/api/access', accessRoutes)   ← above the bare '/api' at :41
  │
  ├─ access.routes.ts:25   accessRoutes.use(requireAuth)        → 401 if !req.user
  ├─ access.routes.ts:72   needs('roles.create')                → 403 { details: { permission } }
  ├─ access.routes.ts:73-75
  │      asyncHandler(async (req, res) => {
  │        res.status(201).json(await roleService.createRole(req.body, actorFromRequest(req)));
  │      })
  │                      the handler parses and delegates. No policy, no aggregation.
  │
  ├─ require-auth.ts:81-92  actorFromRequest → ActorContext { tenantId, actorType:'user',
  │                          actorId, userId, permissions, deviceCode:null }
  │
  ▼
role.service.ts:57-109  createRole(input, actor)
  1  requirePermission(actor, 'roles.create')             :58   ← the gate that also covers sockets
  2  assertAdminTier(actor, 'roles.create')               :59   ← pure guard, domain/access.ts:21
  3  name/tier validation, ValidationError from lib/errors :61-64
  4  assertTierWithinActor / assertPermissionsWithinTier   :65-66
  5  assertNameAvailable(await roleRepo.isNameTaken(…))    :67-71 ← read outside the transaction
  6  await db().transaction(async (trx) => {              :73
       const hlc = await nextHlc(trx)                     :74
       roleRepo.insertRole({…}, trx)                      :76-87
       activityLog.recordActivity({…}, trx)               :89-99  ← inside, atomic with the insert
                                                                    (two-arg today; Stage 1 makes it
                                                                     (entry, actor, trx) — §3.3)
     })
  7  re-read the row after commit                          :104
  8  publishChange({ entity:'role', action:'created', … }) :107  ← after commit, never inside
  9  return                                                :108
  │
  ├─ role.repository.ts:178  insertRole(role, trx)  — the only place Knex appears
  │
  └─ change-bus.ts:19  publishChange → hub.ts:82 fan-out
         hub.ts:114   DIRECTORY_ENTITIES = { 'role', 'user' } — withheld from panels;
                      everything not in that set is broadcast to every paired panel
```

Failure path: any throw inside the handler is caught by `asyncHandler`'s `.catch(next)` and lands in
`errorHandler` (`http/middleware/error-handler.ts:19-33`), which emits
`{ error: <code>, message, details? }` at `error.statusCode`. The `error` field is the **lowercase
snake_case** `AppError.code` — `'conflict'`, `'validation_error'`, `'forbidden'` — not the uppercase
token `docs/ROLES_AND_USERS.md` §13 uses in prose. The Office server branches on the lowercase form
(`office/src/http/app.ts:454`), so lowercase is the real contract and new code branches on it.

Six properties of that trace are non-negotiable for new modules:

| Property | Where it is visible | Why |
|---|---|---|
| Actor last in the signature, no `tenantId` parameter | `role.service.ts:57` | The tenant comes from the session; no caller can name someone else's |
| Guards are pure `assertX` in `domain/` | `domain/access.ts:21-169` | A rule inline in a service is unreachable from the socket path and untestable without a database |
| Reads before the transaction, writes inside it | `role.service.ts:67-102` | Keeps the transaction — and the `activity_log` advisory lock — as short as possible |
| `recordActivity` inside the transaction — in its new three-argument form, `recordActivity(entry, actor, trx)` (§3.3) | `role.service.ts:89-99` | The trail and the change commit together or not at all |
| Re-read after commit, then publish | `role.service.ts:104-107` | A panel that received figures from a transaction that then rolled back would show numbers that never existed (`inventory.service.ts:180-186`) |
| One file header saying *why* | every file in `master/src` | The repository's documentation convention; a new file without one is out of place |

**The asymmetry this example also shows.** Roles and users are reachable over HTTP and have **no
socket commands at all**, so the Office Panel cannot reach them. That is the gap this batch must not
repeat: every module here needs an entry in `ClientToServerEvents`
(`shared/src/protocol/socket.ts`) *and* a line in `registerCommands()` (`hub.ts:204`) using the
existing `run(ack, actor => …)` shape (`hub.ts:205-206`), or "reachable from both panels" is not
true of it.

---

## 3. Anatomy of a new module

### 3.1 Files, in the order they are written

The order is forced by the build, not by taste. **`shared/` is consumed as compiled output, not
source** (`HANDOFF.md`, Traps): nothing in `master/` can import a type that has not been through
`tsc`, which is why `prepare` and the `pre*` scripts exist. Types first, always.

| # | File | Layer | May import | Must not import |
|---|---|---|---|---|
| 1 | `shared/src/domain/<module>.ts` | contract | other `shared` types | anything from `master/` or `office/` |
| 2 | `master/src/db/migrations/<ts>_<name>.ts` | schema | `knex` types only | **any live constant from `@orderbook/shared`** |
| 3 | `master/src/domain/<rule>.ts` | domain | `@orderbook/shared`, `../lib/errors.js`, `./actor.js` | Knex, Express, repositories, services |
| 4 | `master/src/repositories/<x>.repository.ts` | repository | `knex`, `../db/knex.js`, `./transaction.js`, `./mappers.js`, shared types | services, `domain/` guards, `lib/errors` for policy |
| 5 | `master/src/services/<x>.service.ts` | service | `domain/`, `repositories/`, `../db/knex.js` (for `.transaction()` **only**), `change-bus.js` | `knex`, Express, Socket.IO |
| 6 | `master/src/http/routes/<x>.routes.ts` | transport | the service, `asyncHandler`, `require-auth.js`, `lib/errors` for input shape | repositories, `domain/` |
| 7 | `shared/src/protocol/socket.ts` (edit) | contract | — | — |
| 8 | `master/src/realtime/hub.ts` (edit) | transport | the same service the route calls | anything else |
| 9 | `office/src/http/app.ts` (edit) | transport | `forward()` only | any business decision |
| 10 | `{master,office}/web/src/api.ts` (edit) | client | shared types | — |
| 11 | `master/tests/<x>-domain.test.ts` | test | `domain/` only | — **must be pure** |
| 12 | `master/tests/<x>.integration.test.ts` | test | the helpers in `master/tests/helpers/db.ts` | — |

Two mounting rules, both of which fail silently when broken:

- **Mount above `app.ts:41`.** `app.use('/api', dataRoutes)` is mounted at bare `/api`, so a router
  added after it at a path `dataRoutes` also matches is shadowed. New mounts go with the other
  specific ones at `app.ts:36-40`.
- **Everything lives under `/api`.** `app.get(/^(?!\/api).*/, …)` at `app.ts:50` is the SPA fallback;
  a route outside `/api` returns `index.html` rather than a 404, which reads as a broken screen
  rather than a missing route.

### 3.2 Every module ships at least one pure test suite

`describe.skipIf` reports "skipped" in a line most people read as green, and the Windows Postgres
lookup was broken for months while every integration gate silently did nothing (`HANDOFF.md`,
Traps). Each module's highest-risk logic — the cursor codec, the date arithmetic, the font shaping,
the masking — therefore lands in `domain/` and is pinned by a suite with **no** `describe.skipIf`, so
it cannot skip. That is the single strongest argument for the domain layer beyond tidiness: purity is
what makes the gate unskippable.

### 3.3 What a module inherits without restating it

These are settled elsewhere in the set and named here only so no module document has to argue them
again:

- **`recordActivity(entry, actor, trx)`, never `recordDetachedActivity`.** The signature grows a
  middle `actor` parameter (`activity-log.repository.ts:51` takes `(entry, trx)` today), and **that
  change lands in Stage 1, the foundation stage — not at the Logs stage.** The reason is that `actor`
  is harmless before `activity_log.actor_name` exists: the repository simply does not persist it yet,
  and `20260307` adds the column and starts persisting it. Taking the parameter early means Recycle
  Bin and Fields are written once against the final signature instead of being swept a stage later,
  and a sweep across call sites is exactly the operation that misses one. The detached variant
  swallows failure into a `log.warn` (`activity-log.repository.ts:76-93`) and exists for a *failed*
  operation with no transaction to belong to — a refused sign-in. Fourteen call sites across six
  existing services still use it; that is a known inconsistency, not a precedent.
- **Redacted fields are absent, never `null` and never `0`.** `maskFields()` deletes the key
  (`shared/src/domain/permissions.ts:300-312`). A confident `₹0.00` is worse than a blank.
- **Never `toISOString()` on a DATE-derived value.** Month buckets are computed in SQL against the
  configured timezone and returned as `'YYYY-MM'` TEXT.
- **The actor is resolved per command**, never captured per connection (`hub.ts:195-206`), and
  offline is decided from the transport flag, never by reading an error message
  (`office/src/realtime/master-connection.ts:40-60`).
- **New sensitive entities must be added to `DIRECTORY_ENTITIES`** (`hub.ts:114`) — the set is
  allow-by-default, so anything not listed is broadcast to every paired panel.

---

## 4. Cross-cutting decisions, and why

Five shared resources had four claimants each. These are the resolutions and the reasoning; a module
document that contradicts one of them is wrong.

### 4.1 One `CursorPage<T>`, minted once

```ts
// shared/src/domain/inputs.ts — beside the existing offset-based Paginated<T> (inputs.ts:268)
export interface CursorQuery { cursor?: string; direction?: 'older' | 'newer'; limit?: number }
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;   // null for one-directional feeds
  limit: number;
}
```

**Why it must be minted once, and why it is a compile error rather than a merge conflict.** Three
designs each added `CursorPage<T>` to the same file, two of them with structurally different shapes
— `{ items, nextCursor }` versus `{ items, newerCursor, olderCursor, limit }`. `shared/src/index.ts`
is eleven `export *` lines (`shared/src/index.ts:1-11`), so the package's entire public surface is a
flat namespace: two declarations of one exported name in `domain/inputs.ts` is a duplicate-identifier
error, and it breaks **all four packages** at once, not just the one that landed second. Nobody gets
a conflict marker to resolve; the build simply stops for everyone.

`Paginated<T>` stays (`inputs.ts:268-273`). It is offset-based and still correct for the existing
list endpoints. The new type is a sibling, not a replacement — **no page numbers anywhere** in the
new modules, per the UI spec.

### 4.2 One cursor codec

`master/src/domain/cursor.ts` — pure, opaque base64url, no I/O. Three designs each proposed their own
(`log-cursor.ts`, `cursor.ts`, and one inline inside `recycle-bin.ts`). Module-specific cursor
*payloads* build on the one codec.

The reason to unify is not tidiness. A cursor is an opaque token a client round-trips; three encoders
means three formats a client cannot tell apart, three places to get base64url padding wrong, and
three pure test suites pinning the same arithmetic. It lives in `domain/` because it is arithmetic
with no I/O, which is also what makes its test suite unskippable (§3.2).

### 4.3 Migration timestamps, allocated up front

| Timestamp | File | Owner |
|---|---|---|
| `20260305000000` | `_soft_delete_columns.ts` | Recycle Bin |
| `20260306000000` | `_field_values_and_stage_ordering.ts` | Fields |
| `20260307000000` | `_activity_log_actor_name.ts` | Logs (report indexes fold in here) |
| `20260308000000` | `_document_templates_and_exports.ts` | PDF Designer |
| `20260309000000` | `_new_module_permission_grant.ts` | **Shared — one migration, last** |

**Why allocation up front, rather than "pick the next free number when you write it".** Three designs
each claimed `20260305000000` *and* `20260306000000`. The registry at
`master/src/db/migrations/index.ts:30-37` is an explicit hand-maintained array with no directory
scan — the header states the reason (`index.ts:1-13`): importing them makes the set and its order a
compile-time fact. The cost of that choice is the failure mode it creates: **a migration file that is
written but not imported does not exist.** Nothing turns red. The schema is simply not there, and the
first symptom is a query failing against a missing column at runtime, probably on the owner's
machine.

Two consequences for every migration file in this batch:

- `Migration.down` is a **required** member of the interface (`index.ts:27`), so every file exports
  one even when it is deliberately empty with a comment justifying that — the `20260304` precedent.
  In this batch that applies to `20260305`, `20260306` and `20260309`: dropping `deleted_at` would
  resurrect every soft-deleted row in the database, which is a worse outcome than an un-reversible
  migration. `20260307` and `20260308` add tables and columns nothing else depends on, so they get a
  real `down()`. `03-DATABASE.md` is the sole authority for the per-migration `down()` policy and the
  DDL; this table allocates only the timestamps.
- **A migration must never import a live shared constant.** `20260301` imported the permission
  catalogue from `@orderbook/shared`, so editing the catalogue later retroactively changed what an
  already-applied migration had done. Inline and freeze. Note that
  `20260303000000_roles_and_users.ts:21` still does `import { allPermissions } from
  '@orderbook/shared'` and spends it at line 331 — that is live, and the recorded decision is to
  **leave it**: the union-based grant migration (§4.4) makes the outcome correct on every install
  regardless, and editing an applied migration is the more dangerous of the two rules to break.

A **migration registry guard test** lands before the first new migration. Five files arriving at once
against a hand-maintained array is exactly the situation the silent no-op was waiting for.

### 4.4 One permission-grant migration, one policy

**`20260309000000_new_module_permission_grant.ts`, last, granting every new key to `tier = 'admin'`
only, union-not-replace, key strings inlined and frozen.**

**Why one migration.** Three designs each wrote their own, with three different policies. Even if all
three were individually defensible, three grant migrations over the same JSONB column means the
outcome depends on the order they ran, which is precisely the property a permission set must not
have.

**Why admin-only.** One of the three granted new keys to **every existing role**. That is the act the
no-wildcard rule exists to prevent. The catalogue states it plainly:

> There is no wildcard, deliberately. A wildcard would silently add every permission the product ever
> gains to a role somebody approved before those permissions existed.
> — `shared/src/domain/permissions.ts:227-230`

Granting `recycleBin.view` to a role nobody re-approved is the same act with extra steps, and it is
worse here than a wildcard would be, because a wildcard is at least visible as a wildcard. **Non-admin
roles receive the new keys through the permission grid, from an administrator who chooses them.**

**Why union-not-replace.** The migration must converge on two different starting states — a fresh
install, where `20260303`'s live import already granted the admin role everything in today's
catalogue, and the owner's already-migrated database, where it did not. Unioning and sorting is
correct on both; replacing is correct on neither. Sorting matters for a second reason: the stored
array is sorted on write so an identical set is identical bytes and a reorder is not an edit
(`docs/ROLES_AND_USERS.md` §5).

**Why the no-op test is membership, never length.** A role is skipped only when
`NEW_KEYS.every((key) => stored.includes(key))`. Comparing lengths instead — "the stored array is
already long enough, so it must already have them" — skips a role whose stored array happens to
contain a duplicate, and that role then never receives the grant. The algorithm itself belongs to
`08-PERMISSIONS.md`; this is the property that makes it converge.

**Why the key strings are inlined.** Same rule as §4.3. A grant migration that imports the catalogue
it is granting from is a migration whose historical effect changes every time somebody edits a
TypeScript file.

One catalogue change accompanies the grant: **`fields.manage` lowered `admin` → `management`**
(`MINIMUM_TIER` at `permissions.ts:157-181`, `'fields.manage': 'admin'` at `:163`). Fields *reading*
is ungated (`fields.view`, no ceiling); Fields *editing* is management-and-above. Lowering a ceiling
never strips a stored key — `effectivePermissions` filters upward only (`permissions.ts:213-220`) —
so no tier-repair migration is needed, unlike the `20260304` case. `08-PERMISSIONS.md` is the sole
authority for the key list, the tiers and the grant-migration algorithm; this section states only the
policy the algorithm implements.

### 4.5 One timezone config key

```ts
// master/src/config/index.ts — alongside http/database/session (config/index.ts:33-67)
locale: {
  timeZone: process.env.ORDERBOOK_TIMEZONE ?? 'Asia/Kolkata',
}
```

Two designs added the same `ORDERBOOK_TIMEZONE` variable at two different config paths
(`config.reporting.timeZone` and `config.locale.timeZone`). One env var read into two keys is worse
than either alone: half the product agrees with the operator's `.env` and half does not, and the
divergence shows up as reports and documents dated a day apart.

`locale` rather than `reporting`, because the same key serves i18n date formatting later.

**Validated once at startup**, after `runMigrations()` (`master/src/index.ts:32`), with
`SELECT now() AT TIME ZONE $1`, aborting with a message naming the variable if Postgres raises
`invalid_time_zone`. Nothing pins a timezone today — `buildKnexConfig` passes only
client/connection/pool/migrations (`db/knex.ts:10-24`) and there is no `SET TIME ZONE` anywhere — so
a mistyped zone would otherwise surface as quietly wrong month buckets rather than a refusal to
start. This is the mitigation for the defect that already bit once: `DATE` columns came back a day
early east of UTC because `toISOString()` converts to UTC first, and the owner's machine is IST.

### 4.6 The socket ack must carry `details` — Stage 0, built first

```ts
// shared/src/protocol/socket.ts:142-159 — the { ok: false } arm today
| { ok: false; error: string; code?: string; missingPermission?: string }
```

`code` is declared and documented as load-bearing, and **the Master never sets it**: `respond()`
(`hub.ts:391-406`) sets `missingPermission` for a `ForbiddenError` and otherwise sends only
`error`. `details` is not on the type at all. The consequences chain:

- `office/src/http/app.ts:454` does `res.status(code === 'forbidden' ? 403 : 502)`, so **every**
  Office-side refusal — permission denials included — reaches the browser as 502
  `master_command_failed`.
- A `ConflictError`'s `storedVersion` and `diff` (`domain/access.ts:195-202`) and
  `assertNameAvailable`'s `{ field, value }` (`domain/access.ts:160-169`) do not survive the socket
  path at all. Over HTTP they do — `error-handler.ts:28-32` spreads them — so the two transports
  disagree about what a refusal contains.

Two modules depend on structured conflict data reaching the Office browser: the Recycle Bin's
`blockedBy` list and its rename `suggestion`, and the PDF Designer's `storedVersion`/`diff` on a
stale template edit. Without this the Office Panel can only show English prose, and "branch on the
code, never on the message" becomes impossible on exactly the panel where it matters most.

**~15 lines, one owner, and the whole of Stage 0** — stages are numbered 0 through 8 and
`11-BUILD-SEQUENCE.md` is the sole authority for that ordering:

| File | Change |
|---|---|
| `shared/src/protocol/socket.ts:142-159` | add `details?: Record<string, unknown>` to the `{ ok: false }` arm |
| `master/src/realtime/hub.ts:391-406` | in `respond()`, set `code` and `details` for any `AppError`, not only `ForbiddenError` |
| `office/src/realtime/master-connection.ts:48-60` | carry `details` on `MasterCommandError` beside `code` and `missingPermission` |
| `office/src/http/app.ts:438-462` | pass `details` through `forward()` alongside the permission it already forwards |

It is first because two modules are blocked on it and because it is the cheapest possible change that
makes the two transports agree.

### 4.7 The Office path is uniform: forwarded live, hard-fail offline

Every module is forwarded to the Master live and **fails hard offline with 503
`{ error: 'unavailable' }`**. `forward()` already maps `MasterCommandError.unreachable` to exactly
that (`office/src/http/app.ts:443-446`). The mechanism invents nothing: one event in
`ClientToServerEvents`, one line in `registerCommands()`, one `forward(res, '<event>', payload)`
route registered **after** the positional `app.use('/api', requireUser)` gate at
`office/src/http/app.ts:133`.

**Nothing is queued into the outbox**, deliberately. A queued render would emit a legally-shaped
quotation hours later against a lead whose lines had since changed; a queued delete or field edit has
the same character. This matches the roles/users precedent, where no mutation kind exists either.

i18n is the sole exception, and only because it needs nothing from the Master: the catalogue is compiled into the panel's bundle before it ever contacts one.

---

## 5. Known-open, and deliberately not closed here

Named so they are not mistaken for oversights, and so no module document specifies work against them:
`applied_mutations` atomicity; `panel:revoked` never being emitted; the audit trail's fourteen
best-effort call sites across six existing services; the Office snapshot's lack of **module**-level
filtering (`forCurrentUser()` at `office/src/http/app.ts:395-407` re-masks `field.saleRate.view` for
whoever is signed in now — that half is fixed; filtering rows by `*.view` is the open half);
retention and pruning for `activity_log` and `document_exports`; and large CSV/PDF payloads crossing
the 15-second socket ack (`office/src/realtime/master-connection.ts:239-244`).

---

## 6. Layering violations to fix, not copy

These exist in the code today. A new module that copies them inherits the defect, and two of them are
in files an implementer will reasonably open as a reference.

### 6.1 `dashboard.service.ts` queries the database directly

```ts
// master/src/services/dashboard.service.ts:51-54
const rows = await db()('applied_mutations')
  .where({ tenant_id: tenantId })
  .andWhere('applied_at', '>=', db().raw("now() - interval '1 hour'"))
  .count<Array<{ count: string }>>('mutation_id as count');
```

That is Knex in a service — a query builder, a table name and a raw SQL fragment, all outside
`repositories/`. Every other counter on that summary goes through a service that goes through a
repository (`dashboard.service.ts:20-29`).

**Fix, owned by the Office Dashboard module:** `master/src/repositories/dashboard.repository.ts`
takes `countRecentMutations`, plus the new `leadCountsByStage` and `dispatchedThisWeek`. The service
keeps the `Promise.all` and the permission gating. This is the one layering repair in the batch, and
it is small.

### 6.2 Chain verification must not open its own transaction in the service

The Logs module runs chain verification in a read-only transaction with
`SET LOCAL statement_timeout = '30s'`. If the service issues that itself, it is §6.1 again with a
different table. **The `SET LOCAL`, the transaction and the ordered walk all belong inside
`activityLogRepo.verifyChain(tenantId, window, runner)`**; the service function `verifyLogChain`
clamps the window and checks the `logs.verifyChain` permission. The repository/service split of names
is deliberate and `02-FILE-STRUCTURE.md` is the authority for it — note in particular that
`chainBounds` and `streamForExport` are two different repository functions, not two names for one.

The verification itself must run **in SQL**: the digest covers `details::text`, which is Postgres's
own JSONB rendering, so Node cannot reproduce the bytes.

### 6.3 Two repositories break the `TransactionContext` convention — do not copy them

| File | What it does | Why it matters |
|---|---|---|
| `master/src/repositories/inventory.repository.ts:223-226` | `applyMovement(request, existingTrx?: Knex.Transaction)` — optional, typed `Knex.Transaction`, and **opens its own transaction when none is passed** | Calling it from inside a service transaction without threading `trx` runs it on a different connection, defeating atomicity silently |
| `master/src/repositories/master-config.repository.ts:29` | `trx?: Knex.Transaction` | Same optional-transaction shape |

Both predate the convention. New repository writes take a **required** `trx: TransactionContext` and
never open a transaction of their own — the transaction boundary is the service's decision, and a
repository that can quietly open one makes "is this atomic?" unanswerable by reading the service.

### 6.4 `data.routes.ts` is not the template

It applies `requireAuth` and no permission middleware, so every check on that router happens in the
service. Copying it for a permission-gated module produces a route with no early gate and no
compile-time complaint. Copy `access.routes.ts` (§1.2).

---

## 7. Conformance checklist

A module document in this set, and the implementation it describes, should be reviewable against
this list. Every item is a rule stated above, in the order a reviewer would hit it.

| # | Check |
|---|---|
| 1 | No screen files, no `App.tsx` edits, no tab-table entries. API client wrappers only |
| 2 | New types land in `shared/` first; nothing in `master/` imports a type `tsc` has not built |
| 3 | Paging uses the one `CursorPage<T>`/`CursorQuery` from `shared/src/domain/inputs.ts`. No page numbers |
| 4 | Cursor payloads build on `master/src/domain/cursor.ts`. No second codec |
| 5 | The migration uses its allocated timestamp, exports a `down`, inlines every literal, and is **appended to `master/src/db/migrations/index.ts`** |
| 6 | No new permission-grant migration. New keys are granted only by `20260309000000`, to `tier = 'admin'`, union-not-replace |
| 7 | Router copies `access.routes.ts` — `requireAuth` plus `needs('<key>')` per handler — and is mounted above `app.ts:41` under `/api` |
| 8 | Every service function begins with `requirePermission(actor, key)`; the actor is the **last** parameter and there is no `tenantId` parameter |
| 9 | Invariants are pure `assertX` functions in `master/src/domain/`, not inline in the service |
| 10 | All SQL is in a `*.repository.ts`. No `db()(…)` or `trx(…)` outside `repositories/` |
| 11 | Repository writes take a required `trx: TransactionContext`; reads take a trailing `runner: Runner = db()` |
| 12 | `recordActivity(entry, actor, trx)` — the three-argument form, adopted in **Stage 1** — **inside** the transaction. Never `recordDetachedActivity` |
| 13 | Re-read after commit, then `publishChange`. Nothing is published from inside a transaction |
| 14 | A new sensitive entity is added to `DIRECTORY_ENTITIES` (`hub.ts:114`) or it is broadcast to every panel |
| 15 | Socket command registered in `ClientToServerEvents` **and** `registerCommands()`, resolving the actor per command |
| 16 | Office route is `forward()` only, registered after `office/src/http/app.ts:133`, failing 503 offline, nothing queued |
| 17 | Timezone comes from `config.locale.timeZone`. No date-derived value is ever passed to `toISOString()` |
| 18 | Permission-redacted fields are **absent**, never `null`, never `0` |
| 19 | At least one **pure** test suite, with no `describe.skipIf`, pinning the module's highest-risk logic |
| 20 | Every new file opens with a header saying what it is and why the non-obvious decision was made |

---

## 8. Open questions this document does not answer

Marked rather than invented. The full list — including the ones that surfaced inside other documents'
prose — is carried in `README.md` §8 and `11-BUILD-SEQUENCE.md` §2. These three are the ones that
bear on the architecture itself:

1. **Is `messageKey` required on `AppError`?** The sweep is **129 throw sites across `master/src`,
   0 in `office/src`** — stated precisely as *129 (126 by grep; `conversion.ts` contains a NUL byte
   so grep classifies it binary and skips 4 sites — verify with `grep -a`)*. The count that governs
   the *work*, though, is the **68 hand-written tokens**, not 129: many sites share a token.
   `05-EXISTING-CODE-CHANGES.md`'s per-class breakdown is the authority for both numbers.
   `AppError`'s constructor signature (`master/src/lib/errors.ts:7-28`) is a dependency of every
   module here, so this is answered before anything else is built.
   `docs/BACKEND_MODULES.md` §4.4 recommends required, with `message` derived from the EN catalogue so
   existing tests asserting English text keep passing byte-identical.
2. **How do large CSV and PDF exports reach the Office?** Cap far lower, chunk over the cursor, or
   declare export Master-only. Needed before the export endpoints ship
   (`docs/BACKEND_MODULES.md` §8.2). The related question of what a **mid-stream** CSV failure looks
   like once streaming has begun is open too, and is held by `04-API-CONTRACT.md` §O-4.
3. **Should Office snapshot module-filtering be pulled into this batch** rather than left open
   (§5)? It needs its own owner either way.
