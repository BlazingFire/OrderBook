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
| 3 | Reports — 6 endpoints (1.3 H2 added `/options` and `/table/:report`; §3.7–§3.9) |
| 4 | Recycle Bin — 3 endpoints + 4 DELETE routes |
| 5 | Fields — 17 endpoints (3 existing reads deliberately untouched) |
| 6 | PDF Designer — 13 endpoints |
| 7 | Dashboard — `GET /api/dashboard`, changed body |
| 8 | i18n — 3 changed endpoints |
| 9 | The Socket.IO surface |
| 10 | Office forwarding |
| 11 | Client wrappers |
| 12 | Open questions |
| 13 | Server Master, master key and the panel protocol (1.3 Phase 2) |
| 14 | Pending order numbers, presence and stale edits (1.3 Phase 4) |
| 17 | Party Access: list, summary and people (1.4.0) |
| 18 | Adding an Office panel: pairing, leaving, the window (1.4.1) |
| 23 | The product backup zip (2026-10-08) — 3 endpoints, Master users only |

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

Since 1.3 Phase 2, `app.use('/api/master-key', masterKeyRoutes)` sits directly after
`/api/setup` (§13.1). `master/src/http/app.ts` is the live list.

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
i18n contact point, and it is why an entry's wording can change with no schema
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
| **Columns** | `id,sequence,createdAt,actorType,actorName,entityType,entityId,action,hash,sentence,details`. The last two (1.3) are the rendered activity sentence and the entry's details as JSON, appended so a sheet built on the first nine still lines up |
| **Paging** | Internal batching, 5,000 rows per fetch. Capped at 250,000 rows or 128 MiB (`HTTP_EXPORT_LIMITS`). As in 1.2, past the row cap the file holds the newest 250,000 and stops; past the byte cap it stops at the last whole batch that fits. Neither refuses; the export's log entry records `truncated: true` when either cut in. The CSV is built in memory a batch at a time against a running byte count, not streamed (the deviation is noted on `exportLogs`) |
| **Office path** | `log:export` over the socket, answered in one ack. Capped at 250,000 rows or 45 MiB (`SOCKET_EXPORT_LIMITS`), the smaller byte cap because the ack is JSON (up to twice the file) and must stay under the ws client's 100 MiB frame limit |
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
the dispatched order's `line_items` (`SUM(quantity)`, with the line's colour). *(Changed in 1.4:
they used to come from `stock_movements`, which is retired.)*

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
| **Permission** | `reports.view` **and** `reports.export` (a file is a report written down; `reports.view` is checked first) — and Reports must not be switched off for the caller's tier (§3.9). New kinds' CSV carries a UTF-8 BOM; the three legacy kinds' CSV bytes are unchanged. The audit row records `subjectId` (null: everyone) |
| **Path param** | `:report` — any of the fifteen `ReportKind`s (§3.8), validated against `REPORT_KINDS` |
| **Query** | The `ReportQuery` of §3.8 (`period`, `fromMonth`, `toMonth`, `fromDate`, `toDate`, `subjectId`, `limit`) plus `format` = `csv` (default) \| `xlsx` \| `pdf`, `columns`, `totals`, `paperSize`, `orientation` |
| **Response** | `200` — `text/csv; charset=utf-8` for a CSV, the workbook's or the PDF's own type otherwise; `Content-Disposition: attachment`. Over the Office's socket the ack is a union: `{ format: 'csv', csv }` or `{ format: 'pdf' \| 'xlsx', fileName, contentType, bytes }` (it was CSV-only until 1.3; an Office older than that reads only the CSV arm) |
| **Caps** | 100,000 rows for CSV and Excel, 10,000 for PDF (`REPORT_EXPORT_CAPS`); more is a `ValidationError` `validation.reports.tooManyRows`, never a silent cut |
| **Streaming** | The workbook is written row by row and the PDF page by page, each yielding to the event loop, so the Master keeps answering its panels while a capped export is built |
| **Audit** | `recordActivity(entry, actor, trx)`, `report` / `exported`, with `{ report, from, to, rowCount, format }` |

There is no money anywhere in a report.

The three legacy kinds' CSV is **byte-identical** to every earlier release (`master/tests/report-tables.integration.test.ts`
pins the exact strings, and they pass against the pre-1.3 code too).

| Error | Status | `details` | Trigger |
|---|---|---|---|
| `ValidationError` | 400 | `{ field: 'report' }` | Unknown report name |
| `ValidationError` | 400 | `{ field: 'fromDate' \| 'toDate' \| 'subjectId' }` | A refused exact-dates range, or a subject that is not a live user |
| `ForbiddenError` | 403 | `{ permission: 'reports.view' }` | `error.forbidden.reportsHidden`, or `validation.reports.subject.forbidden` (§3.9) |
| *range errors* | 400 | as §3.2 | |

### 3.6a `GET /api/reports/:report/pdf` (1.3 H3, Preview PDF)

The same call as §3.6 with the format forced to `pdf` and the answer shown instead of saved.

| | |
|---|---|
| **Permission** | As §3.6: `reports.view` and `reports.export`, Reports not switched off for the tier, the same subject rule and Party Access, the same 10,000-row PDF cap and the same `report` / `exported` audit row |
| **Query** | As §3.6; `format` is ignored — whatever is asked, the answer is a PDF |
| **Response** | `200` `application/pdf`, `Content-Disposition: inline` (so a window or a tab displays it). The desktop shell opens only this exact shape in a window of its own (`docs/catalogue/CATALOGUE_MODEL.md` §8). Errors are §3.6's; an Office with the Master unreachable answers 503 |

The Office proxies it through the same `report:export` command, forced to `pdf`.

### 3.7 `GET /api/reports/options`

| | |
|---|---|
| **Permission** | `reports.view`, and Reports not switched off for the caller's tier |
| **Response** | `200 ReportOptions` — `{ kinds: ReportKind[]; subjects: Array<{ id, name }> \| null; canExport: boolean }` |

`subjects` is every live user for an administrator and `null` for anyone who may only see their own
figures; the Reports screen draws the "whose figures" picker only when it is not `null`. Over the
Office's socket this is `report:options`.

### 3.8 `GET /api/reports/table/:report`

| | |
|---|---|
| **Permission** | `reports.view`, and Reports not switched off for the caller's tier |
| **Path param** | `:report` — one of `REPORT_KINDS` |
| **Query** | `ReportQuery` — `period` (`thisMonth`, `last3Months`, `last6Months`, `last12Months`, `thisFinancialYear`, `custom`, `customDates`), `fromMonth` / `toMonth` (`custom`), `fromDate` / `toDate` inclusive (`customDates`, at most 366 days), `subjectId`, `limit` (the ranking kinds) |
| **Response** | `200 ReportTable` — `{ kind, range, subject, columns, rows, totals, rowCount, truncated, sections, quietAfterDays? }` |

Every kind answers the same shape, the three legacy ones included (their colours and cities arrive as
`sections`). `columns` carry a unit (`count`, `pieces`, `kg`, `days`, `percent`, `date`, `text`); `totals` sums
the `count`, `pieces` and `kg` columns over **every** row; `rows` is cut at 2,000 for the screen and
`truncated` says so (an export has the lot). Over the Office's socket this is `report:table`.

The kinds and what each counts — pieces are an order's `line_items.quantity`; kilograms are the order's own
weight (`COALESCE(override, computed)`) wherever the grain is an order, and `quantity × weight_kg` over the lines
that have a weight wherever the grain is a product (a line with no weight is left out, not counted as zero):

| Kind | Rows | Anchor |
|---|---|---|
| `dispatches`, `lead-outcomes`, `top-parties` | as §3.3–§3.5 | `dispatched_at`, `created_at`, `dispatched_at` |
| `by-user` | one per person: created, converted, lost, open, dispatched, pieces, kg | leads by `created_at`, orders by `dispatched_at` |
| `user-daily` | one per person per day | creation, conversion and dispatch day |
| `by-party` | one per party: leads, orders, pieces, kg, last order, days since | as `by-user`; the last order is the party's last ever |
| `party-dormant` | parties that ordered before the range and not in it, longest silent first | `dispatched_at` |
| `by-city`, `by-product`, `by-variant`, `by-brand` | orders, pieces, kg per city / category / variant code / brand (as each line snapshotted it) | `dispatched_at` |
| `stage-ageing`, `open-pending-orders` | a picture of now — **the range does not apply** | days since the stage was entered / the lead was raised |
| `lead-sources`, `conversion-time` | per source with the conversion rate / per month converted with average and longest days | `created_at` / `converted_at` |

### 3.9 Who may ask, and about whom

Decided in `report.service.ts` and nowhere else (`shared/src/domain/report-access.ts` states the rule for the
screens):

- `reports.view` (and `reports.export` as well, for a file), then the company switch for the caller's tier —
  `reports.visibleToOffice` / `reports.visibleToManagement`, both on unless switched off. An administrator is never
  switched off. A hidden report answers `403` `error.forbidden.reportsHidden`.
- **The Office and Management tiers see only their own figures.** Every query carries `owner_id = the caller`
  beside Party Access. A `subjectId` that is not the caller's is refused (`validation.reports.subject.forbidden`),
  never silently answered with their own; a caller with no signed-in user is refused rather than shown everyone's.
- **An administrator** may name any live user — another administrator included — or nobody, which is everyone.
- Migration `20261004000000_report_indexes_and_grants` gives `reports.view` and `reports.export` to every office
  and management role and adds the owner-by-date indexes the queries read through.

Since 1.3 the Office has the Reports module too; its server only forwards (`GET /api/reports/options`,
`/table/:report`, `/:report/export`, and the three legacy routes), online-only, answering 503 through
`failForward` while the Master is out of reach.

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
  /** Not every blocker is a Bin entity: a line item blocks a delete
   *  without ever being restorable itself. */
  entityType: RecycleBinEntityType | 'line_item';
  id: RecordId;
  label: string;
  reason:
    | 'parent_deleted'      // restore: the ancestor is still in the Bin
    | 'live_reference'      // delete: a live lead / order / line item points at it
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
| `DELETE /api/orders/:id` | `needs('orders.delete')` | same | Soft-deletes the order; no stock side since 1.4 |
| `DELETE /api/parties/:id` | `needs('parties.delete')` | same | — |
| `DELETE /api/products/:id` | `needs('products.delete')` | same | — |

