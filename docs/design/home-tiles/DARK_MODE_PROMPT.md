# Task: use the dark-theme Basic Home tiles when OrderBook is in dark mode

## Context
- Read `AGENTS.md` and `docs/DESIGN_SYSTEM.md` (section 6.2, Basic Home tiles) first.
- `docs/design/home-tiles/*.svg` are the light-theme tiles. `docs/design/home-tiles/dark/*.svg` are new dark-theme versions with the **same file names**:
  - a deep, hue-tinted ground instead of the bright gradient;
  - the glyph drawn in a light tint of the module's colour, details in the tile's dark ink;
  - a rim in the module colour;
  - black glyph shadows.

  `preview.html` shows both sets.
- `tools/make-tile-icons.mjs` converts the light SVGs into `ui/src/tileIcons.tsx` (`TILE_ICONS`). The theme is `data-theme="dark"` on `<html>`, set by `ui/src/theme.ts`.
- A tile for Notice board management (`notice-board-manage.svg` → module id `noticesManage`) now exists in both sets. If it is not mapped yet, add it to the generator's tile list.

## Do this
1. **Update the generator.** Extend `tools/make-tile-icons.mjs` to also read `docs/design/home-tiles/dark/`. For each tile, emit one component that renders **both** SVGs inside the face:
   - the light one with class `ob-tile-art ob-tile-art--light`;
   - the dark one with class `ob-tile-art ob-tile-art--dark`.

   Ids stay unique per instance (`useId`, with a different suffix per variant). Both get `aria-hidden`. Regenerate `ui/src/tileIcons.tsx` with the script and never edit it by hand.
2. **Switch by theme in CSS** (`ui/src/base.css`):
   - `.ob-tile-art--dark { display: none }`
   - `:root[data-theme='dark'] .ob-tile-art--light { display: none }`
   - `:root[data-theme='dark'] .ob-tile-art--dark { display: block }`

   No JavaScript theme lookup, so a theme switch is instant and no tile flickers.
3. **Tests.** Every `TILE_ICONS` entry must have both variants; add that check to the Basic Home tests. Run `npm run verify` and fix anything that fails.
4. **Docs.** In `docs/DESIGN_SYSTEM.md` 6.2, add a line: "Dark theme: `docs/design/home-tiles/dark/`, same names; switched by CSS on `data-theme`."

## Constraints
- Don't change the light tiles or any token values.
- Work on a new branch and don't push.
- Report the files changed and the verify result.
