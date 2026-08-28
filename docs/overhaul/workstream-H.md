# Workstream H — Performance, API-call reduction, and memory management

sound=false

## Findings
- **blocker**: H3b's `scopeForAdminSocket` admits dead sessions. `authService.sessionPermissions` (auth.service.ts:208) returns `[]` for a token that is absent or expired — it cannot distinguish "no permissions" from "no session". The proposed function returns a non-null `{seesAll:false, userId}` in that case, and `levelFor` then matches the userId against the party's grants. A signed-out, deactivated, or post-master-restart admin socket keeps receiving `data:changed` for every restricted party it holds a grant on. Today `actorForRecipient` (hub.ts:803-821) calls `resolveSession`, gets null, and emits nothing. This is a live disclosure regression on the exact path party scoping exists to protect.
  - FIX: Drop the zero-query variant. Route `actorForRecipient`'s master-admin branch through the new `resolveSessionWithPermissions` (H2), which is one query and preserves the null-on-dead-session behaviour verbatim. One query per recipient socket, only on a restricted party, down from three.
- **blocker**: `refreshSessionsForRole` is called from inside a transaction that can still roll back. `role.service.ts` calls `roleRepo.updateRoleColumns` at :165 and then runs the G4 administrative-capability assertion after it inside the same `trx` (the comment at :172-174 says so explicitly); `user.service.ts` does the same after `updateUserColumns` at :217. Pushing the new permission set into the live session map at that point makes an uncommitted — possibly aborted — permission grant or revocation authoritative for every subsequent request.
  - FIX: Delete `refreshSessionsForRole` entirely. It exists only to make the zero-query broadcast safe, and that is being dropped. `resolveSession`'s per-call role-version re-read (auth.service.ts:164-172) already satisfies the "takes effect on the next call" rule and is the documented contract.
- **blocker**: The H4 delta silently diverges on party variants. `master-connection.ts#applyChange` (:482-528) has cases for lead, party, product, product_category, order and stock only — there is no `party_variant` case, and none for `sync_conflict` or `reservation`. Those are all valid `ChangedEntity` values (shared/src/protocol/socket.ts:230-247). `buildDelta`'s fallback list names only option_list/custom_field/pipeline, so a party-variant change made while a panel was offline is replayed, dropped on the floor, and never covered by a snapshot. `partyVariants` are per-party negotiated rates — staff quote from stale prices with no error anywhere.
  - FIX: Add `party_variant`, `sync_conflict` and `reservation` to `buildDelta`'s forced-full-snapshot set, and derive that set from a single exported constant `REPLAYABLE_ENTITIES` in master-connection.ts so the two lists cannot drift. Assert in `change-ring.test.ts` that every `ChangedEntity` is either replayable or forces a snapshot.
- **blocker**: The H4 delta leaks the company directory to Office Panels. The ring records from the `onChange` subscription at hub.ts:129, which sees every event. The live path deliberately withholds `DIRECTORY_ENTITIES` = role, user, document_export from `ROOM_OFFICE_PANELS` (hub.ts:147-149) — the comment there says broadcasting a `user` row handed every panel the whole staff list and every role's complete permission array. `buildDelta` as designed replays them.
  - FIX: Filter the replay through the same three predicates the live fan-out uses, in this order: skip `DIRECTORY_ENTITIES`; for `PARTY_SCOPED_ENTITIES` run the recipient's `levelFor(resolvePartyScope(actor), grants)` check; emit the rest. Extract that decision into one exported `mayReceive(actor, event, grants)` in hub.ts so live and replay call the same function.
- **blocker**: A restarted panel's delta is applied into nothing. `MasterConnection.snapshot` is private and set only by the `sync:snapshot` handler (:180) and `requestFreshSnapshot` (:557) — it is never hydrated from `localStore.restore()`. `applyChange` opens with `if (!this.snapshot) return;` (:483). A panel that restarts, reads `lastSeq` from disk, and asks for a delta discards every replayed event, then serves `getView()` from a disk snapshot that is missing all of them.
  - FIX: On `connect`, hydrate first: `this.snapshot ??= await localStore.restore()`, and only send `sync:delta` when that returned non-null AND a persisted `{bootId,lastSeq}` exists; otherwise send no cursor and take the pushed snapshot. Persist `{bootId,lastSeq}` in the same write as the snapshot so the pair can never disagree.
