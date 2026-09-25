# Workstream A — Electron stability, lifecycle and packaging

sound=false

## Findings
- **blocker**: A2's headline claim — "Office gets a plain always-on route... That is the whole Office bug" — is false. `office/src/http/app.ts` already defines `GET /api/health` at line 75, mounted immediately after `express.json` at :60 and well above the `requireUser` gate at :218, and it already returns `{ status:'ok', boot:{state:'ready',step:'Ready',message:null,detail:null}, hasNetworkLink, port }` with a comment explaining exactly the shell-polling reason the design gives. The office shell is not stuck on its splash. (HEAD has requireUser at :194 and no health route; the working tree has the fix uncommitted, which is where the stale "established fact" came from.)
  - FIX: Delete `office/src/http/health.ts` from the plan. Extend the existing route in place: add `panel:'office'`, `version: appVersion()`, `interfaces: listLanInterfaces()` (already imported at :92) and the loopback-only path fields, and annotate it `satisfies PanelHealth`. Nothing above it moves.
- **blocker**: A3 is false. `office/src/http/app.ts` already ends with `app.use('/api', notFoundHandler)` at :833 and `app.use(errorHandler)` at :834, with both handlers defined locally from :839, carrying a comment that mirrors master's reasoning. `return app` is at :836, not :804. Creating `office/src/http/middleware/error-handler.ts` produces a second, unreachable copy.
  - FIX: Drop A3 entirely. If anything, note that office's handlers are file-local rather than in a `middleware/` module and leave them there — one file, one caller.
- **blocker**: A4's root cause is already fixed. Both mains now call `app.setName('OrderBook Master Panel'/'OrderBook Office Panel')` immediately before `requestSingleInstanceLock()` (master:285, office:279), with a comment naming the shared-`Electron`-userData collision. The lock-loss branch also now shows `dialog.showErrorBox(... already running ...)` — which the design's "Not doing" section proposes to remove. Worse, the extra `app.setPath('userData', appData/OrderBook/<panel>/shell)` is a data-loss change: it relocates the Chromium profile, so every existing viewer's `localStorage` is wiped on upgrade — today `ob.theme.v2`, `ob.density`, `ob.motion` (master/web/src/ui/theme.ts), and much more once the Settings workstream this design claims to unblock lands there.
  - FIX: Keep `app.setName()` as the single fix and carry it into the shared shell verbatim. Do NOT call `app.setPath('userData', …)`. Keep the already-added lock-loss dialog; correct the "Not doing" line.
- **blocker**: Routing master's live `/api/health` through a `panelHealth()` that derives `status` from `bootStatus()` breaks an existing test. `master/tests/http-api.integration.test.ts` builds the app with `createApp()` directly and never calls `bootReady()`, so `bootStatus().state` is `'starting'`; its assertion `expect(response.body.status).toBe('ok')` fails. The design then compounds it by proposing to add `expect(boot.state).toBe('ready')` to that same test, which fails for the same reason.
  - FIX: The live app hardcodes `status:'ok'` and attaches `boot: bootStatus()`. Only `boot-app.ts` derives `status` from the boot state. Both are annotated `satisfies PanelHealth`. Existing assertions stay green, and the shell's two checks (`status==='ok'`, `boot.state==='failed'`) remain correct against both apps.
- **blocker**: The IPC shutdown listener is placed where it cannot fire during the failure it exists for. `master/src/index.ts` registers signal handlers only inside `installShutdownHandlers` (called at :129) or `installFailedShutdownHandlers` (:141) — both AFTER `startPostgres()` and `runMigrations()`. On first run that is 60–90 s in which the child has no SIGTERM handler and no `message` handler, which is precisely the window in which an operator watching a splash gives up and closes it, and precisely the half-built cluster the design says it protects. Office has the same shape: the `shutdown` closure is created inside `main()` at :57, after `await loadCredentials()`.
  - FIX: Register the listeners at module scope, before `main()` runs, in both entrypoints. In master, hoist `let postgres: PostgresServerHandle|null` and the disposable resources to module scope and collapse `installShutdownHandlers` + `installFailedShutdownHandlers` into one module-level `shutdown(reason)` that tears down whatever is currently non-null — a net deletion, and it makes SIGINT/SIGTERM/`message`/`disconnect` all work from process start.
