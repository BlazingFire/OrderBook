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
- `master/web` and `office/web` have **zero** test files. UI defects are invisible to
  `verify` — treat browser/Electron manual passes as real.

## Hard rules (from AGENTS.md — do not re-decide)

- **Never delete or rewrite a migration** that may have run anywhere.
- **Single-writer**: Master owns all persistent state; Office panels forward writes.
- **Offline-only runtime**: nothing loads from a CDN or calls the internet.
- **Docs and code live separately** — prose in `docs/`, source in the workspaces.
- **No pricing anywhere (removed 2026-09-21); no AI assistant.**
- **Work lands on `main`**, directly or through `dev` (reset to `main` 2026-09-22).
  Every other branch is retired.
- **A guard must be seen to fail** against the defect it targets before it is accepted.

## What is open (as of 2026-09-22)

`docs/NEXT_PHASE.md` is the answer, in order. The short version: every branch
was merged into `main` on 2026-09-22 and the full suite ran green with the
integration suites (140 files / 1707 tests), but nothing merged that day was
seen in a browser or Electron. Four owner decisions block a customer release
(1.0.3 data, signing key, code-signing certificate, Recycle Bin retention),
and four briefs remain in `docs/ai-handoffs/`.

## Environment

- Windows 11, PowerShell 5.1: `&&`/`||` don't work — use `;` or `if ($?) {}`.
- npm 12 blocks install scripts — approve native modules with
  `npm install-scripts approve <pkg>`.
- Owner's PC uses an external PostgreSQL via `.env` `DATABASE_URL`; the bundled path's
  fallbacks are `DATABASE_URL` or `ORDERBOOK_PG_BIN`.
