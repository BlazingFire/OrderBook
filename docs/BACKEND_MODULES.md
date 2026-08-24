# Backend build plan — the six new modules

Status: **planning complete, nothing built.** This is the backend half of `docs/UI_REDESIGN.md`.
It covers the six modules the supplied design implies but the product does not have: **Fields
management**, **Logs**, **Recycle Bin**, **Reports**, **PDF Designer**, and the **i18n /
translation layer**, plus the **Office-side Dashboard aggregate**.

Produced by mapping every touched subsystem, designing each module against those facts, and running
an adversarial completeness pass over the result. §2 records the cross-cutting decisions that had to
be settled before any module could be written, because four independent designs collided on them.

---

## 0. Owner decisions this plan implements

| Question | Answer | How it lands |
|---|---|---|
| Module-to-app split | **All users, both panels** — not Master-admin-only | Every module is permission-gated and forwarded to the Office over the existing Socket.IO command contract (§6) |
| Orders board vs table | **Both** | Frontend-only; no backend change (the list endpoint already serves both shapes) |
| Master chrome | **Permanently dark** | Frontend-only |
| Master presence rail | Aggregate panel/conflict health | Reuses existing dashboard + conflict counts; no new endpoint |
| `t()` translation layer | **Build it** | §4 — and it is much cheaper than first estimated, see below |
| Phase 3 order | Confirmed | §9 build order |

**The i18n estimate was wrong and is now corrected.** `docs/UI_REDESIGN.md` §4.4 sized this as a
sweep of every string in ~4,000 lines of JSX. That was based on `HANDOFF.md` calling the layer "not
built". In fact `shared/src/domain/permissions.ts` already emits a `labelToken` on every catalogue
entry (`permission.lead.convert`, `module.leads`, `capabilityGroup.workflow`, `roleTemplate.sales`)
with an explicit comment that "the renderer never hard-codes the English", and `activity_log`
already stores `(entity_type, action, details JSONB)` rather than English sentences. The token
contract is real and load-bearing; what is missing is the catalogue, `t()`, and a locale picker.

---

## 1. Verified starting state

Several items in the design brief for this batch were based on `HANDOFF.md`'s pre-"second wave" text
and are **already fixed** — the error envelope carries `details`
(`http/middleware/error-handler.ts:28-32`), duplicate names return 409 with `{field, value}`
(`domain/access.ts:160-169`), `expectedVersion` is mandatory and its absence throws with
`storedVersion` attached (`domain/access.ts:183-192`), and unknown-username sign-in failures are
recorded (`services/auth.service.ts:366`). All four verified by reading the code. `HANDOFF.md`'s
"Second wave of audit fixes" section already records them; nothing here re-does that work.

**One thing this plan initially got wrong, corrected here.** The audit trail is **not** atomic
everywhere. `recordActivity` does require a `TransactionContext` — but `recordDetachedActivity`
exists beside it and swallows failures into a warning, and **14 call sites across six services use
it**: `catalog.service.ts` (4), `lead.service.ts` (3), `order.service.ts` (2), `panel.service.ts` (2),
`inventory.service.ts` (2), `auth.service.ts` (1). Only roles and users are genuinely atomic, exactly
as `HANDOFF.md` says.

> **Requirement for every new module: use `recordActivity` with the transaction, never
> `recordDetachedActivity`.** The detached variant is for the narrow case of recording a *failed*
> operation that has no successful change to be atomic with — a refused sign-in. A Fields edit, a
> soft delete, or a PDF export all have a transaction to belong to. Getting this wrong is invisible
> until the trail has holes, and the holes appear exactly when something is going wrong.

Still genuinely open and **not** closed by this batch: `applied_mutations` atomicity, `panel:revoked`
never emitted, the audit trail's best-effort call sites in the six services above, and the Office
snapshot's lack of module-level filtering (§8.1).

---

## 2. Cross-cutting decisions — settle these before any module starts

Four independent designs collided on five shared resources. These are the resolutions; every module
below assumes them.

### 2.1 One `CursorPage<T>`, one owner

Three designs each added a `CursorPage<T>` to `shared/src/domain/inputs.ts`, two of them with
structurally different shapes. That is a duplicate-identifier error across all four packages, since
`shared/src/index.ts` is eleven `export *` lines. The UI spec forbids page numbers everywhere, so
this primitive is needed by four modules and must be minted once:

