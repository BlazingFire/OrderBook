# Workstream G — Full keyboard system: command palette, F-keys, navigation, remapping

sound=false

## Findings
- **blocker**: §7 `useEnterToAdvance` is specified as "one hook on the form element, walking `form.elements`". `grep -rn "<form"` over both web apps returns exactly THREE hits: master/web/src/screens/SignInScreen.tsx:55, office/web/src/screens/SignInScreen.tsx:80, office/web/src/screens/ConnectionScreen.tsx:321. Every drawer, editor and AddLeadScreen builds fields out of `FormField`/`Input` (master/web/src/ui/Form.tsx:33-56) with no `<form>` anywhere. The hook as written has nothing to attach to on any screen the requirement is about, and the design does not mention wrapping ~30 editors in `<form>`.
  - FIX: Take a container ref, not a form: `useEnterToAdvance(ref, onSubmit)` walks `ref.current.querySelectorAll(FOCUSABLE)` using the FOCUSABLE selector that already exists at master/web/src/ui/useOverlay.ts:21 (export it from there rather than writing a second list). "Submit on last field" becomes "run the top-of-stack `record.save` registration", which `useCommand` already provides. No `<form>` elements are added.
- **blocker**: §9's renderer→main `MenuDescriptor` IPC invents a trust boundary into the shell that requirements 1 and 7 exist to stabilise, for a native menu the owner never asked for. Worse, its own pinned test is unwritable: shared/tests cannot import master/electron/main.ts (tsconfig.test.json includes only `{shared,master,office}/tests/**/*.ts`, and main.ts imports `electron`), and main.ts cannot import the regex from shared at runtime because master/electron-builder.yml `files:` is `electron/dist/**/*` + `package.json` with no node_modules — the design states this itself and then asserts a test comparing against "the exact regex literal that master/electron/main.ts uses".
  - FIX: Delete the descriptor, the role allowlist, the accelerator regex and the validation surface. Keep `buildMenu()` static in both mains (master/electron/main.ts:217-246, office/electron/main.ts:211-240) and make the channel one-way main→renderer: `webContents.send('orderbook:menuCommand', id)` with a fixed literal id set. That also fixes main.ts:236's `loadURL('${ORIGIN}/#/updates')` — `readHash()` (master/web/src/App.tsx:100) only recognises `'gallery'`, so that item reloads the app onto the Dashboard. Add one "Keyboard shortcuts\tF1" item sending `help.shortcuts`; the F1 cheat sheet is the discoverability answer, a 70-item native mirror is a second implementation. Pin `role:'reload'` to `CmdOrCtrl+R` so it does not also claim F5, and keep the `before-input-event` F5/Ctrl+Shift+R swallow as belt-and-braces.
- **blocker**: §4 says "App.tsx registers nav.* commands using the permission booleans it already computes at :298-310" but never says what the handler calls. Master's sidebar does not call `setTab`; it calls `navigate(id)` (master/web/src/App.tsx:~418), which first asks `subNav.onExit()` and refuses to leave when an open role/user editor holds an unsaved draft. Office's `goToTab` (office/web/src/App.tsx:484) unconditionally does `setAddingLead(false)`. Alt+N wired to `setTab`/`goToTab` destroys drafts; Alt+N is far easier to hit by accident than a sidebar click.
  - FIX: `nav.*` handlers call master's `navigate(id)` verbatim. In office, `goToTab` gains the same guard before `setAddingLead(false)`: when `addingLead` is true, confirm before discarding (office already has `useToast`; a `window.confirm` is acceptable and matches master's `onExit()` boolean contract). Without that guard the office nav commands are not registered.
- **blocker**: §5 deletes the office topbar search block "plus runSearch, term, hits, searchFailedOffline" — but `searchFailedOffline` is the ONLY offline handling for search in the office panel. office/src/http/app.ts:438 forwards `/api/search` to the Master (`forward(res, 'search:query', …)`), and office/web/src/api.ts:341 carries the comment "Stock and search need the Master, so these still fail when it is offline". Offline is the office panel's normal state. The palette as designed shows an empty Records list with no explanation.
  - FIX: The palette's Records section catches the failure and renders the existing `t('search.failedOffline')` string in place of results. Additionally, when the master is unreachable the office palette falls back to a substring scan of the merged `LocalView` already held in `office/web/src/App.tsx:92` (`view.parties`, `view.products`, `view.leads`) — that view is already permission-masked and party-scoped by office/src/http/app.ts SNAPSHOT_POLICY, so the fallback introduces no new leak path and needs no server change.