- **blocker**: H1's GET dedup and per-caller abort are mutually destructive. `useResource` "owns an AbortController per run, aborts it in the effect cleanup" and that signal is merged into the shared fetch via `AbortSignal.any`. Two screens issuing the same GET share one promise; the first to unmount aborts the shared fetch, the second's `useResource` sees code `aborted`, swallows it silently as designed, and renders loading-forever with no data and no error.
  - FIX: Refcount the shared entry: `{promise, controller, waiters:number}`. Each caller increments on join and decrements on its own abort; the shared controller is aborted only when `waiters` reaches 0. The timeout signal stays shared. ~12 extra lines, and it is the only way to keep both properties.
- **blocker**: H5's `requirePanel` loses the acting user. Image upload and fetch run today through `panelActor(socket, panelId)` → `resolvePanelActor` (panel-actor.service.ts:53), which resolves `socket.data.actingUserToken` into the signed-in person's actor. `imageService.uploadImage` and `resolveImageFile` both take that actor and gate on `products.edit` / `products.view` with a permission-to-404 translation. A route authenticated by `panelService.authenticatePanel` alone runs as the panel's own fallback role, changing who may upload and mis-attributing every image in the audit trail.
  - FIX: `requirePanel` must read `x-orderbook-panel-id`, `x-orderbook-panel-secret` AND `x-orderbook-acting-token`, then call `resolvePanelActor({tenantId, panelId, deviceCode, actingUserToken})` and put the resulting `ActorContext` on `req`. Reject with 401 when `tokenAccepted` is false. The office proxy sends the token it already holds.
- **blocker**: The orphaned-image-variant sweep on the 15-minute timer races the upload pipeline and destroys live uploads. `image.service.ts#normalizeAndStore` writes four `.webp` files (:97-106) before the caller inserts the `product_images` row. A sweep that anti-joins the directory against `product_images.id` in that window deletes a completed upload's files and leaves a row pointing at nothing.
  - FIX: Run the image-orphan sweep at startup only, alongside the existing `sweepOrphanTemporaries()` call at master/src/index.ts:99 — that helper's own comment (document-files.ts:132-136) states the reason: at startup nothing else is writing. Never on the timer.
- **major**: The whole-table party-access cache is unnecessary and unsafe. `grantsForParty` is a single lookup on `idx_party_access_party` (migration 20260313000000:68). The proposed cache has no version key — unlike `role.repository.ts:35`, which is keyed on `version` so a stale repopulate self-heals — and is invalidated "inside the transaction's caller", so a concurrent read between the invalidate and the commit repopulates it with pre-commit rows and it stays wrong until the process restarts. A permanently stale grant map means a newly restricted party keeps broadcasting to everyone.
  - FIX: Do not add the cache. Keep `grantsForParty` as one indexed query per party-scoped change. The cost the design is chasing is the per-recipient triple query, not this.
- **major**: H2 fixes one of five call sites of the same three-query pattern — the reviewer brief's "fix at the call site where the defect is in a shared function". `resolveSession` + `permissionSetForRole` also appears at hub.ts:727/735 (`adminActor`, on every socket connect), hub.ts:810/818 (`actorForRecipient`), hub.ts:857/868 (`broadcastDashboard`, per admin socket per flush), and panel-actor.service.ts:60/72 via `resolveSessionDetailed`.
  - FIX: Introduce `resolveSessionWithPermissions(token)` and `resolveSessionDetailedWithPermissions(token)` in auth.service.ts and route all five through them. `resolveSession`/`resolveSessionDetailed` become thin wrappers so no external behaviour changes.
- **major**: `findByIdWithRole` "reuses baseQuery" in two harmful ways. First, `baseQuery` (user.repository.ts:64) joins `roles as r` on `r.id = u.role_id` with no tenant predicate, while `permissionSetForRole` deliberately matches `{tenant_id, id}` — its comment at :113-119 explains that matching on id alone is "safety from a schema quirk rather than from the query". Collapsing into the join silently drops that. Second, if an implementer adds the three columns to `baseQuery` itself, every `listUsers` row now carries the role's full permission array — the same class of mistake the `USER_COLUMNS` comment at :29-38 exists to prevent.
  - FIX: Write `findByIdWithRole` as its own query, not by editing `baseQuery`: `baseQuery(runner).leftJoin` is replaced by an explicit `.join('roles as r', function(){ this.on('r.id','u.role_id').andOn('r.tenant_id','u.tenant_id') })` variant, selecting `USER_COLUMNS` plus exactly `r.name as role_name`, `r.tier as role_tier`, `r.permissions as role_permissions`, `r.version as role_version`, `r.deleted_at as role_deleted_at`. Return `role: null` when `role_deleted_at` is non-null. `baseQuery` is untouched.
