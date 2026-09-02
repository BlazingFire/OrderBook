# Sign-in: show attempts remaining, show the real wait time, and stop rendering English on a Hindi panel

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S — smaller than it looks. The transport already carries everything
needed; nothing structural has to change.

Owner's item 3: *"Show how many attempts left when user enters wrong password,
also show time (if all attempts failed so need to wait 1 minute). Show proper
error message."*

**Deferred, not in this brief:** "Improve sign-in page UI (LATER)" — the owner
explicitly marked it later.

## The numbers the UI has to render

```
master/src/services/auth.service.ts:75-76   MAX_FAILURES = 3;  LOCKOUT_MS = 60_000;
master/src/services/auth.service.ts:545     recordFailure zeroes the counter when it applies the lock
```

So the sequence a person actually experiences is **3 → 2 → 1 → locked for 60s →
3 again**. Say that in the copy; don't invent a different model.

## What is actually broken

**1. The lockout message cannot express the wait.**
`master/src/services/auth.service.ts:531-536` reads `record.lockedUntil` — the
exact epoch millisecond the lock lifts — on one line and throws
`new UnauthorizedError('error.unauthorized.tooManyAttempts')` on the next,
carrying nothing. The token is the fixed sentence *"Too many failed attempts.
Try again in a minute."*, which is simply wrong once 50 of the 60 seconds have
elapsed.

**2. The attempt count exists and nothing can read it.**
`auth.service.ts:73` holds `{count, lockedUntil, lastFailureAt}` per lowercased
username. There is no exported accessor.

**3. Both sign-in screens throw away the translated message.**
`master/web/src/screens/SignInScreen.tsx:24` and
`office/web/src/screens/SignInScreen.tsx:78` both do
`setError(caught instanceof Error ? caught.message : t(…))` — rendering the raw
**English** `message` and discarding the `messageKey` the transport carefully
carries. A repo-wide grep for `.messageKey` in either web app finds no consumer:
the only hits are the two assignments, the two server-side serialisers, and the
type definitions. **Every sign-in failure is English on a Hindi panel today**,
and the three-tier error pipeline (`messageKey` → coarse code token → English)
that was built end to end on the server has no client.

**4. The Office panel destroys the Master's structured refusal.**
`office/src/services/user-session.service.ts:136` —
`throw new SignInError((error as Error).message, 'invalid_credentials')`. The
`MasterCommandError` it discards was built at
`office/src/realtime/master-connection.ts:485-494` with `code`, `messageKey`,
`params` **and** `details` all intact (`master/src/realtime/hub.ts:829-838`
serialises them, and the doc comment at `hub.ts:815-821` exists specifically to
stop this loss). Four distinct Master outcomes — `signInFailed`,
`tooManyAttempts`, `accountDeactivated`, `noRole` — collapse into one code and
one English sentence.

## What is NOT broken — do not "fix" this

An early audit pass claimed `UnauthorizedError` structurally cannot carry the
data. **That was refuted at verification.** `params` already travels on the wire
(`master/src/http/middleware/error-handler.ts` serialises `error`, `message`,
`messageKey`, `params`, and `details` when present) and both browser clients
already unpack it (`office/web/src/api.ts:250-261` passes `detail?.messageKey`
and `detail?.params` straight through). No protocol change, no new error
subclass, no `details` plumbing is needed for this feature.

## Fix

1. **`shared/src/i18n/en.ts` + `hi.ts`** — give
   `error.unauthorized.tooManyAttempts` a `{seconds}` placeholder, and add a
   token for the countable case, e.g. `error.unauthorized.signInFailedRemaining`
   with `{remaining}`. Mirror both. Note the `ui` `t()` wrapper does **not**
   expose plurals — a count message needs `translator().tCount(stem, count)`
   (`ui/src/i18n.ts:61-63`), so pick the shape deliberately.
2. **`master/src/services/auth.service.ts`** — pass the params that already
   exist in scope:
   - `:534` → `throw new UnauthorizedError('error.unauthorized.tooManyAttempts', { seconds: Math.ceil((record.lockedUntil - Date.now()) / 1000) })`
   - the failure path at `:167` → include `{ remaining: MAX_FAILURES - record.count }`
     from the record `recordFailure` just wrote.
3. **`office/src/services/user-session.service.ts`** — give `SignInError`
   optional `messageKey` / `params` / `details` fields and pass the
   `MasterCommandError`'s through at `:136` instead of dropping them, with its
   real code (map `unauthorized` → `invalid_credentials` only as a default).
   Widen the code union with `locked_out`. Then extend
   `office/src/http/app.ts:388` to spread `messageKey`/`params`/`details` — the
   same spread the file already uses at `:1665-1666`.
4. **Both sign-in screens** — add one shared helper and use it:
   ```ts
   function errorText(caught: unknown): string {
     if (caught instanceof ApiError && caught.messageKey) return t(caught.messageKey, caught.params);
     if (caught instanceof ApiError) return t(errorMessageKey(caught.code));
     return caught instanceof Error ? caught.message : t('signin.errorFallback');
   }
   ```
   `errorMessageKey` (`shared/src/i18n/errors.ts:54`) was written for exactly
   this and is currently unused; this makes the `error.generic.*` fallbacks
   (`en.ts:241-243`) live. Use it at `master/web/src/screens/SignInScreen.tsx:24`
   and `office/web/src/screens/SignInScreen.tsx:78`.

## Security check — settled, showing the count is safe

Three places decide this and all three already behave identically for a real and
an invented username: the `failures` map is keyed by the **attempted** username
whether or not the account exists; both branches share one `recordFailure` and
one generic message token; and a missing user still pays a full scrypt hash, so
the timing does not differ. Showing "2 attempts remaining" therefore leaks
nothing about whether the account exists. **Keep it that way** — do not add a
different message for a nonexistent user while implementing this.

## One thing to decide, not assume

The Office panel keeps its **own** offline lockout counter
(`office/src/services/sign-in-attempts.store.ts`, which already exports
`lockedFor()` returning milliseconds remaining but no count accessor). It can
diverge from the Master's. Decide whether the panel shows its local count while
offline and the Master's while online, and make the copy honest either way —
a number that contradicts itself between two states is worse than no number.
Write down which you chose in this file.

## Done looks like

- `npx tsc -p master/tsconfig.json --noEmit`, `-p office/tsconfig.json`,
  both web configs, clean.
- `npx vitest run master/tests/i18n-tokens.test.ts master/tests/i18n-call-sites.test.ts shared/tests/i18n-coverage.test.ts` pass.
- `npm run verify` green.
- **Manually verified on both panels**, in both English and Hindi: wrong password
  three times, confirm the count decrements and the message is translated;
  confirm the lockout message shows a wait that actually decreases; confirm the
  count resets after the lock lifts.

---
*Implementer: append what changed and what you verified below this line.*