```ts
// shared/src/domain/inputs.ts — beside the existing offset-based Paginated<T>
export interface CursorQuery { cursor?: string; direction?: 'older' | 'newer'; limit?: number }
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;   // null for one-directional feeds
  limit: number;
}
```

`Paginated<T>` stays — it is offset-based and still correct for the existing list endpoints. The new
type is a sibling, not a replacement.

Likewise **one cursor codec**: `master/src/domain/cursor.ts`, a pure opaque base64url encoder.
Three designs each proposed their own (`log-cursor.ts`, `cursor.ts`, and inline in
`recycle-bin.ts`). Module-specific cursor *payloads* build on the one codec.

### 2.2 Migration timestamps, allocated up front

Three designs each claimed `20260305000000` **and** `20260306000000`. The registry at
`master/src/db/migrations/index.ts` is an explicit hand-maintained array — a file written but not
imported is a silent no-op — so the range is allocated here:

| Timestamp | File | Owner |
|---|---|---|
| `20260305000000` | `_soft_delete_columns.ts` | Recycle Bin |
| `20260306000000` | `_field_values_and_stage_ordering.ts` | Fields |
| `20260307000000` | `_activity_log_actor_name.ts` | Logs |
| `20260308000000` | `_document_templates_and_exports.ts` | PDF Designer |
| `20260309000000` | `_new_module_permission_grant.ts` | **Shared — one migration, last** |

`Migration.down` is a required member of the interface (`index.ts:27`), so every file exports one
even when it is deliberately empty with a justifying comment (the `20260304` precedent).

### 2.3 One permission-grant migration, one policy

Three designs each wrote their own grant migration, with three *different* policies — and one of
them granted new keys to **every existing role**. That is precisely the act the no-wildcard rule
exists to prevent: *"a wildcard would silently add every permission the product ever gains to a role
somebody approved before those permissions existed"* (`permissions.ts:224-233`). Granting
`recycleBin.view` to a role nobody re-approved is the same act with extra steps.

**One migration, `20260309000000`, granting every new key to `tier = 'admin'` only.** Non-admin roles
receive new keys through the permission grid, by an administrator who chooses them. The migration
unions-and-sorts rather than replacing, so it converges on both a fresh install and the owner's
already-migrated database. Key strings are **inlined and frozen**, never imported from
`@orderbook/shared` — the `20260301` defect.

> **A conflict needing one recorded decision.** `20260303000000_roles_and_users.ts:21` still does
> `import { allPermissions } from '@orderbook/shared'` and spends it at line 331. That is live, and it
> is exactly the trap the registry header forbids. But the same header also forbids editing an
> applied migration. Both rules cannot hold. **Recommendation: leave it.** The union-based grant
> migration makes the outcome correct on every install regardless, and editing an applied migration
> is the more dangerous of the two rules to break. Record the decision in `HANDOFF.md` so it is not
> rediscovered as a bug a third time.

### 2.4 One timezone config key

Two designs added the same `ORDERBOOK_TIMEZONE` env var at two different config paths. Nothing pins
a timezone today — `buildKnexConfig` passes no `SET TIME ZONE`.

```ts
// master/src/config/index.ts
locale: {
  timeZone: process.env.ORDERBOOK_TIMEZONE ?? 'Asia/Kolkata',
  defaultLocale: isLocale(process.env.ORDERBOOK_DEFAULT_LOCALE) ? … : 'en',
}
```

Validated once at startup after `runMigrations()` with `SELECT now() AT TIME ZONE $1`, aborting with
a message naming the variable if Postgres raises `invalid_time_zone`. This key also serves i18n date
formatting later, which is why `locale` rather than `reporting`.

### 2.5 The socket ack must carry `details` — prerequisite for two modules

`CommandResult<T>`'s `{ ok: false }` arm (`shared/src/protocol/socket.ts:142-159`) has `code?` and
`missingPermission?` and nothing else. `hub.ts` `respond()` never sets `code` at all except for
`ForbiddenError`, and never sends `details`. So on the Office Panel, every structured conflict
arrives as a bare English string.

Two modules depend on structured conflict data reaching the Office browser — the Recycle Bin's
`blockedBy` list and rename `suggestion`, and the PDF Designer's `storedVersion`/`diff` from
`assertVersionMatches`. **~15 lines, one owner, built first:**

