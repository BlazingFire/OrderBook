# Backend modules — specification set

> **2026-09-19 — the PDF Designer (Stage 6) has since been removed from the product.** Everything
> this set says about `document_templates`, `document_assets`, `document_exports`,
> `/api/documents/*`, the `document:*` socket commands, the `documents` permission module and the
> `document_template` Recycle Bin entity is historical: migration
> `20260322000000_drop_document_designer` dropped the tables and stripped the keys. The Reports
> PDF export (§3) is unaffected and still ships. Nothing below has been rewritten to reflect this.
>
> **2026-09-21 — pricing has since been removed from the product, and the product master trimmed.**
> Everything this set says about rates, amounts, totals, `field.*Rate.*` permissions, field-level
> masking and `totalValue` on reports is historical: migration `20260324000000_product_master_trim`
> dropped the columns and stripped the keys (`docs/ai-handoffs/product-master-trim.md`). The
> snapshot guard is now `office/tests/snapshot-for-user.test.ts` (key set and permissions only).

Status: **specification. Nothing in this set is built.** Reading it end to end should be enough to
authorise the work, and enough for somebody who was not in the room to implement it without asking
what was meant.

This set is the buildable form of `docs/BACKEND_MODULES.md`. That document is the canonical plan and
records the owner's decisions; these documents say, per module, exactly which files are created,
which are changed, what the SQL is, what the endpoints are, what is permission-gated, how the Office
Panel reaches it, and what is tested. Where a statement here and a statement there disagree,
`docs/BACKEND_MODULES.md` wins and this set has a defect.

Two related documents sit outside this set and are not superseded by it: `docs/UI_REDESIGN.md` is the
frontend plan these endpoints exist to serve, and `HANDOFF.md` is the project's running record of
settled decisions and traps.

---

## 1. What this set covers

Six modules the supplied UI design implies but the product does not have, plus the Office-side
Dashboard aggregate. Every one is permission-gated and reachable from **both** panels — this is an
owner decision (§3), not an implementation convenience.

| Module | What it does | Backend today | Migration | Permission keys |
|---|---|---|---|---|
| **i18n / `t()`** | Server returns a stable `messageKey` + named params; the panel renders the sentence. Catalogues are compiled TypeScript, not a table | The `labelToken` contract exists on every catalogue entry (`shared/src/domain/permissions.ts:86`); no catalogue, no `t()`, no locale picker | none | none |
| **Recycle Bin** | Cross-entity soft delete and restore. `RECYCLE_BIN_ENTITIES` **grows across stages**: six at Stage 2 (`lead`, `order`, `party`, `product`, `role`, `user`), plus `option_list_item` and `custom_field_definition` at Stage 3, plus `document_template` at Stage 6 — nine in the end. See `04-API-CONTRACT.md` for the union type and `11-BUILD-SEQUENCE.md` for the staging | Roles and users carry `deleted_at` and have restore services; leads/orders/parties/products have **no delete path at all** | `20260305000000_soft_delete_columns` | new `recycleBin.view`, `recycleBin.viewAll`; reuses `leads.delete`, `orders.delete`, `parties.delete`, `products.delete`, `roles.delete`, `users.manage` |
| **Fields** | Managed pipelines, stages, option lists (incl. colour hex) and custom-field definitions | Three ungated reads exist — `GET /api/pipelines`, `/api/option-lists`, `/api/custom-fields` (`master/src/http/routes/data.routes.ts:66,73,80`) — and no write surface | `20260306000000_field_values_and_stage_ordering` | new `fields.view` (no ceiling); `fields.manage` **lowered** `admin` → `management` |
| **Logs** | Read API over the hash-chained audit trail: keyset feed, facets, chain verification, CSV export | `master/src/repositories/activity-log.repository.ts` exists with write functions only (`recordActivity:51`); no HTTP route anywhere | `20260307000000_activity_log_actor_name` (also carries the report indexes) | new `logs.view`, `logs.export`, `logs.verifyChain` |
| **Reports** | Dispatches by month, lead outcomes, top parties, and their CSV exports | Nothing. `reports.view` / `reports.export` are in the frozen catalogue and enforce nothing anywhere | none of its own — indexes fold into `20260307000000` | reuses `reports.view`, `reports.export`; redaction on `field.saleRate.view` |
| **PDF Designer** | Stored document templates; server-side PDF rendering with Devanagari support; recorded exports | Nothing, deliberately (`docs/LEAD_GENERATION_FLOW.md` §11 defers it) | `20260308000000_document_templates_and_exports` | new `documents.view/create/edit`, `documents.delete` (management), `documents.render`; redaction on `field.saleRate.view` |
| **Office Dashboard** | The Office Panel's own aggregate figures, per-figure gated, carried in the snapshot | The Master's `DashboardSummary` / `dashboard.service` / `dashboard:changed` triple exists; the Office has no dashboard | none | no new keys — each figure is gated by the module `*.view` key that already governs its data |