- **blocker**: No suppression rule for open overlays. `KeyboardProvider` owns one document-level listener; `useOverlay` only handles Escape and Tab. With a Modal or Drawer open, F2/F5/F7/F9 still resolve to the screen-scope registration of the screen behind the scrim. `ScreenScope`'s `active` boolean is about tab visibility, not modality.
  - FIX: Define `KeyScope='overlay'` concretely instead of leaving it an empty abstraction: while `document.querySelector('[role="dialog"]')` is non-null, the resolver skips `screen`-scope registrations entirely and considers `overlay` then `global` only. A dialog registers its own `record.save`/`record.commit` via `useCommand` inside itself, so Ctrl+S in a drawer still saves the drawer.
- **major**: §2's resolution order ("1. useOverlay Escape 2. Popover Escape 3. KeyboardProvider") is not what the DOM does. Same-node bubble listeners fire in registration order; `KeyboardProvider` registers at app mount, so it is FIRST among document-bubble listeners, before any overlay's. It is harmless only because `isReservedChord` refuses Escape and Tab, which the diagram does not say.
  - FIX: State the real rule: overlay-vs-app ordering is not achieved by phase, it is achieved by Escape/Tab never entering the chord index at all, plus the `defaultPrevented` guard. Drop the three-stage bubble diagram.
- **major**: "This is the first frontend code to import the shared catalogue" is false. master/web/src/screens/LogsScreen.tsx:27 already does `import { createTranslator, renderActivity } from '@orderbook/shared'` and LogsScreen.tsx:52 does `createTranslator('en')`. Several screens import shared runtime values (`standing`, `RECYCLE_BIN_ENTITIES`).
  - FIX: Remove the claim. It is load-bearing for the design's justification of moving ~70 command labels into shared, which should not happen anyway (next finding).
- **major**: Putting command titles in shared `en.ts`/`hi.ts` creates a second source of truth for module names. `nav.master.dashboard`, `nav.master.leadsOrders`, `nav.master.inventory`, `nav.leads`, `nav.orders`, `nav.products` etc. already exist in master/web/src/i18n/strings.ts and office/web/src/i18n/strings.ts and are what the sidebar renders. A parallel `keys.nav.*` set in shared guarantees the palette and the sidebar say different things after the first edit — and costs ~70 Hindi stubs through tools/i18n-sync.mjs.
  - FIX: `CommandDef.titleKey: string` names a key in the PANEL dictionary. Nav commands reuse the keys that already exist (`nav.master.dashboard`, `nav.updates`, …) and add zero strings. Nav command ids are panel-namespaced (`nav.master.orders` / `nav.office.orders`) so each carries the right key. Only ~24 new chrome strings (palette, cheat sheet, Settings card, announcements) are added, to BOTH strings.ts files. shared/src/i18n is untouched, so shared/tests/i18n-coverage.test.ts and hi.ts are untouched. Pin the keys with a text-scanning test in master/tests (the readFileSync pattern i18n-coverage.test.ts already uses for activity-tokens.lock.json).
- **major**: Internal contradiction. §1: "The panels' forked flat dictionaries get no new keys; the React layer calls sharedT(locale, cmd.titleKey) for command labels only." Files list: "shared/src/i18n/en.ts (modified) — Add the keys.* message keys — one per command title, plus palette/cheat-sheet/settings/announcement strings." The non-command strings have no stated home.
  - FIX: Resolved by the previous finding: every keyboard string, command titles included, lives in the two panel dictionaries.
- **major**: `.ob-sr-only` reinvents `.sr-only`, which already exists at master/web/src/ui/reset.css:94 and office/web/src/ui/reset.css (and is used by Avatar.tsx:79 and PermissionGrid.tsx:150).
  - FIX: Use `className="sr-only"` for the aria-live region. Delete `.ob-sr-only` from the base.css change list.
- **major**: office/web/src/App.tsx:35 imports and mounts `SaveShortcutProvider`. The design's office bullet says only "delete office/web/src/ui/SaveShortcutSlot.tsx" and "AddLeadScreen.tsx:300 becomes useCommand(...)". Deleting the file without removing the provider from office App.tsx is a compile error.
  - FIX: Add to the office App.tsx bullet: remove the `SaveShortcutProvider` import at :35 and the wrapping element.
