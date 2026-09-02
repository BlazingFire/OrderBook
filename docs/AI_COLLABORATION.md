# AI Collaboration — Working Together on This Repo

A practical playbook for running three AI coding tools side by side on this
project — **Command Code (me)**, **Claude** (via Claude Code CLI), and a local
**Qwen 3 (8B / 27B via Ollama)** driven through **OpenCode**. It answers the
session-access question up front, defines how work is divided without stepping
on each other, and records the single source of truth each agent should trust.

This is written as a **reusable template** — the workflow rules are generic.
OrderBook-specific paths and details appear throughout as the concrete example.

---

## 1. Can you access an active Claude session in the GUI?

**Short answer: No.**

A coding agent (Command Code, Claude Code, or OpenCode) cannot reach into a
**live session of Claude's desktop GUI app**. Those are separate applications
with no cross-process channel, and there is deliberately no bridge from a
terminal agent into a GUI session.

What is actually true:

- **Claude Code CLI** sessions are scriptable: you can run `claude` as a
  subprocess with flags such as `--session-id`, and pass it prompts. That is how
  an agent can drive Claude Code — as its own process, not by peeking into a
  GUI.
- **Sessions live on disk as transcripts** (e.g. Command Code keeps JSONL
  transcripts per project under `~/.commandcode/projects/<slug>/`, Claude Code
  under `~/.claude/projects/`). A file on disk is not a live session: transcripts
  are append-only and only durably updated when a turn **commits**, so a
  still-streaming conversation is never a complete, readable file.
- **The `.claude/` folder in this repo** is not a GUI. It holds
  `settings.local.json` and vendored skills — configuration, not a session.

### What this means for collaboration

None of the three agents needs another's live session. The OrderBook repo
already demonstrates the pattern that works (see `HANDOFF.md`): **every agent
runs in its own terminal/CLI session, and coordination happens through shared
files and git** — not through shared memory. If you need Claude to do a piece of
work, launch it yourself (`claude` CLI) or hand it a written brief in a file;
no agent can open the one you already have in the GUI.

---

## 2. The three agents, and who does what

### Roles on this project

| Agent | Where it runs | Suggested role | Notes |
|---|---|---|---|
| **Claude** | Claude Code CLI | Architecture & design lead; broad-context planning; doc authoring | The existing `HANDOFF.md`, `docs/PROJECT_PLAN.md`, `docs/schema/`, and overhaul docs were written by/for Claude Code sessions. Read them first. |
| **Command Code (me)** | Terminal (this session) | Implementation, verification, and repo-grounded review | Run with plan mode when designing; executes `npm run verify`, checks tests/lint/typecheck before committing. |
| **Qwen 3 (8B / 27B)** | Local **Ollama** (`ollama run`), driven by **OpenCode** CLI | Fast parallel/grunt work; drafting; review passes on small scoped files | Runs 100% local — never sees secrets, never needs internet. Smaller context: give it one small, well-specified task at a time. The model id here is `qwen3:8b` / `qwen3:27b` depending on what Ollama has pulled (see §4). |

> **On the "27B" name:** the project's own docs and tests reference
> `qwen2.5` / `Qwen2.5-VL-7B` as the *product's* embedded-assistant model
> (workstream-I). The **Qwen 3** you run via OpenCode is the *development*
> assistant, separate from the OrderBook product's AI feature.

### Division of labor rules

- **Only one agent edits a file at a time.** If two need the same file, coordinate
  in the handoff file first (check §5).
- **The Master owns the DB and all writes** (that's the product's own rule in
  `README.md`) — but for *development* work, only one agent runs `npm run
  release` or touches migrations at a time, because those contend.
- **Small, scoped tasks → Qwen via OpenCode.** Big architectural or
  cross-cutting work → **Claude**. Implementation you want verified against the
  full suite → **Command Code**.
- **Never run two agents that both auto-apply edits** to overlapping files in
  the same working tree. Use separate git branches or serial handoff.

---

## 3. Ground rules for sharing context

