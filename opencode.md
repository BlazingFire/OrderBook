# OpenCode — Project Context

Lean companion to `AGENTS.md` (the canonical project memory — **read that first**).
This file only says where the truth lives and what is open. Do not duplicate
`AGENTS.md` / `HANDOFF.md` content here.

## Read order (every session)

1. `HANDOFF.md` — current state, decisions, traps, owed work.
2. `docs/STRUCTURE.md` — the whole software and its code in one file: layout, every
   file, schema, main flows, tests, and where a given change goes.
3. `docs/AI_COLLABORATION.md` — the multi-agent workflow + handoff protocol. **Update
   its Change log after each prompt that changes the repo.**
4. `docs/PROJECT_PLAN.md` — architecture source of truth.
5. `docs/schema/` — every table/column/index.

## Standing gate

- `npm run verify` = lint + typecheck (all workspaces) + full test suite. Run the three
  steps **separately and check each exit code** — a single-project `tsc` is narrower
  than the gate and misses cross-workspace breaks.
- `npm run build` — shared, both servers, both frontends.
- Integration tests auto-skip when PostgreSQL is absent; a skipped suite prints like a
  green one, so check that it ran.
- `master/web` and `office/web` have no test files of their own, but
  `ui/tests/master-shell.test.tsx` and `ui/tests/office-shell.test.tsx` boot each
  panel's `App.tsx` whole in jsdom (`ui/tests/panel-harness.ts`), so `verify` does see
  which screen a key, toast or link lands on, what a form sends, and the splash's
  errors. Layout, styling, anything visibility-dependent and the running Electron
  shell are still invisible to it — treat browser/Electron passes as real.

## Hard rules (from AGENTS.md — do not re-decide)

- **Never delete or rewrite a migration** that may have run anywhere.
- **Single-writer**: Master owns all persistent state; Office panels forward writes.
- **Offline-only runtime**: nothing loads from a CDN or calls the internet.
- **Docs and code live separately** — prose in `docs/`, source in the workspaces.
- **No pricing anywhere (removed 2026-09-21); no AI assistant.**
- **Work lands on `main`**, directly or through `dev` (reset to `main` 2026-09-22).
  Every other branch is retired.
- **A guard must be seen to fail** against the defect it targets before it is accepted.

## What is open

Do not keep a copy here — it goes stale. `HANDOFF.md` → **Owed work** is the list
and `docs/NEXT_PHASE.md` is the order to take it in. The suite stands at 160 files /
2015 tests (2026-09-25).

## Environment

- Windows 11, PowerShell 5.1: `&&`/`||` don't work — use `;` or `if ($?) {}`.
- npm 12 blocks install scripts — approve native modules with
  `npm install-scripts approve <pkg>`.
- Owner's PC uses an external PostgreSQL via `.env` `DATABASE_URL`; the bundled path's
  fallbacks are `DATABASE_URL` or `ORDERBOOK_PG_BIN`.
