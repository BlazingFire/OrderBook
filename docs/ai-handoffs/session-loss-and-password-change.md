# A changed password leaves the window looking signed in — no message, no redirect, and a security hole on the socket path

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** M. Contains one **security** defect that should land regardless of the
rest of the feature.

Owner's item 4: *"If admin changes its password, show a message that they need
to sign in back when password changes, and redirect to the sign-in screen."*

## Three separate gaps, one of which is a security bug

### 1. There is no session-loss handling anywhere in the front end (root cause)

One grep for `401` across `master/web/src`, `office/web/src` **and** `ui/src`
returns a single hit, and it is a comment (`office/web/src/App.tsx:275`).

`master/web/src/api.ts:207-227` builds an `ApiError` from the body with no
branch on `response.status`; `office/web/src/api.ts` has the same shape. So when
the server stops honouring a session, the client cannot tell that apart from any
other failed request: `master/web/src/App.tsx:150-151` hold `user` and
`sessionToken` and never clear them, and `:229-240` only reaches
`setPhase('signed-out')` on a manual reload via `api.me()`. The window stays
rendered as signed in, every panel shows a generic error toast, and nothing says
why.

**Fix at the one place every caller routes through** — the shared `send()` in
`master/web/src/api.ts:207-227` and its `office/web/src` mirror: on
`response.status === 401`, publish a session-ended reason carrying
`body.messageKey`, then throw as today. Subscribe in each `App.tsx` beside the
socket effect (`master/web/src/App.tsx` ~`:269`): clear `user`/`sessionToken`,
`setPhase('signed-out')`, and stash the reason so `SignInScreen` renders it.
New mirrored tokens: `signIn.notice.sessionEnded`, `signIn.notice.passwordChanged`.

Per the critique that reviewed all of this: both API clients build their
`ApiError` in the same shape (`master/web/src/api.ts:207-227`,
`office/web/src/api.ts:246-261`), so **this belongs in `ui/` once**, not written
twice.

### 2. SECURITY — the socket path silently downgrades a refused token instead of refusing it

`master/src/services/panel-actor.service.ts:85-104` returns a fallback actor
(`actorType: 'office_panel'`, permissions from `panelService.permissionsForPanel()`)
whenever a presented acting token is refused. The HTTP middleware correctly
rejects that with a 401 — and states the rule in its own header comment
(`master/src/http/middleware/require-panel.ts:15`): *"a presented-but-refused
acting token is a 401, never a silent downgrade to the panel's own authority."*

`master/src/realtime/hub.ts:852-876` does the opposite: it clears the token,
emits `session:rejected`, and then **returns the fallback actor — the command
proceeds** under the panel's machine role.

`resolvePanelActor` returns `(actor, tokenAccepted)` and leaves enforcement to
the caller. Two callers exist; only the HTTP one checks. This is exactly why a
client that never notices a refused token also never notices being handed a
weaker one.

**Fix:** move the check into `resolvePanelActor` itself so no third caller can
inherit the bug — throw when a token was presented and refused, keeping the
fallback actor only for the genuinely tokenless case (`tokenAccepted` is already
`!actingUserToken` at `panel-actor.service.ts:89`). `respond()`
(`hub.ts:822-845`) already converts an `AppError` into a proper ack with code
and `messageKey`.

**This one is worth landing on its own, ahead of the UX work.**

### 3. The owner's literal scenario cannot be performed at all today

`changeOwnPassword` exists end to end on the server and has **zero UI callers**
on either panel. There is already an unclaimed brief for building it:
**`docs/ai-handoffs/self-service-password-change.md`** — do that one first or
fold it into this change, but do not re-derive it.

Related, smaller, same area:
- `invalidateSessionsForUser` records no evidence of *why* a session ended, so
  even with the 401 handler the client cannot say "because your password
  changed" rather than a generic "signed out".
- The **Reset password** button has no self-exclusion: an admin resetting their
  own password signs themselves out with no warning that they are about to.
- An idle window is never proactively told. The push path exists —
  `panel:revoked` reaches an Office panel through `master/src/realtime/hub.ts`
  — but is only used per-panel, not per-user. Decide whether a password change
  should push to that user's other live sessions, and say so in this file.

## Done looks like

- `npx tsc` clean on master, office, both web configs, and ui.
- **New test for the security fix:** a socket command presenting a
  revoked/invalid acting token must be refused, not executed under the panel's
  permissions. Put it beside the existing panel-actor coverage; assert the ack
  carries the unauthorized code.
- `npm run verify` green.
- **Manually verified:** sign in on the Master, change that user's password from
  another session, then act in the first window — it must drop to the sign-in
  screen with a message that names the reason, not a generic error toast. Repeat
  on the Office panel.

## Constraints

- Land gap 2 (the socket downgrade) even if the rest of the feature slips. It is
  a privilege boundary the HTTP path already enforces and the socket path does
  not.
- Put the 401 handling in the shared client layer, not per screen — every caller
  routes through `send()`, which is what makes this the root-cause fix rather
  than eleven patches.

---
*Implementer: append what changed and what you verified below this line.*

---

## Landed 2026-09-17 (Claude) — all three numbered gaps

- **§1 session loss** — handled at the one place every request passes through.
  `send()` in both clients publishes a reason on a 401 (`ui/src/sessionEnded.ts`,
  written once in `ui/` as the critique asked); both `App.tsx` shells subscribe,
  clear the session and drop to the sign-in screen; both `SignInScreen`s take a
  `notice` and render it. New tokens `signIn.notice.sessionEnded` and
  `signIn.notice.passwordChanged`, both translated.
- **§2 the socket downgrade (the security one)** — enforcement moved *into*
  `resolvePanelActor`, which now throws `RefusedActingTokenError` carrying the
  rejection reason. `hub.ts` catches it to emit `session:rejected`, then
  rethrows. The broadcast fan-out — the one caller that must not refuse — uses an
  explicitly named `resolvePanelActorAllowingRefusal`. `panel-actor.integration.
  test.ts` updated; its three fallback assertions now also assert the enforcing
  call refuses.
- **§3 self-service password change** — `ChangePasswordDialog` on the Master,
  reachable from the topbar on every screen. Because `changeOwnPassword` ends
  with `invalidateSessionsForUser` with no exception for the caller, the dialog
  says so *before* the button and §1 handles the window afterwards.

### Still open — the "related, smaller" list at the end of §2

- `invalidateSessionsForUser` still records no reason, so the sign-in screen says
  "your session ended" rather than "because your password changed". The
  `signIn.notice.passwordChanged` token exists and is unused, waiting for it.
- **Reset password** still has no self-exclusion: an administrator resetting
  their own password signs themselves out with no warning that they are about to.
- Whether a password change should push to that user's *other* live sessions
  (the `panel:revoked` path exists but is per-panel) is still undecided.