- **blocker**: `electron/tsconfig.json` is specified with `types: ["node","electron"]`. That does not compile: `types` entries resolve under `typeRoots`/`@types`, and `node_modules/@types` contains no `electron` (verified). tsc fails with TS2688 "Cannot find type definition file for 'electron'". Both existing panel tsconfigs correctly use `types: ["node"]` and pick up Electron's types through the `import { app } from 'electron'` specifier.
  - FIX: `types: ["node"]`. Also add `"exclude": ["tests"]` — otherwise the vitest files compile into `electron/dist`, ship inside the asar, and fail typecheck because `vitest` globals are not in `types`.
- **blocker**: `PanelHealth` puts `dataDir`, `logFile` and `installerDir` on master's `/api/health`, which binds `0.0.0.0` (master/src/config/index.ts `host: process.env.HOST ?? '0.0.0.0'`) and is unauthenticated by design, pinned by http-api.integration.test.ts. The design's only offered alternative is gating behind `attachSession`, which it correctly notes would break the shell — so it ships the leak.
  - FIX: Serve the three path fields only to loopback: `const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1'`, and spread them in only when `local`. Three lines, no new route, no auth, and the shell always polls `http://localhost:<port>`. Type them optional on `PanelHealth`.
- **blocker**: `PanelShellConfig.serverEnv(ctx)` is illustrated returning only `{ORDERBOOK_DATA_DIR, PORT, ORDERBOOK_LOG_FILE}`, and nowhere does the design say the shell spreads `process.env` underneath it. Today's code does (`env: {...process.env, …}`). A literal implementation hands the child an environment with no `SystemRoot`, `PATH`, `APPDATA`, `TEMP` or `USERPROFILE`; `initdb` and `pg_ctl` will not run, and the failure looks like a database that never starts.
  - FIX: State it explicitly: the shell builds `const env = {...process.env, ELECTRON_RUN_AS_NODE:'1', ...config.serverEnv(ctx)}` and then `if (app.isPackaged) delete env.DATABASE_URL`. `serverEnv` returns overrides only.
- **major**: A9's `ReleaseManifest` gaining `platform`/`arch` plus `latest-<platform>-<arch>.json` is scope the owner never requested. Requirement 10's "all Mac/Retina screens" is a rendering requirement owned by the responsive workstream, not a macOS build. The change rewrites the deployed Master↔Office update protocol (`/api/updates/office/latest` and `/download`, office `availableUpdate()`), changes `readManifest`/`availability` signatures used at ~10 call sites in `master/tests/updates.test.ts`, and the design itself admits it can strand installed 1.0.2 panels.
  - FIX: Drop the manifest change, the per-platform filenames and the query parameters. Keep only what is cheap and safe: a `--platform` flag on release.mjs, the mac/dmg block and entitlements plists so a Mac build is possible, and `shell.openPath(dmg)` for macOS `applyUpdate`. If a Mac panel ever ships, it gets its own `ORDERBOOK_RELEASES_DIR` — the folder is already the whole distribution story.
- **major**: `release.mjs --platform` is specified but the artifact assertion is not. `build()` at release.mjs:273-281 asserts `files.includes('OrderBook-<Label>-<version>-Setup.exe')` and throws otherwise. A `--platform mac` run produces `…-Setup.dmg` and the build fails after doing all the work.
  - FIX: Derive the extension from the platform (`win32 → exe`, `darwin → dmg`) and use it in both the expected filename and the electron-builder flag (`--win` / `--mac`).
- **major**: A8's generated `master/installer/ports.nsh` will not be found. A bare `!include ports.nsh` inside a script referenced by `nsis.include` resolves against makensis's working directory and `${NSISDIR}\Include`, not against the including file. And the whole apparatus — a new `DEFAULT_MASTER_PORT` in shared, a generated file, a `.gitignore` entry, and an `import('../shared/dist/index.js')` in the build script — exists to keep two integers from drifting.
  - FIX: No codegen. Leave `installer.nsh` as literals and add a ~10-line unit test that reads the file and asserts it contains `localport=45789` matching `DISCOVERY_PORT` and `localport=4100` matching master's `intFromEnv('PORT', 4100)` default. If codegen is ever wanted, the include must be `!include "${BUILD_RESOURCES_DIR}\ports.nsh"`.