- **major**: Deleting office's `/`+Escape effect (office/web/src/App.tsx:318-341) also deletes the ONLY Escape handler for the office sync popover (:334-335). Master's sync popover has no Escape handler at all — both sync popovers are hand-rolled divs (master App.tsx:471-509, office :600-650), not the `Popover` component; `grep -rn "<Popover"` returns exactly one hit, office/web/src/screens/LeadBoardScreen.tsx:256. "2. Popover Escape" in the resolution order describes a component used once.
  - FIX: Register the sync popover as an overlay-scope `overlay.close` consumer in BOTH panels, or convert both to `<Popover>`. Either way the office behaviour must not regress and master gains the missing Escape.
- **major**: The office navOrder list contradicts the office sidebar. Rendered order (office/web/src/App.tsx:415-462) is dashboard, leads, orders, conflicts | products, parties, partyAccess | settings, updates. The design assigns 4=Products, 5=Parties, 6=Conflicts. Alt+4 would land on the 5th visible item. The master list, by contrast, does follow its sidebar.
  - FIX: Office navOrder: 1 dashboard, 2 leads, 3 orders, 4 conflicts, 5 products, 6 parties, 7 partyAccess, 8 settings, 9 updates.
- **major**: "Letters match on event.key.toLowerCase()" breaks Alt+letter on macOS — Alt+K yields `key === '˚'`. No default binds Alt+letter, but §8's capture field lets a user record one, and it would silently die for anyone opening the Master over the LAN from a Mac browser (master binds 0.0.0.0, master/src/config/index.ts:44).
  - FIX: Letters resolve on `key` when `alt` is unset and on `code` (`KeyK`) when `alt` is set. One extra branch, covered by the same test file.
- **major**: Mount points are unspecified and they decide correctness. `MasterPanel` early-returns Splash/FirstRun/SignIn BEFORE `SaveShortcutProvider` (master/web/src/App.tsx:564), so a provider mounted there does not exist in three of four phases. And `useOverlay`'s innermost-dialog rule is DOCUMENT ORDER (useOverlay.ts:49-50): a palette rendered above `<AppShell>` is earlier in the document than any screen Modal, so Escape would close the Modal and leave the palette open.
  - FIX: `KeyboardProvider` mounts in `App()` beside `ToastProvider`. `CommandPalette` and `ShortcutSheet` render in AppShell's existing `overlays` slot (master App.tsx:471, office :600), which renders after `<main>` — guaranteeing they are the last `[role="dialog"]` in the document.
- **minor**: The palette's Records section is said to consume `searchKind` (search.service.ts:58-65). `searchKind` calls `requirePermission` and THROWS 403; `search()` at :30-51 already accepts `query.kinds` and filters them (`permitted = requested.filter((kind) => actorCan(...))`). A palette asking for a kind the user lacks would 403 the whole query.
  - FIX: The palette calls `search()` with `kinds`. Workstream D's only change is reading `req.query.kinds` at master/src/http/routes/data.routes.ts:172-185 and passing it through — which cannot widen access, because `search()` re-filters by `actorCan`.
- **minor**: Pushing a menu descriptor "whenever bindings, permissions or the active screen change" calls `Menu.setApplicationMenu` on every tab switch. Moot once the descriptor is dropped, but the churn was never acknowledged.
  - FIX: N/A once the static menu is kept.
- **minor**: Several line references are wrong. `AppShell.tsx:89-132` — the landmark JSX is 84-140, and `.ob-filterbar` is NOT in AppShell at all (it is FilterBarSlot.tsx:38 and FilterBar.tsx:6). SearchBox.tsx is 126 lines, not 127. office/src/config/index.ts:94 binds `127.0.0.1`, so the office panel is NOT reachable from a LAN browser — the F12 argument holds for master only.
  - FIX: Correct the references; F4 targets `.ob-filterbar` as produced by FilterBarSlot.tsx:38.
- **minor**: tools/i18n-sync.mjs writes stubs with `JSON.stringify` (double quotes) while its own `readKeys` regex only matches single-quoted lines, so a second run re-appends every stub and produces duplicate object keys (TS1117). Any design leaning on that tool should say so.
  - FIX: Moot under the corrected i18n plan (shared catalogue untouched). Flag the tool bug separately.
