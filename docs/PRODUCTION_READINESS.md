# Production readiness — shipping to customers

From 1.2.0 onwards OrderBook is installed on customers' PCs, and the owner's
rule for every version after it is one sentence: **an update replaces the
software and never touches the data.** This page says how the product keeps
that promise, what has to be done once before the first customer build goes
out, what has to be done for every release after it, and what is still open.

Read `docs/UPDATES.md` for the mechanics of an update and `HANDOFF.md` for the
state of the tree. This page is the checklist; those are the reference.

## 1. How an update keeps its hands off the data

| Guarantee | Where it lives | How it is checked |
| --- | --- | --- |
| The data directory is outside the program folder (`%APPDATA%\OrderBook\{master,office}`, or wherever the operator moved it) | `electron/shell.ts` sets `ORDERBOOK_DATA_DIR` / `ORDERBOOK_OFFICE_DATA_DIR`; the pointer file sits *beside* the data, never inside the program folder | `electron/tests`; a packaged install-then-update on a real PC (see §2) |
| The installer never deletes data, and an update never runs the uninstall sweep | `deleteAppDataOnUninstall: false` in both `electron-builder.yml`; `${isUpdated}` guard in `installer/installer.nsh` | Read the NSIS hook; test an over-the-top install (§2) |
| Uninstalling asks before it deletes anything, and defaults to keeping it | `installer.nsh` (`MB_DEFBUTTON2`, `/SD IDNO`), `orderbook:uninstall` in the shell (`keepData` must be an explicit boolean) | `electron/tests/uninstall.test.ts` |
| Migrations after 1.2.0 only **add** — no truncate, no dropped table or column, no deleted rows in `up()` | `master/tests/migration-data-safety.test.ts` pins the line at `20260324000000_product_master_trim` | The test fails the build on any later migration that destroys data; an exemption needs the owner's sign-off and a written record |
| A whole copy of the database is taken before the first boot of a new version | `master/src/db/cluster-snapshot.ts`, called from `master/src/index.ts` before the cluster starts; `<data>/backups/before-<version>-<stamp>/` with a `README.txt` naming the restore steps; newest two kept | `master/tests/cluster-snapshot.test.ts`; the folder appears after the first boot of a build |
| A migration that fails leaves the schema as it was | Knex runs each migration in a transaction; the Master then stays on its boot screen naming the error instead of half-migrating | Integration suites; the boot screen |
| The setup file that runs is the one that was published | SHA-256 in a signed manifest, re-hashed by the shell immediately before launch, from a per-user staging folder | `master/tests/updates.test.ts`, `release-signature.test.ts`, `electron/tests/installer.test.ts` |
| The Office panel's queued work survives its update | The outbox and snapshot cache live in the Office data directory, under the same rule as the Master's | Update an Office panel with unsent leads in its outbox and watch them go out afterwards (§2) |

What an update **does** do to data, and is allowed to: it adds tables and
columns, backfills values, rewrites database functions, and rebuilds derived
folders (image variants, search indexes). None of that loses a record.

## 2. Before the first customer build — once

Do these in order; the first two decide whether "from now on it just updates"
is true.

1. **Decide what happens to a PC running 1.0.3.** The migrations that shipped
   between 1.0.3 and 1.2.0 were written for a product with no customers:
   `20260323000000_product_variants` **truncates** every product-linked table
   (products, categories, images, stock, reservations, leads, orders, lines,
   timelines) and `20260324000000_product_master_trim` **drops** the pricing
   and tile-trade columns. Parties, users, roles, settings and the activity
   log survive; products, leads and orders do not. A 1.0.3 machine updated to
   1.2.0 therefore starts its catalogue and order book afresh — the automatic
   copy in `backups/before-1.2.0-…` keeps the old cluster, but there is no
   path that brings the old rows into the new shape. If any customer holds
   real 1.0.3 data, export it first (Settings → Backup) and treat the 1.2.0
   install as a fresh start with the Swisware catalogue loaded. From 1.2.0
   on this cannot happen again: the guard in §1 fails the build.