- **major**: A8's "honest cost" paragraph is wrong about the mechanism. `loadEnvFiles` skips any key already present in `process.env` (master/src/lib/env-file.ts:40 `if (!key || key in process.env) continue`), and the shell always injects `PORT`. So a packaged panel does not "leave a rule for the wrong port" — it ignores the `.env` `PORT` override entirely, and the documented escape hatch silently does nothing.
  - FIX: State the real behaviour, and if the override is meant to work, have the shell forward rather than force: `...(process.env.PORT ? { PORT: process.env.PORT } : {})` and read the effective port back from `PanelHealth.port` before building `ORIGIN`.
- **major**: `DesktopBridge` gains `getShellSettings`, `setShellSettings` and `openLogFolder` as required members. An installed shell exposes only `applyUpdate`, `panel`, `shellVersion`, and the interface's own doc-comment says a screen must treat the bridge as possibly absent — the same reasoning applies per-method across a version skew.
  - FIX: Declare the three new methods optional (`getShellSettings?(): Promise<ShellSettings>`), so a consumer is forced to branch.
- **major**: The single preload keyed on `--orderbook-panel=` in argv is unspecified (it needs `webPreferences.additionalArguments`, which the design never mentions) and it interacts with the newly-added `sandbox: true`, where the `process` shim is a subset. It is also unnecessary: `DesktopBridge.panel` has zero consumers — the only uses of the bridge are `desktopBridge()` truthiness and `.applyUpdate` (master UpdatesScreen:85 and :290; office UpdatesScreen:75 and :165).
  - FIX: Delete `panel` from `DesktopBridge` and the preload. One preload, no argv, no additionalArguments, no sandbox question. Keep `shellVersion` (`process.versions.electron` is available in a sandboxed preload).
- **major**: The Reuse section lists `office/src/config/paths.ts` `isInside()` as reuse for `resolveInstaller`. It is a private, unexported function in that module. Calling it reuse hides that this creates a second copy of a security-relevant containment check, and the design does not say which copy is canonical.
  - FIX: Say plainly that `electron/lib/installer.ts` re-implements it because the shell cannot import panel source, and pin both with the same test vectors — or export it from paths.ts and have office's own callers use the export.
- **major**: The proposed extension to `master/tests/boot-status.test.ts` — comparing the key sets of the boot app and the live app — needs `createApp()`, which pulls in knex, pg, sharp, pdfkit, fontkit and the whole route graph. The file is explicitly documented as "Pure: no cluster, no `describe.skipIf`, so it can never silently skip."
  - FIX: Delete that test. Annotating both health responses `satisfies PanelHealth` is the drift tripwire, enforced at compile time, which is strictly stronger.
- **major**: The hard-kill fallback is described as complete. It is not: `pg_ctl` starts the postmaster as a detached process, so `child.kill()` on the node child leaves `postgres.exe` running and holding port 55432. The design never says so.
  - FIX: Say what the fallback leaves behind, and note that it is survivable because `startCluster` returns early when `isClusterRunning()` (master/src/db/postgres-server.ts:255) — so the next launch adopts the orphan rather than failing on it.
- **major**: `createWindow()` returns early on `!ready` (master/electron/main.ts:196-201), so on a slow or failed start the window never gets `setWindowOpenHandler` and never nulls `mainWindow` in a `closed` handler. The design's restructure does not mention registering them at construction.
  - FIX: Register `setWindowOpenHandler`, the `will-navigate` guard, `render-process-gone`, `did-fail-load` and `closed` immediately after `new BrowserWindow(...)`, before any `loadURL`.
- **major**: Adding `- '!node_modules/**/*'` to both electron-builder.yml is an unmeasured installer-size optimisation inside a stability workstream, whose own stated failure mode is "the packaged shell fails to start". Neither panel has a nested `node_modules` (verified: `master/node_modules` and `office/node_modules` do not exist — everything hoists to the root), so the saving is unknown.
  - FIX: Move it to "Not doing". Measure the installer with and without it separately, after this workstream ships.
- **minor**: `stripWhenPackaged: readonly string[]` is a configuration array with one value, consumed at one site, for a case that only master has.
  - FIX: `if (app.isPackaged) delete env.DATABASE_URL` unconditionally in the shared shell. Office never sets it, so deleting it is a no-op there.
