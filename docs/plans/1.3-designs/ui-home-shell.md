# Design: Basic Home, device code, Master UI overhaul, loading bars, Master Inventory UI removal, nav/shortcut map (both panels), low-RAM frontend + Electron/PG memory

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

Both panels get a new shared screen, ui/src/BasicHome.tsx. It is an app-icon launcher built from the shell's own permission-filtered NavGroup[], so a tile is missing whenever the sidebar row is missing. It is grouped Work / Catalogue / (Admin on the Master) / System. Each tile has a 104px gradient face with radius 12, a white glyph (the existing Icon paths drawn at 40px), a 12.5px/550 label and an IBM Plex Mono shortcut chip read live from chordFor(). Tiles lift 2px on hover and show a --line-focus ring on focus, and NavItem.count drives a badge on the face. Work also gets a 'New pending order' tile (Ctrl+Shift+N) when the role can create leads. Landing goes through landingScreen(tier): office and management land on Basic Home, and everyone else (admin, server_master, unknown) lands on Dashboard. It is applied at sign-in and on the boot-restore path, and the brand button goes to the same target (AppShell homeId). Sign-out and session-end reset to 'basicHome'. On the Office, Basic Home sits in alwaysAvailable, so it renders before the first snapshot.

Both sidebars are rebuilt as one literal `const groups: NavGroup[] = [...].map((group) => ...)` with the same groups and the same chord map on both panels:
- Work: Basic Home Alt+1, Dashboard Alt+2, Pending Alt+3, Final Alt+4, Conflicts Alt+5, Chatroom Alt+C, Printroom Alt+P, Reports.
- Catalogue: Products Alt+6, Parties Alt+7, Party access Alt+8.
- Admin (Master only): Panels, Roles & users, Fields, Logs, Recycle bin, Integrations.
- System: Settings Alt+9, App update.

This matches the mockup's Office chords exactly. MASTER_NAV/OFFICE_NAV take an optional explicit chord per entry, so sidebar order and Alt digits are both declared and both guarded.

Master UI overhaul:
- Light theme is the default. The storage key is bumped to ob.theme.v3, because initAppearance stores whatever it loads and every existing Master already has 'dark' saved. Dark stays selectable.
- The sidebar uses the four groups above.
- A shared TopbarTitle gives every screen the same header: module icon, group eyebrow, then the h1.
- The footer gains the company name, taken from /api/setup/status.
- The Dashboard is rebuilt on a shared StatTile. It shows counts only: open pending orders, open final orders, converted today, dispatched today, follow-ups due, conflicts, pending sync, panels online and panels offline over an hour. It also has print-jobs-pending and unread-chat tiles, which the Printroom and Chat domains feed.
- Inventory UI is removed from the Master: screen, tests, nav row, Alt chord, sub-pages, api members, low-stock card, badge and popover row, and two orphan settings rows. Server stock is untouched.

Loading: one module-level in-flight counter fed by both api.ts request() functions drives a thin indeterminate TopProgress strip at the top of .ob-main. It appears after 300 ms. A determinate ProgressBar (built on the splash bar CSS) is there for imports, exports and backups. Lazy screens' Suspense fallback feeds the same counter. Motion respects data-motion=off, prefers-reduced-motion and data-window-blur.

The Office shows its device code on the sign-in screen, where it is final and matches the Master's Panels screen. It also shows it on the pairing screen, labelled provisional.

Low RAM:
- Frontend: ScreenHost caps live screens with LRU eviction (4 on machines with 4 GB or less, else 8). Screens with an open record or draft are pinned. Hidden screens are frozen with a memo, so shell re-renders skip them. Rarely used screens load through React.lazy. Kanban columns cap at 60 cards with a 'Show N more' button.
- Electron: the renderer gets a --max-old-space-size of 1024 on PCs with 4.5 GB or less. The Office server heap floor drops to 1024 MB on such PCs (the Master keeps 2048, which it needs for backups). The renderer may now reload once per 5 minutes instead of once per process.
- PostgreSQL gets -c memory options sized from total RAM.
- Both servers log unhandled rejections instead of dying.
- The shell log rotates while running, and postgres.log rotates at start.

## decisions

