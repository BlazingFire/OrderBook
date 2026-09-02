---
name: handoff-protocol
description: Pass work cleanly between the three AI agents on this repo (Command Code, Claude via Claude Code CLI, Qwen 3 via OpenCode) using shared files. Use when picking up someone else's task, writing a task brief, or handing work to another agent.
argument-hint: "[task-slug]"
---

# Handoff protocol

Three agents work this repo (Command Code, Claude Code CLI, and a local Qwen 3
via OpenCode). None of them can read another's live session — coordination
happens through **shared files and git**. Full rules: `docs/AI_COLLABORATION.md` §5.

## The workflow

1. **Write a brief** to a file under `docs/ai-handoffs/<short-task-slug>.md`:
   - the goal, in one paragraph;
   - the exact files to touch (paths);
   - what "done" looks like (which tests to run, what output is expected);
   - any constraints (offline-only, don't touch migrations, keep scope small).
2. **Assign one owner** for implementation and one for review. Name them in the
   brief's header.
3. **The implementer appends to the same file** below a `---` line: what changed,
   what was verified (the `verify-gate` skill's summary line), what is left. The
   next agent reads the file, not a chat transcript.
4. When the task closes, fold anything durable into `HANDOFF.md` and delete or
   archive the brief. This directory is a working queue, not a permanent record.

## Rules

- Keep exactly **one open brief per task** so two agents never pick up the same work.
- Only one agent edits a file at a time.
- If a brief's premise no longer holds (e.g. a file it names was already
  deleted), stop and note it in the brief instead of improvising a wider change.
- A brief that says "don't go looking for more dead code" means exactly that:
  if you spot related work, add a note for a follow-up brief rather than
  expanding scope.
