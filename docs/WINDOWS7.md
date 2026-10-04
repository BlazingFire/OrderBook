# Windows 7 and 8

The **Office Panel** runs on Windows 7 SP1, 8 and 8.1 through a separate build
of it. The **Master Panel** does not: it needs Windows 10 or later, because the
PostgreSQL 17 it carries does not run on Windows 7.

## What to install

| File | What it is |
|---|---|
| `OrderBook-Office-Win7-<version>-Setup.exe` | The installer. One file for 64-bit and 32-bit Windows. |

Both sit in the releases folder's `office-panel` folder (and on the GitHub
release) beside the normal Office files. Install either on the Windows 7 PC
exactly as on any other PC, then pair it with the Master as usual.

The PC needs:

- Windows 7 with Service Pack 1, Windows 8 or Windows 8.1, 64-bit or 32-bit.
- The Universal C Runtime, which is Windows update **KB2999226**. A PC that
  has taken Windows Updates has it. The installer checks for it and warns if
  it is missing, because without it the panel may fail to start with a
  missing-DLL error. On a PC with no internet, bring the update from the
  Microsoft Update Catalog on a USB stick.

It is the same program as the normal Office Panel: the same name in the Start
menu, the same data folder (`%APPDATA%\OrderBook\office`) and the same
uninstaller. A 32-bit PC gives the panel's server at most 1 GB of memory.

## Updates

A Windows 7 panel updates from its Master over the LAN like every other panel,
from its own channel: it asks for `latest-win7.json` and is only ever offered
the Windows 7 build. It refuses a build made for another Windows, so it can
never be handed one it cannot run.

**Update the Master first.** A Master older than the Windows 7 build does not
know the channel and offers nothing, so the panel's Updates screen says there
is no update until the Master is updated. See
[`UPDATES.md`](UPDATES.md#the-windows-7-office-build).

## Moving a PC to Windows 10

Install the normal `OrderBook-Office-<version>-Setup.exe` over the Windows 7
build. The data stays where it is. Until then the PC keeps working on the
Windows 7 build, and keeps taking Windows 7 updates.

## Limits

- The Windows 7 build runs on Electron 22 (Chromium 108, Node 16), the last
  Electron that supports Windows 7. It no longer receives security fixes. That
  is an accepted trade-off: the panel is LAN-only, loads only its own pages
  from its own server on this PC, hands any other address to the system
  browser, runs its window sandboxed and denies every browser permission.
- Node 16 has no `fetch`, so the Windows 7 build takes `fetch`, `FormData`,
  `Headers`, `Request` and `Response` from undici 5.29.0
  (`office/src/lib/legacy-globals.ts`). That is the last undici that runs on
  Node 16, and it has open advisories with no 5.x fix, which `npm audit` reports
  as high. Two reach the panel's `fetch`: GHSA-g9mf-h72j-4rw9 (a response can
  chain `Content-Encoding` decompression without limit and exhaust memory) and
  GHSA-2mjp-6q6p-2qxm (request/response smuggling). The others are about
  undici's WebSocket client, its cookie helpers, `upgrade` and its retry
  interceptor, none of which the panel uses (its socket is socket.io-client on
  `ws`). Only the Windows 7 build loads undici; on Node 20 and later the
  globals already exist and it is never required. The panel only fetches from
  the Master it is paired with, or the address it is being paired with, so the
  exposure is a hostile machine on the LAN posing as a Master, which can at
  worst make that one panel run out of memory. This is an accepted trade-off,
  like Electron 22 itself. Keep the pin: undici 6.23 and later need Node 18.
- OrderBook Clean Install is not built for Windows 7. Use the panel's own
  uninstaller, which runs the same leftovers sweep
  (`tools/uninstall/uninstall-orderbook.ps1` is written for PowerShell 2.0, the
  version Windows 7 has).

## Building it

```bash
npm run release -- --os win7          # on Windows: the Office only, x64 and ia32
```

The GitHub Release workflow builds it on its own leg. A build by hand needs
both `--os win` and `--os win7` for the folder to hold both Office builds.
Asking for the Master with `--os win7` is refused with the reason.

## How it is kept working

There is one source tree. The Windows 7 build differs only in the Electron it
ships on (`tools/legacy-electron.mjs`), its yml (`office/electron-builder.legacy.yml`),
the shell compiled to CommonJS (`electron/tsconfig.legacy.json`, with a
`{"type":"commonjs"}` marker beside it) and its update channel. So all new code
has to run on the older runtimes:

| Code | Must run on | Held by |
|---|---|---|
| `office/src`, `shared/src` | Node 16.17 | the `floor/office-server` and `floor/shared` ESLint blocks, `office/tests/legacy-compat.test.ts`, tsconfig `lib` ES2022 |
| `electron/shell.ts`, `office.main.ts`, `preload.cts`, `electron/lib/*.ts` | Electron 22 (Node 16.17), as CommonJS | the `floor/shell` ESLint block, `tsc -p electron/tsconfig.legacy.json` in `npm run typecheck` |
| `ui/src`, `master/web/src`, `office/web/src` | Chromium 108 | the `floor/web` ESLint block, Vite `build.target` naming `chrome108` (alone for the Office UI; added to Vite's default list for the Master UI, which other LAN browsers open too), the CSS list in `master/tests/legacy-floor.test.ts` |

Where a newer API is worth using with a fallback, feature-detect it and put an
`eslint-disable-next-line` with the reason on that line, as
`office/src/config/paths.ts` does for `fs.statfs`.

Vitest cannot run on Node 16, so the runtime check is a smoke instead:

```bash
npm run smoke:legacy
```

It builds the Office server and the CommonJS shell, downloads Node 16.17.1 and
Electron 22.3.27 into `.tmp/legacy-runtime` (checked against their published
SHA-256), runs `office/dist` on both against a stub Master (pairing, a product
CSV upload, an update download, the connection status, the event stream, free
disk space and a shutdown) and launches the Electron 22 main process from the
CommonJS shell. The `legacy-runtime` CI job runs it on Windows.

What only a real Windows 7 PC proves, and is still owed: install the Setup
file on a 64-bit and a 32-bit Windows 7 SP1 PC (and 8.1 if a shop runs it),
pair with a Windows 10 Master, create a pending order online and offline,
print an order note, update from the Master to the next build, uninstall with and without keeping data, and open the Master
in Chrome 109 on the Windows 7 PC.