One further migration is shared: `20260309000000_new_module_permission_grant`, **last**, granting
every new key above to `tier = 'admin'` only.

---

## 2. What this set deliberately excludes

**Scope is backend only.** No screen files, no `App.tsx` edits, no tab-table entries. The ten screens
(Master and Office × Logs, Reports, Recycle Bin, Fields, plus the two Documents screens and the Office
Dashboard) belong to the UI phase in `docs/UI_REDESIGN.md` §8, built on the `ui/` component package
against these endpoints once they are real. Adding a tab entry now would ship a tab pointing at
nothing.

The single exception is **typed API client wrappers** in `master/web/src/api.ts` and
`office/web/src/api.ts` — functions with no UI attached. They are how an endpoint gets exercised
before a screen exists. **Those two files are the only web files in this batch.**

**The web i18n files are deferred with the screens.** `{master,office}/web/src/i18n/*`,
`components/LocalePicker.tsx`, `components/Untranslated.tsx`, `main.tsx`, `styles.css`, `format.ts`,
`PermissionGrid.tsx` and `AccessScreen.tsx` all belong to the UI phase, not here. This is a
deferral of the *renderer*, not of i18n: **`shared/src/i18n/` is fully in scope** — the catalogues,
the key type, `t()` and the parameter interpolation — and it is fully testable through
`shared/tests/` without a single web file existing. A missing key, a catalogue that has drifted
between EN and HI, and a parameter the template never spends are all caught by a pure suite. What
the deferral postpones is a person choosing a language in a browser.

One consequence of that deferral is worth stating plainly, because it looks like a gap: the eslint
rule `no-untranslated-jsx-text` is **registered as `'off'` in this batch** and promoted in the UI
phase. `lint` is the first step of `verify`, and turning it on against ~4,000 unswept JSX lines would
make every gate in the batch red for a reason that has nothing to do with the batch.
`05-EXISTING-CODE-CHANGES.md` holds the detail.

**Already fixed; do not specify work to re-do it.** Five items that older notes list as outstanding
were verified by reading the code:

| Claim | Reality |
|---|---|
| The HTTP error envelope drops `details` | It carries them — `master/src/http/middleware/error-handler.ts:28-32` |
| A duplicate name returns 400 | It returns 409 `ConflictError` with `{field, value}` — `master/src/domain/access.ts:160-169` |
| `expectedVersion` is optional | It is mandatory; omitting it throws with `storedVersion` attached — `master/src/domain/access.ts:183-192` |
| Sign-in failures against an unknown username are not recorded | They are — `master/src/services/auth.service.ts:366` |
| No Recycle Bin exists | A roles/users-scoped one exists inside `AccessScreen.tsx`; the cross-entity Bin **subsumes** it |

**Known-open, and not closed by this batch.** Named here so they are not mistaken for oversights, and
so nobody specifies them as work:

- `applied_mutations` is still not atomic with the effect it records.
- `panel:revoked` is defined in the socket contract and still never emitted.
- The audit trail is atomic for roles, users and auth, and still best-effort at 14 call sites across
  six services (catalog 4, lead 3, order 2, panel 2, inventory 2, auth 1).
- The Office snapshot has no MODULE-level filtering. `forCurrentUser()`
  (`office/src/http/app.ts:395-407`) re-masks `field.saleRate.view` for whoever is signed in **now** —
  that half is fixed — but it does not filter rows by `leads.view` / `orders.view`. This batch must
  not widen that hole; closing it needs its own owner.
- Retention and pruning for `activity_log` and `document_exports`.
- Large CSV/PDF payloads over the Office Panel's 15-second socket ack
  (`office/src/realtime/master-connection.ts:238-244`).

