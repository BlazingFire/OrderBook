# Task: put the new colourful Basic Home tiles into OrderBook, and rename "New pending order" to "New Order"

## Context
- This repo is OrderBook (npm workspaces: shared, ui, master, master/web, office, office/web). The shared React UI lives in `ui/src`, styles in `ui/src/tokens.css` + `ui/src/base.css`, and the design rules in `docs/DESIGN_SYSTEM.md`. Read `AGENTS.md` and `docs/DESIGN_SYSTEM.md` first and follow them.
- The Basic Home launcher is `ui/src/BasicHome.tsx`. Each module is drawn by its `Tile` component as `<Icon name={icon} size={36} />` inside `.ob-tile-face`, which is an 80px white box with a `--line` border in `base.css` at around line 2640. Its hover state turns the box `--accent-tint` with an accent border.
- The module → line-icon map is `NAV_ICONS` in `ui/src/navIcons.ts`, and `ui/tests/nav-icons.test.tsx` guards it. The Basic Home tests are in `ui/tests/basic-home.test.tsx`.
- New tile artwork is in `docs/design/home-tiles/`: 21 SVG files, each 96×96, plus `preview.html` showing them all. Each SVG is a self-contained colourful tile (rounded square, gradient background, white glyph) with ids prefixed `ob-<name>-`.
- Design-system rule: icons are inline SVG — no image files, no icon font, nothing loaded at runtime. So the tiles must become inline React SVG components, not `<img src>`.

## Tile file → module id (NAV_ICONS key)
new-order → the "new lead" tile (id `newLead`) · dashboard → dashboard · pending-orders → leads · final-orders → orders · conflicts → conflicts · chatroom → chatroom · printroom → printroom · reports → reports · products → products · parties → parties · party-access → partyAccess · lists → the Lists module (find its id in AppShell / nav groups) · settings → settings · app-update → updates · notice-board → notices · office-panels → panels · roles-users → access · fields → fields · activity-log → logs · recycle-bin → recycleBin · integrations → integrations.
If a module id exists in the nav that has no tile (for example `noticesManage`), it keeps the current line icon as a fallback. Report any id you could not match instead of guessing.

## Do this
1. **Make the tile components.** Create `ui/src/tileIcons.tsx`. Convert each SVG in `docs/design/home-tiles/` into a React component, keeping the shapes, colours and gradients exactly. Write a small script for the conversion rather than retyping by hand. JSX attribute names change (`stroke-width` → `strokeWidth`, `stop-color` → `stopColor`, and so on). Make the ids unique per rendered instance with `useId()`, so two copies on one page don't clash. Each component takes `size` (default 80) and renders `aria-hidden="true"`; the button label already names the module. Export `TILE_ICONS: Partial<Record<NavIconId | 'newLead', ComponentType<{ size?: number }>>>`.
2. **Use them in BasicHome.** In `BasicHome.tsx`, `Tile` renders `TILE_ICONS[id]` at 80px when one exists. Otherwise it falls back to the existing `<Icon name={icon} size={36} />` inside the current bordered face.
3. **Update the tile CSS** in `base.css`. When `.ob-tile-face` holds a colour tile (add a modifier class such as `.ob-tile-face--art`), remove its border, background and padding and let the SVG fill the 80px face. Hover: `transform: translateY(-2px)` over `var(--d-fast) var(--e-standard)`, with no colour change. Pressed: back to `translateY(0)`. Keep the focus ring exactly as it is (2px accent outline, 2px offset); it must stay visible around the art. Under `prefers-reduced-motion`, no transform. Keep the label, count badge and shortcut chip positions unchanged. Use only tokens; add no raw values.
4. **Leave the sidebar alone.** It keeps the 16px line icons. Colour tiles appear on Basic Home only.
5. **Rename.** In `shared/src/i18n/en.ts`, change `'basicHome.newLead'` to `'New Order'`. Search the repo for any other user-facing "New pending order" text (i18n strings, command palette entries, sub-nav labels, tooltips, docs) and change it to "New Order". Do not rename code identifiers, routes, permissions or DB values; only visible text and docs change.
6. **Tests.** Update `basic-home.test.tsx` and `nav-icons.test.tsx` as needed, and add a test that every Basic Home tile id resolves either to a `TILE_ICONS` entry or to the fallback.
7. **Docs.** In `docs/DESIGN_SYSTEM.md`, add a short "Basic Home tiles" section covering:
   - colour appears only on Basic Home, as the one exception to colour-neutral chrome;
   - tiles are never used in the sidebar or below 32px;
   - where the source SVGs live (`docs/design/home-tiles/`);
   - the module → colour list.

   Also note the rename.
8. **Run `npm run verify`** (lint, typecheck, tests) and fix anything that fails.

## Constraints
- Don't change `tokens.css` values, and don't load any external stylesheet or font. The app works offline.
- Don't add any money, rate or stock UI.
- Desktop only; no phone layout work.
- Commit on a new branch with a clear message. Don't push unless asked.

## When done, report
The files changed, any module ids that had no matching tile, and the `npm run verify` result.
