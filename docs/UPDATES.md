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

## What data survives

All of it. The installer replaces the program files; the database, uploads and
generated secrets live in `ORDERBOOK_DATA_DIR` (by default outside the install
directory precisely so an installer cannot delete them), and migrations run on
next boot. Downgrading is not supported — a migration that has run is not
expected to un-run.

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
  anybody. They are matched by suffix rather than by name, because every
  filename here carries a version — and a cleanup keyed to a filename stops
  working the moment the version moves, which is exactly when a failed download
  is most likely to have left something.
- **Superseded installers** are removed only *after* a verified replacement has
  landed and `latest.json` has been rewritten. Until that moment the old file
  **is** the release: it is what the manifest names, what the shell would
  install, and what every Office panel on the LAN is asking the Master to
  stream. Deleting it first and then failing the download would leave a manifest
  pointing at a file that no longer exists — a worse state than the disk space
  it saves.

The sweep only removes files it could have written itself: anything named
`OrderBook-Master-<version>-Setup.exe` or `OrderBook-Office-<version>-Setup.exe`,
plus the two debris suffixes. Notes, subfolders and anything else an operator
puts in the releases folder are left alone. An installer that is part-way
through being applied is protected too, so a new release landing between the
Update button appearing and somebody pressing it cannot delete the file out from
under the click.

Office panels keep the same guarantee for `<data>/updates`, and the desktop
shell's staging folder holds one installer at a time rather than one for every
version ever installed.

A leftover that cannot be removed — on Windows, a file still being streamed to a
panel is locked — is left for the next run rather than failing the update. An
update that refused to proceed because last month's build was busy would be a
worse outcome than the disk space.

## Turning it off

Unset `ORDERBOOK_RELEASES_GITHUB_REPO`, or set
`ORDERBOOK_RELEASES_POLL_MINUTES=0` to keep manual checks but stop the
background polling. The releases folder keeps working on its own either way.
