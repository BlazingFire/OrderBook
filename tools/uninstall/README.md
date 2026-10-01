# Uninstall scripts

Two scripts that take OrderBook off a machine completely. They ship inside both
setup files **and inside the standalone clean-install tool**
(`resources/uninstall`, via `extraResources` in all three
`electron-builder.yml` files), and are what the Windows uninstaller's "also delete
all data?" question and `cleaner/` run (the in-app Uninstall button went with the
Settings Developer tab in 5a32106). They can also be run by hand from
this folder.

There is one copy of each script in this repository and every entry point runs
it. That is the point: the inventory of what OrderBook leaves on a PC is the
hard part, and a second copy is how the thing claiming to remove everything
comes to miss something.

The ordinary uninstaller deliberately leaves the data folder alone
(`deleteAppDataOnUninstall: false`): the company's records are not the program's
to take with it. These scripts are the one place that removes it, and only when
asked.

| Flag (Windows) | Flag (macOS)  | Meaning                                                                                     |
| -------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `-Panel`       | `--panel`     | `master`, `office` or `all` (default `all`).                                                |
| `-KeepData`    | `--keep-data` | Remove the program and its caches but keep every data folder (see below).                   |
| `-Yes`         | `--yes`       | No prompts at all — not even for the releases folder. What the app and the installer pass.  |
| `-DryRun`      | `--dry-run`   | Print every action and change nothing. Works on a machine with nothing installed.           |
| `-LeftoversOnly` | —           | Called from inside the NSIS uninstaller: do not run the uninstaller again, the program folder is already gone. |

```powershell
# Windows — see the plan first, then do it
powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall\uninstall-orderbook.ps1 -Panel all -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall\uninstall-orderbook.ps1 -Panel master -KeepData
```

```bash
# macOS
bash tools/uninstall/uninstall-orderbook.sh --panel office --dry-run
bash tools/uninstall/uninstall-orderbook.sh --panel all --yes
```

## What each removes

**Windows** (`uninstall-orderbook.ps1`, self-elevates unless `-DryRun`):
stops every process running from an OrderBook install folder (that is how the
panel's own `postgres.exe` is stopped without touching any other PostgreSQL on
the PC); runs each registered uninstaller silently; removes the install folders,
the Electron profile (`%APPDATA%\<Product>`, `%LOCALAPPDATA%\<Product>`), the
updater caches, `%TEMP%\orderbook*`, shortcuts on every desktop and Start Menu,
the Uninstall / Run / AppCompat / `Software\OrderBook*` registry entries, and the
Master's two firewall rules. Every profile under `C:\Users` is swept because the
installer is per-machine; other users' registry hives are not.

**macOS and Linux** (`uninstall-orderbook.sh`, branching on `uname`): quits the app, stops anything still
running from inside the bundle (again by path, never `pkill postgres`), removes
`/Applications/<Product>.app` and `~/Applications/<Product>.app` (`sudo` only if
the plain remove fails), the Electron profile and every `~/Library` cache, log,
preference, saved-state and updater folder for the app id, and the login item.

On Linux the same script removes `/opt/<Product>`, `~/Applications/<Product>`
and `~/.local/share/<Product>`, the Electron profile under `$XDG_CONFIG_HOME`,
caches under `$XDG_CACHE_HOME`, the `.desktop` entries in `~/.local/share/
applications`, `/usr/share/applications` and on the desktop, and the autostart
entry `setLoginItemSettings` writes. An AppImage is stopped by its filename
rather than its path, because it runs from a FUSE mount under `/tmp` that no
install folder contains.

## What `-KeepData` / `--keep-data` preserves

- the data folder — `%APPDATA%\OrderBook\<panel>` or
  `~/Library/Application Support/OrderBook/<panel>` — holding the database
  cluster, uploads, documents, logs and `shell.json`;
- the relocated data folder, wherever `<panel>-location.json` points;
- `<panel>-location.json` and `<panel>-settings.env` themselves;
- the Master's releases drop box (`C:\OrderBook-Releases`, `%ORDERBOOK_RELEASES_DIR%`,
  `/OrderBook-Releases`). Without `--keep-data` this folder gets its own
  question unless `--yes`, because an operator may have filled it by hand.
  The path comes from `ORDERBOOK_RELEASES_DIR` when it is set, on both scripts.

Reinstalling the same panel afterwards finds that data and carries on where it
left off.

## The flag spelling is a contract

`-KeepData` / `--keep-data` is written in five places that never import one
another: `electron/lib/uninstall.ts`, both scripts, and both `installer.nsh`
files. Renaming it on one side is **not** loud — the NSIS hook builds the flag
as a string and ignores the exit code — and the default on every side is to
erase. `electron/tests/uninstall.test.ts` reads all five and fails if they stop
agreeing. Change one, change them together.

## The standalone tool

`cleaner/` wraps these scripts in a program somebody can run from a USB stick:
it runs the dry run, shows what it found, offers to copy the data folders
somewhere first, erases, **runs the dry run again to prove it is gone**, and
then runs a setup file. That last verification is the one thing none of the
other entry points do — the Windows uninstaller reports success because a script
exited, not because the PC is clean.

```bash
npm run release -- --panel cleaner              # this OS
npm run release -- --panel cleaner --os linux   # on Linux
```

It is deliberately **not** published into the releases folder: that folder is
what a Master serves to its panels over the LAN, and a tool that erases a
machine has no business in that stream.