- **major**: The query-budget target is arithmetically impossible. `party.repository.ts#listParties` issues two queries — a `count` at :46 and the paged `select` at :47. So `GET /api/parties` costs 3 auth + 2 list = 5 today, and 1 + 2 = 3 after H2. The design states before=4 and asserts `<= 2`; the test fails on the first run.
  - FIX: State the real numbers (5 → 3) and assert `<= 3`. Keep the test — it still catches a regained auth lookup — but pin it to a measured figure.
- **major**: Per-entity revisions never fire for the entities the design names. `master/web/src/App.tsx:74` defines `REFRESHING_ENTITIES = ['lead','order','party','stock','reservation','sync_conflict']` and the socket handler bumps the counter only for those. `useRevision('document_export','document_template')` and `useRevision('option_list','custom_field')` would be permanently zero.
  - FIX: Delete `REFRESHING_ENTITIES` and bump `revisions[event.entity]` for every entity. Give `sync:conflict` its own synthetic key `'sync_conflict'` so the conflicts screen and the dashboard still move.
- **major**: H7 misdiagnoses the office staleness bug and omits the file that holds it. `masterConnection.on('change', onChange)` IS wired (office/src/http/app.ts:1347) and does send a masked `change` SSE frame (:1342). The gap is in the browser: `office/web/src/App.tsx:219-241` registers listeners for `status`, `snapshot` and `conflict` only. That file appears nowhere in the design's Files list.
  - FIX: Add `office/web/src/App.tsx` and have it listen for `change`, applying the event to its `view` state with the same upsert/remove shape `master-connection.ts` uses. Keep the small per-record frame; do not replace it with a snapshot push.
- **major**: `schedulePush` on every change re-creates the amplifier it is meant to remove. It replaces a few-hundred-byte masked record with a full `JSON.stringify` of the whole masked snapshot per flush. The snippet also has no `streams.size === 0` guard, so a module-scope listener builds and serialises a snapshot even with no browser open.
  - FIX: Keep `masterConnection.on('change')` sending the per-record frame. Use the coalescer only for the two events that genuinely need a whole view — `snapshot` and `sync.onSyncEvent` — and make it return immediately when `streams.size === 0`. Register the four listeners at module top level (not inside `createApp`, which office/tests calls 5+ times across three files).
- **major**: `retainExports: null → 180` bulk-deletes on the first sweep after deploy, on a system that has been accumulating PDFs. The design's own risk section says to run the first sweep only after the operator has seen the setting, then sets the default anyway. This project has already been bitten once by an irreversible data-shaped change.
  - FIX: Ship the pruning code and leave `retainExports: null` (no pruning) as the default. The Settings workstream turns it on. `null` must be an explicit "never prune" branch in `pruneExports`, not a falsy accident.
- **major**: `sharp.concurrency(1)` combined with a one-permit gate makes every upload both serial and single-threaded on a multi-core shop PC. The memory problem is unbounded parallel uploads each holding a ≤60 MB source plus two derived rasters; libvips thread count is not the cause.
  - FIX: Keep the gate. Set `sharp.cache({ memory: 64, files: 0 })` and leave `sharp.concurrency` at its default. Measure RSS before touching it further.
- **minor**: `shared/src/protocol/index.ts` does not exist. The directory contains backup.ts, desktop.ts, discovery.ts, pairing.ts, socket.ts. `DataChangedEvent`, `SyncSnapshot`, `ClientToServerEvents` and `ServerToClientEvents` all live in socket.ts.
  - FIX: Name `shared/src/protocol/socket.ts` throughout.
- **minor**: The stated H5 risk is wrong in both directions. `socket-contract.test.ts` parses only `ServerToClientEvents` (:44) — removing two client→server events will not fail it. And `maxHttpBufferSize` bounds inbound frames only; `document:preview` and `report:export` acks travel server→client and are not capped by it, so neither the claimed enforced ceiling nor the CSV-export risk exists. (Verified safe on the inbound side: `flush` batches at `config.sync.batchSize` = 100, office/src/config/index.ts:110.)
  - FIX: State that the cap bounds `sync:push` and `document:uploadAsset` only; 4 MB is comfortable against a 100-mutation batch and a 512 KB asset. Keep the real risk — a mixed-version rollout losing image upload — and ship both panels together.
