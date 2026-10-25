# Brief: work/product-order-bundle — no-collide lanes (OpenCode + Muse lane)

Owner (order-note bundle): OpenCode (Qwen via OpenCode). Owner (product-alteration
bundle + import-review fixes): Muse lane. Coordinator (this brief only, no source
touched): Command Code.

## Goal

Two bundles share the uncommitted branch `work/product-order-bundle` and their file
sets overlap, so a concurrent product-alteration edit currently breaks suite
collection and the web typechecks for the order-note bundle. OpenCode reads
`docs/AI_COLLABORATION.md` §§2/5/6/8 first, then each lane edits only its own file
set below (shared files go serially, OpenCode first), runs targeted suites until the
other lane compiles, and nothing merges until one full `npm run verify` exits 0.

## Read first

1. `docs/AI_COLLABORATION.md` §2 (roles), §5 (this protocol), §6 (verify gate),
   §8 (shared-model collab: coordinate through files not chat, one owner per file
   set, `git pull --rebase` before pushing, never commit to `main` from two tools
   at once).
2. `HANDOFF.md` current state (read-only until close; its update happens once, at
   merge).
3. The file sets below. If a file you need is not in your set, stop and append a
   note under Implementer reports instead of editing it.

## OpenCode owns — the Muse lane does not touch (order-note bundle)

Includes the additive migration already on this branch:

- `master/src/db/migrations/20261025000000_note_columns.ts`,
  `master/src/db/migrations/index.ts`, `master/tests/migration-registry.test.ts`
- `master/src/domain/lead-pdf.ts`, `master/src/pdf/note-renderer.ts`,
  `master/tests/note-pdf.test.ts`
- `master/src/repositories/mappers.ts`, `master/src/services/company-features.ts`,
  `master/src/services/lead.service.ts`, `master/src/services/order.service.ts`,
  `master/src/services/sync.service.ts`
- `master/src/http/routes/data.routes.ts`,
  `master/src/http/routes/panel-catalog.routes.ts`
- `master/web/src/screens/LeadsScreen.tsx`, `master/web/src/screens/OrdersScreen.tsx`
- `office/src/sync/local-store.ts`, `office/web/src/screens/LeadBoardScreen.tsx`,
  `office/web/src/screens/OrderBoardScreen.tsx`
- `shared/src/domain/columns.ts`, `shared/src/domain/company-features.ts`,
  `shared/src/domain/entities.ts`, `shared/src/domain/inputs.ts`,
  `shared/src/domain/order-note.ts`, `shared/src/domain/settings.ts`
- `shared/tests/company-features-resolve.test.ts`,
  `shared/tests/new-order-name.test.ts`, `shared/tests/settings.test.ts`
- `ui/src/NoteDocumentPortal.tsx`, `ui/src/OrderNote.tsx`,
  `ui/src/OrderNoteScreen.tsx`, `ui/src/order-note.css`
- `ui/tests/form-controls-design.test.ts`, `ui/tests/master-shell.test.tsx`,
  `ui/tests/office-shell.test.tsx`, `ui/tests/order-note-screen.test.tsx`

## Muse lane owns — OpenCode does not touch (product-alteration + import review)

- `shared/src/domain/product-alteration.ts` (new),
  `master/src/services/product-alteration.service.ts` (new),
  `master/tests/product-alteration.integration.test.ts` (new)
- `ui/src/ProductConflictsScreen.tsx` (new), `ui/src/ProductEditScreen.tsx` (new),
  `ui/src/ProductSmartReview.tsx` (new)
- `master/src/services/product-import.service.ts`,
  `shared/src/domain/product-import.ts`
- `master/web/src/screens/ProductsScreen.tsx`,
  `master/web/src/screens/DuplicatesScreen.tsx` (deleted by this lane),
  `office/web/src/screens/CatalogScreen.tsx`, `ui/src/SubProductsScreen.tsx`,
  `ui/src/catalogueSummary.ts`, `master/web/src/transports.ts`,
  `office/src/http/app.ts`, `master/web/src/App.tsx`, `ui/src/index.ts`

## Shared — serial handoff only, OpenCode first

