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

## Queue, as of 2026-09-14

Every brief here was re-checked against the current tree on 2026-09-14; the
four that were done (`dead-screens-cleanup`, `guardrails-for-autonomous-commits`,
`product-csv-import`, `v103-release-blockers`) were deleted. Anything about
the AI assistant inside a remaining brief is moot — the feature is gone.

**Blocking — the owner cannot use these features at all:**

1. `fix-office-new-lead-unreachable.md` — bug 1 (unreachable screen) is fixed;
   bug 2 (a temp `partyId` on a lead was not remapped) is fixed on 2026-09-19
   in `lead.service.ts` — see item 15. Delete the brief once its text is folded.
2. `add-master-party-screen.md` — `createParty` in `master/web/src/api.ts`
   still has no caller; no Parties screen on the Master.
3. `web-reachability-and-dead-api-tests.md` — test 1 exists; test 2 (no
   zero-caller `api.ts` export) is missing.

**Cross-cutting — other briefs depend on these:**

4. `office-write-refusal-visibility.md`
5. ~~`close-money-field-gate-gaps.md`~~ — moot since 2026-09-21: pricing is
   gone, so there is no money field left to gate.

**Security, landable on their own:**

6. `session-loss-and-password-change.md` §2 — `hub.ts` still falls back to a
   default actor after a refused acting token.
7. `office-product-image-flow.md` §1 — the four image mutations still return
   the unmasked product.

**Owner-reported QA items:**

8. `signin-attempts-and-lockout-feedback.md`
9. `self-service-password-change.md` — `changeOwnPassword` has no caller.
10. `session-loss-and-password-change.md` (the rest)
11. `recycle-bin-delete-actions-and-purge.md` — part 2 needs an owner decision.
12. ~~`office-product-form-gates-and-slimming.md`~~ — moot since 2026-09-21:
    the form has no gated field left, and the slimming happened by decision.
13. `office-product-image-flow.md` (the rest)
14. `party-access-truncation-and-routing.md`

**Landed 2026-09-19 (Claude):**

15. `product-model-variants.md` — the product master is category → model →
    variant, with the code and weight on the variant, one lead line per
    variant, inventory keyed by variant, the Swisware catalogue as the seed.
    Kept as the design record until its live walk-through (§6) is signed off.
    Its §6a also closes bug 2 of item 1 above: a temporary `partyId` on a
    lead is now resolved through `id_map` in `lead.service.ts`.

**Landed 2026-09-21 (Claude):**

16. `product-master-trim.md` — the product master trimmed to name · category
    · alias · size · *made in every colour* switch, with variants of code ·
    colour · weight; pricing removed whole (no rates, amounts, totals,
    `field.*Rate.*` keys or masking anywhere); a lead line on a multi-colour
    model names a colour from the colour list. Kept as the design record
    until its walk-through (§6) is signed off.

**Earlier rounds, still open:** `design-audit-high-priority.md`,
`fix-broken-popover-menu-css.md`, `office-panel-report-hardening.md`,
`fields-and-ai-domain-cleanup.md` (only the `productType` `usedBy` and two
stale comments remain), `debounce-list-search.md`,
`reset-appearance-action.md`, `testing-plan-reconciliation.md`.