---

## 3. The owner's decisions, and what each one costs

From `docs/BACKEND_MODULES.md` §0. These are settled; the consequence column is what the
specification had to absorb.

| Decision | Consequence for the backend |
|---|---|
| **All users, both panels** — not Master-admin-only | Every module needs a permission key, a Socket.IO command, and an Office forwarding route. It is also why `docs/UI_REDESIGN.md` §5's "master/web, admin-only" column is now wrong for these six rows |
| **Build the `t()` layer** | The server never renders a user-facing sentence; `AppError` gains `messageKey` + `params`, which makes it a dependency of every other module and puts i18n first in the build order |
| **Orders keeps its board and gains a table** | No backend change. The existing list endpoint already serves both shapes |
| **Master chrome permanently dark** | Frontend only |
| **Master presence rail shows aggregate panel/conflict health** | No new endpoint; the existing dashboard and conflict counts already carry it |
| **Phase 3 order confirmed** | The build order in §7 below, and its one prerequisite |

One correction the owner should read as part of the decision, because it changes an estimate rather
than a decision: the i18n layer was sized in `docs/UI_REDESIGN.md` §4.4 as a sweep of every string in
~4,000 lines of JSX, on the basis that the token contract did not exist. It does exist —
`shared/src/domain/permissions.ts` emits a `labelToken` on every catalogue entry with an explicit
comment that the renderer never hard-codes the English, and `activity_log` stores
`(entity_type, action, details JSONB)` rather than English sentences. What is missing is the
catalogue, `t()` and a locale picker. The genuinely large part is separate and is §8's first open
question.

---

## 4. How to read this set

**The set is organised by CONCERN, not one document per module.** There is no `03-RECYCLE-BIN.md`
and no `07-PDF-DESIGNER.md`; a module's schema is in `03`, its wire shapes are in `04`, its screens
are in `07`, and so on. If a document sends you to a per-module file, that reference is stale and
should be deleted rather than followed. Twelve documents, and this is all of them:

| Document | The question it answers | Sole authority for | Who needs it |
|---|---|---|---|
| `README.md` | What is in this batch, what it deliberately excludes, what the owner already decided, and what is still open | — | Everyone, and the owner |
| `01-ARCHITECTURE.md` | What do all six modules share — layering, pagination, cursors, migrations, permission policy, timezone, the socket ack, how the Office reaches a module — and why each was settled that way | — | Everyone, first |
| `02-FILE-STRUCTURE.md` | Which files are created and which are changed, per module, with counts | The **FILE manifest** and the scope boundary | Everyone before writing a file |
| `03-DATABASE.md` | What is the SQL — tables, columns, enums, CHECK constraints, indexes, and each migration's `up()` and `down()` | The **schema**, enums, CHECKs, indexes, migration DDL and `down()` policy | Whoever writes a migration; the reviewer of one |
| `04-API-CONTRACT.md` | What goes over the wire — endpoint paths, request and response shapes, TypeScript type definitions, socket event names | **Wire shapes**, TS types, socket event names, endpoint paths | Everyone touching a route, a socket command or `api.ts` |
| `05-EXISTING-CODE-CHANGES.md` | What has to change in code that already exists — `AppError`, `respond()`, `forward()`, the throw-site sweep, the layering repair | — | Whoever touches an existing file |
| `06-WORKFLOWS.md` | What happens step by step for each operation — delete, restore, render, export, verify — including the transaction boundaries | — | The implementer of each module |
| `07-UI-SPEC.md` | What the screens will need from these endpoints, so the backend does not have to be re-shaped later | — | The UI phase; read here only to check an endpoint serves its screen |
| `08-PERMISSIONS.md` | Every new key with its kind and tier, what each gates, and how the grant migration converges | **Permission keys**, tiers, the grant-migration algorithm | Everyone before gating anything |
| `09-I18N.md` | How a message gets from a `throw` on the Master to a Hindi sentence, and what `AppError` looks like afterwards | — | Whoever builds Stage 1; every stage after depends on the constructor signature |
| `10-TESTING.md` | Which suites exist, what each pins, which are pure and cannot skip, and what must be green before a stage is done | The **TEST register** (`02` cites it rather than keeping its own list) | Everyone; the owner, to know what "finished" means |
| `11-BUILD-SEQUENCE.md` | In what order the work lands, Stage 0 through Stage 8, and what gates each stage | **Stage ordering and numbering** | Everyone; the owner, to sequence the batch |