- `shared/src/protocol/socket.ts` — add `details?: Record<string, unknown>` to the `{ ok: false }` arm
- `master/src/realtime/hub.ts` `respond()` — set `code`, `details` (and `messageKey`/`params`, §4) for any `AppError`, not only `ForbiddenError`
- `office/src/realtime/master-connection.ts` — carry them on `MasterCommandError`
- `office/src/http/app.ts` `forward()` — pass them through alongside the permission it already forwards

---

## 3. What this batch is, and is not

**It is backend only.** No screen files, no `App.tsx` edits, no tab-table entries.

This is a deliberate correction to the module designs, three of which added tab entries to
`office/web/src/App.tsx`'s `visibleTabs` array while creating no screen to render — which would ship
tabs pointing at nothing. Eight screens (Master and Office × Logs, Reports, Recycle Bin, Fields) plus
the two Documents screens and the Office Dashboard belong to the UI phase in `docs/UI_REDESIGN.md`
§8, built on the `ui/` component package, against these endpoints once they are real.

The one exception is the **API client wrappers** (`master/web/src/api.ts`, `office/web/src/api.ts`) —
typed functions with no UI attached. They are how the endpoints get exercised before screens exist.

---

## 4. Foundation: the i18n layer

Built first, because `AppError`'s constructor signature is a dependency of every other module.

### 4.1 The decision everything else follows from

**The server never renders a user-facing sentence.** It returns a stable `messageKey` plus named
params; the client renders. This is forced rather than chosen: locale is per-machine and never
synced, so one Master serving several panels has no recipient locale to render for.

It pays off three times:

- **`activity_log` needs no change to what it stores.** `(entity_type, action, details)` is already
  token-plus-params, so the hash chain covers permanent, language-free facts and rendering stays
  outside the chain. An entry written today renders in Hindi tomorrow with no schema change and no
  chain rewrite. *(This resolves the sharpest cross-design contradiction: the i18n and Logs designs
  gave opposite answers about the log until it was noticed that they were answering different
  questions — what the chain **covers** versus what the table **carries**. The chain input is
  `prev_hash|sequence|entity_type|entity_id|action|actor_type|actor_id|details`; the `actor_name`
  column Logs adds sits outside it and is therefore safe.)*
- **The error envelope needs only additive fields** on top of the `code`/`details` contract it already has.
- **It degrades not at all offline** — both catalogues are compiled into the panel's bundle before it
  ever contacts a Master. This is the only one of the six modules that is fully functional offline.

### 4.2 Catalogues are compiled TypeScript, not a database table

A key exists only because code references it. A `.ts` catalogue makes a missing or misspelt key a
**compile error**; a table cannot. `hi.ts` is typed `Record<MessageKey, string>` — **total, not
partial** — so adding an English key turns the build red until Hindi exists.

### 4.3 Files

```
shared/src/i18n/
  en.ts          THE source of truth. `EN_MESSAGES = {...} as const`; dotted keys, NAMED {placeholders}
  hi.ts          Devanagari. Record<MessageKey, string>, total
  keys.ts        MessageKey = keyof typeof EN_MESSAGES; Placeholders<S> recursive template-literal type
  locales.ts     LOCALES/Locale/isLocale/LOCALE_LABELS (each label in its own script)
  translate.ts   t(), tCount(), createTranslator(locale). NO number formatting — spec §10
  activity.ts    activityMessageKey(entityType, action) — the contract Logs renders against
  errors.ts      ErrorPayload/TranslatableError — one wire shape for the HTTP envelope AND the socket ack
  pseudo.ts      dev-only en-XA: pads every string to 1.4x and brackets it, making spec §10's
                 "survive 1.4x expansion" testable instead of aspirational
  index.ts       barrel, explicit .js specifiers (NodeNext house convention)

master/src/domain/i18n-tokens.ts   pure invariant: every (entityType, action) written to
                                   activity_log has a catalogue entry

{master,office}/web/src/i18n/      LocaleProvider.tsx, storage.ts, useErrorMessage.ts
{master,office}/web/src/components/ LocalePicker.tsx, Untranslated.tsx

tools/eslint-rules/no-untranslated-jsx-text.js   in-repo flat-config rule, no new dependency
tools/i18n-sync.mjs                              appends missing HI keys with EN text + a TODO marker
```

`<Untranslated>{order.id}</Untranslated>` is the semantic suppression affordance — it *documents*
that a string is an identifier rather than prose, which matters because the spec forbids translating
or reformatting numbers, IDs and fingerprints.

### 4.4 The one genuinely large decision: is `messageKey` required?

