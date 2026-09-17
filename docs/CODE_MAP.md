# Code map

Where everything is, and what each place is *for*. Read `HANDOFF.md` first for
what is true right now; this file is the layout, which changes far more slowly.

It exists because the repo is large enough (548 source files across six
workspaces) that "find the file that does X" is otherwise a search rather than a
lookup. If you add a directory, add a row here.

---

## The shape of the thing in one paragraph

Two Node servers, each serving its own React frontend on localhost, talking to
each other over a LAN with Socket.IO. **The Master owns the PostgreSQL database
and every file**; an Office Panel owns nothing durable but a queue. A staff
member saves a lead on an Office Panel, it lands in that panel's outbox and the
screen updates immediately; the outbox drains to the Master whenever the link is
up. Both panels are also wrapped in one Electron shell for the desktop build.
Everything is offline: no CDN, no internet call, ever.

## Workspaces

| Path | npm name | What lives here |
|---|---|---|
| `shared/` | `@orderbook/shared` | Types, the Socket.IO contract, the sync protocol, permissions, the i18n catalogue. Imported by everything; imports nothing of ours. |
| `ui/` | `@orderbook/ui` | The one React kit *and* the screens both panels render. Consumed as source, not as a build. |
| `master/` | `@orderbook/master` | The Master server. Owns the database. |
| `master/web/` | `@orderbook/master-web` | The Master's React frontend. |
| `office/` | `@orderbook/office` | An Office Panel's server. Owns the outbox and a snapshot cache. |
| `office/web/` | `@orderbook/office-web` | An Office Panel's React frontend. |
| `electron/` | — | One desktop shell; `master.main.ts` / `office.main.ts` are thin configs over `shell.ts`. |
| `tools/` | — | `release.mjs`, `i18n-sync.mjs`, `make-icons.mjs`, uninstall scripts, the custom eslint rules. |
| `docs/` | — | All prose. Nothing source-of-truth lives in a code comment. |

**`shared/` must be compiled before anything can import it.** The `prepare` and
`pre*` scripts do it; `npm run build:shared` does it by hand.

---

## `shared/src/` — the contract both sides obey

| Path | What it decides |
|---|---|
| `domain/entities.ts` | Every record shape (`Party`, `Product`, `Lead`, `Order`, …) and which fields are money. |
| `domain/inputs.ts` | Every write payload. If a form sends it, its type is here. |
| `domain/permissions.ts` | The permission catalogue and the **tier ceiling** (`office` / `management` / `admin`). |
| `domain/visibility.ts` | Masking on the way out, and `withPermittedRate` / `withPermittedPurchaseRate` on the way in. Three services share these. |
| `domain/columns.ts` | **The one column map.** `undefined` = not asserted, `null` = clear. Never add a second copy — see the trap in `HANDOFF.md`. |
| `domain/fields.ts` | The eight managed option-list sets. |
| `domain/settings.ts` | The nine company switches, each declaring its group, its control and its fallback. Adding one is an entry here plus two i18n tokens — **no migration**: the table is one row per key and an absent row means the fallback. |
| `domain/version.ts` | `ReleaseManifest`, `ReleasePlatform`, and version comparison. |
| `sync/mutations.ts` | The offline write envelope: `Mutation`, `MutationResult`, `MUTATION_PERMISSIONS`. |
| `sync/hlc.ts`, `sync/ids.ts` | Hybrid logical clocks; temporary vs permanent record ids. |
| `sync/merge.ts` | Field-level merge — what makes two panels editing one lead both keep their change. |
| `protocol/socket.ts` | Every Socket.IO event, both directions. The Master and both panels agree here or nowhere. |
| `protocol/discovery.ts` | The custom UDP broadcast protocol (not mDNS). |
| `i18n/en.ts`, `i18n/hi.ts` | The catalogue. `hi.ts` is a **total** record; `npm run i18n:sync` keeps it that way. |
| `i18n/errors.ts` | `errorMessageKey` — the coarse `error.<code>` tier between a specific key and English. |
| `i18n/panel-scoped.ts` | The keys stored twice, `master.*` and `office.*`. The resolver in `ui/` and the call-site guard both read this list — a second copy is how a key renders raw on screen with a green suite. |
| `keys/commands.ts` | The command registry the palette and the chords read. |

## `ui/src/` — the kit, and the screens both panels share

