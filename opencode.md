# OpenCode — Project Context

Lean companion to `AGENTS.md` (the canonical project memory — **read that first**).
This file only carries: (a) where the truth lives, and (b) what is still open as of
the last session. Do not duplicate `AGENTS.md` / `HANDOFF.md` content here.

## Read order (every session)

1. `HANDOFF.md` — current status, decisions, the **release hold**.
2. `docs/AI_COLLABORATION.md` — the three-agent workflow + handoff protocol. **Update
   its Change log after each prompt that changes the repo.**
3. `docs/PROJECT_PLAN.md` — architecture source of truth.
4. `docs/schema/` — every table/column/index.
5. `docs/overhaul/` — the 13-stage programme (all stages implemented).

## Standing gate

- `npm run verify` = lint + typecheck (all workspaces) + full test suite.
  **Green baseline confirmed 2026-09-03: 1351 tests across 106 files**
  (integration suites ran against a real Postgres). A change is not done until this passes.
- `npm run build` — shared, both servers, both frontends.
- Integration tests auto-skip when Postgres binaries are absent (`tests/helpers/db.ts`);
  `fileParallelism:false` is deliberate.

## Hard rules (from AGENTS.md — do not re-decide)

- **Never delete or rewrite a migration** that may have run anywhere
  (`master/src/db/migrations/`, pinned by `master/tests/migration-registry.test.ts`).
- **Single-writer**: Master owns all persistent state. Office panels forward writes
  over Socket.IO and never write their own DB.
- **Offline-only runtime**: nothing loads from a CDN or calls the internet.
- **Docs and code live separately** — prose in `docs/`, source in the workspaces.
- **Vendored skills** (`.claude/skills/`, `.agents/skills/`) are shared tooling —
  read, don't edit. `.commandcode/skills/` is the tracked, team-shared set.
- `master/web` and `office/web` have **zero** test files; `ui/tests` holds a few.
  UI defects are invisible to `verify` — treat browser/Electron manual passes as real.

## Current state (as of 2026-09-06) — what is still open

### ⚠ Release hold — v1.0.3 (still held; conditions now met)
Draft GitHub release `v1.0.3` is **held** and only the owner lifts it. Both
conditions the hold named are now satisfied: the four blockers are fixed and all
five guardrail tests have been rewritten and each individually watched to fail
against the broken code. `npm run lint`, `npm run typecheck` and `npm run test`
each exit 0.

Read the **2026-09-06** entries in `HANDOFF.md` and `docs/AI_COLLABORATION.md`
before assuming anything about this area. The short version, because it is the
part worth carrying:

- The first attempt at the blocker fixes left `npm run typecheck` **red** in
  three workspaces, and its own HANDOFF entry recorded those errors as
  "pre-existing at HEAD". They were not — the same working tree introduced them.
- The fix for the AI slot leak moved the acquire past `insertRun`, which traded
  the counter leak for a row leak: an ordinary refusal left an `ai_runs` row
  stuck at `status='running'` that nothing could finish.
- **All five guardrail tests passed against the code they were written to
  catch.** An allowlist that contained every command including the four dead
  ones; a copy of a private key table with the broken entries added to it; a
  regex that could not cross the `)` in `() => {` and so matched none of the 87
  `useEffect` calls it scanned; two bare `rejects.toThrow()` that a leaked slot
  satisfied as well as a budget refusal; and a screen-id scan that also matched
  every nav item, so it compared a set with itself.

**The rule that follows from that:** before accepting a guard, break the code it
guards, run it, watch it go red, and put the code back. A guard nobody has seen
fail is decoration, and it is worse than nothing because it reads as coverage.

### Verify baseline
`npm run verify` = lint + typecheck (all workspaces) + full suite. Run the three
steps **separately and check each exit code** — a single-project
`npx tsc -p ui/tsconfig.json` is narrower than the gate and will miss a
cross-workspace break, which is how the red typecheck above was reported as
green. Integration suites run against a real Postgres when one is present.

## Owed work (manual, not code — carried from HANDOFF.md)
- Responsive gate: 1024×768 / 1366×768 / 1920×1080 / 3840×2160 at 79% / 100% / 157%,
  sidebar in all three modes (browser pass ran at one size only).
- Manual pass on the assistant against a **real** model (provenance footer names the
  tools it actually used) — every guard is tested without one, deliberately.
- A real code review of the 286-file overhaul diff (the five-agent review died on a
  usage limit and returned "0 findings" without reviewing — do not read that as a pass).

## Notes on the environment
- Windows 11, PowerShell 5.1: `&&`/`||` don't work — use `;` or `if ($?) {}`.
- npm 12 blocks install scripts — approve native modules with
  `npm install-scripts approve <pkg>`.
- Bundled-Postgres postinstall can fail silently (see HANDOFF decision 3); the
  supported fallbacks are `DATABASE_URL` or `ORDERBOOK_PG_BIN`.
