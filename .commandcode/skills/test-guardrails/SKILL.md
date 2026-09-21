---
name: test-guardrails
description: Where OrderBook tests live and what `npm run verify` cannot see. Use when adding tests, touching untested areas, or interpreting a green verify with suspicion.
argument-hint: "[area]"
---

# Test guardrails

`npm run verify` (see the `verify-gate` skill) is necessary but not sufficient:
the v1.0.3 audit found four release blockers while it was green. This skill
closes the gaps it leaves.

## Layout (from `vitest.config.ts`)

- Suites live at `{shared,master,office,electron}/tests/**/*.test.ts` and
  `ui/tests/**/*.test.{ts,tsx}`. Only `ui/tests/**` runs under jsdom.
- `master/web/src` and `office/web/src` hold **zero** test files. A change
  confined to either panel's web app is invisible to the suite — add a
  component-level test under `ui/tests/` when touching the kit, and say
  plainly in the handoff brief when panel-only code went in unverified.

## Integration tests

- They share one throwaway PostgreSQL cluster and must not run in parallel
  (`fileParallelism: false` is deliberate — do not "fix" it).
- They skip automatically when no database is available
  (`master/tests/helpers/db.ts`); a skip looks like a pass, so record which
  suites actually ran. The run points `ORDERBOOK_DATA_DIR` at a temp dir so
  suites never touch the developer's live `master/data/`.

## Permanent rules

- Never delete or rewrite a migration (`master/tests/migration-registry.test.ts`
  pins them). Never narrow a failing run to make it pass — no `-k 'not …'`,
  `--deselect`, or skips added to fit a change.
- Testing notes: `docs/backend-modules/10-TESTING.md`.
