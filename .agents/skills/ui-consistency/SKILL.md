---
name: ui-consistency
description: Keep OrderBook UI consistent across Master and Office panels. Use when adding or changing any screen, component, style, breakpoint, or user-facing string.
---

# UI consistency

Both panels render from one kit. A UI change that touches only one panel, or
bypasses the kit, is a defect even when it renders.

## One kit, two panels

- Import UI from `@orderbook/ui` (`ui/src/index.ts` is the public surface —
  add a file, add a line). Never copy a component into `master/web/src` or
  `office/web/src`: that duplication existed before (26 byte-identical files)
  and Stage 3 removed it.
- The kit is consumed as source, not a build artifact. No CDN, no web fonts
  at runtime — `ui/src/fonts/` only (offline-only rule).

## Scale contract (machine-checked)

`master/tests/ui-conventions.test.ts` enforces this; read it before arguing:

- Breakpoints are physical px, never rem/em (`ui/src/breakpoints.ts`:
  `BP_NARROW` 1180px, `BP_TIGHT` 1080px, `BP_SHORT` 800px height). Scale must
  never change what is on screen, only how big it is.
- Lengths measured against text use rem; hairlines and radii stay px
  (`ui/src/tokens.css`). Scale (font size) and density (row/control height)
  are orthogonal — a density block must never set `--root-size`.

## Strings

- Every user-facing string goes through the i18n catalogue
  (`shared/src/i18n/en.ts`, `hi.ts`). A bare string in JSX is a defect;
  `master/tests/i18n-call-sites.test.ts` checks call sites. Add the `en` key
  and the real `hi` translation together; run `npm run i18n:sync` after.
