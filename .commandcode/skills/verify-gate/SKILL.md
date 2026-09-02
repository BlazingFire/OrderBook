---
name: verify-gate
description: Run this project's verification gate before declaring any change done. Use when finishing a task, before a commit, or when asked "does it pass" / "is it verified". Runs npm run verify (lint + typecheck + tests) and records the result.
argument-hint: "[target]"
---

# Verification gate

This repo's own rule: **a change is not done until `npm run verify` passes.**

## When to use

- Just before you (or the user) would call a change complete.
- Before creating a commit.
- Whenever the user asks whether the tree is green.

## What to run

From the repo root:

```bash
npm run verify        # lint + typecheck (all workspaces) + full test suite
```

`npm run verify` is exactly: `eslint .`, then typecheck across every workspace
(including both web apps and `electron/`), then `vitest run`.

If the change is frontend-only and you need speed, `npm run typecheck` alone is
a narrower but valid intermediate signal — still finish with the full gate.

## Interpreting results

- Integration tests need a throwaway PostgreSQL cluster. They skip automatically
  when one is unavailable (see `tests/helpers/db.ts`); a skipped suite looks
  like a pass, so note when they were skipped.
- The suite takes several minutes on Windows (the first run also builds a
  Postgres cluster via `initdb`). Run it in the background and report the real
  summary line: `N test files passed, M tests passed`.
- If lint or typecheck fails, fix the specific finding — do not paper over it
  or commit a red tree.

## Report

When done, state the summary line and which suites ran. Append the outcome to
the task's handoff brief (see the `handoff-protocol` skill) and to
`docs/AI_COLLABORATION.md`'s Change log if the change is user-visible.
