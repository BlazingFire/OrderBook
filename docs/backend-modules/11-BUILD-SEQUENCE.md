# 11 — The implementation sequence

This is the document work is authorised from. It says what gets built, in what order, why the order
is not negotiable where it is not, what must be green before the next stage starts, and what
"rolling back" would actually mean on the owner's machine if a stage went wrong.

It specifies **backend only** — no screen files, no `App.tsx` edits, no tab-table entries. The one
frontend surface in scope is the typed API client wrappers in `master/web/src/api.ts` and
`office/web/src/api.ts`. The ten screens belong to the UI phase in `docs/UI_REDESIGN.md` §8.

This set is organised **by concern, not one document per module**: `README.md`, `01-ARCHITECTURE.md`,
`02-FILE-STRUCTURE.md`, `03-DATABASE.md`, `04-API-CONTRACT.md`, `05-EXISTING-CODE-CHANGES.md`,
`06-WORKFLOWS.md`, `07-UI-SPEC.md`, `08-PERMISSIONS.md`, `09-I18N.md`, `10-TESTING.md` and this
document. Each has a single authority: **`02-FILE-STRUCTURE.md`** owns the file manifest and the
scope boundary, **`03-DATABASE.md`** owns schema, enums, CHECK constraints, indexes and every
migration's `down()` policy, **`04-API-CONTRACT.md`** owns wire shapes, type definitions, socket
event names and endpoint paths, **`08-PERMISSIONS.md`** owns permission keys, tiers and the
grant-migration algorithm, and **`10-TESTING.md`** owns the test register and the gates named below.
This document owns **stage ordering and numbering only** — Stage 0 through Stage 8. Where it appears
to restate one of those authorities, the authority wins and this document is the thing to correct.
The canonical plan is `docs/BACKEND_MODULES.md`; where this document and that one disagree, that one
wins.

---

## 1. The dependency graph

Nine stages. Five edges are hard — the later stage cannot compile, cannot be written, or would have
to be rewritten without the earlier one. The rest is preference, and preference is stated as such.

```
  Stage 0  socket ack `details`
     │        (shared/protocol + hub.respond + master-connection + forward)
     │
     ▼
  Stage 1  FOUNDATION — i18n · CursorPage/CursorQuery · cursor codec · config.locale
     │        AppError's constructor signature changes here
     │
     ├──────────────┬──────────────┬───────────────┬───────────────┐
     ▼              ▼              ▼               ▼               ▼
  Stage 2        Stage 4        Stage 6        Stage 8        (parallel-safe)
  Recycle Bin    Logs           PDF Designer   Office Dashboard
   20260305      20260307        20260308       no migration
     │              │
     ▼              ▼
  Stage 3        Stage 5
  Fields         Reports
   20260306      no migration of its own
     │              │              │              │
     └──────────────┴──────┬───────┴──────────────┘
                           ▼
                       Stage 7  permission grant — 20260309, LAST
```

### 1.1 The five hard edges

| Edge | Why it is hard |
|---|---|
| 0 → 1 | Both edit the same four files, including `respond()` at `master/src/realtime/hub.ts:391-406`. Stage 1 adds `messageKey`/`params` to exactly the lines Stage 0 adds `details` to. Done in either order they conflict; done in parallel they conflict twice. |
| 1 → everything | `AppError`'s constructor (`master/src/lib/errors.ts:7-27`) is a dependency of every service in the batch. If `messageKey` becomes required (open question 1), every `new ValidationError(...)` written before the sweep has to be rewritten after it. Writing module services first means writing them twice. |
| 0 → 2, 0 → 6 | The Recycle Bin's restore conflict carries `blockedBy` and a rename `suggestion`; the PDF Designer's template save carries `storedVersion` and a field diff. Both are `AppError.details`, and `CommandResult<T>`'s `{ ok: false }` arm (`shared/src/protocol/socket.ts:142-159`) has `code?` and `missingPermission?` and nothing else. Without Stage 0 both arrive on the Office Panel as a bare English string, and the client branches on them are dead code. |
| 2 → 3 | **`RECYCLE_BIN_ENTITIES` grows across stages rather than shipping frozen.** Stage 2 ships **six** — `lead`, `order`, `party`, `product`, `role`, `user` — which are the six tables `20260305` gives `deleted_at`. Stage 3 adds **two**, `option_list_item` and `custom_field_definition`, whose columns arrive in `20260306`. Stage 6 adds **one**, `document_template`, from `20260308`. Final total nine. Each addition is a normal `shared` rebuild, and the Bin's partial indexes follow the same staging: six tables in `20260305`, two in `20260306`, one in `20260308`. A gate asserting an N-branch `UNION` belongs to the stage where N branches exist. |
| 4 → 5 | Reports has no migration of its own: its indexes are folded into `20260307`, and it shares `master/src/lib/csv.ts`, which Logs creates. Building Reports first means building both of those under the wrong owner. |

### 1.2 Why the permission grant runs last

One migration, `20260309000000_new_module_permission_grant`, granting **every** new key to
`tier = 'admin'` only, union-not-replace, key strings inlined and frozen. It runs last for the
obvious reason and one less obvious one:

- **Obvious:** it cannot grant a key that has not been minted yet, and keys are minted across four
  stages. Splitting it per module gives four migrations with four chances to disagree on policy —
  which is exactly what the module designs did, one of them granting new keys to *every* existing
  role. That is the act the no-wildcard rule at `shared/src/domain/permissions.ts:224-233` exists to
  prevent, with extra steps.
- **Less obvious:** the grant is only correct once the key list is final. A key added to the
  catalogue after the grant has run on the owner's database is a key the Administrator role does not
  hold, and nothing turns red — the grid simply shows an unticked box that nobody knows should be
  ticked. Running it last, once, makes "did every new key get granted" a single reviewable list.

Non-admin roles receive these keys through the permission grid, by an administrator who chooses
them. That is deliberate and is not a gap.

### 1.3 What this document allocates that the canonical plan leaves unowned

Four cross-cutting singletons have no module owner, and four independent designs each minted their
own copy. **They are built in Stage 1**, with i18n, because they are foundation and because the
batch's largest structural failure was exactly this class of duplication:

| Primitive | Home | Why Stage 1 |
|---|---|---|
| `CursorPage<T>`, `CursorQuery` | `shared/src/domain/inputs.ts`, beside the existing `Paginated<T>` (`inputs.ts:268`) | Four modules consume it; `shared/src/index.ts` is a barrel of `export *` lines, so two definitions are a duplicate-identifier error across all four packages. |
| The cursor codec | `master/src/domain/cursor.ts` — pure, opaque base64url | Three designs proposed three codecs. Module-specific cursor *payloads* build on the one codec. |
| `config.locale.timeZone` | `master/src/config/index.ts`, from `ORDERBOOK_TIMEZONE`, default `'Asia/Kolkata'` | Logs, Reports and the Office Dashboard all need it. `locale` rather than `reporting` because i18n date formatting reads it too. |
| Startup timezone validation | after `runMigrations()` in `master/src/index.ts:32` | `SELECT now() AT TIME ZONE $1`, aborting with a message naming the variable if Postgres raises `invalid_time_zone`. Nothing pins a timezone today — `buildKnexConfig` (`master/src/db/knex.ts:10-24`) passes no `SET TIME ZONE`. |

This is an allocation, not a new decision: all four are already settled in `BACKEND_MODULES.md`
§2.1, §2.4. What was missing was a stage to build them in.

---

## 2. Pre-flight — what the owner must answer before anyone writes code

Six open questions, from `docs/BACKEND_MODULES.md` §10. Each one blocks a stage. Questions 1 and 5
should be answered before *any* work starts; the rest can be answered while earlier stages run, but
not later than the row says.

