# Design: Windows 7/8 legacy Office Panel build (Electron 22.3.27 = Chromium 108 + Node 16.17.1), alongside the Electron 33 main line; Master stays Windows 10+

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

There is one source tree and two compiled outputs. The Windows 7 Office build runs the same office/src server, the same office/web bundle and the same electron/ shell source as the main build. Only three things differ: the shell is compiled to CommonJS (Electron 22 cannot load an ESM main), it is packaged on Electron 22.3.27, and it names its artifacts and update channel 'win7'.

What the owner sees: the releases folder (and the GitHub release) gains OrderBook-Office-Win7-<v>-Setup.exe and OrderBook-Office-Win7-<v>-Standalone.exe. Each is one installer that holds both x64 and ia32. They carry the same appId, product name, data folder, NSIS hook and uninstall script as the normal Office, so a Win7 PC installs, updates over the LAN, uninstalls and keeps its data exactly as a Win10 PC does. A Win7 Office PC that is later upgraded to Windows 10 can install the normal build over it.

Updates: the Office server works out its release channel with releasePlatformFor(process.platform, process.versions.electron). That gives 'win7' when the Electron major is below 23, so no new env var is needed. It asks the Master for /api/updates/office/latest?platform=win7. The Master reads office-panel/latest-win7.json, polls GitHub for latest-office-win7.json once a Win7 panel has asked, and its sweep no longer treats Win7 .exe files as superseded Win10 .exe files. The Office also refuses any manifest whose signed platform is not its own, so an old Master can never hand a Win7 PC the Electron 33 build.

Node 16 compatibility inside office/src is a small boundary layer. A legacy-globals module installs undici 5's fetch/FormData/Headers/Request/Response and node:buffer Blob, but only when the globals are missing, so the Node 20 path is untouched. Readable.fromWeb becomes Readable.from on both lines. statfs is feature-detected, with a wmic fallback on Win7. server.closeAllConnections is replaced by tracked sockets.

The shell loses import.meta (its own folder now comes from app.getAppPath()) and global fetch (the health poll uses node:http). It gains an ia32 heap ceiling. Both web apps build with Vite target chrome108, and AbortSignal.any (Chromium 116) is replaced by a tiny anySignal helper in @orderbook/ui. That also lets a Win7 Chrome 109 open the Master UI over the LAN.

The uninstall script becomes PowerShell 2.0-compatible without changing its flags, so its four callers are untouched.

Keeping it that way: ESLint 'floor' blocks ban Node>16 and Chromium>108 APIs in office/src, shared/src, ui/src, the web apps and the legacy-compiled shell files. A static test locks the tsconfig libs to ES2022 (which already blocks ES2023+ builtins), the Vite targets, the CSS feature list and the PS2 constructs. A new Windows CI job downloads the real Electron 22 binary and boots office/dist under ELECTRON_RUN_AS_NODE, then exercises fetch, multipart and streamed download through the polyfill. Vitest 2 cannot run on Node 16, so this runtime smoke replaces 'run unit tests on Node 16'.

There are no migrations, permissions, settings, sockets or screens in this domain. Its output is a build line and a runtime floor that every other domain must respect.

## decisions