- **minor**: `SearchBox.tsx` is on the legacy styles.css classes (`card`, `secondary`, `muted`, `chip`) with hardcoded English literals — it never calls `t()`. Deleting it is a translation win the design does not claim, and the `.ob-search` class it is replaced by exists in master's base.css but is currently unused by master's topbar.
  - FIX: State it: master's topbar gains `.ob-search` for the first time, and four untranslated strings disappear.

## Corrected design

## G — Full keyboard system: command palette, F-keys, navigation, remapping (corrected)

**Verdict.** One typed command table in `@orderbook/shared` (DOM-free), one document-level keydown listener per panel resolving chords against it, and every existing ad-hoc keyboard handler re-expressed as a registration against it. The Electron application menu stays **static and main-owned**; the only new IPC is one-way main→renderer carrying a fixed set of string ids. Command labels come from the panels' existing `strings.ts` dictionaries, not from a new parallel catalogue in `shared`.

### 1. Where the system lives

`shared/tsconfig.json` extends `tsconfig.base.json`, whose `lib` is `["ES2022"]` — no DOM. The pure half (chord algebra, the command table, override resolution, conflict detection) belongs there, following the split `shared/src/protocol/desktop.ts:15-19` already states. The React half is authored once per panel and hand-mirrored until the `ui/` de-duplication workstream lands: **5 new React files × 2 panels**. That is the honest cost; no third location is invented to dodge it.

**`shared/src/keys/chord.ts`** — `Chord { key; mod?; ctrl?; alt?; shift? }`, `Platform = 'darwin'|'other'`, a structural `KeyEventLike` (shared cannot name `KeyboardEvent`), plus `chordId`, `parseChord` (returns `null` on garbage — a stale localStorage blob must never throw), `eventChordId`, `formatChord`, `toElectronAccelerator`, `isReservedChord`.

Three matching rules:
1. Digits, F-keys and named keys match on `event.code` (`Digit3`, `F5`, `Slash`). macOS Option+1 delivers `key === '¡'`, `code === 'Digit1'`.
2. Letters match on `event.key.toLowerCase()` when `alt` is unset (so AZERTY/Dvorak work), and on `event.code` (`KeyK`) when `alt` is set (macOS Alt+K is `˚`). Master binds `0.0.0.0` (`master/src/config/index.ts:44`), so a Mac browser on the LAN is a real client; Office binds `127.0.0.1` (`office/src/config/index.ts:94`) and is loopback-only.
3. An `alt`-only chord requires `ctrlKey === false`. AltGr on Indian/European layouts reports as Ctrl+Alt.

Platform is detected once as `navigator.userAgentData?.platform ?? navigator.platform` matching `/mac/i`.

`isReservedChord` refuses `F11`, `F12`, `Alt+F4`, `Mod+Q`, `Mod+W`, `Mod+Shift+I`, `Tab`, `Escape`, and any bare printable other than `/` and `?`.

**`shared/src/keys/commands.ts`** — `CommandDef { id; titleKey: string; group; scope: 'global'|'screen'|'overlay'; defaults: Chord[]; panels; permission?; navOrder?; icon? }`, the single `COMMANDS` table (~70 entries), `COMMANDS_BY_ID`, `commandsForPanel(panel)`.

`titleKey` names a key in the **panel's own** `i18n/strings.ts`. Nav commands reuse the keys the sidebar already renders — `nav.master.dashboard`, `nav.master.leadsOrders`, `nav.updates`, `nav.leads` — so the palette and the sidebar cannot drift and **zero** new nav strings exist. Nav ids are panel-namespaced (`nav.master.orders`, `nav.office.orders`). Only ~24 chrome strings are new (palette, cheat sheet, Settings card, announcements) and they go into **both** `master/web/src/i18n/strings.ts` and `office/web/src/i18n/strings.ts`. `shared/src/i18n` is untouched, so `hi.ts`, `shared/tests/i18n-coverage.test.ts` and `tools/i18n-sync.mjs` are untouched.

**`shared/src/keys/bindings.ts`** — `resolveBindings(panel, overrides)`, `buildChordIndex()`, `findConflicts()`. Two `screen`-scope commands may share a chord (that is the point of per-screen F-keys); a `global` sharing with a `screen` is a conflict, because the screen would shadow the global invisibly. Overrides naming an unknown command are ignored, never thrown.