Read `01-ARCHITECTURE.md` first regardless of which module you are building. Everything else in the
set assumes its decisions and does not restate the reasoning.

**Where the authority column says a document is sole authority, the other eleven cite it rather than
restate it.** Duplication is what produced the contradictions this set was reconciled to remove: a
wire shape written out twice drifts the first time one copy is edited. A short summary plus a
pointer — "see `04-API-CONTRACT.md` §5.1" — is the correct form.

---

## 5. Locked cross-cutting decisions

Restated compactly so a reader of one module document can check an assumption without leaving it.
The reasoning is in `01-ARCHITECTURE.md`; where these are terse it is because the argument lives
there, not because it is thin.

| # | Decision |
|---|---|
| 1 | **One `CursorPage<T>`**, minted once in `shared/src/domain/inputs.ts`: `{ items: T[]; nextCursor: string \| null; prevCursor: string \| null; limit: number }`, plus `CursorQuery { cursor?: string; direction?: 'older' \| 'newer'; limit?: number }`. The offset-based `Paginated<T>` (`inputs.ts:268`) stays as a sibling. **No page numbers anywhere** |
| 2 | **One cursor codec**, `master/src/domain/cursor.ts` — pure, opaque base64url. Module-specific cursor payloads build on it; there are not three codecs |
| 3 | **Migration timestamps are allocated**: `20260305` Recycle Bin, `20260306` Fields, `20260307` Logs (plus report indexes), `20260308` PDF, `20260309` the shared permission grant, last. `Migration.down` is a required member (`master/src/db/migrations/index.ts:27`), so every file exports one even when it is deliberately empty with a justifying comment. `20260305`, `20260306` and `20260309` are deliberately empty — dropping `deleted_at` would resurrect every soft-deleted row — while `20260307` and `20260308` have a real `down()`. `03-DATABASE.md` is the sole authority for the per-migration `down()` policy |
| 4 | **One permission-grant migration**, granting every new key to `tier = 'admin'` **only**, union-not-replace, key strings inlined and frozen — never imported from `@orderbook/shared`. Non-admin roles receive keys through the permission grid, from an administrator who chooses them. This is the no-wildcard rule (`shared/src/domain/permissions.ts:224-231`) applied consistently |
| 5 | **One timezone key**: `config.locale.timeZone` from `ORDERBOOK_TIMEZONE`, default `'Asia/Kolkata'`, validated once at startup with `SELECT now() AT TIME ZONE $1` |
| 6 | **The socket ack must carry `details`** — a prerequisite, built first, ~15 lines across `shared/src/protocol/socket.ts` (the `{ok:false}` arm at `142-159`), `master/src/realtime/hub.ts` `respond()`, `office/src/realtime/master-connection.ts`, and `office/src/http/app.ts` `forward()` |
| 7 | **`fields.manage` lowered `admin` → `management`.** Fields *reading* is ungated (`fields.view`, no ceiling); Fields *editing* is management+. Lowering a ceiling never strips a stored key, so no repair migration is needed |
| 8 | **Soft-deleting a syncable entity stamps `hlc` and `field_hlc.deleted_at`**, not just `version`. No delete/restore `MutationKind`s: deletes are Master-online-only, and propagation to panels uses the existing `publishChange` / `ChangedEntity` path with a new `'restored'` `ChangeAction` (`shared/src/protocol/socket.ts:180`) |
| 9 | **`recordActivity` becomes `recordActivity(entry, actor, trx)`, and that change lands in Stage 1 (foundation)** — not at the Logs stage (`activity-log.repository.ts:51`). The `actor` argument is harmless before `activity_log.actor_name` exists: it is simply not persisted yet, and `20260307` adds the column and starts persisting it. Taking it early means Recycle Bin and Fields are written once against the final signature instead of being swept later. New modules **never** use `recordDetachedActivity` (`:76`) — the detached variant swallows failures into a warning and exists for recording a *failed* operation that has no transaction to belong to |
| 10 | **PDF rendering is server-side in the Master**, PDFKit + fontkit, vendored SIL OFL fonts. **Devanagari support is a hard requirement.** The rate-redaction key is `field.saleRate.view` — `products.rate.view` does not exist |
| 11 | **Redacted fields are ABSENT (`undefined`)** — never `null`, never `0`. A null says "this line has no rate", which is a different and wrong statement, and one a client will happily total to zero |
| 12 | **Date safety**: never `toISOString()` on a `DATE`-derived value. Month buckets are computed in SQL against the configured timezone and returned as `'YYYY-MM'` TEXT |
| 13 | **The Office path for all modules is forwarded live and FAILS HARD offline** with 503 `{error:'unavailable'}`. Nothing is queued into the outbox. i18n is the sole exception — it needs nothing from the Master |
| 14 | **The actor is resolved per command**, never captured per connection. Offline is decided from the transport flag, never by reading an error message |