2. **Make the release key and ship a build that trusts it, before signing
   anything.** `TRUSTED_RELEASE_KEYS` in `shared/src/domain/release-keys.ts`
   is empty, so an installed panel refuses every *signed* release with
   `unknownKey` and every *unsigned* one with `unsigned` unless that machine
   sets `ORDERBOOK_ALLOW_UNSIGNED_RELEASES=1`. Either:
   - run `npm run release:keygen`, commit the public key, build **that** and
     install it by hand on every customer PC, then sign every release from
     then on (`docs/UPDATES.md` §Setting it up); or
   - for USB-stick sites with no internet, set
     `ORDERBOOK_ALLOW_UNSIGNED_RELEASES=1` in each Master's `.env` and keep
     publishing unsigned. Unsigned drafts on GitHub are what the workflow has
     produced so far (1.0.2, 1.0.3, 1.1.0), and no panel will install them.
3. **Build 1.2.0 on a healthy Windows machine.** Pushing the version bump to
   `main` makes `.github/workflows/release.yml` build every file on GitHub's
   Windows runner; `npm run release` does the same on a PC where
   electron-builder runs (it hung on the owner's PC — a machine problem, see
   `HANDOFF.md`). Ten files come out: a `-Setup.exe` and a
   `-Standalone.exe` for each panel, a `.sha256` beside each standalone file,
   and two manifests per panel — `latest-win32.json`, and `latest.json`, the
   one name panels older than the platform-named manifests read.
4. **Rehearse the update on a clean Windows PC or VM**, with the real
   installers, and write the date in `HANDOFF.md`:
   1. Install 1.2.0 Master, finish first-run setup, create a party and a
      lead; install 1.2.0 Office on a second PC (or the same one), pair it,
      create a lead offline and let it sync.
   2. Build a throwaway 1.2.1 (`npm run release 1.2.1` on a branch, do not
      push), copy it into `C:\OrderBook-Releases`, and update the Master from
      its Updates screen; then update the Office panel from its own Updates
      screen. Every record must still be there; `%APPDATA%\OrderBook\master\
      backups\before-1.2.1-…` must exist.
   3. Uninstall with *keep data*, reinstall, confirm the records are back.
   4. Run the standalone Master on a PC **without** administrator rights;
      accept the Windows firewall prompt; confirm an Office panel finds it.
   The scripts dry-run clean; the live path has never been exercised on a
   real machine — that is the one item nobody can do from the repository.
5. **Code-sign the executables** (a certificate purchase, not a code change),
   or accept that Windows SmartScreen warns on first run and tell customers
   so. `signAndEditExecutable: false` also leaves Electron's own name in the
   `.exe` properties until then.
6. **Decide the update channel per site.** Internet-connected Masters get
   `ORDERBOOK_RELEASES_GITHUB_REPO` in their `.env` (a *public* releases
   repository; see `docs/UPDATES.md`); air-gapped sites get the releases
   folder on a USB stick. Only the Master ever fetches; Office panels always
   take the office build from their Master over the LAN.
7. **Keep CI green.** `.github/workflows/ci.yml` was red on `main` for the
   thirteen update tests that only passed on Windows and for a web build
   script written in `cmd.exe` syntax; both are fixed in 1.2.0. A red `main`
   means nobody knows whether the release build is sound.
8. **Do not ship a seeded database.** `npm run seed:dummy` /
   `seed:sample` / the Developer tools exist for demos and tests. A customer
   PC starts from first-run setup, which shows the administrator credentials
   once, and has no screen for loading the Swisware catalogue: the Settings →
   Developer tab was removed in 5a32106, so on a customer PC the catalogue can
   no longer be loaded from the app. **This is a go-live gap.** The
   `/api/developer/load-catalogue` route is still present behind the developer
   token, and `npm run seed:catalogue` works from a checkout; nothing else loads it.
9. **Tell the customer where the data is and how to back it up.** The
   automatic pre-update copy is insurance against a bad update on the same
   disk; it is not a backup against a stolen or dead PC. Settings → Backup
   produces an encrypted export that restores on another machine; agree who
   takes it and how often.

## 3. Every release after 1.2.0 — the routine

