# Wire up self-service "change my password"

**Owner:** Command Code. **Reviewer:** Claude (design/wording check only —
implementer runs `npm run verify`, not Claude).
**Size:** S — the backend is complete and audited; this is a new dialog plus
one new topbar entry point.

## Goal

The endpoint is fully built: `POST /api/access/me/password`
(`master/src/http/routes/access.routes.ts:207-222`) takes
`{ currentPassword, newPassword }`, calls
`authService.changeOwnPassword({...}, actor.userId, actor.tenantId)`, and the
client wrapper already exists —
`master/web/src/api.ts:623-624`:
```ts
changeOwnPassword: (input: ChangeOwnPasswordInput) =>
  post<void>('/api/access/me/password', input),
```
`ChangeOwnPasswordInput` (`shared/src/domain/inputs.ts:339-342`) is
`{ currentPassword: string; newPassword: string }`.

**Nothing in the UI calls this anywhere.** Every password change today goes
through an administrator resetting someone else's password
(`OneTimeSecretDialog`, `master/web/src/screens/AccessScreen.tsx:1215+`) —
there is no "change my own password" entry point at all, which makes even
the most routine account action an admin bottleneck.

## Files to touch

- `master/web/src/App.tsx` — add the entry point.
- A new small component, e.g. `master/web/src/components/ChangePasswordDialog.tsx`
  (or inline in `App.tsx` if you judge that's cleaner — this repo doesn't have
  a hard rule either way for a one-off dialog this small).
- `shared/src/i18n/en.ts` and `shared/src/i18n/hi.ts` — a handful of new
  keys (see below). **Every panel screen must go through `t()`** — no literal
  strings in JSX (there's an eslint rule for this,
  `orderbook-i18n/no-untranslated-jsx-text`, though it's currently set to
  `off` pending a promote-screen-by-screen plan — follow the house rule
  anyway for new code, don't rely on the lint being silent).

## Design

Reuse the existing `Modal` pattern (see `OneTimeSecretDialog` in
`AccessScreen.tsx` for the shape: `<Modal open onClose title footer>`).

- Entry point: a small button/menu item in `App.tsx`'s topbar, near
  `signOut()` (around line 549) — something like a "Change password" ghost
  button, or fold it into a small user menu if you think that reads better
  than a second bare button next to Sign Out. Use your judgment on the exact
  placement/affordance, but it must be reachable from every screen (the
  topbar already is, on every tab).
- Dialog fields: current password, new password, confirm new password (all
  `type="password"` — this repo has a known house rule that password fields
  must not use a bare `type="text"`; grep `AccessScreen.tsx` for how the
  existing "Set new password" dialog does it).
- Client-side: new password ≥ 8 characters (matches the server's own rule,
  `validation.password.tooShort`) and equals the confirm field, before
  submitting — but the server is the real gate; don't skip the server error
  path.
- On submit: call `api.changeOwnPassword({ currentPassword, newPassword })`.
  On success, close the dialog and show a toast/confirmation (reuse whatever
  toast pattern this screen already uses elsewhere in the file).
- On failure: the server throws `validation.password.bothRequired` (missing
  fields — shouldn't be reachable from the UI at all) or an
  `UnauthorizedError` if `currentPassword` is wrong (check
  `authService.changeOwnPassword`'s implementation in
  `master/src/services/auth.service.ts` for the exact error/message key it
  throws on a wrong current password, and surface that message in the
  dialog, not a generic failure).

## New i18n keys (add to both `en.ts` and `hi.ts` — the hi.ts mirror must stay
a real Hindi translation, not a copy of the English string; run
`npm run i18n:sync` after adding the English keys, then translate the
Hindi placeholders it inserts)

Pick your own naming if you prefer, but something in this shape:
- `access.changePassword.title` — dialog title, e.g. "Change your password"
- `access.changePassword.current` — "Current password" field label
- `access.changePassword.new` — "New password" field label
- `access.changePassword.confirm` — "Confirm new password" field label
- `access.changePassword.mismatch` — client-side "Passwords don't match"
- `access.changePassword.submit` — button label, e.g. "Change password"
- `access.changePassword.success` — confirmation toast text
- `footer.changePassword` or `action.changePassword` — the topbar entry
  point's own label

## Done looks like

- `npx tsc -p master/web/tsconfig.json --noEmit` clean.
- `npm run lint` clean.
- `master/tests/i18n-tokens.test.ts` and `master/tests/errors-i18n.test.ts`
  still pass (these fail if a `t('key')` names something missing from the
  catalogue, or if en/hi drift) — run
  `npx vitest run master/tests/i18n-tokens.test.ts master/tests/errors-i18n.test.ts`.
- Manually verified in a running Master (`npm run dev:master`): sign in,
  open the new dialog, submit a wrong current password (see the real error
  message, not a blank failure), then submit correctly and confirm you can
  sign out and back in with the new password.

## Constraints

- Master only for this brief — don't add the same entry point to the Office
  Panel unless you check first whether Office users authenticate through a
  comparable "own password" concept (they may not; Office sign-in is a
  separate system from Master users — check
  `office/src/services/user-session.service.ts` before assuming parity, and
  if it doesn't apply, just say so in this file rather than guessing).
- Don't touch `authService.changeOwnPassword` or the route itself — both are
  already implemented and were part of the recent security audit; this task
  is UI-only.

---
*Implementer: append what changed and what you verified below this line.*