---

## 6. Glossary

Project vocabulary an implementer must not get wrong. Several of these words mean something narrower
here than they do generally.

| Term | In OrderBook it means | Where it lives |
|---|---|---|
| **Party** | A customer or dealer the company sells to. Carries a `partyCode` unique per tenant among live rows. Not a "contact", and never a user | `shared/src/domain/entities.ts:189` |
| **Lead** | An enquiry moving through a configurable pipeline. On conversion it is **kept as history** — `convertedOrderId` is stamped and the lead is never mutated into the order | `entities.ts:356` |
| **Order** | A commitment, its own record with its own pipeline, created by converting a lead. Never created directly; there is no `orders.create` key | `entities.ts:395`, `shared/src/domain/permissions.ts:68` |
| **Line item** | One product on a lead **or** an order, discriminated by `(parentType, parentId)` — one table serves both, which is what makes conversion a copy rather than a translation. Product fields are snapshotted at add time; `rate` is absent when not permitted. Colour quantities are child rows | `entities.ts:299` |
| **Panel** | A machine, not a person. The **Master Panel** owns the database; an **Office Panel** is a paired thin client. A panel has its own role, used only when nobody is signed in on it | `entities.ts:111` |
| **Pairing** | The one-time handshake that turns an unknown PC into an `office_panels` row: UDP discovery (or a manual IP/ID/password), a Master-issued panel id and secret, `status` moving `pending` → `active`. A removed panel goes to `revoked`; the row is never deleted, because leads reference it | `docs/PROJECT_PLAN.md` §4, `docs/schema/01-identity-and-network.md` |
| **Fingerprint** | `credentialFingerprint` — an opaque marker derived from a stored password hash, changing when the password changes. A panel stores it beside the offline verifier it minted and revalidates on reconnect. It is a change marker, never a credential, and never the hash | `shared/src/protocol/socket.ts:110`, `master/src/repositories/panel-credential.repository.ts:42` |
| **Tier** | `office` / `management` / `admin` — a **ceiling** on a role, not a role. A key above the ceiling fails the whole save, and `effectivePermissions` filters only upward | `shared/src/domain/permissions.ts:26` |
| **Capability** | A fine-grained permission that is not a grid cell — `lead.convert`, `field.saleRate.view`, `fields.manage`. Grouped into `workflow` / `pricing` / `stock` / `admin` | `permissions.ts:78-113` |
| **Module action** | The `<module>.<action>` matrix half of the catalogue, derived from `MODULE_ACTIONS` rather than hand-listed, so the grid and the key list cannot drift. A pair absent from the map renders "not applicable", which is a different statement from "above your tier" | `permissions.ts:66-74` |
| **HLC** | Hybrid logical clock, `0001755870000000-00003-A3F9K2` — fixed-width, so lexicographic order is causal order. Answers "which of two disconnected edits happened first". `field_hlc` records it per field. Distinct from `version`, which answers "did somebody save while I had this form open"; neither replaces the other | `docs/schema/06-tenancy-permissions-and-sync.md` §5.2, `docs/ROLES_AND_USERS.md` §2 |
| **Tombstone** | A row with `deleted_at` set. It is still there, still holds its id and its unique code, and still merges — which is why partial unique indexes must exclude it and why a soft delete must advance the HLC (decision 8) | `20260303000000_roles_and_users.ts`; extended by `20260305000000` |
| **Outbox** | The Office Panel's queue of mutations made while offline, flushed on reconnect and made idempotent by `applied_mutations`. **Nothing in this batch is queued into it** (decision 13) | `office/src/sync/outbox.store.ts` |
| **Snapshot** | The fat payload the Master sends an Office Panel on connect and reconnect — the panel's offline working set, capped at `SNAPSHOT_LIMIT = 500` and excluding converted leads. That cap is why Dashboard figures are computed on the Master rather than counted from the snapshot | `shared/src/protocol/socket.ts:198`, `master/src/services/snapshot.service.ts:30` |