- **minor**: The dedup example is fabricated. `AccessScreen.tsx:1685-1690`'s nested `DeletedRecordsScreen` calls `api.deletedRoles()` and `api.deletedUsers()`, not `api.roles()`/`api.users()` — different endpoints, nothing to dedup.
  - FIX: Drop the example. Dedup is still worth having for genuinely concurrent identical GETs, but do not justify it with a case that does not exist.
- **minor**: `pruneExports` is placed in `document.service.ts`, which owns templates and assets; exports live in `document-render.service.ts` and `document-export.repository.ts`. The design also hand-rolls `path.join(config.documents.exportsDir, `${key}.pdf`)`, duplicating `exportPathFor` (master/src/lib/document-files.ts:45), and ignores `removeStoredFile` (:123) and the stored `storage_path` column.
  - FIX: Put `pruneExports` in `document-render.service.ts`, return `storage_path` from the DELETE, and unlink via `removeStoredFile`.
- **minor**: Master's `update.service.ts` reads a releases folder and never downloads anything, so the "mirror it in the master's update.service.ts if it stages builds the same way" instruction has no answer. Separately, `downloadUpdate`'s early return for an already-intact file (office/src/services/update.service.ts:117-124) returns before the proposed cleanup, so a retry never prunes.
  - FIX: State plainly that the master needs no change. Move the cleanup to run on both exit paths, and swallow its errors — on Windows a running installer holds a lock.
- **minor**: `createGate(permits)` is a factory for a parameter that will only ever be 1, in a new file, for two call sites.
  - FIX: A five-line promise chain exported from `image.service.ts` and imported by `avatar.service.ts`. No new module, no permits parameter.
- **minor**: The `liveReferencesToProduct` Promise.all is churn. It runs on a hand-triggered delete, and when `runner` is a transaction the three queries serialise on the single connection anyway, so the change buys nothing measurable.
  - FIX: Do not touch it. Say so.
- **minor**: "A delta-replaying panel reaches byte-identical state to a snapshot-taking one" is unachievable, so the test that the design calls the only thing standing between it and silent divergence cannot be written as specified. `upsert` prepends (`master-connection.ts:575`) while `buildSnapshot` orders by name/id, and snapshot rows are rate-masked per actor while `data:changed` payloads are raw.
  - FIX: Assert equality as an id-keyed map with `sync.hlc` compared per record, ignoring array order, over the four replayable collections.
- **minor**: Several cited lines are wrong and one memo key crashes. `permissionSetForRole` is role.repository.ts:107 (not :106); `roleVersion` is :152 (not :146); `outbox.mutate` is :126 (not :120); `applyChange` :482, `removeFromSnapshot` :530, `requestFreshSnapshot` :554. The `broadcastDashboard` memo key dereferences `permissions.permissions` where `permissionSetForRole` may return null.
  - FIX: Correct the citations; build the key from `permissions?.permissions.join(',') ?? ''`.
- **minor**: Two test-seam and wiring omissions. `local-store.ts#resetLocalStore` (:348) must clear the new memo or every office test after the first reads a stale view. And `purgeExpiredSessions` is synchronous — hanging async prunes off `setInterval(purgeExpiredSessions, …)` at master/src/index.ts:120 needs its own try/catch, since the repo has no `unhandledRejection` handler.
  - FIX: Clear the memo in `resetLocalStore`; wrap the sweep body in `void (async () => { … })().catch(log.warn)`.
- **minor**: No test in the repo constructs a realtime hub, and `broadcastDashboard` / `emitPartyScopedChange` are module-private. The three new socket tests need a harness — a real `createRealtimeHub(httpServer)` plus socket.io-client connections, or new exports — that the design does not describe.
  - FIX: Export `broadcastDashboard` and `emitPartyScopedChange` under an `__testing` object and test them directly against `fixtures.ts`, rather than building a socket harness for three assertions.

## Corrected design

## H — Performance, API-call reduction, and memory management (corrected)

**Verdict.** Four amplifiers turn one action into N×M work: a per-request triple query, a per-socket-per-change dashboard aggregate, a per-reconnect full snapshot, and a per-SSE-stream full snapshot. Remove all four. Add **no** client cache library and no hand-rolled cache — workstream B's keep-alive removes the reason one was wanted. What is left is dedup, cancellation and per-entity invalidation.

Two things the original design got wrong that shape everything below: an in-memory permission read cannot tell "no permissions" from "no session", so it must never gate a disclosure; and the delta path must reuse the live path's *entire* withholding decision, not just its party check.

### H0 — What is actually hot

