# OrderBook Overhaul — Sequenced Implementation Plan

**Branch:** `dev`. **Status:** synthesis of ten reviewed workstream designs into one ordered programme.

---

## 0. Three corrections to the brief's own framing

Before the plan, three premises in the synthesis brief are wrong and change the shape of the work:

**(a) "Committing the untracked electron/ layer (A) must happen before anything else touches it" is far too narrow.** `git status --porcelain` shows 25 untracked paths, and they include:

```
?? master/src/db/migrations/20260313000000_panel_app_version.ts
?? master/src/db/migrations/20260313000000_party_access.ts
```

Both names are in the `SHIPPED` list at `master/tests/migration-registry.test.ts:108-126`, and both are in the `migrations` array at `master/src/db/migrations/index.ts:71,76`. Neither is matched by `.gitignore`. So a `git clean -fd`, a fresh clone, or a mis-resolved merge deletes two migrations that have already run on a real installation — and Knex validates completed-against-source before it runs anything, so the Master boots to *"The migration directory is corrupt, the following files are missing"*. That is the **exact 2026-08-27 incident** the registry test was written to prevent, and the test cannot catch it because the test file is untracked too. Also untracked: the entire Party Access module (`party-scope.ts`, `party-access.repository.ts`, `party-access.service.ts`, `party-access.routes.ts`, both `PartyAccessScreen.tsx`, both its test files), the entire update/version subsystem (`update.routes.ts`, both `update.service.ts`, `shared/src/domain/version.ts`, `shared/src/protocol/desktop.ts`, `app-version.ts`), and `master/tests/postgres-launcher.test.ts`. Roughly half the surface this programme depends on exists only in one working directory.

**(b) "The searchable picker (D) is used by the command palette (G)" is false in both corrected designs.** D explicitly refuses to rebuild `SearchBox` on `Picker` ("`recentsKey`, `onCreate` and pinning are meaningless for it"); G explicitly builds its own listbox and deletes `SearchBox` entirely. The real D→G dependency is three concrete things: the `kinds` query parameter on `/api/search`, ownership of `.ob-combobox-listbox`, and ownership of the `/` and `Escape` keys. Sequenced below as such.

**(c) "The keep-alive design (B) changes what the client-caching work (H) needs to do" is true and understated.** B removes the *reason* for a client cache. H must therefore ship dedup, cancellation and per-entity invalidation and **no cache library and no hand-rolled cache**. That is the single largest scope deletion in the programme.

---

## 1. Stage sequence

Thirteen stages. Stages marked ∥ may run concurrently with each other; everything else is strictly ordered.

