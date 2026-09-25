# Shipping an update

Push a version bump to `main` and every installed copy offers the new build.
This describes how that works, and the one ordering rule that will lock you out
of your own fleet if you get it backwards.

## The shape of it

```
you push to main
  → .github/workflows/release.yml builds both Windows installers,
    signs their manifests, publishes a GitHub Release
  → each Master polls that release, checks the signature,
    downloads into its releases folder
  → the Master offers its own build on the Updates screen
  → every Office Panel asks its Master over the LAN and installs from there
```

Only the Master talks to the internet. A shop floor with no route to the
outside world still updates every till from one PC, and a site with no internet
at all keeps working exactly as before: copy the releases folder in on a USB
stick and nothing else changes.

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

Create a **public** repository holding nothing but release assets, e.g.
`you/orderbook-releases`.

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
| Variable | `RELEASES_REPO`   | `you/orderbook-releases`                       |

On each Master PC, in its `.env`:

```
ORDERBOOK_RELEASES_GITHUB_REPO=you/orderbook-releases
```

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

To build locally instead, `npm run release` with `ORDERBOOK_RELEASE_KEY` and
`ORDERBOOK_RELEASE_KEY_ID` set. It writes the same folder the USB-stick workflow
has always used.

## When a new build shows up

A Master with `ORDERBOOK_RELEASES_GITHUB_REPO` set looks for a new release two
minutes after it starts and then every `ORDERBOOK_RELEASES_POLL_MINUTES` (180
by default), and downloads it into its releases folder. Opening an Updates
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

## The standalone build

Beside each `-Setup.exe` the release makes an `OrderBook-<Panel>-<version>-
Standalone.exe`: the same panel as one file that runs without being installed
(electron-builder's `portable` target). It unpacks under `%TEMP%` on each
launch, needs no administrator rights, and keeps its data in exactly the same
directory as the installed build — so a customer can start on the standalone
file and move to the installer later, or replace one standalone file with a
newer one, without touching a record.

What it cannot do is install an update over itself: there is no installer to
hand the setup file to, and running one would leave two copies sharing one
database. The Updates screen says to replace the file instead, and the shell
refuses to launch an installer from a standalone build. Windows asks about the
firewall on its first run, since no installer added the rules.

The standalone file is not in `latest.json` — the manifest describes what the
update path installs — but it is published with a `.sha256` beside it so a
copy that crossed a USB stick can be checked (`certutil -hashfile <file>
SHA256`). The Master's releases-folder sweep leaves standalone files alone;
old ones are the operator's to delete.

## What stops a bad update

Roughly in the order an attacker meets them:

- **The manifest is signed**, over `panel`, `version`, `file`, `sizeBytes`,
  `sha256` and `releasedAt`. A digest published next to the file it describes
  proves only that the two agree; whoever replaces one replaces the other. The
  signature is the part that says *you* published it.
- **`panel` is signed too**, so a Master build cannot be relabelled and served
  to every till in the shop.
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
`.part` downloads, and that OS's manifest `.tmp` files. A Master whose panels run
more than one OS keeps one build per OS in the same folder — its own OS's comes
with the background poll, and another OS's first build when a panel on that OS
asks, its later ones with the poll too (see *When a new build shows up*) — and
neither sweep touches the other's files. Notes, subfolders, the standalone
`.exe` and the Linux `.deb`, and anything else an operator puts in the releases
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
`ORDERBOOK_RELEASES_POLL_MINUTES=0` to keep manual checks but stop the
background polling. The releases folder keeps working on its own either way.