1. `broadcastDashboard` (hub.ts:846-886) — ~10 aggregates + 3 session queries **per admin socket, per change**. `getDashboardSummary` fans out ten `Promise.all` branches (dashboard.service.ts:33-45).
2. `buildSnapshot` (snapshot.service.ts:44) — 6 paged services × 500 rows + variants + pipelines + option lists + custom fields + 100 conflicts + a full dashboard + grants, on every reconnect and on every option-list/custom-field/pipeline edit (master-connection.ts:554).
3. `attachSession` (require-auth.ts:25) — 3 queries per HTTP request, two of them reading the same roles row.
4. Office SSE `pushView` (app.ts:1326) — full masked snapshot built and stringified per open stream.
5. `emitPartyScopedChange` (hub.ts:758) — 1 grants query per change plus 3 per recipient socket on a restricted party.

Everything else is cold. `liveReferencesToProduct` is **not being touched**: it runs on a hand-triggered delete, and its `runner` is often a transaction, where parallelism does not happen.

### H1 — Client: dedup, real cancellation, per-entity revisions

`request<T>` (master/web/src/api.ts:152, office/web/src/api.ts:180) gains a 15 s `AbortSignal.timeout`, an `'aborted'`/`'timeout'` `ApiError` code, and **refcounted** in-flight GET dedup:

```ts
const inFlight = new Map<string, { promise: Promise<unknown>; controller: AbortController; waiters: number }>();
```

Callers join an entry and increment `waiters`; a caller's own abort decrements it, and the shared `controller` aborts only at zero. Without the refcount, one unmounting screen kills every other consumer's in-flight GET — and `useResource` swallows `aborted`, so the survivor renders loading forever. POSTs never dedup. The timeout error keeps code `'timeout'` and message `t('splash.error.timeout')`, so App.tsx's splash text is unchanged; `withTimeout` (App.tsx:91) is deleted.

`useResource(fetcher, deps)` returns `{data, error, loading, reload}`, owns one AbortController per run, ignores `aborted`, and replaces every `let cancelled = false` block — a net deletion. It lands at `master/web/src/ui/useResource.ts` with a temporary duplicate at `office/web/src/ui/useResource.ts` (the house pattern the `icons.tsx` comment documents), both deleted when the shared web package arrives.

Invalidation: replace the single `dataRevision` (App.tsx:126) with `RevisionContext` + `useRevision(...entities)`. **Delete `REFRESHING_ENTITIES` (App.tsx:74)** — it filters the socket handler to six entities, so a per-entity revision for `document_export` or `option_list` would never fire. Bump `revisions[event.entity]` unconditionally, with a synthetic `'sync_conflict'` key for `sync:conflict`.

Not doing: normalised cache, optimistic mutations, retry. On loopback or one LAN hop a failure means refusal or a dead panel; `reload()` is the retry, pressed by a person.

### H2 — One query per request, at all five call sites

`user.repository.ts` gains `findByIdWithRole`, written as **its own query, not by editing `baseQuery`**: `USER_COLUMNS` plus exactly `r.name as role_name`, `r.tier as role_tier`, `r.permissions as role_permissions`, `r.version as role_version`, `r.deleted_at as role_deleted_at`, joined `on r.id = u.role_id AND r.tenant_id = u.tenant_id`. The tenant predicate is mandatory — `permissionSetForRole`'s comment (role.repository.ts:113-119) says matching on id alone is safety from a schema quirk. Editing `baseQuery` instead would put every role's permission array into every `listUsers` row, the mistake `USER_COLUMNS` exists to prevent. Returns `role: null` when `role_deleted_at` is set, preserving `whereNull('deleted_at')` semantics.

`role.repository.ts` extracts `permissionSetFromRow(tenantId, row)`; `permissionSetForRole` becomes query + that call, keeping the version-keyed cache (:35) as the single cache and the tier intersection in one place.

`auth.service.ts` gains `resolveSessionWithPermissions` and `resolveSessionDetailedWithPermissions`; the existing two become wrappers. **All five sites route through them**: `attachSession` (require-auth.ts:33/42), `adminActor` (hub.ts:727/735), `actorForRecipient` (hub.ts:810/818), `broadcastDashboard` (hub.ts:857/868), `resolvePanelActor` (panel-actor.service.ts:60/72). Fixing only `attachSession` would leave four siblings broken.

Measured budget: `GET /api/parties` is 3 auth + 2 list (`party.repository.ts:46` count, `:47` rows) = **5 today, 3 after**. The regression test asserts `<= 3`.

### H3 — The broadcast path

