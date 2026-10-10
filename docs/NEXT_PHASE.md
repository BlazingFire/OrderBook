# Next phase

Rewritten 2026-09-22 after the branch consolidation, when every open branch was
merged into `main` and the sessions that produced them were retired. Updated
2026-09-25 after the audit round (eleven `fix/*` branches merged into `main`):
what that round fixed is gone from here, and what it found and left is under
"Then: what the 2026-09-24/25 audit left". This file is about *what happens
next*; `HANDOFF.md` is what is true now and `docs/STRUCTURE.md` is the layout.
This file assumes both.

---

## First: 1.4.7 is released with everything combined (2026-10-10)

Every branch and the main checkout's uncommitted work are on `main`, pushed; only `main` exists. Version 1.4.7 is
published (`docs/releases/1.4.7.md`). Next:

1. Install the 1.4.7 Master Setup on this PC (it is still 1.4.4, which is why it shows Electron's logo and no
   notice board), then each Office. Check the desktop and taskbar icon is the OrderBook mark.
2. A browser or Electron pass of the To-do list and of the Office's New Order record screen (not done).
3. The owner decisions and the two backup files below (steps 2 and 3).

## Then: the 2026-10-09 product backup batch (on `main`, released in 1.4.7)

The product backup and restore made exact: every colour, weight, code, photo and caption comes back, older product
files are read, two installs' backups combine with no sub product twice, "Make the catalogue exactly this file"
leaves nothing shipped beside the owner's data, and an update changes no data. What is true is in `HANDOFF.md`,
under "Product backup and restore made exact (2026-10-09)", with its 2026-10-10 fix round (the exact run clears
the way before it writes, the preview takes the opt-ins, a sheet with no Colour column changes no colour); the rules
are in `docs/PRODUCT_IMPORT_FORMAT.md`. In order:

1. Done 2026-10-10: merged into `main` with the party-screen work and released in 1.4.7.
2. Ask the owner the nine decisions listed in `HANDOFF.md` ("Owner decisions waiting"): shipped photos on an update
   from 1.4.4 or earlier (his own Master), brand capitals, the exact option's default and emptying the Recycle Bin of
   what it moved, twins with identical cells, photo 2 of a one-colour sub product, the 1.4.5 catalogue
   corrections on his update, and, from the 2026-10-10 fix round: the colour list with no `colours.csv` under the
   exact option (L3), the exact option's second run when a main product it takes out only at the end holds a name
   the file gives another, and sub products with no stored position coming back numbered on a restore into an
   empty catalogue.