#### When each route refuses with 409 — the per-entity policy

Each of the four has its own rule, and there is no shared "has children" test. Checked inside the
transaction, before anything is written:

| Entity | Refuses when | Otherwise |
|---|---|---|
| `party` | any **live** (not soft-deleted) lead or order references it | soft-deletes |
| `product` | any live `line_items` row references it | soft-deletes |
| `lead` | it has a `converted_order_id` — it is an order's history, not a record of its own any more | soft-deletes, cascading to its line items |
| `order` | it has been dispatched | soft-deletes |

Refusal is `ConflictError` 409 carrying `{ blockedBy: BinBlocker[] }`, naming the actual blocking
records rather than stating a count — "3 open orders" is a message a person cannot act on, and the
names are what let them go and deal with them.

Each rule earns its place separately. A party is refused because deleting one would leave live
records pointing at a tombstone. A product is refused on its lines (it used to be refused on stock too; stock was removed in 1.4).
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

### 4.6 Editing a pending order, and the form's view (2026-10-01, parity plan P3)

Both in `master/src/http/routes/data.routes.ts`, for the Master's own web client.

| Route | Guard | Does |
|---|---|---|
| `PUT /api/leads/:id` | `needs('leads.edit')` | `leadService.updateLead`. A body carrying `items` **replaces the whole line set** (absent leaves the lines alone); malformed `items` (not a non-empty list, a line with no `productId` or `variantId`) is a 400 `validation.lead.*`, never a 500; a converted lead is a 400 `validation.lead.convertedLocked`; party access at `manage` is required on the old and the new party. With `baseFieldHlc`, a field saved by somebody else since is a 409 `error.conflict.staleEdit` (§14.2). Answers the saved `Lead`. |
| `GET /api/lead-entry` | session; `leads.create` or `leads.edit` (else 403 naming `leads.create`) | `buildLeadEntryView` (`snapshot.service.ts`, beside `buildSnapshot`, which is untouched): `{ partyVariants, optionLists, partyGrants, features }`. `partyVariants` are party-scoped (a restricted party's records are absent); `partyGrants` is every grant the caller holds (the snapshot's list stops at its 500 parties); `products` is deliberately omitted. `owners` is added only for a caller holding `record.reassignOwner` (§14.3). Its own path so `GET /leads/:id` cannot capture it. |

### 4.7 The party screen's reads (2026-10-01, parity plan P5)

Additive fields on routes the Master's own web client calls; the hub's `party:*` / `partyVariant:list` handlers and the Office are unchanged.

