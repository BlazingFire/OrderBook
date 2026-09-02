# Design audit — high-priority items (contrast, sticky header, confirm dialogs, sorting, scale floor)

**Owner:** Command Code for items 1, 3, 4 (behavioral/logic changes worth
`npm run verify` rigor); Qwen 3 for items 2, 5 (mechanical token/CSS edits).
**Reviewer:** Claude (visual/wording check).
**Size:** M overall — five independent items, land as separate commits.

From a read-only Apple-HIG-grounded design pass over both panels' shared UI
package and screens. Contrast figures are computed from the literal hex
values in `ui/src/tokens.css` (WCAG 2.x relative-luminance formula) — spot
check a couple yourself before trusting all of them blindly, but the method
is sound.

## 1. Secondary buttons and inputs are visually flush with the card behind them

**Files:** `ui/src/base.css:120-124` (`.ob-btn--secondary`), `:382-394`
(`.ob-input`/`.ob-select`/`.ob-textarea`), `ui/src/tokens.css:49` (`--line`)

`--line` (`#d6dbde` on white = 1.40:1; dark theme ~1.29:1) is used both as
the card boundary AND as every secondary button's and input's border — and
`.ob-card` uses the identical `--bg-surface` fill as those controls, so a
secondary button or input sitting inside a Card has almost no visible
boundary. WCAG 1.4.11 (Non-text Contrast) wants ≥3:1 for identifying a
control.

**Fix:** add a new token `--line-control` at ≥3:1 against surface — light
`#8d979d` (3.05:1), dark `#6b787e` (3.02:1) — in `ui/src/tokens.css`, and
apply it to `.ob-btn--secondary`, `.ob-btn--danger`, `.ob-input`,
`.ob-select`, `.ob-textarea`, `.ob-filterchip` borders in `base.css`. Leave
plain `--line` for decorative separators (it's fine there).

## 2. The offline/"not synced" status pill fails AA contrast in light theme

**Files:** `ui/src/tokens.css:29` (`--kiln-amber: #b26a00`),
`ui/src/base.css:749-752` (`.ob-pill--offline`)

`#b26a00` on its own tint = 3.75:1, on white = 4.24:1 — both below the 4.5:1
floor for the 11px text this pill uses. This is the badge shown on every
unsynced lead/party/order card in the Office panel — arguably the
most-read status color in the product, and light theme is Office's default.

**Fix:** darken the **light-theme only** `--kiln-amber` to `#8a5200`
(5.98:1 on tint, 6.76:1 on white). Don't touch the dark-theme amber — it
already passes (6.79:1). Green and red status colors already pass; leave
them alone.

## 3. The sticky table header doesn't actually stick

**Files:** `ui/src/base.css:505-516` (`.ob-table thead { position: sticky }`),
`ui/src/DataTable.tsx:75-80` (`.ob-tablewrap { overflow: auto }`)

`.ob-tablewrap` has `overflow: auto` with no height constraint, so it grows
to the table's full height and never itself scrolls — the real scroller is
the enclosing `.ob-pane`. That makes `.ob-tablewrap` the sticky containing
block instead of `.ob-pane`, so `position: sticky` on `thead` never
activates: scrolling a long Parties/Orders list carries the header away
with the rows.

**Fix:** remove `overflow: auto` from `.ob-tablewrap` so `.ob-pane` becomes
the sticky ancestor, and set `background: var(--bg-sunken)` on `.ob-table
thead` itself (not just its `th` cells) so nothing shows through while rows
scroll under it.

## 4. Three different confirmation mechanisms in the product, including raw `window.confirm()`

**Files:** `master/web/src/screens/AccessScreen.tsx:1100` (the product's own
Modal-based confirm — the right pattern) vs `:1588` and
`office/web/src/screens/AddLeadScreen.tsx:473`,
`office/web/src/screens/SignInScreen.tsx:94` (raw `window.confirm(...)`)

`window.confirm()` in Electron renders the bare Chromium dialog — no app
theme, blocks the renderer, shows the page origin in its title on Windows.
`ui/src/Modal.tsx`'s own doc comment states the product's rule about never
having two competing dismiss mechanisms at once, and a `window.confirm`
fired from inside an already-open Modal violates it directly (see
`AccessScreen.tsx:1588`, which is 500 lines from the screen's own correct
Modal-confirm pattern at `:1100`).

**Fix:** promote the existing Modal-confirm pattern into a shared
`ConfirmDialog({open, title, body, confirmLabel, tone, onConfirm, onCancel})`
component in `ui/src/`, and replace all three raw `window.confirm` call
sites with it. Note: `useResetGuard`'s current synchronous-boolean return
contract (used by the `AddLeadScreen.tsx:473` call site) will need to
become promise-based to support an async Modal confirm — that's the one
non-mechanical part of this change; trace every caller of `useResetGuard`
before changing its return type.

## 5. No column sorting exists anywhere in the product

**File:** `ui/src/DataTable.tsx:151-162`

Confirmed by grep (`sortBy|onSort|aria-sort|sortDirection` across `ui/src`,
`master/web/src`, `office/web/src`): zero hits. `DataTable` is the primary
view for parties, products, leads, orders, users and roles, with no way to
order by name, date, amount, or stock level — the single most expected
desktop-table affordance is entirely absent.

**Fix:** add `sortable?: boolean` to `DataTableColumn` and a
`sort?: {key, dir}` / `onSortChange` prop to `DataTable`. Render sortable
headers as `<th aria-sort={...}><button>` with a caret glyph; sort `rows`
in a `useMemo` before the existing virtualization slice (it already
operates on a plain array — this is additive, not a restructure).

## 6. At the scale slider's own minimum (11px root), most chrome falls below legible/tappable floors

**Files:** `ui/src/theme.ts:28` (`SCALE_MIN = 11`), `ui/src/tokens.css:82,90`
(`--t-eyebrow-size`, `--t-micro-size`), `ui/src/base.css:342-353`
(`.ob-filterchip`)

At `SCALE_MIN`, eyebrow/micro text (table headers, card labels, status
pills) resolves to **8.6px**, and `.ob-filterchip` height to **17.3px**
(15.7px at Compact density too). HIG's desktop floors are ~10pt text and
20×20pt targets — the product's own settings slider lets an operator walk
under both with nothing stopping them.

**Fix (prefer the clamp over raising the floor — keeps the slider's range
useful for table bodies while protecting labels):**
```css
--t-eyebrow-size: max(0.7857rem, 10px);
--t-micro-size: max(0.7857rem, 10px);
.ob-filterchip { height: max(calc(var(--ctl-h-md) - 0.5714rem), 20px); }
```
If a clamp feels wrong once you see it running, the alternative is raising
`SCALE_MIN` from `11` to `12.5` in `ui/src/theme.ts` — note in this file
which you picked.

## Done looks like (all five items)

- `npx tsc -p ui/tsconfig.json --noEmit`, `npm run lint` clean.
- Visually verify each in both light and dark theme, at both panels — these
  are CSS/contrast/interaction fixes; a typecheck won't catch a wrong hex or
  a still-broken sticky header.
- `npm run verify` green.

---
*Implementer: append what changed and what you verified below this line.*