### 2. Composing with `useOverlay`

`master/web/src/ui/useOverlay.ts:68` registers one listener at `document` with `capture: true` for both Escape and Tab. Capture at `document` plus `stopPropagation()` at `:51` means React's root-container bubble handlers never run — so Escape inside an open `Combobox` inside a `Modal` closes the **modal**, and `Combobox.tsx:76`'s `setOpen(false)` never fires. That is a live bug in both panels (the files are byte-identical).

Changes, four lines plus two:
- `useOverlay.ts` — two `addEventListener` calls. Tab keeps `capture: true`. Escape moves to the bubble phase, gains `if (e.defaultPrevented) return;` and calls `e.preventDefault()` after `closeRef.current()`. The document-order innermost-dialog rule at `:49-50` is untouched.
- `Combobox.tsx:76` — `if (open) { e.preventDefault(); setOpen(false); }`.
- `Popover.tsx:27-32` — add the `defaultPrevented` guard and `preventDefault()`.

Every handler at every level starts with `if (e.defaultPrevented) return;` and calls `preventDefault()` when it acts. Component-level handlers (Combobox, Tabs, DataTable, KanbanBoard, ColourQuantityGrid) win by being closer to the target and get no registry entry.

**Escape and Tab are never in the chord index at all**, because `isReservedChord` refuses them. That — not listener phase — is what keeps `KeyboardProvider` out of the overlay's way; same-node bubble listeners fire in registration order and the provider registers first, at app mount.

**Modality.** While `document.querySelector('[role="dialog"]')` is non-null, the resolver skips `screen`-scope registrations and considers `overlay` then `global` only. A Modal or Drawer registers its own `record.save` / `record.commit` through `useCommand`, so Ctrl+S inside a drawer saves the drawer while F2 no longer fires the screen behind the scrim.

**Typing-target gating.** `isTypingTarget` is hoisted from `office/web/src/App.tsx:320-324` into the provider and deleted there. Modifier chords fire everywhere; bare printables (`/`, `?`) are suppressed inside inputs/textareas/contenteditable; F-keys are not.

### 3. `KeyboardProvider` and the hooks

Mounted in `App()` beside `ToastProvider` — `MasterPanel` early-returns Splash/FirstRun/SignIn before `SaveShortcutProvider`, so mounting there would leave three phases uncovered.

State is `Map<commandId, Registration[]>` — a stack whose top *enabled* entry wins, generalising `SaveShortcutSlot.tsx:4-6`'s "whichever handler most recently registered". `SaveShortcutSlot.tsx` is therefore deleted in both panels, and the `SaveShortcutProvider` import and wrapper are removed from **master/web/src/App.tsx:47,564 and office/web/src/App.tsx:35**.

API: `useCommand(id, run | null, opts?)`, `useScreenCommands(record)`, `useKeyboard()` → `{ bindings, runnable, run, openPalette, openSheet, announce, overrides, setOverride, conflicts }`. `run: null` means registered-but-not-runnable, the same nullable shape as `useSaveShortcut(handler|null)` (`SaveShortcutSlot.tsx:42`), so the palette greys a row instead of the command vanishing mid-keystroke.

`<ScreenScope active={tab === 'orders'}>` supplies a context boolean folded into `enabled`. Requirement 4 keeps screens mounted while hidden, so mount is not visibility. **Same hazard applies to `useFilterBar` (FilterBarSlot.tsx:44-46, publishes on every render with no dep array) and `useTopbarActions`** — hidden mounted screens would fight over the filter bar too. That is the tab-persistence workstream's to fix; F4/F10 depend on it.

Announcements go to one `<div aria-live="polite" className="sr-only" />`. `.sr-only` already exists at `reset.css:94` in both panels — no new class. Focus rings are already correct (`reset.css:67-69`).

### 4. Alt+number against a permission-filtered nav

`master/web/src/App.tsx:351-384` builds `Array<NavItem|null>` and `nest()` filters nulls, so rendered index is not identity. Alt+N resolves against `CommandDef.navOrder`, a permanent property.

Master (matching sidebar order): 1 Dashboard, 2 Leads & orders, 3 Inventory, 4 Reports, 5 Documents, 6 Conflicts, 7 Office panels, 8 Roles & users, 9 Party access; Alt+Shift+1..5 Fields, Logs, Recycle bin, Settings, Updates.
Office (matching sidebar order at App.tsx:415-462): 1 Dashboard, 2 Leads, 3 Orders, 4 Conflicts, 5 Products, 6 Parties, 7 Party access, 8 Settings, 9 Updates.