| # | Question | Recommendation | Blocks | Answer by |
|---|---|---|---|---|
| 1 | **Is `messageKey` required on `AppError`?** **129 throw sites across `master/src`, 0 in `office/src`** — 126 by grep; `master/src/domain/conversion.ts` contains a literal NUL byte so grep classifies it binary and skips 4 sites, less a 1-count correction. Verify with `grep -a`, or read the tree with `readFileSync`. The number of **hand-written tokens is 68**, not 129, because many sites share a token — see `05-EXISTING-CODE-CHANGES.md` for the per-class breakdown. | **Required**, with `message` *derived* from the EN catalogue so tests asserting on English text stay byte-identical. Optional means untranslated errors remain possible forever. | Stage 1, therefore everything | **Before Stage 1** |
| 2 | **Leave `20260303`'s live `allPermissions()` import alone?** It is live at `20260303000000_roles_and_users.ts:21` and spent at line 331 — the trap the registry header forbids. But the same header forbids editing an applied migration. Both rules cannot hold. | **Leave it**, and record the decision in `HANDOFF.md`. The union-based grant makes the outcome correct on every install regardless, and editing an applied migration is the more dangerous rule to break. | Stage 7 | Before Stage 7 |
| 3 | **How do large CSV/PDF exports reach the Office?** A 250,000-row CSV returns as one value in one ack, buffered whole on both sides, through a 15-second timeout (`office/src/realtime/master-connection.ts:239-248`). Cap, chunk, or declare export Master-only. | Not recommended here — this is a product decision about who needs exports on a panel. Whatever is chosen must be one answer covering `logs.export`, `reports.export` and `document.render`. | Stages 4, 5, 6 | Before Stage 4 |
| 4 | **Confirm Fields editing is management+.** Fields *reading* is ungated (`fields.view`, no ceiling); Fields *editing* is `fields.manage`, lowered `admin` → `management`. | **Confirm.** Letting any office-tier user rename a pipeline stage would reorder every board in the company. Lowering a ceiling never strips a stored key, so no tier-repair migration is needed. | Stage 3 | Before Stage 3 |
| 5 | **Is the PDF Designer still wanted?** It was deferred once on purpose (`docs/LEAD_GENERATION_FLOW.md` §11) and is the largest module in the batch. | Answer early even though it blocks a late stage: if it is dropped, Stage 1's catalogue loses its `document.*` tokens and Stage 7's grant list loses five keys. Answering it after Stage 1 means editing Stage 1's output. | Stage 6 (and the shape of 1 and 7) | **Before Stage 1** |
| 6 | **Pull Office snapshot module-filtering into this batch?** `forCurrentUser()` (`office/src/http/app.ts:395-407`) re-masks `field.saleRate.view` and replaces `permissions`, and does no module-level filtering — the tab is hidden, the rows are not. | Leave it out and give it its own owner. It is a security fix of a different shape to anything else here, and folding it in makes every stage below it wait on it. If pulled in, it is a stage of its own, not an addition to Stage 8. | Stage 8 | Before Stage 8 |

### 2.1 Promoted from the module documents — decided, and still open

The reconciliation pass found eight questions raised inside a single document and visible nowhere
else. They are promoted here (and into `README.md` §8) so that a stage cannot start without seeing
them. Each names the document that holds the detail; **this table is an index, not the ruling.**

| Item | Status | Detail lives in | Blocks |
|---|---|---|---|
| **`option_lists.version` / `custom_field_definitions.version`** — is optimistic concurrency wanted on a Fields save? | **DECIDED.** Both tables gain `version INTEGER NOT NULL DEFAULT 1` in `20260306`, and `expectedVersion` is **mandatory** on `PUT /api/fields/values/:id` and `PUT /api/fields/definitions/:id`; a stale save is refused 409 carrying `storedVersion`, matching `assertVersionMatches` (`master/src/domain/access.ts:183-192`). | `03-DATABASE.md` (column), `04-API-CONTRACT.md` (wire) | Stage 3 |
| **Deleting a converted lead** — refuse, or soft-delete the order's history out from under it? | **DECIDED.** Refuse: a lead carrying a `converted_order_id` is an order's history. The four DELETE routes' 409 rule is a per-entity policy table, distinct from `PARENT_LINKS` (which is the upward-only *restore* graph). | `04-API-CONTRACT.md` (the policy table), `06-WORKFLOWS.md` | Stage 2 |
| **The top-parties date anchor** — `orders.created_at` or `orders.dispatched_at`? | **DECIDED.** `orders.dispatched_at`: the report is "dispatched value in the selected period" — goods that left, not business won. Confirm `idx_orders_party` serves it, or specify the index that does. | `03-DATABASE.md` (index), `04-API-CONTRACT.md` (shape) | Stage 5 |
| **Mid-stream CSV failure semantics** — a row that fails to serialise after 40,000 rows are already on the wire. Truncate with a trailing error row, abort the response, or buffer whole and risk the memory? | **OPEN.** Whatever is chosen must be one answer covering `logs.export`, `reports.export` and `document.render`, and it is bound up with open question 3 above. | `04-API-CONTRACT.md` | Stages 4, 5, 6 |
| **`QUIET_AFTER_DAYS = 30`** — what counts as a lead going quiet in this business? | **OPEN, and it is the owner's number, not a designer's.** Cheap to change before the report ships and awkward afterwards. | `02-FILE-STRUCTURE.md` (`master/src/domain/lead-outcome.ts`), `06-WORKFLOWS.md` | Stage 5 |
| **Devanagari font fallback** — embed a face as a base64 data URI (~200–400 KB per bundle), or depend on Windows' `Nirmala UI` until the UI phase self-hosts `.woff2`? | **OPEN.** A deployment-environment question the code cannot answer. Distinct from the *server-side* PDF face, which is vendored under `master/assets/fonts/` and is not in question. | `09-I18N.md` §10.1 | Stage 1 (web), Stage 6 (PDF is unaffected) |
| **Should `party_product_variants` be soft-deletable?** | **OPEN.** They carry a negotiated rate, so deleting one silently changes what a future line quotes. Not a tenth Bin branch by default — but not obviously *not* one either. | `03-DATABASE.md` | Stage 2 (if yes) |
| **Should Logs also surface `timeline_entries`?** | **OPEN.** `activity_log` is the tamper-evident trail; `timeline_entries` is the human narrative on a lead. Merging the two feeds is a product decision, and doing it accidentally would make the hash-chain claim mean less than it says. | `03-DATABASE.md` | Stage 4 |

### 2.2 Pre-flight facts to gather — not decisions, measurements

These are cheap, and each one turns an assumption in the plan into a fact. None needs the owner to
choose anything; they need somebody to run a command and write down the answer.

| Measurement | Why it matters | Blocks |
|---|---|---|
| `SHOW TimeZone;` against the owner's `order_book` database | The plan defaults `config.locale.timeZone` to `'Asia/Kolkata'` by inference from the owner's machine being IST. If the server is already pinned to something else, every month bucket in Reports shifts. | Stage 1 |
| A fontkit `layout()` spike against the vendored Noto Sans Devanagari — does `'हिन्दी'` return fewer glyphs than codepoints, and does `'कि'` place the i-matra before its consonant? | Devanagari is a hard requirement and eliminates several popular PDF libraries. "fontkit has an Indic shaper" and "renders शर्मा टाइल्स correctly at 9pt" are different claims, and only one of them has been checked. If the spike fails, the whole PDF module needs a different renderer before a line of it is written. | Stage 6 |
| An `EXPLAIN` of the **six**-branch Bin `UNION ALL` on real data after `20260305` lands, and again at **eight** after `20260306` and at **nine** after `20260308` | The plan is Append/MergeAppend over Index Scans. A plan that is fine on an empty test cluster is not evidence, and a plan that is fine at six branches is not evidence about nine. | Stage 2 gate, re-run at Stages 3 and 6 |
| A count of rows in `stock_movements` on the owner's database | The Fields colour usage scan is the one query in the batch with no index to lead on. The count decides whether the mitigation is sufficient or merely plausible. | Stage 3 |

---

## 3. The stages

Effort is **relative size only** — small / medium / large. There are no hour counts here because
there is no basis for one, and an invented number becomes a commitment the moment it is written
down.

Every stage, without exception, carries these five obligations. They are not repeated per stage.

1. New modules use `recordActivity(entry, actor, trx)` with the transaction, **never**
   `recordDetachedActivity`. The detached variant swallows failures into a warning and exists only
   for recording a *failed* operation that has no transaction to belong to. **The three-argument
   signature lands in Stage 1**, not at the Logs stage: the `actor` parameter is harmless before
   `activity_log.actor_name` exists — it is simply not persisted yet — and introducing it early
   means Recycle Bin and Fields are written once against the final signature instead of being swept
   later. `20260307` adds the column and starts persisting it.
2. Every new router copies `access.routes.ts` — the only existing router using
   `requirePermissionMiddleware` — not `data.routes.ts`, and every handler carries a `needs(...)`
   guard. `master/tests/credential-invariants.test.ts:73-89` asserts this by reading the source for
   `access.routes.ts`; each stage extends it to its own router.
3. The Office path is one event in `ClientToServerEvents`, one line in the Master hub's
   `registerCommands()` using the existing `run(ack, actor => …)` shape, and one
   `forward(res, '<event>', payload)` route registered **after** the `app.use('/api', requireUser)`
   gate at `office/src/http/app.ts:133`. `forward()` already maps `MasterCommandError.unreachable`
   to 503 `{ error: 'unavailable' }` (`app.ts:443-446`). Nothing is queued into the outbox.
4. The actor is resolved **per command** via `actorFor()`, never captured at connect time. Offline
   is decided from the transport flag, never by reading an error message.
5. Redacted fields are **absent** — `undefined`, never `null`, never `0`. `maskFields()` already
   deletes.

---

### Stage 0 — the socket ack carries `details`

**Size: small.** Roughly fifteen lines across four files. It is a stage of its own because it is a
prerequisite for two modules and because it is the kind of change that gets folded into a larger one
and then half-done.

| What | Where |
|---|---|
| `details?: Record<string, unknown>` on the `{ ok: false }` arm | `shared/src/protocol/socket.ts:142-159` |
| `respond()` sets `code` and `details` for **any** `AppError`, not only `ForbiddenError` | `master/src/realtime/hub.ts:391-406` |
| `MasterCommandError` carries `details` | `office/src/realtime/master-connection.ts` |
| `forward()` passes `details` through alongside the permission it already forwards | `office/src/http/app.ts:438-462` |