- Basic Home is offered on BOTH panels to every role (no permission), as the first sidebar item (Alt+1); only office/management LAND on it. Admin/server_master can still open it. Rationale: owner said 'both panels' and a launcher needs no key beyond sign-in.
- landingScreen(tier: string): 'basicHome' for 'office'|'management', else 'dashboard' (admin, server_master, any unknown future tier). Lives in ui/src/BasicHome.tsx; no tierRank dependency so an old panel seeing 'server_master' still behaves.
- Identical chord map on both panels: Basic Home 1, Dashboard 2, Pending 3, Final 4, Conflicts 5, Products 6, Parties 7, Party access 8, Settings 9 (exactly the mockup's Office chords, and Master muscle memory now matches the Office). Chatroom = Alt+C, Printroom = Alt+P (both panels). Reports, App update and every Master Admin item have no chord (palette reaches them).
- Chord choice: Alt+C / Alt+P instead of Ctrl+Shift+M/P. Ctrl+Shift+M (profile switcher) and Ctrl+Shift+P (system print dialog) are browser-level chords that a LAN browser opening the Master UI may refuse to yield. Alt+C/P collide with no Electron menu mnemonic (&File/&Edit/&View/&Help) and no existing COMMANDS entry. findConflicts and the 'fired by an actual keypress' test cover letters. No darwin override: chord matching falls back to the physical code when Alt is held.
- MASTER_NAV/OFFICE_NAV entries become [id, token, chord?]: undefined = next free Alt digit (counted only over undefined entries, still capped at 9), a string = explicit chord, null = no chord. navOrder stays the sidebar index, so keys-nav-order keeps proving that the declared order equals the sidebar order. One optional tuple slot, no new abstraction.
- Master sidebar is rewritten in the Office's exact shape (`const groups: NavGroup[] = [ {label, items: [...]}, ... ].map((group) => ({ ...group, items: nest(group.items) }))`). keys-nav-order.test.ts then slices both panels with the same markers and the workItems/adminItems markers die. Party access moves from Admin to Catalogue on the Master to mirror the Office mockup.
- Group labels: nav.work, nav.catalogue, nav.master.admin, nav.system on the Master (the Office tokens are reused). nav.master.work, nav.master.inventory and nav.master.reports are deleted from en.ts; Reports uses a new neutral nav.reports on both panels.
- Master light theme default: configureUi({panel:'master', defaultTheme:'light', themeStorageKey:'ob.theme.v3'}), index.html data-theme='light' with no inline color-scheme. The key bump is required because initAppearance() persists whatever it loads, so 'persisted choice wins' would otherwise keep every existing Master dark. Cost: an owner who deliberately chose dark picks it once more (one line in the release notes). BrowserWindow backgroundColor becomes #f2f4f5.
- Since the Master is no longer told apart by dark chrome, the Server Master badge (roles domain) plus the Admin nav group serve as its 'unmistakable' cue. No extra 'Master' wordmark is added.
- No new PageHeader component inside content. The topbar already is the page header on every screen. A shared TopbarTitle (module icon + group eyebrow + h1 label, computed from groups+activeId) replaces both shells' bare <h1>, and tests that read '.ob-topbar h1' keep working.
- Master footer company name is read from GET /api/setup/status (adds companyName). It is already public: it is broadcast in UDP discovery and shown on the Office sign-in screen. Rejected: /api/setup/identity (needs settings.manage) and a new /me field (sign-in does not return it).
- Dashboard: shared ui/src/StatTile.tsx replaces the private StatCard copies in master DashboardScreen and office DashboardScreen (ReportsScreen's copy is left to the reports domain). New optional DashboardSummary fields convertedTodayCount and dispatchedTodayCount (orders.view; orders created / dispatched since local midnight, same tz SQL as dispatchedThisWeek). 'Offline over an hour' is computed client-side from panels (isConnected false and lastSeenAt older than 1 h). Print-pending and unread-chat come in as props from those domains. Counts only, never money.
- Inventory option (i), UI only: delete InventoryScreen.tsx, its two jsdom tests, the nav item, Tab member, SUB_NAV_SCREENS entry, SCREEN_ENTITIES.inventory, subPages.inventory, ScreenSpec, the MASTER_NAV row, the api members stockMovements/stockInbound/stockAdjust/setReorderLevel, PANEL_ONLY.inventory, the Master Dashboard low-stock StatCard and the sync-popover low-stock row. Keep api.stock (ProductsScreen), SCREEN_ENTITIES.catalogueStock, every server route, socket command, public API endpoint and DashboardSummary.lowStockCount (Office DASHBOARD_FIGURE_PERMISSIONS is exhaustively typed and dashboard-staleness pins it). The product-hit search fallback 'inventory' becomes 'products'.
- Settings on the Master UI: hide only the rows inventory.defaultReorderLevel and inventory.adjustmentNoteRequired, which now feed nothing visible, through a MASTER_HIDDEN_SETTINGS set in master SettingsScreen. Keep inventory.freeToSell (it still controls the order Reservations section) and catalog.importCreatesCategories, so the 'stock' group keeps two members and settings.test.ts stays green.
- Roles grid keeps inventory.view/edit/export and stock.adjust visible: inventory.view still gates the Products Stock column and lead-line free hints, and the others still gate the socket and public-API stock commands. Hiding live grants would be worse than showing them. The inventory.* i18n keys stay; there is no dead-key guard and old activity rows use activity.stock.*.
- Motion rule change, recorded in docs/UI_REDESIGN.md: the owner explicitly asked for loading bars, which overrides 'the busy mark is the only mover'. TopProgress is a 2px indeterminate accent strip shown only after 300 ms of in-flight requests, paused under data-window-blur and frozen as a static 40% segment by the reset.css kill switches. Skeletons stay static (no shimmer).
- TopProgress counts every request through request() (GET and writes). Nothing polls by fetch today (the only intervals are Clock, Splash and a settings countdown), so no opt-out flag is needed. SSE and the socket are not counted.
- ScreenHost low-RAM: (1) Frozen = memo(render-prop, skip when !next.active), so hidden <Activity> screens are not re-rendered or even rebuilt by shell re-renders. Effects are already torn down by Activity, and props catch up when the screen becomes active. (2) LRU: keep at most 4 live screens when navigator.deviceMemory <= 4, else 8. The active screen, 'addLead' and any screen holding a SubNav registry entry (open record or draft) are pinned and never evicted. (3) Suspense around each pane for lazy screens.
- React.lazy only for rarely visited screens: Master Logs, RecycleBin, Integrations, Fields, Access, PartyAccess, Panels, Updates, Reports, Conflicts, Settings; Office Conflicts, PartyAccess, Settings, Updates. The landing and daily screens (BasicHome, Dashboard, Leads/LeadEntry/AddLead, Orders, Products, Parties, Chatroom, Printroom) stay eager, so the first paint and the daily path never suspend. A failed chunk import (a stale LAN tab after a Master update) reloads the page once, guarded by sessionStorage.
- Skipped as not worth the cost: Vite manualChunks (lazy() already splits per screen, and a vendor chunk only helps HTTP caching of a localhost-served app); a LoadMorePager cap (DataTable already virtualises above 100 rows, and 500-row pages are about 1 MB of JS, so it is not a 4 GB problem); Office SSE snapshot diffing (JSON diff is not cheap, and freezing hidden screens removes most re-render cost); Kanban virtualisation (replaced by a 60-cards-per-column cap with 'Show N more', which keeps native drag simple).
- Electron memory: serverHeapMb() keeps the Master's 2048 MB floor. The Master is Win10+ and backup restore still buffers up to 1 GB through multer. The Office floor drops to 1024 MB on PCs with 4.5 GB or less, where the heap ceiling only decides how late GC gets aggressive and the Office server's live set is small. The renderer gets js-flags --max-old-space-size=1024 on the same PCs. The renderer 'reloaded once' latch now resets after 5 minutes, so a single crash per session is no longer terminal.
- PostgreSQL: pgMemoryOptions(totalMb) appends -c shared_buffers=64MB -c work_mem=2MB -c maintenance_work_mem=32MB -c max_connections=30 on PCs with 4.5 GB or less, and -c max_connections=40 otherwise (PG defaults stay). The knex pool stays min 2 / max 10: a smaller pool would worsen the nested-transaction starvation in sync applyOne the critic flagged, and 30 >= 10 + migrations + superuser reserve.
- Process safety: both servers log unhandledRejection and keep running. uncaughtException is still allowed to kill the process, because a corrupted process is worse than a supervised restart (the shell already restarts up to 3 times in 10 minutes). The hub.ts comment claiming no handler exists is updated.
- Device code: GET /api/connection adds deviceCode (await deviceCode() from office/src/sync/device.ts). ConnectionInfo.deviceCode is optional so existing fixtures stand. The sign-in screen shows it as final. The pairing ConnectionScreen shows it with a 'provisional, changes when paired' note, decided client-side from !isPaired.

## dataModel

- None. This domain adds no migration. DashboardSummary.convertedTodayCount/dispatchedTodayCount are computed from the existing orders.created_at/dispatched_at columns; theme, sidebar and keep-alive state live in localStorage or memory; PostgreSQL tuning is runtime -c options passed to pg_ctl, not schema.

## permissions

- None new. Basic Home, Dashboard, Settings and App update need only sign-in. Tiles and sidebar rows reuse the existing gates (leads.view, orders.view, sync.resolveConflicts or the refusal rule on the Office, products.view, parties.view, party.assign|party.accessAll, panels.manage, roles.view|users.manage, fields.view, logs.view, recycleBin.view, api.manage). Chatroom, Printroom and Reports rows are gated on booleans their domains supply (see dependsOn).

## interfaces

- GET /api/setup/status (Master, unauthenticated) -> { setupComplete: boolean; companyName?: string | null } (companyName added; read via setupService.getIdentity() only when setup is complete). master/web/src/api.ts setupStatus type updated.
- GET /api/connection (Office) adds deviceCode: string; office/web/src/api.ts ConnectionInfo gains `deviceCode?: string` (optional, wire-safe).
- DashboardSummary (shared/src/domain/entities.ts) gains optional convertedTodayCount?: number and dispatchedTodayCount?: number (orders.view). master/src/repositories/dashboard.repository.ts: dispatchedThisWeek becomes dispatchedSince(tenantId, scope, unit: 'day'|'week'), plus a new convertedToday(tenantId, scope) counting orders.created_at since local midnight. office/src/http/app.ts DASHBOARD_FIGURE_PERMISSIONS gets both keys -> 'orders.view' (compile-required).
- shared/src/keys/commands.ts: nav tuple [id, token, chord?: string | null]. New commands nav.master.basicHome, nav.office.basicHome (Alt+1), nav.{master,office}.chatroom (Alt+C), nav.{master,office}.printroom (Alt+P), nav.{master,office}.reports (no chord), nav.master.inventory removed. Final Master order: basicHome, dashboard, leads, orders, conflicts, chatroom, printroom, reports, products, parties, partyAccess, panels, access, fields, logs, recycleBin, integrations, settings, updates. Final Office order: basicHome, dashboard, leads, orders, conflicts, chatroom, printroom, reports, products, parties, partyAccess, settings, updates.
- ui/src/AppShell.tsx: AppShell gains optional prop homeId?: string (default 'dashboard'), used by the brand button. It renders <TopProgress/> as the first child of .ob-main. New export TopbarTitle({ groups, activeId, fallback }).
- ui/src/BasicHome.tsx (new): export function BasicHome({ groups, onOpen, onNewLead }: { groups: NavGroup[]; onOpen: (id: string) => void; onNewLead?: () => void }) and export function landingScreen(tier: string): 'basicHome' | 'dashboard'.
- ui/src/TopProgress.tsx (new): trackLoad<T>(work: Promise<T>): Promise<T>; TopProgress(); LoadingMark() (counts while mounted, used as the Suspense fallback); ProgressBar({ value, label }: { value: number | null; label?: string }) where null = indeterminate.
- ui/src/StatTile.tsx (new): StatTile({ label, value, note?, tone?: 'conflict'|'offline'|'ok', icon?: IconName, onClick? }) and StatTileSkeleton().
- ui/src/ScreenHost.tsx: same props; adds Suspense, LRU eviction, hidden-screen freeze; new export lazyScreen(load, exportName) -> LazyExoticComponent, which reloads once on a chunk-load failure.
- ui/src/SubNavSlot.tsx: new export useSubNavHeld(): ReadonlySet<string> (screen ids with a registry entry), read by ScreenHost for pinning.
- ui/src/CommandPalette.tsx: export the existing private displayChord (used by BasicHome chips).
- ui/src/icons.tsx: IconName gains 'home', 'chat', 'print', 'report' (Reports switches from 'calendar' to 'report').
- electron/lib/memory.ts (new): serverHeapMb(totalRamMb, panel) and rendererHeapFlag(totalRamMb): string | null. master/src/db/postgres-server.ts: exported pgMemoryOptions(totalMb): string[] appended to serverOptions in startCluster.
- No new socket commands, SSE event types or IPC channels.

## settings

- No company settings and no CompanyFeatures fields. Per-machine localStorage only: the Master theme key moves 'ob.theme.v2' -> 'ob.theme.v3' with default 'light'.

## uiScreens

- ui/src/BasicHome.tsx (shared, props only): one section per group (eyebrow label = group.label) with tiles for every top-level NavItem except 'basicHome' itself; a 'New pending order' tile first in Work when onNewLead is given (chip = chordFor('record.new')). Tile = <button class='ob-tile' data-hue=…>: .ob-tile-face (calc(104rem/14) square, radius var(--r-xl)=12px, layered gradient: var(--tile-sheen) radial over linear-gradient(135deg, var(--tile-<hue>-a), var(--tile-<hue>-b)), white Icon at size 40), .ob-tile-label (0.8929rem / 550), .ob-tile-chord (font-mono 0.75rem, chordFor('nav.<panel>.<id>') via uiConfig().panel + displayChord, omitted when unbound), .ob-tile-count badge from NavItem.count. Hover translateY(-2px) + --sh-2; :focus-visible outline 2px var(--line-focus). Hue map id->hue: dashboard indigo, leads blue, orders teal, conflicts red, chatroom violet, printroom slate, reports amber, products green, parties rose, partyAccess indigo, panels slate, access violet, fields teal, logs slate, recycleBin red, integrations indigo, settings slate, updates green; unknown -> slate. Empty (no tiles) -> EmptyState shell.noModules.
- ui/src/tokens.css: --r-xl: 12px; --tile-sheen; --tile-{blue,indigo,teal,green,amber,red,rose,violet,slate}-{a,b} for light, deeper variants under [data-theme='dark']. ui/src/base.css: .ob-launcher (section grid repeat(auto-fill, minmax(8.5rem, 1fr))), .ob-tile*, .ob-topprogress (2px strip, keyframe ob-topprogress-slide, added to the html[data-window-blur='true'] pause selector), .ob-progress/.ob-progress-fill (determinate, the same declarations as .ob-splash-track/.ob-splash-fill via a shared selector list), .ob-topbar-title (icon + eyebrow + h1).
- Sidebar, both panels: groups Work / Catalogue / [Admin, Master only] / System as listed in interfaces. New rows 'Basic Home' (icon home), 'Chatroom' (chat, count = unread), 'Printroom' (print, count = pending jobs), 'Reports' (report). The Master Inventory row is gone.
- Master Dashboard (master/web/src/screens/DashboardScreen.tsx) refresh: KPI row of StatTiles with icons: Pending orders (leadCount, note = follow-ups due), Final orders open (openOrderCount), Converted today, Dispatched today, Dispatched this week, Follow-ups due, Panels online x/y, Offline over an hour (panels.manage), Conflicts, Pending sync, Print jobs pending, Unread chat. Pipeline bars and follow-ups card are kept. The low-stock card is removed.
- Office Dashboard: local StatCard replaced by StatTile (no behaviour change).
- Master footer: sync button · [flex] · 'Company · <name>' · avatar + user · role · Design system · version · Clock. Office footer unchanged.
- Office SignInScreen: under the company line, a muted 'Device code' row in ob-mono (connection.deviceCode). Office ConnectionScreen network Card: same row plus 'Provisional — the Master assigns the final code when this PC pairs'.
- Topbar (both): TopbarTitle replaces the bare h1.
- Kanban (ui/src/KanbanBoard.tsx): at most 60 cards per column, then a ghost 'Show {count} more' button per column (column-local state).

## steps

### 1. Icons, tokens and CSS for tiles, progress and title

Files: `ui/src/icons.tsx`, `ui/src/tokens.css`, `ui/src/base.css`

Add IconName 'home' (house outline), 'chat' (speech bubble), 'print' (printer) and 'report' (bar chart), each a 16-unit stroke path like the existing ones. tokens.css: --r-xl: 12px, --tile-sheen, and the nine --tile-<hue>-a/-b pairs in light plus darker overrides in [data-theme='dark']. base.css: .ob-launcher, .ob-launcher-section, .ob-tile, .ob-tile-face, .ob-tile-label, .ob-tile-chord, .ob-tile-count, [data-hue=…] mapping to the tile tokens, hover lift and focus ring. Also .ob-topprogress with an indeterminate keyframe, joining the html[data-window-blur='true'] pause rule; .ob-progress/.ob-progress-fill sharing the splash bar declarations (selector list, no copy); .ob-topbar-title. Lengths go in rem (104px = 7.4286rem, 12.5px = 0.8929rem, 10.5px = 0.75rem); hairlines, radii and the 2px lift stay in px, per ui-conventions.

### 2. Loading primitives

Files: `ui/src/TopProgress.tsx`, `ui/src/StatTile.tsx`, `ui/src/index.ts`, `master/web/src/api.ts`, `office/web/src/api.ts`

TopProgress.tsx: a module-level `pending` counter plus a listener Set. trackLoad(work) increments, then decrements in finally. TopProgress uses useSyncExternalStore(subscribe, () => pending > 0) and a 300 ms setTimeout before showing a role=progressbar strip with aria-label t('common.loading'). LoadingMark increments while mounted. ProgressBar renders .ob-progress with aria-valuenow, or the indeterminate strip when value is null. StatTile.tsx is lifted from master DashboardScreen's StatCard, adding an icon and tone 'ok', plus StatTileSkeleton. Add export * lines for TopProgress, StatTile and BasicHome to the barrel. In both api.ts files, `request()` returns trackLoad(<existing promise>) on both branches (the dedupe branch wraps the per-caller promise).

### 3. ScreenHost: Suspense, freeze hidden screens, LRU, lazyScreen

Files: `ui/src/ScreenHost.tsx`, `ui/src/SubNavSlot.tsx`

SubNavSlot: export useSubNavHeld() returning new Set(entries.keys()). ScreenHost: replace `visited` Set with an ordered array (most recent last), still updated during render. Evict the oldest entries beyond MAX_ALIVE (navigator.deviceMemory <= 4 ? 4 : 8), skipping the activeId, 'addLead' and ids in useSubNavHeld(). Render each as <Activity key mode><ScreenPane active><Suspense fallback={<LoadingMark/>}><Frozen active render={screen.render}/></Suspense></ScreenPane></Activity>. Frozen = memo(({render}) => render(), (_prev, next) => !next.active). lazyScreen(load, name) = lazy(() => load().then(m => ({ default: m[name] })).catch(reloadOnce)), where reloadOnce sets sessionStorage 'ob.chunkReload' and calls location.reload(), rethrowing if the flag is already set. Update the header comment to describe eviction and freeze.

### 4. Basic Home component and landing helper

Files: `ui/src/BasicHome.tsx`, `ui/src/CommandPalette.tsx`, `eslint.config.js`

Export displayChord from CommandPalette. BasicHome renders sections from props.groups (top-level items only, skipping id 'basicHome'). Each tile's onClick is onOpen(item.id). The chip comes from chordFor(`nav.${uiConfig().panel}.${item.id}`, useKeyboard().bindings) passed through displayChord. The New pending order tile calls onNewLead with the chip chordFor('record.new'). HUE: Record<string, string> maps id to hue. landingScreen(tier) = tier === 'office' || tier === 'management' ? 'basicHome' : 'dashboard'. Every string goes through t(). Add ui/src/BasicHome.tsx and ui/src/TopProgress.tsx to the swept no-untranslated-jsx-text files list.

### 5. AppShell: home target, progress strip, TopbarTitle

Files: `ui/src/AppShell.tsx`

Add the homeId?: string prop (default 'dashboard'); the brand button calls onNavigate(homeId). Render <TopProgress/> first inside .ob-main. Add TopbarTitle({groups, activeId, fallback}): find the top-level item containing activeId and its group, then render span.ob-topbar-title containing Icon, eyebrow group label and <h1 className='ob-title'>{label of the flattened item with activeId, else fallback}</h1>. Change en nav.home to 'Go to your home screen'.

### 6. Nav catalogue with explicit chords

Files: `shared/src/keys/commands.ts`

Change the tuple type to [id, token, chord?: string | null]. In navCommands, keep a running digit counter over entries whose chord is undefined: defaultChord = chord === undefined ? (digit <= 9 ? `Alt+${digit}` : undefined) : (chord ?? undefined), with platformDefaultChord {darwin: `Meta+${digit}`} only for digit chords. navOrder stays index+1. Replace MASTER_NAV and OFFICE_NAV with the final orders in interfaces: chatroom 'Alt+C', printroom 'Alt+P', and reports, panels, access, fields, logs, recycleBin, integrations and updates set to null. Tokens: nav.basicHome, nav.chatroom, nav.printroom, nav.reports (new); Master keeps nav.master.* for the rest. Rewrite the doc comments (the tail-has-no-chord rationale and the per-entry override).

### 7. Master shell rewrite: groups, landing, Basic Home, Inventory removal, footer, lazy screens

Files: `master/web/src/App.tsx`, `master/web/src/api.ts`, `master/web/src/main.tsx`, `master/web/index.html`, `master/web/src/screens/InventoryScreen.tsx`, `master/web/src/screens/SettingsScreen.tsx`

Tab union: remove 'inventory'; add 'basicHome', 'chatroom', 'printroom'. Remove the InventoryScreen import, canViewInventory, the nav item and badge, subPages.inventory, SCREEN_ENTITIES.inventory, the 'inventory' entry in SUB_NAV_SCREENS, the ScreenSpec and the popover lowStock row; the search product hit falls back to 'products'. Delete InventoryScreen.tsx. Replace workItems/adminItems and the old groups with one `const groups: NavGroup[] = [{label: t('nav.work'), items: [...]}, {label: t('nav.catalogue'), ...}, {label: t('nav.master.admin'), ...}, {label: t('nav.system'), ...}].map((group) => ({ ...group, items: nest(group.items) }))`, items in the interfaces order. Chatroom, Printroom and Reports items are gated on canViewChat, canViewPrint and canViewReports from their domains, with counts. Landing: `const landing = user ? landingScreen(user.roleTier) : 'basicHome'`. setTab(landingScreen(me.user.roleTier)) on the boot restore and in onSignedIn; signOut/onSessionEnded reset to 'basicHome'; shownTab fallback is `landing`; pass homeId={landing} to AppShell. Add a ScreenSpec {id:'basicHome', render: () => <BasicHome groups={groups} onOpen={navigate} onNewLead={canCreateLead ? openNewLead : undefined}/>}. Topbar uses <TopbarTitle groups activeId fallback={activeLabel}/>. Footer: a companyName state set from api.setupStatus() at boot, rendered before the avatar. Switch these screen imports to lazyScreen: Logs, RecycleBin, Integrations, Fields, Access, PartyAccess, Panels, Updates, Reports, Conflicts, Settings. DashboardScreen gets the extra props printPending/chatUnread from those domains. api.ts: delete stockMovements, stockInbound, stockAdjust and setReorderLevel (keep stock); setupStatus type adds companyName. main.tsx: defaultTheme 'light', themeStorageKey 'ob.theme.v3'. index.html: data-theme='light', inline color-scheme removed. SettingsScreen: filter out MASTER_HIDDEN_SETTINGS = new Set(['inventory.defaultReorderLevel','inventory.adjustmentNoteRequired']) in the company-group renderer.

### 8. Master Dashboard refresh and server figures

Files: `master/web/src/screens/DashboardScreen.tsx`, `master/src/services/dashboard.service.ts`, `master/src/repositories/dashboard.repository.ts`, `shared/src/domain/entities.ts`, `office/src/http/app.ts`, `master/src/http/routes/setup.routes.ts`

entities.ts: add the optional convertedTodayCount and dispatchedTodayCount. dashboard.repository: generalise dispatchedThisWeek to dispatchedSince(unit) (keep the old name as a thin call or update its one caller) and add convertedToday (orders.created_at >= date_trunc('day', now() AT TIME ZONE tz) AT TIME ZONE tz, party-scoped). dashboard.service: compute both under canOrders. office app.ts: add both keys to DASHBOARD_FIGURE_PERMISSIONS as 'orders.view'. DashboardScreen: replace StatCard/StatSkeleton with StatTile/StatTileSkeleton; remove the low-stock tile; add Converted today, Dispatched today, Follow-ups due, Offline over an hour (panels with !isConnected && lastSeenAt older than 3_600_000 ms, under canManagePanels), Print jobs pending and Unread chat (rendered only when the prop is defined). setup.routes /status: add companyName. Keep the Office DashboardScreen's figures; only swap its StatCard for StatTile.

### 9. Office shell: Basic Home, landing, groups, idToTab, device code, lazy screens

Files: `office/web/src/App.tsx`, `office/web/src/api.ts`, `office/src/http/app.ts`, `office/web/src/screens/SignInScreen.tsx`, `office/web/src/screens/ConnectionScreen.tsx`, `office/web/src/screens/DashboardScreen.tsx`

Tab union: add 'basicHome', 'chatroom', 'printroom', 'reports'. Groups: Work starts with {id:'basicHome', icon:'home'}, then dashboard, leads, orders, conflicts, chatroom, printroom, reports (domain-gated); Catalogue and System as today. idToTab adds the four ids. Landing: in the boot effect, after setSession(restored) call setTab(landingScreen(restored.roleTier)) when restored is non-null (NOT in refreshSession, which runs on every reconnect). onSignedIn calls setTab(landingScreen(next.roleTier)); signOut and onSessionEnded reset to 'basicHome'; homeId={session ? landingScreen(session.roleTier) : 'basicHome'}. alwaysAvailable gains {id:'basicHome', render: () => <BasicHome groups={groups} onOpen={goToTab} onNewLead={can('leads.create') ? openNewLead : undefined}/>}. The topbar uses TopbarTitle. ConflictsScreen, PartyAccessScreen, SettingsScreen and UpdatesScreen load through lazyScreen. Server: GET /api/connection adds `deviceCode: await deviceCode()` (import from ../sync/device.js). api.ts: ConnectionInfo.deviceCode?: string. SignInScreen and ConnectionScreen render the code row (i18n signin.deviceCode, connection.deviceCodeProvisional).

### 10. Kanban column cap

Files: `ui/src/KanbanBoard.tsx`

Add a per-column `expanded` Set state. Render inStage.slice(0, expanded.has(stage.id) ? undefined : COLUMN_CAP=60), then a ghost button t('kanban.showMore', {count: inStage.length - 60}) that expands the column. Header counts stay the full length. Drag and drop is unchanged.

### 11. Electron and server memory and crash hardening

Files: `electron/lib/memory.ts`, `electron/shell.ts`, `electron/lib/log-file.ts`, `master/src/db/postgres-server.ts`, `master/src/index.ts`, `office/src/index.ts`, `master/src/realtime/hub.ts`

memory.ts: serverHeapMb(totalMb, panel) = clamp(round(cap*0.7), floor, 4096) with cap = total*(office 0.4 | master 0.6) and floor = panel === 'office' && totalMb <= 4608 ? 1024 : 2048; rendererHeapFlag(totalMb) = totalMb <= 4608 ? '--max-old-space-size=1024' : null. shell.ts: use serverHeapMb in startServer; before app.whenReady, `const flag = rendererHeapFlag(...); if (flag) app.commandLine.appendSwitch('js-flags', flag)`; render-process-gone allows a reload when the last reload was more than 5 minutes ago (timestamp instead of a boolean); BrowserWindow backgroundColor '#f2f4f5'. log-file.ts: count bytes written; past MAX_BYTES, end the stream, rotate(file), reopen (try/catch, never throws). postgres-server.ts: export pgMemoryOptions(totalMb) and push its -c flags into serverOptions; before spawning pg_ctl, rename postgres.log to postgres.log.1 if it is over 5 MB (try/catch). master/office index.ts: process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason)). hub.ts: correct the comment at ~1090.

