# 04 — The API contract

Every HTTP endpoint and every Socket.IO event the six new backend modules add or change, plus the
Office-side Dashboard aggregate. This document is the wire contract: paths, permission keys, request
and response shapes, every error each endpoint can return, and paging behaviour. It fixes what the
two panels agree on, so a Master route and the Office command that forwards to it cannot drift.

It implements `docs/BACKEND_MODULES.md`. Where that plan settles something, this document restates
it in wire terms and does not re-decide it.

**This document is the sole authority for the wire contract**: endpoint paths, request and response
shapes, every TypeScript type in `shared/src/domain/` and `shared/src/protocol/` that this batch adds
or changes, and every Socket.IO event name. Where another document names a type, a path or an event,
this one is what it must agree with. Conversely, this document does not own the schema
(`03-DATABASE.md`), the file manifest (`02-FILE-STRUCTURE.md`), the permission catalogue
(`08-PERMISSIONS.md`), the test register (`10-TESTING.md`) or the stage order
(`11-BUILD-SEQUENCE.md`); it cites them.

**Scope: backend only.** No screen file, no `App.tsx` edit and no tab-table entry belongs to this
batch. The only frontend work here is typed client wrappers in `master/web/src/api.ts` and
`office/web/src/api.ts` — functions with no UI attached, which is how these endpoints get exercised
before the screens in `docs/UI_REDESIGN.md` §8 exist. Those two files are the **only** web files in
this batch; the web i18n layer is deferred to the UI phase (`02-FILE-STRUCTURE.md`, `09-I18N.md`).

---

## Contents

| § | Subject |
|---|---|
| 1 | Conventions — mounting, guards, envelope, paging |
| 2 | Logs — 4 endpoints |
| 3 | Reports — 4 endpoints |
| 4 | Recycle Bin — 3 endpoints + 4 DELETE routes |
| 5 | Fields — 17 endpoints (3 existing reads deliberately untouched) |
| 6 | PDF Designer — 13 endpoints |
| 7 | Dashboard — `GET /api/dashboard`, changed body |
| 8 | i18n — 3 changed endpoints |
| 9 | The Socket.IO surface |
| 10 | Office forwarding |
| 11 | Client wrappers |
| 12 | Open questions |

---

## 1. Conventions

Everything in §§2–8 assumes this section. It is short because the existing code already establishes
almost all of it; what follows is mostly a statement of which existing pattern each new file copies,
with the one place where copying the wrong one silently breaks.

### 1.1 Route mounting order — new routers mount ABOVE the bare `/api` line

`master/src/http/app.ts:36-41` mounts five routers in this order:

```ts
app.use('/api/setup', setupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/pairing', pairingRoutes);
app.use('/api/panels', panelRoutes);
app.use('/api/access', accessRoutes);
app.use('/api', dataRoutes);          // line 41 — no path constraint below /api
```

**Every new router is mounted above line 41**, in the `/api/access` block:

```ts
app.use('/api/logs', logRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/recycle-bin', recycleBinRoutes);
app.use('/api/fields', fieldsRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/access', accessRoutes);
app.use('/api', dataRoutes);
```

The reason, stated precisely, because the loose version of this claim is wrong and a specification
that overstates it teaches the wrong lesson:

`app.use('/api', dataRoutes)` puts **every** `/api/*` request into `dataRoutes`, and the first thing
that router runs is `dataRoutes.use(requireAuth)` (`master/src/http/routes/data.routes.ts:29`). A
request matching no route inside falls through with `next()`, so *today* a router mounted below line
41 would still be reached. Two things make mounting above the correct rule anyway:

1. **The unmatched request pays another router's `requireAuth` first.** An unauthenticated
   `GET /api/logs` mounted below line 41 is refused by `data.routes.ts`, not by `log.routes.ts` — so
   the new module's auth semantics are decided by a router it has nothing to do with, and changing
   them means editing a file it does not own.
2. **Fall-through is not guaranteed to survive.** `data.routes.ts` already carries eleven
   parameterised routes one segment down (`/leads/:id`, `/orders/:id`, `/products/by-code/:code`, …).
   The day anyone adds a top-level `/:something` or a catch-all to it, every module mounted below is
   silently shadowed and nothing turns red.

The SPA fallback at `master/src/http/app.ts:50` is `app.get(/^(?!\/api).*/, …)`, so it never
swallows an API path: an unmatched `/api/*` reaches `notFoundHandler`
(`master/src/http/middleware/error-handler.ts:8-10`) and answers
`404 { error: 'not_found', message: 'Endpoint not found' }`.

`attachSession` is app-level (`master/src/http/app.ts:25`), so `req.user`, `req.permissions` and
`req.sessionToken` are populated before any router runs, including for routers that do not require
authentication.

### 1.2 The two-layer permission check

Every new router copies `master/src/http/routes/access.routes.ts` — the only existing router that
mounts `requirePermissionMiddleware` — and **not** `data.routes.ts`, which gates on `requireAuth`
alone.

```ts
export const logRoutes: Router = Router();

logRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;   // access.routes.ts:36

logRoutes.get(
  '/',
  needs('logs.view'),
  asyncHandler(async (req, res) => {
    res.json(await logService.listLogs(parseQuery(req.query), actorFromRequest(req)));
  }),
);
```

Four rules follow from that shape, and all four are load-bearing:

| Rule | Why | Reference |
|---|---|---|
| `requireAuth` is mounted once per router with `.use()`, never per route | A route added later is behind it by construction | `access.routes.ts:25` |
| The route guard is the *second* gate, not the only one — the service checks the same key again | The socket path never runs Express middleware, so the service check is the only gate an Office command passes | `access.routes.ts:27-35`, `require-auth.ts:58-64` |
| The actor is resolved from the session, never from an argument | Identity is not something a caller gets to assert; the tenant comes from `req.user`, and there is deliberately no path by which a client names the tenant it writes to | `require-auth.ts:75-92` |
| Handlers are `asyncHandler`-wrapped | Express 4 does not forward a rejected promise to the error handler | `master/src/http/async-handler.ts:7-13` |

`requirePermissionMiddleware` compares against `req.permissions.permissions`
(`require-auth.ts:65-73`) and throws `ForbiddenError(permission)`, which carries the key in
`details` (`master/src/lib/errors.ts:49-53`).

**Do not add handlers to `access.routes.ts`.** `master/tests/credential-invariants.test.ts:73-89`
asserts `guards.length === handlers.length - 2` for that file specifically, with the two exemptions
named in the test's own comment. A new handler there without a `needs()` guard fails the suite; a new
*guarded* handler there also fails it, because the arithmetic is exact. New surface goes in new
routers.

Each new router should carry the same invariant as its own assertion — every handler in
`log.routes.ts`, `report.routes.ts`, `recycle-bin.routes.ts`, `fields.routes.ts` and
`document.routes.ts` has a `needs()` guard, with **no** exemptions in any of them.

### 1.3 The error envelope

Already correct; nothing in this batch re-does it. `master/src/http/middleware/error-handler.ts:28-32`
answers:

```jsonc
{
  "error":   "conflict",              // AppError.code — branch on this, never on the message
  "message": "A party already uses that code",
  "details": { "field": "partyCode", "value": "P-0042" }   // present only when the error carries it
}
```

Every error any endpoint in this document returns is one of these seven:

| Class | Status | `error` | `details` | Source |
|---|---|---|---|---|
| `ValidationError` | 400 | `validation_error` | whatever the thrower attached | `errors.ts:30-34` |
| `UnauthorizedError` | 401 | `unauthorized` | — | `errors.ts:36-40` |
| `ForbiddenError` | 403 | `forbidden` | `{ permission }` | `errors.ts:49-53` |
| `TenantViolationError` | 403 | `tenant_violation` | — | `errors.ts:62-66` |
| `NotFoundError` | 404 | `not_found` | — | `errors.ts:68-72` |
| `ConflictError` | 409 | `conflict` | whatever the thrower attached | `errors.ts:74-78` |
| *unhandled* | 500 | `internal_error` | — | `error-handler.ts:36-37` |

Per-endpoint error tables below name the class, the trigger and the `details` payload. They do not
repeat 401 (`UnauthorizedError` from `requireAuth`) or the route-level 403 (`ForbiddenError` from
`needs()`) — those apply to every endpoint in §§2–7 uniformly and are listed only where a *second*,
service-level permission is also checked.

An id belonging to another company answers **404, not 403**, on every read route in this batch. That
is a deliberate departure from `TenantViolationError`'s usual use: the alternative lets an endpoint be
used to probe which ids exist. `TenantViolationError` stays for the write paths that already throw it.

### 1.4 Paging: one cursor contract, no page numbers

Minted once, in `shared/src/domain/inputs.ts`, beside the existing offset-based `Paginated<T>`
(`inputs.ts:268-273`), which stays and is unchanged:

```ts
export interface CursorQuery {
  cursor?: string;
  direction?: 'older' | 'newer';
  limit?: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  /** null for a one-directional feed. */
  prevCursor: string | null;
  limit: number;
}
```

| Rule | Detail |
|---|---|
| No page numbers, no offsets, no totals | Anywhere. An offset pager over an append-mostly DESC feed shifts under every new row, and a `COUNT` over the Recycle Bin's multi-table `UNION ALL` — six branches at Stage 2, nine by Stage 6 (§4.1) — would be paid on every page |
| The cursor is opaque | Base64url, minted and read only by `master/src/domain/cursor.ts`. Module-specific payloads build on that one codec — there is not one per module |
| A malformed cursor is a 400 | `ValidationError`, `details: { field: 'cursor' }`. Never silently treated as "start from the beginning": that would page a user back to the top with no explanation |
| `limit` is clamped, never trusted | Per-endpoint default and maximum given below. Out-of-range is clamped, not refused |
| `nextCursor: null` means the end | Determined by fetching `limit + 1` rows and discarding the extra, so the button state costs no `COUNT` |
| `direction` defaults to `'older'` | Only `GET /api/logs` accepts `'newer'`; every other feed is one-directional and returns `prevCursor: null` |
| Bigint ids travel as **strings** | `node-postgres` returns `BIGINT` as a string and `Number()` loses precision. `activity_log.id`, `activity_log.sequence` and `document_exports.id` are `string` on the wire, end to end |

### 1.5 Redaction: absent, never null, never zero

A caller without `field.saleRate.view` receives responses with the money keys **deleted**, not
blanked. Every money field in the new shared types is therefore declared optional (`totalValue?:
number`), and `maskFields()` already deletes rather than nulls. A confident `₹0.00` on a quotation is
worse than no column, which is the whole reason for the rule.

Totals are computed server-side over the same filtered set. The client never sums masked buckets.
Where a report's *ordering* depends on a redacted column, the response says which ordering it
actually used (`orderedBy`), because a leaderboard sorted by a key the reader cannot see is a list
they cannot make sense of.

CSV exports write a redacted money cell as **empty**, never `0`.

### 1.6 Dates on the wire

| Kind | Wire form | Rule |
|---|---|---|
| Timestamps | `IsoTimestamp` (`2026-08-24T11:04:33.281Z`) | Unchanged from today |
| Calendar days | `'YYYY-MM-DD'` TEXT | Never a `Date`. `from`/`to` query params are inclusive calendar days in `config.locale.timeZone` |
| Month buckets | `'YYYY-MM'` TEXT | Computed in SQL against `config.locale.timeZone`, returned as text |

**No date-derived value in this batch ever becomes a JavaScript `Date`.** `HANDOFF.md` records the
defect this prevents: `DATE` columns came back a day early east of UTC because `toISOString()`
converts to UTC first. `master/src/domain/report-range.ts` takes `today` as `{year, month, day}`
components and never constructs a `Date`; the Recycle Bin cursor carries the SQL-rendered microsecond
text rather than a serialised `Date`, because a round-trip through JS truncates Postgres's
microseconds to milliseconds and makes a page boundary ambiguous.

`config.locale.timeZone` comes from `ORDERBOOK_TIMEZONE`, defaults to `'Asia/Kolkata'`, and is
validated once at startup with `SELECT now() AT TIME ZONE $1`. It is the only timezone key.

### 1.7 Request bodies

`master/src/http/app.ts:23` parses JSON with `limit: '2mb'`. The Office's own parser is
`limit: '1mb'` (`office/src/http/app.ts:37`). The tighter of the two governs anything forwarded, which
is why the document-asset upload caps at **512 KB raw** (~700 KB base64, comfortably under 1 MB) and
why that cap cannot be raised without raising the Office limit in the same change.

Routes parse and delegate. They do not validate business rules; those live in `master/src/domain/`
as pure `assertX` functions that the service calls inside the transaction.

### 1.8 Every audited write calls `recordActivity(entry, actor, trx)`

Three arguments, in that order, everywhere in this document — never the two-argument form, and
**never `recordDetachedActivity`**, which is forbidden in every module this batch adds.

The signature change lands in **Stage 1 (foundation)**, not at the Logs stage. The `actor` parameter
is harmless before `activity_log.actor_name` exists — it is simply not persisted yet — and
introducing it in Stage 1 means the Recycle Bin (Stage 2) and Fields (Stage 3) are written once
against the final signature instead of being swept later. The Logs migration `20260307` adds the
column and starts persisting the name derived from that argument (`03-DATABASE.md` §6.6).

