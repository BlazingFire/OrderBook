# OrderBook design system

The owner's design (the artifact "OrderBook Logo Set", 2026-10-07) is the source of truth for how OrderBook looks:
the mark, the tokens, every component and the new pending order screen. This file records it in one place, next to
the code that implements it. Its artboards are saved read-only under `.design-ui/project/*.dc.html` (untracked, in
the main checkout); each section below names the artboard it comes from.

Status of this file: written from the artboards on 2026-10-07, then brought in line with the code as each helper's
work landed (section 11, "Where it lives in the code"). Where the code differs from the artboards on purpose, section 10
says why.

## 1. Principles

- **The chrome is colour-neutral, because colour is data.** The interface is porcelain greys plus one accent (glaze
  blue). The only colours that mean something are product colours, status and state. The mark's squares are never
  recoloured with product colours.
- **Semantic tokens only.** A component names a role (`--fg-secondary`, `--accent`), never a hex value.
- **Keyboard first.** Every control is reachable and operable from the keyboard; the focus ring is never removed
  (2 px accent outline, 2 px offset). Labels sit above fields; errors say what failed and what to do.
- **Active verbs, sentence case** on buttons ("Save changes", "Convert to order"). One primary button per view.
- **Calm motion:** transform and opacity only, three durations (below), and `prefers-reduced-motion` shows the
  final frame.
- **Desktop only**, 1024 x 768 up to 4K; no phone layout.
- **Offline.** Inter and IBM Plex Mono are bundled with the program (`ui/src/fonts`). The artboards link Google Fonts;
  the app never does. Icons are inline SVG, no icon font, no image file, no CDN.
- **No money anywhere.** The artboards show a Rate column, a `₹` field, `₹ 1,57,500` on a kanban card and stock columns
  ("On hand", "Reserved"). OrderBook carries no rates, amounts, totals or stock (HANDOFF decisions), so none of these is
  built. See section 10.

## 2. Tokens (artboard: Tokens)

### 2.1 Colour: the porcelain ramp

| Token | Light | Dark | Use |
|---|---|---|---|
| `porcelain-00` | `#FFFFFF` | `#151C1F` | surface (cards, panels, sidebar) |
| `porcelain-05` | `#F2F4F5` | `#0E1315` | canvas, hover |
| `porcelain-10` | `#E9ECEE` | `#0A0F11` | sunken (table header, segmented track, disabled fill) |
| `porcelain-20` | `#D6DBDE` | `#263136` | hairline lines |
| `porcelain-30` | `#B9C1C6` | `#3A484E` | strong lines, control borders, disabled text |
| `porcelain-50` | `#6E7C84` (design) | `#7E8E96` | tertiary text, eyebrows; see the contrast rule below |
| `porcelain-70` | `#46535B` | `#9AA9B0` | secondary text |
| `porcelain-90` | `#10161A` | `#E6EDF0` | primary text |

**Contrast rule (owner decision via the lead session, 2026-10-07).** Where the design's value fails WCAG 4.5:1 as
text, the product keeps its darker value **for text** and uses the design value only for fills, borders and dots.
Measured on the light theme: `porcelain-50` `#6E7C84` is 4.30:1 on white, 3.90:1 on canvas and 3.63:1 on the sunken
fill; the product's `#5D6B73` is 5.50:1, 5.10:1 and 4.64:1. Amber `#B26A00` is 4.24:1 on white and 3.75:1 on its own tint;
the product's text amber `#8A5200` is 6.39:1 and 5.66:1. The dark values all pass (`#7E8E96` is 5.09:1 on the dark surface,
`#E0A040` 6.79:1 on its tint). The final per-token values are those of `ui/src/tokens.css` (section 11).

### 2.2 Accent and state

| Token | Light | Dark | Use |
|---|---|---|---|
| `glaze-50` (accent) | `#14509E` | `#5B9BF0` | primary button, links, active nav, focus ring, selection |
| `glaze-60` (accent-hover) | `#0F4088` | `#7DB0F4` | primary hover and pressed |
| `glaze-05` (accent-tint) | `#E3ECF8` | `#16283F` | active nav row, selected row, "In progress" pill, filter chips |
| `amber` / `amber-05` | `#B26A00` (fills, borders; text uses `#8A5200`) / `#FBF0DC` | `#E0A040` / `#2E2313` | offline, postponed, due today, temporary id |
| `red` / `red-05` | `#A8231F` / `#FAE9E8` | `#E8706B` / `#331716` | error, conflict, destructive, cancelled |
| `green` / `green-05` | `#1F6F4A` / `#E4F1EA` | `#4FB483` / `#10281D` | success, dispatched, update ready |

Status pill mapping (Data artboard): New = porcelain-10 / porcelain-70; In progress = accent-tint / accent;
Postpone = amber-05 / amber; Dispatched = green-05 / green; Cancelled = red-05 / red.

### 2.3 Type

Inter for text, IBM Plex Mono for ids, codes and shortcuts. Figures that line up use tabular numerals.

| Role | Size / line | Weight | Notes |
|---|---|---|---|
| display | 24 / 28 | 600 | letter-spacing -0.02em; screen titles in artboards |
| title | 18 / 24 | 600 | letter-spacing -0.01em; page, drawer and modal titles |
| eyebrow | 11 / 14 | 600 | uppercase, letter-spacing 0.07em, `fg-tertiary`; group labels, table headers, field labels in the new order form |
| body | 14 / 20 | 400 | |
| body-strong | 14 / 20 | 550 | |
| data | 13.5 / 18 | 450 | tabular figures |
| small | 12.5 / 16 | 400 | `fg-secondary`; field labels (500), helper text, chips |
| micro | 11 / 14 | 500 | letter-spacing 0.02em; counters, pills |
| mono | 12.5 / 18 | 400 | letter-spacing 0.01em; ids such as `LD00000000ZK` |