`App.tsx` registers `nav.*` from the permission booleans at `:298-309`; an unregistered command announces "Not available" rather than landing somewhere else.

**Handlers call `navigate(id)`, never `setTab`.** Master's `navigate` asks `subNav.onExit()` first, so an open role/user editor with an unsaved draft can refuse. Office's `goToTab` (`:484`) currently does `setAddingLead(false)` unconditionally; it gains a confirm when `addingLead` is true. Without that guard the office nav commands are not registered — Alt+N must not be an easier way to lose a half-filled Add Lead form than the sidebar already is.

### 5. Command palette

`ui/CommandPalette.tsx`, rendered in AppShell's existing `overlays` slot (master `App.tsx:471`, office `:600`) so it is the **last** `[role="dialog"]` in the document and `useOverlay`'s innermost rule gives it Escape. It calls `useOverlay(open, close, ref)` for the trap and focus restore, and reuses `.ob-combobox-listbox` / `.ob-combobox-option` (`base.css:1641-1673`).

Two sections, never interleaved:
- **Actions** — `COMMANDS.filter(c => registry.has(c.id))`: the permission filter for free. Ranked by a ~20-line subsequence scorer (word-boundary hits above mid-word, exact prefix wins). No fuzzy dependency for twenty lines.
- **Records** — `api.search(term, { kinds })`. It calls `search()` (search.service.ts:30-51), which already accepts `query.kinds` and re-filters them with `actorCan`, **not** `searchKind` (`:58-65`), which uses `requirePermission` and would 403 the whole query for a user missing one kind. Workstream D's only server change is reading `req.query.kinds` at `data.routes.ts:172-185`.

**Offline.** `/api/search` in Office is a hard forward to the Master (`office/src/http/app.ts:438`). On failure the palette renders the existing `t('search.failedOffline')` and falls back to a substring scan of the merged `LocalView` already in memory (`office/web/src/App.tsx:92`) — already masked and party-scoped by `SNAPSHOT_POLICY`, so no new leak path and no server change.

Records are debounced 180 ms and aborted via `AbortController` once the API workstream threads `signal` through `request<T>` (`master/web/src/api.ts:151`). Render cap 8+8, no virtualisation, same reasoning as `Combobox.tsx:5-6`. Empty query shows the last 8 commands and last 8 records from `localStorage`.

`SearchBox.tsx` (126 lines, still on legacy `styles.css` classes with four hardcoded English literals) is deleted, along with the office topbar search block (`App.tsx:509-554`) and its `runSearch`/`term`/`hits`/`searchFailedOffline`/`debounceRef` state. Both topbars keep a `.ob-search`-styled button with a `<kbd>` that opens the palette — master's topbar gains `.ob-search` for the first time. `/` opens records mode, `Mod+K` all mode. Record activation keeps the `onOpen(hit: SearchHit)` seam (`SearchBox.tsx:26`), so navigation stays App's business.

Deleting office's `/`+Escape effect (`App.tsx:318-341`) also removes the only Escape handler for the office **sync popover** (`:334-335`). Both panels' sync popovers are hand-rolled divs, not `<Popover>` (one usage repo-wide: `office/web/src/screens/LeadBoardScreen.tsx:256`), and master's has no Escape at all. Both register an overlay-scope close so office does not regress and master gains it.

### 6. F-keys

F1 cheat sheet; F11 and F12 reserved (Chromium owns F12 above the page, and Master is reachable from a LAN browser). F5 = `data.refresh`, a refetch not a page reload: in Master it bumps the existing `dataRevision` counter (`App.tsx:126`) that every screen already refetches on; in Office it re-opens the SSE stream that pushes `LocalView` (`App.tsx:234`). Screens may override with a screen-scope registration.

Provider-implemented against existing classes so screens do nothing: **F4** focuses the first control in `.ob-filterbar` (produced by `FilterBarSlot.tsx:38` / `FilterBar.tsx:6` — not by AppShell); **F6** cycles `.ob-sidebar` → `.ob-topbar` → `.ob-filterbar` → `.ob-content` → `.ob-footer` (`AppShell.tsx:84-140`); **F10** focuses `TopbarActionsOutlet` (master only today; office gains the slot). Per-screen: F2 edit, F3 next, F7 duplicate, F8 export, F9 commit.