- Same source, two compile outputs. There is no forked code. The legacy line differs only in the shell module format (CJS), the Electron version (22.3.27), the artifact tag ('Win7') and the update channel ('win7'). The fork cannot drift, and every feature in the batch reaches Win7 automatically.
- No 'electron-legacy' npm alias. Both packages publish a bin named 'electron', so `npx electron` could start Electron 22, and every `npm ci` would download another ~100 MB. Instead the version is pinned once in tools/legacy-electron.mjs (LEGACY_ELECTRON = '22.3.27', the last 22.x; re-verify when implementing). electron-builder downloads it from that pin. The smoke job fetches it with the already-installed @electron/get + extract-zip, exactly as node_modules/electron/install.js does. No allowScripts entry is needed.
- Ship x64 and ia32 in one installer. Office has no native modules, and old Win7 office PCs are often 32-bit. electron-builder then emits one combined NSIS installer and one combined portable .exe. They are about twice the size, but artifact names stay the same and the manifest still names a single file.
- Same appId (com.orderbook.office), productName, executableName, data directory, installer.nsh and uninstall script as the main Office. Upgrades work in place in both directions, firewall, uninstall and data rules are unchanged, and the four uninstall callers stay as they are.
- Artifact names are OrderBook-Office-Win7-<v>-Setup.exe and OrderBook-Office-Win7-<v>-Standalone.exe. They keep the '-<v>-Setup.exe' shape, so the Master's isOurArtefact allowlist and release.mjs version matching still work. The Win7 marker sits before the version.
- The release channel is 'win7', added to ReleasePlatform. I did not use 'win32-legacy', because LEGACY_RELEASE_PLATFORM already means 'pre-platform manifests are win32' and the two would be confused. Files: latest-win7.json in the releases folder and latest-office-win7.json on GitHub. Release.mjs writes no latest.json shim for it.
- The channel is detected, not configured. releasePlatformFor(platform, electronVersion) returns 'win7' for win32 when the Electron major is below 23, otherwise process.platform. No new server env var is added, so electron/tests/server-env.test.ts is untouched.
- The Office refuses any manifest whose signed platform differs from its own channel. It logs, returns reason 'noRelease', and checks this before signature verification, since refusing is always safe. An un-updated Master maps unknown platforms to win32 and would otherwise offer the Electron 33 build to Win7. Docs say to update the Master first.
- Node 16 fetch: undici@5.29.0 (pure JS, engines >=14) as an exact-pinned Office dependency, installed onto globalThis only when the global is missing. It is loaded synchronously with createRequire, with no top-level await. I rejected `--experimental-fetch`: Node 16.15+ has it, but it is unverified under Electron 22's ELECTRON_RUN_AS_NODE and has no Blob global. I also rejected a hand-rolled http client: about 100 lines that would change masterFetch's Response contract and break module-forwarding.test.ts's `new Response(...)` mocks.
- One code path on both lines wherever the Node 16 form is equally correct: Readable.from(response.body) instead of Readable.fromWeb, tracked-socket destroy instead of server.closeAllConnections, and the node:http health poll in the shell. Two code paths only where Node 16 lacks the capability altogether: statfs (fs.statfs when present, else `wmic logicaldisk` on win32, else null, which callers already treat as unknown).
- The shell stays ESM on the main line. Legacy uses electron/tsconfig.legacy.json (module CommonJS, moduleResolution Node10, outDir build/shell-legacy, only the shell, office.main, preload.cts and the non-cleaner lib files) plus a written electron/dist/package.json of {"type":"commonjs"}. To make the source valid for both, shell.ts drops import.meta.url: `here` becomes path.join(app.getAppPath(), 'electron', 'dist'), which is the same folder in dev and in the asar.
- Web floor is Chromium 108. Both vite configs get build.target 'chrome108', which means less down-levelling than today's default chrome87, so it is safe for Electron 33. AbortSignal.any is replaced by anySignal() in @orderbook/ui. No PostCSS or lightningcss is added: the CSS is clean today (only :has, which needs 105, and scrollbar-width, which Chromium 108 ignores). Features above 108 (color-mix, oklch, nesting, text-wrap, popover and others) are banned by test, which matches the owner's 'semantic tokens only' rule.
- Guards: ESLint floor blocks (AST-based, run by `npm run lint` in CI), a static legacy-floor test, a runtime smoke on the real Electron 22 binary on windows-latest, and `tsc -p electron/tsconfig.legacy.json --noEmit` added to `npm run typecheck`. Unit tests on Node 16 are impossible because Vitest 2 needs Node 18 or later.
- Release flow: a new TARGETS.win7 is Office-only. `npm run release -- --os win7` builds it, and `--panel master` with win7 is refused with a reason. A plain `npm run release` is unchanged, so the main pipeline cannot break. The GitHub Release workflow gets a 'win7' matrix leg on windows-latest so the fleet always gets a matching legacy build. The existing collect step already renames latest-win7.json to latest-office-win7.json.
- PowerShell 2.0: the uninstall script keeps one code path. JSON is read with System.Web.Script.Serialization.JavaScriptSerializer, which is in .NET 3.5 (built into Win7) and .NET 4.x. $PSCommandPath becomes $MyInvocation.MyCommand.Path, -Directory becomes PSIsContainer, '-in' becomes '-contains', and HashSet becomes a case-insensitive @{} hashtable. Flags and exit codes do not change.
- Win7 Office server heap: on ia32 the shell caps --max-old-space-size at 1024 MB, because a 32-bit process has 2 GB of address space. Every other low-RAM knob comes from the ui-home-shell/low-RAM domain; the legacy build gets nothing extra.
- The Clean Install tool (cleaner/) is not built for Win7. It is a support tool handed over on USB. On Win7 the NSIS uninstaller plus the PS2-compatible sweep script do the same job.
- The Master stays Windows 10+. master/web still gets target chrome108, so a Win7 PC's Chrome 109 can open the Master UI over the LAN.

## dataModel

- None. This domain adds no migration, table, column or backfill. Office data files (snapshot, outbox, credentials) are byte-identical between the two lines, so a Win7 PC can move to the main build and back without conversion.

## permissions

- None. No permission keys, tiers or grant migrations.

## interfaces

- shared/src/domain/version.ts: ReleasePlatform = 'win32' | 'darwin' | 'linux' | 'win7'. New releasePlatformFor(platform: string, electronVersion: string | undefined): ReleasePlatform returns 'win7' when platform==='win32' && electronVersion's major < 23. Exported through the shared barrel.
- Master HTTP, behaviour only: GET /api/updates/office/latest?platform=win7 and GET /api/updates/office/download?platform=win7 are now accepted by askingPlatform() in master/src/http/routes/update.routes.ts. They read office-panel/latest-win7.json and never fall back to a win32 latest.json; readManifest's existing platform check already refuses that.
- Releases folder / GitHub assets: office-panel/latest-win7.json (no latest.json shim); GitHub asset latest-office-win7.json (manifestAsset is unchanged and generic); setup file OrderBook-Office-Win7-<v>-Setup.exe; beside file OrderBook-Office-Win7-<v>-Standalone.exe plus its .sha256. The signed manifest field platform is 'win7'.
- @orderbook/ui: new export anySignal(signals: readonly AbortSignal[]): AbortSignal, from ui/src/abort.ts. It aborts with the first input's reason and removes its listeners once settled. Used by master/web/src/api.ts and office/web/src/api.ts instead of AbortSignal.any.
- electron/lib/health.ts: new getJson(url: string, timeoutMs: number): Promise<unknown | null>, a node:http GET that returns the parsed JSON body or null on any error, non-JSON or timeout. shell.ts pollHealth uses it.
- office/src/lib/legacy-globals.ts: installLegacyGlobals(target: typeof globalThis = globalThis): string[]. It installs fetch/FormData/Headers/Request/Response from undici and Blob from node:buffer only where missing, and returns what it installed (logged once).
- office/src/config/paths.ts: freeDiskBytes/totalDiskBytes keep their signatures. New exported pure parseWmicDisk(text): { free: number; total: number } | null for the Win7 fallback.
- No socket commands, pushes, SSE event types, IPC channels, REST routes or wire-type fields are added or changed.

