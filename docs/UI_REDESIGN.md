# UI redesign — plan

Status: **planning only, nothing built yet.** This is the working document for porting the
supplied Claude Design UI system onto OrderBook's two real frontends. Update it as phases land,
the same way `docs/LEAD_GENERATION_FLOW.md` and `docs/ROLES_AND_USERS.md` track their modules.

Source material (outside the repo, on the owner's Desktop —
`C:\Users\Z\Desktop\OrderBook UI design\`):

- `6-UI-DESIGN.md` — the design system spec: tokens, typography, spacing/shape/elevation/motion,
  the presence rail, layout shells, the component inventory, density/a11y/language rules, the
  performance budget, and the UI gates.
- 16 `*.dc.html` files — rendered mockups built in Claude Design (a `<x-dc>`/`sc-for`/`sc-if`
  templating format, not real React). Every one carries **placeholder data** ("Party 4",
  "Product A", `₹76,400`) — per the owner's instruction, these are implemented as components and
  wired to real data, the placeholder values are not copied in anywhere.

Like the lead-generation and roles guides before it, this design was written for a slightly
different product shape than the one that exists here — §4 lists every place the two disagree, the
same way those docs' final sections did.

---

## 1. Non-negotiables that already match this repo

The design spec's §2 rules are not new constraints — they restate decisions already made for
OrderBook, so there's no conflict to resolve, only implementation:

- **No network at runtime, fonts and icons included.** OrderBook is LAN-only by design (`HANDOFF.md`);
  both `vite.config.ts` files already forbid reaching a CDN. The mockups' `<link
  href="https://fonts.googleapis.com/...">` tags are a Claude Design preview convenience, not part
  of the deliverable — the real build self-hosts Inter, IBM Plex Mono and Noto Sans Devanagari as
  local `.woff2` files with local `@font-face`, and the CI gate (§8 below) asserts a cold run makes
  zero requests.
- **Plain CSS + custom properties, no CSS-in-JS, no animation library.** Matches current
  `styles.css` (already plain CSS) and the fact that neither app has a single runtime-style
  dependency today.
- **The design floor is 1366×768, no mobile layout.** Matches the existing "shop-PC" target
  hardware assumption.

---

## 2. Current state (frontends)

Full detail gathered from the two apps; summary here, see git history / the apps themselves for
specifics.

- **Two independent Vite + React 18 + TS apps**, `master/web` and `office/web`, no shared UI
  package. Each has its own `styles.css` (592 / 469 lines) built around 9 flat CSS variables — no
  spacing scale, no typography scale, no dark mode, no density system.
- **No router in either app.** Screen switching is a local `useState<Tab>` in `App.tsx` with a
  horizontal row of `TabButton`s — no sidebar exists anywhere today.
- **No component library.** Every screen hand-styles raw `<input>`/`<button>`/`<table>` via global
  class selectors. `Field.tsx` and `format.ts` are duplicated byte-for-byte between the two apps.
- **No fonts, no icon system.** Body font is the system stack; no `.woff2` files, no icon package,
  no SVG sprite anywhere in the repo.
- **State**: no Redux/Zustand/Context/React Query — per-screen `useEffect` + `useState`, with a
  manually bumped `dataRevision`/`view` counter for cross-screen invalidation. Office's realtime
  transport is a raw `EventSource`; Master's is `socket.io-client`.
- **`master/web` screens** (all real, all wired to live data): Dashboard, Office Panels,
  Leads & Orders (read-only), Inventory, Access (Roles & Users — 903 lines, the largest screen in
  either app), Conflicts, Settings, Sign-in, First-run.
- **`office/web` screens**: Sign-in, Connection/pairing, Add Lead (658 lines), Lead Board, Lead
  Detail, Order Board, Catalog (serves both Parties and Products via a `tab` prop), Conflicts.
- Existing reusable pieces worth carrying forward rather than rebuilding from zero:
  `KanbanBoard.tsx`, `ColourQuantities.tsx`, `StockCell.tsx`, `SyncStatus.tsx`,
  `PermissionGrid.tsx`, `SearchBox.tsx`, `CustomFields.tsx`. These get **restyled**, not replaced —
  their data logic already works.

---

## 3. What "update current UI with this new design system" means here

Two different kinds of work are tangled together in the 16 mockups, and they need to be pulled
apart before anything is built:

1. **Restyling screens that already exist and work.** Tokens, typography, spacing, the new
   AppShell/Sidebar/Topbar/StatusFooter/PresenceRail, DataTable, drawers instead of whatever ad hoc
   layout is there now — same data, same behaviour, new look. This is the literal ask and is
   entirely frontend-only, zero backend risk.
2. **Screens the mockups show that don't exist in the product yet** — Fields management, Logs,
   Recycle Bin, a Dashboard on the Office side, Reports, PDF Designer. Some of these have a real API
   to bind to already; some don't. Building their UI without a backend behind it would mean
   inventing data, which is exactly what was ruled out. So each of these gets a backend-readiness
   check *before* any component work, and ships only once real data exists — see §6.

§7 is the phased plan that keeps these two kinds of work from blocking each other: all of (1) can
proceed immediately after the foundation lands; each item in (2) unblocks independently as its
backend piece is ready.

---

## 4. Where the supplied design disagrees with the real product

1. **The mockups assume a single unified shell** (one sidebar with Work / Catalogue / Output /
   Admin groups, 13 modules) used by one kind of user. The real product is **two separate apps with
   different owners and different users**: `master/web` is the admin console the shop owner/manager
   runs (owns the database, manages roles, inventory, panels); `office/web` is the thin sales
   client staff use on the floor (leads, orders, catalogue, no admin surface). The design's own
   "Master Panel: headless, do not build one" assumption doesn't hold here — Master already has a
   full UI and keeps it. **Decision made for this plan**: apply one shared token/component system
   to both apps, but split the 13 modules across the two real apps by who already owns that data
   (table in §5), rather than building one 13-module shell. Confirm this split reads right before
   Phase 2 starts.
2. **No mockup exists for four screens that are real and must be restyled anyway**: Sign-in,
   First-run, Office Panels (pairing/panel list), and Conflicts. These get the same tokens and
   primitives as everything else, composed from the supplied component inventory (Card, DataTable,
   Badge/StatusPill, Drawer) rather than a literal reference screen. Flag if the owner wants to sketch
   these before they're built.
3. **Orders is a table in the mockup, a Kanban board in the real product** (`OrderBoardScreen.tsx`
   uses the same `KanbanBoard` as leads). Leads staying Kanban and Orders becoming a table is a
   genuine behaviour change, not just a restyle — confirm before Phase 2 touches Orders. Recommendation:
   keep it as-is for now (table view per mockup, since dispatch/stage tracking reads better as a
   sortable list) but this is the one place in Phase 2 that isn't a pure reskin.
4. **§11 non-negotiable #6 — "every user-facing string goes through `t()`."** Neither app has any
   i18n layer today; every string is a literal. Adopting this literally means touching every line of
   JSX across ~4,000 lines of screens, which is a project on its own, separate from a visual
   redesign. **Recommendation**: treat this as out of scope for the redesign itself. New components
   built during this work should still take strings as props/children rather than hard-coding them
   three levels deep, so a `t()` pass later is mechanical, but no translation layer ships as part of
   this plan. Flag if this should be pulled in as its own follow-up.
5. **Global keys** `/`, `Ctrl+K`, `Ctrl+N`, `Ctrl+S`, `Esc` — `/`-to-search and `Esc`-to-close
   already exist in a few screens; `Ctrl+K` command palette and `Ctrl+N` do not exist anywhere and
   are a new feature, not a restyle. Included in Phase 2 foundation as a small addition since the
   Sidebar/Topbar work touches the same global key-listener code anyway; scoped down to `/`, `Esc`,
   `Ctrl+S` (already-needed patterns) with `Ctrl+K`/`Ctrl+N` left for later unless requested.
6. **Density and theme "toggle" buttons that appear on every mockup screen.** These are a Claude
   Design preview affordance (so a reviewer can flip light/dark per screen) — not a real per-screen
   control. In the real build, theme and density live once, in Settings, exactly as §10 of the
   design spec describes ("per-machine, never synced").
7. **The "Demo — set connection state" buttons in every presence-rail popover** are preview-only.
   The real presence rail reflects actual sync state from the existing `SyncStatus`/`dataRevision`
   plumbing — no manual override control ships.
8. **The presence rail's meaning differs between the two apps.** For Office, "offline" is real —
   it's a thin client that can lose its link to Master, and the existing `SyncStatus.tsx` already
   tracks pending/offline/conflict. Master *is* the server; it cannot be "offline" from itself.
   **Recommendation**: Master's rail instead reflects an aggregate across its Office Panels — pending
   panel changes, panels currently unreachable, or open sync conflicts (all of which Master already
   tracks) — rather than showing "Synced" as an inert constant. Confirm before Phase 2 reaches
   `master/web`'s shell.
9. **The design's "Developer Panel" (permanently dark chrome) doesn't exist as a third app.**
   Optional idea worth a yes/no: give `master/web`'s shell the same permanently-dark treatment so
   it's unmistakable at a glance from `office/web` when both are open on a desk, at zero token cost.
   Not assumed — ask before adopting.
10. **Fields management's colour values need a hex.** The design's Fields screen edits colour swatches
    with an optional hex; whether the existing `optionLists`/`customFields` API already stores a hex
    per colour value or only a name needs checking against the real schema before that screen is
    built (§6).

---

## 5. Screen-by-screen mapping

| Mockup | Real app | Existing screen it restyles | Backend ready? |
|---|---|---|---|
| `Leads.dc.html` | `office/web` | `LeadBoardScreen.tsx` + `LeadDetail.tsx` (Kanban via `KanbanBoard.tsx`) | Yes |
| `New-Lead.dc.html` | `office/web` | `AddLeadScreen.tsx` | Yes |
| `New-Party.dc.html` | `office/web` | inline party creation inside `CatalogScreen.tsx` / `AddLeadScreen.tsx` → becomes its own drawer/screen | Yes |
| `Orders.dc.html` | `office/web` | `OrderBoardScreen.tsx` (Kanban → table; see §4.3) | Yes |
| `Products.dc.html` | `office/web` | `CatalogScreen.tsx` (`tab="products"`) | Yes (verify rate-redaction wiring) |
| `Parties.dc.html` | `office/web` | `CatalogScreen.tsx` (`tab="parties"`) | Yes |
| `Inventory.dc.html` | `master/web` | `InventoryScreen.tsx` | Yes |
| `Roles.dc.html` | `master/web` | `AccessScreen.tsx` (903 lines — biggest single restyle) | Yes |
| `Settings.dc.html` | Both | `SettingsScreen.tsx` (master); net-new on office | Device/pairing info yes; theme/density/motion is new local-only state |
| `Dashboard.dc.html` | Both, different content | `DashboardScreen.tsx` (master, restyle with master-appropriate cards); **net new on office** | Master: yes. Office: check `snapshot()` covers pipeline/low-stock/recent-activity, or add a small aggregate endpoint |
| `Fields.dc.html` | `master/web` (admin-only, new nav entry) | none | Partial — `optionLists`/`customFields`/`pipelines` APIs exist; verify colour-hex storage (§4.10) |
| `Logs.dc.html` | `master/web` (admin-only, new nav entry) | none | **No** — `activity-log.repository.ts` exists server-side with no HTTP route exposed |
| `Recycle-Bin.dc.html` | `master/web` (admin-only, new nav entry) | roles/users restore already inline in `AccessScreen.tsx` | **No** — no cross-entity soft-delete listing endpoint exists (explicitly listed as not built in `HANDOFF.md`) |
| `Reports.dc.html` | `master/web` | none | **No** — needs aggregation endpoints; explicitly deferred in `HANDOFF.md` |
| `PDF-Designer.dc.html` | `master/web` | none | **No** — explicitly "deliberately not built" per `docs/LEAD_GENERATION_FLOW.md` §11; largest single new feature implied by the mockups |
| `Loading.dc.html` | Both | n/a | Foundation-only — splash/busy-indicator/skeleton spec, not a screen |
| `Brand.dc.html` | Both (dev tooling) | n/a | Optional: adapt into a dev-only token-gallery route per design spec §12 step 1 |
| (none supplied) | `master/web` | Sign-in, First-run, Office Panels, Conflicts | restyled from the component inventory, no reference mockup (§4.2) |
| (none supplied) | `office/web` | Sign-in, Connection, Conflicts | same |

---

## 6. The "no dummy data" rule, applied per screen

- Every screen that restyles an existing real screen (§5, "Backend ready? Yes") binds to the
  existing `api.ts` calls it already uses today — component work only, no new endpoints.
- Screens with **no backend yet** (Logs, Recycle Bin, Reports, PDF Designer, and Fields pending the
  hex check) do not get built as static/placeholder UI. Each one's backend piece is scoped and
  built first (small, in the case of Logs and Fields; larger for Recycle Bin and Reports; largest
  for PDF Designer), and the screen ships against real data or not at all.
- Where a real screen legitimately has nothing to show yet (e.g. an empty leads pipeline, a
  first-launch inventory with no stock movements), that's exactly what the design system's own
  `EmptyState`/`ErrorState` components are for — "No leads yet" with one action, never fabricated
  rows.

---

## 7. Package & tooling plan

**New workspace: `ui/`** (`@orderbook/ui`), added alongside `shared/`, `master/`, `office/` in the
root `package.json` workspaces list. Holds everything neither app should keep duplicating:
`tokens.css`, `reset.css`, self-hosted font files, the logo/mark SVG + splash/busy-indicator
components, the icon set, and every primitive/structure/data component from the design spec's §9
inventory (Button, Input, Select, Combobox, Checkbox/Radio/Switch, Card, Tabs, Drawer, Modal,
Popover, Tooltip, Toast, DataTable, KanbanBoard, ColourQuantityGrid, ColourChip, StatusPill,
Timeline, PermissionGrid, IdField, FingerprintField, CursorPager, Skeleton, EmptyState, ErrorState,
ConflictBanner, OfflineBanner, AppShell, Sidebar, Topbar, FilterBar, StatusFooter, PresenceRail).

**Deliberately not compiled like `shared/`.** `shared/` has to ship compiled JS because Node
(the Master/Office servers) import it directly. `ui/` is only ever imported by the two Vite
frontends, so Vite can transpile its TSX from workspace source with no separate build step —
skipping the `prepare`/`pre*` trap `shared/` has (`HANDOFF.md`: "consumed as compiled output, not
source"). Each app's `vite.config.ts` gets a path alias/workspace reference to `ui/src`; no new
`tsc -b` project reference needed unless the type-check step wants one for editor support.

**Fonts.** Inter (variable), IBM Plex Mono, Noto Sans Devanagari (variable) — all OFL-licensed,
sourced from their official repositories at implementation time and checked into
`ui/assets/fonts/`, then copied into each app's `public/fonts/` (neither app has a `public/`
directory today; both need one) so they load from disk with `font-display: block`, per §4 of the
design spec.

**Icons.** The mockups already draw every nav/UI icon as an inline SVG `path` string (see each
screen's `icons` map) — these get pulled into one hand-picked sprite/`Icon` component in `ui/`,
per the "no icon package" rule in §11 of the design spec.

**Routing.** Recommend **not** adding a router. The design's drawer-not-route pattern for detail
screens and the existing tab-`useState` pattern both work without one; adding `react-router` would
be a second, unrelated architecture change riding along with the redesign. Revisit only if
deep-linking or the `Ctrl+K` command palette (§4.5) is prioritized later.

---

## 8. Phased build plan

Ordering follows the design spec's own §12 build order, adapted to hit the highest-value, lowest-risk
work first and keep backend-blocked screens from stalling the rest.

### Phase 1 — Foundation (`ui/` package, no screens touched yet)
1. `tokens.css` + `reset.css` + self-hosted fonts; light/dark ramps; a dev-only token-gallery route
   (optional, adapted from `Brand.dc.html`).
2. Logo mark, splash sequence, busy indicator (`Loading.dc.html`) — one asset, reused everywhere a
   spinner would otherwise be needed.
3. Foundation form components with every state (default/hover/active/focus-visible/disabled/loading/error):
   Button, IconButton, Input, NumberInput, Select, Combobox, Checkbox, Radio, Switch, Textarea,
   DateField, Label, HelperText, FieldError.
4. AppShell, Sidebar (collapsible, grouped), Topbar, StatusFooter, PresenceRail (wired to each
   app's real sync state per §4.8), FilterBar.
5. Structure/feedback: Card, Section, Tabs, Drawer, Modal, Popover, Tooltip, Toast.
6. Data components: DataTable, CursorPager, Skeleton, EmptyState, ErrorState, ColourChip,
   StatusPill, Timeline, IdField, FingerprintField, ConflictBanner, OfflineBanner.
7. Dark theme, density (compact/comfortable/large), and `data-motion="off"` — all driven by
   localStorage, wired once at the shell level so no downstream component needs to know density
   exists (per design spec §10).

### Phase 2 — Reskin existing screens (no new backend, no behaviour change except §4.3)
Order chosen so the highest-traffic, most representative screen goes first and sets the pattern
every other screen copies, same rationale the design spec gives for doing Leads first:

1. `office/web`: Add Lead + Lead Board + Lead Detail (`Leads.dc.html`, `New-Lead.dc.html`) —
   restyle onto `ColourQuantityGrid`, `Drawer`, `DataTable`/board hybrid.
2. `office/web`: Order Board → table (`Orders.dc.html`, behaviour change per §4.3, confirm first).
3. `office/web`: Catalog → Products + Parties + New Party (`Products.dc.html`, `Parties.dc.html`,
   `New-Party.dc.html`).
4. `master/web`: Inventory (`Inventory.dc.html`).
5. `master/web`: Access → Roles & Users (`Roles.dc.html`) — care taken not to regress tier-ceiling,
   password-reset, or restore flows while reskinning the largest screen in the codebase.
6. Both apps: Settings (`Settings.dc.html`), plus the un-mocked screens (Sign-in, First-run, Office
   Panels, Conflicts) composed from the same component set per §4.2.
7. `office/web`: new Dashboard (`Dashboard.dc.html`, Office-appropriate content).
8. `master/web`: reskin its existing Dashboard with master-appropriate cards (panels online,
   storage, aggregate sync health per §4.8) rather than the mockup's literal Office-flavoured tiles.

### Phase 3 — New screens, backend-gated (each unblocks independently)
Rough order by effort, smallest first:

1. **Fields** — verify/extend `optionLists` for colour hex, then build `Fields.dc.html`.
2. **Logs** — add a paginated `GET` over `activity_log` (already hash-chained server-side, just
   not exposed), then build `Logs.dc.html`.
3. **Recycle Bin** — design and add a cross-entity soft-delete listing endpoint (leads, parties,
   products, roles, users), then build `Recycle-Bin.dc.html`, replacing `AccessScreen.tsx`'s inline
   restore with a link into the unified bin.
4. **Reports** — scope and build the aggregation endpoints (dispatches by month, lead outcomes,
   top parties) before `Reports.dc.html`.
5. **PDF Designer** — largest item; scope as its own mini-plan (template storage, real PDF
   rendering, the rate-redaction rule from §11) before any component work. Recommend sequencing
   this last and re-confirming it's wanted, since it was explicitly deferred once already.

### Phase 4 — Gates (design spec §13, adapted)
Run once Phases 1–2 are complete for a given app; re-run as Phase 3 items land:
- Tokens: no raw hex/px-font-size/ms outside `tokens.css`.
- Offline: cold start with the network adapter disabled makes zero requests (checked in DevTools).
- Scroll: 5,000-row `DataTable` at 60fps.
- Motion off: every `animation-duration`/`transition-duration` ≤ 1ms with `data-motion="off"` and
  with `prefers-reduced-motion`.
- Keyboard: a full lead with several line items enterable with no mouse.
- Density: all three densities render every screen at 1366×768, no clipping, no horizontal scroll.
- Contrast: every text-token pair ≥ 4.5:1 in both themes.
- **Not run**: the §13 "Strings" gate (no literal text outside `t()`) — out of scope per §4.4.

---

## 9. Open questions to confirm before/while implementing

1. §4.1 — confirm the module-to-app split (Fields/Logs/Recycle Bin/Reports/PDF Designer all landing
   on `master/web` as admin-only) reads right.
2. §4.3 — Orders as a table instead of Kanban: keep, or restyle the existing Kanban board instead?
3. §4.6/4.9 — want `master/web`'s chrome permanently dark to distinguish it from `office/web` at a
   glance? Zero token cost either way.
4. §4.8 — confirm Master's presence rail should show aggregate panel/conflict state rather than a
   static "Synced".
5. §4.4 — confirm the `t()`/i18n layer stays out of scope for this pass (recommended), rather than
   being pulled in as a prerequisite.
6. Phase 3 priority order — Fields → Logs → Recycle Bin → Reports → PDF Designer is a guess based on
   effort; confirm or reorder based on what's actually wanted next.