- **minor**: `master/src/db/postgres-platform.ts` is a new file to hold a function that is already exported from `postgres-server.ts`.
  - FIX: In `vendorPostgres()`, `const { embeddedPostgresPackageDir } = await import('../master/dist/db/postgres-server.js')` — a dynamic import, because `master/dist` only exists after `run('npm',['run','build',…])` at release.mjs:232, which precedes the call at :235.
- **minor**: `master/web/src/api.ts` `health()` and its hand-copied `BootStatus` have zero consumers — nothing in either web app calls them. The design's "mirror defect" (`body?.boot ?? null` returning null once the Master is up) is dead code.
  - FIX: Delete `api.health()` and the local `BootStatus` interface rather than re-pointing them at a shared type.
- **minor**: Line numbers throughout are stale and the working tree is changing under the design: office `requireUser` is :218 not :196, `return app` is :836 not :804, `SNAPSHOT_POLICY` is not at :949, master's `releaseDirFor` is not at :185.
  - FIX: Cite behaviour and symbol names, not line numbers, and re-read `office/src/http/app.ts` and both `electron/main.ts` immediately before editing — they were modified during this review.
- **minor**: The splash builds an HTML document and interpolates `message` into it before `encodeURIComponent`, so HTML structure survives decoding. Only the fixed `boot.step` strings are passed today, but the design widens what the splash shows.
  - FIX: Escape `<`, `>` and `&` in the message before interpolation.

## Corrected design

## A — Electron stability, lifecycle and packaging (corrected)

**Verdict.** The desktop layer is one ~300-line shell duplicated twice, uncommitted, untypechecked and untested. Three of the original design's four headline defects have already been fixed in the working tree and must not be re-done. What is genuinely broken is the *process lifecycle*: the child's `exit` handler treats a clean exit as a crash and quits the app (requirement 1 verbatim), `before-quit` force-kills PostgreSQL on Windows without waiting, the server registers its shutdown handlers 60–90 s too late to protect a first-run cluster, and a failed installer launch permanently suppresses every future crash report.

**Read before editing.** `office/src/http/app.ts`, `master/electron/main.ts` and `office/electron/main.ts` changed during review. Re-read them.

### A0. Commit the desktop layer first

`master/electron/`, `office/electron/`, `master/installer/`, `office/installer/`, both `electron-builder.yml` and `tools/release.mjs` are untracked (`??`), not ignored. The shippable product is one `git clean -fd` from gone and CI has never compiled it. Commit them as their own commit on `dev`, before any edit in this design, separate from the ~70 already-modified files.

`.gitignore`'s `dist/` already covers `*/electron/dist/`. No new ignore entries.

Root `typecheck` is `npm run typecheck --workspaces --if-present && tsc -p tsconfig.test.json`; the top-level `electron/` is not a workspace, so append `&& tsc -p electron/tsconfig.json --noEmit`. Lint already covers it (`eslint .`, and `tseslint` matches `.ts`/`.cts`).

### A1. One shell, two thin entrypoints

New top-level `electron/` (not a workspace; it resolves `electron` and `@types/node` from the root):

```
electron/tsconfig.json     outDir dist, module NodeNext, types ["node"], exclude ["tests"]
electron/shell.ts          runPanelShell(config) — the only file importing 'electron'
electron/master.main.ts    ~25 lines
electron/office.main.ts    ~25 lines
electron/preload.cts       one, panel-agnostic
electron/lib/{health,installer,supervisor,log-file,settings}.ts   pure or node:fs only
electron/tests/*.test.ts
```

`types: ["node"]`, never `["node","electron"]` — there is no `@types/electron`; Electron's types arrive through the import.

```ts
export interface PanelShellConfig {
  readonly panel: PanelKind;              // shared/src/domain/version.ts
  readonly productName: string;           // matches electron-builder productName
  readonly port: number;
  readonly readyTimeoutMs: number;        // master 180_000, office 60_000
  readonly autoStartByDefault: boolean;   // master true, office false
  /** Overrides only. The shell spreads process.env underneath. */
  serverEnv(ctx: { dataDir: string; port: number; logFile: string; locationFile: string }): NodeJS.ProcessEnv;
}
```

The shell builds the child env as `{...process.env, ELECTRON_RUN_AS_NODE: '1', ...config.serverEnv(ctx)}` and then, when `app.isPackaged`, `delete env.DATABASE_URL` unconditionally (office never sets it). Spreading `process.env` is not optional: without `SystemRoot`, `PATH`, `APPDATA` and `TEMP`, `initdb` and `pg_ctl` do not run.