`trx` is the caller's transaction, not a fresh one: an audit entry that commits when the write it
describes rolled back is a record of something that never happened.

---

## 2. Logs

Read-only. Renders the audit trail that `activity_log` has been accumulating since `20260303`, and
gives the chain a verification button. Mounted `app.use('/api/logs', logRoutes)`.

### 2.1 Shared types

```ts
// shared/src/domain/activity.ts (new file)

export type ActivityActorType = 'user' | 'office_panel' | 'system';

export interface ActivityActor {
  type: ActivityActorType;
  id: string | null;
  /** Denormalised at write time, so a deleted user's name still renders. */
  name: string | null;
}

export interface ActivityLogEntry {
  id: string;                 // BIGSERIAL as TEXT
  sequence: string | null;    // BIGINT as TEXT; null on pre-chain rows
  tenantId: Uuid;
  entityType: string;
  entityId: string;
  action: string;
  actor: ActivityActor;
  details: Record<string, unknown>;
  createdAt: IsoTimestamp;
  /**
   * This entry's own sha256, hex, as stored. `null` on a backfilled pre-chain
   * row (stored as the literal 'pre-chain'), which is what `chained: false`
   * says in words. Served under `logs.view` like every other field here.
   */
  hash: string | null;
  /** False for backfilled pre-chain rows: unverifiable, not broken. */
  chained: boolean;
}

export interface ActivityLogQuery extends CursorQuery {
  actorType?: ActivityActorType;
  actorId?: string;
  entityType?: string;
  action?: string;
  from?: string;              // 'YYYY-MM-DD', inclusive
  to?: string;                // 'YYYY-MM-DD', inclusive
  q?: string;                 // free text over entity_id and details::text
}

export interface ActivityLogFacets {
  actors: ActivityActor[];
  entityTypes: string[];
  actions: string[];
}

export type ChainBreakKind = 'hash_mismatch' | 'prev_hash_mismatch' | 'sequence_gap';

export interface ChainBreak {
  kind: ChainBreakKind;
  sequence: string;
  id: string;
  createdAt: IsoTimestamp;
}

export interface ChainVerification {
  ok: boolean;
  checkedCount: number;
  skippedPreChainCount: number;
  fromSequence: string | null;
  toSequence: string | null;
  firstBreak: ChainBreak | null;
  truncated: boolean;
}
```

`ActivityActor` is structured and never a rendered label. The wording is the client's — that is the
i18n contact point, and it is why an entry written today renders in Hindi tomorrow with no schema
change and no chain rewrite.

**`hash` is on the entry because the Logs screen has an Entry-hash column, and that column is the
only thing that makes "hash-chained" visible to a person.** Without it, the chain is a property the
documentation asserts and `POST /api/logs/verify` confirms in aggregate; with it, an operator can
read a single row's digest, hand it to somebody, and have it re-derived. It carries no permission of
its own — an actor holding `logs.view` can already see every input to the digest, so withholding the
output would protect nothing.

### 2.2 `GET /api/logs`

The Logs table. Newest-first, keyset-paginated, Newer/Older only.

| | |
|---|---|
| **Permission** | `logs.view` (route guard + service check) |
| **Service** | `logService.listLogs` |
| **Query** | `ActivityLogQuery` — `cursor`, `direction`, `limit`, `actorType`, `actorId`, `entityType`, `action`, `from`, `to`, `q` |
| **Response** | `200 CursorPage<ActivityLogEntry>` |
| **Limit** | default 50, clamped 1–200 |
| **Paging** | Keyset on `activity_log.id` (`BIGSERIAL`, monotonic, unique). Cursor payload `v1|<id>`, id kept as a string. `direction: 'older'` → `id < :cursor ORDER BY id DESC LIMIT n+1`; `'newer'` → `id > :cursor ORDER BY id ASC LIMIT n+1`, reversed **in the repository** so the caller always receives newest-first. Both cursors are returned, so the UI has Newer and Older and nothing else |

`sequence` is the weaker cursor — nullable at DDL level and not unique — and `created_at` is unsafe:
it ties under `now()` within a transaction and has no unique index. `id` is the only correct key.

The `from`/`to` filter is served by the new `(tenant_id, created_at DESC)` index added in
`20260307000000`; the existing `idx_activity_log_created` is not tenant-prefixed.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'cursor' }` | Cursor does not decode, or its version prefix is unknown |
| `ValidationError` | 400 | `{ field: 'from' \| 'to' }` | Not `YYYY-MM-DD`, or `from > to` |
| `ValidationError` | 400 | `{ field: 'direction' }` | Not `older` or `newer` |
| `ForbiddenError` | 403 | `{ permission: 'logs.view' }` | Key not held |

### 2.3 `GET /api/logs/facets`

Populates the filter dropdowns. `action` is free-form `TEXT` with no `CHECK` constraint, so the only
way to enumerate the values is from the data.

| | |
|---|---|
| **Permission** | `logs.view` |
| **Service** | `logService.listLogFacets` |
| **Query** | `from`, `to` (same parsing as §2.2) |
| **Response** | `200 ActivityLogFacets` |
| **Paging** | None. Bounded by the same lookback window as the list (default 90 days) so it stays an index range scan rather than a full-table `DISTINCT` as the table grows |
| **Errors** | As §2.2, minus the cursor row |

### 2.4 `POST /api/logs/verify`

Re-walks the chain and re-computes each `sha256` **in SQL**, comparing recomputed against stored, and
each row's `prev_hash` against its predecessor's `hash`.

| | |
|---|---|
| **Permission** | `logs.verifyChain` |
| **Service** | `logService.verifyLogChain` |
| **Body** | `{ fromSequence?: string; toSequence?: string; limit?: number }` |
| **Response** | `200 ChainVerification` |
| **Limit** | default: the newest 10,000 sequences. Hard cap 200,000 per call |
| **Paging** | Mandatory range limiting by `sequence`, same Older-block idiom as the list. `truncated: true` plus the `fromSequence` reached is what lets the UI offer "verify the previous block" |

POST rather than GET for two reasons: it is expensive, and it writes an audit entry
(`recordActivity(entry, actor, trx)`, `activity_log` / `verified`, in the same transaction).

**Verification runs in SQL, not in Node.** The digest covers `details::text` — Postgres's own JSONB
rendering — so Node cannot reproduce the bytes. `20260307000000` factors the inline digest expression
out of `activity_log_chain()` into a reusable `activity_log_row_hash(...)`.

The read transaction, its `SET LOCAL statement_timeout = '30s'` and the ordered walk all live inside
`activityLogRepo.verifyChain(tenantId, window, runner)`. The service function is
`logService.verifyLogChain`; it clamps the window — resolving an omitted `fromSequence` /
`toSequence` through `activityLogRepo.chainBounds(tenantId)`, which returns the tenant's lowest and
highest `sequence` and nothing else — and checks the permission. It never opens a Knex transaction
itself, which is the layering violation `dashboard.service.ts:51` currently commits and this batch
fixes there (§7).

**`chainBounds` and `streamForExport` are two different functions and neither substitutes for the
other.** `chainBounds` is a two-value aggregate that tells the verifier where the chain starts and
ends; `streamForExport` (§2.5) is a batched row reader. `02-FILE-STRUCTURE.md` lists both as separate
additions to `activity-log.repository.ts`.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'limit', max: 200000 }` | Requested block exceeds the hard cap |
| `ValidationError` | 400 | `{ field: 'fromSequence' }` | Not a decimal string, or `> toSequence` |
| `AppError` | 500 | — | Statement timeout inside the walk. Fails cleanly rather than pinning the single Master process |

A chain break is **not** an error. It is `200 { ok: false, firstBreak: … }` — the endpoint succeeded
in discovering it.

### 2.5 `GET /api/logs/export`

CSV of the current filtered range.

| | |
|---|---|
| **Permission** | `logs.export` |
| **Query** | Same filters as §2.2, **no cursor** |
| **Response** | `200 text/csv`, `Content-Disposition: attachment; filename="logs-<from>-<to>.csv"` |
| **Service** | `logService.exportLogs`, reading through `activityLogRepo.streamForExport` |
| **Paging** | Internal batching only — 5,000 rows per fetch, hard cap 250,000 rows, streamed. Never loaded whole into memory |
| **Audit** | `recordActivity(entry, actor, trx)`, `activity_log` / `exported`, details naming the filter and the row count |

A separate route with its own guard rather than a `format=csv` flag on the list route, so the key
gates a distinct code path instead of becoming a second permission on one handler.

Permission, filter parsing and the first batch query all complete before a single byte is written, so
the errors in §2.2 are still JSON envelopes. A failure *after* streaming begins cannot use the
envelope — headers are already sent. See **O-4**.

---

## 3. Reports

Read-only analytics. Mounted `app.use('/api/reports', reportRoutes)`.

`reports.view` and `reports.export` **already exist** in the catalogue with no `MINIMUM_TIER` entry,
so they already default to office tier and are already available to every user. This module is their
first enforcement site anywhere in the codebase — today they render as togglable grid cells that gate
nothing, which `HANDOFF.md`'s own rule calls worse than a missing key.

### 3.1 Shared types

```ts
// shared/src/domain/reports.ts (new file)

export type ReportPeriod = 'thisMonth' | 'last3Months' | 'last6Months' | 'last12Months' | 'custom';

export interface ReportRangeInput {
  period?: ReportPeriod;      // default 'last6Months'
  fromMonth?: string;         // 'YYYY-MM', required when period === 'custom'
  toMonth?: string;           // 'YYYY-MM', inclusive
}

/** Echoed back on every report, so a printed page states its own day boundary. */
export interface ReportRange {
  period: ReportPeriod;
  fromDate: string;           // 'YYYY-MM-DD'
  toDateExclusive: string;    // 'YYYY-MM-DD'
  months: string[];           // every bucket in order, e.g. ['2026-03', '2026-04']
  timeZone: string;           // config.locale.timeZone
}

export interface ReportTotals { orderCount: number; boxCount: number; totalValue?: number }

export interface DispatchMonthBucket  { month: string; orderCount: number; boxCount: number; totalValue?: number }
export interface DispatchColourBucket { colour: string; boxCount: number; totalValue?: number }
export interface DispatchesReport {
  range: ReportRange;
  months: DispatchMonthBucket[];      // zero-filled: every month in range is present
  colours: DispatchColourBucket[];
  totals: ReportTotals;
  ratesIncluded: boolean;
}

export type LeadOutcome = 'converted' | 'lost' | 'quiet' | 'open';
export interface LeadOutcomeMonthBucket {
  month: string; converted: number; lost: number; quiet: number; open: number;
}
export interface LeadOutcomesReport {
  range: ReportRange;
  months: LeadOutcomeMonthBucket[];
  totals: Record<LeadOutcome, number>;
  /** The "went quiet" threshold actually applied, so the chart can label itself. */
  quietAfterDays: number;
}

export interface TopPartyRow {
  partyId: RecordId; partyName: string; partyCode: string | null;
  city: string | null; orderCount: number; totalValue?: number;
}
export interface TopCityRow {
  city: string | null; partyCount: number; orderCount: number; totalValue?: number;
}
export interface TopPartiesReport {
  range: ReportRange;
  parties: TopPartyRow[];
  cities: TopCityRow[];
  orderedBy: 'value' | 'orderCount';
  limit: number;
  ratesIncluded: boolean;
}
```

Every money field is optional so redaction can delete it (§1.5).

### 3.2 The range contract, shared by all four endpoints