`AppError` gains `messageKey` and `params`. Making `messageKey` **required** is the only thing that
makes an untranslated error impossible — but there are **126** throw sites across `master/src` and
`office/src` (`domain/access.ts` 12, `lead.service.ts` 16, `order.service.ts` 14, `user.service.ts`
14, `catalog.service.ts` 11, …), each needing a token and each token needing an EN and a HI string.

**Recommendation: required**, with `message` *derived* from the EN catalogue so existing tests that
assert on English message text keep passing byte-identical (`access.integration.test.ts` and
`permissions.integration.test.ts` both do). The work is wide but genuinely mechanical, and optional
means untranslated errors remain possible forever — which given "no build it" is not the intent.

This is the single largest scoping item in the batch. Flagging it rather than assuming it.

### 4.5 Gates

- `shared/tests/i18n-coverage.test.ts` — every key in `PERMISSIONS` has a `permission.<key>` token;
  every module, capability group and role template has its token; `hi.ts` is total. **This is what
  makes the existing `labelToken` contract load-bearing rather than decorative.**
- `master/tests/i18n-tokens.test.ts` — source-reading invariant in the established
  `credential-invariants.test.ts` style: scans services for `recordActivity` call sites and asserts
  every `(entityType, action)` pair has a catalogue entry.
- Both are **pure** suites with no `describe.skipIf`, so they cannot silently skip.

---

## 5. Module file structure

Common shape per module, following the clean-architecture layering (decision 12) — pure rules in
`domain/`, orchestration in `services/`, all SQL in `repositories/`, parse-and-delegate in `http/`.
Every new router copies `access.routes.ts` (the only existing router using
`requirePermissionMiddleware`), not `data.routes.ts`.

### 5.1 Logs

