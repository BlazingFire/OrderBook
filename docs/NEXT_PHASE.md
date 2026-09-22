# Next phase

Rewritten 2026-09-22 after the branch consolidation, when every open branch was
merged into `main` and the sessions that produced them were retired. This file
is about *what happens next*; `HANDOFF.md` is what is true now and
`docs/CODE_MAP.md` is the layout. This file assumes both.

---

## Do these first, in this order

### 1. The owner's four decisions

Nothing below blocks on code as much as on these. They are written up in
`docs/PRODUCTION_READINESS.md` §5 and summarised under "Owed work" in
`HANDOFF.md`: what happens to a 1.0.3 machine's data, the release signing key,
a code-signing certificate, and the Recycle Bin's retention policy.

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
beside the repository. On 2026-09-22 this ran 140 files / 1699 tests, none
skipped.

**Check the skip count, not just the pass count.** A test nobody has executed
is a claim, not a check.

### 3. Do a browser and Electron pass

Nothing merged on 2026-09-22 was seen running. `master/web` and `office/web`
have no tests by design, so a real pass is the only verification these changes
have had. Specifically:

- **Settings** on both panels: the four groups, a number setting saved with its
  button (not per keystroke), per-row save feedback, the tab strip at 157% on a
  1366px screen, and each switch actually changing its screen — follow-up
  default on the Office's New lead, packaging no longer required to add a line
  or convert with `leads.packagingRequiredOnConvert` off, the adjustment note
  on the Master's physical count.
- The Master's **Parties** screen end to end, and the Office's Catalog and New
  lead afterwards — the party form is now one shared `PartyFormModal`.
- **Delete** on the Master's leads and orders lists, including the blocked
  case (the reason is named, not "could not delete").
- The **filter strip** on every list screen (it pads and grows now).
- **Change password** in the Master topbar lands on sign-in *with a message*.
- The **language picker** (Settings → Appearance) — switching back must work
  from a panel you can no longer read.

### 4. A Windows install / update / uninstall rehearsal

`docs/PRODUCTION_READINESS.md` §2 item 4: install 1.2.0, update over it, run
the standalone `.exe`, uninstall, and run the clean-install tool — on a real
Windows PC. None of it can be done from a Linux container.

---

## Then: the queue

`docs/ai-handoffs/README.md` is the queue. Summarised:

| # | Brief | Why it matters |
|---|---|---|
| 1 | `office-product-image-flow` §2–§4 | **There is no way to look at a product photo.** The `large` and `master` sizes encoded on every upload are requested by nothing. |
| 2 | `party-access-truncation-and-routing` §3–§4 | The owner's "no option for assign party": no route from a party record to who can see it. |
| 3 | `session-loss-and-password-change` tail | Reset password has no self-exclusion; `invalidateSessionsForUser` records no reason. |
| 4 | `recycle-bin-delete-actions-and-purge` part 2 | **Needs the owner to choose, not an implementer.** Nothing ever leaves the Recycle Bin. |

Also owed and not in a brief: a Master-side New lead (port the Office
`AddLeadScreen` into `ui/` behind a transport), and leads that reference a
product created offline in the same session (a line needs a variant id the
panel cannot know yet).

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
   build an AppImage **and** a `.deb`, with the `executableName` that stops the
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

On this Linux container, for real: both panels built to AppImage and `.deb`;
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

The one thing to know before adding a sixteenth: a company switch reaches a
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

## Two long-standing decisions waiting on the owner

Neither is a code question, and both have been re-litigated more than once.

**Retention.** A soft-deleted row stays in the database forever. So does the
sealed password of a deleted user, and the image files of a deleted product.
For an install that runs for years on one PC that is unbounded growth. The three
options — leave it and document it, a retention sweep, or a manual "delete
forever" behind an admin permission — are written up in the brief, along with
the four questions any of them has to answer (foreign keys, the sync tombstone,
files on disk, and an offline panel reconnecting after a purge it never saw).

**Hindi.** `hi.ts` is 1,445 strings behind (2026-09-22) — `grep -c 'TODO(i18n-hi)'` is the
live number. A Hindi panel is mostly in English today and no test can see it,
because the parity check only asserts a key exists. Either that backlog gets
worked through, or the Hindi option should be honest about being partial. It is
currently neither — and as of 2026-09-17 it is also *reachable*, which raises
the stakes: before the picker existed no user could see the backlog, and now
anybody who tries the language can. Ship the translations, or say on the picker
that Hindi is partial. Leaving it silent is now a choice with a reader.

Still open from before: extra party fields (credit terms, multiple contacts —
GST is already there); concurrent edits of one lead from two panels
(last-write-wins is the default and nobody has confirmed it); app name and
branding.

---

## What would pay for itself next, beyond the queue

Ranked by what this session actually ran into, not by taste.

1. **Tests for the two web applications.** CI now runs the integration suites
   (`ci.yml` installs PostgreSQL 16), so the remaining blind spot is
   `master/web` and `office/web`, which have no tests at all. Every serious
   defect of the last few rounds lived there or in a skipped suite.

2. **A guard against untranslated Hindi.** The parity test proves a key exists;
   it cannot tell a translation from a copy of the English. A test asserting
   that `TODO(i18n-hi)` does not *grow* would at least stop the backlog getting
   worse, which is cheap and would have prevented it reaching four figures.

3. **Finish what `web-reachability.test.ts` started.** Its `ALLOWED_UNCALLED`
   list is still long, each one a screen somebody has not built or code
   somebody should delete. That list is an honest inventory of the gap between
   the API surface and the product, and it is worth reading as a roadmap rather
   than as a mute button.

4. **A second look at `realtime/hub.ts`.** It is the one file where both panels'
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