## settings

- None. No SETTINGS entries or CompanyFeatures fields.

## uiScreens

- No new screens, nav entries, shortcuts or icons. The Win7 build renders the same office/web bundle (and LAN browsers the same master/web bundle) on Chromium 108.
- The Office Updates screen is unchanged. On an old Master its answer is the existing 'no update available' (reason 'noRelease') rather than an offer of the wrong build.

## steps

### 1. Release channel in the shared contract

Files: `shared/src/domain/version.ts`, `shared/src/index.ts`, `shared/tests/release-platform.test.ts`

Add 'win7' to ReleasePlatform, with a doc comment saying it is the one value that is not a process.platform: the Electron 22 Office line for Windows 7/8/8.1. Add releasePlatformFor(platform, electronVersion) plus the constant LEGACY_ELECTRON_CEILING = 23 (the first Electron without Win7). Re-export both if the barrel does not already export version.ts. The new test covers ('win32','22.3.27')→'win7', ('win32','33.4.11')→'win32', ('win32',undefined)→'win32' (plain-Node dev) and ('linux','22.3.27')→'linux'.

### 2. Master accepts and keeps the win7 channel

Files: `master/src/http/routes/update.routes.ts`, `master/src/services/update.service.ts`, `master/src/services/github-releases.ts`

askingPlatform(): accept 'win7'. update.service.ts: add win7:true to the RELEASE_PLATFORMS record (the compiler forces this), so officePlatforms() keeps polling GitHub for win7 once a Win7 panel has asked. github-releases.ts: make sameOs(entry, file) compare the extension AND a Win7 marker (const isWin7Build = (name) => /^OrderBook-\w+-Win7-/i.test(name)). Without this a win32 office sync sweeps OrderBook-Office-Win7-*-Setup.exe as 'superseded' (both end in .exe), and isDebrisOf would delete the other channel's .part. manifestAsset/manifestNames already produce latest-office-win7.json and ['latest-win7.json'] with no change.

### 3. Office server on Node 16: polyfill boundary and API swaps

Files: `office/package.json`, `package-lock.json`, `office/src/lib/legacy-globals.ts`, `office/src/index.ts`, `office/src/services/update.service.ts`, `office/src/config/paths.ts`

office/package.json: add "undici": "5.29.0" (exact; confirm it is the last 5.x and engines >=14). New legacy-globals.ts: `const require = createRequire(import.meta.url)`; installLegacyGlobals(target) assigns fetch/FormData/Headers/Request/Response from require('undici') and Blob from require('node:buffer') only where typeof target[name] is not a function, then runs it at module scope. It is the FIRST import in office/src/index.ts and is never loaded on Node 20 (the require happens only inside the 'missing' branch). index.ts: track sockets (server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)) })), and in shutdown() call server.close(...) then destroy each tracked socket instead of server.closeAllConnections() (Node 18.2+). update.service.ts: Readable.fromWeb(...) becomes Readable.from(response.body as AsyncIterable<Uint8Array>), which works on Node 16.5+ web streams and Node 20. Both `?platform=${process.platform}` become `?platform=${releasePlatformFor(process.platform, process.versions.electron)}`. In availableUpdate(), before verifyManifest, if manifest.platform !== own then log.warn and return {current, available:null, reason:'noRelease'}. paths.ts: replace `import { statfs } from 'node:fs'` with `import fsSync from 'node:fs'`. A named import of a missing export is a link-time SyntaxError on Node 16 that would kill the whole server. Use fsSync.statfs when it is a function (eslint-disable-next-line with a reason). Otherwise on win32 run execFile('wmic', ['logicaldisk','where',`DeviceID='${drive}'`,'get','FreeSpace,Size','/value']) through parseWmicDisk. Otherwise return null. Nothing else in office/src or shared/src uses a newer-than-Node-16 API: I grepped every named node: import, and statfs is the only missing export. express 4.22, multer 2.2, socket.io-client 4.8, engine.io-client 6.6, ws 8.21 and busboy 1.6 all declare engines of Node 10 or lower.

### 4. Shell valid as CJS on Electron 22, ia32 heap ceiling

Files: `electron/shell.ts`, `electron/lib/health.ts`, `electron/tsconfig.legacy.json`, `tools/copy-shell.mjs`, `package.json`