Files: `02-FILE-STRUCTURE.md` §"Stage 0 — transport". No migration.

**Gates** (`10-TESTING.md`):

- `respond()` sets `code` and `details` for a `ConflictError`, not only a `ForbiddenError` — the
  regression test for the 502-instead-of-403 defect.
- An Office `forward()` of a refused command surfaces 403 with `error: 'forbidden'` and
  `details.permission`, end to end through `MasterCommandError`.
- An Office `forward()` of a *conflicting* command surfaces 409 with the conflict's own `details`.

**Parallelism:** none. Stage 1 rewrites the same `respond()` lines. Do not start Stage 1 until this
is merged.

**Compatibility note worth keeping:** `details` is optional on the wire, so a Master and an Office
build that disagree about this change degrade — the field is simply absent — rather than break.
That is the only mixed-version safety in the batch and it exists by accident of the field being
optional, not by design.

---

### Stage 1 — foundation: i18n and the shared primitives

**Size: large.** The largest non-PDF stage, and the one whose size is decided by open question 1.

**What is built**

- `shared/src/i18n/` — `en.ts` (the source of truth), `hi.ts` (total `Record<MessageKey, string>`),
  `keys.ts`, `locales.ts`, `translate.ts`, `activity.ts`, `errors.ts`, `pseudo.ts`, `index.ts`.
- `master/src/domain/i18n-tokens.ts` — the pure invariant that every `(entityType, action)` pair
  written to `activity_log` has a catalogue entry.
- `AppError` gains `messageKey` and `params`; `message` is **derived** from the EN catalogue so the
  existing English assertions in `access.integration.test.ts` and `permissions.integration.test.ts`
  stay byte-identical. If open question 1 is answered "required", this is the **129-site** sweep —
  and **68 hand-written tokens**, not 129, because many sites share one.
- `respond()` additionally sets `messageKey` and `params` — the second edit to the lines Stage 0
  touched, which is why the two stages are sequential.
- **`recordActivity` becomes `recordActivity(entry, actor, trx)` here**, in this stage, not at
  Stage 4. The `actor` argument is accepted and not yet persisted — `activity_log.actor_name` does
  not exist until `20260307` — which is precisely why it is cheap now: Stages 2 and 3 are written
  once against the final signature rather than swept when Logs lands. `recordDetachedActivity`
  remains forbidden in new modules.
- `tools/eslint-rules/no-untranslated-jsx-text.js` (in-repo flat-config rule, no new dependency) and
  `tools/i18n-sync.mjs`. **The rule is registered as `'off'` in this batch** and promoted in the UI
  phase: `lint` is the first step of `verify`, and there are ~4,000 unswept lines of JSX behind it.
  See `05-EXISTING-CODE-CHANGES.md`.
- **The shared primitives from §1.3**: `CursorPage<T>` / `CursorQuery`, `master/src/domain/cursor.ts`,
  `config.locale`, and the startup timezone validation.

**What is NOT built here — the web i18n files are DEFERRED to the UI phase.**
`{master,office}/web/src/i18n/*`, `components/LocalePicker.tsx`, `components/Untranslated.tsx`,
`main.tsx`, `styles.css`, `format.ts`, `PermissionGrid.tsx` and `AccessScreen.tsx` are **all out of
scope for this batch**. The only web files in this batch remain `master/web/src/api.ts` and
`office/web/src/api.ts`, per `02-FILE-STRUCTURE.md`.

That deferral does **not** leave the translation layer unverifiable. `shared/src/i18n/` **is** in
scope and is **fully testable through `shared/tests/`** with no web file involved: catalogue
totality, placeholder-set parity between EN and HI, plural selection, byte-identical passthrough of
ids and hashes, and the `permission.*`/`module.*`/`action.*` coverage contract are all pure
assertions over compiled TypeScript. See `10-TESTING.md` §6.2 — every i18n gate there runs without a
browser, a DOM or a database.

Files: `02-FILE-STRUCTURE.md` §"i18n" and §"Shared primitives". **No migration** — the i18n layer
adds no table, and `activity_log` needs no change to what it stores, because
`(entity_type, action, details)` is already token-plus-params. The chain input is
`prev_hash|sequence|entity_type|entity_id|action|actor_type|actor_id|details`; rendering stays
outside it, so an entry written today renders in Hindi tomorrow with no schema change and no chain
rewrite.

**Gates** (`10-TESTING.md`), all **pure** suites with no `describe.skipIf`:

- Every key in `PERMISSIONS` has a `permission.<key>` token; every module, capability group and role
  template has its token. This is what makes the existing `labelToken` contract load-bearing rather
  than decorative.
- `hi.ts` is total, and covers every EN key with an **identical placeholder set per key** — a
  translator dropping `{name}` is something the compiler cannot catch.
- `t()` leaves a record id, a device code and a chain hash byte-identical. Numbers and IDs are never
  localised.
- `AppError.message` equals `t(messageKey, params)` against EN for every subclass — proves the
  English fallback cannot drift from the token.
- No EN string contains a pre-formatted number, a thousands separator or a `₹`. Numbers arrive as
  params.
- `master/tests/i18n-tokens.test.ts` — source-reading, in the `credential-invariants.test.ts` style:
  every literal `(entityType, action)` pair passed to `recordActivity` across `master/src/services`
  has a catalogue entry.
- The cursor codec round-trips a BIGINT id past 2^53 without losing precision, and rejects a
  malformed cursor rather than silently restarting at the newest page.
- Startup aborts, naming `ORDERBOOK_TIMEZONE`, when the configured zone is not one Postgres knows.

**Parallelism:** none downstream until it merges. Within the stage, the catalogue work and the
129-site sweep can be split between two people once `keys.ts` and the `AppError` signature are
agreed, and that is where the parallelism in this stage is.

**A known cost, deferred rather than paid here:** the two existing humanisers
(`PermissionGrid.humanise`, `AccessScreen.humaniseField`) should become catalogue lookups, and a
hand-written token will rarely match what the humaniser derived. Both files are **web files and
therefore out of this batch** (R2 above) — the tokens are minted here, the humanisers are replaced in
the UI phase, and the visible English diff in a screen the owner knows well lands with it.

---

### Stage 2 — Recycle Bin

**Size: large.** It delivers the first delete path the product has ever had for leads, orders,
parties and products, which is more than a read module's worth of work even though the Bin itself is
a read.

**What is built**

- `shared/src/domain/recycle-bin.ts` — `RECYCLE_BIN_ENTITIES`, `BinEntry`, `BinBlocker`,
  `RESTORE_PERMISSION`. **`RECYCLE_BIN_ENTITIES` ships with six members here** — `lead`, `order`,
  `party`, `product`, `role`, `user` — and grows at Stages 3 and 6 (§1.1). It is not authored frozen
  at nine and it is not authored with members whose `deleted_at` column does not exist yet.
- `master/src/domain/recycle-bin.ts` — `PARENT_LINKS` (the upward-only restore graph),
  `suggestRestoredName`.
- `master/src/repositories/recycle-bin.repository.ts` — the only cross-table SQL in the batch.
- `master/src/services/recycle-bin.service.ts`, `master/src/http/routes/recycle-bin.routes.ts`
  mounted at `/api/recycle-bin`.