### 2.4 Space, radius, elevation, motion

- **Space**, 4 px base: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56.
- **Radius:** sm 4 (inputs, chips, pills, kbd), md 6 (buttons, menus, tooltips), lg 10 (cards, modals, panels).
- **Elevation:** 1 hairline (white, 1 px `porcelain-20` border), 2 float (`0 4px 12px rgba(16,22,26,.10)`: menus,
  popovers, tooltips), 3 modal (`0 16px 40px rgba(16,22,26,.18)`: modals, drawers). A dragged kanban card has an outline and no shadow.
- **Motion:** fast 120 ms (hover, focus, checkbox, chip), base 160 ms (dropdown, tab, tooltip, expand), slow 220 ms
  (modal, drawer, kanban settle). Easing standard `cubic-bezier(.2,0,0,1)`; exit `cubic-bezier(.4,0,1,1)`, one step faster.

### 2.5 Size and scrollbars (artboard: Scroll)

The Scroll artboard shows three per-machine densities (compact: root 13, row 28, control 26; comfortable: root 14, row 32, control 30;
large: root 16, row 38, control 36). **The product does not build them (decision of the lead session, 2026-10-07): there is no
density setting.** A single set remains: table row 32 and controls 26 / 30 / 36 (small, default, large) at the 14 px root. The
**size slider** (the app scale, root 11 to 22 px, shown as 79 % to 157 %) is the only size control, and it scales everything.

Scrollbars: only the content area scrolls; thin, no arrows, colour change only. A 10 px gutter holding a 6 px thumb;
rest, hover and drag are three greys (light and dark each have their own); horizontal scroll is for wide tables only.

### 2.6 Token names in code (`ui/src/tokens.css`, names final, from D13)

Components use the semantic names only.