| | |
|---|---|
| **Query** | `period`, `fromMonth`, `toMonth` |
| **Maximum span** | 12 months (`MAX_RANGE_MONTHS`) |
| **Computation** | `master/src/domain/report-range.ts`, pure, takes `today` as `{year, month, day}` components and never constructs a `Date`. Pinned by `master/tests/report-range.test.ts` — a pure suite that cannot silently skip |

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'period', allowed: [...] }` | Unknown period |
| `ValidationError` | 400 | `{ field: 'fromMonth' }` | Not `YYYY-MM`, or absent when `period === 'custom'` |
| `ValidationError` | 400 | `{ field: 'toMonth', maxMonths: 12 }` | Span exceeds `MAX_RANGE_MONTHS`, or `toMonth < fromMonth` |

### 3.3 `GET /api/reports/dispatches`

Dispatches by month and by colour.

| | |
|---|---|
| **Permission** | `reports.view` |
| **Response** | `200 DispatchesReport` |
| **Paging** | None. Bounded by the range and by the new partial index on `(tenant_id, dispatched_at)` |

Months come from `orders.dispatched_at` — one order in one bucket. Boxes and colours come from
`stock_movements` joined on `(reference_type = 'order' AND reference_id = o.id AND movement_type =
'outbound')`. **Boxes are `SUM(-m.quantity_boxes)`**: `quantity_boxes` is a signed negative delta for
a dispatch, so printing `SUM()` raw shows "-420 boxes dispatched".

`totalValue` is `SUM(o.total_amount)`, absent when the caller lacks `field.saleRate.view`;
`ratesIncluded` then reads `false`.

### 3.4 `GET /api/reports/lead-outcomes`

| | |
|---|---|
| **Permission** | `reports.view` |
| **Response** | `200 LeadOutcomesReport` |
| **Paging** | None. Bounded by the range |

Bucketed by month of **creation** (`leads.created_at`), served by the existing
`idx_leads_created (tenant_id, created_at)` — no new index needed.

Classification lives in `master/src/domain/lead-outcome.ts` as a pure classifier and obeys two rules
that are easy to get wrong: it **never keys on a stage name** (stages are tenant-configurable rows,
renamed from the Fields screen), and it **never treats the "Won" stage as converted**. The
`20260302` migration deliberately produced leads that are in Won *and* converted; conversion is a
separate act that stamps `converted_order_id`.

`quietAfterDays` is echoed on the response so the chart can label its own threshold. The constant
behind it, `QUIET_AFTER_DAYS = 30`, is a **placeholder awaiting the owner's number** — how long a
lead goes untouched before the business calls it quiet is a fact about how this company sells, not a
value a specification gets to invent. Echoing it rather than hard-coding it in the renderer is what
makes changing it a one-line edit. Promoted to `README.md` §8 and `11-BUILD-SEQUENCE.md` §2.

### 3.5 `GET /api/reports/top-parties`

| | |
|---|---|
| **Permission** | `reports.view` |
| **Query** | Range params plus `limit` |
| **Response** | `200 TopPartiesReport` |
| **Limit** | default 10, clamped 5–50 |
| **Paging** | None, ever. "Top parties" is a leaderboard, not a browsable list |
| **Date anchor** | `orders.dispatched_at`, not `orders.created_at` |

**The anchor is `orders.dispatched_at`, and the choice is the report's meaning.** This report answers
"dispatched value in the selected period" — goods that left the building — not "business won in the
selected period". Anchoring on `created_at` would credit a party in March for an order that shipped in
June, and would double-count against the dispatches report (§3.3), which is anchored the same way. An
order with `dispatched_at IS NULL` is not in this report at all; it is not yet value that left.

The predicate is therefore `tenant_id = ? AND dispatched_at >= ? AND dispatched_at < ? AND deleted_at
IS NULL`, grouped by `party_id`. **`idx_orders_party` does not serve it** — that index is
`(tenant_id, party_id)` (`20260302:572`), whose second column is the grouping key, not the filtered
one. The index that serves it is `idx_orders_dispatched (tenant_id, dispatched_at) WHERE dispatched_at
IS NOT NULL AND deleted_at IS NULL`, added by `20260307` for §3.3 and reused here: a range scan
bounded by the period, then aggregation over the rows it returns. No new index
(`03-DATABASE.md` §8.2).

City rows group on `lower(btrim(city))` with `MIN(btrim(city))` as the display label. `NULL` and
blank collapse into one bucket returned as `city: null`, which the client labels from an i18n key —
the server does not invent the string "Unknown".

`orderedBy` is `'value'` for a caller holding `field.saleRate.view` and `'orderCount'` otherwise.
Ordering by a key that is absent from the payload would hand the reader a list they cannot make
sense of, so the response states which ordering it used.

### 3.6 `GET /api/reports/:report/export`

| | |
|---|---|
| **Permission** | `reports.export` |
| **Path param** | `:report` ∈ `dispatches` \| `lead-outcomes` \| `top-parties`, validated against a literal list |
| **Query** | The same range params as the report it exports |
| **Response** | `200 text/csv`, `Content-Disposition: attachment` |
| **Paging** | None — already bounded by the range |
| **Audit** | `recordActivity(entry, actor, trx)`, `report` / `exported` |

A redacted money column is written as an **empty cell**, never `0`.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'report', allowed: ['dispatches','lead-outcomes','top-parties'] }` | Unknown report name |
| *range errors* | 400 | as §3.2 | |

---

## 4. Recycle Bin

The cross-entity soft-delete and restore surface, plus the four DELETE routes that give leads,
orders, parties and products their first delete path. Mounted
`app.use('/api/recycle-bin', recycleBinRoutes)`; the four DELETEs live in `data.routes.ts` (§4.5).

### 4.1 Shared types

```ts
// shared/src/domain/recycle-bin.ts (new file)

export const RECYCLE_BIN_ENTITIES = [
  // Stage 2 — Recycle Bin ships with these six.
  'lead', 'order', 'party', 'product',
  'role', 'user',
  // Stage 3 — Fields appends these two.
  'option_list_item', 'custom_field_definition',
  // Stage 6 — PDF Designer appends this one.
  'document_template',
] as const;
export type RecycleBinEntityType = (typeof RECYCLE_BIN_ENTITIES)[number];
export function isRecycleBinEntityType(value: unknown): value is RecycleBinEntityType;

/** Restore reuses the entity's own delete key — no restore key is minted. */
export const RESTORE_PERMISSION: Record<RecycleBinEntityType, string> = {
  lead: 'leads.delete',
  order: 'orders.delete',
  party: 'parties.delete',
  product: 'products.delete',
  role: 'roles.delete',
  user: 'users.manage',
  option_list_item: 'fields.manage',
  custom_field_definition: 'fields.manage',
  document_template: 'documents.delete',
};

export interface BinEntry {
  entityType: RecycleBinEntityType;
  id: RecordId;
  label: string;
  sublabel: string | null;
  deletedAt: IsoTimestamp;
  /** A US… user id, or null for an unattended panel's deletion. */
  deletedBy: RecordId | null;
  deletedByName: string | null;
  /** null for the entity types that carry no version column. */
  version: number | null;
  cursor: string;
}

/**
 * One record standing in the way. Used by BOTH 409 paths, which are different
 * questions in opposite directions: `parent_deleted` is a still-deleted ancestor
 * blocking a RESTORE (§4.4, PARENT_LINKS); the rest are live records blocking a
 * DELETE (§4.5's policy table).
 */
export interface BinBlocker {
  /** Not every blocker is a Bin entity: a line item and a stock row block a delete
   *  without ever being restorable themselves. */
  entityType: RecycleBinEntityType | 'line_item' | 'inventory_stock';
  id: RecordId;
  label: string;
  reason:
    | 'parent_deleted'      // restore: the ancestor is still in the Bin
    | 'live_reference'      // delete: a live lead / order / line item points at it
    | 'stock_on_hand'       // delete: inventory_stock has non-zero on-hand or reserved
    | 'converted'           // delete: the lead has a converted_order_id
    | 'dispatched';         // delete: the order has left
}

export interface BinRestoreResult {
  entityType: RecycleBinEntityType;
  id: RecordId;
  renamedTo?: string;
  alsoRestored: BinEntry[];
}

/** Absent key, not zero, for a branch the caller may not see. */
export type BinCounts = Partial<Record<RecycleBinEntityType, number>>;
```

**The list grows across stages rather than shipping frozen at nine.** Each addition is a normal
`shared` rebuild — one tuple entry, one `RESTORE_PERMISSION` entry and one `UNION ALL` arm, and no
route change ever:

| Stage | Members after it | Added |
|---|---|---|
| 2 — Recycle Bin | 6 | `lead`, `order`, `party`, `product`, `role`, `user` |
| 3 — Fields | 8 | `option_list_item`, `custom_field_definition` |
| 6 — PDF Designer | 9 | `document_template` |

Two consequences worth stating rather than discovering. The entity literal is
**`custom_field_definition`**, not `custom_field` — the latter is the `ChangedEntity` member
(`socket.ts:174`), a different constant with a different job, and confusing the two produces a Bin
branch that restores nothing. And **a gate that asserts the `UNION ALL` has N branches belongs to the
stage at which N branches exist**: an eight-table assertion written at Stage 2, or a nine-table one
written at Stage 3, fails against a correct build. The Bin's partial indexes follow the same staging
— six tables in `20260305`, two in `20260306`, one in `20260308` (`03-DATABASE.md` §6.1).

`POST /api/documents/templates/:id/restore` (§6.2) exists from Stage 6 **regardless** of the Bin: it
is the template screen's own undo, gated by `documents.delete`, and it would exist even if templates
were never listed in the Bin at all. The Bin branch and that route are two callers of the same
service function, not one feature.

Pipeline stages are **archived**, not soft-deleted, and are deliberately not a Bin branch (§5.5).
`document_exports` is deliberately not one either, though it carries the columns
(`03-DATABASE.md` §12.2).

### 4.2 Visibility, in three layers

Applied in this order, and the order matters:

1. `requirePermission(actor, 'recycleBin.view')` — the module gate.
2. The result is filtered to the entity types whose **delete key** the actor holds. Somebody with
   `parties.delete` but not `roles.delete` sees deleted parties and no deleted roles.
3. Narrowed to `deleted_by = actor.userId` unless the actor also holds `recycleBin.viewAll`
   (management+).

One consequence worth stating rather than discovering: a deletion made by an **unattended** Office
Panel has `deleted_by = NULL` and is therefore visible only to `recycleBin.viewAll` holders.

The role and user branches are reachable from an Office Panel, and that is not a contradiction of
`DIRECTORY_ENTITIES` (`master/src/realtime/hub.ts:114`). That set governs what is **broadcast
unsolicited**; a panel may still *ask*, and the service checks `roles.delete` / `users.manage` when
it does — the comment at `hub.ts:112-114` says exactly this.

### 4.3 `GET /api/recycle-bin`

| | |
|---|---|
| **Permission** | Route `needs('recycleBin.view')`; service applies all three layers of §4.2 |
| **Service** | `recycleBinService.listBin` |
| **Query** | `types` (repeatable), `search`, `deletedBy`, `cursor`, `limit` |
| **Response** | `200 CursorPage<BinEntry>` — `prevCursor` is always `null` |
| **Limit** | default 50, clamped 1–200 |
| **Paging** | Keyset on the composite `(deletedAt, entityType, id)`, sorted `deletedAt DESC, entityType DESC, id DESC` |