### 12. i18n strings in en.ts

Files: `shared/src/i18n/en.ts`

Add nav.basicHome 'Basic Home', nav.chatroom 'Chatroom', nav.printroom 'Printroom', nav.reports 'Reports', common.loading 'Loading…', basicHome.newLead 'New pending order', signin.deviceCode 'Device code', connection.deviceCodeProvisional 'Provisional — the Master assigns the final code when this PC pairs', dashboard.stat.convertedToday, dashboard.stat.dispatchedToday, dashboard.stat.followUpsDue, dashboard.stat.panelsStale ('Offline over an hour'), dashboard.stat.printPending, dashboard.stat.chatUnread (with .one/.other notes where counted), kanban.showMore '{count} more'. Change nav.home to 'Go to your home screen'. Delete nav.master.work, nav.master.inventory and nav.master.reports from en.ts. No TODO stubs, no 3+ digit runs, no price words.

### 13. Tests and guards

Files: `shared/tests/keys-nav-order.test.ts`, `shared/tests/keys.test.ts`, `ui/tests/master-shell.test.tsx`, `ui/tests/office-shell.test.tsx`, `ui/tests/inventory-stock-race.test.tsx`, `ui/tests/inventory-movement-form.test.tsx`, `master/tests/screen-reachability.test.ts`, `master/tests/web-reachability.test.ts`, `ui/tests/screen-host.test.tsx`, `ui/tests/app-shell-nav.test.tsx`

