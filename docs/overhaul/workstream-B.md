# Workstream B — Shared UI package + screen keep-alive and state persistence

sound=false

## Findings
- **blocker**: master/tests/party-access-screen-parity.test.ts is never mentioned. master/web/src/screens/PartyAccessScreen.tsx and office/web/src/screens/PartyAccessScreen.tsx are byte-identical (420 lines, verified with cmp) and the test asserts both byte-identity AND that the master copy's text still contains the literal 'byte-identical'. Its header comment states 'The two panels keep separate copies of ui/ and of their api client', which Part A falsifies. Any import repoint applied unevenly fails the test; the design lists 'master/web/src/screens/*.tsx (modified) — imports repointed' with no parity constraint.
  - FIX: Repoint both copies with one identical edit and rewrite the header paragraph identically in both, keeping the word 'byte-identical'. The screen cannot move into @orderbook/ui because it imports { api, ApiError } from '../api' and the two api.ts files differ (verified). Keep the parity test; update its docstring (it says §7 'proposes a shared workspace that does not exist').
- **blocker**: The React 19 breaking-surface grep is wrong on three counts. (1) ui/Tooltip.tsx:13 `const timer = useRef<ReturnType<typeof setTimeout>>();` is a zero-argument useRef — @types/react@19 removed that overload ('Expected 1 arguments, but got 0'); present in both panels. (2) ui/useOverlay.ts:23 `containerRef: RefObject<HTMLElement>` — in @types/react@19 `useRef<HTMLDivElement>(null)` yields RefObject<HTMLDivElement | null>, which is not assignable; callers ui/Modal.tsx:50 and ui/Drawer.tsx:32. (3) ui/Combobox.tsx:32 `inputRef?: RefObject<HTMLInputElement>` — same defect; callers office AddLeadScreen.tsx:88 and PartyAccessScreen.tsx:409.
  - FIX: Before the upgrade: Tooltip.tsx:13 -> `useRef<ReturnType<typeof setTimeout> | undefined>(undefined)`; useOverlay.ts:23 -> `RefObject<HTMLElement | null>`; Combobox.tsx:32 -> `RefObject<HTMLInputElement | null>`. All three land in ui/src/ after the move, so they are one edit each, not two.
- **blocker**: §B6's discoverability feature is impossible under the mechanism §B1 chose. useSubNav (SubNavSlot.tsx:71) ends with `useEffect(() => () => set(null), [set])`, and <Activity mode="hidden"> tears effects down — so the office AddLead sub-nav entry and master's role/user editor entries vanish from the sidebar the instant you navigate away. The design's own Risks section claims the opposite ('the sidebar will show the nested editor entry persistently until Reset or Save').
  - FIX: Lift open-operation state above <Activity>. SubNavProvider keeps a Map<screenId, SubNavState> in a ref; useSubNav(screenId, state) writes on mount/signature-change and does NOT clear on effect teardown. Entries are cleared only by the screen's own close action (AccessScreen's editorCloseRef path) or by a resetNonce bump, both of which ScreenHost/App observe directly.
- **blocker**: office/web/src/App.tsx:665-750 is not a switch and the ScreenSpec[] rewrite would break the offline path. `updates` (:684) and `settings` (:688) are returned ABOVE an `if (!view) return <waitingFirstSync>` gate at :700, and `addingLead && view` at :668. Every screen below takes a non-null LocalView (`view` is `useState<LocalView | null>(null)` at :92). ScreenHost renders all visited screens at once, so a null `view` would push null into every mounted screen.
  - FIX: Keep the gates outside ScreenHost. Build the ScreenSpec[] in two tiers: `updates` and `settings` always available; the remaining seven ids built only when `view` is non-null, and render `<div className="ob-empty">waitingFirstSync</div>` in place of ScreenHost's data tier until the first snapshot lands. `parties` and `products` stay two ScreenSpecs sharing CatalogScreen with a differing `tab` prop. Same treatment for master's `route === 'gallery'` short-circuit (App.tsx:516), which is a separate `route` state, not a Tab.
- **blocker**: useOverlay's Escape arbitration breaks with N mounted panes. useOverlay.ts:49-51 decides the innermost dialog with `document.querySelectorAll('[role="dialog"]')` and `dialogs[dialogs.length-1] !== container`. Modal.tsx:60 and Drawer.tsx:42 render in-tree with no portal, and Activity hides panes with display:none without removing them, so a hidden pane's open Drawer that sits later in the screens array becomes the 'last dialog' — the visible dialog refuses Escape and the hidden one's handler is already torn down.
  - FIX: Filter the query by visibility: `const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.checkVisibility())`. Apply the same guard to the focus-restore. Electron 33 ships Chromium 130, so checkVisibility() is available.
- **major**: §B8's memory bound is unfounded because DataTable's virtualiser is inert. .ob-tablewrap has overflow:auto (base.css:460) but no height constraint and sits inside .ob-content (base.css:1121), which is the real scroller; screens compose it in a plain flex column (LeadsOrdersScreen.tsx:376-389). So wrapRef.clientHeight is the full table height, React's onScroll does not bubble so scrollTop stays 0, visibleCount = ceil(fullHeight/rowH)+16 >= rows.length, and every row renders. Keep-alive then multiplies a 500-row page by every visited screen. The design's four-line .ob-tablewrap scroll restore is a no-op for the same reason.
  - FIX: Drop the .ob-tablewrap restore. Make DataTable take its metrics from the single .ob-pane scroller: in the existing useLayoutEffect resolve `wrapRef.current.closest('.ob-pane')`, set viewportH from `scroller.clientHeight`, set scrollTop from `Math.max(0, scroller.scrollTop - wrap.offsetTop)` on a passive scroll listener, keep the --row-h read on the wrap, and observe the scroller with the existing ResizeObserver. Remove the onScroll prop. This makes virtualisation real for the first time and is what actually bounds hidden-pane DOM.
- **major**: npm run verify never typechecks the web workspaces, so the design's safety net does not exist. Root typecheck is `npm run typecheck --workspaces --if-present`, and master/web and office/web expose only dev/build/preview. Every call-site error from the i18n fold and the React 19 upgrade surfaces only under npm run build.
  - FIX: Add `"typecheck": "tsc -p tsconfig.json --noEmit"` to master/web/package.json and office/web/package.json as the first step of Part A, so the fold's errors are visible where the risk section assumes they are.
- **major**: Fifteen template-literal t() call sites become compile errors under `K extends MessageKey` and are not mentioned anywhere: master/web/src/App.tsx:269; DocumentsScreen.tsx:234,621,659; FieldsScreen.tsx:804,1091,1101; LogsScreen.tsx:93,227,607; RecycleBinScreen.tsx:270,311,509; office/web/src/App.tsx:351; office/web/src/screens/OrderBoardScreen.tsx:388.
  - FIX: Export one escape hatch from ui/src/i18n.ts: `export function tDynamic(key: string): string { return translator.t(key as MessageKey); }` — shared's t() already falls back to EN then to the raw key (translate.ts:37-47), so behaviour is unchanged. Repoint those 15 sites to tDynamic. Add a coverage assertion that each dynamic stem's enumerated suffixes exist.
- **major**: Five t() call sites already reference keys absent from their own panel dictionary, and the fold turns them from a silent UI bug into compile errors: master/web/src/screens/PanelDetailScreen.tsx uses 'common.save' and 'common.cancel' (twice), master/web/src/ui/ColourQuantityGrid.tsx uses 'lead.add.products.freeToSell' and 'lead.add.products.short'. Master renders the raw key today. ColourQuantityGrid is byte-identical to office's, whose dictionary has both keys — the fork bug, live.
  - FIX: Note them explicitly. 'common.save'/'common.cancel' already exist at shared/src/i18n/en.ts:407-408 and the two lead keys arrive with the office union, so all five resolve at the fold with no new strings.
- **major**: The four keys that overlap shared's existing catalogue are measured but never resolved: fieldSet.lead.sourcePlatform, fieldSet.stock.colour, fieldSet.product.productType, fieldSet.line.packaging. Appending them a second time creates duplicate keys in the EN_MESSAGES object literal, which trips no-dupe-keys from js.configs.recommended and silently shadows.
  - FIX: Verified all four hold identical values in shared and master (office has none). Drop them from the appended block.
- **major**: tools/release.mjs:83-91 setVersion() carries a hard-coded six-file list and stamps one version across every package because 'the panels report their versions to each other and compare them'. ui/package.json is pinned at 1.0.2 by the design and never added to that list, so it drifts on the first release.
  - FIX: Add 'ui/package.json' to the files array in setVersion().
- **major**: Vitest 2.1.9 has no test.projects (that is Vitest 3), and tsconfig.test.json cannot compile React tests: it extends tsconfig.base.json (lib ES2022, no DOM, no jsx) and includes only {shared,master,office}/tests/**/*.ts.
  - FIX: Use `environmentMatchGlobs: [['ui/tests/**', 'jsdom']]` (present in 2.1.9), extend vitest include with 'ui/tests/**/*.test.tsx', and give ui/tests its own tsconfig (jsx react-jsx, lib DOM) rather than widening tsconfig.test.json, which would hand DOM globals to the server suites.