shell.ts:99: `const here = path.join(app.getAppPath(), 'electron', 'dist')`. Drop the fileURLToPath import (the comment about percent-encoding becomes moot). shell.ts:314-323 pollHealth: `const body = await getJson(`${ORIGIN}/api/health`, POLL_INTERVAL_MS * 2); return body === null ? { kind: 'not-listening' } : interpretHealth(body, config.panel)`. health.ts gets getJson via http.get + setTimeout/req.destroy. startServer(): after maxOldSpaceMb is computed, apply the ia32 ceiling `Math.min(…, process.arch === 'ia32' ? 1024 : 4096)` and lower the floor to the same value. If the low-RAM domain has already extracted serverHeapMb() into electron/lib, add the arch clause there instead. New electron/tsconfig.legacy.json: extends ./tsconfig.json; compilerOptions {module:'CommonJS', moduleResolution:'Node10', outDir:'../build/shell-legacy', declaration:false, declarationMap:false}; include ['shell.ts','office.main.ts','preload.cts','lib/*.ts']; exclude ['lib/cleaner/**','tests','dist']. tools/copy-shell.mjs: a `--legacy` flag sets SOURCE to build/shell-legacy and panels to ['office'], and writes office/electron/dist/package.json = {"type":"commonjs"}. Root package.json scripts: add "build:shell:legacy": "tsc -p electron/tsconfig.legacy.json && node tools/copy-shell.mjs --legacy" and "smoke:legacy": "node tools/legacy-smoke.mjs", and append ` && tsc -p electron/tsconfig.legacy.json --noEmit` to "typecheck". I checked every Electron API the shell uses against 22: getPrintersAsync, webContents.print, setWindowOpenHandler, render-process-gone, child-process-gone, plugins:true, sandboxed .cjs preload and setLoginItemSettings all exist there.

### 5. Web bundles on Chromium 108

Files: `ui/src/abort.ts`, `ui/src/index.ts`, `master/web/src/api.ts`, `office/web/src/api.ts`, `master/web/vite.config.ts`, `office/web/vite.config.ts`

New ui/src/abort.ts anySignal(signals): if any input is already aborted, return AbortSignal.abort(reason). Otherwise create a controller and add {once:true} abort listeners that abort it with the source's reason and then remove the remaining listeners. Export it from the ui/src/index.ts barrel (the no-duplicate-ui guard requires this). Then replace AbortSignal.any at master/web/src/api.ts:272,292 and office/web/src/api.ts:301,320, importing anySignal from '@orderbook/ui' (both files already import from it). Add `target: 'chrome108'` under build: in both vite configs, with a comment naming Electron 22 and Win7 Chrome 109. Every other DOM API in ui/src, the web apps and shared/src is at Chromium 108 or below; I grepped for checkVisibility (105), inert (102), :has (105), AbortSignal.timeout (103) and userAgentData (90).

### 6. ESLint runtime floors

Files: `eslint.config.js`