- `shared/src/i18n/en.ts`, `shared/src/index.ts`, `master/web/src/api.ts`,
  `office/web/src/api.ts`, `office/web/src/App.tsx`,
  `ui/tests/master-catalogue.test.tsx`, `docs/AI_COLLABORATION.md` (append-only log:
  one entry per change, never rewrite another agent's entry).
- Rule: OpenCode finishes its shared-file edits first and records them below; the
  Muse lane then applies only its queued additions (e.g. the
  `product.smart.reason.unchanged` key, product-alteration exports) and re-runs the
  touched suites. Never edit these files concurrently.

## Done looks like

1. OpenCode appends an acknowledgment below (read §§5/6/8, accepts its set, names
   its targeted verify line).
2. The Muse lane's untracked files compile — today they break suite collection and
   the web typechecks, which blocks full verify and is owned by the Muse lane.
3. Each bundle green on its targeted suites with pass + skip counts recorded below;
   then one full `npm run verify` (lint + typecheck + tests) exit 0 before merge.
4. Merge `work/product-order-bundle` to `main`, delete it, update `HANDOFF.md`. One
   pusher; `git pull --rebase` before pushing; never commit to `main` from two
   tools at once.

## Constraints

- Offline-only runtime; English-only strings via `t()`; desktop floor 1024x768. No
  new migrations (note_columns already landed on this branch); migrations only add
  — `migration-data-safety` stays green; never delete or rewrite a migration.
- While the other lane's mid-edit files break collection, run targeted vitest files
  only and name the block; a green subset is not a green gate.
- Integration suites skip without PostgreSQL — record skip counts, not just passes.

## Implementer reports (append below this line, newest last)

---

### 2026-10-25 - Coordinator note (Command Code, no source touched)

- Wrote this brief so OpenCode reads `docs/AI_COLLABORATION.md` §§2/5/6/8 and both
  lanes stay in their file sets on `work/product-order-bundle`.
- Verified: brief carries goal, exact paths, done criteria, constraints and owners
  per §5; `shared/tests/company-features-resolve.test.ts` 7/7 green as a smoke
  check; `git status` shows no source edits from this session (only this new brief
  plus the `docs/AI_COLLABORATION.md` change-log entry).
- Left: OpenCode's acknowledgment below; full `npm run verify` once the
  product-alteration lane compiles; `HANDOFF.md` update at merge/close.

### 2026-10-25 - Muse-lane contention finding (Muse Code, no source touched)

- Full `npm run test` started 21:29 finished ~22:27: 317 files passed / 96
  failed (+1 skipped), 4904 tests passed / 518 failed / 135 skipped. The
  failures are shared-cluster contention, not code: `deadlock detected`,
  `terminating connection due to administrator command` (the cluster log shows
  a fast shutdown at 22:27:17 mid-run), and FK violations from cross-run
  interference. Three other full-suite/verify runs (started 22:02-22:09) use
  the same `%TEMP%\orderbook-test-pg` cluster on port 55433; their processes
  were left alone.
- Next: re-running the suite isolated per the HANDOFF recipe
  (`TEMP`/`TMP` = `.tmp\test-tmp-muse`, `ORDERBOOK_TEST_PG_PORT=55479`).
- Ask: lanes serialize full verify runs, or isolate each run the same way, or
  the red/green signal stays meaningless.

### 2026-10-25 - Muse-lane gate complete; merge discipline (Muse Code, docs only)

- Gate: full `npm run test` exit 0 isolated (413 files passed + 1 skipped,
  5540 tests passed + 17 skipped, PG ran); `npm run lint` exit 0;
  `npm run typecheck` exit 0. No source touched by this lane since.
- The parallel session's isolated verify is still in flight. First green gate
  takes the merge + `HANDOFF.md` update + 1.5.3 bump + release notes + push,
  once — this lane will not duplicate it. Owner's goal is the pushed bump;
  the OpenCode ack is still owed but the owner directed proceeding.
- This lane's source set is frozen till the merge lands; any new fix goes in
  as a new report below, not a silent edit.

### 2026-10-25 - Targeted re-check (Command Code, no source touched)

- The Muse lane's previously mid-edit files now compile: `ui/tests/master-shell`
  163/163 and `ui/tests/office-shell` 108/108 collect and pass, so the collision
  block named in this brief is cleared.
- Green this round: master-shell 163, office-shell 108, master-catalogue 43,
  order-note 64, order-note-notes 11, note-pdf 11, order-note-screen 31,
  form-controls 14, migration-registry 7, migration-data-safety 4,
  company-features-resolve 7, company-features-complete 2, settings 117,
  new-order-name 4, wire-optionality 7, keys-implemented 4, apply-setting-change 4,
  office outbox 23 — 624 tests, 0 failures.
- Full `npm run verify` kicked off in the background (task s185g5vv); result to be
  recorded here when it lands. Merge to `main` still waits on that green gate.
