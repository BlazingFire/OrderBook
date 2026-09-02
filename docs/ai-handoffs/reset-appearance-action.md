# One "Reset appearance" action for Scale + Density + Motion together

**Owner:** Qwen 3 (via OpenCode). **Reviewer:** Command Code.
**Size:** S.

## Goal

On the Settings screen's Appearance card, **Scale** already has its own
per-control reset button (`t('settings.scale.reset')`, resets to
`SCALE_DEFAULT`). **Density** and **Motion** don't — so returning a machine
to its shipped defaults after experimenting means three separate manual
corrections (drag the scale slider back, click Comfortable, toggle motion
back on) instead of one. Add a single "Reset appearance" action that resets
all three at once, **in addition to** keeping the existing per-scale reset
button (don't remove it — some people only want to reset the one thing they
just changed).

Defaults, confirmed from source:
- Scale → `SCALE_DEFAULT` (`ui/src/theme.ts` — already imported in both
  screens as `SCALE_DEFAULT`).
- Density → `'comfortable'` (`ui/src/theme.ts:63`,
  `loadDensity()`'s fallback).
- Motion → **on** (i.e. `motionOn = true`; the Switch is inverted — checked
  means motion is *off* — see the existing `handleMotionChange` in both
  files, which flips the boolean before calling `applyMotion`).

## Files to touch

**This exists on both panels, with the same layout but a different i18n key
namespace — don't copy-paste one screen's key names onto the other:**

- `master/web/src/screens/SettingsScreen.tsx` — keys are namespaced
  `settings.theme.*`, `settings.scale.*`, `settings.density.*`,
  `settings.motion.*` (flat, one level).
- `office/web/src/screens/SettingsScreen.tsx` — keys are namespaced
  `settings.appearance.*` (e.g. `settings.appearance.scaleReset`,
  `settings.appearance.density`) — **do the same edit here too**, using
  this screen's own existing key style, not Master's.
- `shared/src/i18n/en.ts` + `shared/src/i18n/hi.ts` — two new keys (one per
  panel's naming convention, or reconcile into one shared key if you check
  and find the two screens could safely share it — your call, but if you do
  reconcile them, update BOTH screens to use the same key and confirm
  neither screen's snapshot/parity test breaks).

## Design

Add one `Button` (ghost or secondary variant, matching the existing
`settings.scale.reset` button's variant/size) near the top of the
Appearance card — e.g. next to the card's title/subtitle, or as a small
right-aligned action in the card header. On click, call each screen's
existing handlers with the defaults above:

```ts
function resetAppearance(): void {
  handleThemeChange(theme); // NOT included — see note below
  handleScaleChange(SCALE_DEFAULT);
  handleDensityChange('comfortable');
  handleMotionChange(false); // false = motion OFF is unchecked = motion ON; check the exact inversion in situ before trusting this line literally
}
```

**Note on theme:** the raw suggestion this brief comes from only names
Scale + Density + Motion — **not** Theme (light/dark). Leave Theme alone;
resetting someone's light/dark preference as a side effect of an
"appearance reset" they didn't ask for would be surprising. If you disagree
after looking at it, say so in this file rather than silently deciding
either way.

Disable the new button when all three are already at their defaults
(mirror the existing `disabled={scale === SCALE_DEFAULT}` pattern on the
per-scale reset button, extended to check all three).

## New i18n keys

Something like `settings.appearance.resetAll` (Master) /
`settings.appearance.resetAll` (Office, already in that namespace — check
if you can literally share one key here since both screens already use
`settings.appearance.*`... actually Master's file uses `settings.scale.*`
not `settings.appearance.*` per the grep above, so they likely can't share
without a bigger rename. Use your judgment; don't force a shared key if it
means renaming Master's whole existing appearance-key family — that's out
of scope for this brief).

## Done looks like

- `npx tsc -p master/web/tsconfig.json --noEmit` and
  `npx tsc -p office/web/tsconfig.json --noEmit` clean.
- `npm run lint` clean.
- `npx vitest run master/tests/i18n-tokens.test.ts master/tests/i18n-call-sites.test.ts` pass.
- Manually verified in both running panels: change Scale, Density, and
  Motion away from their defaults, click the new button, confirm all three
  visibly snap back and the button becomes disabled again; confirm Theme is
  untouched by it.

## Constraints

- Both panels, not just one — this is exactly the kind of thing that drifts
  if only one side gets it (see `master/tests/party-access-screen-parity.test.ts`'s
  own header for why this codebase cares about that class of drift, even
  though these two Settings screens aren't held byte-identical the way
  PartyAccessScreen is).

---
*Implementer: append what changed and what you verified below this line.*