Everything is exported from one barrel (`index.ts`), and
`master/tests/no-duplicate-ui.test.ts` fails if a panel grows its own copy or if
a module escapes the barrel.

**Components:** `Button`, `Card`, `DataTable`, `Modal`, `Form`, `FieldGrid`,
`Input`/`Select`/`Textarea`, `Combobox`, `Picker`, `SuggestInput`, `Tabs`,
`Toast`, `Tooltip`, `Popover`, `StatusPill`, `Avatar`, `ProgressiveImage`,
`KanbanBoard`, `PermissionGrid`, `ImageCropModal`, `ConfirmDialog`.

**Whole screens that both panels render** (each takes a narrow `transport` prop
rather than a panel's api client — that is the rule):

- `NewLeadScreen.tsx` — the keyboard-first lead entry flow.
- `DocumentsScreen.tsx`, `PageDesigner*.tsx` — the PDF designer.
- `PartyFormModal.tsx` — create/edit a party.
- `SettingsLayout.tsx` — including the shared `AppearanceSettings`.
- `GalleryScreen.tsx` — the design-system gallery, reached only by `#/gallery`.

**Shell machinery:** `AppShell` (sidebar + topbar + panes), `ScreenHost` (keeps
screens mounted so filters and half-typed forms survive navigation),
`KeyboardProvider`, `FilterBarSlot`, `SubNavSlot`, `TopbarSlot`, `ResetSlot`.

**Styling:** `tokens.css` (every colour, size and z-index) and `base.css` (every
component rule). `theme.ts` owns the scale/density/motion knobs.
`master/tests/ui-conventions.test.ts` enforces the rem-vs-px rules.

## `master/src/` — clean architecture, in that order

```
http/ + realtime/   transport. Carries no policy.
      ↓
services/           orchestration: permissions, transactions, activity logging
      ↓
repositories/       Knex lives here and nowhere else
      ↓
db/                 connection, migrations, seeds
```

`domain/` sits beside all of it: **pure rules, no I/O**. A new invariant goes
there.

| Directory | Notes |
|---|---|
| `domain/` (28) | `actor.ts` (who is acting), `visibility.ts` re-exports, `party-scope.ts`, `stock-key.ts` (composite stock keys go through this — two inline builders once produced keys that never matched), `panel-report.ts`, `paging.ts`, the document model. |
| `services/` (44) | One per feature. The big ones: `sync.service.ts` (applying an outbox), `catalog.service.ts`, `lead.service.ts`, `order.service.ts`, `auth.service.ts`, `panel.service.ts`, `image.service.ts`, `snapshot.service.ts`. |
| `repositories/` (38) | Knex types never leave this directory. Cross-repo transactions pass the opaque `TransactionContext`. |
| `http/routes/` (20) | One file per surface. `public-api.routes.ts` is the off-by-default external API. |
| `http/middleware/` | `require-panel.ts` is the panel-credential boundary. |
| `realtime/hub.ts` | Every socket command. Long, and the one file where both panels' traffic meets. |
| `db/migrations/` | **Never delete or rewrite one.** Pinned by `migration-registry.test.ts`. A migration never imports a live constant. |
| `pdf/` | Rendering a document template to a PDF. |
| `discovery/` | The UDP responder. |

## `office/src/` — thin client, durable queue

| Path | What it does |
|---|---|
| `sync/outbox.store.ts` | The durable queue, plus the refusals the Master would not take. Temp-then-rename, never append. |
| `sync/sync.service.ts` | Draining the outbox to the Master. |
| `sync/local-store.ts` | The merged view: snapshot + outbox laid over it. |
| `sync/clock.ts`, `sync/device.ts` | This panel's HLC and its 6-char device code. |
| `realtime/master-connection.ts` | The socket to the Master, and `MasterCommandError`. |
| `services/user-session.service.ts` | Who is signed in here, online and offline. |
| `services/panel-report.service.ts` | The five-minute `panel:report`. |
| `config/paths.ts` | Every file the panel owns. Read through `paths()`, never captured — the data folder can move at runtime. |
| `http/app.ts` | One file. Every route the panel serves, including the write routes that queue and answer 202. |

## `master/web/src` and `office/web/src`

Both are the same shape:

```
App.tsx        the shell: Tab union, sidebar, screens, sockets, providers
api.ts         the one api client — every request goes through send()
screens/       one file per screen
components/    panel-specific pieces that are not shared
```

**The Master's screens** (19): Dashboard, Panels, LeadsOrders, Parties,
Inventory, Reports, Documents, Access, PartyAccess, Fields, Integrations, Logs,
RecycleBin, Conflicts, Settings, Updates, NewLead, FirstRun, SignIn.

**The Office's screens** (15): Dashboard, LeadBoard, LeadDetail, OrderBoard,
Catalog (parties + products), PartyDetail, ProductDetail, AddLead, Documents,
PartyAccess, Conflicts, Settings, Updates, Connection, SignIn.

`PartyAccessScreen.tsx` exists in **both** and is held byte-identical by
`master/tests/party-access-screen-parity.test.ts`. Edit one, copy it over.

---

## Where a change goes

| You want to… | Touch |
|---|---|
| Add a field to a record | `shared/domain/entities.ts` + `inputs.ts` + `columns.ts`, a migration, the repository mapper, the form |
| Add a permission | `shared/domain/permissions.ts` (with its tier), then **wire it** — an unenforced permission is worse than a missing one |
| Add a screen | the panel's `Tab` union, its nav items, its `ScreenSpec` array, and `nav.*` in both catalogues |
| Add a socket command | `shared/protocol/socket.ts`, then `master/realtime/hub.ts`, then the panel caller |
| Add an offline-able write | `shared/sync/mutations.ts` (kind + permission), `office/http/app.ts` (queue it), `master/services/sync.service.ts` (`route()`) |
| Change a string | `shared/i18n/en.ts`, then `npm run i18n:sync`, then translate the Hindi |
| Add a company setting | one entry in `shared/domain/settings.ts` (group + control + fallback + parser) and its two i18n tokens. Nothing else — no migration, no column, no screen change |
| Change a colour or size | `ui/src/tokens.css`. Never a literal in a component. |

## Tests

`vitest.config.ts` collects `{shared,master,office,electron}/tests/**/*.test.ts`
and `ui/tests/**/*.test.{ts,tsx}`. **Neither `master/web` nor `office/web`
matches, and neither holds a test file** — UI defects are invisible to the gate,
which is why the source-assertion tests below exist and why a browser pass
counts as real verification.

- **`*.integration.test.ts`** — need a real PostgreSQL and `describe.skipIf`
  themselves out without one. A skipped suite prints like a passing one; check
  it ran. They will not run as root.
- **Everything else is pure** and runs anywhere.
- **Source-assertion guards** — they read the tree rather than execute it:
  `no-duplicate-ui`, `party-access-screen-parity`, `screen-reachability`,
  `web-reachability`, `i18n-tokens`, `i18n-call-sites`, `ui-conventions`,
  `migration-registry`, `credential-invariants` (including the password
  minimum: every path that hashes a caller-supplied password must check it),
  and the discovery half of `panel-naming`.

## Docs

| Document | Covers |
|---|---|
| `HANDOFF.md` | Current state, decisions, traps, owed work. **First.** |
| `docs/CODE_MAP.md` | This file — the layout. |
| `docs/PROJECT_PLAN.md` | Requirements, pairing design, screen flows. |
| `docs/schema/` | Every table, column, index and why. Start at `00-overview.md`. |
| `docs/LEAD_GENERATION_FLOW.md` | The lead → order flow as built. |
| `docs/ROLES_AND_USERS.md` | Roles, users, permissions, tiers. |
| `docs/DEVELOPER_MODE.md` | The developer password, reset, test users. |
| `docs/UPDATES.md` | Shipping an update; the release ordering rule. |
| `docs/TESTING_PLAN.md` | The manual QA script. |
| `docs/BACKEND_MODULES.md` + `docs/backend-modules/` | Fields, Logs, Recycle Bin, Reports, PDF Designer, i18n. |
| `docs/overhaul/` | The 2026-08/09 overhaul designs, stages 0–12. |
| `docs/AI_COLLABORATION.md` | The multi-agent workflow and the per-session change log. |
| `docs/ai-handoffs/` | The working queue of open briefs. Not a permanent record. |

**`docs/overhaul/` and `docs/backend-modules/` were written before the code.**
Several of their stated facts did not survive contact with the tree. Check a
claim against the source before acting on it.