Master's `serverEnv` returns `ORDERBOOK_DATA_DIR`, `PORT`, `ORDERBOOK_LOG_FILE`, `ORDERBOOK_MASTER_SETTINGS_FILE` (beside the data dir); office's (`officeServerEnv` in `electron/lib/office-env.ts`) returns `ORDERBOOK_OFFICE_DATA_DIR`, `OFFICE_PORT`, `ORDERBOOK_LOG_FILE`, `ORDERBOOK_OFFICE_LOCATION_FILE` (`ctx.locationFile`, the shell's `office-location.json` — the record a storage move rewrites, because the shell passes the data dir in the real environment, which no settings file overrides) and `ORDERBOOK_OFFICE_SETTINGS_FILE` (beside that pointer, not beside the data dir, so it stays put when the data moves).

`app.setName(config.productName)` runs before `requestSingleInstanceLock()`, exactly as both mains already do. **No `app.setPath('userData', …)`** — it would relocate the Chromium profile and wipe every viewer's `localStorage` (`ob.theme.v2`, `ob.density`, `ob.motion`, and everything the Settings workstream will add). Keep the existing lock-loss dialog; extend `second-instance` to `if (!mainWindow) void createWindow(); else { restore(); focus(); }`.

**Build wiring.** `tools/release.mjs:233` compiles the shells today. Hoist it out of the per-panel loop to one `run('npx',['tsc','-p','electron/tsconfig.json'])`, then in `build(panel)` copy `ROOT/electron/dist` → `<panel>/electron/dist`. Both yml keep `files: - electron/dist/**/*` unchanged. Panel `main` becomes `electron/dist/master.main.js` / `office.main.js`. Leave `node_modules` alone — neither panel has a nested one and the saving is unmeasured.

### A2. One health shape, no new office route

Append to `shared/src/protocol/desktop.ts`:

```ts
export type PanelBootState = 'starting' | 'ready' | 'failed';
export interface PanelBootStatus { state: PanelBootState; step: string; message: string | null; detail: string | null; }
export interface PanelHealth {
  panel: PanelKind;
  status: 'ok' | 'starting';
  boot: PanelBootStatus;
  version: string;
  port: number;
  hasNetworkLink: boolean;
  interfaces: readonly { name: string; address: string; netmask: string; broadcastAddress: string }[];
  /** Loopback callers only. Absent over the LAN. */
  dataDir?: string;
  logFile?: string | null;
  installerDir?: string;
}
```

Both panels' existing `LanInterface` satisfies `interfaces` structurally; nothing moves.

- **Office already has this route**, at `office/src/http/app.ts` immediately after `express.json` and far above the `requireUser` gate, already returning `{status:'ok', boot:{state:'ready',…}, hasNetworkLink, port}`. Extend it in place with `panel`, `version` (`appVersion()`), `interfaces` (already imported), the loopback fields (`paths().dataDir`, `updatesDir()`), and `satisfies PanelHealth`. No `office/src/http/health.ts`.
- **Master needs one helper**, `master/src/http/health.ts`, because two apps answer: `boot-app.ts` derives `status` from `bootStatus()`; `app.ts` hardcodes `status:'ok'` and attaches `boot: bootStatus()`. Hardcoding is required — `master/tests/http-api.integration.test.ts` builds `createApp()` without ever calling `bootReady()` and asserts `status === 'ok'`. It is also honest: the live app is only installed once boot succeeded. `installerDir` is `releaseDirFor('master')`. `update.service.ts` imports no database code, so the boot app stays dependency-light.
- **Loopback gate**, three lines shared by both: include `dataDir`/`logFile`/`installerDir` only when `req.socket.remoteAddress` is `127.0.0.1`, `::1` or `::ffff:127.0.0.1`. Master binds `0.0.0.0` and this route is deliberately unauthenticated; absolute paths must not travel the LAN. The shell always polls `localhost`.

`master/web/src/api.ts`: delete `health()` and the hand-copied `BootStatus` — both have zero consumers.

Office's `notFoundHandler`/`errorHandler` already exist at the bottom of its `createApp()`. No new middleware file.

### A3. Server lifecycle: spawn, supervise, drain

**Windows has no signals.** `child.kill('SIGTERM')` is `TerminateProcess` there; the argument is ignored, so `installShutdownHandlers` has never run in production.

Spawn gains a fourth stdio slot: `['ignore','pipe','pipe','ipc']`.

**Both entrypoints get a module-scope shutdown broker, registered before `main()` runs.** This is the correction that matters: master registers its handlers only at `index.ts:129`, after `startPostgres()` and `runMigrations()` — 60–90 s on first run, which is exactly when an operator watching a splash gives up, and exactly the cluster this is meant to protect. In `master/src/index.ts`, hoist `postgres`, `hub`, `discovery`, `httpServer` and `sessionSweep` to module scope, collapse `installShutdownHandlers` and `installFailedShutdownHandlers` into one module-level `shutdown(reason)` that tears down whatever is non-null, and register at module scope:

```ts
process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('message', (m: unknown) => {
  if ((m as { type?: string } | null)?.type === 'orderbook:shutdown') void shutdown('shutdown request');
});
process.on('disconnect', () => void shutdown('parent gone'));  // shell died; do not outlive it holding the port
```

Net deletion of one function. `office/src/index.ts` gets the same, its `shutdown` closure hoisted out of `main()`. `disconnect` only fires when an IPC channel exists, so `npm run dev:*` is untouched. This is also the root fix for the orphaned server `boot-status.ts` apologises for as *"another copy of the Master Panel still running"*.

Shell side: `stopServer(grace = 10_000)` sets `quitting`, sends `{type:'orderbook:shutdown'}` when `child.connected` (else `kill()`), awaits `once(child,'exit')`, and hard-`kill()`s at the deadline. `before-quit` calls `event.preventDefault()` once, drains, then `app.quit()`, with an unref'd `app.exit(0)` at grace+5 s so the quit can never hang. 10 s because master stops discovery, the hub, HTTP, the knex pool and then `pg_ctl stop --wait`.

Honest cost of the hard-kill path: `pg_ctl` starts the postmaster detached, so killing the node child leaves `postgres.exe` alive holding port 55432. Survivable — `startCluster` returns early when `isClusterRunning()` — so the next launch adopts it rather than failing.

**Crash handling.** Today any child exit, *including a clean 0*, fires an error dialog and quits — the panel closing by itself. Replace with a bounded supervisor: an unexpected exit logs; up to 3 restarts inside 10 minutes respawn the server and reload the window; the 4th shows a `dialog.showMessageBox` with `['Restart','Open log folder','Quit']` naming the log path (`showErrorBox` has no buttons).

**The stuck `updating` flag.** Set before spawn and cleared only in `catch`, so an installer that starts and dies — or a cancelled UAC prompt — suppresses every crash report for the process's life. Becomes `updatingSince: number | null` with a 60 s window, decided by a pure function in `electron/lib/supervisor.ts`.

### A4. Window and renderer

`minWidth: 1024, minHeight: 640` (requirement 10's new floor, allowing for taskbar and title bar inside 768). `webPreferences` gains `sandbox: true`, `spellcheck: false`, `webviewTag: false`, `devTools: !app.isPackaged`; the DevTools menu role only when `!app.isPackaged`.

`url.startsWith(ORIGIN)` accepts `http://localhost:4100.evil.example`. Replace with `u === ORIGIN || u.startsWith(`${ORIGIN}/`)`, used by both `setWindowOpenHandler` and a new `will-navigate` guard, plus `session.setPermissionRequestHandler((_w,_p,done) => done(false))`.

All of `setWindowOpenHandler`, `will-navigate`, `render-process-gone` (reload once, then splash), `did-fail-load` (main frame only, ignoring `-3` ERR_ABORTED) and `closed` register **immediately after `new BrowserWindow(...)`** — today `createWindow` returns early on a timed-out start, so a slow boot leaves a window with no guards and a `mainWindow` that is never nulled. Add `process.on('uncaughtException')` and `('unhandledRejection')` and `app.on('child-process-gone')`, all writing to the log. Every `loadURL` moves behind `showSplash()` / `showPanel()` helpers that `.catch()` into the log. Escape `<`, `>`, `&` in splash text before interpolation.

`window-all-closed` becomes `if (process.platform !== 'darwin') app.quit()`, with an `activate` handler recreating the window.

### A5. Installer allowlist, logging, auto-start

**Installer path.** Today the shell accepts any renderer-supplied string ending `.exe`. The two panels' installers live in different places — master's under `releaseDirFor('master')`, office's under `<paths().dataDir>/updates` — so the shell captures `installerDir` from the `PanelHealth` it polled from localhost. `resolveInstaller(candidate, allowedDir, platform)` requires a string, a non-null `allowedDir`, containment, and the platform's extension (`.exe` on win32, `.dmg` on darwin). Containment re-implements the `isInside` idiom from `office/src/config/paths.ts` — that function is private, so this is a second copy, deliberately, because the shell cannot import panel source; both are pinned by the same test vectors. Add a one-line `updatesDir()` export in `office/src/services/update.service.ts` that `downloadPath()` then calls, so the allowlist and the download target cannot separate.

**Logging.** `process.stdout.write` goes to a discarded stream in a packaged windowed app, and the error dialog points at a directory holding only `postgres.log`. `electron/lib/log-file.ts` opens `<dataDir>/logs/<panel>.log`, rotates at 5 MB keeping 3, formats lines exactly like `master/src/lib/logger.ts` so shell and child read as one stream, and installs an `'error'` handler that switches to a null sink — a stalled writer back-pressures a full 64 KB pipe and hangs the child, the failure class `master/tests/postgres-launcher.test.ts` exists for. Unpackaged it tees to `process.stdout`. The path travels as `ORDERBOOK_LOG_FILE` → `config.logFile` → `PanelHealth.logFile` → the crash dialog's "Open log folder" (`shell.showItemInFolder`).

**Auto-start.** `setLoginItemSettings({openAtLogin:true})` runs on every packaged launch, silently overriding anyone who turned it off. The OS is the store (`app.getLoginItemSettings().openAtLogin`); the only state needed is "have we applied the first-run default", one boolean in `<dataDir>/shell.json` written temp-then-rename (the `outbox.store.ts` `persist()` pattern). Three IPC channels — `getShellSettings`, `setShellSettings`, `openLogFolder` — join `applyUpdate` on `DesktopBridge`, **declared optional**, because an installed shell exposes only the old surface and the interface's own doc-comment already requires callers to handle absence. Delete `DesktopBridge.panel`: it has zero consumers, and removing it means one panel-agnostic preload with no `additionalArguments` and no sandboxed-`process.argv` question.

### A6. Firewall ports

`master/installer/installer.nsh` hardcodes 4100 and 45789. No codegen: add `master/tests/installer-ports.test.ts` reading the `.nsh` and asserting the two literals equal `DISCOVERY_PORT` and master's `PORT` default. Note the real behaviour of a `PORT` override: `loadEnvFiles` skips keys already in `process.env`, and the shell injects `PORT`, so under a packaged panel a `.env` `PORT` is ignored outright. If the override must work, the shell forwards rather than forces (`...(process.env.PORT ? { PORT: process.env.PORT } : {})`) and reads the effective port back from `PanelHealth.port`.

### A7. macOS — what is in and what is not

In: `release.mjs` gains `--platform` (default: host; `darwin → --mac`, else `--win`), and the artifact assertion becomes extension-aware (`.dmg` vs `.exe`) — today it hardcodes `-Setup.exe` and would throw at the end of a Mac build. `vendorPostgres()` replaces the hardcoded `windows-x64` with `await import('../master/dist/db/postgres-server.js')` for `embeddedPostgresPackageDir()` — a dynamic import, because `master/dist` exists only after the build step that precedes it. No new `postgres-platform.ts`. Both yml gain a `mac` block (dmg, arm64+x64, `hardenedRuntime`, `identity: null`) and an `entitlements.mac.plist` carrying `allow-jit`, `disable-library-validation`, `allow-dyld-environment-variables` and, on the inherit plist, `com.apple.security.inherit` — hardened runtime strips `ELECTRON_RUN_AS_NODE` without them, which breaks the child-process architecture in a way that looks like the server never starting. `applyUpdate` on macOS is `shell.openPath(dmg)` then quit.

Out: the `ReleaseManifest` `platform`/`arch` fields and `latest-<platform>-<arch>.json`. Nobody asked for a macOS build — requirement 10's "Mac/Retina screens" is a rendering requirement the responsive workstream owns — and that change rewrites the deployed Master↔Office update protocol, both `/api/updates/office/*` routes, `readManifest`/`availability`, ~10 call sites in `master/tests/updates.test.ts`, and can strand installed 1.0.2 panels. A Mac panel, if one ever ships, gets its own `ORDERBOOK_RELEASES_DIR`.

### A8. Tests

`vitest.config.ts` include → `['{shared,master,office,electron}/tests/**/*.test.ts']`; `coverage.include` gains `electron/lib/**/*.ts`; `tsconfig.test.json` include gains `electron/tests/**/*.ts`. Everything in `electron/lib/` is pure or `node:fs`-only and never imports `electron`.

- `electron/tests/health-outcome.test.ts` — a 401 body and an unparseable body both yield `not-listening`, never `ready`; master's live body yields `ready`; `boot.state:'failed'` yields `failed`; a body with the other panel yields `wrong-app`.
- `electron/tests/installer-path.test.ts` — traversal, outside-dir, `.bat`/`.ps1`/extensionless, and null-allowlist all rejected; inside-dir `.exe` accepted and resolved; on darwin `.dmg` accepted, `.exe` rejected.
- `electron/tests/supervisor.test.ts` — exit 0 while quitting is not a crash; exit 0 while not quitting **is**; an expired `updatingSince` no longer suppresses; the 4th restart inside 10 minutes is refused and one after the window rolls is allowed.
- `electron/tests/log-file.test.ts` — rotation, `keep:3` retention, write-after-close does not throw.
- `electron/tests/shell-invariants.test.ts` — source assertions in the `postgres-launcher.test.ts` style: `'ipc'` in the stdio array, `event.preventDefault()` in `before-quit`, `devTools: !app.isPackaged`, a registered `will-navigate`, and `kill('SIGTERM')` is not the only stop path.
- `master/tests/installer-ports.test.ts` — the two `.nsh` literals match the constants.
- `office/tests/health-route.test.ts` — supertest against `createApp()`: `/api/health` is 200 with no session and reports `panel:'office'`, `status:'ok'`, `boot.state:'ready'`; `/api/snapshot` with no session is still 401, proving the mount opened no hole.

No new key-set-parity test: `satisfies PanelHealth` on all three call sites is a compile-time tripwire, and `master/tests/boot-status.test.ts` is documented as pure — importing `createApp()` there would drag in knex, pg, sharp and pdfkit.

### Migrations

None. No table, no column. The only new persisted state is `<dataDir>/shell.json`, owned by the shell, deliberately outside PostgreSQL because it must be readable before the server exists. `master/src/db/migrations/index.ts`, the `DELIBERATELY_LAST` pin and the `SHIPPED` list in `migration-registry.test.ts` are untouched. No `SyncSnapshot` collection is added, so `office/src/http/app.ts`'s `SNAPSHOT_POLICY` tripwire is untouched, no masking path changes, and `master/tests/helpers/fixtures.ts` `DATA_TABLES` is untouched.

### Risks

- `ELECTRON_RUN_AS_NODE` plus an `'ipc'` stdio slot must give the child a working `process.send`/`disconnect`. Verify on Windows first; the drain, the orphan fix and the graceful cluster stop all rest on it. Fallback: a loopback `POST /api/shell/shutdown` guarded by a per-launch secret in the child's env.
- `before-quit` + `preventDefault()` is the change most likely to produce a window that will not close. Mitigated twice (hard kill at grace, unref'd `app.exit(0)` at grace+5 s); test manually first.
- Committing four untracked directories may collide with the ~70 modified files already in the tree. Separate commit, first.
- The working tree is being edited concurrently by other workstreams. Re-read `office/src/http/app.ts` and both `electron/main.ts` immediately before editing; do not trust line numbers.

### Not doing

- Window bounds and monitor persistence — `shell.json` is where it belongs when the responsive workstream asks.
- electron-updater / Squirrel — no internet by design; the releases-folder flow exists and is tested.
- Code-signing certificates (Windows or macOS) — a purchase, as both yml already say. Unsigned, Gatekeeper blocks first launch on macOS (right-click → Open).
- Linux targets, a shared `electron-builder.base.yml`, `electron-log`/`winston`, moving `LanInterface` into shared, and `'!node_modules/**/*'` in the yml — each replaces something that already works, or is an unmeasured optimisation inside a stability workstream.
- Removing the single-instance dialog. It was just added deliberately; a silent exit is indistinguishable from a crash.
- Per-platform release manifests (see A7).