See the tests field for each change; run lint, typecheck and the full test suite, then a real Electron pass on both panels at 1024x768 and at 79%/157% scale, in light and dark.

### 14. Docs

Files: `docs/STRUCTURE.md`, `HANDOFF.md`, `docs/UI_REDESIGN.md`, `docs/AI_COLLABORATION.md`

STRUCTURE §3.8: new COMMANDS count, the chord map table and the explicit-chord tuple. §4.2: ScreenHost LRU/freeze/Suspense, AppShell homeId/TopProgress/TopbarTitle, the new BasicHome/TopProgress/StatTile modules. §7.2/§9.2: groups, landing and Basic Home. §7.4: InventoryScreen removed, and the sidebar inventory row dropped from the nav table (line ~3028). §10.1: memory budget and log rotation. HANDOFF: replace the 'Master shortcuts moved' item with the new map (a release-notes line: Alt digits moved on both panels, Master theme reset to light), list Inventory UI hidden with the server still running, and add the low-RAM changes. UI_REDESIGN: record the owner's override of 'busy mark is the only mover' (TopProgress + ProgressBar) and the Master light default. AI_COLLABORATION: update its chord mentions.

## tests

- shared/tests/keys-nav-order.test.ts: the Master now slices between('const groups: NavGroup[] = [', '].map((group)') exactly like the Office (the workItems/adminItems markers are gone because the Master sidebar is now one literal). Add an assertion that both panels' chord maps agree for the shared ids (basicHome..settings).
- shared/tests/keys.test.ts: the office nav test changes to office[4].tab === 'conflicts', navOrder [1..13], office[8] is settings with Alt+9, office[0] is basicHome with Alt+1, and chatroom/printroom have Alt+C/Alt+P with no darwin override. New case: an entry with an explicit chord does not consume an Alt digit. 'ships no conflicting defaults' must stay green (it covers Alt+C/P).
- ui/tests/master-shell.test.tsx: Alt digits shift (Pending = 3, Final = 4, Products = 6, Dashboard = 2); line 254's pressAltDigitUntil(9, panels) becomes a sidebar click or palette open, since Panels has no chord. Delete 'Inventory refetches after a catalogue import' (371-380) and describe('Inventory') (1005-1022); drop 'inventory.view' from the fixture permissions if unused. Keep the admin fixture landing on nav.master.dashboard. New: a management-tier fixture lands on nav.basicHome; Basic Home tiles equal the sidebar's top-level ids; the brand button goes to the landing screen; footer shows the company from setupStatus; Theme defaults to light only in main.tsx (the harness keeps its own configureUi).
- ui/tests/office-shell.test.tsx: the office-tier fixture now lands on Basic Home, so line 463 expects t('nav.basicHome'), and tests that assumed Dashboard on sign-in first press Alt+2 or click the Dashboard tile. pressAltDigitUntil(3, orders) becomes 4, and pressAltDigit(2) becomes 3. New: Basic Home renders before the first snapshot (alwaysAvailable); the 'New pending order' tile is absent without leads.create; the device code shows on SignInScreen when connection.deviceCode is set; reconnect (refreshSession) does NOT move the tab.
- Delete ui/tests/inventory-stock-race.test.tsx and ui/tests/inventory-movement-form.test.tsx (they dynamically import the deleted InventoryScreen).
- master/tests/screen-reachability.test.ts: delete PANEL_ONLY.inventory (its 'no stale reasons' check enforces this). basicHome, chatroom and printroom are on both panels and in both sidebars, so they need no entry. PANEL_ONLY.reports goes when the reports domain adds the Office screen.
- master/tests/web-reachability.test.ts: the Office idToTab must contain basicHome, chatroom, printroom and reports. The deleted Master api members need no ALLOWED_UNCALLED entries. Check that no stale entries remain.
- ui/tests/screen-host.test.tsx: new cases: (a) the oldest unpinned screen is evicted past the cap (stub navigator.deviceMemory = 4); (b) a screen with a SubNav entry survives eviction; (c) a hidden screen's render is not called when the host re-renders with new closures; (d) a lazyScreen shows LoadingMark and then the screen. The existing 'renders the first visit in the same frame' case must stay green (eager screens never suspend).
- ui/tests/app-shell-nav.test.tsx: keep 'sends the brand mark to the dashboard' (the default homeId), and add a homeId='basicHome' case and a TopbarTitle group-eyebrow case.
- New ui/tests/basic-home.test.tsx: tiles follow the given groups (absent, not disabled); chips come from bindings, and a user-cleared binding hides its chip; count badges render; the empty groups case shows shell.noModules; landingScreen maps office/management to basicHome and admin, server_master and unknown tiers to dashboard.
- New ui/tests/top-progress.test.tsx (fake timers): no strip before 300 ms; strip while a tracked promise is pending past 300 ms; hidden after it settles; ProgressBar aria-valuenow.
- New electron/tests/memory.test.ts: serverHeapMb for master/office at 3, 4, 8 and 64 GB; rendererHeapFlag null above 4.5 GB. New electron/tests/log-file.test.ts: rotates while running once MAX_BYTES is crossed, and never throws when the rename fails.
- New master/tests/postgres-memory.test.ts: pgMemoryOptions small/large outputs, and max_connections >= the knex pool max (10) + 10.
- master/tests/dashboard.integration.test.ts: add convertedTodayCount/dispatchedTodayCount figures and their party scope. office/tests/dashboard-staleness.test.ts should stay green, plus a filter case for the two new keys.
- ui/tests/office-shell.test.tsx and ui/tests/master-shell.test.tsx: printPage expectations are untouched (printing is another domain).
- Guards that must stay green and are respected by this design: ui-conventions (rem, no raw px > 3 in JSX styles), no-duplicate-ui (barrel lines for BasicHome, TopProgress, StatTile), no-transport-dep (BasicHome takes no transport), keys-implemented (every nav command has a `tab`), i18n-coverage (digits/price bans), i18n-call-sites, tooling-config (the swept eslint list names real files), wire-optionality (all new wire fields optional), web-catalogue-text (no literal English).