3. When he shares his two product backups: combine them into one zip (one row per sub product, each taking the
   other's data; main products, colours, brands and photos merged the same way), restore it onto a scratch new
   install with "Make the catalogue exactly this file", and check its export against both files. If the preview
   lists a main product rename refused for a name the run takes out only at the end, restore the same file a second
   time (`HANDOFF.md` question 8).
4. Done 2026-10-10: 1.4.7 built with this and the 2026-10-08 batch. Still owed: a browser or Electron pass of the
   restore dialog on the installed program.

## Then: the 2026-10-08 batch (on `main`, released in 1.4.7)

Product backup zip, a build that carries its product database, the Office setup inside the Master, the notice board on
Basic Home and at sign-in, Escape goes back, and the New Order dropdown chain. What is true is in `HANDOFF.md`, under
"Product zip, shipped catalogue, Office setup in the Master, …". In order:

1. Done 2026-10-10 (1.4.7). For the next build: bump first (`node tools/release.mjs <next>`, into a scratch `ORDERBOOK_RELEASES_DIR`). The default
   run now builds the Office first and packs it into the Master, so build both in one run. To ship the owner's own
   products, export them on the Master (Products › Sub products › Backup products (.zip)) and pass `--catalogue <zip>`.
   Build `--os win7` into the same folder first if the Master should also carry the Windows 7 Office (+140 MB).
2. Install it on this PC: the installed Master here is still 1.4.4, which is why the notice board looked missing.
3. Check on the real program: the Master Setup's size (about 85 MB more), Office panels › Add panel › Save Office setup…
   (Electron's Save As dialog), a new PC downloading `http://<master>:4100/api/updates/office/setup`, and the New Order
   chain with a real keyboard.
4. Not done here, and why:
   - Product zip on the Office: its download proxy holds a whole file in memory, and the restore needs the job screen
     only the Master has.
   - Enter pressed in the sub-product box before that product's list has arrived is ignored (as in 1.4.5); a very fast
     typist could lose that one Enter.
   - The card's ✕ on a product lifted from the Added list for editing closes it without putting its lines back
     (unchanged from 1.4.6); owner's call.
5. Second message (R10–R15) is on `main` too: Sell today, the product band, the person screen, the New Order walk to Add sub product. Panel protocol is now **11**, so every Office must update with the Master.
   - Sell today's "once a day" is per person per PC; pausing its countdown on hover is not built.
   - Office: the Notice board badge can come back after "Mark as read" on an offline reload (seen by the Sell today builder, not investigated).
   - Dates on the new screens use the PC's locale (dd-mm-yyyy on an Indian-English PC, as in the owner's screenshot).
6. Then the 1.4.6 leftovers below.
7. Superseded by the 2026-10-09 batch above: the shipped catalogue now loads only on an install not yet set up,
   and the shipped photos never attach on an update.

## Then: 1.4.6 is released; what comes next (2026-10-07)

1.4.6 (the new look, New Order grid, note layout for the pending-order PDF, pcs everywhere) is described in
`docs/releases/1.4.6.md` and `docs/DESIGN_SYSTEM.md`. Left for later, in order:

1. The owner's own passes first: a real two-PC pass, a real print or PDF of the notes and the pending order, and the installed
   program on a clean PC (including Windows 7).
2. Recycle bin: the "Pending Order" Type pill is clipped at app scale 157 % (1366 and 1920).
3. The "API keys" and "Notice board management" titles ellipsize at 1366 and 157 %.
4. A notes-only page of the notes shows "0 pcs this page"; it should show nothing for a page with no quantities.
5. The catalogue photo rebuild at start is refused if a newer `sharp` ever changes the blurhash of a shipped photo; decide whether
   that check should compare the picture instead.
6. Office `failForward` answers 502 where 404 is meant when the Master says a record is gone.
7. Converting a lead to an order drops the lead's notes (unchanged since 1.4.5). Whether it should carry them is the owner's call.

## Before that: 1.4.5 is released; what comes next (2026-10-07)

1.4.5 is on `main` @ `590609b` and published as v1.4.5. The details are in `HANDOFF.md`, under
"Notes, notice board, photos, catalogue, screen sizes + 1.4.5". In order:

1. The owner starts the installed Master again (it was found stopped on 2026-10-07) and installs 1.4.5,
   Master first. Windows' icon cache may show the old icon until it refreshes.
2. A real two-PC pass, plus a real print or PDF of both notes.
3. Two cosmetic leftovers at app scale 157 % (D12, 2026-10-07): the Recycle bin Type pill "Pending Order" is 3 px too
   wide in its column at 1366 and 1920, and the "Notice board management" title ellipsizes at 1366.
4. U14-5: when offline, check the draft's lines against `view.products` (productsComplete) before saving.
5. The backlog.

## Before that: 1.4.4 is released (2026-10-06)

1.4.4 (a party is private to the office user who created it) is on `main` @ `93fd1ac`, pushed
and released as v1.4.4. The details are in `HANDOFF.md` under "Party private to its
creator + 1.4.4". In order:

1. Published 2026-10-06 (Setups and manifests only).
2. The owner installs the Master, then the Offices.
3. A real two-PC pass with two office users and an admin.
4. Still open from 1.4.3: whether Duplicates should merge a Product that holds sub products.

## Before that: 1.4.3 is released (2026-10-05)

1.4.3 is on `main` @ `60d6b50` and published as v1.4.3 (Setups and manifests only). It brings
rate limits, caching, paged order lists, the Duplicates page, the sign-in device warning, Save
to .txt, the role assignment UI and crash hardening. The details are in `HANDOFF.md`, under
"Speed, limits, stability, duplicates + 1.4.3". In order:

1. The owner installs 1.4.3: the Master first, then the Offices.
2. The real-PC checklist from the 1.4.1 block below, plus the sign-in warning on a real
   low-spec PC and the Electron shell.
3. The owner decides whether Duplicates should merge a Product that holds sub products.
4. The backlog.

## Before that: 1.4.2 is released (2026-10-05)

1.4.2 is on `main` @ `dbd04c7` and published as v1.4.2 (Setups and manifests only). It is
English-only, and it carries the filter-strip and Panels-table fixes. The details are in
`HANDOFF.md`, under "English only, filter strip + 1.4.2". Next steps, in order:

1. The owner installs 1.4.2: the Master first, then the Offices.
2. The real-PC checklist from the 1.4.1 block below.
3. The backlog.

## Before that: 1.4.1 is released (2026-10-04)

1.4.1 is on `main` @ `2a7649a`, pushed, and published as release v1.4.1, which holds Setups and
manifests only. What landed, the decisions, the traps and what is owed are in `HANDOFF.md`
under **"Add-connection audit, Setup-only builds + 1.4.1"**. The notes for the owner are in
`docs/releases/1.4.1.md`.

In order:

1. **The owner installs 1.4.1:** the Master first, by hand over the existing install, then
   each Office. That is also the first real-PC pass.
2. **The real-PC checklist** in that HANDOFF section:
   - a Setup installed over the top;
   - the pairing window expiring;
   - two Masters;
   - the IP changing;
   - the firewall rules;
   - Win7;
   - the 11 pm update.
3. **Build every future release with `node tools/release.mjs`.** It produces Setup files
   only. Publish only the Setups and the `latest-*.json` manifests, and leave the release
   body empty, as the owner asked.
4. **The owner deletes the old remote branches** (the command is in HANDOFF).
5. **The backlog** below, unchanged.

The 1.4.0 block that follows is history.

## Before that: 1.4.0 is built; what comes next (2026-10-04)

The Party Access redesign (list screen, shared editor, summary endpoint, kit fixes) is
merged on `d5/1.4` @ `96d0b7f`; CH1 merges the docs, bumps the version to **1.4.0** and
builds the Windows Master and Office and the Win7 Office. What landed, the decisions, the
traps and what the owner owes are in `HANDOFF.md` under **"Party Access redesign + 1.4.0
(2026-10-04)"**. The release notes for the owner and the shops are `docs/releases/1.4.0.md`.

In order:

1. **Publish and verify 1.4.0** (CH1, then D4): `node tools/release.mjs` for each build
   (run the script directly: `npm run release --` drops arguments in PowerShell), signing
   key `%USERPROFILE%\.orderbook\release-2026-10-01.private.pem` with
   `ORDERBOOK_RELEASE_KEY_ID=release-2026-10-01`. Then check the published assets: the
   Ed25519 signature against `shared/src/domain/release-keys.ts`, SHA-256 and size, and the
   update flow from a 1.3.0 checkout (`7d8a731`). Never run a scratch server against the
   real releases folder or repository: set `ORDERBOOK_RELEASES_DIR` to a scratch folder and
   `ORDERBOOK_RELEASES_POLL_MINUTES=0` (see the PowerShell empty-variable trap in HANDOFF).
2. **The owner installs 1.4.0**, Master first, then each Office, by hand over the existing
   install (steps in the release notes). This is also the first real-PC pass.
3. **The real-PC pass.** The checklist in `HANDOFF.md` "1.4 batch" "Owed by the owner",
   plus the Party Access keyboard pass and the 11 pm update, which nothing has run for real.
4. **Branch and push decisions** (owner): `main` is not pushed; retire the merged branches
   and worktrees.
5. **The backlog** from the block below, unchanged.

The "1.4 batch is done" block that follows is history; its backlog list is still current.

---

## First: the 1.4 batch is done; what comes next (2026-10-03)

The 1.3 batch and the owner's 1.4 requests (R0-R22) are all on `main` @ `4caa3a4`
(not pushed), gated green. What landed, the owner's decisions, the traps and the long
real-PC checklist are in `HANDOFF.md` under **"1.4 batch (2026-10-03)"**. Read that
section first; the "1.3 batch" section under it is history.

In order:

1. **The real-PC pass.** Nothing in 1.4 has run on a real PC. `HANDOFF.md` "Owed by the
   owner" has the checklist: the installer and the scheduled task (items 1-10 from D1),
   the Printroom station claim, a real printer, the Win7 VMs and
   the owner's own pass over the Master panel.
2. **Release 1.3.0, Master first.** Bump the version everywhere (it is still 1.2.5), then
   `npm run release` and `npm run release -- --os win7` (the releases repository is
   `BlazingFire/OrderBook-Releases`). The owner decides when `main` is pushed and which
   merged branches and worktrees go.
3. **The backlog**, below: the five decisions only the owner can take, the audit
   leftovers, and the older items. Several were touched by 1.3 and 1.4 (stock is gone,
   the Chatroom and Printroom exist), so check each against the code before acting on it.

The older text that follows this block, "First: finish the 1.3 batch", is superseded; it
is kept because the rest of this file still refers to it.

---

## (Superseded) First: finish the 1.3 batch (2026-10-03)

Phases 0–4 and 8 of the owner's 1.3 batch are on `main`, and the helper's
party import/export and reports are merged. The helper session's branch
`helper/1.3` (git worktree `C:/Users/Z/Desktop/OrderBook-helper`) also holds
the pending-order notes, Save PDF and print copies, plus the Printroom, all
waiting for review and merge. The Chatroom is still to be built.

The status table and the ordered next steps are in `HANDOFF.md` under
**"1.3 batch — status and how to continue"**. The plan is
`docs/plans/1.3-BATCH.md` (approved) with `docs/plans/1.3-BATCH-DETAIL.md`.
Do that list before the older items below. Several of them were touched by
the batch, so check each against the code before acting on it.

## Do these first, in this order

### 1. The owner's five decisions, and three chores only the owner can do

Nothing below blocks on code as much as on these. They are summarised under
"Owed work" in `HANDOFF.md` and written up in `docs/PRODUCTION_READINESS.md` §5
(the Recycle Bin's in its brief, `recycle-bin-delete-actions-and-purge.md`):
what happens to a 1.0.3 machine's data, the release signing key, a
code-signing certificate, the Recycle Bin's retention policy, and whether to
harden the uninstall scripts (*Uninstall, delete data* removes the folder the
shell's pointer names, whole; an Office storage move now refuses a folder the
panel would not own, which closes the path the audit found).

The cloud sessions' git proxy refuses branch deletion and tag pushes (HTTP
403), so these are the owner's:

- Delete the twelve old branches on GitHub (listed in `HANDOFF.md` under
  "Branch consolidation").
- Delete the stale `v1.2.0` draft release (its Linux files predate the
  library-link fix and it has no macOS files), then run the Release workflow on
  `main` with *publish* ticked.
- Launch the macOS build on a real Intel and a real Apple silicon Mac. It has
  been built, never run: first boot must create the database, and a product
  photo upload exercises `sharp`.

### 2. The integration suites — how to run them

PostgreSQL refuses to start as root, so on a root checkout every integration
file skips and the summary still reads green. CI runs them on its Ubuntu runner
(`.github/workflows/ci.yml` installs PostgreSQL 16). Locally in a Linux
container, copy the checkout somewhere a non-root account owns and run vitest
as that account:

```
cp -a /home/user/OrderBook /tmp/obtest   # or tar it across, without .git
chown -R postgres:postgres /tmp/obtest
su postgres -s /bin/bash -c 'cd /tmp/obtest && TMPDIR=/tmp/obtest/.tmp HOME=/tmp/obtest/.home npx vitest run'
```

The copy is what avoids the `EACCES` vitest hits when it bundles its config
beside the repository. On 2026-09-25 this ran 160 files / 2015 tests, none
skipped.

**Check the skip count, not just the pass count.** A test nobody has executed
is a claim, not a check.

### 3. Do a browser and Electron pass

Almost nothing merged since 2026-09-22 has been seen running; only the Settings
permission change and the Socket.IO origin check (both in `d7481f7`'s run) were
exercised in a real Electron window. `master/web`
and `office/web` have no test files of their own. Since 2026-09-25
`ui/tests/master-shell.test.tsx` and `ui/tests/office-shell.test.tsx` boot both
panels in jsdom and pin which screen a key, toast or link lands on and what the
New lead form and the order weight override send; layout, styling, anything
that depends on visibility, and the desktop shell still need a real pass.
Specifically:

- **Settings** on both panels: the four groups, a number setting saved with its
  button (not per keystroke), per-row save feedback, the tab strip at 157% on a
  1366px screen, and each switch actually changing its screen — follow-up
  default on the Office's New lead, packaging no longer required to add a line
  or convert with `leads.packagingRequiredOnConvert` off, the adjustment note
  on the Master's physical count.
- The Master's **Parties** screen end to end, and the Office's Catalog and New
  lead afterwards — the party form is now one shared `PartyFormModal`.
- **Delete** in the Master's Pending Order and Final Order record screens (the
  header's trash button, not a list row), including the blocked case (the reason is
  named, not "could not delete").
- The **filter strip** on every list screen (it pads and grows now).
- **Change password** in the Master topbar lands on sign-in *with a message*.
- The **language picker** (Settings → Appearance) — switching back must work
  from a panel you can no longer read.
- **Shortcuts and the palette.** On the Master, Alt+3 opens Parties and
  Alt+4–9 the screens below it. On both panels, a screen the sidebar does not
  show this person is offered by neither Alt+N nor the palette; the Office
  palette has no *New record* row for a role without `leads.create`; and
  neither palette has a *Find* row (Ctrl+F still works).
- **Copy** buttons (an id field, the crash screen, the one-time password and
  API token dialogs) from a browser on *another* LAN PC, over plain HTTP: they
  must copy, and say Copied only when they did.
- An **Office storage move**, from the Master and from the Office's own storage
  card (sign-in screen and Settings): a drive root, the home folder and a
  folder holding other files are refused with the folder named; an empty
  folder is taken and is still the one in use after the app is restarted.
- **An AppImage update end to end on a real Linux PC**: download, verify,
  replace, relaunch, including a copy started with `--appimage-extract-and-run`;
  and (for a `.deb` installed from a release up to 1.4.0; none is built now) the
  "install the new package" text instead of a button. Only unit tests have run it so far.

### 4. A Windows install / update / uninstall rehearsal

`docs/PRODUCTION_READINESS.md` §2 item 4: install 1.2.0, update over it, run
uninstall, and run the clean-install tool — on a real
Windows PC. None of it can be done from a Linux container.

---

## Then: the queue

`docs/ai-handoffs/README.md` is the queue. Summarised:

| # | Brief | Why it matters |
|---|---|---|
| 1 | `office-product-image-flow` §2 and §4 | The product screen shows the cover photo, but **nothing opens one full size** (the 2048 px `master` size is requested by nothing), and an offline upload answers a raw Node error. |
| 2 | `party-access-truncation-and-routing` §3–§4 | The owner's "no option for assign party": no route from a party record to who can see it. |
| 3 | `session-loss-and-password-change` tail | Reset password has no self-exclusion; `invalidateSessionsForUser` records no reason. |
| 4 | `recycle-bin-delete-actions-and-purge` part 2 | **Needs the owner to choose, not an implementer.** Nothing ever leaves the Recycle Bin. |

Also owed and not in a brief: a Master-side New lead (port the Office
`AddLeadScreen` into `ui/` behind a transport), and leads that reference a
product created offline in the same session (a line needs a variant id the
panel cannot know yet).

---

## Then: what the 2026-09-24/25 audit left

The audit fixed everything the 2026-09-22 structure audit had left open (see
`HANDOFF.md`, "Session history"). These it found and did not fix. Each was
confirmed by reading the code, not in a running app; `HANDOFF.md` under "Owed
work" has the same list with file names.

**Server and data.**

1. **Dispatch keys on the stage named `Dispatched`**
   (`order.service.ts#dispatchOrder`), so renaming that stage on the Fields
   screen leaves a dispatched order where it was. No column on
   `pipeline_stages` says which stage means dispatched (`is_terminal` is also
   true of Cancelled). Needs a stage flag added by an add-only migration, a way
   to set it, and the owner's input before anyone starts.
2. **`deleteOrder` can race a dispatch.** It checks `dispatchedAt` on a read
   before its transaction and does not lock the row, so an order dispatched in
   between can still be deleted.
3. **`party_code` truncates from the 10,000th party.** `lpad(…, 4, '0')` in
   `party.repository.ts` cuts as well as pads, so the code repeats an earlier
   one and the insert fails while that party is live (`docs/schema/02-parties-and-products.md`).
4. **No index on `leads.owner_id` or `orders.owner_id`**, since
   `20260303000000_roles_and_users` re-created both columns as TEXT
   (`docs/schema/03-leads-orders-inventory.md`). Needs an add-only migration.
5. **The public API's tenant cache is stale after a whole restore**:
   `resetPublicApiTenantCache()` is called by Developer mode's erase only.
6. **The wipe/reload CLIs stop the database they started**
   (`catalog-reload-cli.ts`), which pulls it out from under a running Master.
   The header says to run them with the Master stopped; nothing checks.
7. **23 client→server socket events have no caller** in `office/src`; the
   Master still registers handlers for them (`docs/STRUCTURE.md` lists them).
   Delete them or give them a caller.
8. *Observation, not a defect yet:* a `partyVariant.upsert`'s temporary id
   never reaches `id_map` (`docs/LEAD_GENERATION_FLOW.md` §7).

**Office Panel and desktop shell.**

9. **Work may be stranded after an early storage move.** An Office panel that
   moved its storage before this round came back up in the old folder, so
   anything saved after the move sits in the move target. Worth checking on any
   shop PC that was moved.
10. **After a storage move the shell's log stays in the old folder** until the
    app is relaunched. Every "where is the log" answer names the file actually
    being written (`openLogPath()`), so nothing points at the wrong one.
11. **A transient outbox read at flush time.** A flush that meets a moment's
    read error (`load()` in `office/src/sync/outbox.store.ts`) sees an empty
    queue and sends nothing that pass; a save refuses in the same case.
12. **The Updates screen has no "fetching" reason.** While the Master fetches
    the build for a panel's OS, the panel is told there is nothing new yet
    (`docs/UPDATES.md`, "When a new build shows up").
13. **Clean Install's handling of a `.deb` is unsettled.** It lists `.deb` among
    Linux setup files (`electron/lib/cleaner/setup-file.ts`), while no release
    names a `.deb` in a manifest (and since 1.4.1 none is built).

**Master UI.**

14. **AccessScreen's RoleEditor asks with `window.confirm`** before discarding
    an edit, not the themed ConfirmDialog.
15. **The Master keeps drawing a screen after the person's permission for it is
    revoked.** `ScreenHost` draws the tab whatever the sidebar offers; only
    navigation checks. Sign-out and an ended session do reset to the Dashboard.

**Stale text.** Comments near `master/src/services/inventory.service.ts:168` and
in the Electron preload; the header of `shared/src/sync/ids.ts` and
`compareForIdAssignment`'s comment, which still say numbering is the same
whichever panel syncs first and that `id_map` resolves a temporary ID forever.
The sort is per pushed batch, and a business-data wipe clears `id_map`
(`docs/LEAD_GENERATION_FLOW.md` §7).

Deliberate, not a defect, so nobody "fixes" it: three kinds of audit entry are
still written after the fact by `recordDetachedActivity` — sign-in attempts
(accepted ones included, so a trail that cannot be written never stops somebody
signing in), connector runs, and a panel's reissued secret or moved storage
folder (`docs/ROLES_AND_USERS.md` §7.1).

---

## The Mac and Linux panel builds now work (2026-09-18)

Both defects below were real and are fixed; the section is kept because what
made them invisible is worth remembering. Neither showed up in a test, a lint
or a typecheck — one was a declared field with no consumer, the other a missing
block in a YAML file nobody built from.

1. **`vendorPostgres()` (`tools/release.mjs`) hardcoded `windows-x64`**,
   whatever `--os` said. `TARGETS` declared the right `@embedded-postgres`
   package for each OS and the doc comment beside it said getting this wrong
   "ships a Mac build that cannot start its own database" — and then the
   function ignored the field. It now reads `RELEASE_TARGET.postgres`, vendors
   **both** macOS architectures (one universal .dmg, two architectures of
   server binary), and verifies after copying that `initdb`, `pg_ctl` and
   `postgres` exist, are executable and have a non-empty `share/`.
2. **Neither panel's `electron-builder.yml` had a `linux:` block.** Both now
   build an AppImage (and, until 1.4.0, a `.deb`), with the `executableName` that stops the
   binary shipping as `@orderbookmaster`.

Three things followed from those:

- `candidateBinDirs()` (`master/src/db/postgres-server.ts`) tries
  `vendor/postgres/<process.arch>/bin` before the flat path, which is what
  makes the two-architecture macOS layout findable. `resolveBinDir()` now
  checks `X_OK`, not just existence — a copy that lost its executable bit used
  to report "found" and fail later inside `initdb`.
- `allowScripts` (root `package.json`) approves all five `@embedded-postgres`
  packages. The postinstall is not a download — the tarball ships `native/**` —
  it is `hydrate-symlinks.js`, recreating 14 SONAME symlinks in `native/lib/`.
  Windows has no symlinks to lose, which is why only Windows was ever approved.
- `.github/workflows/release.yml` is a three-runner matrix. electron-builder
  does not cross-compile, so one job per OS, one job that creates the release
  and three that upload to it.

### What was actually run, and what was not

On this Linux container, for real: both panels built to AppImage and `.deb` (the `.deb` is no longer built, 1.4.1);
`initdb`/`pg_ctl`/`postgres` inside the packaged Master execute and report
17.10; the 14 `lib/` symlinks are present; the packaged Master, launched under
`xvfb-run` as a non-root account, **created its own cluster and database** and
answered `/api/health` with `status: ok`; the `.deb` payload lands under
`/opt/OrderBook Master Panel` with `/usr/share/applications/orderbook-master.desktop`,
hicolor icons and a `/usr/bin` alternative, and the uninstall script's Linux
branch finds every one of them.

**Not run: the macOS build.** `assertTarget()` refuses `--os mac` anywhere but
macOS, by design. The universal packaging, the two-architecture vendoring
layout and the `process.arch` runtime branch are reasoned and guarded by
`master/tests/packaging-invariants.test.ts`, not executed. The CI matrix is
what will execute them first. The Windows `.exe` is producible here and still
not runnable here.

---

## Every surveyed setting has now shipped

The 2026-09-17 survey verified twelve candidates and shipped five; the owner
asked for the remaining six on 2026-09-18 and they are in. Two settings have
since gone with the product trim (`pricing.enabled`, `catalog.defaultUom`), so
there are thirteen, in four groups. Nothing from that survey is outstanding.

The one thing to know before adding a fourteenth: a company switch reaches a
panel through `CompanyFeatures`, and every field on it is **optional** because a
shop mid-update runs a Master and a panel on different versions. That means a
switch added to the interface and forgotten in
`master/src/services/company-features.ts` typechecks cleanly, ships, and decides
nothing — no screen broken, no test red.
`master/tests/company-features-complete.test.ts` is the only thing that catches
it. Add the field, and let that test tell you where else to go.

Six candidates were **rejected**, and the reasons are worth keeping so nobody
re-proposes them: `security.signInLockoutAttempts` cannot be read by the Office's
offline lockout store, which runs precisely because the Master cannot be asked;
`catalog.productCodePrefix` would overwrite products on an upsert import,
because the generator has no collision retry; `locale.*` is per-machine in
writing; `panels.pairingWindowMinutes` is a fail-safe backstop rather than a UX
number; and company address / GST belong in `master_config` beside
`company_name`, not in a second table — `settings.ts` records splitting one
concept across two tables as the reason a previous key was deleted.

---

## A long-standing decision waiting on the owner

It is not a code question, and it has been re-litigated more than once.

**Retention.** A soft-deleted row stays in the database forever. So does the
sealed password of a deleted user, and the image files of a deleted product.
For an install that runs for years on one PC that is unbounded growth. The three
options — leave it and document it, a retention sweep, or a manual "delete
forever" behind an admin permission — are written up in the brief, along with
the four questions any of them has to answer (foreign keys, the sync tombstone,
files on disk, and an offline panel reconnecting after a purge it never saw).

Still open from before: extra party fields (credit terms, multiple contacts —
GST is already there); concurrent edits of one lead from two panels
(last-write-wins is the default and nobody has confirmed it); app name and
branding.

---

## What would pay for itself next, beyond the queue

Ranked by what this session actually ran into, not by taste.

1. **Tests for the two web applications, past the shell.** CI now runs the
   integration suites (`ci.yml` installs PostgreSQL 16), so the remaining blind
   spot is `master/web` and `office/web`. The jsdom harness
   (`ui/tests/panel-harness.ts`) now boots each panel whole, and the shell tests
   beside it cover navigation, the splash, change-event refetches and two
   Office forms; most screens are still untested. Every serious defect of the
   last few rounds lived there or in a skipped suite, and the harness makes the
   next screen test cheap.

2. **Finish what `web-reachability.test.ts` started.** Its `ALLOWED_UNCALLED`
   list is still long, each one a screen somebody has not built or code
   somebody should delete. That list is an honest inventory of the gap between
   the API surface and the product, and it is worth reading as a roadmap rather
   than as a mute button.

3. **A second look at `realtime/hub.ts`.** It is the one file where both panels'
   traffic meets, it carries policy it should not (the acting-token enforcement
   that moved out of it on 2026-09-17 was there for months), and it is long
   enough that the next thing hiding in it will hide well.

---

## How to work on this repo

The rules that actually caught mistakes this round, as opposed to the ones that
merely sound right:

- **Verify the claim, then fix the code.** Three briefs this round described a
  world the tree had moved past, and one proposed contrast values that did not
  clear the threshold they were chosen for. The brief is a lead, not a fact.
- **Watch every guard fail.** Two written this round passed against the exact
  defect they targeted and had to be rewritten. Breaking the code and watching
  the test go red is the only way to know the assertion reaches the thing it
  names.
- **Count the skips.** Green is not green if 568 tests sat it out.
- **Say what you did not verify.** Every commit message from 2026-09-17 names
  what was run and what was not. That is the only reason the list in §2 above
  can exist.