The three-part key is not belt-and-braces. `deleted_at` is transaction time, so a batch delete stamps
many rows identically; a two-part key would drop or repeat rows at a page boundary. The cursor's
timestamp half is the SQL-rendered microsecond text
(`to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) compared as
`?::timestamptz`, never re-formatted through a JS `Date` — which would truncate microseconds to
milliseconds and make the boundary ambiguous.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'types', allowed: RECYCLE_BIN_ENTITIES }` | Unknown entity type in `types` |
| `ValidationError` | 400 | `{ field: 'cursor' }` | Cursor does not decode |
| `ForbiddenError` | 403 | `{ permission: 'recycleBin.view' }` | Key not held |

### 4.4 `GET /api/recycle-bin/counts` · `POST /api/recycle-bin/restore`

**`GET /api/recycle-bin/counts`**

| | |
|---|---|
| **Permission** | `needs('recycleBin.view')`, same three-layer scope |
| **Service** | `recycleBinService.binCounts` |
| **Response** | `200 BinCounts` |
| **Paging** | None — a fixed-size object keyed by entity type |

Counted only over the branches the caller may see, so the chip totals and the list agree. A branch the
caller cannot see is an **absent key**, not `0` — the same rule as §1.5.

**`POST /api/recycle-bin/restore`**

| | |
|---|---|
| **Permission** | Route `needs('recycleBin.view')`. The meaningful check is in the service: `requirePermission(actor, RESTORE_PERMISSION[entityType])` |
| **Service** | `recycleBinService.restoreEntity` |
| **Body** | `{ entityType: RecycleBinEntityType; id: RecordId; renameTo?: string; cascadeParents?: boolean; expectedVersion?: number }` |
| **Response** | `200 BinRestoreResult` |

Restore is gated by the entity's own **delete** key, so it can never be a back door onto an entity you
may not delete. No `recycleBin.restore` key is minted, matching the `restoreRole` / `restoreUser`
precedent. There is no purge anywhere in the product.

`expectedVersion` is deliberately **optional here**, and this is the one place in the batch where it
is. `assertVersionMatches` (`master/src/domain/access.ts:183-192`) makes it mandatory on an edit
because a stale edit overwrites somebody's work; a restore writes no field values, so there is no
work to overwrite.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'entityType', allowed: [...] }` | Not a Bin entity type |
| `ForbiddenError` | 403 | `{ permission: RESTORE_PERMISSION[entityType] }` | Entity's delete key not held |
| `NotFoundError` | 404 | — | No such id, or another tenant's, or not deleted |
| `ConflictError` | 409 | `{ field: 'name' \| 'partyCode' \| 'productCode', value, suggestion }` | A live record has taken the name/code since. `suggestion` is `suggestRestoredName`'s answer; the caller re-submits with `renameTo` |
| `ConflictError` | 409 | `{ blockedBy: BinBlocker[] }` | A parent is still deleted. The caller re-submits with `cascadeParents: true`, or restores the parents first |

Both 409s carry structured `details`, and both must reach an Office Panel browser intact. That is
precisely why the socket ack fix (§9.1) is a prerequisite for this module rather than a nicety.

`PARENT_LINKS` in `master/src/domain/recycle-bin.ts` is the upward-only restore graph. Upward only:
restoring a party does not resurrect every lead ever raised against it.

### 4.5 The four DELETE routes

`DELETE /api/leads/:id` · `DELETE /api/orders/:id` · `DELETE /api/parties/:id` ·
`DELETE /api/products/:id`

**These live in `master/src/http/routes/data.routes.ts`**, beside their existing siblings, not in
`recycle-bin.routes.ts`. The prefix `/api/leads` already belongs to that router; splitting one
entity's routes across two files is how a future path collision gets missed. This makes
`data.routes.ts` the first router outside `access.routes.ts` to import
`requirePermissionMiddleware` — it currently gates on `requireAuth` alone (`data.routes.ts:29`).

| Route | Route guard | Service check | Extra behaviour |
|---|---|---|---|
| `DELETE /api/leads/:id` | `needs('leads.delete')` | `requirePermission(actor, 'leads.delete')` as the first statement | Cascades the soft delete to the lead's line items |
| `DELETE /api/orders/:id` | `needs('orders.delete')` | same | Releases the order's active stock reservations in the same transaction via `releaseForOrder` (`reservation.repository.ts:111`, currently dead code with no caller), then publishes the affected stock levels **after** commit |
| `DELETE /api/parties/:id` | `needs('parties.delete')` | same | — |
| `DELETE /api/products/:id` | `needs('products.delete')` | same | — |

#### When each route refuses with 409 — the per-entity policy

Each of the four has its own rule, and there is no shared "has children" test. Checked inside the
transaction, before anything is written:

| Entity | Refuses when | Otherwise |
|---|---|---|
| `party` | any **live** (not soft-deleted) lead or order references it | soft-deletes |
| `product` | any live `line_items` row references it, **or** any `inventory_stock` row for it has non-zero on-hand or reserved | soft-deletes |
| `lead` | it has a `converted_order_id` — it is an order's history, not a record of its own any more | soft-deletes, cascading to its line items |
| `order` | it has been dispatched | soft-deletes, releasing active reservations in the same transaction |

Refusal is `ConflictError` 409 carrying `{ blockedBy: BinBlocker[] }`, naming the actual blocking
records rather than stating a count — "3 open orders" is a message a person cannot act on, and the
names are what let them go and deal with them.

Each rule earns its place separately. A party is refused because deleting one would leave live
records pointing at a tombstone. A product is refused on stock as well as on lines because on-hand
boxes are physical goods; a catalogue entry can be wrong, but the pallet in the warehouse is not.
A converted lead is refused because the order that came out of it keeps a link back — deleting the
lead would make the order's own history unreadable, and "delete the order instead" is the honest
answer. A dispatched order is refused because goods left the building and the ledger says so; the
dispatch note may be in a customer's hands.

> **This is the DELETE-side rule and it is not `PARENT_LINKS`.** `PARENT_LINKS`
> (`master/src/domain/recycle-bin.ts`) is the **upward-only restore graph** — which still-deleted
> ancestors block putting a row back, answered by the 409 in §4.4. This table is about which **live**
> descendants block taking a row out. Different direction, different question, different payload,
> and they must not be implemented as one function because a single graph cannot answer both.

All four are the **first enforcement site** these keys have ever had. They have been in the frozen
catalogue and in stored role rows since `20260303`, render as grid cells, and are checked nowhere,
because no delete path exists for any of the four.

| | |
|---|---|
| **Body** | none |
| **Response** | `200 { id, deletedAt }` |
| **Audit** | `recordActivity(entry, actor, trx)` in the same transaction — never `recordDetachedActivity` |
| **Publishes** | `data:changed` with `{ entity: '<entity>', action: 'deleted', id, payload: <the soft-deleted row> }` |

**Every one of these four stamps `hlc` and `field_hlc.deleted_at`,** not just `version`. All four
entities carry `version` / `hlc` / `field_hlc`, unlike roles and users. Mirroring `softDeleteRole`
would bump `version` without advancing `hlc`, leaving a state the merge engine cannot interpret — and
a queued offline edit with a later `hlc` would then win on every field and quietly write to a
tombstone.

No delete or restore `MutationKind` is added. Deletes are Master-online-only, matching the
roles/users precedent; propagation to panels uses the existing `publishChange` / `ChangedEntity` path
with the new `'restored'` `ChangeAction` (§9.4).

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ForbiddenError` | 403 | `{ permission: '<entity>.delete' }` | Key not held |
| `NotFoundError` | 404 | — | No such id, another tenant's, or already deleted |
| `ConflictError` | 409 | `{ blockedBy: BinBlocker[] }` | Refused by the per-entity policy table above |

---

## 5. Fields

Management of option-list values, custom-field definitions and pipeline stages. Mounted
`app.use('/api/fields', fieldsRoutes)`.

**Reading is ungated by tier; editing is management+.** `fields.view` is a new capability with no
`MINIMUM_TIER` entry, so every user can hold it. `fields.manage` is lowered `admin` → `management`.
Stated plainly because the original argument for lowering it did not reach its own goal: an
unattended Office Panel falls back to an office-tier role, so at `management` an unattended panel
still cannot edit. That is the right answer anyway — letting any office user rename a pipeline stage
would reorder every board in the company. Lowering a ceiling never strips a stored key, so no
tier-repair migration is needed.

### 5.1 Shared types

```ts
// shared/src/domain/fields.ts (new file)

export const FIELD_LIST_KEYS = [
  'lead.sourcePlatform',
  'stock.colour',
  'product.productType',
  'line.packaging',
] as const;
export type FieldListKey = (typeof FIELD_LIST_KEYS)[number];
export function isFieldListKey(value: unknown): value is FieldListKey;

export interface FieldSetDefinition {
  listKey: FieldListKey;
  labelToken: string;        // 'fieldSet.stock.colour' — the renderer never hard-codes the English
  /** True for 'stock.colour' ONLY. The other three have no colour to render. */
  hasHex: boolean;
  /** Tables that reference this set, as tokens the client labels. */
  usedBy: string[];
}

export interface FieldCatalogue {
  sets: FieldSetDefinition[];
  customFieldEntities: CustomFieldEntity[];   // 'lead' | 'order' | 'party' | 'product'
}

export function buildFieldCatalogue(): FieldCatalogue;   // modelled on buildPermissionCatalogue()

export interface FieldUsage { value: string; total: number; bySource: Record<string, number> }
export interface FieldUsageBreakdown {
  listKey: FieldListKey;
  sources: string[];
  values: FieldUsage[];
  /** Values seen in the data with no option_lists row yet. */
  unlisted: FieldUsage[];
}
```

**Four keys, and only one of them carries a hex.** Only `lead.sourcePlatform` exists today
(`20260301000000_tenancy_access_and_sync.ts:319`, six seeded rows); `20260306000000` seeds the other
three from the distinct strings already present in the data — `stock.colour` from the five colour
columns, `product.productType` from `products` / `line_items` / `party_product_variants`, and
`line.packaging` from `line_items` / `party_product_variants` (`03-DATABASE.md` §6.3.1). After that
migration all four exist on every installation.

`hasHex` is `true` for `stock.colour` and `false` for the other three: a source platform, a product
type and a packaging kind have no colour to render, so their rows leave `hex` `NULL` permanently and
the screen offers no swatch. The screen renders from this served descriptor rather than from a list
typed into the renderer, so minting a fifth set later is a shared-constant edit plus a seeding
migration and **no route change**.

Modified existing types: `OptionListItem` gains `hex`, `deletedAt`, `createdAt`, `updatedAt` and
`version`; `CustomFieldDefinition` gains `deletedAt` and `version`; `PipelineStage` gains
`isArchived`. The two `version` fields are `number` (never optional) and back the mandatory
`expectedVersion` in §5.3 and §5.4.

### 5.2 Read endpoints

| Method | Path | Permission | Query | Response |
|---|---|---|---|---|
| GET | `/api/fields/catalogue` | `fields.view` | — | `200 FieldCatalogue` |
| GET | `/api/fields/values` | `fields.view` | `listKey` (required), `includeDeleted`, `includeUnlisted` | `200 { items: OptionListItem[]; unlisted?: string[] }` |
| GET | `/api/fields/usage` | `fields.view` | `listKey` (required) | `200 FieldUsageBreakdown` |
| GET | `/api/fields/definitions` | `fields.view` | `entity`, `includeDeleted` | `200 CustomFieldDefinition[]` |
| GET | `/api/fields/stages` | `fields.view` | — | `200 Pipeline[]` with **all** stages including archived, each carrying its colour hex |

None of these page. A value set is tens of rows, not thousands, and ordering by `sequence` is the
whole point. If a set ever grows past a few hundred, `/api/fields/values` becomes
`CursorPage<OptionListItem>` over `(sequence, id)` — the contract in §1.4 is already the one it would
adopt.

`includeUnlisted` returns the values seen in the data that have no `option_lists` row yet, each
offerable with a one-click add. That is what makes the list self-healing without ever blocking a
write.

**`/api/fields/usage` is a separate endpoint from `/api/fields/values` on purpose.** It is called when
a set is opened, not folded into the list, so the cheap read the screens and panels do constantly is
not dragged down by grouped scans.

**The usage count deliberately excludes `stock_movements`.** The count groups over
`line_item_quantities` (joined to `line_items` for the tenant filter — `line_item_quantities` has no
`tenant_id` of its own), `inventory_stock` and `stock_reservations`. No index leads with `colour` on
any of them; `idx_inventory_product_colour` is `(tenant_id, product_id, colour)`, the wrong leading
column for a colour-only probe. `stock_movements` is the append-only ledger, projected into the
millions by `docs/schema/05` — including it would seq-scan the ledger every time somebody opened
Fields → Colours. Three sources answer "is this colour in use" adequately.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'listKey', allowed: FIELD_LIST_KEYS }` | Missing or unknown `listKey` |
| `ValidationError` | 400 | `{ field: 'entity', allowed: ['lead','order','party','product'] }` | Unknown entity |
| `ForbiddenError` | 403 | `{ permission: 'fields.view' }` | Key not held |

### 5.3 Option-list values

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/api/fields/values` | `fields.manage` | `OptionListItemInput` = `{ listKey, value, label, hex?, sequence? }` | `201 OptionListItem` |
| PUT | `/api/fields/values/:id` | `fields.manage` | `{ label?, hex?, isActive?, expectedVersion: number }` | `200 OptionListItem` |
| DELETE | `/api/fields/values/:id` | `fields.manage` | — | `200 { id, deletedAt }` |
| POST | `/api/fields/values/reorder` | `fields.manage` | `OptionListReorderInput` = `{ listKey, ids: Uuid[] }` | `200 OptionListItem[]` |

**`expectedVersion` is mandatory on PUT.** `option_lists` gains
`version INTEGER NOT NULL DEFAULT 1` in `20260306` for exactly this
(`03-DATABASE.md` §6.3), and the guard is the same `assertVersionMatches`
(`master/src/domain/access.ts:183-192`) every other edit path in the product uses: omitted is a 400
carrying `storedVersion`, stale is a 409 carrying `storedVersion`. It is not optional here because
this is precisely the screen two administrators curate at once — one relabels "Ivory", the other
recolours it, and last-write-wins silently discards one of them. The Fields tests gain a concurrency
gate for it (`10-TESTING.md`).

`reorder` and `DELETE` do not take one: a reorder submits the complete ordered list and is
self-validating against the set's live ids, and a delete overwrites no field values.

**Editing `value` itself is refused.** The value is what records hold; changing it would silently
orphan every record carrying the old string. Rename the `label` instead — that is what the label is
for. `normaliseOptionValue` (`master/src/domain/field-values.ts`) trims and **deliberately does not
case-fold**: a value's identity is the exact string it always was, which is what makes "removing a
value never touches the records that used it" true rather than aspirational.

DELETE sets `deleted_at` / `deleted_by`. The value stays on every record that holds it; the row simply
stops being offered and appears in the Recycle Bin. A colour with no `option_lists` row renders
through the two-letter ring fallback the design spec already defines — the five colour columns and
`stockKey()` are not touched by this module at all.

`reorder` takes the **complete ordered list, not a delta**. A delta cannot express "these two swapped"
without a read-modify-write race.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'value' }` | Empty after trimming, or present in a PUT body |
| `ValidationError` | 400 | `{ field: 'hex' }` | Not `#RRGGBB` |
| `ValidationError` | 400 | `{ field: 'ids', missing: [...], unexpected: [...] }` | `reorder` list is not exactly the set's live ids |
| `ForbiddenError` | 403 | `{ permission: 'fields.manage' }` | Key not held — including for a management-tier user on an unattended panel |
| `ValidationError` | 400 | `{ field: 'expectedVersion', storedVersion }` | Omitted on PUT |
| `NotFoundError` | 404 | — | No such id, or another tenant's |
| `ConflictError` | 409 | `{ field: 'value', value }` | `(tenant_id, list_key, value)` already live — the unique index at `20260301:296` |
| `ConflictError` | 409 | `{ storedVersion, diff }` | Stale `expectedVersion` on PUT |