- Per-entity soft-delete/restore writes in **each entity's own repository**. `DELETE /api/leads|
  orders|parties|products/:id` are the first enforcement sites for `leads.delete`, `orders.delete`,
  `parties.delete`, `products.delete` — four keys that have been in the frozen catalogue since
  `20260303` and are checked nowhere.
- A `'restored'` `ChangeAction`. `shared/src/protocol/socket.ts:180` currently declares
  `'created' | 'updated' | 'deleted'`.
- **The four DELETE routes' 409 rule**, which is a per-entity policy table owned by
  `04-API-CONTRACT.md` and summarised here only so the stage knows what it is building: `party`
  refuses while any live lead or order references it; `product` refuses while any live `line_items`
  row references it or any `inventory_stock` row has non-zero on-hand or reserved; `lead` refuses
  once it has a `converted_order_id` (it is an order's history) and otherwise soft-deletes cascading
  to its line items; `order` refuses once dispatched and otherwise soft-deletes, releasing active
  reservations in the same transaction. Refusal is `ConflictError` 409 with
  `{ blockedBy: BinBlocker[] }` naming the blocking records. **This is a DELETE-side rule and is a
  different thing from `PARENT_LINKS`**, which is the upward-only RESTORE graph; conflating them is
  the mistake this bullet exists to prevent.

Files: `02-FILE-STRUCTURE.md` §"Recycle Bin". **Migration `20260305000000_soft_delete_columns`.**

**Do this first, before the migration:** the migration registry guard test. With five files landing
across this batch against the hand-maintained array at `master/src/db/migrations/index.ts:30-37`, a
file written but not imported is a silent no-op and nothing turns red.

**Three decisions to carry into the code, not rediscover**

- **Restore reuses the entity's own delete key** (`RESTORE_PERMISSION[entityType]`), so restore can
  never be a back door onto an entity you may not delete. No `recycleBin.restore` key is minted, and
  there is no purge at all.
- **Scope is `deleted_by = me`** unless the actor holds `recycleBin.viewAll` (management+). The
  consequence is real: a deletion by an unattended Office Panel has `deleted_by NULL` and is visible
  only to `viewAll` holders.
- **Soft-deleting a syncable entity stamps `hlc` and `field_hlc.deleted_at`**, not just `version`.
  No delete/restore `MutationKind`s — deletes are Master-online-only, matching the roles/users
  precedent, and propagation to panels uses the existing `publishChange`/`ChangedEntity` path with
  the new `'restored'` action.

**The DDL verb.** `parties(tenant_id, party_code)` and `products(tenant_id, product_code)` are
unique **indexes**, not table constraints (`20260301000000_tenancy_access_and_sync.ts:144-150`), so
`ALTER TABLE … DROP CONSTRAINT` fails. `DROP INDEX idx_parties_code_tenant;` then recreate
`WHERE deleted_at IS NULL`. The intent is right and important — a soft-deleted party would otherwise
reserve its code forever.

**Gates** (`10-TESTING.md`):

- Pure: the cursor round-trips at microsecond precision; `suggestRestoredName` escalates
  deterministically past every taken name; `PARENT_LINKS` names a parent for every entity that has
  one; an actor with no delete keys sees an empty page rather than a refusal.
- Paging across the branches never drops or repeats a row when many rows share one `deleted_at` —
  delete a batch in one transaction so every row carries an identical timestamp, then page with
  `limit 3` and assert the union of pages equals the set exactly.
- An office-tier user sees only their own deletions; `recycleBin.viewAll` reveals another user's; a
  deletion by an unattended panel is invisible without it.
- Restore refuses a lead whose party is still deleted, and **names the party** in `details` — the
  Stage 0 dependency, proven end to end through the Office `forward()`.
- Restore without `renameTo` returns 409 carrying the suggestion; the same call with `renameTo`
  succeeds.
- Restoring a user whose role is still deleted is refused, rather than producing an account that
  cannot sign in. This is a new gate over an existing unguarded defect.
- A soft-deleted party is absent from `listParties`, from search and from the panel snapshot, and
  frees its `party_code` for reuse.
- A mutation arriving over sync for a deleted record is rejected, and replays to the same rejection.
- Restore publishes `'restored'`, not `'updated'`.
- **There is no endpoint that hard-deletes anything.**
- The `EXPLAIN` from §2.2 shows Append/MergeAppend over Index Scans.

**Parallelism:** Stage 2 and Stage 3 can be worked in parallel by two people. They share exactly one
merge point — the new keys in `shared/src/domain/permissions.ts` — which needs one named owner for
that file. For a single implementer, sequential is safer and barely slower.

**Subsumption, not duplication.** A roles/users-scoped Recycle Bin already exists inside
`AccessScreen.tsx` (`function RecycleBin`, ~line 963), which is what finally gave `restoreRole` and
`restoreUser` a caller. The cross-entity Bin subsumes it: those two entity types become two rows in
the unified feed and the existing restore services are reused rather than reimplemented. The
`AccessScreen` change itself is a screen edit and belongs to the UI phase.

---

### Stage 3 — Fields

**Size: medium.**

**What is built**

- `shared/src/domain/fields.ts` — `FieldCatalogue`, a served descriptor modelled on
  `buildPermissionCatalogue()`, so the screen renders from it rather than from a list typed into the
  renderer.
- `master/src/domain/field-values.ts` — `normaliseOptionValue`, which trims and **deliberately does
  not case-fold**.
- `master/src/repositories/field-usage.repository.ts` — one query per set, never one per value.
- `master/src/services/fields.service.ts`, `master/src/http/routes/fields.routes.ts` at
  `/api/fields`.
- `fields.manage` lowered `admin` → `management` in the catalogue.

Files: `02-FILE-STRUCTURE.md` §"Fields". **Migration
`20260306000000_field_values_and_stage_ordering`.**

**Four things the migration must get right**

- **`option_lists` and `custom_field_definitions` gain `version INTEGER NOT NULL DEFAULT 1`.**
  `expectedVersion` is then **mandatory** on `PUT /api/fields/values/:id` and
  `PUT /api/fields/definitions/:id`, and a stale save is refused 409 carrying `storedVersion` —
  the same shape `assertVersionMatches` (`master/src/domain/access.ts:183-192`) already enforces for
  roles and users. This was an open question and is now decided (§2.1). `03-DATABASE.md` owns the
  DDL; `04-API-CONTRACT.md` owns the wire shape; a concurrency gate joins the Fields tests
  (`10-TESTING.md` §6.4).

- `option_lists` gains a nullable `hex`, back-filled from the distinct colour strings already in the
  stock tables. **Case is preserved exactly and nothing is trimmed.** `'White'` and `'white'` are
  already two `inventory_stock` rows, two reservations and two `stockKey()` values; folding them
  here would merge or orphan live stock, and reservations that stop matching read as **zero** rather
  than as an error. The five colour columns and `stockKey()` are not touched.
- `idx_pipeline_stages_seq` is a unique *index* and a unique index cannot be `DEFERRABLE`.
  Reordering needs it dropped and re-added as a deferrable table constraint.
  `idx_pipeline_stages_one_default` is a *partial* unique index and genuinely cannot become one, so
  default-swapping uses clear-then-set ordering.
- Every `list_key` literal is inlined and frozen in the migration. `FIELD_LIST_KEYS` is not imported
  from `@orderbook/shared`.

**The usage count is bounded by dropping a source.** `usageForListKey('stock.colour')` groups over
`line_item_quantities`, `inventory_stock` and `stock_reservations` — and **not** `stock_movements`.
No index leads with `colour` on any of them (`idx_inventory_product_colour` is
`(tenant_id, product_id, colour)`, the wrong leading column), and `stock_movements` is the
append-only ledger, projected into the millions by `docs/schema/05`. The other three sources answer
"is this colour in use" adequately.

**Leave the three existing reads alone.** `GET /api/pipelines`, `/api/option-lists` and
`/api/custom-fields` stay gated by `requireAuth` only. Routing them through a `fields.view` check
would make `buildSnapshot`'s `Promise.all` reject for anyone lacking the key — and a rejected
`buildSnapshot` produces **no snapshot at all**, swallowed into a log line. The new `/api/fields/*`
surface is separate. This is the single most likely way for a reviewer "tidying up" to break the
panel for every user.

**Also in this stage: the Bin grows two branches, six → eight.** `option_lists` and
`custom_field_definitions` get `deleted_at`/`deleted_by` and their partial indexes here, so the
entities `option_list_item` and `custom_field_definition` join `RECYCLE_BIN_ENTITIES` here — that is
a normal `shared` rebuild, not a schema decision. **The entity literal is `custom_field_definition`,
not `custom_field`.** Note that
`option_lists` then carries **both** `is_active` and `deleted_at` with deliberately different
meanings — *retired* (hidden, reversible in one click, not in the Bin) versus *removed* (hidden, in
the Bin, restorable). A reader who conflates them will either resurrect values through the wrong
door or make the Bin miss half its rows.

**Gates** (`10-TESTING.md`):

- Pure: `normaliseOptionValue` trims but never case-folds; `assertOptionValueChange` passes a value
  the record already holds even when the option was removed; `assertCompleteReorder` rejects a list
  that is not a permutation; a hex is normalised to lowercase and a malformed one is rejected.
- Reordering stages one drag at a time never violates the sequence constraint — **this fails without
  `SET CONSTRAINTS DEFERRED`**, which is the point of the gate.
- Moving the default to another stage does not violate the one-default index.
- Archiving a stage holding live leads is refused and names the count.
- Removing a colour does not touch a single `line_item_quantities`, `inventory_stock`,
  `stock_movements` or `stock_reservations` row.
- A lead already carrying a removed source can still be edited over HTTP **and** over sync.
- A stale `expectedVersion` on a value or a definition save is refused **409** carrying
  `storedVersion`; an omitted one is refused **400**, matching `assertVersionMatches`.
- **Re-run Stage 2's Bin paging gate** with the two new branches present — the `UNION` is now
  eight-way, and the gate asserting eight belongs to this stage, not to Stage 2.

---

### Stage 4 — Logs

**Size: medium.**

**What is built**

- `shared/src/domain/activity.ts`, `master/src/domain/log-cursor.ts` (payload on the Stage 1 codec).
  `ActivityLogEntry` carries `hash: string | null` — the Logs screen has an Entry-hash column and it
  is the only thing that makes "hash-chained" visible to a person. It is covered by `logs.view`, not
  by a key of its own. `04-API-CONTRACT.md` owns the type.
- `master/src/repositories/activity-log.repository.ts` **extended** — `listEntries`, `listFacets`,
  `verifyChain`, `chainBounds`. The export reader is `streamForExport`; `chainBounds` and
  `streamForExport` are **two different functions** and neither is an alias for the other
  (`02-FILE-STRUCTURE.md` is the manifest authority).
- `master/src/services/log.service.ts` — `listLogs`, `listLogFacets`, `verifyLogChain`, `exportLogs`
  — and `master/src/http/routes/log.routes.ts` at `/api/logs`.
- `master/src/lib/csv.ts` — dependency-free CSV writer, shared with Reports.

| Endpoint | Permission |
|---|---|
| `GET /api/logs` | `logs.view` — keyset, newest-first, Newer/Older only |
| `GET /api/logs/facets` | `logs.view` |
| `POST /api/logs/verify` | `logs.verifyChain` |
| `GET /api/logs/export` | `logs.export` — separate route so the key gates a distinct code path |

Files: `02-FILE-STRUCTURE.md` §"Logs". **Migration `20260307000000_activity_log_actor_name`**, which
also carries the Reports indexes.

**Four things this migration and module must get right**

- **Chain verification runs in SQL.** The digest covers `details::text` — Postgres's own JSONB
  rendering — so Node cannot reproduce the bytes. The migration factors the inline digest expression
  out of `activity_log_chain()` into a reusable `activity_log_row_hash(...)`.
- **`actor_name` is derived inside `recordActivity`, not passed at the call site.** The signature is
  **already** `recordActivity(entry, actor, trx)` — it changed in **Stage 1** (§3, obligation 1), so
  by the time this migration runs every call site in the batch already supplies the actor and the
  argument has simply been going unpersisted. This stage adds the column and starts writing it. That
  ordering is the point: the alternative, changing the signature here, would mean sweeping Stages 2
  and 3 after the fact. `recordActivity` is called with an object literal at roughly 24 sites and
  none of them would have set the field by hand, which would have given a column that works for
  backfilled history and is `NULL` for everything written afterwards — worse than not having it.
- **`actor_name` sits outside the hash, by necessity.** Adding it to the digest would change the
  formula and invalidate every existing row. It is immutable (the append-only trigger refuses
  UPDATE) but not tamper-evident, and the verifier must report on chained fields only.
- **Verify must not hold the chain lock.** The chain trigger takes
  `pg_advisory_xact_lock(hashtext(tenant_id::text))` for the life of the caller's transaction, so
  every audited write for the company serialises behind it. Verification therefore runs in a
  read-only transaction that does nothing but `SELECT`, with `SET LOCAL statement_timeout`, and
  writes its own audit entry in a **separate** short transaction afterwards. The `SET LOCAL`, the
  transaction and the ordered walk all live inside the repository — a service opening
  `db().transaction()` is Knex in a service, which decision 12 forbids.

**Add `(tenant_id, created_at DESC)`.** The existing `idx_activity_log_created` is not
tenant-prefixed, and the date filter and the facets both need it.

**Gates** (`10-TESTING.md`):

- Pages newest-first and returns the same rows walking Older then Newer back.
- The cursor round-trips a BIGINT id past 2^53; a malformed cursor is rejected rather than silently
  restarting at the newest page.
- Shows the name of a user who has since been soft-deleted — the denormalisation gate.
- Verify reports `ok` over an untampered chain and counts the rows it checked; reports the first
  break and its sequence when a stored hash is altered; reports a `prev_hash` break when a row is
  unlinked; seeds a partial range from the predecessor rather than assuming genesis; counts
  pre-chain rows as **unverifiable, not broken**; truncates an over-cap range and says so.
- Verifying writes exactly one audit entry, **after** the scan. Listing the log writes none —
  otherwise the trail becomes mostly about itself.
- `credential-invariants.test.ts` extended to `log.routes.ts`.

**Parallelism:** Stage 4 can run in parallel with Stage 6 and Stage 8. It cannot run in parallel
with Stage 5, which depends on it.

---

### Stage 5 — Reports

**Size: medium.** No migration of its own; its indexes were folded into `20260307`.

**What is built**

- `shared/src/domain/reports.ts` — all money fields **optional**, so redaction can delete them.
- `master/src/domain/report-range.ts` — the date-safety module.
- `master/src/domain/lead-outcome.ts` — the "went quiet" rule as a pure classifier.
- `master/src/repositories/report.repository.ts` — five raw-SQL `GROUP BY` functions.
- `master/src/services/report.service.ts`, `master/src/http/routes/report.routes.ts` at
  `/api/reports`.

| Endpoint | Permission |
|---|---|
| `GET /api/reports/dispatches` | `reports.view` |
| `GET /api/reports/lead-outcomes` | `reports.view` |
| `GET /api/reports/top-parties` | `reports.view` |
| `GET /api/reports/:report/export` | `reports.export` |

`reports.view` and `reports.export` **already exist** with no `MINIMUM_TIER` entry, so they already
default to office tier and are already available to every user. This module is their **first
enforcement site anywhere in the codebase**; today they render as togglable grid cells that gate
nothing.

**Date safety is the whole module.** Every calendar boundary and month bucket is computed in SQL
against `config.locale.timeZone` and returned as a `'YYYY-MM'` TEXT label. No date-derived value
ever becomes a JS `Date` that something could `toISOString()`. `report-range.ts` takes `today` as
`{year, month, day}` components and never constructs a `Date`. Three specific traps, all of which
produce a report that is wrong by exactly the amount nobody notices:

- `dispatched_at AT TIME ZONE :tz` converts a `timestamptz` **into** wall-clock (bucketing);
  `:fromDate::timestamp AT TIME ZONE :tz` converts wall-clock **into** a `timestamptz` (boundaries).
  Same spelling, opposite meanings, decided by the operand's type.
- Never `BETWEEN` on a timestamptz range — it includes the upper endpoint, so an order dispatched at
  exactly midnight on the first lands in two months. Every range predicate is half-open `[from, to)`.
- BIGINT and NUMERIC arrive from node-postgres as **strings**. `rows.reduce((a, r) => a + r.total, 0)`
  string-concatenates silently. Everything numeric goes through `toNumber`/`toRequiredNumber` in
  `mappers.ts`.

**Rate redaction.** A user without `field.saleRate.view` gets money columns **absent**, and totals
are computed server-side over the same filtered set — never summed by the client from masked
buckets.

**Gates** (`10-TESTING.md`), the first two pure:

- `report-range` resolves this month from local date components, never from `toISOString()`; produces
  a half-open range; lists every month including empty ones; refuses an over-long range.
- `toIsoDate` keeps the day the user typed on an IST machine. Note that `toIsoDate`
  (`master/src/repositories/mappers.ts:79-90`) is the existing fix for the shipped
  DATE-a-day-early defect and currently has **no test coverage at all** — this is its first.
- An order dispatched at **23:30 on the last day of the month** buckets into that month.
- The month label is a string from SQL and is never re-derived from a `Date`.
- Dispatched boxes report positive even though the ledger delta is negative.
- A converted lead whose lines exist under both parent types is not double-counted.
- A caller without `field.saleRate.view` gets buckets with **no `totalValue` key at all** — asserted
  as `'totalValue' in bucket === false`, matching the existing `permissions.integration.test.ts`
  idiom, not a null or zero check.
- The SQL outcome `CASE` and the pure `classifyLeadOutcome` agree at the 29/30/31-day boundary.
- A lead in a terminal stage is lost, decided by `is_terminal` and never by the stage name.
- `credential-invariants.test.ts` extended to `report.routes.ts`.

**The top-parties date anchor is `orders.dispatched_at`** — decided, not assumed (§2.1). The report
is "dispatched value in the selected period", so it counts goods that left, not business won; an
order created in March and dispatched in April belongs to April. Confirm `idx_orders_party` actually
serves that predicate, or specify the index that does — `03-DATABASE.md` owns the answer. An anchor
of `created_at` would produce a plausible, differently-wrong report, which is the class of defect
§7's ordering principle ranks highest.

**One open item this stage inherits:** `QUIET_AFTER_DAYS = 30` is a designer's number, not the
owner's. What counts as a lead going quiet in this business is a question, and it is cheap to change
before the report ships and awkward afterwards. It is on the promoted list in §2.1.

---

### Stage 6 — PDF Designer

**Size: large.** The largest module in the batch, and the one previously deferred on purpose.

**Do not start this stage until the fontkit spike from §2.2 has passed.** If Devanagari shaping does
not work against the vendored face, the renderer changes and everything below it changes with it.

**What is built**

- `shared/src/domain/documents.ts`.
- `master/src/domain/document-template.ts` (`assertTemplateValid`),
  `master/src/domain/document-model.ts` (**the seam**: masked record + template → pure
  `DocumentModel`), `master/src/domain/document-text.ts` (`splitByScript()` →
  `'body' | 'devanagari' | 'mono'` runs).
- Three repositories: `document-template`, `document-export`, `document-asset`.
- `master/src/services/document.service.ts` (template CRUD) and
  `master/src/services/document-render.service.ts` — **the only importer of `pdf/`**.
- `master/src/pdf/` — `renderer.ts`, `fonts.ts`, `primitives.ts`. Infrastructure, a peer of
  `realtime/`, framework import and no business rule.
- `master/src/lib/document-files.ts` — disk I/O, no Knex, so deliberately outside `repositories/`.
- `master/assets/fonts/` — Inter-Regular, Inter-SemiBold, IBMPlexMono-Regular,
  NotoSansDevanagari-Regular, plus `LICENSES.md`. All four are SIL OFL 1.1, which explicitly permits
  PDF embedding; the licence file ships alongside so the vendored binaries are auditable with no
  network access.
- `master/src/http/routes/document.routes.ts` at `/api/documents`.

Files: `02-FILE-STRUCTURE.md` §"PDF Designer". **Migration
`20260308000000_document_templates_and_exports`.**

**Rendering is server-side, in the Master.** Rate redaction is decided from the `ActorContext`, the
rate column must be **absent from the document** rather than zeroed, and the export must be recorded
in `document_exports` **and** `activity_log` in one transaction — none of which a client-side
renderer can be trusted with or is even able to do.

**The permission key is `field.saleRate.view`.** `products.rate.view` does not exist in the
catalogue. Rendering additionally requires the subject's own view key (`leads.view` / `orders.view`),
so document access can never exceed record access. `reports.export` is deliberately **not** reused —
overloading it would make unticking one silently disable the other.

**Gates** (`10-TESTING.md`), the first four pure:

- fontkit `layout()` of `'हिन्दी'` returns fewer glyphs than codepoints — conjunct formation, i.e.
  real shaping rather than codepoint-order mapping.
- fontkit `layout()` of `'कि'` places the i-matra glyph **before** its consonant — reordering, the
  second half of the Devanagari requirement.
- The rate column is **absent** from `DocumentModel.columns`, not present-and-zero, when the template
  asks for rates but the actor may not see them.
- A template with `showRates=false` produces no rate column even for an actor who holds the key.
- The renderer fails at **startup**, not at first print, when a vendored font file is missing.
- A render by an actor without `field.saleRate.view` produces a PDF whose extracted text contains no
  rate and no total.
- The export row and its `activity_log` entry commit together, and neither survives a rolled-back
  render. A failed disk write leaves no export row; a crash between write and commit leaves only a
  `.tmp` the startup sweep removes.
- `previewDocument` writes no file, no export row and no activity entry.
- A stored export is unreachable through `/uploads` and reachable only through the authenticated
  route; another tenant's export id answers **404, not 403**.
- An `expectedDispatchDate` of the 1st renders as the 1st on an IST machine.
- `credential-invariants.test.ts` extended to `document.routes.ts`.

**Parallelism:** genuinely parallel with Stages 4, 5 and 8 — different files, different migration,
no shared module. It shares `shared/src/domain/permissions.ts` with them, the same one merge point
as everywhere else.

**Also in this stage: the Bin grows its ninth and final branch, eight → nine.** `document_template`
joins `RECYCLE_BIN_ENTITIES` here, with its partial index in `20260308`, and
`POST /api/documents/templates/:id/restore` exists from this stage regardless. `document_exports`
does **not** join it: a document that was sent to a customer is a record of what was sent, and
deleting it is not an act the product offers. Re-run the Bin paging gate with nine branches present
(`10-TESTING.md` §6.3) — a gate asserting nine belongs here, not at Stage 2.

**`DocumentLayout` is settled — and the split is the thing to get right.** The nine on/off switches
are **not** all `layout` JSONB. Eight are typed BOOLEAN **columns** on `document_templates`
(`show_rates`, `show_colour_chips`, `show_terms`, `show_logo`, `show_signature`, `show_page_numbers`,
`show_watermark`, `show_party_block`), per `03-DATABASE.md`. The `layout` JSONB holds **only** block
order and per-block options — `DocumentBlock` is a discriminated union over
`'header' | 'party' | 'lines' | 'totals' | 'terms' | 'signature'`, and `DocumentLayout` is
`{ blocks: DocumentBlock[] }`. `04-API-CONTRACT.md` owns the type. `assertTemplateValid` enforces the
grammar: every `kind` at most once, `lines` mandatory, `header` first if present, `signature` last if
present, `terms.text` at most 500 characters; a violation is a 400 carrying
`{ field: 'layout', block: n, reason }`. `07-UI-SPEC.md` is **wrong** where it says the nine toggles
write into `layout`.

**`document_exports.superseded_by` gets a writer.** `POST /api/documents/render` looks up the most
recent non-superseded export for `(subjectKind, subjectId, documentType)` and stamps it **in the same
transaction** as the new row. A column nothing writes is the same defect as a permission nothing
enforces, and this one would read as working history right up until somebody asked which quotation
was current.

---

### Stage 7 — the permission grant migration

**Size: small.** One file, one policy, run once.

**Migration `20260309000000_new_module_permission_grant`.** Grants every new key to `tier = 'admin'`
**only**, union-and-sort rather than replace, so it converges on both a fresh install and the
owner's already-migrated database. Key strings are **inlined and frozen** — never imported from
`@orderbook/shared`, which is the `20260301` defect.

The keys, from `docs/BACKEND_MODULES.md` §7:

| Key | Kind | Tier |
|---|---|---|
| `logs.view`, `logs.export` | module actions (new `logs` module) | office |
| `logs.verifyChain` | capability, `admin` group | office |
| `recycleBin.view` | capability | office |
| `recycleBin.viewAll` | capability | management |
| `fields.view` | capability | office |
| `documents.view` / `documents.create` / `documents.edit` | module actions (new `documents` module) | office |
| `documents.delete` | module action | management |
| `documents.render` | capability, `workflow` group | office |

Reused and **not** minted: `reports.view`, `reports.export`, `field.saleRate.view`, `leads.delete`,
`orders.delete`, `parties.delete`, `products.delete`, `roles.delete`, `users.manage`. Changed:
`fields.manage` lowered `admin` → `management`.

**The one shape rule to copy from `20260304`:** read `id`, `tenant_id`, `tier`, `permissions`;
compute `[...new Set([...stored, ...toGrant])].sort()`; `UPDATE` scoped by `{ id, tenant_id }`.

**The no-op test is `NEW_KEYS.every((key) => stored.includes(key))` — never a length comparison.**
`08-PERMISSIONS.md` owns the algorithm and this is its rule. A length test
(`if (merged.length === stored.length) continue;`) is wrong in a way that is invisible: `stored` is a
JSONB array with no uniqueness constraint, so **a stored array containing a duplicate makes the
merged set no longer than the stored array**, and the role is skipped — silently not granted the keys
it needs. Comparing membership costs nothing and cannot be fooled by a duplicate. The purpose is
unchanged: a role that already holds every key is untouched, and `updated_at` is not churned across
every installation.

**Gates** (`10-TESTING.md`):

- Running the migration twice grants the same set — idempotent by union.
- **A role whose stored `permissions` array contains a duplicate is still granted** — the gate that
  a length comparison fails and `every()` passes.
- No role below `admin` gains a key.
- Every key the batch minted appears in the migration's frozen list; the test reads the catalogue
  and the migration source and compares, so a key minted in Stage 6 and forgotten here turns red.
- The registry guard test still passes with all five new files present.

**Parallelism:** none. This is the last migration by definition.

---

### Stage 8 — Office Dashboard

**Size: small to medium.** **No new endpoints.**

The existing `DashboardSummary` / `dashboard.service` / `dashboard:changed` triple is reused,
extended with three figures, made per-figure permission-gated (absent, never `0`), and carried into
`SyncSnapshot.dashboard`. `master/src/repositories/dashboard.repository.ts` is new — the service
currently calls `db()` directly, a live layering violation this fixes.

**`openConflictCount` and `pendingSyncCount` are optional and gated on `sync.resolveConflicts`** —
consistent with every other figure being per-figure gated and simply **absent** when the key is not
held. They are not ungated "operational" numbers: a count of unresolved conflicts is a statement
about company data. `pipelineBreakdown`'s element is
`{ stageId, stageName, sequence, colourHex, leadCount }`. `04-API-CONTRACT.md` owns the type;
`05-EXISTING-CODE-CHANGES.md` conforms to it.

Counting client-side from the snapshot was rejected for a concrete reason: the snapshot is capped at
`SNAPSHOT_LIMIT = 500` and excludes converted leads, so client-side counts would be **silently
wrong** at scale. Online the panel gets a correct figure; offline it gets an honestly-labelled stale
one.

**Gates** (`10-TESTING.md`):

- `DashboardSummary` omits `leadCount` entirely for an actor without `leads.view` — the key is
  absent, not `0`.
- `dispatchedThisWeekCount` uses `config.locale.timeZone` and does not shift a Monday-morning
  dispatch into the previous week.
- The pipeline breakdown excludes converted leads and names stages from `pipeline_stages` rather
  than a hardcoded list.
- `buildSnapshot` still succeeds for an actor missing several module permissions — adding the
  dashboard must not make the snapshot all-or-nothing.
- `SyncSnapshot.dashboard` equals what `dashboard:get` returns for the same actor.
- **Every `SyncSnapshot` key is accounted for in `forCurrentUser`.** There is no such test today, so
  a newly added collection is a silent leak. This stage adds it. It does **not** close the module
  filtering gap — see §6 and open question 6.

**Two costs to accept before starting:**

- Making `DashboardSummary`'s fields optional is a source-breaking change for `master/web`. Every
  consumer must handle `undefined`, and `value ?? 0` would silently reintroduce the exact confident
  zero the change exists to prevent.
- Extending `dashboard:changed` to office panels multiplies its cost — it already re-derives per
  master-admin socket, and every lead/order/party/product/stock/conflict change would now also fan
  out per connected panel. It needs a trailing debounce, or a busy afternoon of stage moves becomes
  a query storm.

---

## 4. Rollback

### 4.1 What "rolling back" actually means here

Three facts, all verified, that together decide the answer:

1. **There is no rollback command.** `master/src/db/migrate-cli.ts` applies migrations and, with
   `--status`, lists them (`migrate-cli.ts:22-32`). It exposes no `migrate.rollback`. Nothing else
   in the repo calls it either. Running a `down()` today means writing a one-off script.
2. **`Migration.down` is a required member of the interface** (`master/src/db/migrations/index.ts:27`),
   so every file exports one — including the ones where the honest implementation is an empty body
   with a comment saying why. `20260304000000_role_tier_ceiling_repair.ts:89-94` is the precedent.
3. **The owner runs one PostgreSQL instance with real data and no second copy.** On the owner's dev
   PC, `pg_dump` exists (a locally installed PostgreSQL 17). On a bundled-binaries install it does
   **not** — the `@embedded-postgres` distribution contains server binaries only (`initdb`,
   `pg_ctl`, `postgres`), so there is no `pg_dump` and no `psql`.

So: **before every migration stage, take a `pg_dump` on the machine that has one.** That is the real
rollback story. `down()` is a convenience for a development database and a courtesy to a future
reader; it is not a recovery plan, because on a shop PC it is the only option and on a stage-2 or
stage-3 rollback it destroys data (below).

### 4.2 Per stage

| Stage | Migration | `down()` | What rolling back costs |
|---|---|---|---|
| 0 | none | — | `git revert`. `details` is optional on the wire, so a reverted Master and an un-reverted Office simply stop exchanging the field. |
| 1 | none | — | `git revert`, but wide: if `messageKey` went in as required, the revert touches the same 129 sites. No schema is involved, so there is nothing to lose. |
| 2 | `20260305` | **Deliberately empty, with a comment**, following the `20260304` precedent. | The reversal that *could* be written is the reason not to write one. Dropping `deleted_at` **un-deletes every soft-deleted row** and loses who deleted it — a data-resurrection event dressed up as a migration. And recreating the plain unique index on `parties(tenant_id, party_code)` **fails outright** if a live row and a soft-deleted row share a code, which is precisely the case the partial index was added to allow. An empty `down()` with the argument written into the file header is the honest implementation. `03-DATABASE.md` is the authority on this and on every other `down()` policy. |
| 3 | `20260306` | **Deliberately empty, with a comment**, same argument. | Dropping `option_lists.deleted_at` resurrects every removed value; deleting the seeded colour rows by `list_key` throws away any `hex` an administrator has assigned; and restoring `idx_pipeline_stages_seq` as a plain unique index silently reintroduces the mid-statement violation that made reordering impossible in the first place. Three destructive outcomes for a convenience nothing in the repo can invoke — `migrate-cli.ts` exposes no rollback at all. Empty, commented, and recovered from the `pg_dump` instead. |
| 4 | `20260307` | **Real**, but with one rule. | Dropping `actor_name` and the indexes is harmless — the column is outside the hash, so no chain breaks. The dangerous half is the trigger surgery: `down()` must restore `activity_log_chain()` from the **byte-identical body `20260303` installed, copied verbatim into the file**, not re-derived. A digest that differs by one character produces a chain where every row written after the rollback fails verification and nothing says why. |
| 5 | none | — | `git revert`. Reports is read-only and owns no schema. |
| 6 | `20260308` | **Real**, dropping the new tables. | Loses templates and export history. The `down()` does **not** remove the rendered PDFs on disk — a migration cannot reach the storage directory — so those must be swept by hand or they are orphans nothing references. |
| 7 | `20260309` | **Deliberately empty**, with a comment. | Following `20260304`'s argument verbatim: re-stripping permissions on a rollback is a privilege change dressed up as a migration. The grant is idempotent and re-runnable, so there is nothing to undo. |
| 8 | none | — | `git revert`. Note the `DashboardSummary` optional-fields change is source-breaking for `master/web` in both directions. |

---

## 5. Verification

### 5.1 The command sequence, run at the end of every stage

```powershell
# 1. The whole gate. Lint, typecheck (including tsconfig.test.json), then tests.
npm run verify

# 2. On Windows, integration suites need PostgreSQL binaries or they SKIP.
$env:ORDERBOOK_PG_BIN = "C:\Program Files\PostgreSQL\17\bin"
npm run verify
```

The Bash equivalent, which is what `HANDOFF.md` records:

```bash
ORDERBOOK_PG_BIN="/c/Program Files/PostgreSQL/17/bin" npm run verify
```

While iterating, a single file is faster than the suite:

```powershell
npx vitest run master/tests/recycle-bin.integration.test.ts
```

For a stage with a migration, before and after:

```powershell
npm run migrate -- --status      # what has been applied, what is pending
npm run migrate                  # apply
npm run migrate -- --status      # confirm the new file is listed as applied
```

### 5.2 The check that is not a command

**Confirm the suites actually RAN.** `npm run verify` is currently **333 tests across 21 files**;
`10-TESTING.md` §8 is the register that says how many files and cases each stage adds, and it is the
authority — do not keep a second copy of those numbers here. After a stage that adds fourteen tests,
the total must be 347. A stage that adds fourteen tests and
leaves the total at 333 has skipped all fourteen, and `describe.skipIf` prints "skipped" in a
summary line most people read as green. That is not a hypothetical: the Windows Postgres lookup was
broken for months and every integration gate silently did nothing, including the file that *is* the
`docs/ROLES_AND_USERS.md` §15 gate list.

So the acceptance check at every stage is two numbers, not one colour:

1. the file count rose by the number of files the stage added, and
2. the test count rose by the number of tests the stage added.

Each stage's pure suites are the ones that cannot skip, which is why every module in this batch has
at least one.

### 5.3 The migration registry check

Built in Stage 2, run at every stage after it: the directory listing of
`master/src/db/migrations/` (minus `index.ts`) must equal the `name` values in the registry array,
and each `name` must equal its filename minus `.ts`. A migration file written but not imported is a
silent no-op — the compiler is happy, the tests are green, and the column simply is not there.

---

## 6. Definition of done, per module

A module is done when **all** of these are true. This is a checklist to be walked, not a summary.

| # | Applies to | Done means |
|---|---|---|
| 1 | every module | Every endpoint exists, is mounted, and carries a `needs(...)` guard, with `credential-invariants.test.ts` extended to the new router so the guard count is asserted from the source. |
| 2 | every module | The Office path is one socket event, one `registerCommands()` line, one `forward()` route registered **after** the `requireUser` gate — answering 503 `{ error: 'unavailable' }` when the Master is unreachable, and **enqueuing nothing**. A test asserts the 503 and asserts the outbox is empty afterwards. |
| 3 | modules with a migration | The file exists, is in the registry array, the registry guard test passes, `--status` lists it as applied, and its `down()` either reverses the change or carries a comment saying why it deliberately does not. |
| 4 | every module | Every write goes through `recordActivity(entry, actor, trx)` inside the transaction. No new call to `recordDetachedActivity` anywhere. |
| 5 | every module | Every new permission key has a `permission.<key>` token in `en.ts` **and** `hi.ts`, and the Stage 1 coverage gate is still green. |
| 6 | every module | Every new `(entityType, action)` pair written to `activity_log` has a catalogue entry, and `master/tests/i18n-tokens.test.ts` proves it by reading the source. |
| 7 | modules returning money | A caller without `field.saleRate.view` gets the key **absent**, asserted as `'key' in obj === false`. Not null. Not zero. |
| 8 | modules returning dates | No value derived from a `DATE` or `timestamptz` reaches JS as a `Date` that could be `toISOString()`-ed. Month buckets are `'YYYY-MM'` TEXT from SQL. |
| 9 | every module | Typed API client wrappers exist in `master/web/src/api.ts` and `office/web/src/api.ts`. **No screen file, no `App.tsx` edit, no tab-table entry.** |
| 10 | every module | The stage's gates in `10-TESTING.md` are green **and confirmed to have run** — §5.2's two numbers. |
| 11 | every module | `HANDOFF.md` records what was built and any decision made along the way, per the repo's own working agreement. A decision that lives only in chat history is a decision that will be re-litigated. |

---

## 7. Risk register

Ranked by probability × damage, highest first. The ordering principle: a risk that fails **loudly**
ranks below one of the same size that fails **silently**, because a failed migration is an
afternoon and a wrong report is a decision made on bad numbers.

### 1. The IST date trap — Reports, Logs, the Office Dashboard

**Why first.** It has already shipped once in this codebase: `DATE` columns came back a day early
anywhere east of UTC because `toISOString()` converts to UTC first, and the owner's machine is IST.
The existing fix, `toIsoDate` (`master/src/repositories/mappers.ts:79-90`), has **no test coverage
at all** today. A report that is wrong by one day at the month boundary looks exactly like a report
that is right.

**Mitigation.** Month buckets computed in SQL against `config.locale.timeZone` and returned as
`'YYYY-MM'` TEXT; `report-range.ts` takes `today` as `{year, month, day}` components and never
constructs a `Date`; half-open `[from, to)` ranges everywhere, never `BETWEEN`; the direction
asymmetry of `AT TIME ZONE` written out in the repository's header rather than left to be inferred;
and `master/tests/report-range.test.ts` as a **pure** suite that cannot skip, including the
23:30-on-the-last-of-the-month case and the first test `toIsoDate` has ever had.

### 2. The 129-site `AppError` change — Stage 1

**Why second.** It is the largest single scoping item in the batch, it gates every other stage, and
it fails in two directions: too small (optional `messageKey`, and untranslated errors remain possible
forever) or too slow (a mechanical sweep that stalls the batch). It also touches tests that assert on
English message text.

**The count, stated so nobody re-derives it wrongly:** **129 throw sites across `master/src`, 0 in
`office/src`** — 126 by naive grep, plus 4 in `master/src/domain/conversion.ts` which grep skips
because the file contains a literal NUL byte and is therefore classified as binary, minus a 1-count
correction. **Verify with `grep -a`**, or better, read the tree with `readFileSync` the way
`credential-invariants.test.ts` does. The number of **hand-written tokens is 68**, not 129 — many
sites share one — and `05-EXISTING-CODE-CHANGES.md` holds the per-class breakdown that gets the sweep
from "129 edits" to "68 strings". Quoting 129 as the token count would triple the apparent size of
this stage.

**Mitigation.** Answer open question 1 **before Stage 1 starts**, not during. Make `message` derived
from the EN catalogue so `access.integration.test.ts` and `permissions.integration.test.ts` keep
passing byte-identical. Split the sweep by file between two people once `keys.ts` and the constructor
signature are agreed — it is wide, not deep. And gate it with the test that
`AppError.message === t(messageKey, params)` for every subclass, so the English fallback cannot drift
from the token later.

### 3. The `activity_log` trigger surgery — Stage 4

**Why third.** `20260307` factors the inline digest out of `activity_log_chain()` into
`activity_log_row_hash(...)`. If the extracted function's output differs from the inline expression
by a single byte, every row written afterwards chains against a different formula, and the only
symptom is that the verify button — which exists to prove nothing was tampered with — reports a break
at the row where the migration ran. The trigger also refuses UPDATE, so the surgery has to drop and
recreate rather than alter.

**Mitigation.** The extracted function is the inline expression **copied verbatim**, and the
migration proves it before it commits: hash a known row with both the old expression and the new
function and compare inside the migration itself, failing the migration if they differ. `down()`
restores the byte-identical `20260303` body from the file, not from memory. And the verify gates
include one that seeds a partial range from the predecessor rather than assuming genesis, which is
the case a mid-history formula change would break.

### 4. `hlc` stamping on soft delete — Stage 2

**Why fourth.** `leads`, `orders`, `parties` and `products` carry `version`/`hlc`/`field_hlc`, unlike
roles and users. Mirroring `softDeleteRole` exactly would bump `version` without advancing `hlc`,
leaving a state the merge engine cannot interpret: a queued offline edit with a later `hlc` wins on
every field and quietly writes to a tombstone. It is silent, it corrupts data, and it only happens
when a panel has been offline — which is the case least likely to be reproduced in testing.

**Mitigation.** Stamp `hlc` and `field_hlc.deleted_at` on delete **and** restore. Do not add
delete/restore `MutationKind`s — deletes are Master-online-only, matching the roles/users precedent —
and propagate to panels through the existing `publishChange`/`ChangedEntity` path with the new
`'restored'` action. The gate is the one that pushes a mutation over sync for a deleted record and
asserts it is rejected, and asserts a replay produces the same rejection.

### 5. Unique index versus table constraint — Stages 2 and 3

**Why fifth, not higher.** It fails loudly. `ALTER TABLE parties DROP CONSTRAINT
idx_parties_code_tenant` raises, Knex rolls the migration back, and the implementer sees it
immediately. The damage is an afternoon, not a data loss.

**Mitigation.** The verbs are settled: `DROP INDEX idx_parties_code_tenant;` then `CREATE UNIQUE
INDEX … WHERE deleted_at IS NULL` (`20260301000000_tenancy_access_and_sync.ts:144-150` shows what
they actually are). `idx_pipeline_stages_seq` is dropped and re-added as a **deferrable table
constraint**, because a unique index cannot be `DEFERRABLE`. `idx_pipeline_stages_one_default` is a
*partial* unique index and genuinely cannot become one, so default-swapping uses clear-then-set
ordering. The gate is the reorder test, which fails without `SET CONSTRAINTS DEFERRED` — and note
that `SET CONSTRAINTS` is a no-op outside a transaction, so the reorder must run inside one.

### 6. Large exports over the 15-second socket ack — Stages 4, 5, 6

**Why sixth.** It fails loudly and late: the export works in testing at a hundred rows and times out
in the shop at a hundred thousand. A 250,000-row CSV returns as one value in one ack, buffered whole
on both sides, through `masterConnection.command`'s 15-second timeout
(`office/src/realtime/master-connection.ts:239-248`).

**Mitigation.** This is open question 3 and it must be answered **before Stage 4 ships an export
route**, not discovered afterwards. One answer covering all three modules: cap the Office-side export
far lower and say so in the UI, chunk it cursor-wise and assemble it on the Office server before it
streams to its own browser, or declare export Master-only. Whatever is chosen, the Master-side export
is unaffected — this is a panel-path decision.

### 7. The unbounded colour usage scan — Stage 3

**Why last of the seven.** It is slow, not wrong, and slowness is visible. Opening Fields → Colours
would sequentially scan `stock_movements` — the append-only ledger, projected into the millions by
`docs/schema/05` — because no index leads with `colour` on any of the usage sources
(`idx_inventory_product_colour` is `(tenant_id, product_id, colour)`, the wrong leading column).

**Mitigation.** Drop `stock_movements` from the usage count entirely. The other three sources —
`line_item_quantities`, `inventory_stock`, `stock_reservations` — answer "is this colour in use"
adequately, and the question the screen asks is a yes/no dressed as a number. Keep the one-query-per-set
shape; an N-per-value probe would be worse at every size. Measure the ledger's row count first (§2.2)
so the decision rests on the owner's data rather than on a projection.

### Also on the register — lower, but not zero

| Risk | Mitigation |
|---|---|
| **PDFKit's Devanagari shaping is unverified.** "fontkit has an Indic shaper" and "renders शर्मा टाइल्स correctly at 9pt" are different claims, and nobody has rendered one. | The §2.2 spike, run **before** Stage 6 starts. If it fails, the fallback ladder is pre-shaping with a bundled HarfBuzz WASM build drawn through pdf-lib — not headless Chromium, which means a large postinstall download, and the silent-postinstall-failure trap has bitten this project once already. |
| **`buildSnapshot` is all-or-nothing.** It is a `Promise.all` over services that each call `requirePermission`, so one missing key produces **no snapshot at all**, swallowed into a log line. | Stage 3 keeps `GET /api/pipelines`, `/api/option-lists` and `/api/custom-fields` on the repository path deliberately. A reviewer "tidying" that into a `fields.view`-checking service is the single most likely way to break the panel for every user, and it belongs in a file-header comment, not only here. |
| **The Office cached snapshot is not module-filtered.** `forCurrentUser()` re-masks `field.saleRate.view` and replaces `permissions`; it filters nothing by module. The tab is hidden, the rows are not. | Out of scope by open question 6. This batch must not **widen** it, and Stage 8 adds the test asserting every `SyncSnapshot` key is accounted for — there is none today, so a newly added collection is a silent leak. Closing it properly needs its own owner. |

---

## 8. Known-open, and not closed by this batch

Stated so they are not mistaken for oversights, and so nobody schedules them into a stage above:

- `applied_mutations` atomicity — the projection, the bookkeeping row and the id mapping open three
  separate transactions.
- `panel:revoked` is defined in the socket contract and handled by the Office Panel, and the Master
  never emits it.
- The audit trail's 14 best-effort `recordDetachedActivity` call sites across six existing services
  (`catalog` 4, `lead` 3, `order` 2, `panel` 2, `inventory` 2, `auth` 1). New modules must not add to
  them; the existing ones are not this batch's work.
- Module-level filtering of the Office snapshot (§7, above).
- Retention and pruning for `activity_log` and `document_exports`. `docs/schema/05` promises
  export-then-prune, and the `activity_log_no_delete` trigger means a pruner cannot simply `DELETE`.
  This batch is what will make the growth visible, which is a reason to expect the question, not a
  reason to answer it here.
- Large CSV/PDF payloads over the 15-second socket ack, until open question 3 is answered.