---

## 7. The verified baseline

Everything below was verified by reading the repository at the time this set was written. If any of
it reads stale, check the tree before trusting it.

**Packages.** An npm-workspaces TypeScript monorepo: `shared/` (types and the Socket.IO contract,
consumed as **compiled output**, not source), `master/` (owns PostgreSQL via Knex, serves
`master/web`), `office/` (no database, one Socket.IO link to the Master, serves `office/web`). The
product never touches the internet — no CDN, no cloud API, no web font over the network.

**Migrations.** Six, in a hand-maintained array at `master/src/db/migrations/index.ts:31-36` — a file
written but not imported is a silent no-op:

```
20260101000000_initial_schema
20260201000000_stock_movement_notes
20260301000000_tenancy_access_and_sync
20260302000000_lead_order_rebuild
20260303000000_roles_and_users
20260304000000_role_tier_ceiling_repair
```

**Tests.** `npm run verify` is green at **333 tests across 21 files** — 16 under `master/tests`, 3
under `office/tests`, 2 under `shared/tests`. What this batch adds is registered in `10-TESTING.md`
§8, which is the sole authority for the test register; the file counts in `02-FILE-STRUCTURE.md` cite
the same register rather than keeping a second list. What matters here is the property, not the
count: a large fraction of the new suites are **pure** and therefore cannot skip. Integration suites
use `describe.skipIf` and a
skipped suite reads exactly like a passing one in the summary line, which is how the Windows
PostgreSQL lookup stayed broken for months. Integration suites need PostgreSQL binaries — on the
owner's PC, `ORDERBOOK_PG_BIN="/c/Program Files/PostgreSQL/17/bin" npm run verify`.

**Build order.** Stages are numbered **0 through 8**, and `11-BUILD-SEQUENCE.md` is the sole
authority for that ordering and numbering — any "build step N" written against an older 1–9 scheme is
stale. The stages:

| Stage | What lands | Migration |
|---|---|---|
| **0** | Socket ack `details` (decision 6) — ~15 lines, unblocks two modules | none |
| **1** | Foundation: i18n, the shared primitives, and `recordActivity(entry, actor, trx)` (decision 9). `AppError`'s signature is a dependency of everything after it | none |
| **2** | Recycle Bin. Delivers the first delete path the product has ever had for leads, orders, parties and products | `20260305` |
| **3** | Fields | `20260306` |
| **4** | Logs | `20260307` |
| **5** | Reports — its indexes fold into `20260307` | none of its own |
| **6** | PDF Designer. Largest; worth re-confirming it is still wanted before starting | `20260308` |
| **7** | Permission grant, granting every new key at once | `20260309` |
| **8** | Office Dashboard | none |

A **migration registry guard test** lands before Stage 2: with five files arriving against a
hand-maintained array, an unimported file turns nothing red.

---

## 8. Open questions carried into implementation

This section and `11-BUILD-SEQUENCE.md` §2 carry the same list; anything that was buried in one
document's prose has been promoted here so the owner sees it without reading twelve files. Each has a
recommendation in `docs/BACKEND_MODULES.md` §10 and, where it changes a module's shape, in the
document named beside it.

### 8.1 Still open — the owner decides

