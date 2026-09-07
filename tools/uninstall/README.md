# Uninstall scripts

Two scripts that take OrderBook off a machine completely. They ship inside both
setup files (`resources/uninstall`, via `extraResources` in each
`electron-builder.yml`) and are what the desktop app's **Settings → Developer →
Uninstall OrderBook** button and the Windows uninstaller's "also delete all data?"
question run. They can also be run by hand from this folder.

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

**macOS** (`uninstall-orderbook.sh`): quits the app, stops anything still
running from inside the bundle (again by path, never `pkill postgres`), removes
`/Applications/<Product>.app` and `~/Applications/<Product>.app` (`sudo` only if
the plain remove fails), the Electron profile and every `~/Library` cache, log,
preference, saved-state and updater folder for the app id, and the login item.

## What `-KeepData` / `--keep-data` preserves

- the data folder — `%APPDATA%\OrderBook\<panel>` or
  `~/Library/Application Support/OrderBook/<panel>` — holding the database
  cluster, uploads, documents, logs and `shell.json`;
- the relocated data folder, wherever `<panel>-location.json` points;
- `<panel>-location.json` and `<panel>-settings.env` themselves;
- the Master's releases drop box (`C:\OrderBook-Releases`, `%ORDERBOOK_RELEASES_DIR%`,
  `/OrderBook-Releases`). Without `--keep-data` this folder gets its own
  question unless `--yes`, because an operator may have filled it by hand.

Reinstalling the same panel afterwards finds that data and carries on where it
left off.
