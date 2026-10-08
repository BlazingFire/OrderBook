# Shipping an update

Push a version bump to `main` and every installed copy offers the new build.
This describes how that works, and the one ordering rule that will lock you out
of your own fleet if you get it backwards.

## The shape of it

```
you push to main
  → .github/workflows/release.yml builds both panels on Windows,
    macOS and Linux, signs their manifests, publishes a GitHub Release
  → each Master polls that release, checks the signature,
    downloads into its releases folder
  → the Master offers its own build on the Updates screen
  → every Office Panel asks its Master over the LAN and installs from there
```

Office panels never reach the internet for an update: they ask their Master
over the LAN. Since 1.4 the Master reaches GitHub by default, to the public
`BlazingFire/OrderBook-Releases` (`ORDERBOOK_RELEASES_GITHUB_REPO` overrides it, and
setting it to nothing turns it off). Only the Master ever does; no Office Panel
leaves the LAN. (It is one of two internet-capable paths in the product;
the other is the Master's outbound connectors, which call whatever URL an
administrator configures under Integrations.) A shop floor with no route to the
outside world still updates every till from one PC, and a site with no
internet at all keeps working exactly as before: copy the releases folder in on
a USB stick and nothing else changes.

## Setting it up, once

### 1. Make the signing key

```bash
npm run release:keygen
```