**H3a. Coalesce, then compute once per scope.** A 250 ms trailing `scheduleDashboard(io)` replaces the three `void broadcastDashboard(io)` calls (hub.ts:136, :168, :173); the timer is `unref`'d. Inside one flush, memoise on `${tenantId}|${scope.seesAll}|${scope.userId}|${permissions?.permissions.join(',') ?? ''}` — note the null guard; `permissionSetForRole` can return null. Two tabs of one admin share one set of aggregates. A dashboard is a sampled summary; trailing-edge sampling is semantically correct.

**H3b. Three queries per recipient socket become one.** Keep `grantsForParty` — one indexed lookup on `idx_party_access_party`. **No grant cache**: an unversioned whole-table cache invalidated from inside a transaction can be repopulated with pre-commit rows and stays wrong until restart, and a permanently stale grant map is a disclosure. The role cache survives that hazard only because it is version-keyed.

`actorForRecipient`'s master-admin branch calls `resolveSessionWithPermissions`. That preserves the null-on-dead-session behaviour exactly — a signed-out, deactivated or post-restart socket still emits nothing — which the proposed `sessionPermissions()` read could not, because it returns `[]` for an unknown token and cannot be told apart from a real empty permission set.

Consequently there is **no `refreshSessionsForRole`**. It would have had to fire from inside transactions that can still roll back (role.service.ts:165 with its G4 assertion after; user.service.ts:217), pushing uncommitted permissions into live sessions.

### H4 — Reconnect: replay, with the live path's full withholding rule

`master/src/realtime/change-ring.ts` (~60 lines): `BOOT_ID = randomUUID()`, a 2 000-entry ring, `record(event)`, `since(seq)`, `currentSeq()`, recorded from the existing `onChange` subscription at hub.ts:129. `DataChangedEvent` gains optional `seq` in **`shared/src/protocol/socket.ts`** (there is no `protocol/index.ts`). New `sync:delta` command beside `sync:request` (hub.ts:321).

`buildDelta` falls back to the unchanged `buildSnapshot` whenever: `bootId !== BOOT_ID`; `since()` returns null; or any buffered event's entity is not replayable. **Replayable is exactly what `applyChange` handles** — lead, party, product, product_category, order, stock. Everything else forces a snapshot: `option_list`, `custom_field`, `pipeline`, and — the omission that would have shipped silent divergence — **`party_variant`, `sync_conflict`, `reservation`**, none of which `applyChange` has a case for. Export one `REPLAYABLE_ENTITIES` constant so the two lists cannot drift, and pin in `change-ring.test.ts` that every `ChangedEntity` (socket.ts:230-247) is in exactly one bucket.

Every replayed event passes through one shared `mayReceive(actor, event, grants)` extracted from the live fan-out, which applies all three rules in order: skip `DIRECTORY_ENTITIES` (role, user, document_export — hub.ts:147-149); party-scope `PARTY_SCOPED_ENTITIES` through `levelFor`; pass the rest. Replaying without the directory filter would hand every panel the whole staff list and every role's permission array.

`permissions`, `partyGrants` and `dashboard` ride along, since a role or grant can change while a panel is offline. `grantsForUser`'s `partyIds` becomes optional (`partyIds?: readonly string[]`) — omitted means all of the caller's own grants, which is not a leak; an explicitly empty array still returns `[]`.

Panel side: on `connect`, **hydrate first** — `this.snapshot ??= await localStore.restore()` — and send a cursor only when both that and a persisted `{bootId,lastSeq}` exist. `MasterConnection.snapshot` is otherwise set only by `sync:snapshot`, and `applyChange` returns early on null (:483), so a restarted panel would have discarded every replayed event. `applyChange` calls a 2 s trailing, `unref`'d `localStore.persistCurrent()` — the two modules share one object reference (`setSnapshot` stores `next` directly, local-store.ts:40), so memory is current and disk is stale today. `requestFreshSnapshot` (:554) is debounced 500 ms; editing a 20-value option list currently pulls 20 snapshots per panel. hub.ts:282's unconditional `sync:snapshot` fires only when no usable cursor is presented.

`SNAPSHOT_LIMIT = 500` stays. The ring removes the reason it had to; raising it is a correctness decision about the offline working set and belongs to the catalogue workstream.

### H5 — Bytes off the command channel

`maxHttpBufferSize` = 60 MB (hub.ts:90) applies to **inbound frames only**; `document:preview` and `report:export` acks travel server→client and are not capped by it, so the cap is neither a ceiling on them nor a risk to them.

