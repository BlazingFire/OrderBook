# The reason both blocking bugs shipped: nothing tests either web application

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S — two Node tests, roughly 30 lines each, no framework additions.
**Priority: land right after the two blocking fixes**, so they cannot come back.

## Why this exists

Both bugs the owner hit in manual QA live in `*/web/src/App.tsx`, and both are
invisible to every existing guard:

```
vitest.config.ts:16   include: '{shared,master,office,electron}/tests/**/*.test.ts'
                                and 'ui/tests/**/*.test.{ts,tsx}'
```

Neither `master/web` nor `office/web` matches that glob, and
`find master/web office/web -name "*.test.*"` returns **zero files**. The
1336-test green run this project keeps citing proves nothing about either panel's
application shell. `tsc` is clean on both bugs too — neither is type-visible.

The repo already has the right pattern for this: `master/tests/no-duplicate-ui.test.ts`
reads `master/web/src` and `office/web/src` off disk and asserts they don't
re-copy `ui/`; `party-access-screen-parity.test.ts` asserts byte parity;
`i18n-call-sites.test.ts` and `i18n-tokens.test.ts` check tokens. A Node test
that greps the frontend is established and cheap. Two invariants are missing.

## Test 1 — every `Tab` is reachable

Catches the New Lead bug (`office/web/src/App.tsx:586-591` — `idToTab` has no
`addLead` key, so the tab falls back to the Dashboard) and every future
recurrence.

Assert, for **both** panels: every member of the `Tab` union has (a) a
`ScreenSpec` registered, and (b) either an `idToTab` entry or an explicit
allow-list entry naming it as a nav-less screen. Parse the source with a regex
the way `no-duplicate-ui.test.ts` already does — no React render, no DOM.

The allow-list matters: `addLead` is *legitimately* nav-less. The test's job is
to force that to be stated once, deliberately, instead of discovered by a user.

The cheapest strong version, if regex-parsing the union proves brittle: extract
the `activeId`/`activeScreenId` computation (`office/web/src/App.tsx:586-591`
plus `:915`) into an exported pure function and assert
`resolveActiveScreen('addLead') === 'addLead'` for every `Tab` value. That is a
better test and a small refactor.

## Test 2 — no exported API client function has zero callers

Catches `master/web/src/api.ts:515 createParty` (the Master's missing party
screen) and, in one assertion, five more findings that three separate audit
agents reported independently:

- `deleteParty` / `deleteProduct` / `deleteLead` / `deleteOrder` — declared in
  **both** panels' clients (`master/web/src/api.ts:673-680`,
  `office/web/src/api.ts:518-525`) with zero callers anywhere. Four of the
  Recycle Bin's nine entity types can therefore never be deleted from any UI.
- Six more dead catalog helpers in the Master's client (`api.ts:511, 516, 525`, …).

Assert: for every `name:` key exported from `<panel>/web/src/api.ts`, at least
one `api.<name>` reference exists elsewhere under `<panel>/web/src`. Failures
are either a missing screen (build it) or genuinely dead code (delete it) —
both are things somebody should have to decide on purpose.

Seed the test with an explicit, commented exception list for anything the team
consciously keeps ahead of its UI, so the failure message is actionable rather
than a wall.

## Done looks like

- Both tests live under `master/tests/` (matching where `no-duplicate-ui.test.ts`
  already reads both panels' sources from) and are picked up by the existing
  vitest glob without touching `vitest.config.ts`.
- **Both tests fail on the current `main`** — write them first and watch them go
  red against the unfixed code, then confirm they pass after the two blocking
  fixes land. A guard that was never seen failing is not a guard.
- `npm run verify` green.

## Constraints

- No new test framework, no jsdom, no React Testing Library. These are source
  assertions, in the style the repo already uses.
- The exception lists must carry a one-line reason each, in the file. An
  exception list without reasons decays into a mute button.

---
*Implementer: append what changed and what you verified below this line.*