| Group | Names |
|---|---|
| Surfaces | `--bg-canvas`, `--bg-surface`, `--bg-sunken`, `--bg-hover`, `--bg-selected` |
| Text | `--fg-primary`, `--fg-secondary`, `--fg-tertiary`, `--fg-disabled`, `--fg-on-accent` |
| Lines | `--line`, `--line-strong`, `--line-control` (a control's border), `--line-focus` |
| Accent | `--accent`, `--accent-hover`, `--accent-tint` |
| State | `--state-offline`, `--state-conflict`, `--state-ok`, each with a `-tint`; new `--state-offline-fill` (the design's amber, for fills) |
| Ramps | `--porcelain-00` to `-90`, `--glaze-50`, `-60`, `-05`, `--kiln-*` |
| Fill-only design values | `--porcelain-50-fill` `#6E7C84`, `--kiln-amber-fill` `#B26A00`; text keeps `#5D6B73` (`--porcelain-50`) and `#8A5200` (`--kiln-amber`) for 4.5:1 |
| Type | `--t-<role>-size` and `--t-<role>-line` (in rem on the 14 px root; the eyebrow and micro sizes never go below 10 px) for display 24/28 600, title 18/24 600, eyebrow 11/14 600 caps, body 14/20, data 13.5/18 tabular, small 12.5/16, micro 11/14 500, mono 12.5/18 |
| Space | 4 px base, `--s-2` to `--s-56` (2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56) |
| Radius | 4, 6, 10 |
| Elevation | hairline, `--sh-2` (`0 4px 12px`), `--sh-3` (`0 16px 40px`); the dark theme uses black shadows at .45 and .60 |
| Motion | `--d-fast` 120, `--d-base` 160, `--d-slow` 220, `--d-exit` 140 ms; `--e-standard` `.2,0,0,1`, `--e-exit` `.4,0,1,1`, `--e-spring` (a small overshoot, kept for the kanban settle) |
| Focus ring | 2 px solid accent, offset 2 px |

**Scrollbars (as built):** `--scrollbar-w` 10 px gutter holding a 6 px thumb with radius 4, a transparent track (the track tokens are gone);
the thumb is always drawn (not only on hover); `--scrollbar-thumb` = `--porcelain-30`, `--scrollbar-thumb-hover` = `--porcelain-50-fill`,
`--scrollbar-thumb-active` = `--porcelain-70`.

**Sizes:** `--row-h` 32 px (2.2857rem), `--ctl-h-sm` / `-md` / `-lg` 26 / 30 / 36 px, `--shell-footer-h` 26 px. In the dark theme `--porcelain-50` and
`--porcelain-50-fill` are the same `#7E8E96` and `--kiln-amber` and `--kiln-amber-fill` the same `#E0A040`, since both pass as text.

**Retired:** the per-machine density (`ob.density`, `data-density`), the `--tile-*` set of the old glossy icon tiles, and `--r-xl`.
The status footer is 26 px tall (`--shell-footer-h`).

## 3. The mark (artboards: Main, Marks, Usage, Mark, Icons, Panels)

**What it is.** A 4 x 3 lattice of 4-unit squares on a 24 x 24 grid with 2-unit gutters, each square `rx` 0.6, an SVG of
about 600 bytes inlined, no icon font and no image file. Rows: 2 of 4 squares (the top row's last two are the "ghost"),
then 4 of 4, then 4 of 4. Square origins (x, y): row 1 at y 4 (x 1, 7; ghosts at x 13, 19 drawn at 20 % opacity),
rows 2 and 3 at y 10 and 16 (x 1, 7, 13, 19). The idea: a stock grid, a row of colour swatches, a ledger filling up.

**Ghost.** The two ghost squares are the same shape at reduced opacity. At 24 px and below they are dropped (opacity 0) so the
mark stays crisp. Kit prop: `size`, `ink`, `ghost` (0 to 1).

**Colour variants.**

| Use | Ink | Ghost opacity | Ground |
|---|---|---|---|
| Cobalt on white (default) | `#14509E` | 0.20 | white |
| Ink on white (Master Panel) | `#10161A` | 0.18 | white |
| Reversed on cobalt | `#FFFFFF` | 0.30 | `#14509E` |
| Dark theme | `#5B9BF0` | 0.28 | `#0E1315` |
| One colour (print, stamp, fax) | `#000000` | 0 | white |
| One colour reversed | `#FFFFFF` | 0 | `#000000` |

**Lockups.** Wordmark in Inter 600, letter-spacing -0.02em, line-height 1. The lockup and marketing artboards spell it
"Order Book Software"; **inside the application the wordmark is "OrderBook"**, as the Sidebar artboard shows (15 px / 600), and
"Order Book Software" is used only on lockups, the splash and marketing material (owner's design, confirmed by the lead session, 2026-10-07).

| Lockup | Mark | Type | Gap |
|---|---|---|---|
| Primary, horizontal | 48 | 36 | 16 |
| Stacked | 64 | 26 | 14 |
| **Compact, in the app** | **24** | **18** | **8** |
| Mark only | 40 | n/a | window icon, collapsed sidebar |
| Program lockup | 40 | 20 over an eyebrow 11 | 12 |

**Clear space and minimum size.** Keep half the mark's height clear on every side. The lockup is never below mark 24 / type 18;
the mark alone is never below 16 px. Never recolour squares with product colours: colour is data.

**The programs.** Same mark; the program is named underneath by an eyebrow, and the icon tile tells them apart on a taskbar.

| Program | Eyebrow | Mark ink | Icon tile |
|---|---|---|---|
| Office Panel | OFFICE PANEL (accent) | cobalt | filled cobalt tile, white mark |
| Master Panel | MASTER PANEL (secondary text) | ink `#10161A` wordmark; mark cobalt in the tile | white tile, 1 px `#B9C1C6` border, cobalt mark |
| Developer Panel (vendor only, not in this product) | DEVELOPER PANEL | `#5B9BF0` | dark tile `#0E1315`, 1 px `#3A484E` border |

**App icon sizes.** Tile = rounded square filled `#14509E` with the white mark at 65 % of the tile (ghost 0.30).
Windows `.ico`: 256 master, radius 24; sizes 128 (radius 16), 64 (10), 48 (8), 32 (6), 24 (4), 16 (3); the mark inside is
96, 48, 36, 26, 20, 14. macOS `.icns`: 1024 master, radius 54 on 240 (not built; no macOS release). **24 and 16 drop the ghosts.**

**As built (D8, `ui/src/Mark.tsx`, `Logo.tsx`, `Splash.tsx`, `BusyMark.tsx`, `ui/src/logoCells.ts`, `tools/make-icons.mjs`).** `Mark({ size, ink, ghost, title })` draws the 24-unit "Fill"; the ink is `--accent`
and the ghost opacity `--ob-mark-ghost` (0.2 light, 0.28 dark); the two ghost squares are left out at 24 px and below. `Logo` and `LogoLockup` draw it in the app. `make-icons.mjs` renders every `.ico` size on its own with the Icons
artboard's tile radius and mark size (ghosts out at 24 and 16): the Office a cobalt tile with the white mark, the Master a white tile with a hairline and the cobalt mark, the clean-install tool the white mark on its warning red;
`master/installer/icon.ico` and `office/installer/icon.ico` are stamped into the program file by `tools/exe-icon.cjs`, and a test pins the committed files to what the script renders.
The splash is the mark at 56 px beside the wordmark: outline 0 to 240 ms, squares ink from 240 ms 34 ms apart, wordmark rises 4 px at 620 ms, the progress bar from 700 ms.

**Motion (artboard: Motion).**
- *Splash, 900 ms, once on a cold start:* 0 to 240 ms the 12-square outline draws (stroke-dashoffset); 240 to 620 ms the 10
  squares ink in with a 34 ms stagger (opacity 0 to 1, scale .88 to 1); 620 to 900 ms the wordmark rises 4 px.
- *Busy indicator, 700 ms loop:* the squares pulse in sequence (70 ms stagger, opacity .15 to 1); it is **the only loading
  indicator in the product**, no spinner anywhere, and it stops when the window loses focus. At 16 px it sits before the label
  ("Opening orders"). Reduced motion: no animation, final frame.

## 4. Buttons (artboard: Buttons)

Height 30 (comfortable), padding 0 12, radius 6, 1 px border, font 14 / 550. Sizes: small 26 (padding 0 10, 12.5 px),
default 30, large 36 (padding 0 16). Pressed moves down by `translateY(1px)`. Disabled: `cursor: default`, no hover.

| Variant | Default | Hover | Pressed | Disabled |
|---|---|---|---|---|
| Primary | accent fill, white text | `accent-hover` | `accent-hover`, 1 px down | fill `porcelain-10`, text `porcelain-30` |
| Secondary | white, 1 px `porcelain-30` border, primary text | fill `porcelain-05` | fill `porcelain-10` | border `porcelain-20`, text `porcelain-30` |
| Ghost | transparent, secondary text | fill `porcelain-05`, primary text | fill `porcelain-10` | text `porcelain-30` |
| Destructive | white, 1 px red border, red text | fill `red-05` | red fill, white text | |

Focus: 2 px accent outline, offset 2. **Loading** keeps the label, adds the 16 px busy mark before it (gap 8) and sets
`aria-busy="true"`; the verb turns into its gerund ("Saving", "Exporting", "Deleting").
With an icon: gap 6, padding 0 12 0 10 (icon left) or 0 10 0 12 (icon right); a shortcut hint ("Ctrl N") is a kbd at the end.
**Icon buttons** are 30 x 30 (26 for a close button), radius 6, secondary / ghost / tinted / red-text variants, always with an
`aria-label`.

**As built (`ui/src/Button.tsx`, `ui/src/base.css`).** Heights come from `--ctl-h-sm`, `--ctl-h-md`, `--ctl-h-lg` (26, 30 and 36 px at the 14 px root).
A busy button shows the busy mark (14 px, in the button's own ink) where its icon would be, sets `aria-busy`, and keeps a present-tense label
("Saving"); its fill does not turn into the disabled look. An icon first in the button trims that side of the padding so the glyph sits in the
corner. `IconButton` has three variants, `ghost` (default), `bordered` and `danger`, 30 px square. Hover, pressed (1 px down) and disabled follow the table.
Test: `ui/tests/form-controls-design.test.ts`.

## 5. Form controls (artboard: Inputs)

- **Text input:** height 30, padding 0 10, 1 px `porcelain-30` border, radius 4, white, 14 px. Label above (12.5 px / 500);
  helper below (12.5 px, secondary). Focus: 2 px accent border/outline. Error: red border and a message that says what
  failed and what to do. Disabled: label and text `porcelain-30`, fill `porcelain-10`, helper says what permission or condition
  is missing ("Needs record.reassignOwner to change.").
- **Textarea** (Notes): the same border and radius, label with "optional" in regular weight.
- **Number with unit:** a 30 px field with a grey prefix cell (`porcelain-05`, radius 4 0 0 4). (The artboard's prefix is `₹`; money is not built.)
- **Select:** native look in the same box, chevron right. **Combobox:** the open list is a level-2 panel; rows 28 px:
  mono code (12 px, 64 px wide, accent on the highlighted row), name 13.5 px, size 12.5 px secondary; a footer row (28 px)
  says "Up/down to move, Enter to add, Esc to close"; the highlighted row is `accent-tint`.
- **Date:** the same box with a calendar button.
- **Checkbox** 16 x 16, radius 4, 1 px `porcelain-30` border; checked = accent fill with a white tick; disabled = `porcelain-10` fill.
  **Radio** 16 x 16 circle, selected = 5 px accent border ring. **Switch** for per-machine settings, with the label to its right;
  a disabled switch names why ("Webhooks, Admin only").

**Control edges (decision of the lead session, 2026-10-07).** The edge of an input, select, checkbox, radio and switch track is
**`--line-control`** (`#848D94` light, `#6B787E` dark), **not** the artboard's `#B9C1C6`. The artboard value is 1.83:1 on white; `#848D94` is 3.38:1
on white and 3.06:1 on the canvas, which meets WCAG 1.4.11 (non-text contrast, 3:1). Decorative hairlines (cards, table rules) stay on `--line`.

**As built (`ui/src/Form.tsx`, `ui/src/base.css`).**
- `Input`, `Textarea`, `Select` share the field box; the select's arrow is the artboard's chevron (a 16 px inline SVG background), not the platform's.
  A label whose field is disabled goes quiet with it (`.ob-label:has(+ :disabled)`); placeholders use the muted text token.
- `FieldError` is a 14 px circled exclamation and the message, in the error colour; it says what failed and what to do.
- `Checkbox` is 16 px with a 3-stroke tick, or a dash when indeterminate. **`Radio` is new in the kit:** one choice of a group (members share a `name`),
  a ring that fills to a dot, drawn with the border, with the same focus and disabled treatment as the checkbox. `Switch` is 32 x 18.
- The combobox list rows are **32 px**, not the artboard's 28 (a larger target); the content of a row is as in the artboard.

## 6. Navigation (artboards: Navigation, Sidebar, Shell)

- **Sidebar:** 208 px wide, white, 1 px right border; collapsed 52 px (icons and the mark only, tooltip with the name). Header:
  the compact in-app lockup, the mark (24) beside the name "OrderBook" (the Sidebar artboard shows it at 15 px; the app uses 18 px / mark 24 / gap 8, see "As built").
  Groups follow the work: **Work, Catalogue, Output, Admin**, each with an eyebrow label (padding 8 8 4, then 12 8 4). A module the
  role cannot view is absent, not greyed out. Items: height 30, padding 0 8, gap 10, radius 6, icon then label (14 px, secondary
  text); **active** item = `accent-tint` fill, accent text, weight 550; a count sits at the right (11 px / 500).
- **Top bar:** 48 px, white, 1 px bottom border: breadcrumb or group eyebrow, the page title (16 to 18 px / 600), then a command
  box ("Command or search records", `Ctrl K` chip), notifications bell with a badge (15 px accent pill, 10 px), and a 26 px avatar.
  The top bar keeps the title readable: the command box and secondary actions collapse to icons on a narrow main column.
- **Filter chips:** 24 px, accent-tint fill, accent text, 12.5 px / 500 ("Status: Open"), with a remove x; "Add filter" is a dashed
  `porcelain-30` chip. **Segmented control** (List / Kanban): 24 to 26 px tall, track `porcelain-10`, the selected segment white with a 1 px line.
- **Tabs:** 36 px tall, 14 px; active = primary text, 550, a 2 px accent underline; hover = `porcelain-05` fill with rounded top;
  focus = 2 px accent outline; disabled = `porcelain-30`. A count is a micro badge (16 px, `porcelain-10`).
- **Status footer / presence rail:** 26 px tall, white, 1 px top border: sync state (Synced, Syncing N, Offline, "Offline, 4 pending"
  in amber 550, "3 fields resolved, review" as a link), company name, the signed-in person, the version in mono 11 px at the right.

**As built (D3, `ui/src/AppShell.tsx`, `ui/src/Tabs.tsx`, `ui/src/base.css`, both panels' `App.tsx`; `ui/tests/shell-design.test.tsx`).**
- **Sidebar lockup:** the mark at 24 px, the wordmark "OrderBook" at 18 px, gap 8 (the Main artboard's in-app lockup). Rows are **28 px** with a 10 px gap (the artboard draws 30), group
  bands 28 px, **sub-pages 26 px**, counts in the accent colour at 11 px / 500, the collapse button 36 px. **Collapsed**, the column shows 32 px square icon buttons, centred, with the mark
  alone on top and no scroll bar (so the centred icons stay centred).
- **Segmented control:** a sunken track (`--bg-sunken`) with the chosen segment as a raised chip with a hairline.
- **Tabs:** 36 px tall, a 12 px inset underline, a hover wash, a count badge after the label, a disabled tab that the arrow keys skip; every tab is visited when none is disabled.
- **Status footer:** a 26 px strip of 12 px-padded cells; **the sync state comes first** (in its own colour when it is not fine: offline, offline with pending changes, conflict), then the
  company, the person and the version (mono). The sync button's target is the whole strip height and never below 24 px.

### 6.1 Icons and Basic Home (owner V1: "ui icons not updated yet")

**One icon set**, inline SVG, flat line drawings on a 24-unit grid with a 1.75-unit round-capped, round-joined stroke in `currentColor` and no fill
(`ui/src/icons.tsx`: `Icon({ name, size = 16 })`, 53 names; each icon is a single path, a circle or rounded rectangle written as a path). The glossy gradient
tiles and the `navGlyphs.tsx` drawings are gone. A size is a prop: 16 px in the sidebar and in buttons (18 in a large button), 14 in field messages, larger on a tile.
Icons take the text colour of where they sit, so they follow the theme and the state (accent when active, red in a destructive control).

`ui/src/navIcons.ts` (`NAV_ICONS`) maps each module to one icon for **both** the sidebar and Basic Home, and no two modules share an icon
(`ui/tests/nav-icons.test.tsx` holds that). The Master and the Office build their navigation from this map.

**Basic Home tiles** are flat: `--bg-surface` face, a 1 px `--line` border, radius `--r-lg`, the module's icon large in `--accent`, the label under it, the
shortcut in a mono chip; hover fills `--accent-tint`. One colour for every tile (colour is data, not decoration). A module the role cannot open has no tile, as
it has no sidebar row: absent, never disabled.

## 7. Feedback (artboard: Feedback)

Say what is loading; say what failed and what to do next; no spinners.

- **Progress bar:** the fill moves by `scaleX` only. A line of text above names the job and the count ("Downloading update", "41.2 of 64.0 MB").
  States: offline pause (amber text, "import paused at 38%"), failure (red text with a "Download again" button), done (green text, "Update now").
- **Busy mark:** section 3. **Skeleton:** static (no shimmer), `porcelain-10` bars in the shape of the content.
- **Toasts:** bottom-left, 4 s, at most 3; an optional action button (accent text) such as "Open" or "Choose printer"; ids in mono.
- **Tooltip:** 400 ms delay, `porcelain-90` fill, `#E6EDF0` text, 12.5 px, radius 6, level 2; names the missing permission for a redacted value.
- **Banners:** offline ("You're offline. Work is saved on this machine and syncs when the server is back.") and conflict ("3 fields were resolved
  automatically." with a "Review" button), amber and red tints.
- **Empty states:** a title (14 / 550), one sentence, one button ("No leads yet", "Can't reach the server" with "Retry now").

**As built (D9, `ui/src/BusyMark.tsx`, `ProgressBar` in `UpdateProgress.tsx`, `TopProgress.tsx`, `States.tsx`, `Toast.tsx`, `Tooltip.tsx`, `base.css`).**
- `BusyMark`: the mark's ten cells at 40 % opacity, each lighting from 0.15 to full and back in reading order, 70 ms apart, on a 700 ms linear loop. The one spinner-like asset
  in the product; it stops while the window is in the background and holds still with every cell lit under reduced motion or the app's motion switch.
- `ProgressBar` (the only determinate bar, reuse it): `value` from 0 to 1, or `null` while the size of the job is unknown (an indeterminate sweep); what is happening on the left,
  the figure on the right, a 6 px track under them, and a fill that moves by `scaleX` only. Tones: `default`, `offline` (amber), `conflict` (red), `ok` (green).
  The thin **loading bar** at the top of a screen (`TopProgress`) is kept (the owner asked for it on 2026-10-01); it freezes into a static segment under reduced motion
  and pauses in the background. So "no spinners" holds, and bars are the only other movers.
- `Skeleton` and the skeleton rows are static: 28 px rows split by a hairline, a short key at the left, bars of varying length, a short figure at the right.
- Toasts: bottom left, 4 s, at most 3, a 16 px stroke icon (a tick for done in green and for news in accent, a ring with an exclamation for a failure), an optional action button;
  a failure interrupts, anything else waits its turn.
- **Tooltip** (`TooltipLayer`, mounted once by `ToastProvider`): a dark bubble with a small pointer, shown 400 ms after the pointer rests on something, never taking the pointer.
  It **takes over the `title` attribute**: while the pointer is on an element with a `title` the attribute is parked in `data-ob-title` so the browser's own tooltip does not also show,
  and given back when the pointer leaves; the words stay in `title` otherwise (tests and code that read it keep working). Nobody wraps elements.
- Banners and empty states use `States.tsx`; the Gallery screen (`ui/src/GalleryScreen.tsx`) shows each feedback component in every tone. Tests: `ui/tests/feedback.test.tsx`.

### 7.1 The notice slideshow (owner add-on V5; no artboard, built from the system's parts)

A band at the top of Basic Home on both panels (`ui/src/NoticeSlideshow.tsx`), inset like the launcher's sections and no wider than the Dashboard's content
(`ob-measure-wide`). It uses a surface band like the Feedback banners, the Data pills (`StatusPill`: conflict for Important, accent for Pinned) and the icon set's chevrons.
- **What it shows:** the reader's important and pinned notices that are not expired, **unread first**, then read ones, at most 8 (`cardNotices`, the same selection as the Dashboard card,
  from the same list the board shows, so the same audience). A slide is the title, the pills, the date and the start of the body (plain text). Pressing a slide opens that notice on the board
  (the board scrolls to it, opens it in full and focuses it). With nothing to show, nothing is drawn.
- **Rotation (WAI-ARIA carousel):** 6 s a slide; paused while the pointer is over it or focus is inside it; a stop/start button first, then previous, the dots and next. The slides region is silent
  while it rotates by itself and polite once the reader is driving. Under reduced motion (the OS setting or the app's motion switch) it never advances by itself and the stop button is not shown.
- **Source:** on the Master the board list from `GET /api/notices`; on the Office the signed-in person's own cached list (the per-viewer, fail-closed cache), with reads recorded here overlaid.
  It follows the `notice` change event, so a new notice appears without a reload.

**Stage tones and colour labels (as built).** `stageTone()` (`ui/src/DataDisplay.tsx`) maps a pipeline stage's own colour (set in Fields > Pipeline stages) by hue to the five pill tones
(red, amber, green, accent; greys neutral) and keeps the stage flags only as the fallback for a stage with no colour: Cancelled shows red, Postpone amber, Dispatched green, In progress accent.
Colour names are shown through `colourLabeller` (`shared/src/domain/colour-rule.ts`) and the kit's `useColourLabel(optionLists)`: a line stores the colour list's value, every screen prints the list's **current label**
(deleted and inactive entries included), and falls back to the stored value for a colour the list no longer has.

## 8. Data (artboard: Data)

- **Table:** no zebra stripes, no column lines, numbers right-aligned in tabular figures; header = eyebrow style on `porcelain-10`; row 32 px
  (comfortable); hover `porcelain-05`; selected = `accent-tint`; a selection bar appears above the table with the count and bulk actions; a redacted
  cell shows an em dash with a tooltip naming the permission. Pager: "Newer" / "Older" small secondary buttons.
- **Pills:** 20 px, radius 4, 11 px / 500 (section 2.2). **Colour chip:** 14 px circle with a 1 px border, the colour name beside it.
- **ID field:** label, the id in mono 12.5 px with a copy icon button; a temporary id shows the amber "Temporary" pill.
  **Certificate fingerprint:** eight mono groups of hex pairs.
- **Timeline:** newest first, "Name, time" in 12.5 px tertiary text over the entry in 14 px; a system entry ("Status changed New to In progress") in 12.5 px secondary.
- **Kanban card:** party name (14 / 550), quantity, due line ("Follow up today" in amber), owner avatar; dragging = outline, no shadow.
- **Colour x quantity grid:** columns Colour, Qty (and the artboard's stock columns, not built), a Total row; Tab moves down, Enter commits the line,
  up/down change by 1, Shift by 10, a blank is not 0.

**As built (D12, `ui/src/DataDisplay.tsx`, `ui/src/PageBar.tsx`, `ui/src/base.css`).**
- `DataTable`: the header and rows are `--row-h` (32 px), separated by hairlines only (no zebra, no column lines), numbers in tabular figures, ids in mono.
- `StatusPill` is 20 px (tones `default`, `ok`, `offline`, `conflict`, `accent`, `master`). Stage pills are about to take the stage's own colour
  (`PipelineStage.colour`), so Cancelled shows red and Postpone amber as on the artboard.
- `ColourChip` is a 14 px circle with a 1 px border; a colour with no known hex falls back to the artboard's two-letter initials circle ("RU").
  `ColourName` puts the name beside it.
- `IdField` is the sunken id box with a copy button.
- `Timeline` draws a hairline down the left, each entry's meta line ("Ramesh P. · 10:42") over its text; entries written by the software (a stage change) are smaller
  and italic. A lead's or order's history is fed through `recordTimelineEntries(entries, formatWhen)`.
- `PageBar` (paging) is a 40 px footer band in secondary ink under the rows.
- **`ProductThumb`** is the one photo component (in `DataDisplay.tsx`, on `ProgressiveImage`): sizes 32 and 48 px (the order screen), 28 px in the Products lists (the `micro` variant, blurhash first, lazy so a virtualised list
  fetches only the rows on screen), with a fallback of blank, an initial-letter tile or nothing, and an `alt`. The Office draws it from its own image cache, so photos show offline.
- The kanban card follows the artboard (name, quantity, due line, owner) with the dragging outline and no shadow. **There is no colour x quantity grid in the kit:** the new
  pending order's own card does that job (section 10).

## 9. Overlays (artboard: Overlays)

Level 2 for menus and popovers, level 3 for modals and drawers; Esc closes; focus returns to the opener.
- **Menu** (row actions): 30 px rows, padding 0 8, radius 4; the first row highlighted `porcelain-05`; a shortcut at the right in mono 11 px; a disabled row
  `porcelain-30`; the destructive row ("Move to recycle bin") in red, last.
- **Command palette** (Ctrl K): groups (Create, Go to) under eyebrows; rows 30 px; the highlighted row `accent-tint` with accent text and its chord at the right.
- **Modal:** on a scrim, radius 10, level 3; title 18 / 600, body 14 / 20 secondary, footer with Cancel (ghost) and the primary action. A confirmation names what happens.
- **Drawer:** 520 px, right edge; the id (mono), a status pill, the title, tabs (Details, Line items N, Timeline), a definition list (term 12.5 tertiary, value 14), footer actions.
**As built (D2, `ui/src/Modal.tsx`, `ConfirmDialog.tsx`, `Popover.tsx`, `CommandPalette.tsx`, `useOverlay`, `base.css`).** The scrim is `--overlay-scrim` over the whole window (fixed, alpha .32). `Modal` has
a `chrome="palette"` mode (headerless, top-aligned) for the command palette; the dialog head has no rule and the foot no fill (header padding 20/20/0, footer 14/20). `ConfirmDialog`'s Cancel is **ghost**, its body is in
`--fg-secondary` 10 px under the title; the hand-rolled confirms (Fields remove, Panels revoke, Main products delete) match. The palette has its own search row (44 px) and rows, the selected row in the accent colour; the
row-actions menu is 220 px wide with focus ring, danger and separator states and a mono hint. **Focus and ARIA:** `Popover` moves focus with the arrow keys, Home and End and returns it to its trigger; a card's menu
trigger has `aria-haspopup` and `aria-expanded`, with `menu` / `menuitem` roles; `useOverlay` reads the opener during render so an autofocused field no longer makes a close drop focus to the body. Tests: `overlays-restyle`,
`overlay-focus-return`, `popover-menu-keys`.

- **Sync detail popover** (from the status rail): the state, last sync, the server address (mono), and a "Review conflicts" link.

### 9.1 The sign-in notice pop-up (owner add-on V6; no artboard, built on the modal)

`ui/src/SignInNotices.tsx`, mounted inside each panel's signed-in shell (so the sign-in screen never shows it and a sign-out unmounts it), keyed by the person so each sign-in decides afresh.
- **When:** once, the first time that person's notices have arrived after signing in: the notices on their board today that are **important** and **not read by them**, newest first. None,
  or no notices for them at all, and nothing shows. A notice that arrives later in the session waits for the board and the next sign-in; it never interrupts.
- **What:** a medium modal ("Important notices", an intro line), each notice's title with the Important pill and its full plain text (line breaks kept). **Mark as read** hands the ids to the panel's
  own read path: the Master posts them; the Office queues them per person while the link is down. A failure shows a field error inside the dialog and leaves it open. **Later** and Escape only close it; it shows again at the next sign-in.
- **Source:** Master, the board list (`useNotices`, which now forgets the previous person's list when signed out, so nothing of theirs shows to the next person); Office, the person's own cached list
  (`loaded` once their snapshot exists). Tests: `ui/tests/sign-in-notices.test.tsx`, `master-use-notices.test.tsx`, and cases in the two shell tests.

## 10. The new pending order (artboards: NewOrder, NewOrderFilled; 1440 x 900)

Replaces the pending order entry on both panels; every existing behaviour is kept (the Enter flow with the colour step, the live catalogue, the save
block on a deleted product, offline saves, drafts, follow-up chips, party and owner, the added-products panel and the step counter).

1. **Header strip** (white, padding 12 16): a four-column grid `minmax(0,1fr) 150px 260px 150px`: **Party** (a search field with the picked party shown as
   initials tile, name 14 / 550, code in mono, "city, N open orders" muted), **Source** (select), **Follow up** (a date field and the chips "+1 d", "+3 d", "+1 wk", segmented in a
   `porcelain-10` track; the active chip white with accent text), **Owner** (select, "Me" first). Labels are eyebrows above the fields.
2. **Body**, two columns (gap 12): the **entry card** (flexible, white, padding 16) and the **added products panel** (aside, 480 px, white).
3. **Entry card:** "Add products" eyebrow with the hint "Pick a product, type quantity per sub product, press Enter" and the `F2` chip that focuses the product search;
   a 36 px product search; below it the picked product's header (code in mono accent, name 14 / 550, group eyebrow "Closets") or the empty state "No product picked"; then the sub
   product table with a seven-column grid `82px | minmax(0,1fr) | 124px | 50px | 56px | 96px | 80px` = **Code, Sub product, Colour, Weight, Qty, Packaging, Grade**; the colour
   combobox opens as a 220 px popover (rows 28 px, "Type to filter", footer hint "up/down move, Enter picks"). Footer of the card: "This product" count, a hint "Shift+Q adds and goes to the next", and the
   secondary **Add product** button with an `Enter` kbd. **Notes** (optional) sits at the bottom of the card.
4. **Added products panel:** header (44 px) "Added products" with the count; an empty state ("Nothing added yet", padding 24); a search field (28 px) over the list; each product block
   shows its sub-product rows in a grid `minmax(0,1fr) | 96 | 72 | 64 | 40` (name and colour, packaging, grade, quantity with the unit **box**, remove); a footer (padding 12 16 16) with the total quantity.
5. **Bottom bar:** secondary **Cancel** (36 px) and primary **Save pending order** (36 px, with a `Ctrl S` kbd that tints with the button; disabled until there is a line).
6. **Status footer** (26 px): "1 offline, 5 pending", the company, the person, the version.

**As built on the Master (D4, `ui/src/LeadEntryScreen.tsx` on the `ui/src/order/` kit).** The kit, shared with the Office copy: `OrderDetailsBar` (the header strip: Party, Source,
Follow up, Owner), `OrderField` (a label above a field), `FollowUpField` (the date and the "+1 d / +3 d / +1 wk" chips), `PartyChip` (the picked party as name, code and city; a "create party" row
reachable by keyboard), `AddedProductsPanel` (the aside: header with the count, search, rows, a footer with the checks, the total and Cancel / Save), `OrderChecks` (the ok / to-do list above the
total: Party, Products), `CartEntry` and `CartLines` (one added product that opens and closes, its sub lines under it), `ProductThumb` (below). Styles: `ui/src/order/order.css`.
- **Photos.** `ProductThumb` shows a product's primary photo: **32 px in a sub-product picker row, 48 px on the picked product's card** (blurhash first, then the `thumb` variant); with no photo it draws
  nothing, or, when given a name, an initial-letter tile of the same size. `GET /api/pick/product` rows now carry the product's primary image for this (a thumbnail, not the gallery). The first-stage
  list (the Products, i.e. categories) has no photos; the Added products rows show none (the artboard has none).
- **Colour (verified live on the Master).** A multicolour sub product's card opens with the company colour list down and the first colour highlighted: Enter adds a colour and stays for the next, Enter on the
  empty box goes to the quantities; each colour is its own row (code, variant, weight, Qty, Packaging, Grade). A fixed colour shows and is skipped; closets show "White", the trap closets "Any colour". Saving stores
  one line per colour (checked: White 10 and Ivory 5 came back from the API as two lines with their colour names).
- **Keys on the card:** Enter walks quantity, packaging and grade to **Add product**, which adds the sub product and returns to the list; Shift+Q adds it and moves to the next product; Backspace on the empty
  sub-product box goes back to the product bar; F2 focuses the product search; Ctrl+S saves.
- **Quantity unit.** The screen's quantity wording is "pieces" / "pcs" (the entry has said so since before this redesign; the printed notes say **box**). Whether the entry follows the notes is an open
  question (see the 1.4.6 notes).

**The Office copy (D1, `office/web/src/screens/AddLeadScreen.tsx`)** is the same screen on the same `ui/src/order/` kit and keeps its own behaviours: per-person drafts, the provisional party, offline saves queued to the outbox, the
live catalogue from the person's snapshot. **Since then:** the party chip shows name, code and city (`PartyChip`); "Create a new party" opens the New party form pre-filled with the typed text (works by Enter); Added products rows
show the 32 px photo (`CartEntry` thumb slot); the follow-up chips are a real radio group (roving focus, arrow keys); lines show the colour list's current label; the picked card head keeps code and label on one line at 1366 px;
the page title is the shell's top bar (no second heading). The page is capped at 120 rem.

**Not built from the artboard (the product has none of them):** the **Rate** column and any amount, the `₹` prefix, the stock figures ("on hand shown", On hand, Reserved).
Lead wording becomes **pending order**. The artboard's quantity unit "pcs" is as the entry screens already say it; the printed notes say **box**; which one each screen should say is an open owner question (reports keep separate Pieces and Boxes columns, so they may be different quantities).

## 11. Where it lives in the code

| Area | Files |
|---|---|
| Tokens, type, radii, focus ring, scrollbars, size | `ui/src/tokens.css` (names in 2.6), `ui/src/base.css`, `ui/src/theme.ts` (the size slider) |
| Fonts (Inter, IBM Plex Mono, bundled) | `ui/src/fonts/`, `ui/src/fonts.css` |
| Mark, lockup, splash, busy mark, app icons | `ui/src/Mark.tsx`, `Logo.tsx`, `Splash.tsx`, `BusyMark.tsx`, `logoCells.ts`; `tools/make-icons.mjs`, `tools/exe-icon.cjs`, `master/installer/icon.ico`, `office/installer/icon.ico` |
| Buttons and form controls | `ui/src/Button.tsx` (Button, IconButton), `ui/src/Form.tsx` (Input, Textarea, Select, FieldError, Checkbox, Radio, Switch), control CSS in `base.css`; `ui/tests/form-controls-design.test.ts` |
| Sidebar, top bar, tabs, status footer | `ui/src/AppShell.tsx`, `ui/src/Tabs.tsx`, shell CSS in `base.css`, both panels' `App.tsx`; `ui/tests/shell-design.test.tsx` |
| Icons, Basic Home | `ui/src/icons.tsx`, `navIcons.ts`, `BasicHome.tsx`; `ui/tests/nav-icons.test.tsx` |
| Feedback | `ui/src/UpdateProgress.tsx` (ProgressBar), `TopProgress.tsx`, `States.tsx`, `Toast.tsx`, `Tooltip.tsx`, `GalleryScreen.tsx`; `ui/tests/feedback.test.tsx` |
| Data, stage tones, colour labels, product photos | `ui/src/DataTable.tsx`, `ui/src/DataDisplay.tsx` (StatusPill, `stageTone`, ColourChip, `useColourLabel`, IdField, Timeline, `recordTimelineEntries`, ProductThumb), `ui/src/PageBar.tsx`, `shared/src/domain/colour-rule.ts` (`colourLabeller`); `ui/tests/data-timeline.test.tsx` |
| Overlays | `ui/src/Modal.tsx`, `ConfirmDialog.tsx`, `Popover.tsx`, `CommandPalette.tsx`, `useOverlay`; `ui/tests/overlays-restyle`, `overlay-focus-return`, `popover-menu-keys` |
| Notices on Basic Home and at sign-in | `ui/src/NoticeSlideshow.tsx`, `ui/src/SignInNotices.tsx`, `ui/src/NoticeDashboardCard.tsx`, `NoticeBoardView.tsx`; `master/web/src/useNotices.ts` |
| New pending order | `ui/src/LeadEntryScreen.tsx` (Master) and `office/web/src/screens/AddLeadScreen.tsx` (Office) on the `ui/src/order/` kit (`OrderDetailsBar`, `OrderField`, `FollowUpField`, `PartyChip`, `AddedProductsPanel`, `OrderChecks`, `CartEntry`, `order.css`); `ui/tests/lead-entry-screen.test.tsx`, `add-lead-flow.test.tsx` |
| Notes (three codes to a line, colour labels) | `shared/src/domain/order-note.ts` (`NOTE_LAYOUT.codesPerRow`), `ui/src/OrderNote.tsx`, `ui/src/order-note.css`; `master/src/services/print.service.ts` |
| Colour chain (server) | `master/src/services/lead.service.ts` (`buildLines`, `matchExistingLines`), the Dispatches report in `report.service.ts` |
