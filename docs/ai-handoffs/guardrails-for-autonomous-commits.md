# Seven small tests that would have caught almost everything in v1.0.3

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S–M. Every item is in the grep-a-directory style this repo already
uses. No new framework, no jsdom, no React Testing Library.

> **Owner's decision, 2026-09-03: this brief goes FIRST — ahead of the v1.0.3
> blocker fixes and ahead of all other queued work.**
>
> That ordering is the point, not a formality. Items 1, 2, 4, 6 and 7 each
> correspond to a live defect in `d52bdef` that has not been fixed yet, so every
> one of them can be **written against the broken code and watched to fail**,
> then watched to pass as `v103-release-blockers.md` lands. A guard written
> after the fix proves nothing about whether it would have caught anything.

## Why

`d52bdef` added 258 lines of screen, a keydown dispatcher, a wire-format change
and a memory subsystem across 32 files, with **one line of new test** — and
`npm run verify` stayed green at 1339 passing tests. The 46-agent audit of it
found four release blockers and ~50 further defects. **Not one of them was
visible to the gate.**

The guardrails here are not weak in kind. `master/tests/no-duplicate-ui.test.ts`,
`party-access-screen-parity.test.ts`, `i18n-tokens.test.ts` and
`i18n-call-sites.test.ts` all grep source and assert invariants — exactly the
right instrument. They are pointed at the wrong surface: `vitest.config.ts:16`
includes `'{shared,master,office,electron}/tests/**'` and `'ui/tests/**'`, and
`ui/tests` holds three files, none of which touches this commit's code.
`master/web` and `office/web` have **zero** test files of any kind.

The second lesson is sharper. The agent **reintroduced a bug whose fix and
postmortem sit 200 lines above the code it wrote, in a file it was editing in the
same commit** (`ui/src/AssistantScreen.tsx:61-72` vs `ui/src/AiSupportScreen.tsx:56-58`),
and added a second instance of the exact failure `ui/src/ErrorBoundary.tsx:7-10`
was written to memorialise. **Institutional memory encoded as a prose comment
does not survive an autonomous agent. It has to be a test or it is decoration.**

## The seven

1. **`shared/tests/keys-implemented.test.ts`** — every id in `COMMANDS` must be
   either special-cased in `ui/src/KeyboardProvider.tsx` or appear as
   `useCommand('<id>'` somewhere in `ui/src`, `master/web/src` or
   `office/web/src`. This is `i18n-call-sites.test.ts` with a different token
   list. *Catches all four dead commands and the palette entries advertising
   them.*

2. **Two assertions added to the existing `shared/tests/keys.test.ts`** — for
   every command and both platform branches, `parseChord(chord)` must round-trip,
   and `chord.key` must appear in the table `matchesChord` consults
   (`shared/src/keys/chord.ts:124-136`). The file already imports everything
   needed. *Catches `nav.prev`/`nav.next` binding a chord that can never fire.*

3. **`master/tests/screen-reachability.test.ts`**, modelled on
   `party-access-screen-parity.test.ts` — parse `master/web/src/App.tsx` and
   `office/web/src/App.tsx`; assert the `Tab` union, the nav-items array and the
   `ScreenSpec` ids are the same set in each panel, with an explicit,
   reason-carrying exception list for deliberately nav-less screens. *This is the
   check the two previously shipped blocking bugs needed, and it flags the Office
   panel's missing AI Support route as a decision rather than an oversight.*
   Overlaps `web-reachability-and-dead-api-tests.md` — **do them together, one
   file.**

4. **One grep test over `ui/src`** — no `useEffect` may list `transport` in its
   dependency array; the house pattern is `transportRef`
   (`ui/src/AssistantScreen.tsx:71-72`). One line of regex. *Catches the
   reintroduced refetch, and encodes the postmortem as something an agent cannot
   read past.*

5. **Point `i18n-call-sites.test.ts` at `ui/src`** in addition to `master/web`.
   *Catches the eight hardcoded English literals in
   `ui/src/AssistantScreen.tsx:226-254`, two of which duplicate tokens the same
   commit added twelve lines away.*

6. **One unit test on the AI limiter** — call `startRun` down a throwing path
   (the `validation.ai.budgetSpent` branch is the easiest) and assert
   `activeRunCount` is unchanged. Not structural, but it is the single most
   damaging finding in the commit and it is a ten-line test.

7. **A cross-workspace version test.** All seven `package.json` files must agree.
   `shared/tests/version.test.ts` exists but does not assert this, so a missed
   workspace would ship silently. *Ten lines.*

## Two things to delete rather than test

- **`global.gc?.()`** (`master/src/lib/memory-monitor.ts:45, :48`) — the check
  that would have caught it is not writing the line. Deleting it is both the fix
  and the guard.
- **The `memory` object on the health endpoint** (`master/src/http/health.ts:67`)
  — zero consumers across both web apps, `electron` and `ui`. Same for the two
  unreferenced keyframes and two unused motion tokens the same commit added.

## Two process rules, no code required

- **One feature per commit.** `d52bdef` is four unrelated features in 32 files,
  which is precisely why neither a human reviewer nor any single audit dimension
  could hold it whole.
- **A "Verified" line must read `npm run verify` verbatim.** That rule is already
  written in `docs/AI_COLLABORATION.md`; the v1.0.3 entry violated it three
  sections below where it appears, recording "140 shared tests, 23 keyboard
  tests, three tsconfigs" as its bar instead. **Self-documentation is not
  evidence** — that same entry gets its own file count wrong three ways.

## Done looks like

- Each test **fails against `d52bdef` before the fixes land**, and passes after.
  Write them first and watch them go red; a guard nobody saw fail is not a guard.
- `npm run verify` green.

---
*Implementer: append what changed and what you verified below this line.*