Define the lists once and compose them with a helper `floor({properties, globals, imports, syntax})`, which returns the four rule entries. Flat-config blocks override rules rather than merging them, so each file set gets exactly one composed block. NODE16.properties: AbortSignal.any, Readable.fromWeb, Readable.toWeb, property-only closeAllConnections/closeIdleConnections, fs.statfs, fs.statfsSync, fs.openAsBlob, fs.glob, os.availableParallelism, util.parseArgs, util.styleText, process.loadEnvFile, process.getBuiltinModule, crypto.subtle, crypto.getRandomValues. NODE16.globals: structuredClone, ReadableStream, WritableStream, TransformStream, BroadcastChannel, WebSocket, File, crypto. NODE16.imports: node:fs/fs importNames statfs/statfsSync/openAsBlob/glob/globSync; node:fs/promises statfs/glob; node:util parseArgs/styleText; node:os availableParallelism; node:test; node:sqlite. NODE16.syntax: import.meta.dirname/filename (MemberExpression[object.type='MetaProperty'][property.name=/^(dirname|filename)$/]) and readdir with a `recursive` property. SHELL adds: globals fetch, FormData, Blob, Response, Request, Headers; syntax MetaProperty (any import.meta); properties net.fetch, protocol.handle, property-only navigationHistory; imports electron importNames webUtils, WebContentsView, BaseWindow. CHROMIUM108.properties: AbortSignal.any, URL.canParse, URL.parse, Object.groupBy, Map.groupBy, Promise.withResolvers, Array.fromAsync, document.startViewTransition, scheduler.yield, property-only showPopover/hidePopover/togglePopover/isWellFormed/toWellFormed. CHROMIUM108.globals: CloseWatcher, Iterator. CHROMIUM108.syntax: JSXAttribute[name.name='popover']. Blocks: office/src/**/*.ts gets NODE16. shared/src/**/*.ts gets NODE16 plus CHROMIUM108. ui/src/** and {master,office}/web/src/** get CHROMIUM108. electron/shell.ts, electron/office.main.ts, electron/preload.cts and electron/lib/*.ts get NODE16 plus SHELL. Every message names the floor and the replacement. ES2023+ builtins (findLast, toSorted, …) are left to tsconfig lib ES2022, which the static test locks.

### 7. Packaging: legacy yml and the win7 release target

Files: `office/electron-builder.legacy.yml`, `tools/legacy-electron.mjs`, `tools/release.mjs`

New office/electron-builder.legacy.yml. It is standalone rather than `extends`, so packaging-invariants can read it as text. It copies appId/productName/copyright/directories(output ../build/office, buildResources installer)/npmRebuild/buildDependenciesFromSource/files/extraResources/icon from office/electron-builder.yml. win.target is nsis arch [x64, ia32] and portable arch [x64, ia32], with signAndEditExecutable false. portable gets artifactName OrderBook-Office-Win7-${version}-Standalone.${ext} and unpackDirName OrderBook-Office. nsis keeps the same block as the main yml but with artifactName OrderBook-Office-Win7-${version}-Setup.${ext}. There are no mac/linux blocks. New tools/legacy-electron.mjs: `export const LEGACY_ELECTRON = '22.3.27'`. release.mjs: import it, and add a TARGETS entry `win7: { builderFlag: '--win', platform: 'win7', ext: 'exe', arch: 'x64', archs: ['x64', 'ia32'], postgres: [], buildsOn: ['win32'], besides: ['Standalone.exe'], panels: ['office'], config: 'electron-builder.legacy.yml', electron: LEGACY_ELECTRON, legacyShell: true, tag: 'Win7' }`. main(): when no --panel is given, the panel list is RELEASE_TARGET.panels ?? the publishable panels. An explicit panel outside RELEASE_TARGET.panels throws 'The win7 target builds the Office panel only; the Master needs Windows 10 or later (PostgreSQL 17)'. The --fast check becomes `RELEASE_TARGET.builderFlag !== '--win'`. build(): when RELEASE_TARGET.legacyShell, run `npx tsc -p electron/tsconfig.legacy.json`, then rm and cp build/shell-legacy into <panel>/electron/dist, then writeFile <panel>/electron/dist/package.json '{"type":"commonjs"}\n'. Otherwise do what it does today. electronVersion = RELEASE_TARGET.electron ?? the installed version. `--config` takes RELEASE_TARGET.config ?? 'electron-builder.yml'. name = [config.artifact ?? config.label, RELEASE_TARGET.tag].filter(Boolean).join('-'), which serves both `expected` and besides. publish() is unchanged: it writes latest-win7.json, and the latest.json shim only for 'win32'.

### 8. PowerShell 2.0-compatible uninstall script

Files: `tools/uninstall/uninstall-orderbook.ps1`

Line 73: $PSCommandPath becomes $MyInvocation.MyCommand.Path, captured at script scope into $scriptPath. Lines 178 and 199: `Get-ChildItem -Directory` becomes `Get-ChildItem … | Where-Object { $_.PSIsContainer }`. Line 200: `$u.Name -in @(…)` becomes `@(…) -contains $u.Name`. Lines 167-191: the two HashSet[string] sets become `@{}` hashtables (case-insensitive by default) with ContainsKey checks. Line 315: Get-Content -Raw | ConvertFrom-Json becomes a function Read-DataDir($file): Add-Type -AssemblyName System.Web.Extensions; $text = [IO.File]::ReadAllText($file); (New-Object System.Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($text)['dataDir'], wrapped in the existing try/catch. Keep the param block, flag spellings, exit codes and output tags byte-identical (contract with installer.nsh x2, electron/lib/uninstall.ts and the cleaner). Get-NetFirewallRule is already inside try/catch with a netsh fallback, and netsh works on Win7.

### 9. Runtime smoke on the real Electron 22 binary

Files: `tools/legacy-smoke.mjs`, `build/ (gitignored cache: build/legacy-electron/)`

One script with two modes. Outer mode: (1) downloadArtifact({version: LEGACY_ELECTRON, artifactName:'electron', platform: process.platform, arch: process.arch}) from @electron/get, then extract-zip into build/legacy-electron/<ver>-<platform>-<arch>, skipped when it is already there. (2) Spawn the binary with ELECTRON_RUN_AS_NODE=1 and `-p process.versions`, and assert node 16.17.x and chrome 108.x. (3) Spawn the binary on this same file with `--inside`. (4) Spawn it on office/dist/index.js with ELECTRON_RUN_AS_NODE=1, ORDERBOOK_OFFICE_DATA_DIR/LOCATION_FILE/SETTINGS_FILE pointing into a temp dir and OFFICE_PORT set to a free port. Poll /api/health with http.get until it returns JSON with panel 'office' (60 s budget), GET /api/connection (200) and GET / (index.html served from web/dist), then kill it. (5) Exit 1 with the child's stderr on any failure. Inner mode (--inside, running on Node 16): import ../office/dist/lib/legacy-globals.js and assert that fetch, FormData and Blob are now functions. Start a node:http server and check: fetch GET JSON with signal AbortSignal.timeout; fetch POST of a FormData with new Blob([Buffer]) and a filename (the server checks the multipart body contains filename="x.csv" and the field values); a 1 MB streamed GET through Readable.from(res.body) hashed and compared; and a dynamic import of ../office/dist/config/paths.js calling freeDiskBytes(os.tmpdir()), which must resolve to a number or null without throwing. A manual `--gui` flag launches the legacy binary on the office folder after `npm run build:shell:legacy`, for an eyes-on check of Chromium 108.

### 10. CI and the release workflow

Files: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

ci.yml: a new job `legacy-runtime` on windows-latest. It runs checkout, setup-node 22 with npm cache, an actions/cache of ~/AppData/Local/electron/Cache keyed on tools/legacy-electron.mjs, `npm ci`, `npm run build:shared`, `npm run build --workspace @orderbook/office`, then `npm run smoke:legacy`. It is a separate job because ubuntu runners lack some of Electron's shared libraries and Windows is the target family anyway. The verify job already covers lint (the floors) and typecheck (the legacy tsconfig). release.yml: add the matrix leg `- os: win7 / runner: windows-latest`. The build step's `npm run release -- --os ${{ matrix.os }}` then builds the legacy Office, and the existing collect loop renames latest-win7.json to latest-office-win7.json and uploads the Win7 Setup, Standalone and .sha256 files with no script change. Update the header comment ('four legs; win7 is Office only').

### 11. Tests and guards

Files: `master/tests/legacy-floor.test.ts`, `master/tests/packaging-invariants.test.ts`, `master/tests/github-releases.test.ts`, `master/tests/updates.test.ts`, `office/tests/legacy-compat.test.ts`, `office/tests/update-platform.test.ts`, `electron/tests/health.test.ts`, `electron/tests/uninstall.test.ts`, `ui/tests/abort.test.ts`, `shared/tests/release-platform.test.ts`

See the 'tests' field for every assertion. Order: write the new guards first, so they fail on today's AbortSignal.any, statfs import, PS3 constructs and missing vite target. Then make the changes above until they pass. Finally run lint, typecheck, test, `npm run smoke:legacy` and a real `npm run release -- --os win7 --fast`.

### 12. Docs

Files: `docs/WINDOWS7.md`, `docs/UPDATES.md`, `docs/STRUCTURE.md`, `HANDOFF.md`, `docs/AI_COLLABORATION.md`, `README.md`

See the 'docs' field. HANDOFF must record that the Win7 VM acceptance pass is still owed until it is done.

## tests

- NEW master/tests/legacy-floor.test.ts (static, no network):
(a) tsconfig.base.json compilerOptions.lib equals ['ES2022'] and target ES2022; shared and office tsconfigs do not override lib; ui, master/web and office/web tsconfig lib equals ['ES2022','DOM','DOM.Iterable']. This is the lock that keeps ES2023+ builtins (findLast, toSorted, groupBy, withResolvers) a type error.
(b) Both web vite.config.ts files contain build target 'chrome108'.
(c) Every *.css under ui/src, office/web/src and master/web/src is free of: color-mix(, oklch(, oklab(, light-dark(, text-wrap, @scope, @starting-style, subgrid, field-sizing, anchor-name, position-anchor, interpolate-size, calc-size(, transition-behavior, view-transition, :user-valid, :user-invalid, :dir(, :popover-open, relative colour 'from ', the round(/mod(/rem( functions, lh/rlh units, unprefixed mask/mask-image, and nesting (a selector line starting with '&' or containing ' &').
(d) tools/uninstall/uninstall-orderbook.ps1 contains none of: -Raw, $PSCommandPath, -Directory, ' -in ', ' -notin ', [ordered], [pscustomobject], .ForEach(, .Where(, '-ErrorAction Ignore', $PSItem, ::new(, ConvertFrom-Json, ConvertTo-Json, HashSet.
(e) electron/tsconfig.legacy.json uses module CommonJS, includes shell.ts, office.main.ts, preload.cts and lib/*.ts, and excludes lib/cleaner.
(f) eslint.config.js has floor blocks whose files cover office/src, shared/src, ui/src, both web src trees and electron/shell.ts.
- NEW office/tests/legacy-compat.test.ts: installLegacyGlobals({}) installs fetch, FormData, Headers, Request, Response and Blob as functions; installLegacyGlobals({ fetch: f }) leaves f untouched and returns the list of what it installed; parseWmicDisk parses 'FreeSpace=123\r\nSize=456' to {free:123,total:456} and returns null on garbage; freeDiskBytes still returns a number on the CI host (statfs path).
- NEW office/tests/update-platform.test.ts (mocks ../src/lib/master-fetch.js the way lead-route.test.ts does, plus credentials): when process.versions.electron is stubbed to '22.3.27' on win32, availableUpdate asks with ?platform=win7, and a manifest whose platform is 'win32' yields {available:null, reason:'noRelease'} without calling verifyManifest. On the host platform the query is process.platform, so behaviour is unchanged.
- NEW shared/tests/release-platform.test.ts: the releasePlatformFor matrix (win32+22 gives win7; win32+33, win32+undefined and linux+22 give their platform).
- NEW ui/tests/abort.test.ts: anySignal aborts when either input aborts and carries that reason; it returns an already-aborted signal for an already-aborted input; a later abort of the other input after settling is a no-op.
- EXTEND electron/tests/health.test.ts: getJson against a local node:http server returns parsed JSON for 200 application/json, null for an HTML body, null for a refused port, and null when the server stalls past timeoutMs.
- EXTEND electron/tests/uninstall.test.ts: an it.skipIf(process.platform !== 'win32') case runs `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/uninstall/uninstall-orderbook.ps1 -Panel office -DryRun` and expects exit 0 and 'Dry run complete'. It proves the PS2 rewrite still works on PS 5.1; PS 2.0 itself is covered only by the static list and the VM pass.
- EXTEND master/tests/github-releases.test.ts:
- In a folder holding OrderBook-Office-1.0.0-Setup.exe, OrderBook-Office-Win7-1.0.0-Setup.exe and both manifests, a win32 office sync to 2.0.0 sweeps only the plain 1.0.0 exe and keeps the Win7 one; the reverse holds for a win7 sync.
- A win7 sync's debris sweep leaves OrderBook-Office-2.0.0-Setup.exe.part alone.
- manifestAsset('office','win7') is 'latest-office-win7.json'.
- A win7 sync writes only latest-win7.json and never latest.json.
- EXTEND master/tests/updates.test.ts: GET /api/updates/office/latest?platform=win7 serves latest-win7.json. With only a win32 latest.json present it answers no release (readManifest's platform check), never the Electron 33 build.
- CHANGE master/tests/packaging-invariants.test.ts, deliberately, because there is a fourth target:
- 'declares all three operating systems' becomes 'declares every release target' and expects ['linux','mac','win','win7'].
- declaredTargets() also parses `panels: [...]`, `config: '...'`, `archs: [...]` and `tag: '...'`.
- The 'what electron-builder builds' and 'electron-builder configuration' loops skip things not in target.panels, read target.config ?? 'electron-builder.yml', map the yml key with KEY.win7 = 'win' and NAMED_BY.win7 = ['win','nsis','portable'], expect `OrderBook-${ARTIFACT}-${tag}-<v>-${tail}` when tag is set, and want target.archs ?? [target.arch] for the arch assertion.
- 'vendors the architecture each target builds' passes because postgres is [].
New cases:
- releaseAs('win32','x64','win7','master') fails with 'Office panel only'.
- releaseAs('win32','arm64','win7') reaches 'STOP before npm', since Office is not native.
- build() contains the tsconfig.legacy compile and the '{"type":"commonjs"}' write under legacyShell.
- TARGETS.win7.electron comes from tools/legacy-electron.mjs, and that value matches /^22\.3\.\d+$/.
- office/electron-builder.legacy.yml has the same appId, productName and nsis.include as office/electron-builder.yml.
- UNCHANGED but re-run and expected green: office/tests/module-forwarding.test.ts (global FormData/Response on Node 22 are untouched because the polyfill installs only when missing); electron/tests/server-env.test.ts (no new env var); electron/tests/shell-log.test.ts (reads shell.ts text, and no log lines change); master/tests/release-folder-besides.test.ts; master/tests/release-signed-fields.test.ts ('win7' is just a value of the signed platform field); master/tests/no-duplicate-ui.test.ts (anySignal is exported from the barrel); shared/tests/version.test.ts.
- CI runtime guard (not vitest): the `legacy-runtime` job's tools/legacy-smoke.mjs on the real Electron 22.3.27 binary (Node 16.17.1). It boots office/dist under ELECTRON_RUN_AS_NODE and checks the Node 16 fetch, multipart, streamed-download and statfs paths. It replaces 'unit tests on Node 16', which is impossible because Vitest 2.1 requires Node 18 or later.
- Manual acceptance (recorded in HANDOFF, required by its real-Electron rule): on Windows 7 SP1 x64 and x86 VMs, plus an 8.1 VM if available, install the Setup.exe, pair with a Win10 Master, create a pending order online and offline, print an order note, update from the Master's releases folder to the next build, run the Standalone.exe, and uninstall with and without keeping data. Also open the Master UI in Chrome 109 on Win7.

## docs

- NEW docs/WINDOWS7.md (short, operator-facing):
- What runs on Win7/8/8.1: the Office Panel only. The Master needs Windows 10+ because of PostgreSQL 17.
- Requirements: Windows 7 SP1 with current updates; x64 or 32-bit.
- Which file to install (OrderBook-Office-Win7-<v>-Setup.exe or Standalone.exe).
- Updates arrive from the Master like every other panel. Update the Master first.
- Moving a Win7 PC to Windows 10: install the normal Office over it; data is kept.
- Limits: Electron 22 receives no Chromium security fixes, so the app is LAN-only and loads only its own pages. The Clean Install tool is not provided for Win7; use the uninstaller.
- How to build: npm run release -- --os win7.
- How to test: npm run smoke:legacy, then the VM checklist.
- docs/UPDATES.md: the win7 channel (latest-win7.json in the folder, latest-office-win7.json on GitHub, Win7 artifact names); the Office refusing a manifest for another platform; build both `--os win` and `--os win7` when releasing by hand; and the Master must be updated before Win7 panels.
- docs/STRUCTURE.md:
- §1.6 runtime rules: add the two floors (Office server, shared and shell at Node 16.17; web at Chromium 108) and how they are enforced.
- §2.5: undici in office deps and the new scripts build:shell:legacy, smoke:legacy and the typecheck addition.
- §2.6: electron/tsconfig.legacy.json.
- §2.7: the ESLint floor blocks.
- §2.11: the legacy-runtime CI job.
- §3.2: version.ts 'win7' and releasePlatformFor.
- §4: anySignal.
- §8.2 and §8.4: legacy-globals, tracked sockets, statfs/wmic.
- §10.1: `here` via getAppPath, getJson health poll, ia32 heap ceiling.
- §10.4: the legacy yml.
- §10.6: TARGETS.win7 and the legacy shell step.
- §10.8: win7 update channel and the Win7-aware sweep.
- The guard table (legacy-floor.test.ts and packaging-invariants changes).
- HANDOFF.md: Win7 line status, the owed VM acceptance checklist, and the rule that new code must pass the floors (this affects every other domain in the batch).
- docs/AI_COLLABORATION.md: a working agreement that new Office server, shared or shell code stays within Node 16.17 and Electron 22 APIs and new web/CSS within Chromium 108, with the lint and test that enforce it and how to add a feature-detected exception (eslint-disable with a reason).
- README.md: the system-requirements line (Master Windows 10+; Office Windows 7 SP1+ via the Win7 build, or Windows 10+).

## risks

- Electron 22 / Chromium 108 has had no security fixes since late 2023. The mitigation is what the shell already does: sandboxed, contextIsolation on, navigation locked to its own origin, all permissions denied, loads only http://localhost:4200, LAN-only. Record it in docs/WINDOWS7.md as an accepted owner trade-off.
- ESM loading of office/dist under Electron 22's ELECTRON_RUN_AS_NODE is expected to work (Node 16 ESM is stable) but has never been run here. The legacy-runtime CI job is the proof. If it fails, the fallback is to bundle office/dist to CJS for the legacy line only, which is a larger change.
- undici 5 on Node 16 pulls in node:stream/web, which prints an ExperimentalWarning to the server log once (harmless). undici 5.x has had CVEs (fixed by 5.28.5 and later), so pin the latest 5.x; the attack surface is the LAN-only Master link.
- electron-builder 25's NSIS template and combined x64+ia32 portable output are untested on Win7. The ia32 pair roughly doubles installer size (~2x, about 150-180 MB) for LAN updates. Only the VM pass proves them.
- TypeScript `moduleResolution: Node10` is deprecated for TS 7. The legacy tsconfig may need `ignoreDeprecations` or a switch to emitting .cts on a future TypeScript upgrade.
- The floors constrain every other domain in this batch. Basic Home tile gradients must not use color-mix or oklch, notifications must use Electron-22 APIs (Notification, flashFrame and Tray exist; Win7 notifications are Electron's custom balloon implementation), and any new Office server code must avoid Node 18+ APIs. Lint and the CSS test catch most of this, but only the smoke and the VM pass catch runtime-only gaps.
- The property-only ESLint bans (closeAllConnections, showPopover, isWellFormed) can false-positive on same-named members of our own objects. Resolve with a reasoned eslint-disable-next-line, never by dropping the rule.
- An un-updated Master maps 'win7' to win32. The Office refuses that manifest, but the operator then sees 'no update' until the Master is updated, so docs must say 'update the Master first'.
- A Win7 PC upgraded to Windows 10 stays on the win7 channel (it still works) until someone installs the normal build by hand.
- @electron/get and extract-zip are transitive dependencies of `electron`, used only by tools/legacy-smoke.mjs. If a future electron drops them, the smoke script breaks loudly; it does not silently pass.
- PowerShell 2.0 cannot run in CI (GitHub runners lack .NET 3.5 PS2). The static ban list plus the PS 5.1 dry-run test cover most of it, and the Win7 VM uninstall run is the real proof.
- A manual release that forgets `--os win7` leaves Win7 panels a version behind the Master. The GitHub workflow's dedicated leg prevents this for the normal path.

## dependsOn

- ui-home-shell / low-RAM domain: owns the shell's RAM knobs (the 2048 MB server-heap floor at electron/shell.ts:189, renderer js-flags, ScreenHost eviction). I need it either to keep the heap computation in one place that I can add `arch === 'ia32' → ceiling 1024 MB` to, or to extract it as electron/lib/serverHeapMb({ totalMb, panel, arch }) with a test. Whoever lands second rebases. The legacy build uses the same settings; no Win7-specific branch beyond ia32.
- Every domain that touches office/src, shared/src, ui/src, master/web, office/web or electron/: it must pass the Node 16 / Chromium 108 / Electron 22 floors (lint, legacy typecheck, CSS test). New Electron IPC (notifications, flashFrame, printroom copies) must use APIs present in Electron 22; webContents.print's `copies` option and Notification exist there.
- Notifications/attention domain: Electron 22's Notification on Win7 uses Electron's custom implementation. The renderer's permission handler denies everything, so notifications must stay main-process via IPC, as the critic already suggests.
- Release/updates domain, if any: shares tools/release.mjs, the github-releases sweep and the release.yml matrix. My changes are additive (a new target, a new matrix leg, a Win7-aware sameOs).
- Sync/realtime domain: if it adds Master rediscovery or a version handshake, any HTTP it adds in office/src goes through global fetch (polyfilled), so nothing extra is needed. It must not use AbortSignal.any in office/src.
- Docs shared by all domains: docs/STRUCTURE.md, HANDOFF.md and docs/AI_COLLABORATION.md are edited by every domain, so merge by section.

## openQuestions

- Can the owner provide Windows 7 SP1 test machines or VMs, one 64-bit and one 32-bit (and an 8.1 if any shop PC runs it), for the acceptance pass? CI proves the Node 16 server runtime and the build, but only a real Win7 box proves the installer, the Chromium 108 window, printing and the PowerShell 2.0 uninstall.

## effort

About 30 files: 14 source/config files modified, 6 new (legacy-globals.ts, abort.ts, tsconfig.legacy.json, electron-builder.legacy.yml, legacy-electron.mjs, legacy-smoke.mjs), 10 test files new or extended, and 6 docs. Roughly 550–700 lines of code (the release.mjs target handling ~80, ESLint floors ~90, the smoke script ~170, the PS2 rewrite ~40 changed lines, the Office compatibility layer ~90, shell ~40, web ~30), plus ~450 lines of tests and ~250 lines of docs. That is 1.5–2 implementation sessions, plus a half-day Win7 VM acceptance pass. It should land BEFORE the other domains so their code is written against the floors from the start.