| Route | Adds |
|---|---|
| `GET /api/parties/:id` | `myAccess`: the caller's own grant (`'view'` or `'manage'`), `null` when they hold none (an unassigned party is open; since 2026-10 a party made by a person without `party.accessAll` carries that person's own `manage` grant from birth, see section 21). Built from `grantsForUser`, so every user gets it, not only holders of `party.assign` / `party.accessAll`. |
| `GET /api/parties` | each row carries `recordCount` (the party's own product records) and `myAccess`, for the list's Products and My access columns. |
| `GET /api/parties/:id/variants` | each record carries `catalogueName`: the catalogue model's name, `null` when the product is deleted or the caller lacks `products.view`. |

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

**The usage count groups over two sources.** Since the 2026-09 variant
restructure the colour lives on `product_variants.label` and is frozen onto `line_items.variant_label`;
the count groups over those two. (It excluded the stock ledger; stock was removed in 1.4.)

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
through the two-letter ring fallback the design spec already defines — the five colour columns are not touched by this module at all.

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

### 5.6 The existing reads stay exactly as they are

`GET /api/pipelines` and `GET /api/option-lists` (`data.routes.ts`) remain gated by `requireAuth`
**only**. (`GET /api/custom-fields` was the third; nothing called it, so P7 removed it — custom-field
definitions reach the Office in the snapshot.) They now call `fieldsService` read
functions instead of repositories directly, but those particular exports do not check `fields.view`.

This is not an oversight. Those feed the Add Lead form and `buildSnapshot`'s `Promise.all`
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
from the Master at runtime: the catalogue is compiled into each panel's bundle before it ever
contacts one. One existing endpoint changes shape.

| Method | Path | Change | Permission |
|---|---|---|---|
| GET | `/api/access/permission-catalogue` | Payload gains a `labelToken` on each entry of the new `actions` array, alongside the module and capability tokens it already carries | **Unchanged**: `requireAuth` only. One of the two deliberately ungated handlers on `accessRoutes`, and `credential-invariants.test.ts:73-89` counts on it staying that way |

The server never renders a user-facing sentence. It returns a stable `messageKey` plus named params
and the client renders.

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
  | 'office_panel' | 'pipeline' | 'option_list'
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

Each forward-only route carries a comment in the same voice as the existing forward-only comments in
`office/src/http/app.ts`, saying *why* it is online-only rather than leaving it to be
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

### 10.2a The product-variant surface (2026-09)

Not part of the six modules above, but the same forwarding pattern, and the contract every screen
now assumes (the design is `docs/schema/02-parties-and-products.md` §*Product variants* and
`HANDOFF.md` Key decision 14):

| Master endpoint | Office route | Notes |
|---|---|---|
| `GET /api/pick/category?q=` | same, answered from the cached snapshot offline | The lead screen's first stage. `PickKind` is `'category' \| 'product' \| 'party'`; the tile-era `'variant'` kind is gone |
| `GET /api/pick/product?q=&categoryId=` | same | The second stage: models inside one category, matched on name, alias, barcode, brand and every variant's code and label; each row carries `variants[]` |
| `POST /api/pick/live-products` `{ids}` | Office forwards (`product:live`, protocol 10); `{live:null}` when the Master is off or too old | Which of the ids are still active and not deleted, tenant-scoped, `products.view`. The lead entry's save check: the Master refuses a whole order that names a deleted product, so the form blocks the save and keeps the draft (new orders, and lines added in an edit). `null` means "cannot tell": nothing is blocked |
| `GET /api/products?search=&categoryId=&missingWeight=true` | same | `ProductListPage.categories` is the facet, counted over the search without the category filter |
| `GET /api/categories?search=` | — | |
| `POST /api/products` · `PUT /api/products/:id` | queued | `ProductInput` carries `categoryId` or `categoryName` (one required on create), `hasVariants` and `variants: ProductVariantInput[]`; the set is validated by `validateProductVariants` on both the online and the offline-merge path, and replaced whole (`fieldHlc.variants` carries one stamp) |
| `GET /api/products/by-code/:code` | — | Resolves through the variant that holds the code |
| `/api/stock/*` | — | Removed in 1.4 (stock and inventory) |
| `POST /api/developer/load-catalogue` | — | Developer-unlocked; returns `LoadCatalogueResult { categories, products, variants, skipped }` |

Lead and order line bodies (`LineItemInput`) name a `productId`, a `variantId` and one `quantity`;
`quantities[]` is gone. `Lead` and `Order` carry `totalWeightKg` and `linesWithoutWeight`; every
line carries `variantId`, `variantLabel`, `quantity`, `lineWeightKg`. (Stock levels, reservations and
movements, and the `stock` change event, were removed in 1.4.)

Restoring a product from the Recycle Bin is refused with `validation.product.restoreCodesTaken`
(409, `details: { field: 'code', codes }`) while another live product holds one of its codes —
codes are never renamed on the way out of the bin the way party names are.

### 10.2b The catalogue v2 surface (2026-09-29)

Added for `docs/catalogue/CATALOGUE_MODEL.md` §5 and §8 — the owner's Brand → Product → Sub
product. In the wire's words a **Product** is a category and a **Sub product** a product (model).
Written from the code as it landed on the `catalogue-v2-port` worktree, not designed ahead of it:

| Master endpoint | Office route | Event | Notes |
|---|---|---|---|
| `GET /api/categories?search=&brand=` | same; **answered from the cached snapshot offline** (`listCategoriesFromView`) | `category:list` (`{ search?, brand? }` — the event gained a query argument) | `ProductCategoryListRow[]` — live categories only, `sort_order NULLS LAST, lower(name), id`, each with `subProductCount`; `search` matches name, code and brand. `products.view` |
| `POST /api/categories` | same, **online only** (503 offline) | `category:create` | `CategoryInput { name, code, brand?, sortOrder? }` → 201 `ProductCategory`. `products.create`. Name and code required; the code matches `CATEGORY_CODE_PATTERN` (`validation.category.codeInvalid`); a brand must be a live `product.brand` value (`validation.category.brandUnknown`); `sortOrder` a non-negative integer. 409 `error.conflict.categoryCodeTaken` / `categoryNameTaken` (per brand, live rows) |
| `PUT /api/categories/:id` | same, online only | `category:update` (`{ id, input }`) | `CategoryUpdateInput` (a partial patch) → `ProductCategory`. `products.edit`. Logs `changes: { field: { from, to } }`; a change of name, code or brand also publishes one `catalog` change, because every sub product in a panel's snapshot carries its category's name, code and brand |
| `DELETE /api/categories/:id` | same, online only | `category:delete` | → `{ id, deletedAt }`. `products.delete`. 409 `error.conflict.blockedByLiveReferences` with `details.blockedBy` naming each live sub product while any remains |
| `POST /api/recycle-bin/restore` | same | `recycleBin:restore` | `product_category` is a new `RECYCLE_BIN_ENTITIES` member (restore needs `products.delete`). A code taken meanwhile → 409 `categoryCodeTaken`; a name taken meanwhile → the usual `restoreCollision` with a suggested rename. A sub product cannot be restored into a category still in the Bin |
| `GET /api/leads/:id/pdf` | same, online only | `lead:pdf` → `{ fileName, bytes }` | `leads.export`. `application/pdf`, `Content-Disposition: inline; filename="lead-<id>.pdf"`. The lead is read through `getLead` (party scoping applies) after `resolveId`, so a panel may still name it by its temporary id. Fixed layout, no money (`LEAD_GENERATION_FLOW.md` §6) |
| `PUT /api/settings/:key` (existing, `settings.manage`) | `PUT /api/settings/:key` (new), online only | `settings:save` (`{ key, value }`) → `SettingView[]` | The Office may write **`leads.followUpDefaultDays` only**, and only as a signed-in person: `assertPanelSettingWrite` in `hub.ts` refuses the panel's own role actor (403) and any other key (400 `validation.setting.invalid`); `writeSetting` then checks `settings.manage` as usual |

Changed in place:

- **Picks.** `GET /api/pick/category` matches a code from its start, or the name or the brand
  anywhere; a code typed in full comes first, then catalogue order; only live categories holding a
  live sub product are offered. Rows are `ProductCategory` and so carry `code` and `brand`.
  `GET /api/pick/product?categoryId=` returns **every** live sub product of that category in
  `sort_order`, narrowed by a name substring or a code prefix and not re-ranked;
  `PICK_MAX_LIMIT` is 1000 (was 50). Without `categoryId` the whole-catalogue pick matches the
  search vector, a variant code prefix or a name prefix. Picked products carry `categoryCode` and
  `brand`.
- **Products.** `GET /api/products` takes `brand=` and its search also matches the category's code
  and brand; its page ceiling is 2000 (`PRODUCT_PAGING`), and the snapshot asks for products
  at that ceiling (every other collection stays at 500). `ProductInput` gains
  `categoryCode` (resolves a live category, never creates one —
  `validation.product.categoryCodeUnknown`), `categoryBrand` and `sortOrder`; a blank variant code
  on a product named by category id or code becomes the next `CODE-####`; a second live sub
  product of the same name in one category is 409 `validation.product.nameTaken`.
- **Stock.** Removed in 1.4 (stock and inventory); `GET /api/stock` no longer exists.
- **Lines.** `LineItem` and `LineItemInput` carry `categoryCode` and `brandName`. A `colour` on a
  line whose product is not multi-colour is **dropped**, no longer refused with
  `validation.lead.colourUnexpected`.
- **Developer.** `POST /api/developer/load-catalogue` loads the shipped Markdown catalogue
  additively and returns `LoadCatalogueResult { brands, colours, products, subProducts, skipped,
  removedLeads, removedOrders }` (the two `removed*` are zero here; they are the reload's).

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
| `/api/products/export.zip`, `/api/products/restore*` (§23) | The Office's `proxyDownload` buffers a whole download in memory, and a restore is minutes of photo encoding run as a Master job; the paired-panel surface (`/api/panel`) does not mount them |

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

**O-5 — Should the Logs screen also surface `timeline_entries`?** `activity_log` is the hash-chained
audit trail; `timeline_entries` (`20260302:214-225`) is the per-record narrative a user writes and
reads on a lead or an order. They answer different questions and only one of them is tamper-evident,
which argues for keeping them apart — but "show me everything that happened to this order" is a
question a person asks once and gets half an answer to. **Open**; promoted to `README.md` §8. Nothing
in this batch depends on it: adding a second source later is a new endpoint, not a change to
`ActivityLogEntry`.

---

## 13. Server Master, master key and the panel protocol (1.3 Phase 2)

The Server Master tier ranks above `admin` and signs in only on the Master PC. The master key
(`docs/MASTER_KEY.md`) gates the operations that could lock the owner out. "Master PC only" below
means `requireLoopback`: any other caller gets 403 `error.forbidden.masterPcOnly`.

### 13.1 `/api/master-key/*`, Master PC only, no session needed

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/api/master-key/verify` | `{ key }` | 201 `{ token, expiresAt }`. Wrong key 401 `error.unauthorized.masterKey`; five wrong in a row lock the gate for 60 s (429 with `seconds`). Attempts are checked one at a time. Both outcomes are logged, as the signed-in user or as the Master PC |
| POST | `/api/master-key/lock` | — (token in the header) | 200 `{ ok: true }` |
| GET | `/api/master-key/server-masters` | — | `{ accounts: [{ id, username, displayName, isActive }], needed }` |
| POST | `/api/master-key/server-masters` | `{ accounts: [{ username, displayName, password }] }` | 201 `{ accounts }`. Exactly `needed` accounts, else 400 `validation.serverMaster.accountCount`; 409 `error.conflict.serverMastersComplete` once two are active |
| POST | `/api/master-key/recover` | `{ userId, newPassword }` | 204. Resets a Server Master's password, lifts that username's sign-in lockout and ends its sessions |

Every route but `verify` reads the token from the **`x-master-key-token`** header
(`MASTER_KEY_TOKEN_HEADER`). A missing or expired token is 401 `error.unauthorized.masterKeyRequired`.

### 13.2 Setup routes

| Method | Path | Change |
|---|---|---|
| GET | `/api/setup/status` | Adds `onMasterPc` (the caller is on loopback) and `serverMasterSetupNeeded` (fewer than two active Server Masters) |
| POST | `/api/setup/initialize` | Master PC only. Body `{ companyName, accounts }`, two Server Master accounts; no `admin` is created |
| POST | `/api/setup/restore/preview`, `/api/setup/restore` | Master PC only, checked before the upload is read, and 409 `error.conflict.alreadySetUp` once setup has run. A restore re-creates the Server Master role when the backup has none |
| POST | `/api/setup/pairing-password` | New. Master PC only, a signed-in Server Master, master-key header. Answers `{ pairingPassword }`, shown once. Anyone else 403 `error.forbidden.serverMasterOnly` |

### 13.3 Users and sign-in

- `POST /api/access/users`, `PUT` and `DELETE /api/access/users/:id`,
  `POST /api/access/users/:id/reset-password` and `POST /api/access/me/password` pass the
  `x-master-key-token` header through. The service decides whether a change needs it (creating a
  Server Master, changing one's username, active state, role or password, moving someone onto the
  role); without a live token it is 401 `error.unauthorized.masterKeyRequired`. A display-name or
  avatar change does not need it.
- An admin acting on a Server Master gets 403 `error.forbidden.serverMasterTarget`, for every user
  action including password reveal.
- A Server Master signing in anywhere but the Master PC gets 401
  `error.unauthorized.serverMasterMasterPcOnly`, only after the password checks out, so the code is
  no oracle. Their sessions resolve only from loopback.

### 13.4 The panel protocol

- `PANEL_PROTOCOL_VERSION` (`shared/src/protocol/socket.ts`, now 5 with the Chatroom, section 15) rises by one in each release
  that adds a socket command. An absent value on either side means 1.
- The Office handshake `auth` payload adds `protocol` and `appVersion`. Snapshots and deltas add the
  Master's `protocol`.
- `COMMAND_MIN_PROTOCOL` names the lowest Master protocol a command needs. The Office refuses a
  command its Master is too old for at once, without sending it, and its HTTP layer answers
  **426** `error.updateNeeded.master`.
- `auth:offlineEvents` (protocol 2): `OfflineAuthEvent[]` → `{ recorded }`. The sign-ins an Office
  checked offline, oldest first, at most 500 per call (more is 400
  `validation.offlineEvents.tooMany`). A malformed entry or a username over 100 characters is
  skipped. The Master files them under the panel's device code; the Office drops them only on the ack.
- `report:table` and `report:options` (protocol 2, the reports of 1.3 H2): `{ report, query }` →
  `ReportTable`, and nothing → `ReportOptions`. An Office on a protocol-1 Master answers 426 for
  `GET /api/reports/options` and `GET /api/reports/table/:report` without asking it.
- `notification:list` (protocol 3): `{ limit?, before? }` → `{ items: UserNotification[], unreadCount }`
  for the acting person; none with nobody signed in. `notification:markRead` (protocol 3):
  `{ ids? } | { all: true }` → `{ unreadCount }`.
- `notification:new` (Master → panel, protocol 3): a `UserNotification` plus `forUserId`. Sent only
  to sockets acting as that person; the Office drops it if someone else is signed in by then.
- `GET /api/notifications?limit=&before=` and `POST /api/notifications/read` `{ ids? } | { all: true }`
  (Master, 1.3 Phase 3): the same two answers for the signed-in person over REST, `requireAuth` only.
  Newest first, `limit` 1–100 (default 50); `before` is the `createdAt` of the last row seen, 400
  `validation.cursor.malformed` when it is not a date. Ids that are not the person's own match nothing.
  Read notices older than 60 days, and anything past a person's newest 500, are pruned every six hours.
- The handshake also carries `actingUserToken` (1.3 Phase 3). The Master acts as that person from
  the first snapshot, and a following `auth:assume` with the same token sends no second snapshot.
- A refused handshake's `connect_error` carries `data: { code, messageKey }`. `panelRevoked` (the
  pairing was revoked; `data.masterUniqueId` names this Master, and the Office forgets its credentials
  only when that matches the Master it paired with), `panelNotPaired` (this Master has no such active
  panel: keep them, the address may be wrong), `panelCredentialsInvalid`, and `maintenance` (the
  Master failed rather than refused: retry). socket.io-client does not retry a refused handshake on
  its own, so the Office retries with its own backoff (5 s doubling to 60 s).
- `POST /api/panel/prove` `{ panelId, nonce }`, no credentials (1.3 Phase 3): `{ proof }`, the
  HMAC-SHA256 of `nonce|host:port` keyed by the panel's proof key (`MASTER_PROOF_CONTEXT` and
  `masterProofMessage` in `shared/src/protocol/discovery.ts`). The Master uses the address and port
  the request arrived at, the Office the ones it contacted, so a device relaying the nonce to the real
  Master gets an answer that does not match its own address. The Office reads at most 1 KB of the
  answer and refuses redirects. 404 for an unknown, revoked or not-yet-keyed panel, 400 for a
  malformed nonce, 429 past 30 a minute from one address.
- Office side (1.3 Phase 3). `GET /api/notifications` and `POST /api/notifications/read` forward to
  the two commands above (503 offline, 426 for a Master older than protocol 3). The SSE stream gains
  a `notification` event, sent only while the person signed in is the one in `forUserId`; anything
  else is dropped (`broadcastForUser` in `office/src/http/app.ts`). The SSE `status` frame,
  `GET /api/connection` and `GET /api/sync` gain `masterProtocol`, `disconnectedSince`, `catchingUp`,
  `hasNetworkLink`, `clockSkewMs` (this PC minus the Master), `rediscoveredFrom`, `notRecognised` and
  `rediscoveryRefused` (an address that answered as this Master but failed the proof or was one of two
  claiming it; cleared on connect).
  `POST /api/sync/flush` also retries the Master at once when the link is down.
- Rediscovery. After three failed connects in a row (at most once a minute, only with a network
  link) the Office looks for its `masterUniqueId` over UDP. A reply from one address only is then
  asked to prove itself at `/api/panel/prove` before the panel secret is sent there, and the new
  address is saved only after a connection there authenticates.

## 14. Pending order numbers, presence and stale edits (1.3 Phase 4)

Protocol 4. The design is `docs/LEAD_GENERATION_FLOW.md` §4 and §7.

### 14.1 Pending order numbers on the wire

- `Lead.poNumber?` and `Order.poNumber?` (`string | null`): `PO/<fy>/<seq>`, matching
  `PO_NUMBER_PATTERN`. An order's is its lead's, read through the join; an order with no lead has
  none. Optional, so a pre-1.3 Master's payloads still parse; a client shows the id instead
  (`recordNumber`).
- `POST /api/leads` on the Master answers the `Lead` with its `poNumber` (no shape change).
- `MutationResult.number?`: the PO number an applied `lead.create` was given. Stored with the
  applied mutation, so a duplicate replay answers the same number.
- `GET /api/leads/:id/pdf` names its file `pending-order-PO-2026-27-00042.pdf` (slashes replaced);
  the URL is unchanged. Search hits for lead and order lines carry the number as their subtitle.
- Activity details: a lead or order `created` carries `poNumber`; `deleted`, `restored` and the
  lead's `converted` carry `number` (the PO number, or the id when there is none). The Logs screen
  shows that number in place of the id.
- Notification kind `lead.numbered` (to the lead's author, when the save reached the Master more
  than 60 s after it was made): params `{ number, party }`, link `{ kind: 'lead', id }`, dedupe
  `lead.numbered:<id>`. `NotificationLink.kind` is now `'panel' | 'lead'`; opening one opens the
  lead on either panel.

### 14.2 Stale-edit protection

- `PUT /api/leads/:id` and `PUT /api/orders/:id` accept `baseFieldHlc` (`Record<field, hlc>`): the
  field clocks the editor opened the record at. A field in the body whose stored clock differs from
  its base answers **409** `error.conflict.staleEdit` with `details: { stale: string[], fieldHlc }`
  (the clocks the Master holds now), and nothing is written. The check runs under the row lock.
  Without `baseFieldHlc`, or with a malformed one, the edit applies as before.
- Clients send only the fields that changed since the record was opened, and `items` only when the
  lines really changed (`sameLines`, now in `shared/src/sync/merge.ts`). "Keep mine" sends again
  with `details.fieldHlc` as the base.
- Office: the queued `PUT`s take `baseFieldHlc` out of the payload (only string clocks are kept)
  and send it as the mutation's `baseFieldHlc`, so the Master's merge records a conflict instead of
  overwriting. This applies to every queued `PUT` (leads, orders, parties, products).
- `DataChangedEvent.actorUserId?` / `actorName?` name who made a lead or order change, for the
  "Ravi saved this at 10:42" notice.

### 14.3 Owner picker

`GET /api/lead-entry` adds `owners?: AssignablePerson[]` (active, undeleted users, by display
name) only when the caller holds `record.reassignOwner`. The Master's form shows an Owner picker
only when it is there and sends `ownerId` on create (or on edit when it changed). A Server Master
holds every permission, so it may raise a pending order for any user and delete any user's; both
are logged under the Server Master.

### 14.4 Presence

Held in the Master's memory only: never stored, logged or put in the change ring. Types are in
`shared/src/protocol/presence.ts`.

- `PresenceBeat { tabId, recordKind?, recordId?, editing? }`. `tabId` matches
  `[A-Za-z0-9_-]{1,64}`, `recordKind` is `lead` or `order`, `recordId` is at most 40 characters.
  Leaving out `recordKind` and `recordId` means the tab left. Who is beating is never in the body.
- `RecordPresence { recordKind, recordId, entries: PresenceEntry[], lastWrite? }`, where
  `PresenceEntry { userId, displayName, avatar, tier, editing, since }` merges every tab of one
  person (editing if any tab is), and `lastWrite { userId, displayName, at, action }` rides only on
  the push that follows a save or delete.
- Every beat (every `PRESENCE_BEAT_MS` = 10 s while a record screen is showing) re-reads the record
  as the caller, so `leads.view` / `orders.view` and party scope apply; a record they may not see
  answers 404 or 403 and takes the tab off. A tab that stops beating drops off after
  `PRESENCE_TTL_MS` = 30 s. A provisional record (a temporary id) is never beaten.
- **Master REST** `POST /api/presence` (session): body `PresenceBeat`, answers `RecordPresence`
  (or `null` for a leave). 400 `validation.presence.invalid` for a bad shape. The key is
  `admin:<userId>:<tabId>`.
- **`AdminAuthPayload.tabId?`**: a Master browser tab sends the same tab id in its socket
  handshake, so closing the tab takes it off at once.
- **C→S `presence:beat`** (protocol 4): `(beat, ack: CommandAck<RecordPresence | null>)`. Keyed
  `panel:<panelId>:<tabId>`; refused with nobody signed in. A panel's entries go when its socket
  disconnects or its acting person changes.
- **S→C `presence:changed`**: `RecordPresence & { forUserId }`, debounced 100 ms per record, sent
  only to the people on that record who may still see it (`mayReceive` and party grants). The
  Office drops it unless `forUserId` is the person signed in there.
- **Board feed (1.4 R22, protocol 7).** `BoardPresence { recordKind, records: Record<recordId, PresenceEntry[]> }`
  is who is on every card of the Pending (`lead`) or Final (`order`) board, limited to records the
  reader may read (the module permission and Party Access, by `mayReceive`). **C→S `presence:board`**
  `(kind, ack: CommandAck<BoardPresence>)`; **S→C `presence:board`** `BoardPresence & { forUserId }`,
  the whole board, at most one per board per 500 ms, only to an Office at protocol 7 or more.
  **Master REST** `GET /api/presence/board?kind=` (400 `validation.presence.invalid` for any other
  kind); **Office REST** `GET /api/presence/board?kind=` forwards it; the Office SSE frame is
  `presenceBoard`. Tabs that stop beating are swept every `PRESENCE_BEAT_MS`, so a crashed browser's
  face leaves the board. An older Office is simply never sent the event.
- **Office REST** `POST /api/presence` (`requireUser`): forwards `presence:beat` with the body cut
  down to the fields above; 503 offline, 426 for a Master older than protocol 4. The SSE stream
  gains a `presence` event (only for the person signed in).

### 14.5 The Office's new pending order save

`POST /api/leads` still queues the lead and answers **202**
`{ queued, id, mutationId, pendingCount }`, now with:

- `status: 'numbered'`, `permanentId` and `poNumber` (absent from a pre-1.3 Master) when the link
  was up and the push carrying it answered within `OFFICE_SAVE_NUMBER_WAIT_MS` (5 s);
- `status: 'provisional'` when the Master was out of reach or slower than that; the lead is safe in
  the outbox and is shown as Provisional;
- `status: 'rejected'` and `error` when the Master refused the lead.

The SSE stream gains a `numbered` event `{ entity: 'lead', temporaryId, permanentId, poNumber?,
announced }` for every lead whose temporary id was replaced; `announced` is true when a waiting
save already named the number. The `lead:create` socket command is not used for saves.
## 15. The Chatroom (1.3 Phase 6)

Text-only chat. It is **outside the change ring and the activity chain**: nothing here publishes
a `data:changed`, and only governance is audited (§15.5). The shapes are in
`shared/src/domain/chat.ts`; the code in `master/src/services/chat.service.ts`.

### 15.1 Permissions

Six keys in the `chat` capability group. `chat.use` is the switch: without it the Chatroom is
absent from both panels and every route below answers 403 naming it. The finer keys are checked by
the service, because each depends on the body or the room.

| Key | Tier ceiling | Gates |
|---|---|---|
| `chat.use` | office | the room list, reading and posting in rooms you are in, editing or deleting your own message within five minutes, ticking tasks given to you, mute, leave, search |
| `chat.directMessages` | office | starting a direct chat (`POST /direct`) |
| `chat.shareRecords` | office | a post carrying record chips |
| `chat.tasks` | office | a post that is a task |
| `chat.createGroups` | management | creating a group (the creator becomes its admin) |
| `chat.manage` | admin | listing and administering every group (members, announcement mode, archive, pins, removing someone else's message) without being its admin. Reading a group's messages still needs membership; adding oneself is audited |

Migration `20261005000000_chatroom` gives all six to every `admin` and `server_master` role and
`chat.use` + `chat.shareRecords` to every `office` and `management` role (union, idempotent, no tenant
or `deleted_at` filter). A role created later holds none until an administrator ticks them.
The Sales role template offers `chat.use`, `.directMessages`, `.shareRecords` and `.tasks`; Dispatch
offers `chat.use`.

### 15.2 Master REST, `/api/chat` (every route `requireAuth` + `needs('chat.use')`)

Mounted before `dataRoutes`. A non-member is told the room or message does not exist (404), never
that it exists and is closed to them.

| Route | Body / query | Answer |
|---|---|---|
| `GET /people` | | `ChatPerson[]`: active people holding `chat.use` |
| `GET /rooms?all=&archived=` | `all=1` needs `chat.manage` and lists every group | `ChatRoomSummary[]`, newest activity first, with `unread` and `mentionUnread` |
| `POST /rooms` | `ChatRoomInput {name, description?, announceOnly?, memberIds?}` | 201 `ChatRoomSummary`. 409 `error.conflict.chatRoomName` for a live group of that name |
| `GET /rooms/:id` | | `ChatRoomDetail` (members with `lastReadSeq`, pinned messages) |
| `PUT /rooms/:id` | `ChatRoomPatch {name?, description?, announceOnly?, archived?}` | `ChatRoomSummary`; room admins and `chat.manage` |
| `POST /rooms/:id/members` | `{userId, role: 'admin' \| 'member' \| null}` | `ChatRoomDetail`, or `null` when the caller just left; `null` removes, anyone may remove themselves |
| `GET /rooms/:id/messages?before=&limit=` | `before` is a `seq`; `limit` 1-100, default 50 | `ChatMessage[]`, oldest first |
| `POST /rooms/:id/messages` | `ChatPostInput {body, refs?, mentions?, task?, clientId?}` | 201 `ChatMessage` |
| `POST /rooms/:id/read` | `{seq}` | `{lastReadSeq}`; never past the room's last message, never backwards |
| `POST /rooms/:id/mute` | `{muted}` | `null` |
| `POST /direct` | `{userId}` | `ChatRoomSummary`; find-or-create, either side finds the same room |
| `PUT /messages/:id` | `{body, mentions?}` | `ChatMessage`; own message within five minutes (database clock) |
| `DELETE /messages/:id` | | `ChatMessage` (a tombstone); own within five minutes, or a room admin / `chat.manage` at any time |
| `POST /messages/:id/pin` | `{pinned}` | `ChatMessage`; room admins and `chat.manage` |
| `POST /messages/:id/done` | `{done}` | `ChatMessage`; an assignee, the author, a room admin or `chat.manage` |
| `GET /search?q=&roomId=` | `q` at least two characters | `ChatSearchHit[]`, newest 50, only rooms the caller is in, never a deleted message |
| `GET /tasks?scope=mine\|created&includeDone=` | | `ChatTaskRow[]` |
| `POST /access-requests` | `{capability, note?}` | `{notified}`. `capability` is one of `chat.directMessages`, `chat.shareRecords`, `chat.tasks`, `chat.createGroups`; tells everyone holding `roles.edit`, one unread request per person and right |

Limits (`CHAT_LIMITS`): body 4,000 characters, 5 record chips, 20 mentions, group name 60,
description 280. Refusals are `validation.chat.*` keys (`bodyRequired`, `bodyTooLong`, `tooManyRefs`,
`refNotFound`, `assigneeRequired`, `dueInvalid`, `roomArchived`, `announceOnly`, `assigneeNotMember`,
`editWindow`, `notTask`, `notPinnable`, `nameRequired`, `nameTooLong`, `descriptionTooLong`,
`notMember`, `directSelf`, `capabilityUnknown`, `wrongAuthor`).

**Record chips store only `{kind: 'lead' | 'order', id}`.** The sender must be able to open each
record (`getLead` / `getOrder` with the sender's party scope; a temporary id is resolved through
`id_map`) or the post is refused `validation.chat.refNotFound`. On every read the chip is resolved
for the person looking: `{label, partyName, restricted: false}` when they may open it, otherwise
`{label: null, partyName: null, restricted: true}`, so a room never learns which party a restricted
record belongs to. The label is `recordNumber(record)`: the PO number, or the record id when there is none.

### 15.3 Socket commands (Office to Master), protocol 5

Seventeen, twinned with the routes above and forwarded by the Office at the same paths:
`chat:people`, `chat:rooms`, `chat:room`, `chat:messages`, `chat:search`, `chat:tasks`,
`chat:roomCreate`, `chat:roomUpdate`, `chat:memberSet`, `chat:direct`, `chat:edit`, `chat:delete`,
`chat:pin`, `chat:taskDone`, `chat:read`, `chat:mute`, `chat:requestAccess`. All sit in
`COMMAND_MIN_PROTOCOL` at `CHAT_MIN_PROTOCOL` (5); an Office on an older Master answers 426
`error.updateNeeded.master`. **There is no `chat:post`.** An Office posts through `sync:push`.

### 15.4 The `chat.post` mutation and the held-post rule

`MUTATION_KINDS += 'chat.post'` (entity `chat_message`, id prefix `CM`, permission `chat.use`),
payload `{roomId, body, refs?, mentions?, task?}`. The Master's `route()` calls `postMessage` with
`clientId` set to the mutation id, so a resend returns the message it already made, and maps the
temporary id to the `CM` id.

A post speaks for one person:

- **Office.** `office/src/sync/sync.service.ts` holds a `chat.post` back unless its `actorUserId`
  is the person signed in now (`setActingUser`, set by the sign-in module). A held post waits in the
  outbox for its author, never goes up under the panel's own role or another person's session, and
  never stands in front of lead and order work. Only held posts left: no push and no retry timer.
  Signing in flushes. `GET /api/chat/rooms/:id/messages` appends this person's own still-queued
  posts for that room as `{pending: true, clientId: mutationId}` (never anyone else's), and on a lost
  link answers 503 with them in `details.pending`.
- **Master.** `applyOne` rejects, and records, a `chat.post` whose `actorUserId` is not the pushing
  actor's `userId` (`validation.chat.wrongAuthor`), and leaves it out of the batch-wide 503 that a
  person's work under a panel role otherwise earns.

### 15.5 Live updates and audit

`chat.service` publishes `{tenantId, userIds, push}` on the change bus's own `chat` channel
(`publishChat` / `onChat`, never the ring). `hub.ts` sends `chat:event` through `emitToActors`
to sockets whose current actor is one of `userIds` and holds `chat.use`, skipping an Office older
than protocol 5. A `message` push is resolved again for each recipient (`personalisePush`), so two
members of one room can see the same chip differently. `ChatPush` is one of:

- `{kind: 'message', roomId, message}`: new, edited, deleted, pinned or ticked;
- `{kind: 'room', roomId}`: the viewer reads the room again;
- `{kind: 'read', roomId, userId, seq}`: a member's read position (task receipts).

The Office relays it as SSE event `chat` through `broadcastForUser`; a person who is not the one
`forUserId` names gets nothing. SSE has no replay, so both web apps read again on every reconnect.

Audited through `recordActivity`, in the write's own transaction: `chat_room` `created`,
`updated`, `archived`, `restored`, `member_added`, `member_removed`, `role_changed`, and
`chat_message` `removed` (someone else's), `pinned`, `unpinned`. Posts, own edits and deletes, reads,
mutes and task ticks are not.

Notifications (after commit, `notify()`): `chat.mention` (also into a muted room), `task.assigned`
(not into a muted room), `task.done` (to the task's author), and `access.requested` (to every holder of
`roles.edit`). Their links are `{kind: 'chat', id, messageId?}` and `{kind: 'role', id}`.

---

## 16. The Printroom (1.3 Phase 7)

A shared print queue and an auto-print station. Anybody holding `print.send` can queue a pending or a
final order's Filling note or Dispatch note; the PC with the printer (a holder of `print.station`) prints
it. Like the Chatroom it is **outside the change ring and the activity chain** (§16.6 says what is
audited). The shapes are in `shared/src/domain/printroom.ts`; the code in
`master/src/services/print.service.ts` and `master/src/repositories/print.repository.ts`; the design in
`docs/ORDER_NOTES_PLAN.md` section 11.

### 16.1 Permissions

| Key | Tier ceiling | Gates |
|---|---|---|
| `print.send` | office | sending a note (`POST /print-jobs`), listing, reading and cancelling **your own** jobs, listing the printrooms to aim at |
| `print.station` | office | **every** job whatever its party (see below), claiming, marking printed and not printed, cancelling any queued job, registering this PC as a station (`PUT /print-stations/self`) |

Sending also needs the note's own export right, checked by the service: `leads.export` for a pending
order, `orders.export` for a final order. The sender's own view decides whether they may print the record
at all: the service reads it through `getLead` / `getOrder`, so Party Access applies and a record they
cannot see is a 404.

**`print.station` is a deliberate cross-party grant.** The sender addressed the printroom, not a person,
so the PC that prints sees and prints every job whatever party it is for and whether or not that PC's
user holds `party.accessAll`. The permission label says so, and `docs/ROLES_AND_USERS.md` tells
administrators to grant it knowingly. An unattended printer PC needs a person signed in on it (the
station runner lives in the signed-in UI and the Master addresses pushes to a person); grant
`print.station` to the role of the user who stays signed in there.

Migration `20261006000000_printroom` unions both keys into every `admin` and `server_master` role (frozen
list, idempotent, no tenant or `deleted_at` filter). Office and management roles get them when an
administrator ticks them. The Sales template offers `print.send`; Dispatch offers both.

### 16.2 Master REST (`requireAuth`; mounted before `dataRoutes`)

| Route | Guard | Body / query | Answer |
|---|---|---|---|
| `GET /api/print-jobs?status=&mine=&cursor=&limit=` | service: `print.send` (own) or `print.station` (all) | `status` is `waiting` (queued and printing, oldest first), `printed`, `cancelled` or `all` (newest first); `mine=1` limits a station holder to their own | `PrintJobPage {jobs, nextCursor, waitingCount}`; no sheet in a list |
| `POST /api/print-jobs` | `needs('print.send')` | `PrintJobInput {requestId, kind, source, sourceId, copies, targetStationId?, vehicleNumber?, note?}` | 201 `PrintJob` (with its `document`). A retried `requestId` returns the job already made |
| `GET /api/print-jobs/:id` | service: own job, or `print.station` | | `PrintJob`; 404 for a job that is not yours to see |
| `POST /api/print-jobs/:id/printed` | `needs('print.station')` | `{printed, printerName?}` | `PrintJobSummary`. `printed: false` puts a printed job back in the queue (and gives a failed claim back) |
| `POST /api/print-jobs/:id/cancel` | service: own queued job, or any for `print.station` | | `PrintJobSummary`; 400 `validation.print.notQueued` once a station holds it |
| `GET /api/print-stations` | service: either key | | `PrintStation[]` with `online` (heard from within 90 s) and `isSelf` |
| `PUT /api/print-stations/self` | `needs('print.station')` | `PrintStationInput {displayName?, printerName, autoPrint}` | `PrintStation`. 403 `validation.print.stationNeedsDesktop` unless the request comes from the Master PC itself |

There is **no REST claim**: a claim belongs to a connection (§16.4). The Master PC's own window claims
with the `print:claim` event on its own socket.

**The station key is never read from a body.** On the Master PC it is `master` (`isOnMasterPc`: loopback
address and a `Host` / `Origin` that name this PC); for an Office it is `panel:<panel id>` from the
panel's socket. A browser on any other PC has none and cannot be a station.

`kind` is `filling` or `dispatch`; `source` is `lead` or `order`; `sourceId` may be a temporary id (the
Master resolves it through `id_map`). `copies` is a whole number 1 to 50 (never rounded, a refusal is
`validation.print.copies`); the vehicle number is cleaned as everywhere (`cleanVehicleNumber`), kept
only for a Dispatch note, and a final order falls back to its own saved one; `note` is at most 200
characters. `requestId` is 32 hex characters made by the sender with `crypto.getRandomValues`
(`randomUUID` is absent on a plain-http LAN origin) and is unique per sender.

**The Master builds the sheet.** `sendJob` reads the lead or order, its party and its PO number itself and
freezes `noteDocument(...)` in `print_jobs.payload`, so the printer PC never depends on its own snapshot
cap or party scope, and a later edit of the record leaves the job's sheet as sent. Rows are kept for
good; the sheet of a printed or cancelled job is dropped 30 days after it by one `UPDATE` on each send
(`hasDocument: false`, and the screen says so). Refusals are `validation.print.*` keys (`requestId`,
`kind`, `source`, `copies`, `note`, `vehicle`, `station`, `printer`, `notQueued`, `notPrintable`,
`stationNeedsDesktop`, `stationUnknown`).

### 16.3 Socket commands (Office to Master), protocol 6

Eight, twinned with the routes above and forwarded by the Office at the same paths:
`print:list`, `print:get`, `print:send`, `print:mark`, `print:cancel`, `print:claim`, `print:stations`,
`print:station`. All sit in `COMMAND_MIN_PROTOCOL` at `PRINTROOM_MIN_PROTOCOL` (6, a named constant in
`shared/src/domain/printroom.ts`); an Office on an older Master answers 426. `PANEL_PROTOCOL_VERSION`
is 6 with this phase. Everything is online-only: with the Master out of reach the Office answers 503
`error.unavailable`, a send is **never** queued in the outbox (a note printed an hour late on an
unattended PC wastes paper), and the note's own Print button keeps working. A send first lets the outbox
hand over a just-edited order (`flushBriefly`, at most four seconds, failures ignored).

`print:claim` and `print:station` take their station from the connection (`socket.data.panelId`), never
from the payload; a forged `stationKey` is ignored. The Master PC's window can also send `print:claim` on
its own admin socket.

### 16.4 Claims belong to a connection

`print:claim` flips a `queued` job to `printing` with one atomic `UPDATE`. It names the claiming station,
person and **socket id**, and wins only if the job is queued (or its claim is older than ten minutes), has
its sheet, and is not aimed at a different station. The loser gets `null`, an ordinary outcome. Then:

- a socket that **disconnects** releases every job it held (`releaseClaimsOf`), whether or not a newer
  connection from the same panel has replaced it;
- a claim **older than ten minutes** may be taken by another station (`PRINT_LIMITS.claimStaleMs`);
- every claim is **cleared at Master boot** (`releaseAllClaimsAtBoot`);
- a station whose print failed gives its own claim back with `print:mark {printed: false}` (only the
  claimant can), and the runner does not try that job again this session.

So two stations never print one sheet, and a station that crashes or loses its link never strands a job.

### 16.5 Live updates

`print.service` publishes `{tenantId, job}` on the change bus's own `print` channel (`publishPrintJob` /
`onPrintJob`, never the ring). `hub.ts` sends `print:changed` through `emitToActors` to sockets whose
current actor holds `print.station`, or holds `print.send` and **is** the job's sender, skipping an Office
older than protocol 6. The payload is a `PrintJobSummary` (never the sheet) stamped `forUserId`. The
Office relays it as SSE `print` through `broadcastForUser`. SSE has no replay, so both web apps read the
list again on a reconnect (`dispatchPrint({kind: 'resync'})`), and the auto-print runner lists the queue
again on every beat.

When someone **else** prints a job, the sender gets a `print.printed` notification (`{name, party}`,
link `{kind: 'print', id}`), after the commit.

### 16.6 Audit

Written with `recordActivity` in the change's own transaction, entity `print_job`, details
`{number, kind}`: `sent`, `printed`, `unprinted`, `cancelled`. Claims, giving a claim back and station
heartbeats are not audited. The sentences are `activity.print_job.*`.

### 16.7 Station mode in the desktop shell

`DesktopBridge.setStationMode(on)` (IPC `orderbook:setStationMode`, panel window only, only the boolean
`true` turns it on) switches off background throttling while a PC is an auto-print station, so a minimised
printer PC keeps printing. Silent printing is unchanged: `printPage` prints without a dialog only to a
printer Windows lists, and the station runner treats an unlisted printer as a failure rather than letting
a dialog open on an unattended PC.

---

## 17. Party Access: list, summary and people (1.4.0)

The redesign changed three reads. Writes (`PUT /api/party-access/:partyId`, whole-set replace guarded by
`expectedVersion`) and the CSV export are unchanged. Types: `shared/src/domain/inputs.ts`
(`PartyAccessQuery`, `PARTY_ACCESS_SORTS`, `PartyAccessSort`, `PartyAccessSortDir`, `PartyAccessSummary`).

### 17.1 `GET /api/party-access`

`?search&userId&restriction&sort&dir&limit&offset` → `Paginated<PartyAccessRow>`.

- `search` is plain text (`\`, `%` and `_` are escaped, never wildcards) matched against party **code, name, city,
  phone** and the **display name or username of anybody assigned**.
- `restriction` ∈ `all | open | restricted`. "Nobody" is `restriction=open`; `userId` is always a real id, and
  `userId` with `restriction=open` matches nothing.
- `sort` ∈ `code | name | city | access` and `dir` ∈ `asc | desc`. `access` is the number of assignees (ascending =
  open parties first). Allow-listed in the Office route, the Master route, the service and the repository;
  anything else falls back to name ascending. Ties break on name, then id.
- A holder whose account is inactive or deleted keeps the grant and is returned with `isActive: false`
  (`isActive` folds in `deleted_at IS NULL`). A save keeps such existing grants; only **new** grants must be live.

### 17.2 `GET /api/party-access/summary`

→ `PartyAccessSummary { total, restricted, open }`: every live party company-wide, unaffected by search or filter.
Needs `party.assign` or `party.accessAll`. Registered **before** `/:partyId`. Socket command
`partyAccess:summary` (ack `CommandAck<PartyAccessSummary>`), minimum protocol **8**
(`COMMAND_MIN_PROTOCOL`, `PANEL_PROTOCOL_VERSION = 8`). An Office on a Master that predates it gets the usual
"update needed" failure; an old Master ignores `sort`/`dir`/city/assignee search. Office offline: 503, like the whole screen
(Party Access is never queued).

### 17.3 `GET /api/party-access/people`

Allowed with `party.assign` **or** `party.accessAll` (no route guard; `requireCanRead` in the service), same narrow
fields: `id, displayName, username, roleName, roleTier, avatar`. A caller with neither key gets 403.

---

## 18. Adding an Office panel: pairing, leaving, the window (1.4.1)

The 1.4.1 audit of the add-connection flow (`CLAUDE_HELPER_CONN.md`). The flow end to end
is `docs/STRUCTURE.md` §11.1 and §8.7. `PANEL_PROTOCOL_VERSION` is **9**
(`shared/src/protocol/socket.ts`).

### 18.1 `POST /api/pairing/request` (`PAIRING_ENDPOINT`), unauthenticated, rate-limited

`PairingRequest` (`shared/src/protocol/pairing.ts`) gains two optional fields:

| Field | Meaning |
|---|---|
| `previousPanelId` | The panel id this PC held before it was removed or unpaired. The Office sends it only to the Master whose `masterUniqueId` it stored. |
| `previousPanelSecret` | That panel's secret. The Office sends it only to a host that has just passed the `POST /api/panel/prove` HMAC challenge, which proves the host holds the secret without the secret being sent. The Master never logs or stores it, and the logger redacts credential-named properties. |

**Which row a pairing gets.** Every case below still needs the request to be admitted first,
either by an open window or by the pairing password. `pairPanel`
(`master/src/services/panel.service.ts`) resolves the row in this order:

1. A verified `previousPanelId` plus `previousPanelSecret` (bcrypt) for an **active** row: the
   same PC takes its own row back, and the old socket of that row is dropped.
2. The removed row named by `previousPanelId`.
3. The newest removed row with the same `hostname`.
4. Otherwise a new row.

An active row is never taken over by hostname alone. A revived row keeps its earlier name; if
another panel took that name meanwhile, it gets a numbered name. The activity row is
`re_paired`.

**Refusals.** Every Master refusal carries a `messageKey`. The Office treats any non-OK reply
without one as `not_a_master`; the one exception is a 429, which is always a rate limit.

| Status | `error` | `messageKey` / details |
|---|---|---|
| 401 | `unauthorized` | `error.unauthorized.incorrectPairingPassword` |
| 401 | `unauthorized` | `error.unauthorized.pairingAutoOff`: the window is open but automatic joining is off, so only the pairing password works |
| 401 | `unauthorized` | `error.unauthorized.pairingNotAccepting`: no window is open |
| 429 | `rate_limited` | details `{ seconds, retryAfterSeconds }`, header `Retry-After`; 10 manual attempts per IP per minute |

### 18.2 `panel:leave` (socket command, protocol 9)

The Office sends it on its own authenticated panel socket when the person unpairs that PC.
- **Payload:** none. **Ack:** `CommandAck<null>`.
- **Effect:** the row is marked removed (`revoked`, reason "left"), and an activity entry
  says the panel unpaired itself.
- **Socket:** it closes about 100 ms after the ack, and no `panel:revoked` is echoed back.
- **Repeats:** a second call does nothing.
- **Older Master:** `COMMAND_MIN_PROTOCOL['panel:leave'] = 9`, so an older Master answers
  `updateNeeded`, and the Office then just unpairs locally.

### 18.3 The Master's pairing window

| Route | Gate | Notes |
|---|---|---|
| `GET /api/panels/pairing-window` | `panels.manage` (was any signed-in user) | `PairingWindowState`: `open`, `closesAt` (epoch ms or null), `autoPairingEnabled`, `accepting`, `port`, `addresses[]`, `discovery { listening, port, reason }`, `officeSetups[] { platform, version, file, sizeBytes }` (the Office setups this Master's setup file carried; empty when none, 2026-10-08) |
| `POST /api/panels/pairing-window/open`, `/close` | `panels.manage` | 5 minutes, in memory; a successful auto pairing closes it |
| `POST /api/panels/:id/rotate-secret` | `panels.manage` | Now has a "Reissue secret" button, shown only for a connected panel |
| `GET /api/updates/office/setup` (2026-10-08) | **none**: no session and no panel credentials, because the PC asking has not paired and cannot until the Office is installed. `limitByIp('office-setup')`, 10 a minute per address | Streams the Office setup the Master carries (`config.officeSetupDir`) with `Content-Disposition: attachment; filename="<file>"` and its `Content-Length`. `?platform=` is `win32`, `win7`, `darwin` or `linux`; without it, the first carried (on Windows the Windows 10/11 Office). None carried, or none for that platform: 404 `not_found`, `messageKey: error.officeSetupMissing`. `/api/updates/office/latest` and `/office/download` are unchanged and still answer 401 without panel credentials |

**Discovery.** The discovery responder replies with the address of the interface whose subnet
contains the asker. Failing that, it uses the best-ranked address: physical adapters come
above virtual, VPN and link-local ones. A UDP bind failure no longer stops the Master from
starting; the responder retries every 30 s.

### 18.4 The Office's connection routes (local to the Office, `office/src/http/app.ts`)

| Route | Purpose |
|---|---|
| `GET /api/connection` | The link state, the reason a pairing ended ("removed by the Master" or "left"), and the last address |
| `POST /api/connection/scan`, `/pair/auto` | Discovery and auto pairing. Can be cancelled. Coded refusals (`PairingErrorCode`) |
| `POST /api/connection/test` | Probes an address with the Master's unauthenticated `/api/health`: the company name, the version, and whether it is the same version as this Office |
| `POST /api/connection/pair/manual` | Pairs with an address and the pairing password. The address is validated first |
| `POST /api/connection/unpair` | `unpairAllowed()`: no sign-in is needed only when this PC is not recognised or the Master cannot be reached; otherwise it needs `panels.manage`. Discarding unsent work always needs that right. It sends `panel:leave` when connected |

## 19. Duplicate products (1.4.3)

Master-only REST, both behind `products.delete` (a resolve is a delete; no new key). Types in
`shared/src/domain/duplicate-products.ts`; finder `master/src/domain/duplicate-products.ts`;
service `master/src/services/duplicate-products.service.ts`.

| Route | Purpose |
|---|---|
| `GET /api/duplicates` | `{ groups: DuplicateGroup[] }`. Two levels. `product` (a category): same brand and same name, or same brand and same code. `subProduct`: same Product and same name, or same brand and one same variant code. The comparison (`duplicateKey`) ignores case, spacing, punctuation and accents. Each member carries `blockedBy`: `liveReferences` (a live pending order or order quotes it) or `subProducts` (a Product still holding live sub products) |
| `POST /api/duplicates/resolve` | `{ level, keepId, deleteIds[] }` → `{ deleted[], refused[{id, blockedBy}] }`. The groups are found again server side; `keepId` and every `deleteIds` entry must sit in one group (else 400 `validation.duplicates.selection`). Each delete is `deleteProduct` / `deleteCategory`, so it is the Recycle Bin soft delete with its activity row and its `data:changed … deleted` event, which every Office folds (`apply-change.ts`). A blocked copy is refused and left; the others still go |

## 20. Device figures, paged order lists, stage counts and the error answers (1.4.3)

Duplicate products are section 19. This section is the rest of the 1.4.3 wire changes.

### 20.1 `GET /api/device` (both servers), unauthenticated

Sits beside `/api/health` on the Master and on the Office's local server, because the sign-in screen
shows it before anybody has signed in. It describes the PC that server runs on, hardware only:

```ts
{ totalMemoryBytes: number, cpuCount: number }   // os.totalmem(), os.cpus().length
```

The thresholds are not on the wire. `shared/src/domain/device.ts` holds them (memory below
7.5 x 1024^3 bytes, or 2 or fewer logical processors) and `ui/src/DeviceWarning.tsx` applies them. Unknown
or zero figures warn nothing. `os.availableParallelism` is not used because the Windows 7 Office runs
Node 16. The Master's own screen asks for it only when the browser is on the Master PC itself, since a
browser on another machine would be shown the Master's hardware as if it were its own.

### 20.2 The Pending and Final lists are paged

`GET /api/leads` and `GET /api/orders` return `Paginated<T>` = `{ items, total, limit, offset }`. The
query is `search`, `limit`, `offset`, `scope` (`assigned` or absent), `sort`, `dir`, and a comma-separated
`stageIds`; leads also take `includeConverted`, `convertedOnly`, `partyId` and `followUpDueOnly`. An unasked
`limit` is 100 and the ceiling is 500 (`clampPaging`). `total` is the number of rows the filters leave, not
the page size. The stage filter is applied before the page is cut, so a stage chosen on page 1 narrows
every page. The Master screens ask for one page at a time and the bar offers 25, 50, 100, 200 or 500
rows (`ui/src/PageBar.tsx`, remembered per machine). The old load-more button is gone.

The Office does not call these routes for its lists: it pages its local snapshot (filter by scope,
stage and search first, then slice), so its totals are the local filtered counts.

### 20.3 `GET /api/leads/stage-counts` and `GET /api/orders/stage-counts`

```ts
StageCounts = { total: number, counts: Record<stageId, number> }   // a stage with none is absent
```

Same filters as the list (`search`, `scope`, and for leads the converted switches, `partyId` and
`followUpDueOnly`) with the stage filter **ignored**, and the same party scope and permission check (`leads.view` or
`orders.view`). The chips above the list show these figures, so each chip is the same on every page
and under any stage choice, and "All" is `total`. Both routes are registered before the `:id` routes so
the word "stage-counts" is never taken for an id.

### 20.4 Limits and the answers a caller can get

Every limit is a fixed 60 second window kept in memory (`master/src/http/middleware/rate-limit.ts`,
built on `consume`). They are flood guards sized so that normal shop use never reaches them: every Office
reaches the Master from its own PC's address, so one address is one panel.

| Where | Key | Per minute |
|---|---|---|
| `POST /api/auth/sign-in` | source address; attempted username (case-folded) | 60; 30 |
| Password reset, reveal, change, pairing-password and master-key writes | source address | 60 |
| `/api/reports/:report/pdf` and `/export` | source address | 60 |
| Any multipart request under `/api` | source address | 120 |
| `/api/v1` before the key's own limit | source address | 1,200 |
| Every Socket.IO command | connection | 1,200 |
| Manual pairing (older, unchanged) | source address | 10 |

| Status | `error` | When | Carries |
|---|---|---|---|
| 429 | `rate_limited` | a limit above was passed | `messageKey: error.rateLimited`, `details.seconds` and `details.retryAfterSeconds`, and a `Retry-After` header |
| 400 | `invalid_request` | the JSON body could not be read (malformed or the wrong encoding) | `messageKey: error.generic.malformedBody` |
| 413 | `payload_too_large` | the body passed the limit (Master 2 MB, Office 1 MB) | `messageKey: error.generic.tooLarge` |
| 400 | `validation_error` | a database refusal that a caller causes: a text that is not an id, a number out of range, a bad date, a value too long, a NUL character, or a malformed percent-escape in the path | `messageKey: validation.request.badInput` |

A refused socket command with an acknowledgement gets `{ ok: false, code: 'rate_limited', messageKey, params,
details }`; one without an acknowledgement is dropped. The window is forgotten when the connection ends.
None of these is a 500: the generic handler used to answer 500 for the last three.

### 20.5 Caching headers and the server read cache

Not part of any payload, listed here because clients may rely on them. Files under `/assets/` (content-hashed
by the build) are `public, max-age=31536000, immutable`; `index.html` and the rest are `no-cache` with an
`ETag`, so an update shows on the next open. Product images and avatars were already `immutable` with an
`ETag`. A few hot reads (the dashboard summary, the categories list, the Pending and Final lists, chat
history) are kept for 5 to 15 seconds by `master/src/lib/seq-cache.ts`, valid only while no change has been
published since they were computed, so any write drops them. An answer is therefore never older than the
last change event, and a read made inside the window after a write sees it.

## 21. Party visibility (2026-10)

No new route or permission key. What changed in the answers:

- **Creation:** `POST /api/parties`, the `party:create` socket command, a `party.create` mutation pushed from an
  Office, and a party import all create a party through `createParty` / the import writer, which add the creator's
  `manage` grant in the same transaction when the actor is a person without `party.accessAll`. The party
  event that follows is delivered by the usual per-recipient filter, so other users' panels never receive it.
- **Hidden means not found.** `requirePartyAccess` throws 404 `Party` when the caller's level is `none`,
  and an id that names no party is `none` for a caller who cannot see every party. A lead create or update, a
  party-variant upsert or a merged `lead.update` naming a hidden party therefore answers exactly as for a missing
  one, and the check runs before any lookup that could differ (`createLead`, `updateLead`, `upsertVariant`, and
  `mergeUpdate`, which runs it before reading the target party's lines).
- **Import:** `listLivePartyNameCities(tenantId, scope)` counts only parties the caller can see, so "already exists,
  skipped" no longer confirms someone else's private party.
- **Sync push (`sync:push`, protocol unchanged):** an `office_panel` push containing a party-scoped mutation
  (`lead.*`, `order.*`, `party.*`, `partyVariant.*`) is answered **503 `error.unavailable.signInToSync`**, and
  nothing in it is applied, when nobody is signed in on the panel and the panel's role does not hold
  `party.accessAll`, or when the signed-in person is not the mutation's `actorUserId`. The Office keeps the
  mutation queued and sends it again when its author signs in.
- **Snapshot (`SyncSnapshot`):** adds `openPartyIds` (parties with no grant row; an Office signed in as someone
  else may show only these while offline) and `partyAccessCounts` (people who can see each restricted party,
  for the Private / Shared markers). `conflicts` is empty unless the caller holds `sync.resolveConflicts`, and
  holds only conflicts on parties, leads and orders the caller can see. `GET /api/conflicts`, `conflict:list` and
  the dashboard's `openConflictCount` use the same narrowing.
- **Delta replay:** a buffered party-scoped change that names no party id makes the Master answer with a full
  snapshot, never a delta (the live fan-out already drops such an event). The Office offers a cursor only when its
  cache was built for the person now signed in.
- **`GET /api/panels/:id/activity`:** rows about parties, leads and orders the caller cannot see are left out.

## 22. The notice board (Oct 2026)

Shared types: `shared/src/domain/notices.ts` (`Notice`, `NoticeInput`, `NoticeUpdate`, `NoticeBoard`, `NoticeReaders`,
`NoticeAudience`, limits `NOTICE_TITLE_MAX` 120, `NOTICE_BODY_MAX` 4000, `NOTICE_AUDIENCE_MAX_ROLES` 50). Service:
`master/src/services/notice.service.ts`. First protocol that speaks it: `NOTICE_MIN_PROTOCOL` (10).

| Route (Master) | Key | Answer |
|---|---|---|
| `GET /api/notices` | `notices.view` | `{ notices, unreadCount }`: the notices for the caller's role, not expired, pinned first, then important, then newest; each carries `readByMe`, never counts or role names |
| `POST /api/notices/read` | `notices.view` | `{ ids? }` (all of the caller's board when omitted) -> `{ unreadCount }`. An id that is not on the caller's board, not a UUID or not a notice is ignored and answered the same, so the answer says nothing about whether a notice exists |
| `GET /api/notices/manage` | `notices.manage` | every notice, expired ones too, with `audienceRoleNames`, `expired`, `readCount`, `audienceSize` |
| `GET /api/notices/audiences` | `notices.manage` | the roles an audience can be made of |
| `GET /api/notices/:id/readers` | `notices.manage` | everybody in the audience with `readAt` (null = not yet) |
| `POST /api/notices` | `notices.manage` | create; 201 with the notice. Audience `{kind:'all'}` (default) or `{kind:'roles', roleIds}` of live roles. `showOnHome`, `showAtSignIn` (booleans, each true when omitted); both false is 400 `validation.notice.placementEmpty` |
| `PATCH /api/notices/:id` | `notices.manage` | edit; the body carries `expectedVersion`, a stale one is 409 `conflict`. A placement left out keeps what is stored, and the pair after the edit must keep one true (400 `validation.notice.placementEmpty`) |
| `DELETE /api/notices/:id` | `notices.manage` | soft delete; restore is the Recycle Bin (`entity notice`) |

Socket (Office panels): `notice:list`, `notice:manageList`, `notice:audiences`, `notice:readers`, `notice:create`,
`notice:update`, `notice:delete`, `notice:markRead`, the same service, with the acting person's role. The Office
server forwards the same paths (`office/src/http/app.ts`); it answers the board offline from the snapshot (expired notices
left out, reads shown from the last snapshot) and every write and "mark read" needs the Master.

**Snapshot and events.** `SyncSnapshot.notices` is the reader's own list, empty without `notices.view`. A change is one
`notice` event (`created`, `updated`, `deleted`, `restored`) whose payload names only the audience, before and after
(the title and body never ride the change ring); it is snapshot-forcing, and reaches only a recipient whose role is in
the audience, or who holds `notices.manage`, so an edit that moves a notice off a role still tells that role.

**Placement (2026-10-08).** Every `Notice` answer (reader, manager, snapshot) carries `showOnHome` and `showAtSignIn`:
whether the panels show it in the Basic Home band and in the pop-up after sign-in. Both are optional on the wire and
absent means true (`noticeOnHome`, `noticeAtSignIn`), so a Master from before them reads as "everywhere" on a newer panel,
and a newer Master's extra fields are ignored by an older one. No new command, so `PANEL_PROTOCOL_VERSION` did not move.
The company switches `notices.showOnHome` / `notices.showAtSignIn` travel as `CompanyFeatures.noticesOnHome` /
`noticesAtSignIn` on `/me` and in the snapshot; a setting change is snapshot-forcing, and the Master's browser re-reads `/me`.

### 22.1 "Sell today" (2026-10-08, protocol 11)

What to sell today: a headline, an optional message and the sub products to push, for chosen days and an audience. It
is a row of `notices` with `kind = 'sellToday'` (migration `20261018000000_notice_sell_today`), so it shares the
audience, the version, the soft delete, the Recycle Bin, the activity log and the `notice` change event with a notice,
and it is **never** a notice on the wire: `GET /api/notices`' `notices` and `unreadCount`, `notice:manageList`,
`SyncSnapshot.notices` and `notice:markRead` see `kind = 'notice'` rows only, and `PATCH /api/notices/:id` on an entry
is 404 (as `PATCH /api/notices/sell-today/:id` on a notice is). Types: `SellToday`, `SellTodayInput`, `SellTodayUpdate`,
`SellTodayProduct`, `sellTodayProblem`, `sellTodayFor` in `shared/src/domain/notices.ts`.

| Route (Master) | Key | Answer |
|---|---|---|
| `GET /api/notices` | `notices.view` | gains `sellToday`: the caller's entries that have not ended (one that starts on a later day is included), each with `products`, the live ones of `productIds` resolved to cards `{ id, name, code, size, mainProduct, image }` (none for a caller without `products.view`) |
| `GET /api/notices/sell-today` | `notices.manage` | every entry, ended ones too (`expired`), newest first, with `audienceRoleNames` |
| `POST /api/notices/sell-today` | `notices.manage` | create; 201 with the entry. `title` (the headline, 1 to 120), `body` (0 to 4000), `productIds` (at most 12 live sub products, in order), `autoCloseSeconds` (0 = only when closed, or a whole 5 to 120; 15 when omitted), `showFrom` / `showUntil` (`YYYY-MM-DD` or null; the last not before the first), `audience` as for a notice. A product or a message is required |
| `PATCH /api/notices/sell-today/:id` | `notices.manage` | edit with `expectedVersion` (stale: 409). The window and "something to sell" are checked against what the edit leaves out |
| `DELETE /api/notices/:id` | `notices.manage` | the notice's own delete; the Recycle Bin lists it as `notice` with the sublabel `sellToday` (a token; a notice's is its priority), which the screen puts into words |

Refusals (400): `validation.sellToday.malformed` (a field of the wrong type), `.nothingToSell`, `.tooManyProducts`
(`{max}`), `.autoCloseInvalid` (`{min, max}`), `.datesReversed`, `.unknownProduct` (an id that is not a live sub
product), and the notice's own `validation.notice.titleRequired` / `.titleTooLong` / `.bodyTooLong` / `.dateInvalid` /
`.audienceEmpty` / `.audienceTooBig` / `.audienceUnknownRole`.

Socket (Office panels): `sellToday:manageList`, `sellToday:create`, `sellToday:update`, each at
`SELL_TODAY_MIN_PROTOCOL` (11) in `COMMAND_MIN_PROTOCOL`, so an Office refuses them at once (426 `updateNeeded` from its
server) against an older Master, and its management screen then does not offer the tab. **Why the protocol moved
(10 to 11):** a create sent as `notice:create` to an older Master would have been stored as an ordinary notice and shown
on everybody's board; new commands make an older Master say no instead. Reading needs no command: the entries ride on
`SyncSnapshot.sellToday` (optional, so an older Master's snapshot has none and an older Office ignores it), gated on the
Office like `notices` (nothing without `notices.view`; from a cache built for somebody else only the entries for
everybody).

The company switches `notices.showSellToday` (the pop-up) and `basicHome.productSlideshow` (the Basic Home product
band), both on by default, travel as `CompanyFeatures.sellTodayPopup` / `productSlideshow`.

## 23. The product backup zip (2026-10-08)

Shared types: `shared/src/domain/product-import.ts` (`ProductZipReport`, `ProductRowChange`, `ProductCellChange`,
`ProductZipProblem`, `ProductRestoreOptions`, `ProductRestoreJob`, `MAX_PRODUCT_ZIP_BYTES` 1 GiB). Service:
`master/src/services/product-zip.service.ts`; routes: `productImportRoutes(actorFromRequest, { zip: true })` in
`master/src/http/routes/panel-catalog.routes.ts`, on `dataRoutes` (a signed-in Master user) only. The file format is
`docs/PRODUCT_IMPORT_FORMAT.md`, "The product backup zip".

| Route (Master) | Keys | Answer |
|---|---|---|
| `GET /api/products/export.zip` | `products.view` + `products.export` | `application/zip`, `attachment; filename="OrderBook-Products-<company>-<date>.zip"`, streamed from a file in `<dataDir>/tmp` that is deleted when the response closes. One `catalog.exported` activity row (`format: 'zip'`) |
| `POST /api/products/restore` (multipart `file`, a zip or, since 2026-10-09, a bare products `.csv`/`.xlsx`; written to disk, over 1 GiB `400 validation.productZip.tooLarge`) with `dryRun=true`; since 2026-10-10 the opt-in fields below too, so the preview is of the run they ask (`exactCatalogue=true` previews the exact run) | `products.bulk` + `.create` + `.edit` (+ `catalog.lists.manage` when the colour or brand list changes); with the opt-ins, what the run below asks (`403` for an exact preview without `products.delete`, or without `catalog.lists.manage` when it would take a colour or brand out, which a preview without it reports as `exactNeedsLists`) | `200 ProductZipReport` (`dryRun: true`; `exactNeedsLists` when the exact run would need `catalog.lists.manage` the caller lacks); nothing written; the upload deleted |
| `POST /api/products/restore` without `dryRun`; `binMissingProducts=true`, `removeMissingPhotos=true`, `exactCatalogue=true` (2026-10-09) opt in | the same, + `products.delete` with `binMissingProducts` or `exactCatalogue`, + `catalog.lists.manage` when `exactCatalogue` would take a colour or brand out | `202 ProductRestoreJob` (`phase: 'checking'`); the run continues detached and deletes the upload when it ends. A second start while one runs: `409 error.conflict.productRestoreBusy`; a start while a full backup restore runs: `409 error.conflict.backupBusy`. The other way round, `POST /api/storage/archive/restore` answers `409 error.conflict.productRestoreBusy` while this job runs |
| `GET /api/products/restore/job` | `products.bulk` | the latest `ProductRestoreJob` (`phase` `checking` → `products` → `photos` (`done`/`total` photos) → `removing` → `done` with `result: ProductZipReport`, or `failed` with `message`), or `null` since the Master started |

Refusals before anything is written: `validation.productZip.notAZip`, `.entryRejected` (`{entry}`: an absolute or `..`
name), `.noProductsCsv`, `.manyFiles` (`{file}`), and the import's own `validation.import.missingColumn` /
`.unreadable` / `.emptyFile` (no header, or a header and no rows) for `products.csv`. A row or photo that fails is listed
in the report (`products.issues`, `problems`), never a refusal of the whole zip; so is a `products.csv` main product cell
that disagrees with `main-products.csv` (`validation.productZip.mainDiffers`, `{column, value, main}`: the latter is read). A real run that changed anything writes one `catalog.imported` activity row
and one `catalog` change event; the photos and renames it makes announce themselves as a single edit would.

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
