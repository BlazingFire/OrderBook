# Project Memory

## What this project is

**OrderBook** — an offline, LAN-only order & inventory management web app for a
ceramic company. **No internet access at any point, ever** (at runtime). Two
cooperating Electron-wrapped web apps:

- **Master Panel** — one PC; owns the PostgreSQL database and all files. Every
  write goes through it.
- **Office Panel** — other PCs on the same LAN; thin clients that create leads,
  manage parties/products, and push leads to orders. No database of its own.

## Source of truth — read these before assuming

- **`HANDOFF.md`** (root) — running record of decisions and current status. Read first in any session.
- **`docs/PROJECT_PLAN.md`** — architecture source of truth (requirements, pairing, screen flows).
- **`docs/schema/`** — every table, column, index, and rationale.
- **`docs/overhaul/`** — the 13-stage overhaul programme; per-workstream corrected designs.
- **`docs/AI_COLLABORATION.md`** — the three-agent (Command Code / Claude / Qwen via OpenCode) workflow, roles, handoff protocol, and change log. **Update its Change log after each prompt** that changes the repo.

## Verification gate

- `npm run verify` = lint + typecheck (all workspaces) + full test suite. Currently
  1300+ tests across 100+ files. **A change is not done until this passes.**
- `npm run build` — builds shared, both servers, both frontends.
- Integration tests need PostgreSQL and skip automatically when unavailable
  (see `tests/helpers/db.ts`); `fileParallelism:false` is deliberate.

## Standing conventions

- **Never delete or rewrite a migration** that may have run anywhere
  (`master/src/db/migrations/`, pinned by `migration-registry.test.ts`).
- **Documentation and code live separately** — prose in `docs/`, source in the
  workspaces. No source-of-truth doc buried in a code comment.
- **Single-writer**: the Master owns all persistent state. Office panels forward
  writes over Socket.IO; they never write their own database.
- **Runtime is offline-only**: nothing loads from a CDN or calls the internet.
  Bundled fonts/assets only. `.env` config is optional (see `.env.example`).
- **Vendored skills** (`.claude/skills/` and `.agents/skills/`, kept byte-identical)
  are shared tooling — read them, don't edit them.
- **Monorepo layout**: `shared/` (types + Socket.IO + discovery protocol),
  `ui/` (shared React kit), `master/` + `master/web/`, `office/` + `office/web/`,
  `electron/` (shell), `tools/` (release/build scripts).

## Command Code project skills

Team-shared Command Code skills live in **`.commandcode/skills/`** (tracked in git
via a `.gitignore` exception). The rest of `.commandcode/` (taste, settings) is
local-only. The vendored `.agents/skills/` skills are auto-discovered by Command
Code and need no copy.
