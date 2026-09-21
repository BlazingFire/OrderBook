# Project Memory

## What this project is

**OrderBook** — an offline, LAN-only order & inventory management web app for a
ceramic company. **No internet access at any point, ever** (at runtime). Two
cooperating Electron-wrapped web apps:

- **Master Panel** — one PC; owns the PostgreSQL database and all files. Every
  write goes through it.
- **Office Panel** — other PCs on the same LAN; thin clients that create leads,
  manage parties/products, and push leads to orders. No database of its own.

It is order management, not billing: the software carries **no money at all**
— no rates, amounts or totals anywhere (pricing was removed on 2026-09-21).
There is no AI assistant.

## Source of truth — read these before assuming

- **`HANDOFF.md`** (root) — current state, decisions, traps, owed work. Read first in any session.
- **`docs/PROJECT_PLAN.md`** — architecture source of truth (requirements, pairing, screen flows).
- **`docs/schema/`** — every table, column, index, and rationale.
- **`docs/overhaul/`** and **`docs/backend-modules/`** — the designs behind the code, cited from
  source comments. Written before the code; check a claim against the tree before acting on it.
- **`docs/AI_COLLABORATION.md`** — the multi-agent workflow, handoff protocol, and change log.
  **Update its Change log after each prompt** that changes the repo.

## Verification gate

- `npm run verify` = lint + typecheck (all workspaces) + full test suite (~122 files,
  ~1500 tests). **A change is not done until each of the three steps exits 0.**
- `npm run build` — builds shared, both servers, both frontends.
- Integration tests need PostgreSQL and skip automatically when unavailable
  (see `master/tests/helpers/db.ts`); `fileParallelism:false` is deliberate. A skipped
  suite prints like a green one — check it ran.
- `master/web` and `office/web` have no test files. UI defects are invisible to
  `verify`; a browser or Electron pass is real verification.

## Standing conventions

- **Branching:** work lands on `main` directly. `dev` is historical and behind.
- **Never delete or rewrite a migration** that may have run anywhere
  (`master/src/db/migrations/`, pinned by `migration-registry.test.ts`).
- **Documentation and code live separately** — prose in `docs/`, source in the
  workspaces. No source-of-truth doc buried in a code comment.
- **Single-writer**: the Master owns all persistent state. Office panels forward
  writes over Socket.IO; they never write their own database.
- **Runtime is offline-only**: nothing loads from a CDN or calls the internet.
  Bundled fonts/assets only. `.env` config is optional (see `.env.example`).
- **Desktop only**: design floor 1024×768, laptop-to-4K at 79–157 % scale. No phone layout.
- **Monorepo layout**: `shared/` (types + Socket.IO + discovery protocol + i18n),
  `ui/` (shared React kit), `master/` + `master/web/`, `office/` + `office/web/`,
  `electron/` (shell), `tools/` (release/build scripts).

## Project skills

Team-shared skills live in **`.commandcode/skills/`** (tracked via a `.gitignore`
exception; the rest of `.commandcode/` is local-only) and, for Muse Code discovery,
**`.agents/skills/ui-consistency/`**. Third-party skills (apple-design, improve,
writing-plans, …) are installed globally on the owner's machine, not vendored here.