1. **Change the schema additively.** `npm run verify` refuses a migration
   that truncates, drops a table or column, or deletes rows. If a change
   genuinely needs one, stop: the owner decides, a `docs/ai-handoffs/` note
   records what is lost and why, the pre-update copy is confirmed working on
   a real installation, and only then is the migration named in `EXEMPT` in
   `master/tests/migration-data-safety.test.ts`.
2. **Never rename, delete or rewrite a migration that may have run
   anywhere** (`migration-registry.test.ts` pins the names).
3. **Bump the version** across every package and push to `main`:
   `npm version patch --no-git-tag-version --workspaces --include-workspace-root`
   (or `minor`). The bump is the publish gesture; the workflow builds and,
   with `RELEASE_KEY` set, publishes; without it, a draft nobody installs.
   To build without publishing — a branch, a rehearsal — run the workflow by
   hand with *publish* left unticked: it attaches the files to a draft
   pre-release named after the branch and commit.
4. **Install the new build over the previous one on the rehearsal PC** before
   customers get it. The version on the Updates screen must move, the
   records must all be there, and `backups/before-<version>-…` must exist.
5. **Put the release notes in the commit message of the version bump** — the
   workflow copies it into the manifest's `notes`, which the Updates screen
   shows before the operator presses Install.
6. **Downgrading is not supported.** A migration that has run does not
   un-run. Going back is: quit, restore `backups/before-<version>-…/postgres`
   over the data directory's `postgres/` folder as its `README.txt` says,
   reinstall the previous build.

## 4. What each build does on update

- **Installed Master (`-Setup.exe`).** The Updates screen offers the newer
  build from the releases folder (or from GitHub); the shell re-hashes the
  file, stops the server and its PostgreSQL cleanly, runs the installer, and
  the new build's first boot copies the cluster, runs the additive migrations
  and records `booted-version`. Data directory untouched.
- **Installed Office (`-Setup.exe`).** Asks its Master for the office build,
  downloads it over the LAN, verifies it, and installs the same way. Its
  outbox and cache survive; queued leads go out after the restart.
- **Standalone (`-Standalone.exe`, either panel).** Runs without being
  installed and keeps its data in exactly the same place as the installed
  build, so the two are interchangeable. It cannot install an update over
  itself: the Updates screen says to replace the file, and the shell refuses
  to launch an installer. Replace the `.exe`, start it, and the same
  first-boot copy and migrations run. Windows asks about the firewall on the
  first run because there is no installer to add the rules; the unpack
  folder is fixed so the answer is remembered.
- **Linux AppImage (either panel).** Takes the build the Linux manifest
  names, verifies it like a setup file, writes it beside the running
  AppImage and renames it over it, then starts it again (with
  `--appimage-extract-and-run` if the old copy was started that way). The
  folder the AppImage sits in must be writable by whoever runs it, or the
  update is refused before anything stops (`docs/UPDATES.md`).
- **Linux `.deb`.** Not updated from the Updates screen, which says to
  install the newer `.deb` by hand, and the shell refuses if asked anyway.
  The data under `~/.config/OrderBook` is untouched.

## 5. Open — decisions only the owner can make

- Signing key and the ordering rule in §2 item 2 (until then, no installed
  panel will offer an update by itself).
- A code-signing certificate for the `.exe` files.
- The fate of 1.0.3 data (§2 item 1).
- Accepted risks recorded in `HANDOFF.md`: the plaintext password vault, no
  TLS on the LAN, last-write-wins on concurrent edits of one lead.
- Extra party fields (GST/tax id, credit terms), and the app's name and
  branding — unchanged since the questions were first asked.
- Whether to harden the uninstall scripts (`tools/uninstall/`). *Uninstall,
  delete data* removes the folder the `<panel>-location.json` pointer names,
  whole (`Remove-Item -Recurse` / `rm -rf`). Since 2026-09-25 an Office storage
  move refuses a drive root, the home folder and a folder holding anything that
  is not the panel's own, so a move can no longer point the uninstall at
  unrelated files.
  Deleting only a panel's own entries from a relocated folder would also cover
  the Master's first-run chooser, which is why it was left to the owner.