New `master/src/http/middleware/require-panel.ts` reads `x-orderbook-panel-id`, `x-orderbook-panel-secret` **and `x-orderbook-acting-token`**, verifies the pair with `panelService.authenticatePanel`, then resolves the actor with `resolvePanelActor` and attaches it to `req`, rejecting 401 when `tokenAccepted` is false. Panel-secret-only auth would run uploads as the panel's fallback role instead of the signed-in person, changing permission outcomes and mis-attributing every image in the audit trail.

`master/src/http/routes/panel-image.routes.ts` mounts POST `/api/panel/products/:productId/images` (reusing images.routes.ts:20's multer memory storage and `MAX_SOURCE_BYTES`) and GET `/api/panel/images/:imageId/:variant` (`res.sendFile` after `resolveImageFile`). The office proxy (app.ts:290, :323) swaps the two socket commands for `fetch` + `pipeline(response.body, createWriteStream(localPath))`, copying `update.service.ts:128`. It already caches to disk with `immutable` headers, so this is a transport swap.

Then drop `maxHttpBufferSize` to 4 MB and delete `product:image:upload` / `image:fetch`. Safe on the inbound side: `flush` batches at `config.sync.batchSize` = 100 (office/src/config/index.ts:110) and `maxAssetBytes` is 512 KB. `socket-contract.test.ts` will not fail — it parses `ServerToClientEvents` only (:44) — but a mixed-version rollout loses image upload, so ship both panels together. Add `perMessageDeflate: { threshold: 1024 }`.

**Rasters.** Root cause is unbounded concurrent uploads each holding a ≤60 MB source plus two derived rasters. A five-line promise-chain gate exported from `image.service.ts` and imported by `avatar.service.ts` (they contend for one libvips heap) serialises both pipelines — no `createGate(permits)` factory for a value that is always 1. Add `sharp.cache({ memory: 64, files: 0 })`. **Leave `sharp.concurrency` alone**: pinning it to 1 makes every upload single-threaded as well as serial. Delete `readBackMaster` (:118) and checksum the master variant's in-hand `data` buffer.

### H6 — Things that only grow

- **`failures` map** (auth.service.ts:48): sweep inside `purgeExpiredSessions` (:297), which already runs on the 15-minute interval at index.ts:120. `resetAuthState` (:292) already clears it for tests.
- **Update downloads** (office update.service.ts): after a passing checksum *and* on the already-intact early return (:117-124), `readdir` the updates directory and `rm` everything else, swallowing errors — a running installer holds a lock on Windows. The **master needs no change**: its `update.service.ts` reads a releases folder and never downloads.
- **Document exports**: add `pruneExports(tenantId)` to `document-render.service.ts` (where exports live), returning `storage_path` from the DELETE and unlinking via `removeStoredFile` (document-files.ts:123) rather than rebuilding the path — `exportPathFor` (:45) already exists. **`config.documents.retainExports` stays `null`**, with `null` an explicit "never prune" branch. Turning it on is the Settings workstream's call; defaulting it to 180 would bulk-delete a year of PDFs on the first sweep after deploy, and this project has been bitten once already by an irreversible change.
- **Orphaned image variants**: sweep at **startup only**, beside the existing `sweepOrphanTemporaries()` at index.ts:99 — that helper's comment says why (nothing else is writing). On the timer it would race `normalizeAndStore`, which writes four `.webp` files before the row is inserted, and delete a live upload.
- Async work hung off the 15-minute timer needs its own `.catch` — there is no `unhandledRejection` handler.

**Not doing:** `outbox.store.ts`'s whole-file write. Its comment (:8-13) is right — temp-then-rename is atomic, a torn record is a lost sale, and the queue drains in seconds.

### H7 — Office panel

`streamEvents` registers its `res.write` in a module-level `streams` set; the four `masterConnection.on(…)` handlers move to **module top level**, not inside `createApp` — office/tests calls `createApp()` 5+ times across `dashboard-staleness`, `module-forwarding` and `snapshot-masking`.

Only the two events that need a whole view — `snapshot` and `sync.onSyncEvent` — go through a 120 ms trailing coalescer that builds `forCurrentUser(view)` **once** and writes the same frame to every stream. `forCurrentUser` (app.ts:1059) reads `userSession.sessionPermissions()`, and there is exactly one signed-in person per panel (`let current` at user-session.service.ts:66), so the payload is identical for every stream. The coalescer returns immediately when `streams.size === 0`.

`masterConnection.on('change')` keeps sending the small masked per-record frame. It is **already wired** (app.ts:1342/:1347) — the real gap is that the browser never listens: `office/web/src/App.tsx:219-241` handles `status`, `snapshot` and `conflict` only. Add a `change` listener there that upserts/removes into `view` with the same shape `master-connection.ts:482-551` uses. Routing `change` into a full snapshot push instead would re-create amplifier #4.

`getView` memo: `{ snapshotRev, outboxRev, view }`. `outbox.store.ts` exports `revision()`, incremented in `mutate` (:126). `local-store.ts` keeps a `snapshotRev` bumped by `setSnapshot` and by `applyChange` (the object is mutated in place, so identity is useless). `resetLocalStore` (:348) must clear the memo. Safe: the only two callers are app.ts:230 and :1326, and `forCurrentUser` is pure.

**Ack timeout** (master-connection.ts:337-379): replace the hand-rolled `setTimeout` with `socket.timeout(15_000).emitWithAck(...)`, the same library call `requestFromPanel` already uses (hub.ts:918). Unwrap `result.ok` exactly as today. ~25 lines deleted. Add `setMaxListeners(0)` to sync.service.ts:37 and master-connection.ts:95 as belt-and-braces.

### H8 — Pool

`master/src/db/knex.ts:16`: add `acquireTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, reapIntervalMillis: 5_000`. `max: 10` stays — after H3a nothing bursts past it. The acquire timeout converts "the panel froze" into a logged `TimeoutAcquiringConnection`.

### H9 — Measurement

`master/src/db/query-counter.ts`: `AsyncLocalStorage` + `knex.on('query')`, an Express middleware logging `${method} ${path} ${count}q ${ms}ms` at debug and setting `X-Query-Count`/`X-Duration-Ms` outside production. Extend `/api/health` (app.ts:36) with `rss`, `heapUsed`, `sessions`, `panelSockets`, `adminSockets`, `changeRingSeq`.

Tests, all in the existing Vitest layout:

- `query-budget.integration.test.ts` — one authenticated `GET /api/parties` asserts `<= 3` (measured: 5 → 3).
- `broadcast-coalescing.integration.test.ts` and the party-scope assertions — export `broadcastDashboard` and `emitPartyScopedChange` under an `__testing` object and drive them against `fixtures.ts`. No test in this repo constructs a hub; building a socket.io harness for three assertions is not worth it.
- `change-ring.test.ts` — pure: monotonicity, wrap, bootId mismatch, and **every `ChangedEntity` is either replayable or forces a snapshot**.
- `sync-delta.integration.test.ts` — a delta-replaying panel and a snapshot-taking one compared as **id-keyed maps with `sync.hlc` per record, order-insensitive**, over the replayable collections. Byte-identical is unachievable: `upsert` prepends (master-connection.ts:575) while `buildSnapshot` orders by name/id, and snapshot rows are rate-masked per actor while `data:changed` payloads are raw.
- Extend `party-access.integration.test.ts`: a grant written through `replaceGrants` is honoured by the very next `emitPartyScopedChange`, and a socket whose session has been invalidated receives nothing.
- Extend `credential-invariants.test.ts`: `findByIdWithRole` returns no `password_hash` and no role permissions on `User`. That file already asserts `not.toContain("select('u.*'")`, which named columns satisfy.
- Extend `images.integration.test.ts`: three concurrent uploads serialise through the gate; the panel route refuses a wrong secret with 401 **and** refuses a valid secret with a rejected acting token.
- `office/tests/sse-coalescing.test.ts` and `local-store-memo.test.ts`; extend `outbox.test.ts` with `revision()`.

No continuous benchmark: on a shop PC with an embedded Postgres and a 35 s `initdb` it is noise that reads like signal.

### Migrations

**None.** The delta replays buffered events rather than scanning for rows newer than a cursor, so no sequence column and no index. An `(tenant_id, hlc)` index was considered and rejected: `hlc` is nullable TEXT on pre-sync rows, so the predicate degrades and the index stops helping. If a future workstream adds one, the registry rules apply in full — file, import in `master/src/db/migrations/index.ts`, array entry after `20260313000000_party_access` and before the pinned `20260309000000_new_module_permission_grant` final slot, `SHIPPED` entry once it reaches a real installation, and a `DATA_TABLES` entry in `master/tests/helpers/fixtures.ts` in FK order if a table is added.

### Dependencies

Workstream B lands first (it is what makes "no cache" right). The ui/ de-duplication workstream eventually owns `useResource`. The searchable-dropdown workstream depends on H1's dedup and refcounted abort. The Settings workstream owns `retainExports`. Anything editing `shared/src/protocol/socket.ts` should sequence around H5.