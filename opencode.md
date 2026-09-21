# OpenCode — Project Context

Lean companion to `AGENTS.md` (the canonical project memory — **read that first**).
This file only says where the truth lives and what is open. Do not duplicate
`AGENTS.md` / `HANDOFF.md` content here.

## Read order (every session)

1. `HANDOFF.md` — current state, decisions, traps, owed work.
2. `docs/AI_COLLABORATION.md` — the multi-agent workflow + handoff protocol. **Update
   its Change log after each prompt that changes the repo.**
3. `docs/PROJECT_PLAN.md` — architecture source of truth.
4. `docs/schema/` — every table/column/index.

## Standing gate

- `npm run verify` = lint + typecheck (all workspaces) + full test suite. Run the three
  steps **separately and check each exit code** — a single-project `tsc` is narrower
  than the gate and misses cross-workspace breaks.
- `npm run build` — shared, both servers, both frontends.
- Integration tests auto-skip when PostgreSQL is absent; a skipped suite prints like a
  green one, so check that it ran.
- `master/web` and `office/web` have **zero** test files. UI defects are invisible to
  `verify` — treat browser/Electron manual passes as real.

## Hard rules (from AGENTS.md — do not re-decide)

- **Never delete or rewrite a migration** that may have run anywhere.
- **Single-writer**: Master owns all persistent state; Office panels forward writes.
- **Offline-only runtime**: nothing loads from a CDN or calls the internet.
- **Docs and code live separately** — prose in `docs/`, source in the workspaces.
- **No pricing outside `pricing.enabled`; no AI assistant.**
- **Work lands on `main`.** `dev` is historical.
- **A guard must be seen to fail** against the defect it targets before it is accepted.

## What is open (as of 2026-09-14)

See `HANDOFF.md` → "Owed work". All of it is manual verification (responsive gate,
keep-alive walk, new-lead flow on both panels, PDF Designer click-through, packaged
install/uninstall) plus rebuilding the 1.1.0 installers on a machine where
electron-builder runs.

## Environment

- Windows 11, PowerShell 5.1: `&&`/`||` don't work — use `;` or `if ($?) {}`.
- npm 12 blocks install scripts — approve native modules with
  `npm install-scripts approve <pkg>`.
- Owner's PC uses an external PostgreSQL via `.env` `DATABASE_URL`; the bundled path's
  fallbacks are `DATABASE_URL` or `ORDERBOOK_PG_BIN`.