## docs

- docs/STRUCTURE.md §3.8 keys (COMMANDS count, chord map, explicit-chord tuple), §4 ui kit (BasicHome, TopProgress, StatTile, ScreenHost LRU/freeze/Suspense, AppShell homeId/TopbarTitle), §7.2/§7.4 Master shell and screens (groups, landing, Inventory removed, Dashboard tiles), §9.2 Office shell (Basic Home, device code), §10.1 electron (memory budget, log rotation), §6 postgres launcher options
- HANDOFF.md: replace 'Master shortcuts moved' with the new identical chord map for both panels; note the Master theme reset to light (ob.theme.v3); Inventory UI hidden with server stock still running; low-RAM measures and what was deliberately skipped (manualChunks, pager cap, snapshot diff)
- docs/UI_REDESIGN.md: owner override of 'the busy mark is the only mover' (TopProgress + ProgressBar, motion/blur/reduced-motion behaviour); Master light default; Basic Home tile spec (sizes, tokens, hue map)
- docs/AI_COLLABORATION.md: correct its chord references

## risks

- Nav churn collides with the Chatroom, Printroom and Reports domains: all three add rows to the same groups literals. Mitigation: this domain lands the final groups and MASTER_NAV/OFFICE_NAV shape first, with those rows gated on booleans defaulting to false. Each domain then only flips its boolean, supplies the ScreenSpec and adds its idToTab/Tab member, with no reordering.
- Every Alt digit moves on both panels (Master Panels loses Alt+9, Reports loses Alt+8, Office Dashboard goes Alt+1 to Alt+2). User-remapped bindings keyed by command id survive. Defaults change, so this needs a release-note line.
- Lazy screens make the first visit async. Shell tests that use getBy right after opening Settings/Logs/etc. must move to findBy. A stale LAN browser tab after a Master update could fail a chunk load; it reloads once (sessionStorage guard) and then the ErrorBoundary shows.
- LRU eviction remounts a screen the user left more than N screens ago, losing filters and scroll on that screen only. Drafts and open records are pinned through the SubNav registry and 'addLead'. A screen holding unsaved state without publishing a SubNav entry would lose it; audit Settings/Fields editors and pin any that hold drafts.
- The frozen hidden screens rely on effects being torn down while hidden (Activity) and on props catching up at reveal. A screen that expects props to change while hidden (none found) would show stale data for one frame.
- The theme key bump resets a deliberate dark choice on existing Masters once.
- The renderer heap cap (1024 MB on PCs with 4.5 GB or less) turns a pathological leak into a renderer crash instead of swapping. The 5-minute reload window recovers, but a leak would loop; this is logged as 'Renderer gone'.
- The lower Office server heap floor (1024 MB) on 4 GB PCs: if the Office ever buffers a large upload (product import with images), it could hit the ceiling sooner. The Master keeps 2048.
- pg tuning applies only on a fresh start (an already-running cluster keeps its settings). max_connections=30 must stay above the pool max (10) plus test, migrate and backup connections; this is guarded by the new unit test.
- Hiding the Master Inventory UI leaves stock that nobody can zero from the UI: products with on-hand stock can still never be deleted ('stock_on_hand'), and only the public API, which is off by default, can adjust it. The owner accepted option (i); worth one line in HANDOFF.
- jsdom cannot verify the tile visuals, gradient tokens, light/dark contrast or the 1024x768 fit. A real Electron pass on both panels is required (HANDOFF rule).

