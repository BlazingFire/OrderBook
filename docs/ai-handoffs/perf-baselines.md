# Brief: `perf-baselines` (Phase 0) — COMPLETE, numbers below

Implement: Command Code. Review: Claude. **Measurement only — no code committed** (plan: "numbers into the brief, no commits").
Run date: 2026-10-26 (session of the approved plan, `~/.commandcode/plans/performance-blazing-fast.md`).

## Environment (scratch only — never the owner's `order_book`)

- Tree: `main` @ `0944dc61` + docs commit `9222e9bf` (Muse lane's `clean/dedup-styles-dead-keys` was checked out during the run; its 3 dirty files — `styles.css`, `base.css`, `en.ts` — are parked by that lane, untouched here).
- Scratch Master 1.5.4, `PORT=5410`, embedded PG `ORDERBOOK_PG_PORT=55483`, private `TEMP/TMP=.tmp/perf-b0/tmp`, `ORDERBOOK_DATA_DIR=.tmp/perf-b0/data`, `ORDERBOOK_RELEASES_DIR=.tmp/perf-b0/releases`, `ORDERBOOK_RELEASES_POLL_MINUTES=0`.
- Data: `seed:sample` (13 leads / 19 orders — the fixture volume is hardcoded, no knob) + **API bulk**: 235 leads created + 112 converted → **136 pending, 131 final** (≥100 each as the plan requires). Server stopped clean afterwards (`pg_ctl stop -m fast`), no orphan processes.

## 1. HTTP query counts / durations (`X-Query-Count`/`X-Duration-Ms`, already emitted by `master/src/db/query-counter.ts` in dev — no code needed)

5 runs each; #1 is cold, #2-5 warm (1.4.3 request cache):

| Endpoint | Cold | Warm |
|---|---|---|
| `GET /api/leads?limit=100` (100 rows) | **5q / 6 ms** | 1q / 1-2 ms |
| `GET /api/orders?limit=100` (100 rows) | **5q / 13 ms** | 1q / 1-2 ms |
| `GET /api/leads/stage-counts` | 2q / 2 ms | 1q / 1-2 ms |
| `GET /api/orders/stage-counts` | 2q / 2 ms | 1q / 1 ms |
| `GET /api/dashboard` | **13q / 6 ms** | 1q / 1-3 ms |

**One lead edit (POST `/api/leads/:id/stage`): 16q / 6-13 ms** (includes session resolve; fan-out portion measured separately in §3).
**100 writes: 2.4 s wall (avg 24 ms/write incl. HTTP round trip).**

Verdict vs targets: list open <300 ms warm → measured **1-13 ms**, huge headroom. P18A's count budgets line up: `listLeads ≤5` ✓ (exactly 5 cold at HTTP level incl. auth), `stageCounts ≤2` ✓, dashboard cold 13q is the **P4 target** (11 counts → 2 GROUP BYs).

## 2. Reconnect `buildSnapshot` (TEMP knex counter in `snapshot.service.ts`, triggered via `snapshot-party-access.integration.test.ts`)

Fixture data is small, but these are count-shaped (same queries at any volume):

- Full-permission snapshot: **26-36q total**, batch1 (the five list collections) 10-16q, wall **4-49 ms** (typical 26q/10-13 ms).
- Worst observed: **36q / 10-11 ms** (actor holding `sync.resolveConflicts` → conflicts read included).
- Scoped / view-only actors: 7-14q.

**Note for P18A:** the budget `buildSnapshot ≤35 queries` is already touched (36q baseline). Either P3 must shave the resolve/grants reads first or the budget starts at 40 — decision at P18, baseline is this number.

## 3. Fan-out per write (TEMP counters in `hub.ts`: grants / emits / session-resolves, triggered via `panel-push.integration.test.ts` with live sockets)

- Party-scoped change with one entitled recipient: **`grants=1, emits=1, resolves=1`**.
- Change with no entitled recipient: `grants=1, emits=0, resolves=0`.
- Shape: **1 `grantsForParty` query per change + 1 `resolveSessionWithPermissions` (1 query) + 1 emit PER connected recipient** — linear in recipients. Dashboard push (`scheduleDashboard`) is debounced and separate.
- **Baseline for P3's ≤7 emits / ≤10 DB reads budget:** with N recipients the fan-out costs ≈ 1 + N queries today; N ≥ 7 already exceeds the 10-read budget, which is exactly the hole the actor cache (2 s TTL) must close.

## 4. Memory (`/api/health` `runtime.rssBytes`)

- Idle after boot: **110.7 MiB** (116,047,872 B).
- Working (seeded data + bursts): **135.5 MB → 137.1 MB across a 100-write burst (+1.6 MB, no leak signature)**.
- P18A ceiling basis: idle + 20 % ≈ **133 MiB** ceiling to confirm at P18.

## 5. Browser profiler on a 100-row board — **NOT DONE**

No browser session in this run (headless pass would need the agent-browser lane; layout/fps is anyway named manual in the plan). Owed with the P18 manual pass; reason recorded per plan's "NOT DONE with reason" rule.

## 6. UI motion baseline (static inventory — input for P19's motion audit)

- **14 intervals:** `ui/src` 7 — `Clock.tsx:34` (500 ms), `PrintStationRunner` heartbeat, `SellTodayPopup` countdown, `SettingsLayout` deadline, `UpdateRun`, `useRecordPresence` beat, `UpdateProgress`; `master/web` 2 — `PanelsScreen` clock, `UpdatesScreen` poll; `office/web` 5 — `App.tsx:704` connection refresh (1.5 s), `ConnectionScreen`, `UpdatesScreen` (30 s), `UpdateRequiredScreen`, `SetupScreen` seconds.
- **27 CSS `@keyframes`:** 10 in `ui/src/base.css` (rail, indeterminate, modal in/out, pop-in, toast in/out, card-in, drawer in/out), 17 in `ui/src/mark.css` (busy ×2 + 15 splash `ob-sp-*`).
- No `requestAnimationFrame` loops; only one-shot copy-feedback timeouts.

## 7. Kill points for the P18 chaos drills (entry points)

- **mid-restore:** `restoreProductZip` progress (`master/src/services/product-zip.service.ts`).
- **mid-flush:** Office outbox `flush()` (`office/src/sync/`).
- **mid-print:** printroom claim → runner (`master/src/services/print.service.ts` claim/markQueued + `ui/src/PrintStationRunner.tsx`).
- **mid-backup:** `.obbackup` write (`master/src/services/backup-export.service.ts`).

## Stability sign-off

- Temp counters in `hub.ts` + `snapshot.service.ts` **removed** (`git checkout --` both; `git status` shows only the Muse lane's parked files) — nothing from this phase is or will be committed.
- Scratch state only under `.tmp/perf-b0/` (gitignored); scratch PG stopped clean; no ports left bound (5410/55483 free).
- Reviewer re-check: any list-open header — `npm run seed:sample` on a scratch dir + `measure.ps1` (in session scratchpad) reproduces §1 in one command.

## Done

All plan-§0 measurements captured except §5 (NOT DONE, reason above). Kill points named. Motion baseline collected. Next: **Phase 1 `dedup-cleaner-ia`** (see plan; note overlap — Muse's parked `dedup-styles-dead-keys` already covers a slice of 1J's dead-key sweep).
