# The QA plan tests screens that were never built — reconcile it before the next manual pass

**Owner:** Claude drafts the reconciliation; Command Code applies whatever
implementation decisions fall out. **Reviewer:** the repo owner — this one needs
a product call, not just a code change.
**Size:** S to fix the document. The decisions it forces are the large part.

## Why this is worth doing before any more manual QA

Four of the owner's ten QA findings trace to one document.
`docs/TESTING_PLAN.md` §5 (lines 85-97) instructs the tester to create a party,
create a category and a product, and upload and reorder product images **on the
Master panel**. §4 (line 81) says to change your own password through the
self-service flow.

**None of those four screens exists.** The plan was written against the API
surface and the permission catalogue — both of which fully support all four —
rather than against the screens that actually render. So it walks the owner into
unbuilt features and they come back as bug reports. `HANDOFF.md:2188` already
recorded the underlying fact in passing: *"the Master has no product or party
screen and `master/web/src/api.ts` has no `put`/`patch` at all."*

Reconciling the plan against what actually renders is worth more than any single
fix in this round, because it decides **which of the owner's items are defects at
all** rather than requests for features nobody built.

## What to do

1. **Walk `docs/TESTING_PLAN.md` end to end against the shipped screens.** For
   every instruction, confirm a screen exists that can perform it. The cheap way:
   for each step, find the `api.*` call that would serve it and check it has a
   caller — the same invariant `web-reachability-and-dead-api-tests.md` is about
   to enforce in CI.
2. **For each mismatch, choose one and mark it in the plan:**
   - *Build it* — the capability genuinely belongs on that panel. (This is the
     answer for parties on the Master; see `add-master-party-screen.md`.)
   - *Move it* — the step is right but belongs on the other panel. Correct the
     plan.
   - *Drop it* — the capability was never intended. Then also **delete the dead
     API client helpers** that imply otherwise, so the next reader is not misled
     the same way.
3. **Settle the standing question this raises:** is the Master meant to have a
   catalog surface at all, or is it deliberately administration-only with the
   Office panel owning parties and products? Everything else here follows from
   that answer, and it is currently ambiguous — the API client says yes, the
   screens say no, `PartyAccessScreen.tsx:20-22` says the omission is deliberate,
   and the QA plan assumes yes. **Record the decision in `HANDOFF.md`**, not just
   here, so it stops being re-litigated.

## Known mismatches to start from

| `TESTING_PLAN.md` says | Reality |
|---|---|
| §5: create a party on the Master | No party screen on the Master; `api.createParty` has zero callers |
| §5: create a category and product on the Master | No catalog screen on the Master; `api.createProduct` dead |
| §5: upload/reorder product images on the Master | Image UI exists only on the Office panel |
| §4: change your own password | `changeOwnPassword` has zero UI callers on either panel |

Expect more — those four were found while chasing other things, not by a
systematic pass.

## Done looks like

- `docs/TESTING_PLAN.md` contains no step that cannot be performed on the panel
  it names.
- Every mismatch is resolved as build / move / drop, and the dropped ones have
  had their dead API helpers deleted.
- The Master-catalog decision is written down in `HANDOFF.md`.

---
*Implementer: append what changed and what you verified below this line.*