- **major**: ScreenHost adds activeId to `visited` inside a useEffect, so the first render after switching to an unvisited tab renders no pane at all — a blank frame on every first visit to each of the 14/9 tabs.
  - FIX: Use a render-phase update: `if (!visited.has(activeId)) setVisited(new Set(visited).add(activeId));` directly in the body. React re-renders before commit, so no frame is dropped.
- **major**: usePersistentState<T>(key, initial, isValid) cannot reuse theme.ts's read(), whose signature is read<T extends string>(key, allowed: readonly T[], fallback: T) — an allow-list of string literals, not a predicate over arbitrary T. The stated reuse does not typecheck.
  - FIX: Keep the allow-list shape: `usePersistentState<T extends string>(key: string, allowed: readonly T[], initial: T)`. Every listed use (LeadsOrdersScreen view/scope, AccessScreen tab, CatalogScreen filter, ob.ui.lastTab, ob.ui.sidebarCollapsed) is a string enum, so nothing is lost.
- **minor**: Files list says ui/src/base.css is 'moved verbatim', but §B3 requires editing .ob-content (overflow:hidden, padding:0) and adding a new .ob-pane rule.
  - FIX: State the two base.css edits in the Files list.
- **minor**: Line counts are wrong in two places: office/web/src/ui/PermissionGrid.tsx is 188 lines and master's is 242 — the Files entry attributes 242 to office. Master's dead styles.css tail is 123 lines (520-642), not 101.
  - FIX: Correct both; the conclusions (office's copy is the dead one, the tail is dead in both panels) hold — verified zero importers for office PermissionGrid and zero users of .permission-grid/.capability/.capability-grid/button.link, with .sr-only already at ui/reset.css:94.
- **minor**: 'Net API effect is negative' is false. A screen fetches once per mount today and once per re-show after; the count is identical. The real gain is that a hand-rolled display:none keep-alive would have made it worse.
  - FIX: State it as neutral.
- **minor**: createTranslator is described as existing-and-unused; master/web/src/screens/LogsScreen.tsx:52 already calls it and feeds renderActivity(translator, ...) with a hard-coded 'en'.
  - FIX: Export the Translator object from ui/src/i18n.ts and have LogsScreen use it, or that screen alone ignores ob.locale.
- **minor**: Widening the digit rule to /(?<![#\w-])\d{3,}/ weakens a guard over the whole shared catalogue including server error strings, to spare two illustrative examples. Also 'up to 5 MB' in avatar.hint is a single digit and was never an offender.
  - FIX: Parameterise all four: avatar.hint {px}, documents.editor.termsHint {max}, fields.values.field.hexHint/hexInvalid {example}. Leave shared/tests/i18n-coverage.test.ts untouched.
- **minor**: sync.offline also differs in placeholder set between panels (master '{count} offline', office 'Offline'); only sync.offlinePending is named. The 12-key conflict list is otherwise exactly right (verified).
  - FIX: Namespace it with the other eleven.
- **minor**: The Reset button is specified with Icon name="sync", which is already the Updates nav glyph (office/web/src/App.tsx:460), and its visibility rule ('resetNonce shows the screen has been mounted longer than this visit') is not implementable — nothing tracks that. IconName has no refresh/reload entry.
  - FIX: Add a 'reset' glyph to ui/src/icons.tsx (one file after Part A) and render the button unconditionally on any non-gallery screen.
- **minor**: The claim that folding is required to render server messageKeys overstates the case: ApiError already carries a shared MessageKey and `import { t } from '@orderbook/shared'` renders it today.
  - FIX: Drop that argument; the permissionLabels.ts deletion and the single-dictionary rule carry the fold on their own.
- **minor**: docs/UI_REDESIGN.md §7 already specifies this exact workspace (with a different font strategy: ui/assets/fonts copied into each app's public/), and its Phase-1 landing notes record why the fork exists. Neither is cited or updated.
  - FIX: Update §7 and the Phase-1 divergence notes; state that the CSS-url() font strategy already in ui/fonts/ supersedes §7's public/ plan (six woff2 files, verified byte-identical across panels).
- **minor**: Bundle and memory effect of the fold is unstated: shared/src/i18n/translate.ts imports EN_MESSAGES unconditionally, so after the fold each panel bundle and each Express server carries all 1401 strings, including the other panel's vocabulary.
  - FIX: State it. A few hundred KB in a local Electron app is acceptable; pretending it is zero is not.

## Corrected design

## B — Shared UI package + screen keep-alive and state persistence (corrected)

**Verdict:** Extract the hand-duplicated `ui/` into a source-only workspace `@orderbook/ui` consumed directly by Vite, fold both forked frontend string tables into `shared/src/i18n/`, and replace tab-switch unmounting with React 19.2's `<Activity>`. `<Activity>` is right because it tears down hidden children's effects, which is what keeps `FilterBarSlot`, `TopbarSlot`, `SaveShortcutSlot`, `useOverlay` and every `revision`-keyed refetch correct with N screens mounted — all four slots publish from `useEffect` with no dep array (verified), so a hand-rolled `display:none` wrapper would need a visibility gate inside each of them. But effect teardown is not free: three things in the repo depend on teardown meaning *unmount*, and each needs an explicit fix below.

## Verified ground truth

26 of 41 `ui/` entries are byte-identical; four differ — `base.css` (master +19 lines: `.ob-panel-figures`, `.ob-panel-grid`), `icons.tsx` (master adds `server`; office carries the "add it to the other panel too" comment), `theme.ts` (3 differences), and `PermissionGrid.tsx` (master 242 lines, office 188, zero importers on office's). The six `fonts/*.woff2` are byte-identical. Master's `styles.css` carries a dead 123-line tail (520–642: `.permission-grid`, `.capability*`, `button.link`, a duplicate `.sr-only` that `ui/reset.css:94` already provides) with zero users in either panel. `components/Field.tsx`, `format.ts`, `vite-env.d.ts` and `main.tsx` are byte-identical. **`screens/PartyAccessScreen.tsx` (420 lines) is byte-identical too, and `master/tests/party-access-screen-parity.test.ts` enforces it.** Only seven `ui/` files reach outside the directory, all for `t` from `../i18n/strings` — so the i18n fold is a hard prerequisite for the move. i18n key counts: master 1029, office 501, intersection 129 (12 with differing text), union 1401, overlap with shared's 341 keys exactly 4 with identical values.

# Part A — `@orderbook/ui`

## A1. Wiring

New root directory `ui/`, sibling of `shared/`. It cannot live in `shared/`: that project is `module: NodeNext`, `lib: ["ES2022"]` (no DOM), compiled to `dist/` and imported by both Express servers.

`ui/package.json`: name `@orderbook/ui`, private, `type: module`, `version` kept in step with the rest, `sideEffects: ["*.css"]`, `exports` mapping `.` → `./src/index.ts`, `./styles.css`, `./legacy.css`; dependencies `@orderbook/shared` and `blurhash` (moved out of `office/web`); peerDependencies react/react-dom `^19.2.0`; a `typecheck` script. `ui/tsconfig.json` is `master/web/tsconfig.json` with `include: ["src"]`.

Source exports, no build step: Vite does not pre-bundle symlinked workspace packages, so the `.tsx`/`.css`/`.woff2` graph is transpiled like local source — required, because `assetsInlineLimit: 0` must own font emission. Add `optimizeDeps: { exclude: ['@orderbook/ui'] }` to both `vite.config.ts`. `moduleResolution: "bundler"` honours `exports`, so each consumer typechecks the package source with no project reference.

Also required, and missed by the original: **add `"typecheck": "tsc -p tsconfig.json --noEmit"` to `master/web/package.json` and `office/web/package.json`.** Today neither has one, so `npm run verify` (`lint && typecheck && test`) never typechecks either web app — every call-site error this workstream can produce is invisible until `npm run build`. Add `"ui"` to root `workspaces` before `"master"`; add `'ui/src/**/*.tsx'` to `eslint.config.js`'s JSX block; **add `'ui/package.json'` to `setVersion()`'s file list in `tools/release.mjs:83-91`**, which stamps one version across every package by design.

## A2. What moves

All 36 components, `icons.tsx` (master's superset), `logoCells.ts`, `useOverlay.ts`, `theme.ts`, the four CSS files, `fonts/`, plus `components/Field.tsx` and `format.ts`. No panel-only tier — tree-shaking off a barrel with `sideEffects: ["*.css"]` means a panel ships only what it imports.

Deleted: `office/web/src/ui/PermissionGrid.tsx` (188 lines, zero importers; master's 242-line version survives — office's `base.css` already carries every `.ob-permsection`/`.ob-permtoggle`/`.ob-capability*` rule it needs), `office/web/src/components/KanbanBoard.tsx` (zero importers), `master/web/src/ui/permissionLabels.ts`, master's 123-line `styles.css` tail, office's `icons.tsx`. `Tooltip.tsx` moves despite zero importers — requirement 5 needs it.

**`PartyAccessScreen.tsx` does not move**: it imports `{ api, ApiError }` from `../api`, and the two `api.ts` files differ. Both copies get one identical import repoint and one identical header rewrite (keeping the literal word `byte-identical`, which the parity test asserts); the parity test stays and its docstring is updated.

## A3. React 19 upgrade — three real breakages

The original claimed the breaking surface was empty. It is not:

- `ui/Tooltip.tsx:13` — `useRef<ReturnType<typeof setTimeout>>()` has no initial argument; `@types/react@19` removed that overload. Fix: `useRef<ReturnType<typeof setTimeout> | undefined>(undefined)`.
- `ui/useOverlay.ts:23` — `containerRef: RefObject<HTMLElement>`; in v19 `useRef<HTMLDivElement>(null)` is `RefObject<HTMLDivElement | null>`. Fix: `RefObject<HTMLElement | null>`. Callers `Modal.tsx:50`, `Drawer.tsx:32`.
- `ui/Combobox.tsx:32` — `inputRef?: RefObject<HTMLInputElement>`; same fix. Callers `AddLeadScreen.tsx:88`, `PartyAccessScreen.tsx:409`.

Everything else checks out: no `defaultProps`, `propTypes`, string refs, `findDOMNode`, `ReactDOM.render`, `JSX.Element` or `React.FC`; only `forwardRef` (`Form.tsx:59`), deprecated but working. Gate Part B on `node -e "console.log(!!require('react').Activity)"` after the upgrade.

## A4. CSS

`ui/src/styles.css` `@import`s fonts, tokens, reset, base. `ui/src/legacy.css` is the 409 lines common to both `styles.css` files. Each `main.tsx` drops five imports for two. `base.css` is master's copy **plus two edits required by §B3** (see below) — not verbatim.

## A5. `theme.ts` → configuration

`ui/src/config.ts` holds a module singleton `PanelConfig { panel, defaultTheme, themeStorageKey }` with `configureUi()`/`uiConfig()`; `main.tsx` calls `configureUi(...)` above `initAppearance()` (line 14). No ui module may call `uiConfig()` at module top level — the barrel evaluates before `main.tsx`'s first statement. Master keeps `ob.theme.v2`/dark, office `ob.theme`/light. Office's missing `style.colorScheme` is a bug, not configuration: always set it, and add `style="color-scheme: light"` to `office/web/index.html` to match master's inline value. Export `read`/`store` (`theme.ts:22`, `:49`).

## A6. i18n fold

Fold both dictionaries into `shared/src/i18n/en.ts`. `ui/src/i18n.ts` binds the locale over `createTranslator` (`translate.ts:75`), reads `ob.locale` from `localStorage`, and `setLocale()` stores then reloads. It must also export the `Translator` object: `master/web/src/screens/LogsScreen.tsx:52` already calls `createTranslator('en')` and feeds `renderActivity(translator, …)`, and would otherwise be the one screen ignoring `ob.locale`.

Order of the fold commit:

1. Namespace the **13** conflicting keys as `master.*`/`office.*`: `app.panel`, `backup.export.title`, `backup.restore.confirmWipe`, `search.failedOffline`, `settings.storage.title`, `sync.conflictReview`, `sync.offline`, `sync.offlinePending`, `sync.pendingChanges`, `sync.popoverTitle.{offline,offlinePending,synced}`. Two differ in *placeholder set* — `sync.offlinePending` (`{count}`+`{pending}` vs `{count}`) and `sync.offline` (`{count}` vs none) — so a naive merge corrupts a status line.
2. Drop the four keys already in shared with identical values (`fieldSet.lead.sourcePlatform`, `fieldSet.stock.colour`, `fieldSet.product.productType`, `fieldSet.line.packaging`) — a duplicate literal key trips `no-dupe-keys`.
3. Parameterise the four strings carrying 3+ digit runs: `avatar.hint` `{px}`, `documents.editor.termsHint` `{max}`, `fields.values.field.hexHint`/`hexInvalid` `{example}`. Leave the coverage rule alone — widening it weakens a guard over the server's error catalogue too.
4. Add `tDynamic(key: string)` to `ui/src/i18n.ts` (shared `t()` already falls back EN → raw key) and repoint the **15** template-literal call sites: `master/web/src/App.tsx:269`, `DocumentsScreen.tsx:234,621,659`, `FieldsScreen.tsx:804,1091,1101`, `LogsScreen.tsx:93,227,607`, `RecycleBinScreen.tsx:270,311,509`, `office/web/src/App.tsx:351`, `OrderBoardScreen.tsx:388`.
5. Append and repoint imports.

Five call sites already reference keys missing from their own dictionary and render the raw key today — `common.save`/`common.cancel` (×2) in `PanelDetailScreen.tsx`, `lead.add.products.freeToSell`/`short` in `ColourQuantityGrid.tsx`. All five resolve at the fold (the first two from `en.ts:407-408`). No param-shape mismatches exist across the ~1380 literal call sites (measured), so `ParamsFor<K>` costs nothing at the fold. Cost: both panel bundles and both servers now carry all 1401 strings, since `translate.ts` imports the catalogue unconditionally.

# Part B — keep-alive

## B1. Mechanism

`<Activity>`, not a router (none gives keep-alive; `#/gallery` is the only deep link), not an external store (41/50 `useState`s to enumerate), not a hand-rolled `display:none` wrapper.

## B2. The shell

`ui/src/ScreenHost.tsx` renders visited screens inside `<Activity key={`${id}:${resetNonce[id] ?? 0}`} mode={...}>` wrapping a `ScreenPane`. **`visited` is updated in the render body** (`if (!visited.has(activeId)) setVisited(new Set(visited).add(activeId))`), not in an effect — an effect drops a frame on every first visit.

Master: `App.tsx:515-563`'s IIFE becomes a `ScreenSpec[]` of the same 14 arms; `route === 'gallery'` stays outside ScreenHost. `App.tsx:420`'s `if (subNav && !subNav.onExit()) return;` is deleted, and `SubNavState.onExit` is removed (`AccessScreen.tsx:162,175`); `onBack={() => editorCloseRef.current()}` at `:203` remains the explicit confirm path.

Office (`App.tsx:665-750`) is **not** a switch and needs two tiers. `updates` and `settings` are returned above the `if (!view)` gate and must stay always-available; the other seven ids plus `addLead` are built only when `view` is non-null, with `waitingFirstSync` rendered in ScreenHost's place until the first snapshot. `parties` and `products` become two ScreenSpecs sharing `CatalogScreen`. Wrap each `ScreenSpec.render` in `React.memo` — `MasterPanel` re-renders on every `data:changed` (`App.tsx:208-213`).

**Sub-nav must move above `<Activity>`.** `useSubNav`'s teardown (`SubNavSlot.tsx:71`) fires on hide, so leaving it as-is deletes the very sidebar entry §B6 promises. `SubNavProvider` keeps a `Map<screenId, SubNavState>` in a ref; `useSubNav(screenId, state)` writes on mount and signature change and never clears on teardown. Entries clear on the screen's own close action or a `resetNonce` bump.

Make the two remaining slots order-independent rather than relying on React's hide/show effect ordering: `useFilterBar`'s cleanup becomes `set((cur) => (cur === node ? null : cur))`, and `useSaveShortcut`'s clears only if it still owns the handler.

## B3. Scroll and overlays

`.ob-content { flex:1; min-height:0; overflow:hidden; padding:0 }` and a new `.ob-pane { height:100%; overflow:auto; padding: var(--s-16) var(--s-20) }` — two real edits to `base.css`. `ScreenPane` saves/restores `scrollTop` across the `display:none` hide via a ref `<Activity>` preserves. Sticky `thead` (`base.css:492`) still resolves against the nearest scroller, unchanged.

**DataTable's virtualiser is inert today and must be fixed here**, because keep-alive multiplies its cost by every visited screen. `.ob-tablewrap` has `overflow:auto` (`:460`) but no height constraint and sits in `.ob-content`, so `clientHeight` is the full table height, `onScroll` never fires (scroll does not bubble), and `visibleCount ≥ rows.length` — every row renders. Replace the wrap-based measurement with the pane: resolve `wrapRef.current.closest('.ob-pane')`, take `viewportH` from `scroller.clientHeight`, `scrollTop` from `scroller.scrollTop - wrap.offsetTop` on a passive listener, keep the `--row-h` read on the wrap, drop the `onScroll` prop. This makes `VIRTUALIZE_ABOVE=100`/`OVERSCAN=8` real and removes the need for any `.ob-tablewrap` restore.

`useOverlay` needs two guards. Filter the dialog query by visibility — `[...document.querySelectorAll('[role="dialog"]')].filter((d) => d.checkVisibility())` — or a hidden pane's open Drawer, later in DOM order, silently steals Escape from the visible one. And capture `restoreFocus` once per open transition, restoring only on a true `open: true→false` edge with `el.isConnected`, so a hide/show cycle neither yanks focus into a `display:none` subtree nor corrupts the restore target.

## B4. In-flight fetches

Each screen's existing `let cancelled = false` guard already orders hide/show races. No `AbortController` — that belongs to requirement 11. Gate every skeleton on `loading && rows.length === 0` (~20 sites across both panels).

## B5. Reset

The shell owns `resetNonce`; Reset bumps the active screen's entry, the `key` changes, React remounts. Total reset, zero per-screen code. The button sits right of `<TopbarActionsOutlet />` (`App.tsx:435`), rendered on any non-gallery screen, using a **new `reset` glyph added to `ui/src/icons.tsx`** — `sync` is already the Updates nav icon. `ui/src/ResetSlot.tsx` copies `SaveShortcutSlot`'s ref shape: `useResetGuard(guard)` / `useResetRequest()`. `AddLeadScreen` and `AccessScreen`'s editors register a confirm; nothing else registers.

## B6. Office AddLead

`office/web/src/App.tsx:484`'s `setAddingLead(false)` inside `goToTab` is deleted; the draft survives because the pane is not unmounted. `onCancel` routes through `requestReset()`. The sidebar entry works only because §B2 lifted the sub-nav registry above `<Activity>`. The topbar "New lead" button (`:556-564`) becomes `goToTab('addLead')`.

## B7. Restart persistence

`ob.ui.lastTab` (validated against the freshly computed nav), `ob.ui.sidebarCollapsed`, `ob.locale`. `ui/src/usePersistentState.ts` keeps `theme.ts`'s allow-list shape — `usePersistentState<T extends string>(key, allowed, initial)` — because `read()` takes an allow-list, not a predicate; every intended use is a string enum. Not persisted: fetched data, and half-typed drafts (a rehydrated draft can carry a `saleRate` the person has since lost `field.saleRate.view` for, and masking here is by key absence, `shared/src/domain/visibility.ts:22-58`). A durable draft belongs in the office outbox — a backend change, out of scope.

## B8. Memory and API, honestly

Retained per hidden screen: fiber tree, DOM subtree, fetched arrays. DOM is bounded only *after* the DataTable fix above. `DocumentsScreen` and `RecycleBinScreen` accumulate via `LoadMorePager` (`CursorPager.tsx:5`); cap each at 10 retained pages. `LogsScreen`'s `NewerOlderPager` replaces and needs nothing. No LRU. Net API effect is **neutral**, not negative: a screen fetches once per mount today and once per re-show after — the win is that the alternative keep-alive would have made it worse.

## Tests

`ui/tests/screen-host.test.tsx`, `slots.test.tsx`, `scroll-restore.test.tsx`, and `no-duplicate-ui.test.ts` (asserts neither `web/src/ui` exists and no `./ui/` relative import survives). This needs the repo's first React test setup: `jsdom` + `@testing-library/react` as devDeps, `environmentMatchGlobs: [['ui/tests/**', 'jsdom']]` in `vitest.config.ts` (**Vitest 2.1.9 has no `test.projects` — that is Vitest 3**), include extended to `ui/tests/**/*.test.tsx`, and a dedicated `ui/tests/tsconfig.json` with `jsx: react-jsx` and DOM lib rather than widening `tsconfig.test.json`, which would hand DOM globals to the server suites. Extend `shared/tests/i18n-coverage.test.ts` with a static scan asserting every literal `t('...')` key across `ui/src` and both web apps is in `EN_MESSAGES`, and that the 13 namespaced keys stay paired. `master/tests/party-access-screen-parity.test.ts` and `master/tests/credential-invariants.test.ts` (which reads only `master/src`) must still pass unchanged.

## Docs

`docs/UI_REDESIGN.md` §7 already specifies this workspace and its Phase-1 notes record why the fork exists; both go stale, as does the parity test's docstring. Update all three, and record that the existing CSS-`url()` font strategy supersedes §7's `public/fonts/` plan.

## Not doing

No router. No external per-tab store. No `AbortController` plumbing. No LRU. No panel-only tier. No persisted form drafts. No locale switcher UI or reactive locale change. `PartyAccessScreen` is not de-duplicated — it depends on each panel's own `api` client, so the parity test remains the mechanism.