| # | Stage | Depends on | Why here |
|---|---|---|---|
| **0** | Repo safety | — | Two SHIPPED migrations are one `git clean` from gone |
| **1** ∥ | Data-integrity core (E-part-1) | 0 | Only live data-loss bug; gates D, I, J writes |
| **2** ∥ | Electron shell (A) | 0 | Requirements 1 & 7; touches no file Stage 1 touches |
| **3** | i18n fold → `@orderbook/ui` + React 19 (B-part-A) | 0 | Structural blocker for every UI stage |
| **4** ∥ | Settings + password vault (F) | 0 | Gates AI config, connector secrets, reveal toggle |
| **5** | Screen keep-alive + DataTable (B-part-B + C's row-height fix) | 3 | Requirement 4; gates G's `ScreenScope` |
| **6** | UI scale, 1024→4K, fluency (C) | 5 | Requirement 3 & 10 |
| **7** | Performance and memory (H) | 3, 5 | Requirement 11; needs one `ui/` and stable mount lifecycle |
| **8** | Product & party attributes (E-part-2) | 1, 4 | Requirement 8; needs patch semantics + settings |
| **9** | Picker, dense forms, grid entry, report exports (D) | 6, 7, 8 | Requirements 9 & 15 |
| **10** | Keyboard system (G) | 5, 9 | Requirement 5; needs `ScreenScope` + `kinds` param |
| **11** | Public API + connectors (J) | 1, 4, 7 | Requirement 13 |
| **12** | AI section (I) | 4, 8, 9 | Requirement 12; last because it consumes everything |

Requirements 2 (clean the codebase) and 14 (more fluent UI) are not stages — they are distributed: 2 is the net deletions in Stages 1, 3, 5, 7; 14 is Stage 6 §3.

---

### Stage 0 — Repo safety

**One commit, containing nothing else.**

1. `git add` every untracked path listed by `git status --porcelain | grep '^??'`. Do not curate. Two of them are SHIPPED migrations; the rest is the module they came with.
2. Verify `npm run verify` passes on a clean checkout of the resulting commit. If it does not, the working tree has been running on files that never existed in git and that is the finding.
3. Add `"typecheck": "tsc -b"` to `master/web/package.json` and `office/web/package.json`. Root `typecheck` is `npm run typecheck --workspaces --if-present` and **neither web workspace has the script**, so `npm run verify` has never typechecked a single line of frontend code. Stages 3, 5, 6, 9 and 10 make ~1500 edits under `web/src`; discovering this at Stage 6 is not acceptable.
4. Append `&& tsc -p electron/tsconfig.json --noEmit` to root `typecheck` — reserved for Stage 2, added here so the script is stable.

**Done when:** a fresh `git clone` of `dev` runs `npm ci && npm run verify` green, and `master/dist` builds without any file that only exists locally.

**Size:** trivial (0 new files, 3 modified, one large `git add`). **This is 30 minutes and it is the highest-value 30 minutes in the programme.**

---

### Stage 1 ∥ — Data-integrity core (E, part 1)

The whole-record-replace defect and its two siblings. No UI, no migration, no new table.

**New:** `shared/src/domain/columns.ts` — `PRODUCT_COLUMNS`, `PARTY_COLUMNS`, `LEAD_COLUMNS`, `ORDER_COLUMNS`, `USER_COLUMNS` as `const satisfies Record<string,string>`; `JSON_COLUMNS`; `assertedFields()`; `columnPatch<M extends Record<string,string>>()` (generic, so the wrong map is a compile error); `fieldFor()`; `MERGEABLE_COLUMNS` with `MERGEABLE_PRODUCT_COLUMNS = PRODUCT_COLUMNS minus categoryId`.

**Net deletion:** `sync.service.ts:81-131` COLUMN_MAP + JSON_COLUMNS, `lead.service.ts:455-468`, `user.service.ts:406-416`, and both `columnsFrom` bodies. The `notes:'notes'` bug on a nonexistent column disappears by construction.

**Contract, stated once and enforced everywhere after:** `undefined` = not asserted, `null` = clear it. This changes the meaning of an omitted key for sync, the future REST API and the future connector simultaneously. Document it in the module header.

Also in this stage:
- `stampFieldHlc(current, fields, hlc)` in `shared/src/sync/merge.ts`, applied at `createProduct`/`createParty`/`updateProduct`/`updateParty` (loading `existing` **inside** the transaction — `catalog.service.ts:320-347` does not load the row today), `conflict.service.ts:110-133`, `order.service.ts:251` (via `fieldFor(ORDER_COLUMNS, column)` — it writes snake_case keys today that `mergeFields` never reads), `auth.service.ts:104,:242`. This switches the merge engine back on: `merge.ts:88-116` is dead code today because `fieldHlc: {}` is passed at four catalogue write sites.
- `validateProductInput(input)` — pure, beside the columns map, called from **both** `catalog.service` and `mergeUpdate`. Non-negotiable: `mergeUpdate` writes columns with no service in front, `applyOne` (`sync.service.ts:212-219`) records any throw as permanently `rejected`, and the replay path (`:148-151`) returns that rejection forever. A raw CHECK violation there silently destroys an Office panel's offline work.
- `setStockLevels` in `inventory.repository.ts:246-262`: build the INSERT column list and the `ON CONFLICT DO UPDATE` SET clause from **only the asserted subset** of `{reorder_level, min_stock_level, max_stock_level}`; return `findStockLevel` unchanged when the subset is empty; never bind `undefined` into a knex `.raw()`.
- **Two-dimension product masking**, done now rather than at Stage 8, because it is the same file family: `maskProduct(product, { rates, cost })`, `canSeeCost`/`canEditCost`, and — the part that matters — `office/src/http/app.ts` `maskChangeEvent` loses its `if (allowed) return event;` short-circuit and becomes `if (vis.rates && vis.cost) return event;`. The signature change is *not* a sufficient tripwire; that guard is not a call site and would keep compiling.
- **Live bug, two lines:** `search.repository.ts:92` and `:110` filter only `is_active`, but `softDeleteProduct`/`softDeleteParty` set `deleted_at` and leave `is_active` alone. Soft-deleted products and parties are in universal search today. Add `AND p.deleted_at IS NULL` / `AND pa.deleted_at IS NULL` in the shared query, not in a new path.
- Office client half: `office/web/src/api.ts:314,:317` widen to `PartyInput & { baseFieldHlc?: … }`; the drawers send `editing.sync.fieldHlc`; `office/src/http/app.ts` strips it before `Object.keys` builds `fields`.
- `local-store.ts:96 applyOverlay` gains `party.update` and `product.update` cases (generalise `pickLeadFields` to `pickFields<T>`).

**Behaviour change to record, not to "fix" back:** today a rate-blind editor's update NULLs the rate (`withPermittedRate` deletes the key, `columnsFrom` writes `?? null`). Under `columnPatch` the stored rate is preserved — which `visibility.ts:60-68` always claimed.

**Recoverability, stated plainly:** damaged rows are not recoverable from the activity log (`catalog.service.ts:307-315` records `action:'updated'` with no `details`; the hash chain proves *that* a row changed, never what it held). Only a `.obbackup` or an Office panel's on-disk snapshot holds the old values. On the evidence — `master/web/src/api.ts` has no `put<`/`patch<` at all and master has no product or party screen — **this is a loaded gun, not a smoking one.** Say that to the owner. It fires the first time Stage 9 ships a master form.

**Done when:** a regression test proves a name-only update leaves the other nineteen product columns intact; an offline `uom:'crate'` merge is refused as a readable `ValidationError` rather than a Postgres CHECK error; `master/tests/search.integration.test.ts:116-131` still passes.

**Size:** medium — ~2 new files, ~18 modified.

---

### Stage 2 ∥ — Electron shell (A)

Three of the original design's four headline defects were already fixed in the working tree; **re-read `office/src/http/app.ts` and both `electron/main.ts` immediately before editing and trust no line number.** Verified during synthesis: office already has `GET /api/health` at `:75`, above the `requireUser` gate at `:218`; `app.use('/api', notFoundHandler)` is at `:833` and `errorHandler` at `:834` with both defined locally from `:839`; `return app` is at `:836`.

What is genuinely broken is the process lifecycle:

1. **One shell, two thin entrypoints.** New top-level `electron/` (not a workspace): `shell.ts` (the only file importing `electron`), `master.main.ts`, `office.main.ts`, one panel-agnostic `preload.cts`, `lib/{health,installer,supervisor,log-file,settings}.ts` (pure or `node:fs` only), `tests/`. `tsconfig.json` uses `types: ["node"]` — **never `["node","electron"]`**, which fails TS2688 — plus `"exclude": ["tests"]`.
2. **`serverEnv` returns overrides only.** The shell builds `{...process.env, ELECTRON_RUN_AS_NODE:'1', ...config.serverEnv(ctx)}` then `delete env.DATABASE_URL` when packaged. Without `process.env` underneath there is no `SystemRoot`/`PATH`/`TEMP` and `initdb` does not run.
3. **`app.setName()` only.** Keep the existing single-instance dialog. **Never `app.setPath('userData', …)`** — it relocates the Chromium profile and wipes `ob.theme.v2`, `ob.density`, `ob.motion` and everything Stages 5/6/9/10 add there.
4. **Health.** Extend office's existing route in place with `panel`, `version`, `interfaces`, the loopback fields, `satisfies PanelHealth`. Master gets `master/src/http/health.ts`: `boot-app.ts` derives `status` from `bootStatus()`; **the live app hardcodes `status:'ok'`** and attaches `boot: bootStatus()` — `http-api.integration.test.ts` builds `createApp()` without ever calling `bootReady()`. `dataDir`/`logFile`/`installerDir` are spread in **only** when `req.socket.remoteAddress` is loopback; master binds `0.0.0.0` and this route is unauthenticated by design.
5. **Module-scope shutdown broker, registered before `main()` runs.** In `master/src/index.ts`, hoist `postgres`/`hub`/`discovery`/`httpServer`/`sessionSweep` to module scope and collapse `installShutdownHandlers` + `installFailedShutdownHandlers` into one module-level `shutdown(reason)` — a net deletion. Register `SIGINT`, `SIGTERM`, `message` and `disconnect` at module scope. Today they register at `:129`, *after* `startPostgres()` and `runMigrations()`: 60-90 s on first run with no handler, which is exactly the window in which an operator closes the splash and exactly the half-built cluster this protects. Office gets the same, its `shutdown` closure hoisted out of `main()`.
   > **Seam for later stages.** Leave a module-level `disposables: Array<() => void | Promise<void>>` that `shutdown()` drains. Stage 4 registers the vault key pre-flight, Stage 11 the connector scheduler, Stage 12 the AI retention sweep. Without this seam three later stages each re-shape the same function.
6. **Supervisor.** Today *any* child exit including a clean 0 fires an error dialog and quits — that is requirement 1 verbatim. Replace with a bounded supervisor: 3 restarts in 10 minutes, then a `showMessageBox` with `['Restart','Open log folder','Quit']`. `updating` becomes `updatingSince: number|null` with a 60 s window (today an installer that starts and dies suppresses every future crash report for the process's life).
7. **Window.** `minWidth: 1024, minHeight: 640` — **this is where requirement 10's new floor lands, not in Stage 6.** `sandbox: true`, `devTools: !app.isPackaged`, origin check `u === ORIGIN || u.startsWith(\`${ORIGIN}/\`)`, and every guard (`setWindowOpenHandler`, `will-navigate`, `render-process-gone`, `did-fail-load`, `closed`) registered **immediately after `new BrowserWindow`** — `createWindow` returns early on a timed-out start today.
8. **Menu — and this is where Stage 10's shell changes land.** Keep `buildMenu()` static and main-owned. Pin `role:'reload'` to `CmdOrCtrl+R`. Add the `before-input-event` F5/Ctrl+Shift+R swallow. Replace the Help item's `loadURL('${ORIGIN}/#/updates')` (dead — `readHash()` only recognises `'gallery'`, so it reloads onto the Dashboard) with `webContents.send('orderbook:menuCommand','nav.updates')`. Add one "Keyboard shortcuts\tF1" item sending `'help.shortcuts'`. Add `DesktopBridge.onMenuCommand` (optional member). **No renderer→main descriptor, no accelerator regex, no role allowlist.** Stage 10 adds only the renderer listener.
9. **Installer allowlist, log file, auto-start** per the corrected design; `DesktopBridge` gains `getShellSettings`/`setShellSettings`/`openLogFolder` as **optional** members; `DesktopBridge.panel` is deleted (zero consumers).

**Out:** per-platform release manifests, `'!node_modules/**/*'`, `postgres-platform.ts`, `stripWhenPackaged`, and `master/web/src/api.ts`'s `health()` + hand-copied `BootStatus` (zero consumers — delete them).

**Done when:** `electron/tests/*` pass; both packaged panels start, are closed by their window button without an error dialog, and leave no `postgres.exe` on port 55432 after a normal quit; killing the shell's process tree shuts the server down (proves `disconnect` works); a deliberately-broken migration produces the boot failure page and not a silent quit.

**Size:** large — ~10 new files, ~12 modified, plus deleting ~500 lines of duplicated shell.

---

### Stage 3 — i18n fold → `@orderbook/ui` + React 19 (B, part A)

The structural blocker. 26 of 41 `ui/` entries are byte-identical; four are **forks, not copies** — `theme.ts`, `icons.tsx`, `PermissionGrid.tsx`, `base.css`. Copying master's `theme.ts` over office's flips every installed Office panel to dark and orphans its stored preference (`ob.theme` vs `ob.theme.v2`).

**Order within the stage is fixed, because seven `ui/` files import `../i18n/strings`:**

**3a. Fold the two dictionaries into `shared/src/i18n/en.ts` (1029 + 501 keys → 1401 union).**
1. Namespace the **13** conflicting keys as `master.*`/`office.*`. Two differ in *placeholder set* (`sync.offlinePending`, `sync.offline`) — a naive merge corrupts a status line.
2. Drop the four keys already in shared with identical values (`fieldSet.lead.sourcePlatform`, `fieldSet.stock.colour`, `fieldSet.product.productType`, `fieldSet.line.packaging`) — a duplicate literal key trips `no-dupe-keys`.
3. Fix `tools/i18n-sync.mjs`'s `KEY_LINE` (misses 119 entries) **and its value parser** (multi-line, both quote styles). **Keep emitting the English text under the `TODO(i18n-hi)` marker** — emitting `'<key>': '<key>'` strips placeholders and turns ~141 assertions in `shared/tests/i18n-coverage.test.ts` red. Also fix the double-quoted-stub re-append that produces TS1117 on a second run.
4. Parameterise the four strings carrying 3+ digit runs (`avatar.hint` `{px}`, `documents.editor.termsHint` `{max}`, `fields.values.field.hexHint`/`hexInvalid` `{example}`). Do **not** widen the digit rule — it guards the server's error catalogue too.
5. Add `tDynamic(key: string)` and repoint the **15** template-literal call sites (enumerated in the B design).
6. Five call sites already reference keys missing from their own dictionary and render the raw key today (`PanelDetailScreen` `common.save`/`common.cancel` ×2, `ColourQuantityGrid` `lead.add.products.freeToSell`/`short`) — all five resolve at the fold. That is the fork bug, live.

**3b. Create `ui/` as a source-only workspace.** `exports` → `./src/index.ts`; `optimizeDeps: { exclude: ['@orderbook/ui'] }` in both vite configs (Vite does not pre-bundle symlinked workspace packages, which is what lets `assetsInlineLimit: 0` own font emission). Add `"ui"` to root `workspaces` **before** `"master"`, to `eslint.config.js`'s JSX block, and — easily missed — to `setVersion()`'s hard-coded file list at `tools/release.mjs:83-91`, which stamps one version across every package because the panels compare versions with each other.

**Move all 36 components including the master-only ones.** This is the ponytail win the individual designs missed: moving `SubNavSlot.tsx`, `TopbarSlot.tsx`, `AvatarPicker`, `PermissionSummary` into the shared package **deletes two separate "port X into office" tasks** — D's SubNavSlot port and G's office TopbarActions slot. Delete: office's `PermissionGrid.tsx` (zero importers), office's `icons.tsx`, `KanbanBoard.tsx` (zero importers), `permissionLabels.ts`, master's dead 123-line `styles.css` tail. `theme.ts` splits into `config.ts` (`configureUi()` with panel/defaultTheme/storageKey) + storage helpers; **export `readJson`/`writeJson` here**, because Stages 6, 9 and 10 each want them.

**3c. React 19.2 upgrade — three real breakages, all in files that just moved, so one edit each:**
- `ui/Tooltip.tsx:13` → `useRef<ReturnType<typeof setTimeout> | undefined>(undefined)`
- `ui/useOverlay.ts:23` → `RefObject<HTMLElement | null>`
- `ui/Combobox.tsx:32` → `RefObject<HTMLInputElement | null>`

Gate Stage 5 on `!!require('react').Activity` after the upgrade.

**`PartyAccessScreen.tsx` does not move** — it imports `{ api, ApiError }` from `../api` and the two clients differ. Both copies get **one identical import repoint and one identical header rewrite keeping the literal word `byte-identical`**, which `master/tests/party-access-screen-parity.test.ts` asserts. Update that test's docstring (it currently says the panels keep separate `ui/` copies, which this stage falsifies, and refers to a shared workspace "that does not exist").

**Test infrastructure, first time in this repo:** `jsdom` + `@testing-library/react` as devDeps, `environmentMatchGlobs: [['ui/tests/**','jsdom']]` (**Vitest 2.1.9 has no `test.projects` — that is Vitest 3**), include extended to `ui/tests/**/*.test.tsx`, and a dedicated `ui/tests/tsconfig.json` with `jsx: react-jsx` rather than widening `tsconfig.test.json` and handing DOM globals to the server suites.

**Cost to state:** `translate.ts` imports both catalogues unconditionally, so after the fold each panel bundle and each Express server carries 1401 EN + 1401 HI strings, including the other panel's vocabulary.

**Done when:** `npm run verify` green *including* the two new web `typecheck` scripts; `no-duplicate-ui.test.ts` asserts neither `web/src/ui` exists and no `./ui/` relative import survives; the parity test passes; both panels build and run visually unchanged.

**Size:** very large — ~45 files moved, ~40 modified, 1400 keys relocated. **This is the single biggest and most mechanical stage, and the one most likely to be under-estimated.**

---

### Stage 4 ∥ — Settings + password vault (F)

Two tables, one migration, no `SyncSnapshot` change.

`settings` is a row per key (`tenant_id`, `key`, `value` JSONB, `is_secret`, `key_version`, `updated_at`, `updated_by`), declared once in `shared/src/domain/settings.ts` with `parse: (raw: unknown) => T` explicitly annotated (`strict: true` means `as const satisfies` does not contextually type through the assertion). Absent row = declared default, so an upgraded installation behaves identically the minute after.

**There is no `audience` field, no `SharedSettings`, no `writePermission`.** Every setting is Master-only and every write is gated on `settings.manage` alone. `writePermission: 'users.viewPassword'` deadlocked exactly the installations it claimed to protect: nobody could turn the feature on, and — worse — nobody could turn it **off**, stranding plaintexts with no purge. `SyncSnapshot` gains nothing: every field added to that interface since it shipped is optional and says why, and `office/src/sync/local-store.ts:56` parses a file the *previous* version wrote.

`user_password_vault` (`tenant_id`, `user_id`, `key_version`, `sealed` JSONB, `credential_fingerprint`, `updated_at`, `updated_by`) sealed with AES-256-GCM from `master/src/lib/secret-box.ts`, AAD `vault:${tenantId}:${userId}`, key at `dataDir/secrets/vault.key` mode 0600. Created **lazily on first seal/open** with a boot pre-flight registered through Stage 2's `disposables` seam — no integration suite runs `main()`, so a boot-only initialiser makes every vault test throw `no_key`.

Five write moments, all already holding the plaintext. **Seal after the transaction**, taking the fingerprint from `panelCredentialRepo.fingerprintForUser()` — `signIn` rewrites bcrypt→scrypt inside its own transaction (`auth.service.ts:98-108`) and `setup.service.ts:51` hashes the first administrator with bcrypt, so sealing `credential.passwordHash` would make the shop's own admin account report `stale` on its very first reveal.

`POST /api/access/users/:id/reveal-password` — POST so it never enters a URL or proxy log, `no-store`, its own route so it cannot ride along in `GET /api/access/users`. Gates in order: `users.viewPassword` → toggle-on → user exists → **re-authentication** (5-min cache, swept by a *new loop inside* `purgeExpiredSessions` and cleared by `resetAuthState`) → fingerprint match → `open()` → **audit committed before responding**. Returns the existing `OneTimeSecret` rendered by the existing `OneTimeSecretDialog`. No new shared type, no new dialog.

**Say the truth about the permission.** `20260303000000_roles_and_users.ts:331` updates the admin-tier role with a **live `allPermissions()` import**, so adding `users.viewPassword` to `CAPABILITIES` auto-grants it to the seeded Administrator on every fresh install; `fixtures.ts:244` gives it to every `testActor()`. Only an *upgraded* installation starts with nobody holding it. The load-bearing control is `security.passwordRevealEnabled`, `false` on both, purging the whole vault in the same transaction when set back to false.

**Six containment guarantees**, of which one is a same-commit obligation: `backup.repository.ts:40 EXCLUDED_TABLES` gains `'user_password_vault'` **in the same commit as the table**, or every backup taken between the two commits carries the ciphertext out of the building. Because `loadTables` then never truncates it, `backup-restore.service.ts` calls `clearVault(trx, tenantIds)` beside `revokeAllOfficePanels`.

`invalidateSettingsCache()` joins the three existing invalidators at `fixtures.ts:220-223` **and** is called after the restore transaction commits. In-memory caches survive `TRUNCATE`, and `fileParallelism: false` on a shared database means a leaked `true` toggle surfaces in an unrelated suite. (Fix `backup-restore`'s identical missing `invalidateRoleCache()` here too.)

**Done when:** `password-vault-invariants.test.ts` (7 source-reading guards, including "`user_password_vault` appears in exactly **three** files under `master/src`"), the vault and settings integration suites, and `credential-invariants.test.ts` **unchanged** all pass; a `.obbackup` demonstrably contains no vault key; the reveal is refused for a key holder while the toggle is false.

**Size:** large — 8 new files, ~18 modified, 1 migration.

---

### Stage 5 — Screen keep-alive + DataTable (B part B, with C's row-height fix folded in)

Requirement 4. `<Activity>`, not a router (none gives keep-alive), not an external store (41/50 `useState`s to enumerate).

`ui/src/ScreenHost.tsx` renders visited screens inside `<Activity key={\`${id}:${resetNonce[id] ?? 0}\`}>`. **`visited` updates in the render body**, not an effect — an effect drops a blank frame on every first visit to each of the 14/9 tabs.

**Three things depend on effect teardown meaning unmount, and each needs an explicit fix:**

1. **Sub-nav must move above `<Activity>`.** `useSubNav` ends with `useEffect(() => () => set(null), [set])`; `<Activity mode="hidden">` tears effects down, so leaving it deletes the sidebar entry the feature promises. `SubNavProvider` keeps a `Map<screenId, SubNavState>` in a ref; `useSubNav(screenId, state)` writes on mount and signature change and never clears on teardown. Entries clear only on the screen's own close action or a `resetNonce` bump. Delete `SubNavState.onExit` and `App.tsx:420`'s `if (subNav && !subNav.onExit()) return;`.
2. **`useOverlay`'s Escape arbitration breaks with N mounted panes.** `Modal` and `Drawer` render in-tree with no portal and `<Activity>` hides with `display:none`, so a hidden pane's open Drawer later in the array becomes the "last dialog" and the visible one refuses Escape. Filter by visibility: `[...document.querySelectorAll('[role="dialog"]')].filter(d => d.checkVisibility())` — Electron 33 ships Chromium 130. Same guard on the focus-restore, and capture `restoreFocus` once per open transition so a hide/show cycle does not yank focus into a `display:none` subtree.
3. **Office's `App.tsx:665-750` is not a switch.** `updates` and `settings` are returned *above* an `if (!view) return <waitingFirstSync>` gate, and every screen below takes a non-null `LocalView`. Build the `ScreenSpec[]` in two tiers: those two always available; the remaining seven only when `view` is non-null, rendering `waitingFirstSync` in ScreenHost's place until the first snapshot. `parties` and `products` are two ScreenSpecs sharing `CatalogScreen`. Same treatment for master's `route === 'gallery'` short-circuit, which is separate `route` state, not a `Tab`.

Make the two remaining slots order-independent rather than trusting hide/show effect ordering: `useFilterBar`'s cleanup becomes `set(cur => cur === node ? null : cur)`; `useSaveShortcut` clears only if it still owns the handler.

**DataTable — one edit, three fixes, because Stage 6 and Stage 9 both want this file:**
- **The virtualiser is inert today.** `.ob-tablewrap` has `overflow:auto` (`base.css:460`) but no height constraint and sits inside `.ob-content`, which is the real scroller; `clientHeight` is the full table height, `onScroll` never fires (scroll does not bubble), and `visibleCount ≥ rows.length`. Keep-alive would multiply a 500-row page by every visited screen. Fix: `.ob-content { flex:1; min-height:0; overflow:hidden; padding:0 }` plus a new `.ob-pane { height:100%; overflow:auto; padding: var(--s-16) var(--s-20) }`; resolve `wrapRef.current.closest('.ob-pane')`, take `viewportH` from `scroller.clientHeight` and `scrollTop` from `scroller.scrollTop - wrap.offsetTop` on a passive listener; drop the `onScroll` prop.
- **Stop reading `--row-h` through `getComputedStyle`** (`DataTable.tsx:58`). Stage 6 makes that token rem, `parseFloat` returns 2.2857, and `Math.ceil(viewportH / 2.2857)` renders ~10,000 rows. `base.css:537` already sets `height: var(--row-h)` on the row: ref the first non-padding `<tr>`, read `offsetHeight`, add it to the same `ResizeObserver`. This tracks scale *and* density automatically and deletes the need for an `@property` registration, a magic-number guard, and a test asserting either. `DEFAULT_ROW_H = 32` stays as the pre-measure fallback.
- Add `setViewportW(el.clientWidth)` to `measure()` — Stage 6's column-priority needs it.

`ScreenPane` saves/restores `scrollTop` across the hide. `LoadMorePager` accumulation in `DocumentsScreen`/`RecycleBinScreen` caps at 10 retained pages. **No LRU.** Do **not** delete the `let cancelled = false` blocks — Stage 7 owns that. Gate every skeleton on `loading && rows.length === 0` (~20 sites).

**Reset:** the shell owns `resetNonce`; bumping it changes the `key` and React remounts. Total reset, zero per-screen code. Button right of `<TopbarActionsOutlet />` using a **new `reset` glyph** — `sync` is already the Updates nav icon. `ui/src/ResetSlot.tsx` copies `SaveShortcutSlot`'s ref shape; only `AddLeadScreen` and `AccessScreen`'s editors register a confirm.

**Office AddLead:** delete `setAddingLead(false)` from `goToTab`; the draft survives because the pane is not unmounted.

**Persisted across restart:** `ob.ui.lastTab` (validated against the freshly computed nav), `ob.ui.sidebarCollapsed`, `ob.locale`. **Not** persisted: fetched data, and half-typed drafts — a rehydrated draft can carry a `saleRate` the person has since lost `field.saleRate.view` for, and masking is by key absence. A durable draft belongs in the office outbox.

**Honest statement:** net API effect is **neutral**, not negative. A screen fetches once per mount today and once per re-show after. The win is that a hand-rolled `display:none` keep-alive would have made it worse.

**Done when:** filters, scroll, drawers and half-typed forms survive a tab round-trip on all 14 master and 9 office screens; Reset clears exactly one screen; no table renders more than ~40 rows at 1080p; `ui/tests/{screen-host,slots,scroll-restore}.test.tsx` pass.

**Size:** large — 4 new files, ~25 modified.

---

### Stage 6 — UI scale, 1024→4K, fluency (C)

**Scale.** Split the two jobs `[data-density]` conflates: `--root-size` becomes the continuous knob (11-22 px, 0.5 steps, shown as 79%-157% of 14), and `[data-density]` keeps only the height-to-text *ratios*, in rem. Each ratio is today's absolute value over today's per-density root, so every preset keeps its exact current proportions and `tokens.css:173-175`'s "no component knows density exists" contract now covers scale too.

Persistence extends `ui/src/theme.ts` (one file now, after Stage 3): `KEY_SCALE = 'ob.scale'`, `loadScale()` with a one-time migration reading `ob.density` → 13/14/16 (and **not** clearing it — density stays live and independent), `applyScale()` setting the property and storing. `initAppearance()` gains `applyScale(loadScale())` and already runs before `createRoot().render()`, so no inline pre-paint script. Add `KEY_SIDEBAR` with `'auto'|'open'|'closed'`.

Five mechanical conversion rules (hairlines and radii stay px; anything measured against text becomes rem at base 14; anything against the viewport becomes `min(<rem>, <vw|vh>)`; JSX numerics go through one `rem()` helper). Enumerated sites are in the C design; **add the two it missed — `base.css:325` and `:645`, `calc(var(--ctl-h-md) - 8px)` → `- 0.5714rem`.** `icons.tsx` keeps numeric `width`/`height` attributes and adds `style={{width: rem(size), height: rem(size)}}` — `rem` is not a legal SVG 1.1 attribute unit.

**Electron zoom: nothing to do.** The menu has no zoom roles, nothing calls `setZoomFactor`, and pinch-zoom ships disabled. There is no accessibility escape hatch to remove. Stage 10 binds `Mod+=`/`-`/`0` to `applyScale`.

**Responsiveness.** Three breakpoints in physical CSS px, deliberately — a layout that reorganises while you drag a font slider reads as a bug, and `@media` `em` resolves against the browser default (16 px), not `html{font-size}`. `BP_NARROW (max-width:1180px)`, `BP_TIGHT (1080px)`, `BP_SHORT (max-height:800px)`. **No upper breakpoint and no shell max-width** — at 4K the app gets more content via `DataTable`'s trailing `minmax(0,1fr)` filler and the five `auto-fit` grids; only measure-bound surfaces cap.

**Modals already survive the new floor**, arithmetic corrected: at 1024 px the content area is 1024 − 3 px rail − sidebar = **969 px collapsed / 813 px pinned**, and `--lg` at 840 px + 48 px wrap padding fits with 81 px spare; `max-width:100%` clamps the pinned case and the 157% case.

**Delete the drawer — but only the four screen-level ones here.** `CatalogScreen.tsx:284` (party), `:427` (product), `LeadBoardScreen.tsx:363`, `OrderBoardScreen.tsx:245` are record detail and the standing rule requires modals. This needs `Modal.tsx` edits: add `'xl'` to `ModalSize` with `.ob-modal--xl { width: min(76rem,100%) }`, and add optional `expanded`/`onToggleExpand` mapping to `xl`, because two of those sites use Drawer's full-screen toggle. Drawer's `headerActions` has zero call sites. **`ui/Drawer.tsx` is deleted at the end of Stage 9**, not here — Stage 9 owns the two remaining form drawers.

**Retina: do not use srcset.** Office serves images from a local cache and forwards `image:fetch` to the master on a miss, returning **503 when offline**; srcset makes the browser choose among four variants instead of the one normal browsing warms, and a 503 on the chosen candidate does not fall back to `src`. Pick one variant at render from `slotCssPx * devicePixelRatio`. Move the long edges from `master/src/domain/images.ts` (a **server** module `office/web` cannot import) into `shared/src/domain/entities.ts` beside `IMAGE_VARIANTS` and have `IMAGE_VARIANT_SPECS` build from them, so there is one table.

**Fluency:** `SkeletonTable<T>` added **alongside** `SkeletonRows` (11 call sites — not a replacement); four transitions; optimistic pending-marker on Office rows only (`getView()` already replays the outbox, so the value is already in the pushed view; Master's loopback writes return in milliseconds and rollback machinery is pure risk on a conflict path); `html { scroll-behavior: auto !important }` in both `reset.css` motion blocks.

**`styles.css` is trimmed, not deleted.** Every guarded element rule in it is already token-based and scales for free. Do the zero-risk subset only: convert ~10 px values; delete the 13 zero-`className` rules, the duplicate `.sr-only` and the dead `@media (max-width:900px)`; hoist bare `.num` into `base.css` (`base.css:663` defines only `.ob-table .num`, and 18 sites use the bare class outside a table); and **first** replace `var(--muted)` at `office/web/src/components/KanbanBoard.tsx:85` — that token is defined only in `styles.css`'s alias block. The 165-site className migration is **explicitly not in this programme and has no owner.**

`master/web/src/components/SearchBox.tsx` is rewritten onto `.ob-*` here (it renders a **bare** `<input>` styled only by the legacy element rule, in a `card`/`secondary`/`row`/`chip` dropdown with five more hardcoded literals) — and then **deleted entirely in Stage 10**. Doing the rewrite here is still correct: it removes the last legacy dependency in the topbar, and Stage 10 needs a working `.ob-search` shell to hang the palette button on. `.ob-search` does not collapse to an icon button at ≤1080 until Stage 10 ships the palette.

**Tests:** one `master/tests/ui-conventions.test.ts` in the fs-reading style (token units; `tokens.css`/`reset.css` identical **after line-ending normalisation** — there is no `.gitattributes`; no numeric size literal in any JSX `style` object for the eight size properties; regexes must handle template-literal `className`, as at `office/web/src/components/SyncStatus.tsx:28`). Plus `master/tests/datatable-fit.test.ts` importing an extracted DOM-free `ui/src/fitColumns.ts`, which requires adding `"lib": ["ES2022","DOM"]` to `tsconfig.test.json`. **Drop `theme-scale.test.ts`** — a `Math.min/max` clamp does not earn a test file needing a stubbed `localStorage`.

**Manual gate in the PR** (there is no jsdom for screens): both panels at 1024×768, 1366×768, 1920×1080, 3840×2160, each at 79% / 100% / 157%, sidebar in all three modes.

**Size:** large — 4 new files, ~40 modified, ~200 mechanical `.tsx` edits.

---

### Stage 7 — Performance and memory (H)

Four amplifiers turn one action into N×M work. Remove all four. **No cache library and no hand-rolled cache** — Stage 5 removed the reason.

**H1 client.** `request<T>` gains a 15 s `AbortSignal.timeout`, `'aborted'`/`'timeout'` codes, and **refcounted** in-flight GET dedup: `{promise, controller, waiters}`. Without the refcount, one unmounting screen kills every other consumer's in-flight GET and the survivor renders loading-forever (`useResource` swallows `aborted` by design). POSTs never dedup. Delete `withTimeout`. `useResource(fetcher, deps)` replaces every `let cancelled = false` block — a net deletion, and one file now, in `@orderbook/ui`. Replace `dataRevision` with `RevisionContext` + `useRevision(...entities)` and **delete `REFRESHING_ENTITIES`** — it filters the socket handler to six entities, so a per-entity revision for `document_export` or `option_list` would be permanently zero.

**H2 one query per request, at all five sites.** `user.repository.ts` gains `findByIdWithRole` as **its own query, not an edit to `baseQuery`** — `baseQuery` joins roles with no tenant predicate (`permissionSetForRole`'s comment explains why matching on id alone is not safety), and adding the columns to `baseQuery` would put every role's permission array into every `listUsers` row. `resolveSessionWithPermissions` routes `attachSession`, `adminActor`, `actorForRecipient`, `broadcastDashboard` and `resolvePanelActor`. Measured budget: `GET /api/parties` is 3 auth + 2 list (`party.repository.ts:46` count + `:47` rows) = **5 → 3**. Assert `<= 3`, not `<= 2`.

**H3 broadcast.** 250 ms trailing `scheduleDashboard(io)`, `unref`'d, memoised per flush on `${tenantId}|${seesAll}|${userId}|${permissions?.permissions.join(',') ?? ''}` (note the null guard). **This is the single debounce; Stage 11's 500 ms proposal is deleted.** `actorForRecipient`'s master-admin branch routes through `resolveSessionWithPermissions` — **not** a zero-query `sessionPermissions()` read, which returns `[]` for an absent or expired token and cannot be told apart from a real empty set, so a signed-out or post-restart admin socket would keep receiving `data:changed` for every restricted party it holds a grant on. **No grant cache** (unversioned, invalidated from inside a transaction that can repopulate it pre-commit) and **no `refreshSessionsForRole`** (called from inside transactions at `role.service.ts:165` and `user.service.ts:217` that can still roll back).

**H4 delta replay.** `change-ring.ts` (~60 lines) recording from the existing `onChange` at `hub.ts:129`; `sync:delta`; `DataChangedEvent.seq?` in `shared/src/protocol/socket.ts` (**there is no `protocol/index.ts`**). Three corrections that are the difference between working and silently wrong:
- **Replayable is exactly what `applyChange` handles** — lead, party, product, product_category, order, stock. `party_variant`, `sync_conflict` and `reservation` are valid `ChangedEntity` values with **no case**, so they force a full snapshot. Party variants are per-party negotiated rates; replaying and dropping them means staff quote from stale prices with no error anywhere. Export one `REPLAYABLE_ENTITIES` so the lists cannot drift, and assert in `change-ring.test.ts` that every `ChangedEntity` is in exactly one bucket.
- **Extract one `mayReceive(actor, event, grants)`** from the live fan-out and use it for replay: skip `DIRECTORY_ENTITIES` (role, user, document_export), party-scope the scoped ones, emit the rest. Replaying without the directory filter hands every Office panel the whole staff list and every role's complete permission array.
- **Hydrate before applying.** `MasterConnection.snapshot` is set only by `sync:snapshot` and `requestFreshSnapshot`; `applyChange` returns early on null. On connect: `this.snapshot ??= await localStore.restore()`, and send a cursor only when that is non-null **and** a persisted `{bootId,lastSeq}` exists — written in the same disk write as the snapshot so the pair cannot disagree.

**H5 bytes off the socket.** `require-panel.ts` reads `x-orderbook-panel-id`, `x-orderbook-panel-secret` **and `x-orderbook-acting-token`**, then calls `resolvePanelActor` — panel-secret-only auth runs uploads as the panel's fallback role, changing who may upload and mis-attributing every image in the audit trail. Two HTTP routes replace `product:image:upload`/`image:fetch`; `maxHttpBufferSize` drops 60 MB → 4 MB; ship both panels together. Rasters: a five-line promise gate shared by `image.service.ts` and `avatar.service.ts` (they contend for one libvips heap), `sharp.cache({memory:64,files:0})`, **leave `sharp.concurrency` alone** (pinning it to 1 makes every upload single-threaded as well as serial), delete `readBackMaster`.

**H6 things that only grow.** Sweep the `failures` map inside `purgeExpiredSessions` — **and do not delete Stage 4's re-auth loop in the same function.** Prune stale update downloads after a passing checksum *and* on the already-intact early return (master needs nothing — its `update.service.ts` reads a folder and never downloads). `pruneExports` goes in `document-render.service.ts` (where exports live) using `removeStoredFile` and the stored `storage_path`; **`retainExports` stays `null`** — defaulting it to 180 bulk-deletes a year of PDFs on the first sweep after deploy. **Orphaned image variants sweep at startup only**, beside `sweepOrphanTemporaries()`; on a 15-minute timer it races `normalizeAndStore`, which writes four `.webp` files before the row is inserted, and deletes a live upload. Every async task hung off the interval needs its own `.catch` — there is no `unhandledRejection` handler.

**H7 office.** Move the four `masterConnection.on(...)` handlers to **module top level** (`createApp()` is called 5+ times across office tests) with `setMaxListeners(0)`. Only `snapshot` and `sync.onSyncEvent` go through a 120 ms coalescer that builds `forCurrentUser(view)` **once** and returns immediately when `streams.size === 0`. `change` keeps sending the small masked per-record frame — it is **already wired**; the real gap is that `office/web/src/App.tsx:219-241` listens for `status`, `snapshot` and `conflict` only. `getView` memo on `{snapshotRev, outboxRev}`, cleared by `resetLocalStore`. Replace the hand-rolled ack timeout with `socket.timeout(15_000).emitWithAck(...)` — ~25 lines deleted.

**H8 pool:** `acquireTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, reapIntervalMillis: 5_000`. `max: 10` stays.

**Not doing:** `liveReferencesToProduct` parallelism (hand-triggered, and a transaction serialises it anyway); `outbox.store.ts`'s whole-file write (its comment is right — a torn record is a lost sale); a continuous benchmark.

**Done when:** the query-budget test asserts 3; `change-ring.test.ts` proves the entity partition is total; `sync-delta.integration.test.ts` compares a delta-replaying panel and a snapshot-taking one as **id-keyed maps with `sync.hlc`, order-insensitive** (byte-identical is unachievable: `upsert` prepends while `buildSnapshot` orders by name, and snapshot rows are rate-masked while `data:changed` payloads are raw); a restricted-party grant is honoured by the very next `emitPartyScopedChange` and an invalidated session receives nothing.

**Size:** large — 5 new files, ~30 modified.

---

### Stage 8 — Product & party attributes (E, part 2)

Requirement 8. Migration `20260315000000_product_trade_and_ceramic_attributes`.

14 columns on `products` (MRP, purchase rate, GST %, UOM, barcode, brand, shade, calibre, water absorption, PEI, edge type, surface texture, application, origin plant); `min_stock_level`/`max_stock_level` on `inventory_stock` (**reorder point already exists** as `reorder_level` — renaming it churns `countLowStock`, `mapStockLevel`, the route and the mutation kind for zero behaviour change); `batch_no`/`shade`/`calibre` on `stock_movements` with a partial index.

**Batch/lot is deliberately not a product column.** One product receives many lots; a column is false the second inbound. True lot-level on-hand means re-keying `inventory_stock` from `(tenant_id, product_id, colour)` through reservations, line-item quantities, `reservedTotals`, `countLowStock`, dispatch settlement and the document renderer — a workstream, not a column. What ships answers "which lot is this" from the movement ledger, which is the data that upgrade would start from. **Tell the owner this is a deliberate refusal of the requirement as literally written, replaced with the correct model.**

`field.purchaseRate.view`/`.edit`, group `pricing`, `MINIMUM_TIER: 'management'`. Stage 1 already landed `ProductVisibility` and the `maskChangeEvent` fix, so this stage only adds the keys and the columns to the mask.

Migration parts: (A) 14 columns then eight CHECKs — `ADD COLUMN` with a constant default is catalogue-only on PG 11+, each `ADD CONSTRAINT CHECK` takes ACCESS EXCLUSIVE and a full scan (milliseconds on a shop catalogue); (B) partial-unique barcode index matching `idx_products_code_tenant` as redefined at `20260305000000:71-73`, plus a brand index; (C) stock columns with `CHECK (max >= min)`; (D) `CREATE OR REPLACE FUNCTION products_search_refresh()` — **write out all thirteen `setweight` terms in full**, the eight originals verbatim from `20260302000000:598-606` plus barcode A, brand B, shade C, surface_texture C, origin_plant D, then backfill with `UPDATE products SET updated_at = updated_at;`; (E) grant the two new keys **in JS with inlined literals**.

`down()` restores the eight-term function body **written out in full** and re-runs the backfill.

**Compile-blocking `Product` literals the design must not miss:** `office/tests/snapshot-masking.test.ts:53-80` (inside a `SyncSnapshot`-typed fixture), `office/src/sync/local-store.ts:283-318 provisionalProduct`, `master/tests/mappers.test.ts:143-160`. `purchaseRate` is declared **optional** — that is what makes masking-by-absence legal.

Four new `FIELD_LIST_KEYS` force four `GROUP BY` blocks in `field-usage.repository.ts` (`SOURCES` is `Record<FieldListKey, …>` — a compile error until they exist). No seeding: `unlisted` already surfaces values in data. No backfill from `parameters` JSONB — `catalog.integration.test.ts:123-131` stores arbitrary keys, so any mapping is a guess.

**No product export exists today.** When Stage 9 adds one it takes a `ProductVisibility` and **omits** the purchase-rate column entirely rather than blanking it.

**Size:** medium-large — 1 migration, ~20 modified.

---

### Stage 9 — Picker, dense forms, grid entry, report exports (D)

Requirements 9 and 15. **No migration** — the tsvector + GIN index from `20260302000000:587-657` already gives the required ranking.

**Prefix search.** `prefixTsQuery(term)` → `'gla:* & ser:*'`; `likePrefix(term)` escaping `\%_` (real product codes and tile sizes contain `%` and `_`). `pickProducts`/`pickParties` return full rows; `COALESCE(... ILIKE ...)` on the `exact_prefix` boost with `ORDER BY exact_prefix DESC NULLS LAST` — `false OR NULL` is `NULL` and Postgres `DESC` defaults to NULLS FIRST, which sorts non-matching rows *above* the true prefix hits. `limit + 1` fetched so `truncated` is honest. The `include` branch sits **outside** the active/deleted guards (a selection never vanishes mid-edit) and **inside** the tenant and party guards. A separate include-only query runs when `prefixTsQuery` returns `null`, which is what makes the idle pinned/recent state work.

Two kinds only: `product`, `party`. `'lead'|'order'` are served by existing list endpoints; **`'user'` is dropped** — `listUsers` requires `users.manage` while the Recycle Bin filter is gated on `recycleBin.viewAll`, so a pick kind there 403s people who have a working filter today. That filter's real bug (`withDeleters` builds options from pages already fetched) is fixed with a **distinct-deleters facet** on the recycle-bin endpoint. **There is no `maskParty`** — parties carry no money field; only `partyScopeSql` applies. `searchKind()` is deleted (verifiably dead).

**Office offline pick** calls `pickFromView(kind, query, forCurrentUser(await localStore.getView()))` — **never `getView()` raw**, which leaks another person's restricted parties and leaks `rate` to an actor without `field.saleRate.view`. It also gates on `userSession.sessionPermissions()` (the offline counterpart of `requirePermission`) and merges outbox-provisional rows online *and* off. `shared/src/domain/pick-score.ts` is the one scorer both sides use. Honest cost: offline the picker sees `SNAPSHOT_LIMIT = 500` per collection plus the outbox, and the listbox says so in a `--state-offline` footer.

`failForward(res, error)` extracted and used by **all four** forwarders — `forward`, `forwardCsv`, `forwardFile` and pick. Three copies exist today, not two.

**`ui/Picker.tsx` is written once** into `@orderbook/ui` (Stage 3 made this possible; without it, both `PartyAccessScreen.tsx` copies and both `api.ts` clients would have needed byte-identical edits *now* to keep the parity test green). 150 ms debounce via a single `useDebounced` in `@orderbook/ui` — replacing the two that exist. Every fetch carries an `AbortController` and drops a resolved-but-aborted response. Keyboard: ↓/↑, Home/End, PageUp/Down ±8, Enter, **Tab selects and advances**, Escape closes then clears, Alt+↓, Ctrl+Enter creates, Ctrl+P pins. Recents/pins in `localStorage` via Stage 3's `readJson`/`writeJson`; pinned ids ride in `include`. **Three** selects convert (`InventoryScreen.tsx:688`, `DocumentsScreen.tsx:892`, and the office `Combobox` sites); **22 stay native** — every one is a closed enum, a curated `option_lists` set, or a server-supplied facet, and a native select is keyboard- and screen-reader-complete for free.

**Dense forms.** `ui/FieldGrid.tsx` — `Field` renders an outer `<div data-span>` **around** `FormField`, because `FormField` owns the `.ob-field` div and a wrapper cannot add an attribute to it. `repeat(auto-fill, minmax(13rem,1fr))` so the column *count* falls as UI scale rises, with no media query. Party → centred modal, `.ob-modal--lg`, all 14 columns. Product → `ProductsScreen.tsx` + `ProductEditorScreen.tsx` published through `useSubNav` (available in office too, since Stage 3 moved `SubNavSlot` into the shared package). **Two flat nav items**, not a `catalog` parent — `AppShell.tsx:24-30` states the rule outright, and a parent id absent from the switch renders a blank content area.

**Office keeps its drawers, converted in place.** `ProductDrawer` and `PartyDrawer` are used by `CatalogScreen` (create and edit), `PartyDetail`, `ProductDetail` and `AddLeadScreen:570`. Convert both to `FieldGrid` sections inside `Modal`, widening ProductDrawer 8 → 22 fields and PartyDrawer 5 → 14. **The field coverage is the change that matters; the container is secondary.** `ui/Drawer.tsx` and `.ob-drawer*` are deleted at the end of this stage.

**Grid voucher entry.** Extract `useRowWindow` out of `DataTable` (with an external `scrollTop` seam) — but **`LineGrid` does not use it**: a voucher is tens of lines, and windowing an editable grid unmounts the input under the caret, which paste-from-Excel growing rows downward hits immediately. Reuse `ColourQuantityGrid`'s stepper, its keep-the-typed-text rule and its totals footer. Paste reads `text/plain` and splits on `\r?\n` then `\t` (Excel emits TSV; a CSV parser is the wrong tool). Fix the live inconsistency: `DraftLine` gains `rateTouched`, and a party or party-wise-mode change re-rates every untouched line.

**Report exports.** `REPORT_COLUMNS` in `shared/src/domain/reports.ts`. **Redaction rule: the money column stays, its cells go empty** — `master/src/lib/csv.ts`'s header states it ("a redacted money column is an empty cell, never `0`") and `master/tests/reports.integration.test.ts:196-199` pins the header row for a rate-blind actor. Absent-key is the JSON wire rule, not the tabular one. csv `''`, xlsx blank, pdf em dash. `?format=&columns=&groupBy=&totals=&paperSize=&orientation=` defaulting to today's output byte-for-byte. **Office must be widened or the export is corrupt**: `forwardCsv` casts the ack to `{csv:string}` and always sets `text/csv` with `${report}.csv`; widen the ack to a discriminated union and route non-csv through `forwardFile`. PDF via a new `pdf/table-renderer.ts` reusing the existing primitives — **not** through `renderPdf`, whose closed eight-member `DocumentColumnKey` is what keeps a rate column out of a rate-blind PDF. **`exceljs` ships last**, behind csv and pdf and behind the office binary fix; Excel opens CSV, so it buys number formats and a frozen header row. SheetJS is rejected (npm `xlsx` frozen at 0.18.5 with two CVEs).

**Every new string is a multi-file change:** two `MessageKey`s in `en.ts` **and** `hi.ts`, ~12 picker/grid UI keys, and every report column label. After Stage 3 this is one catalogue instead of three, which is the whole reason Stage 3 comes first.

**Size:** very large — ~10 new files, ~35 modified.

---

### Stage 10 — Keyboard system (G)

Requirement 5. Pure half in `shared/src/keys/{chord,commands,bindings}.ts` (DOM-free — `shared`'s `lib` is `["ES2022"]`); React half now **written once** in `@orderbook/ui`, not 5 files × 2 panels, because Stage 3 landed.

Three matching rules that are not optional: digits/F-keys/named keys match on `event.code` (macOS Option+1 delivers `key === '¡'`); letters match on `event.key.toLowerCase()` unless `alt` is set, in which case `event.code` (macOS Alt+K is `˚`, and master binds `0.0.0.0` so a Mac browser on the LAN is a real client — office binds `127.0.0.1` and is loopback-only); an `alt`-only chord requires `ctrlKey === false` (AltGr reports as Ctrl+Alt).

**Command titles come from the folded catalogue**, reusing the keys the sidebar already renders (`nav.master.dashboard`, `nav.leads`, …) so the palette and the sidebar cannot drift. *This supersedes the G design's "no new keys in shared" position, which was written against forked panel dictionaries that Stage 3 deleted.* Only ~24 chrome strings are new. Same collapse applies to Stage 11's `logs.actorType.*`.

**Four composition fixes:**
- `useOverlay` registers Escape at document **capture** with `stopPropagation()`, so Escape inside an open `Combobox` inside a `Modal` closes the modal — a live bug in both panels. Escape moves to bubble with a `defaultPrevented` guard; Tab keeps capture.
- **Modality:** while `document.querySelector('[role="dialog"]')` is non-null the resolver skips `screen`-scope registrations entirely. Without this, F2/F5/F7/F9 fire on the screen behind the scrim — `ScreenScope`'s `active` is about tab visibility, not modality. A dialog registers its own `record.save` inside itself, so Ctrl+S in a drawer still saves the drawer.
- **Escape and Tab are never in the chord index at all** (`isReservedChord` refuses them). That, not listener phase, is what keeps `KeyboardProvider` out of the overlay's way — the provider registers first among document-bubble listeners.
- Mount `KeyboardProvider` in `App()` beside `ToastProvider`; `MasterPanel` early-returns Splash/FirstRun/SignIn before `SaveShortcutProvider`. Render the palette in AppShell's `overlays` slot so it is the **last** `[role="dialog"]` in the document.

**Alt+number resolves against `CommandDef.navOrder`**, not rendered index (`nest()` filters nulls). The office list must follow the office sidebar's actual order — dashboard, leads, orders, **conflicts**, products, parties, partyAccess, settings, updates. **Handlers call master's `navigate(id)` verbatim** (which asks `subNav.onExit()`), and office's `goToTab` gains a confirm before `setAddingLead(false)`. Without that guard the office nav commands are not registered: Alt+N must not be an easier way to lose a half-filled form than the sidebar.

**Palette Records** calls `search()` with `query.kinds` — **not** `searchKind()`, which uses `requirePermission` and would 403 the whole query for a user missing one kind. Offline, it renders the existing `t('search.failedOffline')` and falls back to a substring scan of the merged `LocalView` already in memory, which is already masked and party-scoped by `SNAPSHOT_POLICY`. Deleting `searchFailedOffline` without this would leave the office panel — whose normal state is offline — showing an empty Records list with no explanation.

**`useEnterToAdvance` takes a container ref, not a form.** `grep -rn "<form"` returns exactly **three** hits in both web apps; every drawer and editor is bare `FormField`/`Input`. It walks `ref.current.querySelectorAll(FOCUSABLE)` reusing the constant already at `useOverlay.ts:21`. "Submit on last field" becomes "run the top-of-stack `record.save` registration". No `<form>` elements are added. Excludes `[data-keys-grid]`, which Stage 9's LineGrid sets.

**Electron: nothing.** Stage 2 already shipped the accelerator pin, the F5 swallow, the two menu items and `DesktopBridge.onMenuCommand`. This stage adds the renderer listener whitelisting ids against `COMMANDS_BY_ID`. **No renderer→main `MenuDescriptor`** — it invents a trust boundary into the shell requirements 1 and 7 exist to stabilise, for a native menu nobody asked for, and its own pinned test is unwritable (`shared/tests` cannot import `main.ts`, and `main.ts` cannot import from shared at runtime because `electron-builder.yml` ships no `node_modules`).

Bindings persist in `localStorage` (`ob.keys.v1`, keyed by userId) through Stage 3's `readJson`/`writeJson`. A keyboard is a property of a machine, exactly as theme/density/motion already are. Accepted cost: remaps do not follow a user to another panel. **No migration.**

**Ships unit-untested where it matters:** the `useOverlay` phase change needs a manual pass over every Modal and Drawer in both panels before merge.

**Size:** medium-large — 4 new files (once, not twice), ~15 modified, plus deleting `SaveShortcutSlot.tsx` and `SearchBox.tsx`.

---

### Stage 11 — Public API + connectors (J)

Requirement 13. Migration `20260316000000_public_api_and_connectors`.

**Three deletions from the design, all of which shrink it:**
1. **No `master_config.api_enabled` column.** Stage 4 shipped the settings table; `externalApi.enabled` is a `SETTINGS` key. One less schema change and one less place the switch can live.
2. **No per-key party pinning.** `api_key_parties`, `ActorContext.partyIds`, `PartyScope.onlyPartyIds` and the three-helper widening are all deleted. Requirement 13 never asks for them, and widening only the three *list* predicates leaks on every single-record read and every write: `party-access.service.ts:256 levelForParty` opens with `if (scope.seesAll) return 'manage'`, and `party-scope.ts:67 levelFor` returns `'manage'` for any party with zero grants. A key pinned to A would pass `requirePartyAccess` on any unassigned B. A key's party scope is its owner's; narrow keys are made by owning them from a narrow user.
3. **No `broadcastDashboard` debounce here** — Stage 7 owns it. A 500-row import firing 500 full dashboard aggregates per admin socket is real, and it is already fixed.

**The migration's permission grant must be JavaScript.** `role_permissions` was **dropped** at `20260303000000_roles_and_users.ts:78`; permissions have lived as a JSONB array on `roles.permissions` ever since. `INSERT INTO role_permissions …` raises `relation does not exist`, the transaction aborts, Knex refuses to complete the run, and the Master boots to the failure page — the 2026-08-27 class of incident. Follow `20260311000000_storage_permission_grant.ts` verbatim, inlining and freezing the key list, importing nothing from `@orderbook/shared`.

**Every child table carries `tenant_id`**, including `api_key_scopes`, `api_connector_resources`, `api_connector_field_maps` — `backup.repository.ts:52-58 tenantScopedTables()` keys purely on that column's presence and `loadTables` leaves a tenant-less table untouched on a selected restore.

**`PATCH /api/v1/{parties,products}/:id` is read-merge-write against an UNMASKED repository read** (`productRepo.findProductById` / `partyRepo.findPartyById`) and refuses 403 if the body names a field the key may not see. Reading through the masked service read would have `maskProduct` remove `rate` and `columnsFrom` write `null` — silently zeroing the catalogue price for a key without `field.saleRate.view`. Stage 1's patch semantics are the hard gate for this whole surface.

**SSRF guard: require `http:`/`https:` and reject only the Master's own origin.** Loopback and private ranges are **allowed** — the shop LAN has no internet and the named target (Miracle/Hermes) runs on the shop PC itself. Blocking `127.0.0.0/8` would make the feature useless.

Key auth: sha256 + `timingSafeEqual`, not scrypt (256 bits of machine entropy verified per request; scrypt caps the API near 25 req/s on one core). Actor is its own principal for audit (`actor_type='api_key'`, `actor_id`= the uuid, both inside the hash chain covering `actor_type`/`actor_id` but **not** `actor_name`) and bound to a user for authority. Route through Stage 7's `resolveSessionWithPermissions` — `permissionSetForRole` issues a `roles` SELECT on **every** call before consulting its cache, so a key request is not free.

`api_enabled` off → the v1 router answers **404 itself and never calls `next()`**; `next()` falls into `app.use('/api', dataRoutes)` whose `requireAuth` answers 401, and the SPA catch-all `/^(?!\/api).*/` never matches an `/api` path. Failed key auth is **not** written to `activity_log` — every insert takes `pg_advisory_xact_lock(hashtext(tenant_id))`, so key-spraying would serialise every audited write in the company.

Connector credentials go through Stage 4's `secret-box` (`credential_ref`, never a column named `secret_key`). Dry run enforced before first import; `mapping_version` bumped by any field-map write. Writes go through the services with `actorType:'connector'` and `run_as_user_id` (`systemActor` has `permissions: null` and `requirePermission` refuses everything). Conflicts use `on_conflict` per field, not the HLC — a remote `updated_at` is not causally ordered with ours; `flag` is offered only for the eight fields `conflict.service.ts:24-44` can restore.

`master/tests/i18n-tokens.test.ts` scans `master/src/services/*.service.ts` for `(entityType, action)` literals and fails if the pair has no catalogue token, so the `activity.api_key.*`/`activity.connector.*` tokens must land in the same commit as the services that record them.

**Office: nothing, both directions.** It binds loopback (so an API there is unreachable by the machines that want it), its writes are outbox-queued, and it can resolve neither links nor conflicts. No `SyncSnapshot` collection, so `SNAPSHOT_POLICY` is untouched.

**Size:** very large — ~18 new files, ~15 modified, 1 migration.

---

### Stage 12 — AI section (I)

Requirement 12. Migration `20260317000000_ai_assistant`.

All provider calls originate in the Master process. One OpenAI-compatible streaming transport, three profile constants, no dependency (Node 22 `fetch` + `AbortSignal`). **Generated SQL is refused**: party scope and rate masking run *above* the SQL, so a generated query bypasses both by construction, and making it safe means re-expressing the party rule as RLS — the nine-times duplication `party-access.repository.ts`'s header exists to prevent.

**Three deletions Stage 4 earns:** the encrypted `dataDir/secrets/ai.json` fallback (F shipped `secret-box`), the "if F slips" branch entirely, and the twelve non-secret keys' storage design (they are `SETTINGS` entries).

**Transport reuses the two live channels.** Master browsers already hold a Socket.IO connection in `ROOM_MASTER_ADMINS`; office browsers already hold an SSE stream at `/api/events`. **No per-run EventSource, no per-run SSE route.** `MasterConnection` attaches **one** `socket.on('ai:event')` at construction and re-emits; the HTTP layer fans out from a module-level `Map<runId, Set<Response>>`. One listener per run on an emitter with no `setMaxListeners` that already carries four per open stream would compound an existing warning — Stage 7 set `setMaxListeners(0)`, but the per-run pattern is still wrong.

**`ai:start` acks the instant the run row is inserted and the request is dispatched — never on completion.** `office/src/realtime/master-connection.ts:346-353` rejects every command after 15 s as `unreachable`, which `forward()` turns into a 503; the Office UI would report the Master offline while the run is still going.

**Provider capabilities are probed, not assumed:** the Test button issues one 40-token generation with a trivial tool declared (Ollama exposes `tool_calls` only for models whose template declares them, and Qwen2.5-VL-7B is not reliably one); the parser accumulates `delta.tool_calls[].function.arguments` fragments across frames; every request sends `stream_options: { include_usage: true }` or the token counts, cost display and budget all read zero.

**Fifteen read tools**, each one call to an existing service with the caller's own actor. `AI_TOOLS: Record<AiToolName, AiTool>` — **no generic** (`AiTool<A>` uses `A` in return position, so `Record<…, AiTool<never>>` does not compile) — and say plainly that `type Permission = string`, so the `Record` catches a *missing* tool and only the test catches a bad permission. The control against prompt injection is **the absence of authority**: no write tools, no free-form string reaching SQL or a path, no network tool. Worst case is a wrong answer, never an action. Untrusted output renders as plain text; a record reference is clickable only if its id is in that run's own `tool_trace`.

**Insights: SQL computes, the model narrates**, and the figures always render — with AI off the sentence comes from the catalogue. The slow-moving-stock query must be rewritten: `inventory_stock` has **no `created_at`** (the `20260302000000` rebuild left id, tenant_id, product_id, colour, quantity_boxes, reorder_level, updated_at) and is keyed per (product, colour), so aggregate per product with `SUM(s.quantity_boxes)` and anchor on `COALESCE(MAX(m.created_at), MIN(s.updated_at))`. That query carries **no** `partyScopeSql` — stock has no party column anywhere.

**Vision operates only on gallery images.** `imageFileBytes` resolves through `resolveImageFile`, which requires a `product_images` row. "Read a code off a box" means upload through the existing pipeline first, then run vision naming that `imageId`. Send the **`large`** (800 px) variant, not `master` (2048 px) — four times the visual tokens for no gain on a printed code.

**Audit** via `recordDetachedActivity(entry, actor, db())` — `recordActivity` requires an open transaction and an AI run has none. `activity_log` is append-only by trigger and is not swept by `ai.retentionDays`, so `details` carries only `{runId, kind, provider, model, promptTokens, completionTokens}`. `ai.manage` metadata **omits `subject_kind`/`subject_id`**: `ai.manage` is admin tier while `party.accessAll` is management, so they are independent keys and subject ids would enumerate restricted parties. `rates_visible` is enforced on read.

**Off switch, non-contradictory:** `GET /api/ai/status` **always answers**, returning `{enabled:false}` when off; every other `/api/ai/*` answers 404. The tab hides on `enabled:false` and on a 404 from status (an older Master) — the same rendering.

**Proposal apply: drop the false fifth gate.** `productRepo.updateProduct` does `version + 1` unconditionally and `ProductInput` has no `expectedVersion`; there is no version check on products or parties. The endpoint reads, merges accepted fields, re-reads `version` and refuses if it moved — last-write-wins with a cheap compare, stated plainly. It cannot ship before Stage 1, which it does not, and the merge is against an unmasked repository read for the same reason as Stage 11's PATCH.

**Master-side product affordances become possible** because Stage 9 shipped `ProductsScreen`. Per-screen entry points open in **centred modals** per the standing rule.

**Optional 5th migration:** if duplicate detection ships, `20260318000000_search_extensions` creating `pg_trgm`, `fuzzystrmatch`, `unaccent` (all present in the vendored PG 17 distribution; **pgvector is not**, so there is no embeddings path). This is currently **orphaned** — I's design assigns it to "the search workstream" and D's design explicitly says "not doing". Assign it here or drop duplicate detection; do not leave it unassigned.

**Size:** very large — ~13 new files, ~25 modified, 1-2 migrations.

---

## 2. Conflicts, and who owns what

| File | Owner (stage) | Everyone else does instead |
|---|---|---|
| `ui/src/base.css` (one file after S3) | **S5** `.ob-content`/`.ob-pane`; **S6** the rem sweep and every existing declaration | S9, S10, S12 **append** a banner-commented block; none rewrites an existing rule. S6 runs before them and must sweep `.ob-pane`. Only S6 touches `.ob-combobox-listbox`'s 240 px cap — S9 leaves it. |
| `ui/src/tokens.css` | **S6** exclusively | S12 appends one `--ai-note-line` (`--accent-tint` already exists at `:55`) |
| `master/web/src/App.tsx`, `office/web/src/App.tsx` | **S5** owns the `ScreenSpec[]` structural rewrite; **S7** the revision plumbing; **S10** provider mounting + topbar-search deletion + nav guards | S9 and S12 add **ScreenSpec entries**, never a switch case. Nobody re-adds `dataRevision` or `REFRESHING_ENTITIES`. |
| `api.ts` (both) | **S7** owns `request<T>` internals exclusively | S2 deletes `health()`; S4, S9, S11, S12 **append methods only** |
| `ui/src/DataTable.tsx` | **S5** — one edit doing the scroller fix, the `offsetHeight` row measure and `viewportW` | S6 adds `priority` + `fitColumns.ts`; S9 extracts `useRowWindow` with the external `scrollTop` seam. Nobody reads `--row-h` through `getComputedStyle` again. |
| `ui/src/Modal.tsx` | **S6** — `'xl'` + `expanded`/`onToggleExpand` | S9 converts the two form drawers and deletes `Drawer.tsx` at the end of S9 |
| `ui/src/useOverlay.ts` | **S5** visibility filter + focus-restore edge; **S10** Escape phase split + `export FOCUSABLE` | Nobody else |
| `data.routes.ts` | **S11** owns the `paging()` extraction to `http/query.ts` | S8 widens the stock body; S9 adds `/pick/:kind`, `kinds`, the deleters facet — all against the in-file `paging()` |
| `office/src/http/app.ts` | **S1** masking (`maskChangeEvent`, `forCurrentUser`); **S2** the health route body only; **S7** `streamEvents` + listener wiring + memo; **S9** `failForward` + pick + report layout | S12 appends five `/api/ai/*` routes and one SSE event type. **Nobody touches `SNAPSHOT_POLICY`** — no stage adds a collection. |
| `master/src/index.ts` | **S2** — the module-scope `shutdown(reason)` collapse and the `disposables` seam | S4, S11, S12 each register **one** disposable. None re-shapes the function. |
| `auth.service.ts#purgeExpiredSessions` | **S4** adds the re-auth loop; **S7** adds the `failures` loop | Neither deletes the other's |
| `shared/src/protocol/socket.ts` | Strictly sequential: **S7** (`seq`, `sync:delta`) → **S9** (`pick:query`, `report:export` union) → **S12** (`ai:*`) | Each appends. `socket-contract.test.ts` parses only `ServerToClientEvents`. |
| `shared/src/i18n/en.ts` + `hi.ts` | **S3** owns the 1401-key fold | S1, S4, S8, S9, S11, S12 append. **S10's "no new keys in shared" is void after S3** — there are no panel dictionaries left. |
| `SettingsScreen.tsx` | **S4** establishes the server-backed card pattern | S6 (Scale), S10 (Keyboard), S12 (AI) each append one card |
| `electron/main.ts` (→ `electron/shell.ts`) | **S2** exclusively, including S10's menu items and S6's `minWidth: 1024` | S10 adds only the renderer-side `onMenuCommand` listener |
| `roles.permissions` JSONB grants | S8, S11, S12 each rewrite it | All three use `[...new Set([...stored, key])].sort()` and **inline their literals** |
| `broadcastDashboard` debounce | **S7** (250 ms) | S11's 500 ms proposal deleted |
| `PartyAccessScreen.tsx` ×2 | Byte-identity is enforced; **S3** does the one identical repoint + header rewrite | S9 must not touch it — the Combobox→Picker change is unnecessary once `Picker` lives in `@orderbook/ui` and `Combobox` is deleted from one place |

---

## 3. Duplication collapsed

| Mechanism | Invented by | One owner |
|---|---|---|
| Debounce (2 existing + 3 proposed) | SearchBox 200 ms, office topbar 180 ms, D 150 ms, G 180 ms | **`useDebounced` in `@orderbook/ui`**, written in S9; both existing sites are deleted by S6/S10 |
| Request cancellation / dedup | H1, D's picker, G's palette, B's `let cancelled` | **H1's `request<T>` + `useResource`** (S7). S5 must **not** delete the `let cancelled` blocks. |
| Row windowing | B's scroller fix, C's row measure, D's `useRowWindow` | **One S5 edit**, then S9 extracts the seam. LineGrid opts out. |
| Session + permission resolution (3 queries × 5 sites) | H2, and J's false "it's cached" claim | **`resolveSessionWithPermissions`** (S7); S11's key auth routes through it |
| Dashboard broadcast debounce | H3a 250 ms, J 500 ms | **H3a** (S7) |
| `forward()` error branch (3 live copies) | D | **`failForward()`** (S9), all four forwarders |
| Fan-out withholding decision | H4's replay, the live path, J's pinning | **`mayReceive(actor, event, grants)`** (S7); J's pinning deleted |
| Secret sealing at rest | F's `secret-box`, I's `ai.json`, J's `credential_ref` | **F's `secret-box`** (S4); I's fallback file deleted entirely |
| Key-value configuration store | F's `settings`, J's `master_config.api_enabled` | **F's `settings`** (S4); J's column deleted |
| `localStorage` typed read/write | C's scale, G's `readJson`, B's `usePersistentState`, D's recents | **`ui/src/theme.ts` + `readJson`/`writeJson`** (S3) |
| `isTypingTarget` | office `App.tsx:320`, G | **G**, hoisted into the provider, deleted from App |
| Focusable-element selector | `useOverlay.ts:21`, G's new list | **`useOverlay`**, exported |
| Enter-to-advance | G's hook, two office drawers' ad-hoc handlers | **G's hook**; the two ad-hoc handlers deleted |
| Image variant long edges | `master/src/domain/images.ts` (server-only), C's hardcoded copy | **`shared/src/domain/entities.ts`** (S6); `IMAGE_VARIANT_SPECS` builds from it |
| "Port X into office" tasks | D's SubNavSlot port, G's office TopbarActions slot | **Both deleted** — S3 moves the master-only `ui/` files into the shared package |
| `Record<ClosedUnion, …>` compile tripwire | `SNAPSHOT_POLICY`, `MERGEABLE_COLUMNS`, `REPORT_COLUMNS`, `PUBLIC_API_ROUTES`, `AI_TOOLS` | **Not duplication** — same idiom, five domains. Keep all five; name the idiom in `docs/`. |

---

## 4. Migrations — the complete ordered list

Registry rules, verified against the source this session: `index.ts` array order is what Knex follows; new entries go **after `20260313000000_party_access` and before the pinned `20260309000000_new_module_permission_grant`**; the ascending-timestamp assertion excludes `DELIBERATELY_LAST`; duplicate timestamps are permitted but duplicate names are not; every filename starts with 14 digits; `SHIPPED` gains a name only once it has run on a real installation and **never loses one**.

Three workstreams independently claimed `20260314000000`. Allocated by stage order:

| Order | Filename | Stage | Tables touched | New tables → `DATA_TABLES` (FK order) |
|---|---|---|---|---|
| 1 | `20260314000000_settings_and_password_vault` | 4 | creates `settings`, `user_password_vault`; FK to `tenants` | `user_password_vault` **before** `users`; `settings` **before** `master_config` |
| 2 | `20260315000000_product_trade_and_ceramic_attributes` | 8 | `products` (14 cols + 8 CHECKs + 2 indexes + `products_search_refresh` rewrite), `inventory_stock` (2 cols + CHECK), `stock_movements` (3 cols + index), **`roles.permissions`** | none |
| 3 | `20260316000000_public_api_and_connectors` | 11 | creates 7 `api_*` tables; `activity_log` actor_type CHECK; **`roles.permissions`** | `api_connector_runs`, `api_connector_links`, `api_connector_field_maps`, `api_connector_resources`, `api_connectors`, `api_key_scopes`, `api_keys` — after `id_map` |
| 4 | `20260317000000_ai_assistant` | 12 | creates `ai_runs`; FK to `office_panels`; **`roles.permissions`** | `ai_runs` before `office_panels` |
| 5 *(conditional)* | `20260318000000_search_extensions` | 12 | `CREATE EXTENSION pg_trgm, fuzzystrmatch, unaccent` | none |

**Same-table collisions, flagged:**
- **`roles.permissions` is rewritten by migrations 2, 3 and 4.** They run in sequence so they compose, but each must read `id, tenant_id, permissions`, filter the array to strings, skip if the key is present, and write back `JSON.stringify([...new Set([...stored, key])].sort())` — following `20260311000000_storage_permission_grant.ts` verbatim — and each must **inline its key literals**. A migration is a fixed historical fact; importing `@orderbook/shared` makes it move. (Note that `20260303000000:331` already breaks this rule with a live `allPermissions()` import; that is why every new capability auto-grants to a fresh install's Administrator, and it is why Stage 4's toggle, not its permission, is the vault's real control.)
- **`products`** is touched only by migration 2. **`activity_log`** only by 3 (DDL only, so `activity_log_immutable()` never fires). No other overlap.

**Bookkeeping per migration:** the file; an `import * as x from './<name>.js'` in `index.ts`; an array entry in the position above; a `DATA_TABLES` entry per new table in `master/tests/helpers/fixtures.ts`, children before parents. **Do not edit `SHIPPED` in any of these stages.** Add each name only after that version has run on a real installation.

**Stage 0 corollary:** two names already in `SHIPPED` currently reference untracked files. Until Stage 0 lands, the `SHIPPED` guarantee is fiction.

---

## 5. The blocker list — all 51, and where each is resolved

**[A] Electron — all resolved in Stage 2.**

| # | Blocker | Resolution |
|---|---|---|
| A-1 | "Office has no `/api/health`" is false — it exists at `:75` above `requireUser` at `:218` | Delete `office/src/http/health.ts` from the plan; extend the existing route in place with `panel`, `version`, `interfaces`, loopback fields, `satisfies PanelHealth` |
| A-2 | "Office has no error handlers" is false — `:833`/`:834`, defined locally from `:839`, `return app` at `:836` | Drop A3 entirely; leave the handlers file-local |
| A-3 | `app.setName()` already landed; `setPath('userData')` would wipe every viewer's `localStorage` | Keep `setName()` and the lock-loss dialog; **never** `setPath`; correct the "Not doing" line |
| A-4 | Deriving live `status` from `bootStatus()` breaks `http-api.integration.test.ts` | Live app hardcodes `status:'ok'` + `boot: bootStatus()`; only `boot-app.ts` derives |
| A-5 | Shutdown handlers register 60-90 s too late on first run | Module-scope `shutdown(reason)` + module-scope `SIGINT`/`SIGTERM`/`message`/`disconnect`, before `main()`; net deletion of one function |
| A-6 | `types: ["node","electron"]` fails TS2688 | `types: ["node"]` + `"exclude": ["tests"]` |
| A-7 | `dataDir`/`logFile`/`installerDir` leak over the `0.0.0.0` unauthenticated health route | Spread in only when `req.socket.remoteAddress` is loopback; type them optional |
| A-8 | `serverEnv` illustrated without `process.env` → no `PATH`/`SystemRoot`, `initdb` fails | Shell builds `{...process.env, ELECTRON_RUN_AS_NODE:'1', ...serverEnv(ctx)}`; `serverEnv` returns overrides only |

**[B] Shared UI + keep-alive — B-1..B-3 in Stage 3, B-4..B-6 in Stage 5.**

| # | Blocker | Resolution |
|---|---|---|
| B-1 | `party-access-screen-parity.test.ts` pins two screens byte-identical | S3: one identical repoint + identical header rewrite keeping the literal `byte-identical`; test kept, docstring updated |
| B-2 | Three real React 19 breakages (`Tooltip.tsx:13`, `useOverlay.ts:23`, `Combobox.tsx:32`) | S3: one edit each, after the move, so once not twice |
| B-3 | `i18n-sync` stub change strips placeholders → ~141 assertions red | S3: fix `readKeys`' value parser; keep emitting the English text under the TODO marker |
| B-4 | `useSubNav`'s teardown deletes the sidebar entry `<Activity>` was meant to preserve | S5: `SubNavProvider` keeps a ref `Map`; no clear on teardown; cleared by close action or `resetNonce` |
| B-5 | Office `App.tsx:665-750` is not a switch; `updates`/`settings` sit above the `!view` gate | S5: two-tier `ScreenSpec[]`; `waitingFirstSync` in ScreenHost's place until first snapshot |
| B-6 | `useOverlay`'s "last dialog" picks a hidden pane's Drawer | S5: filter by `d.checkVisibility()`; same guard on focus-restore |

**[C] Scale & responsive — all in Stage 6 except C-3, which moves to Stage 5.**

| # | Blocker | Resolution |
|---|---|---|
| C-1 | `theme.ts`/`icons.tsx`/`PermissionGrid.tsx`/`base.css` are forks, not mirrors | S3 hand-merges the four; only `tokens.css` and `reset.css` copy wholesale, pinned identical **after line-ending normalisation** |
| C-2 | The two proposed tests break `npm run typecheck` (no DOM lib, no `jsx`) | S6: extract DOM-free `fitColumns.ts`; add `"lib":["ES2022","DOM"]` to `tsconfig.test.json`; **drop `theme-scale.test.ts`**; fold the rest into one fs-reading `ui-conventions.test.ts` |
| C-3 | `--row-h` as rem makes `parseFloat` return 2.2857 → ~10,000 rows; the proposed fix rests on a false coupling | **S5**: measure the first `<tr>`'s `offsetHeight` in the existing `ResizeObserver`; deletes the `@property` registration, the guard and its test |
| C-4 | srcset cannot be implemented (server-only module, 503 offline, wrong `w` arithmetic) | S6: **drop srcset**; pick one variant from `slotCssPx * devicePixelRatio`; move long edges into `shared` |

**[D] Pickers & forms — all in Stage 9 except D-1, subsumed by Stage 3.**

| # | Blocker | Resolution |
|---|---|---|
| D-1 | Parity test forces byte-identical edits to both `PartyAccessScreen.tsx` | **Dissolved by S3**: `Picker` lives in `@orderbook/ui`, `Combobox` is deleted from one place, and the screen's only edit is S3's identical repoint |
| D-2 | Office offline pick uses raw `getView()` → leaks restricted parties and `rate` | `forCurrentUser(await localStore.getView())` + `sessionPermissions()` gating |
| D-3 | `maskParty` does not exist | Drop the claim; parties carry no money field; only `partyScopeSql` |
| D-4 | Every new string is a multi-file change across three dictionaries | **Reduced to one catalogue by S3**; enumerate the two `MessageKey`s (`en.ts` **and** `hi.ts`) and the ~12 UI keys |
| D-5 | Dropping money columns breaks `reports.integration.test.ts:196-199` and `csv.ts`'s stated rule | Keep the header, empty the cell — csv `''`, xlsx blank, pdf em dash |
| D-6 | Deleting the office drawers breaks four screens and has no possible replacement | Keep both drawers, convert in place to `FieldGrid` inside `Modal`, widen the field sets (8→22, 5→14) |

**[E] Attributes & data loss — E-1 and E-2 in Stage 1, E-3 in Stage 1 (columns map).**

| # | Blocker | Resolution |
|---|---|---|
| E-1 | `maskChangeEvent`'s `if (allowed) return event;` is not a call site — leaks `purchaseRate` | Compute both dimensions: `if (vis.rates && vis.cost) return event;`, pass `vis` into `maskProduct` |
| E-2 | `setStockLevels` reintroduces whole-record replace and binds `undefined` | Build INSERT columns and the SET clause from the asserted subset only; return unchanged when empty; never bind `undefined` |
| E-3 | Full `PRODUCT_COLUMNS` on `mergeUpdate` puts CHECKs and an FK on an unvalidated write path whose failures are permanent | `validateProductInput()` called from **both** the service and `mergeUpdate`; `MERGEABLE_PRODUCT_COLUMNS = PRODUCT_COLUMNS − categoryId` |

**[F] Vault & settings — all in Stage 4.**

| # | Blocker | Resolution |
|---|---|---|
| F-1 | "Granted to nobody" is false — `20260303000000:331` uses a live `allPermissions()` | State the truth: a fresh install's Administrator holds it from day one; only an upgrade starts empty. **`security.passwordRevealEnabled` is the control.** |
| F-2 | `writePermission` deadlocks on upgraded installs and blocks the purge switch | Drop `writePermission` entirely. `settings.manage` gates writes; `users.viewPassword` gates the reveal endpoint. |
| F-3 | Required `SyncSnapshot.settings` breaks offline start and two office tests | Cut `audience`/`SharedSettings`/`readSharedSettings`/the snapshot change/the policy entry. Every setting here is Master-only. |

**[G] Keyboard — G-1..G-4 in Stage 10, G-5 in Stage 10, plus G-2's shell half in Stage 2.**

| # | Blocker | Resolution |
|---|---|---|
| G-1 | `useEnterToAdvance` has nothing to attach to — only three `<form>`s exist | Container ref + `querySelectorAll(FOCUSABLE)` reusing `useOverlay.ts:21`; "last field" = run `record.save` |
| G-2 | Renderer→main `MenuDescriptor` invents a trust boundary; its pinned test is unwritable | Static main-owned menu; one-way `webContents.send('orderbook:menuCommand', id)` with a fixed id set. **Ships in Stage 2**, not as a second pass over the same 250 lines. |
| G-3 | `nav.*` wired to `setTab`/`goToTab` destroys drafts | Call master's `navigate(id)` verbatim; office's `goToTab` gains a confirm before `setAddingLead(false)` |
| G-4 | Deleting `searchFailedOffline` removes the office panel's only offline search handling | Palette renders `t('search.failedOffline')` and falls back to a substring scan of the in-memory `LocalView` |
| G-5 | No suppression rule — F-keys fire on the screen behind an open Modal | While `[role="dialog"]` exists, the resolver skips `screen` scope and considers `overlay` then `global` |

**[H] Performance — all in Stage 7.**

| # | Blocker | Resolution |
|---|---|---|
| H-1 | `scopeForAdminSocket` admits dead sessions (`sessionPermissions` returns `[]` for an unknown token) | Drop it; route `actorForRecipient` through `resolveSessionWithPermissions` — one query, null-on-dead-session preserved |
| H-2 | `refreshSessionsForRole` runs inside transactions that can roll back | Delete it entirely; `resolveSession`'s per-call role-version re-read is the documented contract |
| H-3 | Delta silently drops `party_variant`, `sync_conflict`, `reservation` | `REPLAYABLE_ENTITIES` exported once; those three force a full snapshot; `change-ring.test.ts` asserts the partition is total |
| H-4 | Delta replays `DIRECTORY_ENTITIES` — the whole staff list and every role's permissions | One `mayReceive(actor, event, grants)` shared by live and replay |
| H-5 | A restarted panel's delta is applied into a null snapshot and discarded | Hydrate `this.snapshot ??= await localStore.restore()` on connect; send a cursor only with a persisted `{bootId,lastSeq}` written in the same disk write |
| H-6 | Shared GET dedup + per-caller abort destroy each other | Refcount `{promise, controller, waiters}`; abort the shared controller only at zero |
| H-7 | `requirePanel` loses the acting user → wrong permissions and mis-attributed audit | Read the acting token too and call `resolvePanelActor`; 401 when `tokenAccepted` is false |
| H-8 | Timer-based orphan-variant sweep deletes live uploads | Startup only, beside `sweepOrphanTemporaries()` |

**[I] AI — all in Stage 12.**

| # | Blocker | Resolution |
|---|---|---|
| I-1 | `s.created_at` does not exist on `inventory_stock`; per-colour rows split one product | Aggregate per product; anchor on `COALESCE(MAX(m.created_at), MIN(s.updated_at))`; join movements on (tenant, product) only |
| I-2 | `ai:start` would always fail from Office (15 s command ceiling) | Ack the instant the run row is inserted and the request dispatched; every token travels on `ai:event` |
| I-3 | `recordActivity` requires a transaction; an AI run has none | `recordDetachedActivity(entry, actor, db())` |
| I-4 | "404 everything" + "hide on `enabled:false`" cannot both hold | `GET /api/ai/status` always answers `{enabled:false}`; everything else 404s; the tab hides on either |
| I-5 | Apply path claims a transaction it does not have and a version check that does not exist | Read → merge → re-read `version` → refuse if moved. Last-write-wins, stated plainly. Ships after Stage 1. |

**[J] External API — all in Stage 11.**

| # | Blocker | Resolution |
|---|---|---|
| J-1 | `INSERT INTO role_permissions` — table dropped at `20260303000000:78`; aborts the run, Master boots to the failure page | Grant in JS following `20260311000000` verbatim; inline and freeze the key list |
| J-2 | Per-key party pinning leaks on every read-one and every write (`levelForParty`'s `seesAll` shortcut, `levelFor`'s unassigned rule) | **Delete the sub-feature.** A key's party scope is its owner's. |
| J-3 | `PATCH` is a full replace, and merging through a masked read nulls the rate | Read-merge-write against **unmasked** repository reads; 403 if the body names an unseeable field; gated on Stage 1 |

---

## 6. Risk

**1. The repository is not durable, and nothing in the programme survives that.** Two SHIPPED migrations, the whole Party Access module, the whole update subsystem and the desktop layer exist only in one working directory. A `git clean -fd`, a bad merge resolution, or a disk failure turns every installed Master into *"The migration directory is corrupt"* — data intact and unreachable, which has already happened once on 2026-08-27. **Guard:** Stage 0, one commit, first, containing nothing else, verified by a fresh clone running `npm run verify`. Do not start any other stage until that commit is pushed.

**2. The password vault. Bluntly.** Once `security.passwordRevealEnabled` is on, every password of every person who signs in online afterwards is recoverable by anyone with Administrator on the shop PC — the key file and the cluster sit on the same disk. The encryption stops a copied database file and a stolen `.obbackup`, and nothing else. Inside the app it is one admin-tier permission — which a fresh install's Administrator **already holds**, because `20260303000000:331` grants via a live `allPermissions()` — plus a re-typed password away. `fixtures.ts:244` gives the key to every `testActor()`, so **no test in the suite proves the permission gates anything**; only the toggle does. People reuse passwords, so the blast radius is their email and their bank, not this app.
**Guards, all mandatory and none of them sufficient:** off by default; every stored plaintext deleted in the same transaction that turns it off; re-authentication before every reveal; POST + `no-store` + its own route so it can never ride along in a list response; an immutable `activity_log` row per reveal on a table that refuses UPDATE and DELETE by trigger; the vault table excluded from backups **in the same commit that creates it**; and seven source-reading invariants in `password-vault-invariants.test.ts` proving `open()` has exactly one caller and the string `user_password_vault` appears in exactly three files under `master/src`.
**Residual, to be said to the owner in writing:** misuse is made *visible*, not *prevented*. That is the most that can honestly be offered, and the owner has accepted it.

**3. The `<Activity>` bet.** Stage 5 — and therefore requirement 4, and therefore Stage 10's `ScreenScope` — rests entirely on React 19.2's `<Activity>` existing and tearing down hidden children's effects as documented. If it does not, requirement 4 has no cheap implementation: the alternative is a visibility gate inside all four slot providers plus every `revision`-keyed refetch. **Guard:** a half-day spike immediately after Stage 3's React upgrade, against the real `master/web/src/App.tsx` with two screens, verifying (a) `!!require('react').Activity`, (b) a hidden pane's `useEffect` cleanup actually runs, and (c) `checkVisibility()` returns false for a `display:none` ancestor in Chromium 130. If any fails, stop and re-plan Stage 5 before Stages 6-12 are scheduled around it.

**4. Stage 3 is where the programme most likely goes red for a week.** A 1401-key fold, 15 template-literal call sites, 5 already-broken call sites, 3 React 19 type breakages, 45 files moved, four hand-merged forks, and a workspace whose frontend has **never once been typechecked**. **Guards:** Stage 0's two `typecheck` scripts land first so `npm run verify` can see the damage; the fold and the upgrade are two commits, not one; `shared/tests/i18n-coverage.test.ts` is extended with a static scan of every literal `t('...')` across `ui/src` and both web apps *before* the panel dictionaries are deleted, so a missing key is a test failure rather than a raw key rendered in the shop.

**5. Partial-patch semantics change the meaning of an omitted key in three protocols at once.** After Stage 1, absent means untouched for sync mutations, for the Stage 11 REST API and for the Stage 12 connector. Any consumer that sends a full object with nulls to clear fields keeps working; any consumer that omits a field expecting it to clear silently stops. **Guard:** the contract goes in `shared/src/domain/columns.ts`'s header, in the OpenAPI document's description, and in a regression test per write path proving a two-field patch leaves the other columns intact.

---

## 7. Verification

**Continuous, every stage:** `npm run verify` (= `lint && typecheck && test`), with `typecheck` now including both web workspaces and `electron/`. 62 existing test files, ~757 assertions, `fileParallelism: false`.

**The seven forcing functions that must stay green at every stage, and which will catch the specific mistakes each stage is prone to:**

| Test | Catches |
|---|---|
| `migration-registry.test.ts` | A migration file with no array entry; a deleted SHIPPED name; a broken array order |
| `credential-invariants.test.ts` | Stage 4 leaking `password_hash` into a list query or onto `User` |
| `party-access-screen-parity.test.ts` | Stage 3/9 editing one panel's copy and not the other |
| `i18n-coverage.test.ts` | Stage 3's fold losing a placeholder; any stage adding an EN key without HI, or a 3+ digit run, or `₹` |
| `i18n-tokens.test.ts` | Stages 4/11/12 recording an `(entityType, action)` pair with no catalogue token, on an append-only table |
| `socket-contract.test.ts` | Stages 7/9/12 breaking `ServerToClientEvents` |
| `snapshot-masking.test.ts` + `SNAPSHOT_POLICY`'s `Record<keyof SyncSnapshot, …>` | Any stage adding a collection without a masking decision — **no stage does; that is deliberate** |

**Per-stage "done":**

- **S0** — a fresh clone of `dev` runs `npm ci && npm run verify` green.
- **S1** — a name-only product update leaves 19 columns intact; an offline `uom:'crate'` merge is a readable `ValidationError`, not a Postgres CHECK error; a soft-deleted product is absent from `/api/search`; `search.integration.test.ts:116-131` green.
- **S2** — `electron/tests/*` green; both **packaged** panels start; each closes by its window button with no error dialog and no surviving `postgres.exe` on 55432; killing the shell's process tree shuts the server down; a deliberately-broken migration shows the boot failure page.
- **S3** — `no-duplicate-ui.test.ts`; the extended i18n static scan; both panels build and render **visually unchanged**; office is still light-themed and master still dark.
- **S4** — vault refused while the toggle is false even for a key holder; a bcrypt-hashed account seals correctly on its **first** sign-in; a `.obbackup` contains no `user_password_vault` key; the toggle set to false empties the table in the same transaction.
- **S5** — filters, scroll, drawers and half-typed forms survive a tab round-trip on all 23 screens; Reset clears exactly one; no table renders >~40 rows at 1080p.
- **S6** — the manual matrix: both panels at 1024×768 / 1366×768 / 1920×1080 / 3840×2160 × 79% / 100% / 157% × three sidebar modes. No horizontal body scroll, every modal fits, the filter bar scrolls rather than clips.
- **S7** — `GET /api/parties` costs 3 queries; a delta-replaying panel and a snapshot-taking one agree as id-keyed maps with `sync.hlc`; a restricted-party grant is honoured by the next change; an invalidated session receives nothing.
- **S8** — the migration up/down round-trips on a populated cluster; `products_search_refresh` still ranks the eight original fields after the rewrite.
- **S9** — an exact `product_code` prefix outranks a higher-`ts_rank` fuzzy match **and** a row whose code and alias are both NULL; `%` in a term is not a wildcard; the default report export is byte-identical to today's for both a rate-permitted and a rate-blind actor.
- **S10** — the manual overlay pass: Escape in every Modal, Drawer, Combobox and popover in both panels; every F-key on every screen with and without a dialog open.
- **S11** — a key listing `products.view` whose owner's role lost it gets 403; a two-field PATCH leaves 20 columns intact; `verifyChain()` still returns `ok:true` after API-key writes.
- **S12** — with `ai.enabled` false, `/api/ai/status` answers `{enabled:false}`, everything else 404s, and no provider request is attempted; a party granted only to user A is absent from every tool run as user B; `rate` is an **absent key**, not null, for a rate-blind actor.

**End-to-end, before the programme is called done — on two real machines on one LAN, both panels packaged and installed:**
1. Fresh install of both. Pair the Office panel. First sync.
2. Office goes offline (unplug). Create a party, create a product, add a lead with lines. Reconnect. Watch the delta replay, not a full snapshot.
3. Master edits the same product's two fields through the new dense form. Confirm the other twenty columns survive.
4. Enable the reveal toggle, reveal a password, disable it, confirm the table is empty.
5. Issue an API key from a narrow user, PATCH a party through `/api/v1`, confirm the audit row shows `actor_type='api_key'` and the chain verifies.
6. Point a connector at a loopback endpoint, dry-run, import, re-import (zero writes).
7. Run the assistant against Ollama on the 16 GB machine and against the marginal one; confirm the warning and the measured tokens/sec.
8. The full display matrix from S6, at 1024×768 on the smallest screen in the shop.

---

## 8. Honest cost

| Stage | Size | New files | Modified | Hardest part |
|---|---|---|---|---|
| 0 Repo safety | trivial | 0 | 3 | Nothing. 30 minutes. |
| 1 Data-integrity core | medium | 2 | ~18 | Getting `stampFieldHlc` right at all seven sites; the merge engine has been off, so conflicts will appear where none did |
| 2 Electron | large | ~10 | ~12 | Proving `ELECTRON_RUN_AS_NODE` + an `'ipc'` stdio slot gives the child a working `process.send`/`disconnect` on Windows. The drain, the orphan fix and the graceful cluster stop all rest on it. |
| 3 UI package + i18n + React 19 | **very large** | ~8 | ~85 (45 moved) | The four forked files, and the fact that this is where the never-typechecked frontend gets typechecked for the first time |
| 4 Settings + vault | large | 8 | ~18 | Sealing the *post*-upgrade fingerprint, not the bcrypt one; and the same-commit backup exclusion |
| 5 Keep-alive + DataTable | large | 4 | ~25 | The three teardown-means-unmount dependencies, and office's two-tier `!view` gate |
| 6 Scale + responsive | large | 4 | ~40 (+~200 mechanical edits) | The rem sweep's blast radius, and doing it without a jsdom harness |
| 7 Performance | large | 5 | ~30 | The delta's three correctness holes — replayable set, directory withholding, snapshot hydration. Each is silent when wrong. |
| 8 Product attributes | medium-large | 1 | ~20 | Writing `products_search_refresh` out in full, twice (up and down), without dropping a `setweight` term |
| 9 Picker + forms + grid + reports | **very large** | ~10 | ~35 | The office offline pick's masking; and `exceljs`, which ships last |
| 10 Keyboard | medium-large | 4 | ~15 | The `useOverlay` phase change, which ships unit-untested |
| 11 Public API + connectors | **very large** | ~18 | ~15 | The field-mapping UI, and read-merge-write on an unmasked read without reintroducing the very bug Stage 1 fixed |
| 12 AI | **very large** | ~13 | ~25 | Provider capability probing — tool-call support, streamed argument fragments, and `include_usage` — none of which can be assumed |

**What will be hardest, in order:**

1. **Stage 3.** It is mechanical, enormous, and touches every UI file at once, with four hand-merges and a compiler that has never been pointed at this code. Everything after it is blocked. Budget more than it looks like.
2. **Stage 7's delta replay.** Three of its five blockers produce *silent* divergence — a party variant dropped, a directory leaked, a delta discarded into a null snapshot. None of them throws. The `change-ring.test.ts` entity-partition assertion is the only thing between the implementation and a panel quoting stale negotiated rates.
3. **Stage 2's Windows process lifecycle.** Windows has no signals, `child.kill('SIGTERM')` is `TerminateProcess`, `pg_ctl` detaches the postmaster, and `before-quit` + `preventDefault()` is the single change most likely to produce a window that will not close. Three independent mitigations, and it still needs a manual pass first.
4. **The two "very large" late stages (11, 12) landing on a tree that eleven prior stages have reshaped.** Both were designed against line numbers that will all be wrong. Both must re-read before editing.

**What is explicitly not being done, and has no owner:**

- **The 165-site `styles.css` className migration.** Stage 6 does only the zero-risk subset. The rest is its own workstream, on a file whose header documents an incident where an unguarded rule painted the entire sidebar blue.
- **TLS.** The Master binds `0.0.0.0` with no certificate. Stage 11's API key is exactly as confidential as the session cookie already is, which is to say not at all against a passive LAN sniffer. Self-signed certs on shop PCs plus an Electron trust-store entry is a support burden out of proportion to a ten-metre LAN — but it is a decision, not an oversight, and the owner should make it.
- **`hub.ts:86`'s `cors: { origin: true, credentials: true }`** — a pre-existing cross-site WebSocket-hijack hole. No stage extends it; no stage closes it. (Closed on 2026-09-24, outside this plan: the hub has no CORS option now and refuses a cross-site handshake, `master/src/realtime/socket-origin.ts`.)
- **Lot-level on-hand inventory.** Stage 8 ships the movement ledger that an upgrade would start from, and deliberately refuses batch-as-a-product-column.
- **A macOS build.** Stage 2 makes `release.mjs` platform-aware and adds the entitlements, but no Mac panel ships and none is code-signed. Requirement 10's "Mac/Retina screens" is a rendering requirement Stage 6 satisfies for a Mac browser on the LAN.
- **Recovery of already-damaged product/party rows.** Impossible from the activity log. Only a `.obbackup` or an Office snapshot holds the old values, and no recovery tool is being built for a bug that, on the evidence, has never fired on a shipped installation.