This writes a private key to `%USERPROFILE%\.orderbook\` — it refuses to write
one anywhere inside the repository — and appends the matching public key to
`shared/src/domain/release-keys.ts`.

**Back that private key up somewhere safe.** Losing it means every machine in
the field trusts a key you can no longer sign with, and the only way back is a
manual install on each PC carrying a build that trusts a new key.

### 2. Ship a build carrying the public key, before you sign anything

This is the ordering rule, and it is not recoverable remotely if you skip it.

A panel trusts only the keys compiled into its own build. `TRUSTED_RELEASE_KEYS`
ships **empty**, so a machine running today's build refuses every signed release
with `unknownKey` — correctly, because it has no way to tell your signature from
anyone else's.

So the sequence is:

1. Commit the change to `release-keys.ts`.
2. Get that build onto every machine **by hand** — USB stick, or a GitHub
   Release published as a draft that you promote once you have installed it
   yourself.
3. Only then start signing releases. From that point on it is automatic.

Rotation later has the same shape, which is why the keygen script appends
rather than replaces: ship a build trusting both keys, then switch which one
signs, then drop the old one.

### 3. Make the releases repository

The releases repository is **public** and holds nothing but release assets:
`BlazingFire/OrderBook-Releases` (created 2026-10-03).

It is public on purpose. Release assets on a private repository need an
`Authorization` header, so fetching them means shipping a token to every
customer PC — a token that can generally also read your source. A separate
public repository of installers costs nothing and means no secret ever leaves
your machine. (`ORDERBOOK_RELEASES_GITHUB_TOKEN` exists for a private one
anyway, and is named so nobody sets it by accident.)

### 4. Configure both ends

On this repository, in Settings → Secrets and variables → Actions:

| Kind     | Name              | Value                                        |
| -------- | ----------------- | -------------------------------------------- |
| Secret   | `RELEASE_KEY`     | contents of the private `.pem` from step 1    |
| Secret   | `RELEASES_TOKEN`  | a token with `contents: write` on the releases repo |
| Variable | `RELEASE_KEY_ID`  | the key id the keygen script printed          |
| Variable | `RELEASES_REPO`   | optional: only to publish somewhere other than `BlazingFire/OrderBook-Releases` |

On each Master PC nothing is needed: it fetches from `BlazingFire/OrderBook-Releases`.
To use another repository, or none, put this in its `.env`:

```
ORDERBOOK_RELEASES_GITHUB_REPO=you/other-releases
ORDERBOOK_RELEASES_GITHUB_REPO=
```
(the first points elsewhere; the second, empty, turns fetching off).

Without `RELEASE_KEY` the workflow still builds, but publishes a **draft** — and
drafts are ignored by every panel. No key, no fleet update. That is deliberate:
the failure mode is nothing happening, not an unsigned build going out.

## Publishing a build

Bump the version and push:

```bash
npm version patch --no-git-tag-version --workspaces --include-workspace-root
```

Then commit and push to `main`.

The workflow triggers on a version whose tag does not exist yet, not on any push
— so a README fix does not rebuild 200 MB of installers and offer every shop PC
an update identical to what it is already running. Bumping the version *is* the
publish gesture.

**Only `main` publishes.** Running the workflow by hand (Actions → Release → Run
workflow) on any other branch, or on a tag, builds every file into a draft
pre-release named after the branch and commit, which no panel ever sees. Ticking
*publish* there does not change that: the `check` job warns that only `main`
publishes and builds the draft anyway. From `main`, *publish* creates the real
release for the current version, unless that version is already released.

To build locally instead, `npm run release` with `ORDERBOOK_RELEASE_KEY` and
`ORDERBOOK_RELEASE_KEY_ID` set. It writes the same folder the USB-stick workflow
has always used.

### Shipping the product database with a build (2026-10-08)

Every Master build carries a product catalogue, which a **new install** loads on
its first boot: the printed catalogue (`master/assets/catalogue/swisware-plus-2026.md`
and its photos) unless the build carries a product backup zip. To ship the
company's current products instead, take **Products → Sub products → Backup
products (.zip)** on the live Master and build with it:

```bash
npm run release -- --catalogue D:/Backups/OrderBook-Products-Acme-2026-10-08.zip
```

(or set `ORDERBOOK_CATALOGUE_ZIP`). The release checks the zip holds a
`products.csv` before it builds anything, then copies it to
`master/assets/catalogue/products.zip`, which the Master build stages with the
rest of `assets/`. The run prints which catalogue it ships; a `products.zip`
left there by an earlier `--catalogue` run ships too until it is deleted. That
path is git-ignored, so the CI release ships the committed catalogue unless the
owner commits a zip there (`git add -f`), which is his decision.

The shipped catalogue is loaded **once**, and only into an install whose
catalogue has never held a main product (the Recycle Bin counts): a fresh
install, before or after first-run setup, or a Master whose data was erased. An
update never touches an existing catalogue; the internal setting
`internal.shippedCatalogueLoaded` records that the check was made.

## When a new build shows up

A Master with `ORDERBOOK_RELEASES_GITHUB_REPO` set looks for a new release two
minutes after it starts and then every `ORDERBOOK_RELEASES_POLL_MINUTES` (**2**
by default since 1.4; it was 180), and downloads it into its releases folder. Opening an Updates
screen asks GitHub too, but waits no more than five seconds for the answer — a
setup file takes minutes to arrive — and then says what the folder holds. So
between a release being published and the next poll, an Updates screen can say
there is nothing new while the build downloads behind it. Open the screen again
a few minutes later.

The poll fetches the office build for the Master's own operating system, and
for every other one a panel has already had a build for: once a Mac panel has
asked, the `office-panel` folder holds `latest-darwin.json`, and each later Mac
build comes with the poll. The first time a panel on a new operating system
asks, its build only starts downloading then, so that panel's Updates screen
shows nothing to install yet: check again a few minutes later. To stop fetching
for an operating system the shop no longer runs, delete its
`latest-<platform>.json` and its setup file from `office-panel`.

## 1.4: Check now, the progress bar, Save all and the nightly update

**What has to be true on a real install for any of this to run.** Three things,
all in `.env` or in the build, none of them a code change:

1. Nothing, for the repository: every Master fetches from the public
   `BlazingFire/OrderBook-Releases` by default (`DEFAULT_RELEASES_REPO`).
   `ORDERBOOK_RELEASES_GITHUB_REPO=owner/repo` in `.env` points it elsewhere, and
   setting it to nothing (`ORDERBOOK_RELEASES_GITHUB_REPO=`) turns fetching off
   for an air-gapped site. Under tests (`NODE_ENV=test`) the default is off.
2. The build carries the release key. `TRUSTED_RELEASE_KEYS` holds
   `release-2026-10-01`, so a release signed with the matching private key is
   trusted and `ORDERBOOK_ALLOW_UNSIGNED_RELEASES` is **not** needed. An
   unsigned release is still refused.
3. The Master PC can reach `api.github.com` and the asset hosts. Offices never
   do: they ask the Master.

**Rate limit.** Unauthenticated, GitHub allows 60 API calls an hour. The poll is
every two minutes, so the release listing is read once per sweep and shared by
every build and every Office that asks (a 20 s cache), and a repeat after that
is a *conditional* request (`If-None-Match`), which GitHub answers `304` without
counting it. Check now forgets the cache but keeps the etag, and presses closer
together than ten seconds share one answer.

**Check now** is a button on both panels' App update screen. The Master's asks
GitHub at once; the Office's asks the Master (`/api/updates/office/latest?check=1`),
which asks GitHub. The answer comes within five seconds; a build still
downloading is shown by its progress bar and, when it lands, everybody is told.

**Who is told.** The first time a poll or a check finds a build newer than the one
running, every active account gets one `update.available` bell notice for that
version (`master/src/services/auto-update.ts`). The version is remembered in
`<dataDir>/auto-update.json`, so reading the notice and the next poll finding the
same build does not send it again. An open Updates screen re-reads every 30 s.

**The progress bar** shows bytes done of the total, speed (a five-second moving
average, so a stall shows as a stall) and time left, for the Master fetching
from GitHub (`/api/updates/status` → `download`) and for an Office fetching from
the Master (`/api/updates/progress` on the Office).

**Install now** on either panel: prepare/download and verify, then *Save all*
(below), sign out, then the shell stops the server and runs the setup silently
(`/S --force-run`: no wizard, and the new version opens itself when the install
ends). Windows asks for administrator approval once; declining it puts the server
back and shows "Sign in again".

**Save all.** No form in this product keeps a draft on disk, so there is no draft
store to keep things in. What registers (`useUnsavedWork`) is the **New lead**
form on both panels: a lead that is ready is saved exactly as Ctrl+Enter would,
and one that is not (no party yet, a product card half-filled) is named in a
dialog with "Update anyway" or Cancel. The shell also asks the page to save before
it closes the window (`onBeforeUpdate`, waited on for at most eight seconds), so
the nightly update does the same. Everything else open (a party form, a product
drawer) is not saved: the install button's confirmation is the only protection
there.

**An Office on another version than its Master** shows a blocking "Update needed"
screen after sign-in, in place of the app, and anybody signed in may install
(it is mandatory; the Windows prompt still needs an administrator). It applies
only once the Office *knows* the Master's version, which it learns from the
Master's own snapshot, so an Office that starts with no connection works offline
as ever; the first snapshot from a newer Master brings the screen. An Office that
is *ahead* of its Master is held too, on a "Waiting for the Master to update"
screen that has no install to offer: the owner's rule is that the app starts only
when both are on the same version. That screen asks for the Master's version again
every ten seconds and opens by itself the moment the Master matches.

**The nightly update** (Master only, default **on at 23:00**, set on the App update
screen by anybody with `settings.manage`): from the chosen time until **05:00 the
next morning** (so a 23:30 setting, or a Master that was busy or restarting at
23:00, still gets its run after midnight; a daytime choice keeps a three-hour
window), once a *night*, the Master (1) fetches, (2) writes a copy of its data to
`<dataDir>/pre-update-backups` (the newest three kept; no photos), (3) verifies
and holds the installer, and (4) puts one request on its loopback health route.
Its desktop shell polls that route every 30 s and runs the same checked install as
the button, with nobody there. The new version starts itself, the server serves
the Offices as soon as it is up, and the window shows the sign-in screen: nobody
has to sign in for the shop to work. The PC has to be switched on and signed in to
Windows overnight (it is a desktop app).

**How the unattended install gets administrator rights (and why that is safe).**
The Windows installer is per-machine and needs administrator approval, and at
23:00 nobody can give it. So the installer, which *is* approved once when the
Master is installed, registers a scheduled task, **OrderBook Master Update**, with
the highest privileges of the account that installed it, and makes two folders
under `%ProgramData%\OrderBook`:

| Folder | Who can write it | What it is for |
|---|---|---|
| `staged-update` | anybody | the Master app (not elevated) leaves the setup file and its signed `manifest.json` here |
| `elevated` | administrators and SYSTEM only (inheritance removed, owner Administrators); Users may read | the task copies the setup file here, hashes the copy, runs it with `TEMP` here, and writes `result.json` and `apply.log` |

**Making those folders is not a plain `icacls`.** A folder that already exists, or
a custom install location, is the classic way to turn "install once as
administrator" into "any program becomes administrator". So `update-dirs.ps1
-Mode Install` (run by the installer, elevated; `master/installer/apply-update`):

- **takes over the program folder** (a custom install such as `C:\OrderBook` inherits
  Users:Modify, which would make the task's script and the release keys editable by
  any program): owner Administrators, a protected ACL, Users read-and-run, and a
  scan for links or foreign entries inside it;
- **checks every folder above it**, up to the drive root: not a link, owned by
  Administrators, SYSTEM or TrustedInstaller, and nobody else allowed to delete or
  rewrite it (creating a new sibling, as `C:\` lets any user, is harmless);
- **never reuses `%ProgramData%\OrderBook` as found**: a junction or symbolic link
  there is removed (never followed), a folder owned by anybody else is moved aside,
  and the new one is created Administrators-owned with a protected ACL, then
  re-read and verified. `icacls` is only ever run with `/L`, so it cannot follow a
  link and leave the attacker as owner;
- **finds the folders by the Windows known-folder API** and records them, with the
  system's own `powershell.exe`, in `resources\apply-update\paths.json` in the
  hardened program folder. The task reads that file; it trusts **no environment
  variable** (`%ProgramData%`, `%TEMP%`, `NODE_OPTIONS`… are all things the
  account's other programs can change).

**The installers' own PowerShell is verified too.** The installer extracts
`update-dirs.ps1` (and, for the uninstall sweep, `uninstall-orderbook.ps1`, in both
the Master's and the Office's installer) to a temp folder that another program
running as the same account can write, and runs them elevated. So none of them is
run from the file. The command line the installer builds
(`tools/nsis/verified-powershell.nsh`):

1. is the system's own `powershell.exe` by absolute `$SYSDIR` path, and **pins
   `PSModulePath` to `$PSHOME\Modules` as its first statement**. `-NoProfile` does
   not stop PowerShell auto-loading a module such as `Microsoft.PowerShell.Archive`
   from the user's own writable `Documents\WindowsPowerShell\Modules` (a planted
   one runs on first use; a test does exactly that). The task's own PowerShell is
   started with an environment **built from nothing** (`taskChildEnv`: system folders
   derived from `paths.json`, a fixed `PATH`; no `COR_*`/`COMPlus_*`/`DOTNET_*`
   .NET-profiler variable, which would load a DLL into the elevated process, no
   `NODE_*`, no user `PATH`). `apply-update.cmd` and this macro clear those variables
   too, and `update-dirs.ps1` pins the module path again before its first cmdlet.
   The elevated uninstall sweep takes **no delete target from the environment** (known-folder
   API only; `ORDERBOOK_RELEASES_DIR` is not read), refuses any folder that is not
   plainly OrderBook's, a drive root, or a link, and removes links inside a folder as links;
2. reads the file **once**, checks its SHA-256 against the value baked in when the
   installer is **compiled** (`!system` runs `tools/bake-script-hashes.cjs`, so even
   `electron-builder --prepackaged`, which skips `afterPack`, cannot leave a stale
   hash, and a failed bake stops the compile), and runs *those bytes from memory*;
   a swapped file is exit 9 and nothing runs;
3. wraps the call in `try/catch` and ends in an explicit exit code, so a binding
   error cannot fall through to success and register the task;
4. receives every path as an **environment variable** (`OB_SCRIPT`, `OB_INSTDIR`),
   never pasted into the command, so a `$`, a backtick or a quote in an install
   path is data and not code.

Every other program an administrator runs there is an absolute `$SYSDIR` path too,
`netsh.exe`, `schtasks.exe` and `cmd.exe` included.

If any of that fails the task is **not registered** (and an older one is removed):
the nightly update then falls back to asking for approval, as it does without a
task. The task re-runs the same folder check (`-Mode Check`) before it touches
anything, and does nothing, not even write a log, if its folder fails it.

The launcher (`apply-update.cmd`) clears every `NODE_*` and `ELECTRON_*` variable
before it starts the program as plain Node, and the shipped `.exe` has the Electron
fuses `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`
switched off (`tools/flip-fuses.cjs`, an `afterPack` hook on every Windows build,
the Windows 7 one included), so `NODE_OPTIONS=--require evil.js` or `--inspect`
cannot run code in the elevated process. The `RunAsNode` fuse stays on: the
product starts its own server that way.

At 23:00 the shell does not install anything itself: it stages the files and asks
Windows to run the task (`schtasks /Run /TN "OrderBook Master Update"`). The task
runs a fixed script from the program folder (`resources\apply-update`, writable
only by an administrator) that **believes nothing it is given**:

1. it verifies the manifest's **Ed25519 signature itself**, against the release
   keys compiled into the *installed* program, and refuses an unsigned one
   whatever `ORDERBOOK_ALLOW_UNSIGNED_RELEASES` says;
2. it checks the manifest is for the Master on Windows and is **newer** than the
   installed version, so an old signed release cannot be replayed;
3. it copies the setup file into `elevated`, checks the copy's **size and SHA-256**
   against the signed values, and only then runs the copy, silently
   (`/S --force-run`), with `TEMP` and `TMP` pointing into `elevated\tmp` (the
   account's own temp folder is one its other programs can write), waiting for it
   to finish.

**If the task refuses, the server comes back.** By the time the shell asks Windows
to run the task it has stopped the server. The task writes its answer
(`checking`, `installing` or `refused`) to `elevated\result.json`, which the shell
may read; the shell quits only on `installing`, and restarts the server on
`refused`, or when nothing has been said for 90 seconds (the account was not
logged on, the task could not start, its folder failed the check). A forged
answer can only make the shell quit early or restart its own server.

Anyone who can write `staged-update` can therefore make the task install only a
build the owner signed, and only a newer one. The shell makes the same checks
first, so a refusal happens with the server still running; the task's own checks
and `elevated\apply.log` are what stand if the shell is lied to.

If the task is not there (a Master installed before 1.4, or run from source), a
shell that is already elevated installs directly; anything else **declines and
leaves the server running**, and the screen says the update was prepared and not
installed. The first interactive "Install now" after upgrading registers the
task for the nights after. The task belongs to the account that ran the
installer, so that account must be the one signed in to Windows on the Master PC
overnight. Uninstalling removes the task and both folders (not during an update,
which the task may have started).

**Where the old menu went.** The menu bar is gone on Windows and Linux; macOS
keeps only Quit, Edit (Copy/Paste) and Window.

| Old menu item | Now |
|---|---|
| Edit roles (Cut, Copy, Paste, Select All) | macOS only: the Edit menu; Windows and Linux handle the keys natively |
| View → Reload (Ctrl+R) | F5, `view.refresh` (already a command) |
| View → Full screen | F11, in the shell (`shellKeyAction`) |
| View → Developer tools | Ctrl+Shift+I, in a build that is not packaged |
| Help → Check for updates | the App update item in the sidebar, and its Check now button |
| Help → Keyboard shortcuts (F1) | D4 adds F1 as a real chord (`keys.help`) |
| Help → Open log folder | a button on the App update screen (`openLogFolder`) |
| Help → Version | the App update screen |

## What data survives

All of it. The installer replaces the program files; the database, uploads and
generated secrets live in `ORDERBOOK_DATA_DIR` (by default outside the install
directory precisely so an installer cannot delete them), and migrations run on
next boot. Downgrading is not supported — a migration that has run is not
expected to un-run.

Two more things hold that line from 1.2.0 on, the version customers run:

- **Migrations only add.** `master/tests/migration-data-safety.test.ts` fails
  `npm run verify` on any migration after `20260324000000_product_master_trim`
  whose `up()` truncates, drops a table or column, or deletes rows. Two
  migrations before that line did exactly those things, by the owner's
  decision at the time; nothing after it may, without the owner's sign-off
  and a written record.
- **The database is copied before a new version's first boot.** With the
  cluster still stopped, the Master copies `<data>\postgres` to
  `<data>\backups\before-<version>-<stamp>\postgres`, writes a `README.txt`
  with the restore steps beside it, keeps the newest two copies and removes
  older ones. It is skipped when this version has booted here before
  (`<data>\booted-version`), on a first run, when a PostgreSQL process is
  still holding the cluster, when the drive lacks the room, and on any
  machine with `ORDERBOOK_UPGRADE_SNAPSHOT=0`; a copy that cannot be taken is
  logged and the boot goes on. External databases (`DATABASE_URL`) are not
  copied — whoever runs them keeps their backups.

To go back after a bad update: quit the Master, rename `<data>\postgres` aside,
copy the `postgres` folder out of the newest `backups\before-…`, and reinstall
the previous build. The `README.txt` in the copy says the same.

## Linux: updating the AppImage

On Linux the file the update path installs is
`OrderBook-<Panel>-<version>-Setup.AppImage`, the one the Linux manifest names.
There is no installer to hand it to — an AppImage is the whole program in one
file — so the shell installs it itself (`electron/lib/appimage.ts`): it takes
the file from the panel's folder and checks its hash exactly as it does a
Windows setup file, writes it beside the AppImage it was started from, makes it
executable, renames it over the old one, and starts it again once the old copy
has quit — with `--appimage-extract-and-run` again if that is how the old copy
was started, as it is on a system without FUSE. The path stays the same, so a
desktop entry or a link pointing at the file keeps working; the file's name
keeps the version it was first downloaded as, and the Updates screen shows what
is actually running.

Keep the AppImage in a folder the person running it can write — somewhere in
their home folder, not one only root can write. Otherwise the update is
refused before anything is stopped, and the log says why.

A copy that was not started from an AppImage cannot update itself. In a shipped
build that is one installed from the `.deb`, whose files belong to the package
manager: the Updates screen says to install the new `.deb` the same way instead
of offering a button, and the shell refuses if asked anyway.

## Setup files only (1.4.1)

A release is the setup file and its signed manifest, nothing else: `-Setup.exe`
on Windows, `-Setup.AppImage` on Linux, `-Setup.dmg` on macOS. There is no
Standalone `.exe` (electron-builder's `portable` target), no Linux `.deb`, and
no `.sha256` file beside the setup (the manifest carries the SHA-256). Releases
up to 1.4.0 did publish those; copies of them in a releases folder that is
already in the field are left alone by the Master's sweep (an operator's to
delete), and a Standalone copy somebody still runs keeps refusing to install an
update over itself and says to get the setup instead (`electron/lib/standalone.ts`).
Install the setup file over it: both keep their data in the same place.

## The Windows 7 Office build

The Office Panel has a second Windows build for Windows 7, 8 and 8.1
([`WINDOWS7.md`](WINDOWS7.md)): `OrderBook-Office-Win7-<version>-Setup.exe`
on Electron 22, for x64 and ia32 in one file. It has its
own update channel, `win7`, beside `win32`, `darwin` and `linux`:

- In the releases folder its manifest is `office-panel/latest-win7.json`. No
  `latest.json` is written for it: that name stays the Windows 10 build's.
- On GitHub the manifest is `latest-office-win7.json`, uploaded by the
  workflow's `win7` leg. A Master with the GitHub poll fetches it once a
  Windows 7 panel has asked, like any other operating system's build.
- A Windows 7 panel works out its channel itself (an Electron older than 23 on
  Windows means `win7`) and asks for it with `?platform=win7`. It refuses any
  manifest whose signed platform is not `win7`, before even checking the
  signature, so it can never be offered the Windows 10 build.
- The Master's sweeps tell the two Windows builds apart by the `Win7` in the
  file name, so syncing one never removes the other's setup file or its
  `.part` download.

**Update the Master before the Windows 7 panels.** A Master from before this
channel reads an unknown platform as Windows 10 and would offer that build;
the panel refuses it, and its Updates screen says there is no update until the
Master is updated.

A release by hand needs both builds: `npm run release -- --os win` and
`npm run release -- --os win7`, on Windows, into the same releases folder. The
second builds the Office only.

## What stops a bad update

Roughly in the order an attacker meets them:

- **The manifest is signed**, over `panel`, `platform`, `version`, `file`,
  `sizeBytes`, `sha256` and `releasedAt` (`SIGNED_MANIFEST_FIELDS` in
  `shared/src/domain/release-signature.ts`). A digest published next to the
  file it describes proves only that the two agree; whoever replaces one
  replaces the other. The signature is the part that says *you* published it.
- **`panel` and `platform` are signed too**, so a Master build cannot be
  relabelled and served to every till in the shop, nor a Windows build offered
  to a Mac.
- **The signature is checked before the installer is downloaded**, so nobody who
  can answer for `api.github.com` can spend a shop's bandwidth and disk at will.
- **Every redirect hop is checked against an allowlist.** `fetch` follows
  redirects by default, so "we asked github.com" says nothing about where the
  bytes came from.
- **The download is capped at the size in the manifest** and streams to a
  `.part` file that is renamed into place only when complete, so a truncated or
  endless body leaves the folder empty rather than half a setup file.
- **The shell hashes the bytes again immediately before running them**, in its
  own process, and runs the file from a per-user folder rather than the shared
  releases folder — because a file in a folder anybody can write can be swapped
  between being checked and being run.
- **The renderer cannot choose what runs.** It can ask for an update; the path
  comes from the shell's own server over loopback.

The setup files themselves are not code-signed — that is a certificate purchase,
not a code change — so Windows SmartScreen will still warn on first run.

## Leftovers from a failed download

A download that fails — a dropped connection, a full disk, a power cut — leaves
whatever reached the disk behind, and the next attempt clears it before it
starts. There are two kinds of leftover and they are treated differently on
purpose:

- **Half-written files** (`.part`, `.tmp`) are removed *before* each download.
  Nothing ever reads one, so removing one cannot take anything away from
  anybody. They are matched by pattern rather than by name, because every
  filename here carries a version — and a cleanup keyed to a filename stops
  working the moment the version moves, which is exactly when a failed download
  is most likely to have left something.
- **Superseded installers** are removed only *after* a verified replacement has
  landed and its manifest has been rewritten (`latest-<platform>.json`, and
  `latest.json` too for a Windows build). Until that moment the old file
  **is** the release: it is what the manifest names, what the shell would
  install, and what every Office panel on the LAN is asking the Master to
  stream. Deleting it first and then failing the download would leave a manifest
  pointing at a file that no longer exists — a worse state than the disk space
  it saves.

The sweep only removes files it could have written itself, for the operating
system it is fetching: setup files named `OrderBook-Master-<version>-Setup.<ext>`
or `OrderBook-Office-<version>-Setup.<ext>` (`exe`, `dmg` or `AppImage`), their
`.part` downloads, and that OS's manifest `.tmp` files. The Windows 7 Office
build counts as an OS of its own here: its files carry `Win7` in the name
(`OrderBook-Office-Win7-<version>-Setup.exe`), and a Windows sync and a Windows
7 sync each leave the other's alone. A Master whose panels run
more than one OS keeps one build per OS in the same folder — its own OS's comes
with the background poll, and another OS's first build when a panel on that OS
asks, its later ones with the poll too (see *When a new build shows up*) — and
neither sweep touches the other's files. Notes, subfolders, old standalone
`.exe` and `.deb` copies (releases up to 1.4.0), and anything else an operator puts in the releases
folder are left alone. An installer that is part-way through being applied is
protected too, so a new release landing between the Update button appearing and
somebody pressing it cannot delete the file out from under the click.

On Linux, keep the AppImage you run outside the releases folder. An AppImage is
the program itself rather than an installer, and a superseded one in the
releases folder is removed like any setup file — except the one the Master is
itself running from, which it never removes.

Office panels keep the same guarantee for `<data>/updates`, and the desktop
shell's staging folder holds one installer at a time rather than one for every
version ever installed.

A leftover that cannot be removed — on Windows, a file another program holds
open, such as an antivirus scan — is left for the next run rather than failing
the update. An update that refused to proceed because last month's build was
busy would be a worse outcome than the disk space. A file still being streamed
to a panel is not one of those: removing it succeeds, and the panel's download
carries on from the file it already has open.

## Turning it off

Unset `ORDERBOOK_RELEASES_GITHUB_REPO`, or set
`ORDERBOOK_RELEASES_POLL_MINUTES=0`: either one stops every fetch from GitHub —
the background poll, Check now, the Updates screen and an Office panel's ask
alike (before 2026-10-07, `0` stopped only the poll). The releases folder keeps
working on its own either way.