| # | Question | Recommendation | Detail lives in |
|---|---|---|---|
| 1 | Is `messageKey` **required** on `AppError`? **129 throw sites across `master/src`, 0 in `office/src`** — stated as *129 (126 by grep; `conversion.ts` contains a NUL byte so grep classifies it binary and skips 4 sites — verify with `grep -a`)*. The number of **hand-written tokens is 68**, not 129: many sites share one | Required, with `message` derived from the EN catalogue so existing tests asserting English text stay byte-identical. This is the largest scoping item in the batch | `05-EXISTING-CODE-CHANGES.md`, whose per-class breakdown is the authority for both counts |
| 2 | Accept leaving `20260303000000_roles_and_users.ts:21`'s live `allPermissions()` import alone? The registry forbids both the import and editing an applied migration; both rules cannot hold | Leave it, and record the decision in `HANDOFF.md` so it is not rediscovered as a bug a third time | `01-ARCHITECTURE.md` §4.3 |
| 3 | How should large CSV and PDF exports reach the Office Panel through a 15-second ack? | Cap, chunk, or declare export Master-only. **Needs a decision before the export endpoints ship** | `11-BUILD-SEQUENCE.md` §7 risk 6 |
| 4 | **What does a mid-stream CSV failure look like?** The export endpoints stream; a failure after the first byte cannot become a JSON error envelope, and a truncated file that opens cleanly in Excel is the worst outcome available | Owner's call between a trailing sentinel row, an abort that leaves the transfer visibly incomplete, and buffering small exports whole | `04-API-CONTRACT.md` §O-4 |
| 5 | `QUIET_AFTER_DAYS = 30` is a designer's number, not the owner's. It decides which leads the outcome report calls "went quiet" | Needs the owner's number before Stage 5 ships; the rule itself is already a pure classifier so changing it is a one-line edit and a test | `02-FILE-STRUCTURE.md` (`master/src/domain/lead-outcome.ts`), `11-BUILD-SEQUENCE.md` Stage 5 |
| 6 | **The Devanagari font fallback.** The vendored face is registered and asserted present at startup; what should happen to a codepoint it has no glyph for is not settled — silent blank boxes are the default and the worst answer | Decide before Stage 6 renders anything customer-facing | `02-FILE-STRUCTURE.md` (`master/src/pdf/fonts.ts`, `master/tests/document-fonts.test.ts`) |
| 7 | Should `party_product_variants` be **soft-deletable**? They are listed as read-but-untouched, yet each carries a negotiated rate, so deleting one silently changes what a future line quotes | **Open.** Not closed by this batch; it wants its own owner because the consequence is a price, not a row | `03-DATABASE.md` §1 |
| 8 | Should the Logs feed also surface `timeline_entries`? They are a per-record narrative (`20260302:214-225`) and are not part of the hash chain, so including them means two sources with different guarantees behind one screen | Owner's call; excluded by default | `03-DATABASE.md` |
| 9 | Confirm Fields *editing* is management+ rather than genuinely every user | Management+ — letting any office user rename a pipeline stage reorders every board in the company | `08-PERMISSIONS.md` |
| 10 | Is the PDF Designer still wanted, now that it is scoped? It was deferred once on purpose | Owner's call; it is the largest single item here | `11-BUILD-SEQUENCE.md` Stage 6 |
| 11 | Should Office snapshot module-filtering be pulled into this batch rather than left open? | Left open, with a test added here asserting every `SyncSnapshot` key is accounted for in `forCurrentUser` — there is none today, so a newly added collection is a silent leak | `10-TESTING.md` §6.8 |

### 8.2 Decided during reconciliation — recorded so they are not re-opened

| Question | Ruling | Detail lives in |
|---|---|---|
| Do `option_lists` and `custom_field_definitions` need a `version` column? | **Yes.** Both gain `version INTEGER NOT NULL DEFAULT 1` in `20260306`, and `expectedVersion` is **mandatory** on `PUT /api/fields/values/:id` and `PUT /api/fields/definitions/:id`, refusing a stale save with 409 carrying `storedVersion` — matching `assertVersionMatches` (`master/src/domain/access.ts:183-192`). A concurrency gate joins the Fields tests | `03-DATABASE.md` (column), `04-API-CONTRACT.md` (wire), `10-TESTING.md` (gate) |
| Can a converted lead be deleted? | **No.** A lead holding a `converted_order_id` is an order's history; the DELETE refuses with `ConflictError` 409 and `{ blockedBy: BinBlocker[] }`. This is one row of a per-entity DELETE policy table covering `party`, `product`, `lead` and `order`, and it is distinct from `PARENT_LINKS`, which is the upward-only **restore** graph | `06-WORKFLOWS.md` (the policy table), `04-API-CONTRACT.md` (the envelope) |
| What date anchors the top-parties report? | **`orders.dispatched_at`.** The report is "dispatched value in the selected period" — goods that left, not business won | `03-DATABASE.md` §on report indexes, which also names the index that serves the grouping |