### 5.4 Custom-field definitions

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/api/fields/definitions` | `fields.manage` | `CustomFieldDefinitionInput` = `{ entity, key, label, fieldType, isRequired?, options?, sequence? }` | `201 CustomFieldDefinition` |
| PUT | `/api/fields/definitions/:id` | `fields.manage` | `{ label?, isRequired?, options?, isActive?, expectedVersion: number }` | `200 CustomFieldDefinition` |
| DELETE | `/api/fields/definitions/:id` | `fields.manage` | — | `200 { id, deletedAt }` |
| POST | `/api/fields/definitions/reorder` | `fields.manage` | `CustomFieldReorderInput` = `{ entity, ids: Uuid[] }` | `200 CustomFieldDefinition[]` |

`key` and `entity` are **immutable** for the same reason `value` is: they are what the stored JSONB on
each record is keyed by. DELETE leaves those stored JSONB values untouched.

`fieldType` ∈ `text` \| `number` \| `date` \| `select` \| `boolean` (the `CHECK` at `20260301:304`).
`entity` ∈ `lead` \| `order` \| `party` \| `product` (the `CHECK` at `20260301:301`).

**`expectedVersion` is mandatory on PUT**, for the reason and with the shape §5.3 gives:
`custom_field_definitions` gains `version INTEGER NOT NULL DEFAULT 1` in the same migration
(`03-DATABASE.md` §6.4), and a stale save is refused with 409 carrying `storedVersion` rather than
quietly overwriting an option list somebody else just edited.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'fieldType', allowed: [...] }` | Not one of the five |
| `ValidationError` | 400 | `{ field: 'key' }` | Empty, or present in a PUT body |
| `ValidationError` | 400 | `{ field: 'options' }` | `fieldType === 'select'` with an empty list |
| `ValidationError` | 400 | `{ field: 'expectedVersion', storedVersion }` | Omitted on PUT |
| `ConflictError` | 409 | `{ field: 'key', value }` | `(tenant_id, entity, key)` already live — `idx_custom_fields_key`, `20260301:312` |
| `ConflictError` | 409 | `{ storedVersion, diff }` | Stale `expectedVersion` on PUT |

### 5.5 Pipeline stages

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| PUT | `/api/fields/stages/:id` | `fields.manage` | `PipelineStageInput` = `{ name?, colourHex?, isTerminal?, isDefault? }` | `200 PipelineStage` |
| POST | `/api/fields/stages/reorder` | `fields.manage` | `StageReorderInput` = `{ pipelineId, ids: Uuid[] }` | `200 PipelineStage[]` |
| POST | `/api/fields/stages/:id/archive` | `fields.manage` | — | `200 PipelineStage` |
| POST | `/api/fields/stages/:id/restore` | `fields.manage` | — | `200 PipelineStage` |

Setting `isDefault: true` demotes the previous default in the same transaction, **clear-then-set**:
`idx_pipeline_stages_one_default` (`20260301:261`) is a *partial* unique index and genuinely cannot
become a deferrable constraint, so the two writes must be ordered rather than deferred.

Reordering is different: `idx_pipeline_stages_seq` (`20260301:253`) is a plain unique **index**, and a
unique index cannot be `DEFERRABLE`. `20260306000000` drops it and re-adds it as
`ALTER TABLE pipeline_stages ADD CONSTRAINT … UNIQUE (pipeline_id, sequence) DEFERRABLE INITIALLY
IMMEDIATE`, so a permutation can be written in one statement group without tripping the constraint
mid-way.

`archive` sets `is_archived`; it is **not** a soft delete and the stage does not appear in the Recycle
Bin. `restore` clears it.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'ids', pipelineId }` | Reorder list is not exactly the pipeline's stage ids |
| `ValidationError` | 400 | `{ field: 'colourHex' }` | Not `#RRGGBB` |
| `ConflictError` | 409 | `{ occupiedBy: { leads: n, orders: n }, suggestedTarget: Uuid \| null }` | `archive` refused while live leads or orders sit in the stage. `suggestedTarget` is the pipeline's default stage, offered so the caller can move them first |
| `ConflictError` | 409 | `{ field: 'isDefault' }` | `archive` on the pipeline's default stage |
| `NotFoundError` | 404 | — | No such stage, or another tenant's |

### 5.6 The three existing reads stay exactly as they are

`GET /api/pipelines`, `GET /api/option-lists` and `GET /api/custom-fields`
(`data.routes.ts:65-84`) remain gated by `requireAuth` **only**. They now call `fieldsService` read
functions instead of repositories directly, but those particular exports do not check `fields.view`.

This is not an oversight. Those three feed the Add Lead form and `buildSnapshot`'s `Promise.all`
(`master/src/services/snapshot.service.ts:43-49`). Routing them through a `fields.view`-checking read
would make that `Promise.all` reject for anyone lacking the key — and a rejected `buildSnapshot`
produces **no snapshot at all**, swallowed into a log line at `hub.ts:176`. A permission check there
would lock a user out of the entire panel. The new `/api/fields/*` surface is separate.

### 5.7 Not added to `shared`

No new `ChangedEntity` member, and no new `SYNCABLE_ENTITIES` / `ENTITY_PREFIX` / `MUTATION_KINDS` /
`MUTATION_PERMISSIONS` entry. `'option_list'`, `'custom_field'` and `'pipeline'` are already declared
`ChangedEntity` members (`shared/src/protocol/socket.ts:173-175`) that nothing has ever emitted; this
module is what finally emits them. Reuse, not addition.

---

## 6. PDF Designer

Template CRUD, server-side rendering, and export history. Mounted
`app.use('/api/documents', documentRoutes)`.

**Rendering is server-side in the Master**, PDFKit + fontkit, with vendored SIL OFL faces. The
permission rule settles it: rate redaction is decided from the `ActorContext`, the rate column must be
**absent from the document** rather than zeroed, and the export must be recorded in `document_exports`
*and* `activity_log` in one transaction. A client-side renderer can do none of that and could not be
trusted with the first.

Devanagari support is a **hard requirement** — party names, addresses and terms in Hindi are otherwise
unrenderable — which eliminates the PDF libraries that ship WinAnsi encoding only.

The rate-redaction key is **`field.saleRate.view`**. `products.rate.view` does not exist in the
catalogue.

### 6.1 Shared types

```ts
// shared/src/domain/documents.ts (new file)

/** Three members. The product does not raise invoices, and the CHECK on
 *  document_templates.document_type has the same three (03-DATABASE.md §5.2). */
export type DocumentType      = 'quotation' | 'order_confirmation' | 'dispatch_note';
/** Matches the CHECK on document_templates.paper_size. */
export type PaperSize         = 'A4' | 'A5' | 'Letter';
export type PageOrientation   = 'portrait' | 'landscape';
export type DocumentAssetKind = 'logo' | 'signature';

// --- The layout grammar ----------------------------------------------------

export type DocumentBlockKind =
  'header' | 'party' | 'lines' | 'totals' | 'terms' | 'signature';

export type DocumentBlock =
  | { kind: 'header';    align: 'left' | 'centre' }
  | { kind: 'party' }
  | { kind: 'lines';     groupByProduct: boolean }
  | { kind: 'totals';    showBoxCount: boolean }
  | { kind: 'terms';     text: string }
  | { kind: 'signature'; label: string };

/** Block ORDER and per-block options. Never a toggle — see below. */
export interface DocumentLayout {
  blocks: DocumentBlock[];
}

export interface DocumentTemplate {
  id: Uuid;
  tenantId: Uuid;
  name: string;
  documentType: DocumentType;
  paperSize: PaperSize;
  orientation: PageOrientation;
  margins: { top: number; right: number; bottom: number; left: number };  // millimetres

  // The eight switches. Typed BOOLEAN columns on document_templates, NOT keys
  // inside `layout` — 03-DATABASE.md §5.2 owns the columns.
  showRates: boolean;
  showColourChips: boolean;
  showTerms: boolean;
  showLogo: boolean;
  showSignature: boolean;
  showPageNumbers: boolean;
  showWatermark: boolean;
  showPartyBlock: boolean;

  /** Block order and per-block options only. Grammar below. */
  layout: DocumentLayout;

  logoAssetId: Uuid | null;
  signatureAssetId: Uuid | null;
  isDefault: boolean;
  version: number;
  deletedAt: IsoTimestamp | null;
  /** A US… user id. */
  deletedBy: RecordId | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface DocumentAsset {
  id: Uuid; tenantId: Uuid; kind: DocumentAssetKind;
  mimeType: 'image/png' | 'image/jpeg';
  byteSize: number; width: number; height: number;
  createdAt: IsoTimestamp;
}

export interface DocumentExport {
  id: string;                    // BIGSERIAL as TEXT
  tenantId: Uuid;
  templateId: Uuid | null;       // null once the template is deleted
  templateName: string;          // denormalised, so history still reads correctly
  documentType: DocumentType;
  subjectKind: 'lead' | 'order';
  subjectId: RecordId;
  subjectLabel: string;
  fileName: string;
  byteSize: number;
  pageCount: number;
  /** The audit-grade fact that the copy sent to this customer carried no prices. */
  ratesIncluded: boolean;
  /** A US… user id, or null when an unattended panel rendered it. */
  renderedBy: RecordId | null;
  renderedByName: string | null;
  /** The id of the export that replaced this one, or null if this is the current one. */
  supersededBy: string | null;
  createdAt: IsoTimestamp;
}

export interface DocumentRenderResult {
  exportId: string; fileName: string; byteSize: number;
  pageCount: number; ratesIncluded: boolean; downloadPath: string;
}

/** The in-memory fallback template and the designer's prefill. */
export const TEMPLATE_DEFAULTS: Record<DocumentType, Omit<DocumentTemplate, 'id' | 'tenantId' | …>>;
```

#### The switch/layout split, stated once

**Eight switches are typed BOOLEAN columns. `layout` holds block order and per-block options, and
nothing else.** That division is not a style preference; it is what makes a typo a compile error
instead of a document that silently prints without its rate column. A typed field means the renderer
reads `template.showRates`; a key inside `layout` means it reads `layout.showRates ?? true` forever.
`03-DATABASE.md` §5.2 carries the eight columns and the argument in full.

`07-UI-SPEC.md`'s description of nine toggles writing into `layout` is **wrong** and is corrected
there: eight of them are columns, and the ninth thing the designer manipulates is the block list
itself, which is what `layout` is.

#### The grammar `assertTemplateValid` enforces

Five rules, checked in `master/src/domain/document-template.ts` before any write, on both
`POST`/`PUT` and `POST /api/documents/preview`:

| # | Rule |
|---|---|
| 1 | Every `kind` appears **at most once** — a document with two totals blocks is not a layout, it is a bug |
| 2 | `lines` is **mandatory** — a document with no line items is a letterhead |
| 3 | `header`, if present, must be **first** |
| 4 | `signature`, if present, must be **last** |
| 5 | `terms.text` is at most **500 characters** |

A violation is a 400:

```jsonc
{
  "error": "validation_error",
  "message": "…",
  "details": { "field": "layout", "block": 3, "reason": "duplicate_kind" }
}
```

`block` is the **zero-based index into `blocks`** of the offending member, so the designer can
highlight the block rather than the form. For a violation with no single offending member — rule 2 —
`block` is `null` and `reason` is `'missing_lines'`. The `reason` values are
`'duplicate_kind'`, `'missing_lines'`, `'header_not_first'`, `'signature_not_last'`,
`'terms_too_long'`.

Ordering rules cannot live in a SQL `CHECK` — they are constraints on the *sequence* of a JSONB
array — which is why the domain function is the only validator and why the column default in
`03-DATABASE.md` §5.2 is a minimal legal document (`{"blocks":[{"kind":"lines","groupByProduct":false}]}`)
rather than `'{}'`: a default that fails its own validator is a row the service would refuse to save
back unchanged.

### 6.2 Templates

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| GET | `/api/documents/templates` | `documents.view` | — (query: `documentType`, `cursor`, `limit`) | `200 CursorPage<DocumentTemplate>` |
| GET | `/api/documents/templates/:id` | `documents.view` | — | `200 DocumentTemplate` |
| POST | `/api/documents/templates` | `documents.create` | `DocumentTemplateInput` | `201 DocumentTemplate` |
| PUT | `/api/documents/templates/:id` | `documents.edit` | `DocumentTemplateInput & { expectedVersion: number }` | `200 DocumentTemplate` |
| DELETE | `/api/documents/templates/:id` | `documents.delete` | `{ expectedVersion: number }` | `200 { id, deletedAt }` |
| POST | `/api/documents/templates/:id/restore` | `documents.delete` | — | `200 DocumentTemplate` |

**List paging**: keyset on `(lower(name), id)` ascending — a template list is read alphabetically, not
newest-first. `prevCursor: null`. Default limit 50, clamped 1–200. Soft-deleted rows excluded.

**`expectedVersion` is mandatory on PUT and DELETE.** `assertVersionMatches`
(`master/src/domain/access.ts:183-192`) already throws `ValidationError` with
`{ field: 'expectedVersion', storedVersion }` when it is omitted, and `ConflictError` carrying
`storedVersion` and the field diff when it is stale. Both reach an Office browser only once §9.1
lands — this is the second module that makes the ack fix a prerequisite rather than a nicety.

Promoting `is_default` demotes the previous default **for that document type** in the same
transaction. DELETE frees the name immediately by way of the partial unique index; existing
`document_exports` rows keep `template_name` denormalised so history still reads correctly. Restore
refuses with 409 if a live template has taken the name since — and restore is gated by the **delete**
key, matching §4.4 rather than inventing a restore key.

