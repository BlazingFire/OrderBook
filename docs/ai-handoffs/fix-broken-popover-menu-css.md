# Fix it now: the sync popover and Lead-board menu have no CSS at all

**Owner:** Command Code. **Reviewer:** Claude.
**Size:** S, but treat as **higher priority than the other design briefs** —
this is a broken core interaction, not polish. Verified independently (not
just trusting the audit that found it):

```
grep -rn "\.ob-popover\|\.ob-menu\b\|\.ob-menu-item" ui/src master/web/src/styles.css office/web/src/styles.css
→ zero matches anywhere
```
but the classes ARE used, in four places:
- `ui/src/Popover.tsx:43`
- `office/web/src/App.tsx:698` and the sync-status click-away shim near it
- `master/web/src/App.tsx:593`
- `office/web/src/screens/LeadBoardScreen.tsx:292`

## What's actually broken

1. **`ui/src/Popover.tsx`'s `.ob-popover` div** has no `position`, no
   `background`, no `border`, no `box-shadow`, no `z-index` anywhere in the
   stylesheet cascade. The component sets `left`/`bottom` **inline** via
   `anchorStyle`, but with no `position` rule those coordinates are inert
   (a statically-positioned element ignores `top`/`left`/etc.) — so it
   renders in normal document flow with a **transparent background**,
   whatever is behind it showing through.
2. **Both panels' sync-status popover** (the thing a staff member clicks
   when the panel shows offline/pending) is built on this component. Its
   click-away shim (`office/web/src/App.tsx:694`, mirrored on Master) is
   `position: absolute` with `zIndex: var(--z-popover)` — since the popover
   itself has no `position`/`z-index` rule, the shim can end up **painted
   above it**, meaning every control inside the popover, including its own
   Close button, may not receive clicks.
3. **The Lead board's kebab menu** (`LeadBoardScreen.tsx:292`, using
   `.ob-menu`/`.ob-menu-item`) renders as three bare, unstyled, padding-less
   buttons shoved directly into the card's normal flow — no dropdown
   surface at all, just inline buttons pushing the card's content down.

## Fix

Add to `ui/src/base.css` (this is the shared package both panels consume —
fix it once, here, not per-panel):

```css
.ob-popover {
  position: absolute;
  background: var(--bg-surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--sh-2);
  z-index: var(--z-popover);
}

.ob-menu {
  display: flex;
  flex-direction: column;
  min-width: 11rem;
  padding: var(--s-4);
}

.ob-menu-item {
  display: flex;
  align-items: center;
  height: var(--ctl-h-md);
  padding: 0 var(--s-8);
  border-radius: var(--r-sm);
  text-align: left;
}

.ob-menu-item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.ob-menu-item:disabled {
  opacity: 0.45;
}
```

(Check the exact token names — `--bg-surface`, `--line`, `--r-md`, `--sh-2`,
`--z-popover`, `--bg-hover`, `--ctl-h-md`, `--r-sm`, `--s-4`, `--s-8` — against
`ui/src/tokens.css` before pasting; adjust to whatever the real names are if
any differ from this sketch.)

Then raise the click-away shim's z-index above the popover's, e.g.
`zIndex: calc(var(--z-popover) - 1)` in both `office/web/src/App.tsx` and
`master/web/src/App.tsx` (search each for the sync-popover shim) — actually
check the layering direction carefully: the shim needs to sit **behind** the
popover content but **above** everything else, so it must be *lower* than
the popover's z-index, not higher; verify by testing, don't just trust the
arithmetic here.

## Done looks like

- `npx tsc -p ui/tsconfig.json --noEmit` clean.
- `npm run lint` clean.
- **Manually verify in the running app** (`npm run dev:master` and
  `npm run dev:office`) — this is a visual/interaction bug that a typecheck
  cannot catch:
  - Click the sync status indicator in the topbar on both panels; confirm a
    real dropdown surface appears (background, border, shadow) and its
    Close button and every control inside it is actually clickable.
  - Click a Lead card's kebab menu on the Office Lead board; confirm a real
    dropdown appears instead of three bare buttons in the card's flow.
  - Check both light and dark theme.

## Constraints

- Fix the shared `.ob-popover`/`.ob-menu` CSS once in `ui/src/base.css` —
  do not duplicate it into either panel's own `styles.css`.
- If you find a THIRD consumer of `.ob-popover`/`.ob-menu` while you're in
  there, it gets the same fix for free — no extra work needed, just confirm
  it too.

---
*Implementer: append what changed and what you verified below this line.*