```
shared/src/domain/activity.ts                    ActivityLogEntry, ActivityActor, ActivityLogQuery,
                                                 ActivityLogFacets, ChainVerification, ChainBreak
master/src/domain/log-cursor.ts                  keyset cursor payload (on the shared codec, §2.1)
master/src/repositories/activity-log.repository.ts   EXTENDED: listEntries, listFacets, verifyChain, streamForExport
master/src/services/log.service.ts
master/src/http/routes/log.routes.ts             mounted /api/logs
master/src/lib/csv.ts                            dependency-free CSV writer, shared with Reports
master/src/db/migrations/20260307000000_activity_log_actor_name.ts
master/tests/logs.integration.test.ts
```

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/logs` | `logs.view` | Keyset, newest-first, Newer/Older only — no page numbers |
| `GET /api/logs/facets` | `logs.view` | Populates filter dropdowns |
| `POST /api/logs/verify` | `logs.verifyChain` | Re-walks and re-computes sha256 **in SQL** |
| `GET /api/logs/export` | `logs.export` | CSV; separate route so the key gates a distinct code path |

**Chain verification must run in SQL.** The digest covers `details::text` — Postgres's own JSONB
rendering — so Node cannot reproduce the bytes. The migration factors the inline digest expression
out of `activity_log_chain()` into a reusable `activity_log_row_hash(...)` function.

**`actor_name` and the 24 call sites.** The Logs design adds `activity_log.actor_name TEXT` so a
deleted user's name still renders. But `recordActivity` is called with an object literal at ~24 sites;
none would set it, giving a column that works for backfilled history and is `NULL` for everything
written afterwards — worse than not having it. **Resolution: change the signature to
`recordActivity(entry, actor, trx)` and derive the name inside**, making "forgot to set it" a compile
error, in the same spirit as the already-required `trx`.

**Add `(tenant_id, created_at DESC)`.** The existing `idx_activity_log_created` is not tenant-prefixed,
and the date filter and facets both need it.

### 5.2 Reports

```
shared/src/domain/reports.ts          all money fields OPTIONAL, so redaction can delete them
master/src/domain/report-range.ts     THE date-safety module
master/src/domain/lead-outcome.ts     the "went quiet" rule as a pure classifier
master/src/repositories/report.repository.ts   five raw-SQL GROUP BY functions
master/src/services/report.service.ts
master/src/http/routes/report.routes.ts        mounted /api/reports
master/tests/report-range.test.ts              PURE — cannot silently skip
master/tests/reports.integration.test.ts
```

| Endpoint | Permission |
|---|---|
| `GET /api/reports/dispatches` | `reports.view` |
| `GET /api/reports/lead-outcomes` | `reports.view` |
| `GET /api/reports/top-parties` | `reports.view` |
| `GET /api/reports/:report/export` | `reports.export` |

`reports.view` and `reports.export` **already exist** in the catalogue with no `MINIMUM_TIER` entry —
so they already default to `office` tier and are already available to every user, exactly matching
the "for all users" decision. This module is their **first enforcement site anywhere in the
codebase**; today they render as togglable grid cells that gate nothing.

**The single highest-risk detail in the whole batch.** `HANDOFF.md` records that `DATE` columns came
back a day early east of UTC because `toISOString()` converts to UTC first. Every calendar boundary
and month bucket is therefore computed **in SQL against the configured business timezone** and
returned as a `'YYYY-MM'` TEXT label — no date-derived value ever becomes a JS `Date` that something
could `toISOString()`. `report-range.ts` takes `today` as `{year, month, day}` components and never
constructs a `Date`. `master/tests/report-range.test.ts` pins it, including an order dispatched at
23:30 IST on the last of the month landing in the right bucket. Note the existing fix, `toIsoDate` at
`mappers.ts:79-90`, currently has **no test coverage at all** — this would be its first.

**Rate redaction.** A user without `field.saleRate.view` gets money columns **absent**, not zeroed and
not null — and totals are computed server-side over the same filtered set, never summed by the client
from masked buckets.

### 5.3 Recycle Bin

```
shared/src/domain/recycle-bin.ts       RECYCLE_BIN_ENTITIES, BinEntry, BinBlocker, RESTORE_PERMISSION
master/src/domain/recycle-bin.ts       PARENT_LINKS (upward-only restore graph), suggestRestoredName
master/src/repositories/recycle-bin.repository.ts   the ONLY cross-table SQL: UNION ALL over 8 tables
master/src/services/recycle-bin.service.ts
master/src/http/routes/recycle-bin.routes.ts        mounted /api/recycle-bin
master/src/db/migrations/20260305000000_soft_delete_columns.ts
master/tests/recycle-bin.integration.test.ts
master/tests/recycle-bin-domain.test.ts             PURE
```

Per-entity soft-delete/restore writes live in **each entity's own repository**; only the cross-table
read is new. `leads`, `orders`, `parties`, `products` gain `deleted_at`/`deleted_by` (roles and users
already have them).

**A roles/users-scoped Recycle Bin already exists** — `HANDOFF.md`'s second wave added it inside
`AccessScreen.tsx` (`function RecycleBin`, ~line 963), which is what finally gave `restoreRole` and
`restoreUser` a caller. The cross-entity Bin **subsumes** it: those two entity types become two rows
in the unified feed, `AccessScreen`'s inline section is replaced by a link into the Bin pre-filtered
to roles and users, and the existing restore services are reused rather than reimplemented. This is
an extension of working code, not a rewrite of it.

`DELETE /api/leads|orders|parties|products/:id` are the **first enforcement sites** for
`leads.delete`, `orders.delete`, `parties.delete`, `products.delete` — four keys that have been in the
frozen catalogue and in stored role rows since `20260303`, render as grid cells, and are checked
nowhere because no delete path exists for any of the four.

Three decisions worth stating:

- **Restore reuses the entity's own delete key** (`RESTORE_PERMISSION[entityType]`), so restore can
  never be a back door onto an entity you may not delete. No `recycleBin.restore` key is minted, and
  there is no purge at all.
- **Scope is `deleted_by = me`** unless the actor holds `recycleBin.viewAll` (management+). Note the
  consequence: a deletion by an unattended Office Panel has `deleted_by NULL` and is visible only to
  `viewAll` holders.
- **Name collisions on restore are real** — a party deleted and recreated under the same name will
  happen. Restore returns 409 with `suggestRestoredName`'s answer in `details`, which is why §2.5 is
  a prerequisite.

**Two corrections to the design:**

1. **The DDL verb was wrong.** The design says "DROP the plain unique constraints on
   `parties(tenant_id, party_code)`". They are unique **indexes**, not table constraints
   (`20260301:144-150`), so `ALTER TABLE … DROP CONSTRAINT` fails. Correct: `DROP INDEX
   idx_parties_code_tenant;` then recreate `WHERE deleted_at IS NULL`. The *intent* is right and
   important — a soft-deleted party would otherwise reserve its code forever.
2. **Soft-deleting a syncable entity must stamp `hlc`.** `leads`/`orders`/`parties`/`products` all
   carry `version`/`hlc`/`field_hlc`, unlike roles and users. Mirroring `softDeleteRole` exactly
   would bump `version` without advancing `hlc`, leaving a state the merge engine cannot interpret —
   a queued offline edit with a later `hlc` would win on every field and quietly write to a tombstone.
   **Resolution: stamp `hlc` and `field_hlc.deleted_at` on delete and restore**, but do **not** add
   delete/restore `MutationKind`s — deletes are Master-online-only, matching the roles/users
   precedent, and propagation to panels happens through the existing `publishChange`/`ChangedEntity`
   path with a new `'restored'` action.

### 5.4 Fields

```
shared/src/domain/fields.ts            FieldCatalogue — the screen renders from a served descriptor,
                                       modelled on buildPermissionCatalogue()