`POST /api/documents/templates/:id/restore` ships with this module — Stage 6 — **regardless of the
Recycle Bin**. It is the template screen's own undo. `'document_template'` also joins
`RECYCLE_BIN_ENTITIES` at the same stage (§4.1), and the two are simply two callers of one service
function; neither depends on the other existing.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'expectedVersion', storedVersion }` | Omitted on PUT/DELETE |
| `ValidationError` | 400 | `{ field: 'paperSize' \| 'orientation', allowed: [...] }` | Unknown value |
| `ValidationError` | 400 | `{ field: 'margins', reason: 'exceeds_page' }` | `assertTemplateValid` — margins leave no printable area |
| `ValidationError` | 400 | `{ field: 'layout', block: n \| null, reason }` | Block grammar violation — the five rules and five `reason` values in §6.1 |
| `ValidationError` | 400 | `{ field: 'documentType', allowed: ['quotation','order_confirmation','dispatch_note'] }` | Unknown document type — three members, no `invoice` |
| `ConflictError` | 409 | `{ field: 'name', value }` | Duplicate name for the tenant |
| `ConflictError` | 409 | `{ storedVersion, diff }` | Stale `expectedVersion` |
| `NotFoundError` | 404 | — | No such id, another tenant's, or (on GET/PUT) soft-deleted |

### 6.3 Assets

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/api/documents/assets` | `documents.edit` | `DocumentAssetInput` = `{ kind, dataUrl }` | `201 DocumentAsset` |
| GET | `/api/documents/assets/:id/file` | `documents.view` | — | `200 image/png` \| `image/jpeg`, `Content-Disposition: inline` |

A base64 data URL in a JSON body rather than multipart, deliberately: `express.json` already parses
the request at both ends, so there is no `multer` dependency and no new parser in the global chain.

Validated on three axes — **magic bytes**, declared mime, and a **512 KB raw cap** (§1.7). SVG is
refused: PDFKit draws PNG and JPEG natively, and an SVG would need a second library and a second
parser on untrusted input.

Assets are **never served from `/uploads`** (`master/src/http/app.ts:44`, which is `express.static`
and unauthenticated). They are streamed by an authenticated route that resolves the path from
`config` plus the stored key, never from any client-supplied string.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'dataUrl', reason: 'unsupported_type', allowed: ['image/png','image/jpeg'] }` | Magic bytes or mime not PNG/JPEG |
| `ValidationError` | 400 | `{ field: 'dataUrl', reason: 'too_large', maxBytes: 524288 }` | Over the cap |
| `ValidationError` | 400 | `{ field: 'kind', allowed: ['logo','signature'] }` | Unknown kind |
| `NotFoundError` | 404 | — | No such asset, or another tenant's |

### 6.4 Rendering

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/api/documents/render` | `documents.render` **and** the subject's own view key | `RenderDocumentInput` = `{ templateId, subjectKind, subjectId }` | `200 DocumentRenderResult` |
| POST | `/api/documents/preview` | `documents.render` **and** the subject's own view key | `PreviewDocumentInput` = `{ template, subjectKind, subjectId }` | `200 application/pdf`, `Content-Disposition: inline` |

The route guard is `needs('documents.render')`. The subject's key — `leads.view` for a lead,
`orders.view` for an order — is checked **in the service**, because it depends on the body. Document
access can therefore never exceed record access.

`reports.export` is deliberately **not** reused for either. Overloading it would make unticking one
silently disable the other.

`render` **persists**: it writes the file, the `document_exports` row and the `activity_log` entry
(`recordActivity(entry, actor, trx)`) in one transaction, then returns metadata rather than bytes.
The browser then GETs the file. That asymmetry is the point — a retry does not re-render, and the
same bytes the customer received stay addressable.

**`render` is also the writer of `superseded_by`, in the same transaction.** After inserting the new
row it looks up the most recent non-superseded, non-deleted export for
`(tenantId, subjectKind, subjectId, documentType)` and stamps it with the new id
(`03-DATABASE.md` §5.3 carries the statement). Nothing else writes that column, and it is worth
saying out loud: a column nothing writes is the same defect as a permission nothing enforces — it
reads as a guarantee and delivers nothing. What it buys is that "which quotation is the current one
for this order" has an answer that does not depend on comparing timestamps, and
`DocumentExport.supersededBy` is what the history list greys a row on.

The lookup is served by `idx_document_exports_subject (tenant_id, subject_type, subject_id, id DESC)`,
so it costs one index probe over the handful of exports one subject has ever produced.

`preview` persists **nothing**: no file, no export row, no activity entry, and the `PREVIEW` watermark
is forced on regardless of what the template says. It takes a whole `template` object rather than an
id, so the designer can preview unsaved edits. Capped at `config.documents.maxPreviewBytes`.

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ForbiddenError` | 403 | `{ permission: 'documents.render' }` | Route guard |
| `ForbiddenError` | 403 | `{ permission: 'leads.view' \| 'orders.view' }` | Service check on the subject |
| `ValidationError` | 400 | `{ field: 'subjectKind', allowed: ['lead','order'] }` | Unknown subject kind |
| `ValidationError` | 400 | `{ field: 'templateId', documentType }` | Template's `documentType` does not apply to this subject |
| `NotFoundError` | 404 | — | No such template or subject, or another tenant's |
| `ConflictError` | 409 | `{ reason: 'subject_deleted' }` | The lead or order is soft-deleted |
| `AppError` | 500 | — | Render failure. The transaction rolls back, so no orphan export row survives a half-written file |

### 6.5 Export history

| Method | Path | Permission | Query / param | Response |
|---|---|---|---|---|
| GET | `/api/documents/exports` | `documents.view` (+ per-row filtering) | `subjectKind`, `subjectId`, `cursor`, `limit` | `200 CursorPage<DocumentExport>` |
| GET | `/api/documents/exports/:id` | `documents.view` + subject's view key | — | `200 DocumentExport` |
| GET | `/api/documents/exports/:id/file` | `documents.view` + subject's view key | — | `200 application/pdf`, `Content-Disposition: attachment` |

**List paging**: keyset on `id DESC` (`BIGSERIAL`), `WHERE tenant_id = ? AND id < :cursor`. The cursor
round-trips the id as a **string** (§1.4). Default limit 50, clamped 1–200. `prevCursor: null`.

**Rows whose subject kind the caller may not view are filtered OUT, not refused.** This follows
`search.service.ts`, so a dispatch clerk holding `orders.view` but not `leads.view` sees a coherent
list of order documents rather than a 403 on the whole page. The single-row endpoints do refuse,
because there is nothing to filter down to.

The file route re-checks permission and tenant, resolves the path from `config` plus `storage_key`,
and answers **404 for another tenant's id rather than 403**, so it cannot be used to probe which ids
exist (§1.3).

---

## 7. Dashboard

### 7.1 `GET /api/dashboard` — unchanged path, changed body

Route unchanged at `data.routes.ts:51-56`: `requireAuth` only, no route-level permission guard. Every
individual figure is gated **inside the service**, and a figure the caller may not see is **absent**,
never `0` (§1.5).

```ts
// shared/src/domain/entities.ts:567 — EXTENDED, not replaced
export interface DashboardSummary {
  leadCount?: number;
  orderCount?: number;
  partyCount?: number;
  productCount?: number;
  lowStockCount?: number;
  followUpsDueCount?: number;
  openConflictCount?: number;
  pendingSyncCount?: number;
  // new
  openOrderCount?: number;
  dispatchedThisWeekCount?: number;
  pipelineBreakdown?: Array<{
    stageId: Uuid;
    stageName: string;
    /** The stage's position in its pipeline, so the client orders without re-deriving it. */
    sequence: number;
    colourHex: string | null;
    leadCount: number;
  }>;
  /** When these figures were computed. Always present — an offline panel labels its staleness from it. */
  asOf: IsoTimestamp;
}
```

| Figure | Gate |
|---|---|
| `leadCount`, `followUpsDueCount`, `pipelineBreakdown` | `leads.view` |
| `orderCount`, `openOrderCount`, `dispatchedThisWeekCount` | `orders.view` |
| `partyCount` | `parties.view` |
| `productCount` | `products.view` |
| `lowStockCount` | `inventory.view` |
| `openConflictCount`, `pendingSyncCount` | `sync.resolveConflicts` |
| `asOf` | **ungated** — it describes the response, not the company |

**Every counter is optional and absent when its key is not held**, `openConflictCount` and
`pendingSyncCount` included. They were previously required and ungated on the argument that sync
health is a fact about the installation rather than company data. That argument does not survive
contact with the rest of the table: a conflict count is a count of *records* in dispute, it is the
one figure with an action attached, and the action is gated by `sync.resolveConflicts`. A number
whose only response is a screen the reader cannot open is either noise or a leak. Gating them
per-figure, like everything else, is the consistent answer.

`asOf` stays required precisely because it is not a figure — it is the timestamp of the response
itself, and a panel labelling stale cached figures needs it whatever the reader may see.

That makes all ten counters optional: a **breaking type change** for every current reader of
`DashboardSummary`, and deliberate. The alternative is a gated figure arriving as `0`, which reads as
"no leads" rather than "not your business".

`pipelineBreakdown`'s element is `{ stageId, stageName, sequence, colourHex, leadCount }`.
`sequence` is on it because the array is rendered as a pipeline in order, and re-deriving that order
client-side would need the full `pipeline_stages` list the dashboard does not otherwise send.

Two new repository functions land in `master/src/repositories/dashboard.repository.ts`:
`leadCountsByStage` and `dispatchedThisWeek`. `dashboard.service.ts:51` currently calls `db()`
directly — a live layering violation this module fixes on its way past.

`dispatchedThisWeek` computes its week boundary **in SQL against `config.locale.timeZone`**. A week
that starts at UTC midnight is a week that starts at 05:30 IST, which puts an early-morning dispatch
in the wrong week.

### 7.2 No new dashboard endpoints

The existing `DashboardSummary` / `dashboard.service` / `dashboard:changed` triple is reused. The
Office reaches it two ways: cached, through `SyncSnapshot.dashboard` (§9.5), and live, through the
`dashboard:get` command (§10.3).

Counting client-side from the snapshot was rejected for a concrete reason: `SNAPSHOT_LIMIT` is 500
rows per collection and the snapshot excludes converted leads, so a client-side count would be
**silently wrong** at any real scale. Online the panel gets a correct figure; offline it gets an
honestly-labelled stale one, which is the better of the two failures.

---

## 8. i18n — three changed endpoints

The i18n layer adds **no new endpoint**. It is the only one of the six modules that needs nothing
from the Master at runtime: both catalogues are compiled into each panel's bundle before it ever
contacts one. Three existing endpoints change shape.

| Method | Path | Change | Permission |
|---|---|---|---|
| GET | `/api/access/permission-catalogue` | Payload gains a `labelToken` on each entry of the new `actions` array, alongside the module and capability tokens it already carries | **Unchanged**: `requireAuth` only. One of the two deliberately ungated handlers on `accessRoutes`, and `credential-invariants.test.ts:73-89` counts on it staying that way |
| GET | `/api/auth/me` | Additionally returns `defaultLocale`, so a fresh browser profile on a Hindi-deployed machine starts in Hindi | `requireAuth` |
| GET | `/api/session` (Office) | Additionally returns `defaultLocale`. Answered from local state, never forwarded, so it works with the Master switched off | **None** — registered *before* the `app.use('/api', requireUser)` gate at `office/src/http/app.ts:133`, as it must be for the sign-in screen to render in the right language |

The server never renders a user-facing sentence. It returns a stable `messageKey` plus named params
and the client renders. This is forced rather than chosen: locale is per-machine and never synced, so
one Master serving several panels has no recipient locale to render for.

`AppError` gains `messageKey` and `params`, and the HTTP envelope and the socket ack carry both. On
the envelope this is purely additive on top of the `code` / `details` contract that already exists.
**Whether `messageKey` is required is open (O-1)** — **129** `AppError`-family throw sites in
`master/src`, and **0** in `office/src`, depend on the answer, and it is a dependency of every other
module in this batch.

---

## 9. The Socket.IO surface

### 9.1 The ack `details` fix — Stage 0, prerequisite for two modules

`CommandResult<T>`'s `{ ok: false }` arm (`shared/src/protocol/socket.ts:142-159`) carries `code?` and
`missingPermission?` and nothing else, and `respond()` (`master/src/realtime/hub.ts:391-406`) never
sets `code` at all except for `ForbiddenError`, and never sends `details`. So every structured
conflict arrives on an Office Panel as a bare English string — the Recycle Bin's `blockedBy` list and
rename `suggestion` (§4.4), and the PDF Designer's `storedVersion` / `diff` (§6.2).

This is **Stage 0** in `11-BUILD-SEQUENCE.md`'s numbering, which runs 0–8 and is the only stage
numbering this document uses: 0 socket-ack `details`, 1 i18n foundation, 2 Recycle Bin, 3 Fields,
4 Logs, 5 Reports, 6 PDF Designer, 7 permission grant migration, 8 Office Dashboard.

Four files, in this order.

**1. `shared/src/protocol/socket.ts:142-159`** — one field:

```ts
export type CommandResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      code?: string;
      missingPermission?: string;
      /**
       * Structured facts about the failure, mirroring the HTTP envelope's
       * `details` (http/middleware/error-handler.ts:28-32). Without it the
       * Office browser gets prose where the Master sent data.
       */
      details?: Record<string, unknown>;
    };
