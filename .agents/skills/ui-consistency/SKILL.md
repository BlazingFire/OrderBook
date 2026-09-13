---
name: ui-consistency
description: Keep OrderBook UI consistent across Master and Office panels when adding or changing screens, components, styles, breakpoints, or user-facing strings.
---

# UI Consistency

Both panels render from one kit. A UI change that touches only one panel, or bypasses the kit, is a defect even when it renders.

- Import UI from `@orderbook/ui` (`ui/src/index.ts` is the public surface). Never copy a component into `master/web/src` or `office/web/src`.
- Breakpoints are physical px, never rem or em (`ui/src/breakpoints.ts`). Lengths measured against text use rem; hairlines and radii stay px (`ui/src/tokens.css`). Scale (font size) and density (row and control height) are orthogonal.
- Every user-facing string goes through the i18n catalogue (`shared/src/i18n/en.ts`, `hi.ts`). A bare string in JSX is a defect.