1. **Put durable decisions in `HANDOFF.md`** (this repo's running record).
   Anything worth remembering — a decision, a gotcha, a completed stage —
   belongs there, not in a chat transcript that dies with the session.
2. **Write plans as files.** Claude Code has a `writing-plans` skill (vendored
   under `.claude/skills/`) that produces handoff plans for other models to
   execute. Command Code writes plans to `~/.commandcode/plans/`. Both are
   better handoffs than pasted chat.
3. **Prefer the source of truth over any summary.** `docs/PROJECT_PLAN.md` is
   the architecture source of truth; `docs/schema/` is the schema; `HANDOFF.md`
   is current status. If two documents disagree, say so and fix the stale one.
4. **Status lives in git, not in memory.** Commit granular work; the log is the
   shared timeline all three agents can read (`git log`). Uncommitted work is
   invisible to the others.
5. **Vendored skills** (`.claude/skills/` and `.agents/skills/`, kept
   byte-identical to upstream per `.prettierignore`) are shared tooling — read
   them, don't edit them.

---

## 4. The local Qwen stack (via OpenCode + Ollama)

The dev-assistant model runs through **OpenCode**, which talks to **Ollama**
serving a local Qwen 3 model.

```bash
# ensure Ollama is running and the model is pulled
ollama pull qwen3:8b        # smaller, faster; good for quick drafting
# or, for 27B-class work with more context/quality:
ollama pull qwen3:27b

# run OpenCode pointed at the local model
opencode --model ollama/qwen3:27b    # flags vary by OpenCode version
```

- **Everything stays local** — no API keys, works even while the shop's
  "no internet, ever" rule would forbid a cloud call.
- **Context is limited** compared to Claude. Give Qwen one file or one function
  at a time, with the exact path and the exact task.
- **Verify its output before committing** — small local models can hallucinate
  APIs or "fix" working code. Command Code can run `npm run verify` (lint +
  typecheck + tests) on anything it produced.

---

## 5. Handoff protocol

Use this when passing a task from one agent to another:

1. **Write a brief** to a file (e.g. `docs/ai-handoffs/<task>.md`) containing:
   - the goal, in one paragraph;
   - the exact files to touch (paths);
   - what "done" looks like (tests to run, output expected);
   - any constraints (offline-only, don't touch migrations, etc.).
2. **Assign one owner.** The brief names who implements and who reviews.
3. **The implementer reports back in the same file** — what changed, what was
   verified, what's left. The next agent reads the file, not the chat.
4. **Update `HANDOFF.md`** when the task closes.

This mirrors the "improve" skill's model (`plans/` + execute/reconcile) already
vendored in this repo, and keeps every agent working from durable state.

---

## 6. Verification before anything is "done"

The project's own gate is `npm run verify` (lint + typecheck + tests). Current
status at the time of writing: **1141 passing tests across 92 files**, both
panels build. No agent should claim a change is done without running the
relevant gate and recording the result.

```bash
npm run verify        # lint + typecheck + full test suite
npm run build         # builds shared, both servers, both frontends
```

For OrderBook specifically: `npm run typecheck` covers the web workspaces and
`electron/` too, so run it (or `verify`) rather than a narrower check.

---

## 7. Quick reference — where things live

| Thing | Path |
|---|---|
| Running record / decisions | `HANDOFF.md` (root) |
| Architecture source of truth | `docs/PROJECT_PLAN.md` |
| Database schema | `docs/schema/` (start at `00-overview.md`) |
| Overhaul/executive plan | `docs/overhaul/README.md` |
| Manual QA plan | `docs/TESTING_PLAN.md` |
| Shared types + Socket.IO contract | `shared/src/` (protocol in `shared/src/protocol/`) |
| Master Panel server | `master/src/` (Express + Socket.IO + Postgres) |
| Office Panel server | `office/src/` (thin client; forwards to Master) |
| Shared UI package | `ui/src/` (consumed as source by both panels) |
| Electron shell | `electron/` (main process + supervisor) |
| Release/build tooling | `tools/` (`release.mjs`, `make-icons.mjs`, …) |
| AI assistant (product feature) | `master/src/ai/`, docs in `docs/overhaul/workstream-I.md` |
| AI dev skills (vendored) | `.claude/skills/` + `.agents/skills/` |

---

*Template note: to reuse this doc in another project, replace the paths in the
tables with that project's layout and keep the rules in §1–§6 unchanged.*

---

## Change log

Newest first. Each entry records what an agent changed on the repo and what
was verified, so the next agent can trust the state without re-auditing.

### 2026-09-02 — Bloatware audit and cleanup (Command Code)

Scope: remove provably unused code/files without breaking function
(`npm run verify` must stay green).

**What was found.** The tracked tree is already aggressively lean — the repo
keeps no dead modules (its own `HANDOFF.md` documents a culture of deleting
"an abstraction extracted for no second caller"). Every tracked file is
load-bearing: routes/services/repositories are wired through `index.ts`
barrels and the HTTP/socket layers; migrations are pinned by
`migration-registry.test.ts`; UI exports are pinned by
`no-duplicate-ui.test.ts`; i18n keys by `i18n-tokens.test.ts`; every
Socket.IO event by `socket-contract.test.ts`. A grep for zero-reference files
over 516 source files flagged 309, but every one resolved to a real wiring
(barrel export, dynamic registration, build config, or test import) — the
basename scan is a poor dead-code detector in a codebase this connected.
Dependencies are likewise lean: every package in every workspace
`package.json` has a consumer (e.g. `uuid` is imported in four Master
services).

**What was removed.** Two confirmed-dead screen files, left on disk after an
earlier `git rm` (they were untracked, referenced by nothing — their names
appear only in docs and their own bodies):

- `master/web/src/screens/PanelDetailScreen.tsx` (superseded by a
  Modal-based detail view)
- `office/web/src/components/SyncStatus.tsx` (superseded by the presence
  rail)

Both deletions were already scoped by the open brief
`docs/ai-handoffs/dead-screens-cleanup.md`.

**What was deliberately left.** Everything whose deletion could not be proven
safe, or which is load-bearing: build artifacts (`shared/dist/`,
`*/build/`, `*.tsbuildinfo`) and runtime data (`node_modules/`, `data/`) are
gitignored and never ship; `.bat` launchers and installer resources are
referenced by the packaging config; migrations, docs, and the vendored
skills (`.claude/skills/`, `.agents/skills/`) are pinned by tests/workflow;
`.claude/scheduled_tasks.lock` is a live runtime lock owned by the Claude
tool, not repo source.

**Verified.** `npm run verify` is green: lint clean, typecheck clean in every
workspace, **102 test files / 1336 tests passing**.