`zoomIn`/`zoomOut`/`resetZoom` roles are **not** registered — they move `webContents.zoomFactor` and would compound with `--root-size` (`tokens.css:136,191`). `Mod+=`/`-`/`0` bind to the UI-scale workstream's own commands.

### 7. Enter-to-advance

`ui/useEnterToAdvance.ts` takes a **container ref, not a form**: only three `<form>` elements exist in the whole frontend (`master/web/src/screens/SignInScreen.tsx:55`, `office/.../SignInScreen.tsx:80`, `office/.../ConnectionScreen.tsx:321`) — every drawer and editor is bare `FormField`/`Input`. It walks `ref.current.querySelectorAll(FOCUSABLE)`, reusing the selector constant at `useOverlay.ts:21` (exported from there, not re-written). Enter in a non-final control focuses the next enabled one; on the last it runs the top-of-stack `record.save` registration. Mod+Enter always saves.

Excluded: `<textarea>`, `<select>`, `type="submit"`, contenteditable, and anything inside `[data-keys-grid]` (covering `ColourQuantityGrid.tsx:148-159`, which owns Enter-on-last via `onEnterLast`, and workstream D's voucher grid). An open Combobox needs no case: `Combobox.tsx:72` already `preventDefault()`s Enter.

`office/web/src/components/PartyDrawer.tsx:143-145` and `ProductDrawer.tsx:174-176` each hang an ad-hoc Enter→save off one field; both are deleted and replaced by the hook.

### 8. Cheat sheet, remapping, storage

`ui/ShortcutSheet.tsx` is a `Modal size="lg"` (`Modal.tsx:24` already has `'lg'`) opened by `?` or F1, rendered from the **resolved** binding map so it cannot lie after a remap. Every chord goes through `formatChord()` — one formatter, three consumers.

Storage is per-machine `localStorage`, key `ob.keys.v1` → `Record<userId, Record<commandId, chordId[]>>`, through `readJson`/`writeJson` added beside `read`/`store` in each panel's `ui/theme.ts` (master `:22-29,49-56`; office's file differs — different `KEY_THEME` and no `colorScheme` line — so edit both, do not copy). Rationale: a keyboard is a property of a machine, exactly as theme/density/motion already are. Accepted cost: remaps do not follow a user to another panel.

Settings gets a Keyboard card in both `SettingsScreen.tsx`, using each screen's local `Card`/`SettingRow` (master `:185`): grouped list, current chord, capture button, per-row reset, Reset all, inline `findConflicts()` output blocking save. Capture ignores modifier-only presses, treats Escape as cancel, never captures Tab, and refuses anything `isReservedChord` rejects.

### 9. Electron menu

`buildMenu()` in `master/electron/main.ts:217-246` and `office/electron/main.ts:211-240` stays static and main-owned. No descriptor crosses from renderer to main; the shell that requirements 1 and 7 exist to stabilise gains no new attack surface, and no accelerator-validation regex is needed.

Changes:
- `role: 'reload'` pinned to `accelerator: 'CmdOrCtrl+R'` so it does not also claim F5.
- `before-input-event` swallows F5 and Ctrl+Shift+R in packaged builds (secondary; the pin does the real work).
- The Help item at `:236` stops calling `loadURL('${ORIGIN}/#/updates')` — `readHash()` (`App.tsx:100`) only recognises `'gallery'`, so today it reloads the app onto the Dashboard — and instead sends `webContents.send('orderbook:menuCommand', 'nav.updates')`.
- One new item: "Keyboard shortcuts\tF1" sending `'help.shortcuts'`.

`shared/src/protocol/desktop.ts` gains one method on `DesktopBridge`: `onMenuCommand(handler: (id: string) => void): () => void`. Both `preload.cts` files expose it. The renderer whitelists ids against `COMMANDS_BY_ID` before running anything.

### Files