## dependsOn

- Chatroom domain: supplies canViewChat (its view permission), the unread total (NavItem.count and the Dashboard chatUnread prop), a ChatroomScreen ScreenSpec for both shells, and `chatroom` in the Tab union and Office idToTab. This domain provides the 'chat' icon, nav.chatroom, the Alt+C command and the Work-group slot.
- Printroom domain: supplies canViewPrint, the pending job count (badge and Dashboard printPending), the PrintroomScreen ScreenSpec and the Tab/idToTab member. This domain provides the 'print' icon, nav.printroom, Alt+P and the slot. Its determinate print progress can use ProgressBar.
- Reports domain: supplies canViewReports per panel (reports.view AND the per-tier company setting, with admin and server_master always true), the Office ReportsScreen, removal of PANEL_ONLY.reports, and the ReportsScreen StatCard swap to StatTile. This domain provides nav.reports, the 'report' icon and the slot. Exports should use ProgressBar.
- Roles/Server Master domain: the 'server_master' tier value (landingScreen sends it to Dashboard), the Server Master badge in the footer, the Users list and presence, and first-run changes to /api/setup/status. This domain only adds companyName to that response.
- Backup/import-export domains: use ProgressBar (determinate) and trackLoad for long operations; backup restore memory, since the Master server heap floor stays 2048 MB because restore buffers in memory.
- Sync/notifications domain: the 'offline > 1 h' notification is theirs; this domain only shows the Dashboard tile computed from panels.lastSeenAt.
- Windows 7 legacy Office build: everything here uses Chromium-108-safe APIs (useSyncExternalStore, React.lazy, navigator.deviceMemory, CSS without :has). app.commandLine.appendSwitch and the memory helpers run on Electron 22 / Node 16. The AbortSignal.any fix in api.ts is that domain's; trackLoad wraps request() and does not touch it.
- Shared files touched by several domains: master/web/src/App.tsx, office/web/src/App.tsx, shared/src/keys/commands.ts, shared/src/i18n/en.ts, ui/src/index.ts, ui/src/icons.tsx, docs/STRUCTURE.md, HANDOFF.md.

## openQuestions

- Chatroom = Alt+C and Printroom = Alt+P on both panels (the Ctrl+Shift+M/P alternatives are browser-reserved chords in a LAN browser). Is that acceptable, or does the owner want different keys?
- On the Master, Party access moves from the Admin group to Catalogue to match the Office mockup, and Panels, Roles & users and the other Admin screens lose their Alt digits so both panels share one chord map. OK?

## effort

About 40 files touched, plus 5 new modules (ui BasicHome, TopProgress, StatTile; electron/lib/memory.ts; new tests). Roughly +1,400 LOC new or changed, and about -1,600 LOC deleted (InventoryScreen.tsx at 1,255 lines plus its two tests and three StatCard copies). About 160 new i18n keys in en.ts. Two to three implementation sessions, plus one real-Electron verification pass on both panels (1024x768 and 4K, 79% and 157% scale, light and dark).