master/src/domain/field-values.ts      normaliseOptionValue — trims, DELIBERATELY does not case-fold
master/src/repositories/field-usage.repository.ts   one query per SET, never one per value
master/src/services/fields.service.ts
master/src/http/routes/fields.routes.ts             mounted /api/fields
master/src/db/migrations/20260306000000_field_values_and_stage_ordering.ts
master/tests/fields.integration.test.ts
master/tests/field-values-domain.test.ts            PURE
```

**Colour hex.** `option_lists` gains a nullable `hex` column, back-filled from the distinct colour
strings already present in the stock tables. The five colour columns and `stockKey()` are **not
touched** — a colour with no `option_lists` row stays a normal state and renders through the
two-letter ring fallback the design spec already defines. A value's identity remains the exact string
it always was, which is what makes "removing a value never touches the records that used it" true
rather than aspirational: remove sets `deleted_at`, records keep their string, and the UI still
renders it.

**Pipeline stage ordering.** `idx_pipeline_stages_seq` is a unique *index* and a unique index cannot
be `DEFERRABLE`; reordering therefore needs it dropped and re-added as a deferrable table constraint.
`idx_pipeline_stages_one_default` is a *partial* unique index and genuinely cannot become one, so
default-swapping uses clear-then-set ordering.

**Two things to fix from the design:**

- **`fields.manage` tier.** The design lowers it `admin` → `management` while arguing it must be
  reachable by Office Panel users — but an unattended panel falls back to an **office**-tier role, so
  at `management` the stated goal is still unmet by its own argument. **Resolution: state it plainly
  — Fields *reading* is ungated (`fields.view`, no ceiling), Fields *editing* is management+.** That
  is defensible: letting any office user rename a pipeline stage would reorder every board in the
  company. Lowering a ceiling never strips a stored key, so no tier-repair migration is needed.
- **The usage count is an unbounded scan.** `usageForListKey('stock.colour')` groups over
  `line_item_quantities`, `inventory_stock`, `stock_reservations` **and `stock_movements`** — and no
  index leads with `colour` on any of them (`idx_inventory_product_colour` is
  `(tenant_id, product_id, colour)`, wrong leading column). `stock_movements` is the append-only
  ledger, projected into the millions by `docs/schema/05`. Opening Fields → Colours would seq-scan it.
  **Resolution: drop `stock_movements` from the usage count** — the other three sources answer "is
  this colour in use" adequately.

**Leave the three existing reads alone.** `GET /api/pipelines`, `/api/option-lists` and
`/api/custom-fields` stay gated by `requireAuth` only. Routing them through a `fields.view` check
would make `buildSnapshot`'s `Promise.all` reject for anyone lacking the key — and a rejected
`buildSnapshot` produces **no snapshot at all**, swallowed into a log line. The new `/api/fields/*`
surface is separate.

### 5.5 PDF Designer

The largest module, and the one previously deferred on purpose (`docs/LEAD_GENERATION_FLOW.md` §11).

```
shared/src/domain/documents.ts
master/src/domain/document-template.ts    assertTemplateValid (margins, paper, orientation)
master/src/domain/document-model.ts       THE seam: masked record + template → pure DocumentModel
master/src/domain/document-text.ts        splitByScript() → 'body' | 'devanagari' | 'mono' runs
master/src/repositories/document-template.repository.ts
master/src/repositories/document-export.repository.ts
master/src/repositories/document-asset.repository.ts
master/src/services/document.service.ts           template CRUD
master/src/services/document-render.service.ts    the only importer of pdf/
master/src/pdf/renderer.ts                DocumentModel → Buffer. Infrastructure, peer of realtime/
master/src/pdf/fonts.ts                   registers the vendored faces with PDFKit once per process
master/src/pdf/primitives.ts              table(), colourChip() with the two-letter ring fallback
master/src/lib/document-files.ts          disk I/O (no Knex, so deliberately outside repositories/)
master/src/http/routes/document.routes.ts mounted /api/documents
master/assets/fonts/                      Inter-Regular, Inter-SemiBold, IBMPlexMono-Regular,
                                          NotoSansDevanagari-Regular (+ LICENSES.md)
master/src/db/migrations/20260308000000_document_templates_and_exports.ts
master/tests/document-fonts.test.ts       PURE — THE Devanagari gate
master/tests/document-model.test.ts       PURE — rate columns ABSENT, not zero, not null
master/tests/document-{template,render}.integration.test.ts
```

**Rendering is server-side, in the Master, with bundled PDFKit + fontkit.** The permission rule
settles it and the argument is worth keeping: rate redaction is decided from the `ActorContext`, the
rate column must be **absent from the document** rather than zeroed, and the export must be recorded
in `document_exports` **and** `activity_log` in one transaction — none of which a client-side
renderer can be trusted with or is even able to do.

**Devanagari support is a hard requirement and eliminates several popular PDF libraries** that ship
WinAnsi encoding only. Party names, addresses and terms in Hindi are unrenderable without it.
`master/tests/document-fonts.test.ts` runs fontkit's `layout()` against the vendored face directly —
a pure suite, so the gate cannot silently skip. All four faces are SIL OFL 1.1, which explicitly
permits PDF embedding; `LICENSES.md` ships alongside so the vendored binaries are auditable with no
network access.

**The real permission key is `field.saleRate.view`.** The design brief called it `products.rate.view`;
that string does not exist in the catalogue. Rendering additionally requires the subject's own view
key (`leads.view` / `orders.view`), so document access can never exceed record access.
`reports.export` is deliberately **not** reused — overloading it would make unticking one silently
disable the other.

### 5.6 Office Dashboard

**No new endpoints.** The existing `DashboardSummary` / `dashboard.service` / `dashboard:changed`
triple is reused, extended with three figures, made per-figure permission-gated (absent, never `0`),
and carried into `SyncSnapshot.dashboard`.

Counting client-side from the snapshot was rejected for a concrete reason: the snapshot is capped at
`SNAPSHOT_LIMIT = 500` and excludes converted leads, so client-side counts would be **silently
wrong** at scale. Online the panel gets a correct figure; offline it gets an honestly-labelled stale
one.

```
master/src/repositories/dashboard.repository.ts   leadCountsByStage, dispatchedThisWeek
                                                  (dashboard.service currently calls db() directly —
                                                   a live layering violation this fixes)
```

---

## 6. How the Office reaches all six modules

Every module is **forwarded live and fails hard offline** — except i18n, which needs nothing.

The mechanism is uniform and invents nothing: one event in `ClientToServerEvents`, one line in the
Master hub's `registerCommands()` using the existing `run(ack, actor => …)` shape, and one
`forward(res, '<event>', payload)` route in `office/src/http/app.ts` registered **after** the
positional `app.use('/api', requireUser)` gate at line 133. `forward()` already maps
`MasterCommandError.unreachable` to 503 `{ error: 'unavailable' }`.

Two invariants that must not be broken:

- **The actor is resolved per command** via `actorFor()`, never captured at connect time. A socket
  outlives sign-ins, sign-outs and role edits.
- **Offline is decided from the transport flag, never by reading the error message.** A Postgres
  "canceling statement due to statement timeout" is a message the Master *sent* — it means refused,
  not silent.

**Nothing here is queued into the outbox**, deliberately. A queued render would emit a legally-shaped
quotation hours later against a lead whose lines had since changed; a queued delete or field edit has
the same character. This matches the roles/users precedent.

---

## 7. Permission catalogue changes

New keys, all added to `shared/src/domain/permissions.ts`:

| Key | Kind | Tier | Note |
|---|---|---|---|
| `logs.view`, `logs.export` | module actions (new `logs` module) | office | |
| `logs.verifyChain` | capability, `admin` group | office | |
| `recycleBin.view` | capability | office | scoped to your own deletions |
| `recycleBin.viewAll` | capability | management | sees everyone's |
| `fields.view` | capability | office | management read surface only |
| `documents.view/create/edit` | module actions (new `documents` module) | office | |
| `documents.delete` | module action | management | matches the other `*.delete` keys |
| `documents.render` | capability, `workflow` group | office | |

**Reused, not minted:** `reports.view`, `reports.export`, `field.saleRate.view`, `leads.delete`,
`orders.delete`, `parties.delete`, `products.delete`, `roles.delete`, `users.manage` — nine existing
keys, seven of which currently enforce nothing anywhere. `HANDOFF.md`'s own rule applies: *"A
permission that enforces nothing is worse than a missing one."*

**Changed:** `fields.manage` lowered `admin` → `management` (§5.4).

---

## 8. Known gaps this batch does not close

Stated so they are not mistaken for oversights:

1. **The Office cached snapshot is re-masked for the right person, but only on one axis.**
   `HANDOFF.md`'s second wave correctly fixed *whose* masking is applied — `forCurrentUser()` runs
   for whoever is signed in **now**, not whoever the snapshot was fetched for, and tabs are gated by
   permission. What it does **not** do is filter by module: `forCurrentUser()`
   (`office/src/http/app.ts:395-407`) re-masks `field.saleRate.view` and replaces `permissions`, so
   `/api/snapshot` and the SSE `snapshot` event still hand the browser every lead and order row
   regardless of whether the session holds `leads.view`. The tab is hidden; the data is not. These
   are two different axes and only the first is closed. This batch must not widen the second, and
   adds a test asserting every `SyncSnapshot` key is accounted for in `forCurrentUser` — there is
   none today, so a newly added collection is a silent leak. **Closing it properly needs its own owner.**
2. **CSV/PDF payloads over a 15-second socket ack.** A 250,000-row export returns as one value in a
   single ack, buffered whole on both sides, through `masterConnection.command`'s 15s timeout
   (`master-connection.ts:242`). Either cap the Office-side export far lower, chunk it, or declare
   export Master-only. **Needs a decision before the export endpoints ship.**
3. **Retention.** `docs/schema/05` promises export-then-prune for `activity_log`, but the
   `activity_log_no_delete` trigger means a pruner cannot simply `DELETE`. `document_exports` grows on
   disk with no policy. Neither is designed.
4. **`applied_mutations` atomicity** — pre-existing, untouched.
5. **`panel:revoked` still never emitted** — pre-existing, untouched.
6. **The activity `action` token catalogue.** `action` is free-form `TEXT` with no `CHECK`; the 13 real
   values (`created, updated, deleted, restored, deactivated, password_reset, password_changed,
   sign_in, sign_in_failed, stage_changed, dispatched, inbound, adjusted`) plus whatever the new
   modules mint must be enumerated in `ACTIVITY_TOKENS`. `master/tests/i18n-tokens.test.ts` (§4.5)
   is what keeps the list honest, but somebody must populate it.

---

## 9. Build order

1. **§2.5 socket `details`** — 15 lines, unblocks two modules.
2. **i18n foundation** (§4) — `AppError`'s signature is a dependency of everything else. Answer §4.4 first.
3. **Recycle Bin** — `20260305`. Delivers the first delete path the product has ever had for leads/orders/parties/products.
4. **Fields** — `20260306`.
5. **Logs** — `20260307`.
6. **Reports** — no migration of its own beyond indexes folded into `20260307`.
7. **PDF Designer** — `20260308`. Largest; worth re-confirming it is still wanted before starting.
8. **Permission grant** — `20260309`, last, granting every new key at once.
9. **Office Dashboard** — no migration; reuses the dashboard triple.

Add a **migration registry guard test** before step 3: with five files landing at once against a
hand-maintained array, a file written but not imported is a silent no-op and nothing turns red.

`npm run verify` is currently **333 tests across 21 files**. This batch adds roughly 12 files, of
which 7 are pure suites that cannot skip.

---

## 10. Open questions

1. **§4.4 — is `messageKey` required on `AppError`?** 126 throw sites. Recommended: yes.
2. **§2.3 — accept leaving `20260303`'s live `allPermissions()` import alone?** Recommended: yes, and record it.
3. **§8.2 — how should large CSV/PDF exports reach the Office?** Cap, chunk, or Master-only.
4. **§5.4 — confirm Fields editing is management+** rather than genuinely every user.
5. **PDF Designer** — confirm it is still wanted now that it is scoped, given it was deferred once.
6. **§8.1** — should Office snapshot module-filtering be pulled into this batch rather than left open?