**New (shared):** `shared/src/keys/{chord,commands,bindings,index}.ts`; `shared/src/index.ts` re-exports the barrel.
**New (each panel's `web/src/ui/`, ×2):** `KeyboardProvider.tsx`, `useKeys.ts`, `CommandPalette.tsx`, `ShortcutSheet.tsx`, `useEnterToAdvance.ts`.
**Modified (×2):** `ui/useOverlay.ts` (phase split; export `FOCUSABLE`), `ui/Combobox.tsx`, `ui/Popover.tsx`, `ui/theme.ts`, `ui/base.css` (`.ob-kbd`, `.ob-palette*`, `.ob-sheet-grid` — no `.ob-sr-only`), `i18n/strings.ts` (~24 keys), `screens/SettingsScreen.tsx`, `electron/main.ts`, `electron/preload.cts`.
**Modified (master):** `App.tsx` (mount provider in `App()`, palette/sheet in `overlays`, `ScreenScope`, `nav.*` via `navigate()`, drop `SaveShortcutProvider`, replace `SearchBox`).
**Modified (office):** `App.tsx` (same, plus delete `:318-341` and `:509-554` and their state, drop `SaveShortcutProvider` at `:35`, add a TopbarActions slot, guard `goToTab`'s `setAddingLead(false)`), `components/PartyDrawer.tsx`, `components/ProductDrawer.tsx`, `screens/AddLeadScreen.tsx:300`.
**Deleted (×2):** `ui/SaveShortcutSlot.tsx`. **Deleted (master):** `components/SearchBox.tsx`.
**Migrations:** none. No table, no `DATA_TABLES` entry, no `SNAPSHOT_POLICY` collection, no `migration-registry.test.ts` churn.

### Tests

`shared/tests/keys.test.ts` (pure, runs today): no default chord is reserved; no two global commands collide, and no global collides with a screen command; `navOrder` unique and contiguous per panel; `formatChord(parseChord(id))` round-trips on both platforms; `eventChordId({key:'¡',code:'Digit1',altKey:true},'darwin') === 'alt+Digit1'`; an AltGr event (`altKey && ctrlKey`) yields no alt-only match; Alt+letter resolves on `code`; `parseChord('garbage')` returns `null`; every `permission` satisfies `isPermission`; `resolveBindings` ignores unknown ids and an empty override leaves the command palette-reachable; `findConflicts()` is `[]` for shipped defaults, flags global-vs-screen, does not flag two screens sharing F2.

`master/tests/keyboard-strings.test.ts` (new): `readFileSync` both panels' `strings.ts` — the pattern `i18n-coverage.test.ts:121` already uses — and assert every `titleKey` in `commandsForPanel('master'|'office')` appears in the matching dictionary. Catches the drift the forked dictionaries otherwise guarantee.

### Not doing

No database table for bindings, so no migration, no `index.ts` array entry before the pinned `20260309000000` slot, no SHIPPED entry, no `SNAPSHOT_POLICY` collection. Theme/density/motion already establish per-machine as the precedent. Upgrade path if the owner disagrees: `user_preferences(tenant_id, user_id, key, value jsonb)` with a `'replace'` policy.

No new keys in `shared/src/i18n` — the panel dictionaries already hold every visible label, and a parallel catalogue would make the palette and the sidebar disagree.

No renderer-driven Electron menu. Not requested, and it would put an untrusted descriptor into `Menu.buildFromTemplate` inside the shell requirement 1 is about. F1 is the discoverability answer.

No fuzzy-search dependency; no merged Actions/Records ranking (a subsequence score and a Postgres `ts_rank` are different scales); no virtualisation at 8+8 rows; no component-scope registry entries; no remapping of Escape, Tab or arrows.

No React-layer tests. `vitest.config.ts:8` collects only `{shared,master,office}/tests/**/*.test.ts` with `environment:'node'`, and `tsconfig.test.json` has no DOM lib. Everything testable was pushed into `shared/src/keys` so it can be tested today. **The `useOverlay` phase change ships unit-untested and needs a manual pass over every Modal and Drawer in both panels before merge.**

### Dependencies

Tab-persistence (req. 4) — hard interface: `ScreenScope`, and the same visibility gate for `useFilterBar`/`useTopbarActions`. Workstream D — the `kinds` param and `data-keys-grid` on the voucher grid. API optimisation (req. 11) — `AbortSignal` through `request<T>`. UI-scale (req. 3) — owns `Mod+=`/`-`/`0`. Electron stability (reqs. 1, 7) — both `main.ts` files are being rewritten there; the reload-accelerator pin, the `before-input-event` swallow and the two menu items must land inside that rewrite, not as a second pass over the same 250 lines.