```

**2. `master/src/realtime/hub.ts` `respond()`** — set `code` and `details` for any `AppError`, not
only `ForbiddenError`. `AppError` is already imported at `hub.ts:24`:

```ts
.catch((error: unknown) => {
  log.warn(`Command failed: ${toErrorMessage(error)}`);

  if (error instanceof AppError) {
    ack({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error instanceof ForbiddenError ? { missingPermission: error.permission } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  ack({ ok: false, error: toErrorMessage(error) });
});
```

`messageKey` and `params` are added here too, by the i18n foundation, subject to **O-1**.

**3. `office/src/realtime/master-connection.ts`** — `MasterCommandError` gains `details`, appended
**after** `unreachable` with a default so the two existing unreachable constructions (lines 235 and
242) compile unchanged and only the ack path at line 257 changes:

```ts
constructor(
  message: string,
  readonly code: string | undefined,
  readonly missingPermission: string | undefined,
  readonly unreachable: boolean,
  readonly details: Record<string, unknown> = {},
) { … }
```

**4. `office/src/http/app.ts` `forward()`** — pass `details` through alongside the permission it
already forwards, and map the Master's code to the status that code means:

```ts
const FORWARD_STATUS: Record<string, number> = {
  validation_error: 400,
  unauthorized:     401,
  forbidden:        403,
  tenant_violation: 403,
  not_found:        404,
  conflict:         409,
};
// Anything else — including an absent code — stays 502: the Master answered
// something this panel does not model.
```

The status map is beyond the four bullet points in `docs/BACKEND_MODULES.md` §2.5, and it earns its
place: without it a Recycle Bin rename collision reaches the Office browser as **502** with the
`conflict` code buried in the body, which defeats the reason for shipping `details` at all. The map
is not an invention — it is `AppError`'s own status codes (`master/src/lib/errors.ts:30-78`) restated
on the far side of the socket.

`503 { error: 'unavailable' }` is untouched. It stays decided from `MasterCommandError.unreachable`,
a transport flag, and never from reading the message — a Postgres "canceling statement due to
statement timeout" is a message the Master *sent*, so it means refused, not silent.

### 9.2 The shape every new command follows

`registerCommands()` (`master/src/realtime/hub.ts:204-302`) is one line per command:

```ts
function registerCommands(socket: PanelSocket, actorFor: () => Promise<ActorContext>): void {
  const run = <T>(ack: CommandAck<T>, operation: (actor: ActorContext) => Promise<T>): void =>
    respond(ack, async () => operation(await actorFor()));

  // …existing commands…

  socket.on('log:list', (query, ack) => run(ack, (actor) => logService.listLogs(query, actor)));
  socket.on('recycleBin:restore', (input, ack) =>
    run(ack, (actor) => recycleBinService.restoreEntity(input, actor)),
  );
}
```

Three properties, all mandatory:

- **`run(ack, actor => …)`, never a bare `socket.on` with its own try/catch.** `respond()` is what
  guarantees the ack is answered exactly once; throwing across the socket leaves the Office Panel's
  UI waiting forever.
- **`actorFor()` is called per command**, never captured at connection time. A socket outlives
  sign-ins, sign-outs and role edits, and caching the actor at connect is exactly how a revoked
  permission survives until the next reconnect (`hub.ts:195-203`).
- **The command delegates to the identical service function the HTTP route calls.** The route
  middleware does not exist on this path, so the service's own `requirePermission` is the *only* gate
  an Office command passes. A service that relies on its route guard is a service with no gate here.

New commands go in `registerCommands`, never in `registerAuthCommands` (`hub.ts:311-381`), which is
the narrow group a panel may issue while holding no user identity at all.

### 9.3 New `ClientToServerEvents` entries

**46 entries**, added to `shared/src/protocol/socket.ts:218-303`, itemised below: Logs 4, Reports 4,
Recycle Bin 7, Fields 17, PDF Designer 13, Dashboard 1. Every one takes an ack; the ack type is
`CommandAck<T>` for the `T` shown. Office `forward()` routes the same 46 (§10.2 lists 47 rows: 46
carry an event, and `GET /api/dashboard` carries none because it is served from the cached snapshot).
**46 is the number**; any document quoting an estimate is quoting this list wrong.

The Fields events all carry the **`fields:`** prefix with the verbs below — `fields:catalogue`,
`fields:values`, `fields:usage`, `fields:definitions`, `fields:stages`, `fields:createValue` and so
on for all seventeen. A `field:` singular prefix, or a `field:listValues` style verb, appears nowhere
in this contract.

**Logs — 4**

| Event | Payload | `CommandAck<T>` |
|---|---|---|
| `log:list` | `ActivityLogQuery` | `CursorPage<ActivityLogEntry>` |
| `log:facets` | `{ from?: string; to?: string }` | `ActivityLogFacets` |
| `log:verifyChain` | `{ fromSequence?: string; toSequence?: string; limit?: number }` | `ChainVerification` |
| `log:export` | `ActivityLogQuery` | `{ fileName: string; csv: string; rowCount: number; truncated: boolean }` |

**Reports — 4**

| Event | Payload | `CommandAck<T>` |
|---|---|---|
| `report:dispatches` | `ReportRangeInput` | `DispatchesReport` |
| `report:leadOutcomes` | `ReportRangeInput` | `LeadOutcomesReport` |
| `report:topParties` | `ReportRangeInput & { limit?: number }` | `TopPartiesReport` |
| `report:export` | `{ report: 'dispatches' \| 'lead-outcomes' \| 'top-parties' } & ReportRangeInput` | `{ fileName: string; csv: string; rowCount: number }` |

**Recycle Bin — 7**

| Event | Payload | `CommandAck<T>` |
|---|---|---|
| `recycleBin:list` | `RecycleBinQuery` | `CursorPage<BinEntry>` |
| `recycleBin:counts` | `RecycleBinQuery` | `BinCounts` |
| `recycleBin:restore` | `RestoreInput` | `BinRestoreResult` |
| `lead:delete` | `RecordId` | `{ id: RecordId; deletedAt: IsoTimestamp }` |
| `order:delete` | `RecordId` | `{ id: RecordId; deletedAt: IsoTimestamp }` |
| `party:delete` | `RecordId` | `{ id: RecordId; deletedAt: IsoTimestamp }` |
| `product:delete` | `RecordId` | `{ id: RecordId; deletedAt: IsoTimestamp }` |

**Fields — 17**

| Event | Payload | `CommandAck<T>` |
|---|---|---|
| `fields:catalogue` | — | `FieldCatalogue` |
| `fields:values` | `{ listKey; includeDeleted?; includeUnlisted? }` | `{ items: OptionListItem[]; unlisted?: string[] }` |
| `fields:usage` | `{ listKey }` | `FieldUsageBreakdown` |
| `fields:createValue` | `OptionListItemInput` | `OptionListItem` |
| `fields:updateValue` | `{ id: Uuid; input: Partial<OptionListItemInput> & { expectedVersion: number } }` | `OptionListItem` |
| `fields:deleteValue` | `Uuid` | `{ id: Uuid; deletedAt: IsoTimestamp }` |
| `fields:reorderValues` | `OptionListReorderInput` | `OptionListItem[]` |
| `fields:definitions` | `{ entity?; includeDeleted? }` | `CustomFieldDefinition[]` |
| `fields:createDefinition` | `CustomFieldDefinitionInput` | `CustomFieldDefinition` |
| `fields:updateDefinition` | `{ id: Uuid; input: Partial<CustomFieldDefinitionInput> & { expectedVersion: number } }` | `CustomFieldDefinition` |
| `fields:deleteDefinition` | `Uuid` | `{ id: Uuid; deletedAt: IsoTimestamp }` |
| `fields:reorderDefinitions` | `CustomFieldReorderInput` | `CustomFieldDefinition[]` |
| `fields:stages` | — | `Pipeline[]` |
| `fields:updateStage` | `{ id: Uuid; input: PipelineStageInput }` | `PipelineStage` |
| `fields:reorderStages` | `StageReorderInput` | `PipelineStage[]` |
| `fields:archiveStage` | `Uuid` | `PipelineStage` |
| `fields:restoreStage` | `Uuid` | `PipelineStage` |

**PDF Designer — 13**

| Event | Payload | `CommandAck<T>` |
|---|---|---|
| `document:listTemplates` | `CursorQuery & { documentType? }` | `CursorPage<DocumentTemplate>` |
| `document:getTemplate` | `Uuid` | `DocumentTemplate` |
| `document:createTemplate` | `DocumentTemplateInput` | `DocumentTemplate` |
| `document:updateTemplate` | `{ id: Uuid; input: DocumentTemplateInput & { expectedVersion: number } }` | `DocumentTemplate` |
| `document:deleteTemplate` | `{ id: Uuid; expectedVersion: number }` | `{ id: Uuid; deletedAt: IsoTimestamp }` |
| `document:restoreTemplate` | `Uuid` | `DocumentTemplate` |
| `document:uploadAsset` | `DocumentAssetInput` | `DocumentAsset` |
| `document:assetFile` | `Uuid` | `{ fileName: string; contentType: string; bytes: Uint8Array }` |
| `document:render` | `RenderDocumentInput` | `DocumentRenderResult` |
| `document:preview` | `PreviewDocumentInput` | `{ fileName: string; contentType: 'application/pdf'; bytes: Uint8Array }` |
| `document:listExports` | `DocumentExportQuery` | `CursorPage<DocumentExport>` |
| `document:getExport` | `string` | `DocumentExport` |
| `document:exportFile` | `string` | `{ fileName: string; contentType: 'application/pdf'; bytes: Uint8Array }` |

Binary travels as `Uint8Array`. Socket.IO's default parser sends it as a separate attachment rather
than inline JSON, which avoids base64's 33% inflation on a ~200 KB file. The size ceiling on this
path is **open (O-2)**.

**Dashboard — 1**

| Event | Payload | `CommandAck<T>` |
|---|---|---|
| `dashboard:get` | — | `DashboardSummary` |

### 9.4 `ChangeAction`, `ChangedEntity`, `DIRECTORY_ENTITIES`

```ts
// shared/src/protocol/socket.ts:180
export type ChangeAction = 'created' | 'updated' | 'deleted' | 'restored';

// shared/src/protocol/socket.ts:163-178 — two members appended
export type ChangedEntity =
  | 'lead' | 'order' | 'party' | 'product' | 'product_category' | 'party_variant'
  | 'office_panel' | 'stock' | 'reservation' | 'pipeline' | 'option_list'
  | 'custom_field' | 'sync_conflict' | 'role' | 'user'
  | 'document_template'      // new
  | 'document_export';       // new
```

`'restored'` is what makes the Recycle Bin propagate without any new `MutationKind`. A restore
publishes `{ entity, action: 'restored', id, payload: <the live row> }` through the existing
`publishChange` path; a panel that has been dropping the row on `'deleted'` puts it back.

`DIRECTORY_ENTITIES` (`master/src/realtime/hub.ts:114`) gains `'document_export'`. An export row names
a lead or an order the recipient may not be entitled to see, so it must not fan out unsolicited to
every paired panel — the same leak that set closed for roles and users. `'document_template'` is
**not** added: a template is configuration, gated by `documents.view`, and carries no record data.

`DASHBOARD_ENTITIES` (`hub.ts:117`) is unchanged.

The Fields module adds **no** `ChangedEntity` member. `'option_list'`, `'custom_field'` and
`'pipeline'` are already declared (`socket.ts:173-175`) and nothing has ever emitted them; this is what
finally does.

### 9.5 `SyncSnapshot.dashboard`

```ts
// shared/src/protocol/socket.ts:198-215 — one field appended
export interface SyncSnapshot {
  // …existing eleven collections, permissions, serverHlc, serverTime…
  /** Computed per-actor by the Master. Absent figures mean "not yours", never zero. */
  dashboard: DashboardSummary;
}
```

Computed inside `buildSnapshot` for the actor the snapshot is being built for, so the Office's normal
path costs **zero new routes**: `/api/snapshot` and the SSE `snapshot` event already carry whatever is
in the snapshot.

`dashboard:changed` (`ServerToClientEvents`, `socket.ts:310`) is extended to `ROOM_OFFICE_PANELS`,
with the summary **re-derived per socket** through `panelActor` — never computed once and broadcast,
because it is permission-filtered and a single broadcast would show one panel's figures to another.
`broadcastDashboard` (`hub.ts:476-504`) already does exactly this for admin sockets and is the model.

Two consequences to record rather than discover:

- `forCurrentUser` (`office/src/http/app.ts:395-407`) must re-filter `dashboard` for whoever is signed
  in **now**, the same way it re-masks `field.saleRate.view`. A snapshot fetched for one person and
  served to the next otherwise hands over their figures.
- This is belt-and-braces, not the panel alone. Master-side per-figure gating (§7.1) is the real gate;
  the Office re-filter exists because the cached file outlives the session it was built for.
- The Office snapshot's lack of **module-level** filtering is a known-open gap, unchanged and not
  widened by this batch. `forCurrentUser` re-masks rates correctly but does not filter collections by
  `*.view`. This batch adds a test asserting every `SyncSnapshot` key is accounted for in
  `forCurrentUser` — there is none today, so a newly added collection is a silent leak. Closing the
  gap properly needs its own owner.

---

## 10. Office forwarding

### 10.1 Where the routes go

Every forwarding route is registered in `office/src/http/app.ts` **after** the positional
`app.use('/api', requireUser)` gate at line 133. That gate is one line rather than a per-route check
precisely so a route added later cannot be forgotten — it is behind it by construction. A route added
*above* line 133 is reachable by anybody standing at the machine.

Each route is one line:

```ts
app.get('/api/logs', (req, res) => forward(res, 'log:list', parseQuery(req.query)));
```

`forward()` (`office/src/http/app.ts:438-462`) already maps `MasterCommandError.unreachable` to
`503 { error: 'unavailable' }`; §9.1 gives it `details` and the status map.

Each forward-only route carries a comment in the same voice as the existing stock comment at
`office/src/http/app.ts:270-271`, saying *why* it is online-only rather than leaving it to be
discovered.

### 10.2 The table

Offline behaviour is **503 `{ error: 'unavailable' }` for every row**, decided from the transport
flag. Nothing in this batch is queued into the outbox.

| Master endpoint | Office route | Event | Notes |
|---|---|---|---|
| `GET /api/logs` | `GET /api/logs` | `log:list` | |
| `GET /api/logs/facets` | `GET /api/logs/facets` | `log:facets` | |
| `POST /api/logs/verify` | `POST /api/logs/verify` | `log:verifyChain` | |
| `GET /api/logs/export` | `GET /api/logs/export` | `log:export` | CSV as a string in the ack. Office-side row cap **open (O-2)** |
| `GET /api/reports/dispatches` | same | `report:dispatches` | |
| `GET /api/reports/lead-outcomes` | same | `report:leadOutcomes` | |
| `GET /api/reports/top-parties` | same | `report:topParties` | |
| `GET /api/reports/:report/export` | same | `report:export` | Cap **open (O-2)** |
| `GET /api/recycle-bin` | same | `recycleBin:list` | |
| `GET /api/recycle-bin/counts` | same | `recycleBin:counts` | |
| `POST /api/recycle-bin/restore` | same | `recycleBin:restore` | 409 `details` needs §9.1 |
| `DELETE /api/leads/:id` | same | `lead:delete` | Sits beside the existing queued `PUT /api/leads/:id` — different method, no conflict |
| `DELETE /api/orders/:id` | same | `order:delete` | |
| `DELETE /api/parties/:id` | same | `party:delete` | |
| `DELETE /api/products/:id` | same | `product:delete` | |
| `GET /api/fields/catalogue` | same | `fields:catalogue` | |
| `GET /api/fields/values` | same | `fields:values` | |
| `GET /api/fields/usage` | same | `fields:usage` | |
| `POST /api/fields/values` | same | `fields:createValue` | |
| `PUT /api/fields/values/:id` | same | `fields:updateValue` | |
| `DELETE /api/fields/values/:id` | same | `fields:deleteValue` | |
| `POST /api/fields/values/reorder` | same | `fields:reorderValues` | |
| `GET /api/fields/definitions` | same | `fields:definitions` | |
| `POST /api/fields/definitions` | same | `fields:createDefinition` | |
| `PUT /api/fields/definitions/:id` | same | `fields:updateDefinition` | |
| `DELETE /api/fields/definitions/:id` | same | `fields:deleteDefinition` | |
| `POST /api/fields/definitions/reorder` | same | `fields:reorderDefinitions` | |
| `GET /api/fields/stages` | same | `fields:stages` | |
| `PUT /api/fields/stages/:id` | same | `fields:updateStage` | |
| `POST /api/fields/stages/reorder` | same | `fields:reorderStages` | |
| `POST /api/fields/stages/:id/archive` | same | `fields:archiveStage` | |
| `POST /api/fields/stages/:id/restore` | same | `fields:restoreStage` | |
| `GET /api/documents/templates` | same | `document:listTemplates` | |
| `GET /api/documents/templates/:id` | same | `document:getTemplate` | |
| `POST /api/documents/templates` | same | `document:createTemplate` | |
| `PUT /api/documents/templates/:id` | same | `document:updateTemplate` | Stale-version 409 `details` needs §9.1 |
| `DELETE /api/documents/templates/:id` | same | `document:deleteTemplate` | |
| `POST /api/documents/templates/:id/restore` | same | `document:restoreTemplate` | |
| `POST /api/documents/assets` | same | `document:uploadAsset` | 512 KB cap; the Office parser is `1mb` (§1.7) |
| `GET /api/documents/assets/:id/file` | same | `document:assetFile` | Bytes through the ack, streamed on by the Office server |
| `POST /api/documents/render` | same | `document:render` | Returns metadata, not bytes |
| `POST /api/documents/preview` | same | `document:preview` | Bytes through the ack. Size **open (O-2)** |
| `GET /api/documents/exports` | same | `document:listExports` | |
| `GET /api/documents/exports/:id` | same | `document:getExport` | |
| `GET /api/documents/exports/:id/file` | same | `document:exportFile` | Bytes through the ack. Size **open (O-2)** |
| `GET /api/dashboard` | *(none — cached)* | — | Rides on `SyncSnapshot.dashboard`; served from `/api/snapshot` and the SSE `snapshot` event |
| — | `POST /api/dashboard/refresh` | `dashboard:get` | The one live pull. 503 offline; the cached figures stay on screen with their `asOf` label |

### 10.3 What is Master-only, and why

**None of the six modules is Master-only.** All six are permission-gated and reachable from both
panels; that is a settled decision, and the table above is what implements it.

The Dashboard aggregate is the one place where "fails hard offline" needs a sentence of precision. The
live pull (`POST /api/dashboard/refresh` → `dashboard:get`) fails hard with 503 like everything else.
The *cached* figures survive offline because they arrive inside `SyncSnapshot`, which the panel
already holds on disk and already serves offline — no new transport, no new caching decision, nothing
queued. The card renders the last figure with its `asOf` timestamp and says so.

Pre-existing Master-only surface, unchanged by this batch and listed so its absence from the table is
not read as an omission:

| Surface | Why it stays Master-only |
|---|---|
| `/api/access/*` — roles, users, permission catalogue | Roles and users are administered on the Master. `DIRECTORY_ENTITIES` (`hub.ts:114`) withholds their rows from unsolicited panel broadcasts, and the Office has no screens for them. The Recycle Bin's `role` / `user` branches are a different thing: a panel may *ask*, and the service checks `roles.delete` / `users.manage` when it does (§4.2) |
| `/api/setup/*`, `/api/pairing/*`, `/api/panels/*` | Installation and pairing. A panel cannot pair itself through a Master it has not paired with |
| `/api/storage` | Disk usage of the Master's own machine |
| `/uploads/*` | `express.static` on the Master's disk (`master/src/http/app.ts:44`). Document assets deliberately do **not** use it (§6.3) |

---

## 11. Client wrappers

The only frontend work in this batch. Typed functions, no UI.

`master/web/src/api.ts` already has the shape they follow: a `request<T>` helper that reads
`body.details` into `ApiError.details` and exposes `missingPermission`, `storedVersion` and `diff` as
getters over it (`master/web/src/api.ts:40-95`). New wrappers add methods to the exported `api` object
and nothing else. `office/web/src/api.ts` follows its own `request<T>` at line 87.

Two rules for the new wrappers:

- **Branch on `code`, never on the message.** Every getter added to `ApiError` reads from `details`,
  which is the reason `details` is plumbed through the socket at all (§9.1).
- **A cursor is opaque to the client.** Wrappers pass `nextCursor` and `prevCursor` back verbatim and
  never parse, compare or synthesise one.

---

## 12. Open questions

Marked rather than answered, because each has a real cost either way.

**O-1 — Is `messageKey` required on `AppError`?** The affected surface is **129 throw sites across
`master/src`, and 0 in `office/src`** — the Office panel constructs no `AppError`; it re-raises what
the Master sent. State the master figure as "129 (126 by grep; `master/src/domain/conversion.ts`
contains a NUL byte so grep classifies the file binary and skips 4 sites — verify with `grep -a`),"
because the naive number is the one a reviewer will reproduce and be confused by.

The number of **hand-written message tokens is 68, not 129**: many sites share a token (the same
"not found for this company" wording is thrown from a dozen repositories), so the translation work is
roughly half what the throw-site count suggests. `05-EXISTING-CODE-CHANGES.md` carries the per-class
breakdown and is the authority on both figures.

Required is the only thing that makes an untranslated error impossible; optional leaves them possible
forever. `AppError`'s constructor signature is a dependency of every module in this batch, so this is
answered before anything is built. `docs/BACKEND_MODULES.md` §4.4 recommends **required**, with
`message` derived from the EN catalogue so existing tests asserting on English text keep passing
byte-identical.

**O-2 — How do large CSV and PDF payloads reach the Office?** `masterConnection.command` has a
15-second timeout (`office/src/realtime/master-connection.ts:238-246`) and buffers the whole ack value
on both sides. A 250,000-row CSV is tens of megabytes in one message. Three options: cap the
Office-side export far lower and say so in the UI, chunk it cursor-wise and reassemble in the Office
server before streaming to its own browser, or declare export Master-only. **This must be answered
before the four export/binary rows in §10.2 ship.** Nothing else in the batch depends on it.

**O-3 — DECIDED.** *Does the Recycle Bin's `document_template` branch land with the PDF Designer, or
is the branch stubbed earlier?* It lands with the PDF Designer, at **Stage 6**.
`RECYCLE_BIN_ENTITIES` **grows across stages** rather than shipping frozen at nine: six at Stage 2,
eight at Stage 3, nine at Stage 6 (§4.1). Each addition is a normal `shared` rebuild, which is a
build-order fact rather than an obstacle. The consequence to hold on to is that a gate asserting an
eight- or nine-branch `UNION ALL` belongs to the stage where that many branches exist — this is now
the answer to "why is this list six and not nine", which a reviewer at Stage 2 will ask.

**O-4 — What does a mid-stream CSV failure look like?** `GET /api/logs/export` and
`GET /api/reports/:report/export` stream. Once the first byte is written the error envelope is
unavailable, so a failure at row 180,000 is a truncated file that looks complete. Either the CSV
carries a completion sentinel the client checks, or the download is left to fail visibly. **Still
open**, and promoted to `README.md` §8 and `11-BUILD-SEQUENCE.md` §2 so it is not decided by whoever
happens to write the streamer.

**O-5 — What does the renderer do when the Devanagari face has no glyph?** §6 makes Devanagari a hard
requirement, and the vendored SIL OFL face covers ordinary Hindi. It does not cover every conjunct a
party name might carry, and PDFKit's silent behaviour for a missing glyph is a blank box in a document
that may be sent to a customer. The choices are a declared fallback chain, a pre-render glyph-coverage
check that refuses with a 400 naming the character, or accepting the box. **Open**; promoted to
`README.md` §8.

**O-6 — Should the Logs screen also surface `timeline_entries`?** `activity_log` is the hash-chained
audit trail; `timeline_entries` (`20260302:214-225`) is the per-record narrative a user writes and
reads on a lead or an order. They answer different questions and only one of them is tamper-evident,
which argues for keeping them apart — but "show me everything that happened to this order" is a
question a person asks once and gets half an answer to. **Open**; promoted to `README.md` §8. Nothing
in this batch depends on it: adding a second source later is a new endpoint, not a change to
`ActivityLogEntry`.

---

## Appendix — new permission keys

**`08-PERMISSIONS.md` is the authority for permission keys, tiers and the grant-migration algorithm.**
This appendix is a wire-side index — which endpoint in this document first enforces each key — and
where the two differ, `08` wins.

Eleven, all added to `shared/src/domain/permissions.ts`, all granted to `tier = 'admin'` only by the
single grant migration `20260309000000`, union-not-replace, key strings **inlined and frozen**. Every
other role receives them through the permission grid, by an administrator who chooses them.

| Key | Kind | Tier | First enforcement site |
|---|---|---|---|
| `logs.view` | module action (new `logs` module) | office | §2.2, §2.3 |
| `logs.export` | module action | office | §2.5 |
| `logs.verifyChain` | capability, `admin` group | office | §2.4 |
| `recycleBin.view` | capability | office | §4.3 |
| `recycleBin.viewAll` | capability | management | §4.2 |
| `fields.view` | capability | office | §5.2 |
| `documents.view` | module action (new `documents` module) | office | §6.2 |
| `documents.create` | module action | office | §6.2 |
| `documents.edit` | module action | office | §6.2, §6.3 |
| `documents.delete` | module action | management | §6.2 |
| `documents.render` | capability, `workflow` group | office | §6.4 |

**Reused, not minted** — nine existing keys, seven of which enforce nothing anywhere today:
`reports.view`, `reports.export` (§3), `field.saleRate.view` (§1.5, §3, §6), `leads.delete`,
`orders.delete`, `parties.delete`, `products.delete` (§4.5), `roles.delete`, `users.manage` (§4.4).

**Changed:** `fields.manage`, `MINIMUM_TIER` lowered `admin` → `management`
(`shared/src/domain/permissions.ts:163`, §5).
