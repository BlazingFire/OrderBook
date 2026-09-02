# AI handoff briefs

One file per task, written by whichever agent scoped the work (usually
Claude, per `docs/AI_COLLABORATION.md`) for whichever agent implements it
(Command Code or Qwen 3 via OpenCode). Follow `docs/AI_COLLABORATION.md` §5:

1. **The brief** (written by the planner): the goal in one paragraph, the
   exact files to touch, what "done" looks like (which tests to run, what
   output is expected), and any constraints (offline-only, don't touch
   migrations, etc.).
2. **One named owner** for implementation, one for review.
3. **The implementer appends to the same file** — what changed, what was
   verified (`npm run verify` output or the relevant subset), what's left.
   The next agent reads this file, not a chat transcript.
4. Once a brief is done, fold anything durable into `HANDOFF.md` and delete
   or archive the brief — this directory is a working queue, not a permanent
   record.

Name files `<short-task-slug>.md`. Keep exactly one open brief per task so
two agents don't pick up the same work.

## Queue order, as of 2026-09-03

Several briefs depend on each other, so this order is not arbitrary. Work down
it unless the owner says otherwise.

**Release-blocking — v1.0.3 is already on `main` and must not be built into
installers until these land:**

0. `v103-release-blockers.md` — four confirmed blockers in `d52bdef`, found by a
   46-agent adversarial audit. Two ordinary budget refusals permanently disable
   AI installation-wide; an Office panel on a different version than its Master
   crashes entirely; the "RAM cap" lowers V8's ceiling on small machines and
   raises it on large ones while its monitor cannot fire; and the new screen
   refetches on every sync delta. Also fixes the wrong `HANDOFF.md` entry.
1. `guardrails-for-autonomous-commits.md` — the seven small tests that would have
   caught almost all of it. Merge item 3 with
   `web-reachability-and-dead-api-tests.md`; they are the same file.

**Blocking — the owner cannot use these features at all:**

1. `fix-office-new-lead-unreachable.md` — the Office panel cannot create a lead.
   Two bugs that must ship together, or the visible failure becomes silent data
   loss.
2. `add-master-party-screen.md` — the Master panel has no way to add a party;
   the screen was never built.
3. `web-reachability-and-dead-api-tests.md` — the missing invariants that let
   both of the above ship. Land right after them so they cannot come back.

**Cross-cutting — other briefs depend on these:**

4. `office-write-refusal-visibility.md` — a refused Office write is invisible to
   whoever wrote it. This is what makes several other failures silent.
5. `close-money-field-gate-gaps.md` — `mrp`/`pricePerSqft` permission gaps.
   Supersedes section 3 of `office-product-form-gates-and-slimming.md`.

**Security, landable on their own:**

6. `session-loss-and-password-change.md` §2 — the socket path silently
   downgrades a refused acting token instead of refusing it.
7. `office-product-image-flow.md` §1 — all four image mutations return the
   unmasked product, leaking rates to the browser.

**Owner-reported QA items:**

8. `signin-attempts-and-lockout-feedback.md`
9. `session-loss-and-password-change.md` (the rest) — needs
   `self-service-password-change.md` first.
10. `recycle-bin-delete-actions-and-purge.md` — part 2 needs an owner decision.
11. `office-product-form-gates-and-slimming.md`
12. `office-product-image-flow.md` (the rest)
13. `party-access-truncation-and-routing.md`
14. `product-csv-import.md` — large; depends on 1 and 4.

**Decisions and documents:**

15. `testing-plan-reconciliation.md` — four of the owner's QA findings are
    steps in `docs/TESTING_PLAN.md` for screens that were never built.
    Worth doing before the next manual pass.

**Earlier rounds, still open:** `design-audit-high-priority.md`,
`fix-broken-popover-menu-css.md`, `office-panel-report-hardening.md`,
`fields-and-ai-domain-cleanup.md`, `debounce-list-search.md`,
`reset-appearance-action.md`, `self-service-password-change.md`.
