# Next phase

Written 2026-09-17, at the end of a session whose context was about to be
deleted. Everything worth keeping from it is in the repo; this file is the part
that is about *what happens next* rather than what is true now.

Read `HANDOFF.md` for current state and `docs/CODE_MAP.md` for the layout. This
file assumes both.

---

## Do these first, in this order

### 1. Merge the branch

`claude/hopeful-lovelace-q6f57v` is pushed and ahead of `main`, and **nothing
has merged it**. The standing convention is that work lands on `main`;
the branch exists only because the session was required to use one. Until it
merges, `main` still has the lost-lead bug, no Master Parties screen, and four
open privilege holes.

### 2. The integration suites now run — here is how

They had never run, on any machine, for the whole of 2026-09-17: PostgreSQL
refuses to start as root and the container had no other account. On 2026-09-18 a
non-root account (`obtest`) was created and they ran for the first time.

```
sudo -u obtest bash -lc '
  mkdir -p ~/run
  cp /home/user/OrderBook/vitest.config.ts ~/run/
  ln -sfn /home/user/OrderBook/node_modules ~/run/node_modules
  cd /home/user/OrderBook
  npx vitest run --config ~/run/vitest.config.ts --root /home/user/OrderBook
'
```

The config has to be copied somewhere the account can write: vitest bundles it
to a sibling `.timestamp-*.mjs` and dies with `EACCES` otherwise. `--root` keeps
every relative path in that config pointing at the repository.

**Check the skip count, not just the pass count.** A skipped suite prints like a
passing one, and this project has been bitten by exactly that — twice now. The
second time shipped a `.update(db().raw(...))` that throws before any SQL is
built: unexecuted turned out to mean unparsed by anything that would object.

Running them found one real defect in the round they were written for, and it
was in a test rather than in the code. That is still the point: a test nobody
has executed is a claim, not a check.

### 3. Do a browser and Electron pass

Nothing from 2026-09-17 was seen running. `master/web` and `office/web` have no
tests by design, so a real pass is the only verification these changes have
had. The visual and interaction changes specifically:

- The **sync popover** on both panels, and the Lead board's kebab menu — they
  had no CSS at all, so this is the first time either has rendered as a surface.
  Check the Close button inside the popover is actually clickable: the shim
  layering was the other half of that bug.
- The **sticky table header** on a long list — it never stuck before.
- **Column sorting** on the Master's Parties screen.
- The Master's new **Parties** screen end to end, and the Office's Catalog
  afterwards — the party form is now one shared component, so a regression there
  shows up on the panel that already had it.
- **Change password** in the Master topbar: the dialog warns it signs you out,
  and the window should land on sign-in *with a message*, not on a generic error.
- Both themes, and the scale slider at its minimum (the type and chip clamps).
- **The language picker** (Settings → Appearance). Switch to हिन्दी and look at
  the panel: this is the first time anybody has been able to, and it is how the
  1,737-string backlog below becomes visible rather than theoretical. Switching
  back must work from a panel you can no longer read — the two buttons are named
  in their own scripts for exactly that reason.
- **The Settings tab itself**, on both panels: the four groups, a number setting
  saved with its button (not on keystroke), the per-row save feedback, and the
  tab strip at 157% on a 1366px screen, which is where the later tabs used to be
  unreachable.

### 4. Rebuild the 1.1.0 installers

Still owed from 2026-09-13. `npm run release` hangs on the owner's PC; the build
inputs are refreshed and a healthy machine should work.

---

## Then: the five remaining briefs

`docs/ai-handoffs/README.md` is the queue and it is current. Summarised:

| # | Brief | Why it matters |
|---|---|---|
| 1 | `office-product-image-flow` §2–§4 | **There is no way to look at a product photo.** For a ceramics catalogue that is the primary use of one. The `large` and `master` variants encoded on every upload are requested by nothing. |
| 2 | `office-product-form-gates-and-slimming` §6–§7 + reorg | The owner's own complaint — 29 fields in the New Product modal. Gates are done; the layout is not. |
| 3 | `party-access-truncation-and-routing` §3–§4 | The owner's "no option for assign party": no route from a party record to who can see it. |
| 4 | `session-loss-and-password-change` tail | Reset password has no self-exclusion; an admin resetting their own password signs themselves out with no warning. |
| 5 | `recycle-bin-delete-actions-and-purge` part 2 | **Needs the owner to choose, not an implementer.** Nothing ever leaves the Recycle Bin. |

---

## The Mac and Linux panel builds do not work

Found on 2026-09-18 while building the clean-install tool for three platforms.
Both are small, and neither is a guess — they are in the code:

1. **`vendorPostgres()` (`tools/release.mjs`) hardcodes `windows-x64`**, whatever
   `--os` says. `TARGETS` declares the right `@embedded-postgres` package for
   each OS and the doc comment beside it says getting this wrong "ships a Mac
   build that cannot start its own database" — and then the function ignores
   the field. A `--os mac` or `--os linux` **Master** would vendor Windows
   binaries.
2. **Neither panel's `electron-builder.yml` has a `linux:` block.**
   `TARGETS.linux` exists and expects an `AppImage`, so `--os linux` gets as
   far as electron-builder and then fails the exact-filename check, because
   nothing told it what to name the artifact. `cleaner/electron-builder.yml`
   now has a working `linux:` block to copy from, including the
   `executableName` that stops the binary shipping as `@orderbookcleaner`.

Until both are fixed, the clean-install tool's Mac and Linux builds clean an
installation that cannot exist on those platforms. The tool was still built for
all three, deliberately and with the owner's decision, because the alternative
was to ship it only where the gap happens not to bite.

Also unverified from this machine, and unfixable here: `release.mjs` refuses a
cross-compile (`assertTarget`), so a `.dmg` needs a Mac and the Windows `.exe`
can be produced on Linux but not *run* there.

---

## Every surveyed setting has now shipped

The 2026-09-17 survey verified twelve candidates and shipped five; the owner
asked for the remaining six on 2026-09-18 and they are in. Fifteen company
settings, four groups. Nothing from that survey is outstanding.

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

## The two decisions waiting on the owner

Neither is a code question, and both have been re-litigated more than once.

**Retention.** A soft-deleted row stays in the database forever. So does the
sealed password of a deleted user, and the image files of a deleted product.
For an install that runs for years on one PC that is unbounded growth. The three
options — leave it and document it, a retention sweep, or a manual "delete
forever" behind an admin permission — are written up in the brief, along with
the four questions any of them has to answer (foreign keys, the sync tombstone,
files on disk, and an offline panel reconnecting after a purge it never saw).

**Hindi.** `hi.ts` is 1,737 strings behind — `grep -c 'TODO(i18n-hi)'` is the
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

1. **CI that runs the integration suites.** Every serious defect closed in the
   last two rounds lived in a place the gate could not see — two web
   applications with no tests, and integration suites that skip on the one
   machine anybody runs them on. Both obstacles are gone as of 2026-09-17: the
   Windows-only test fixtures are fixed, and `npm run build` runs on Linux for
   the first time (it was `cmd` inside an npm script and died with a syntax
   error anywhere else). A runner needs only a non-root user and a PostgreSQL.

2. **A guard against untranslated Hindi.** The parity test proves a key exists;
   it cannot tell a translation from a copy of the English. A test asserting
   that `TODO(i18n-hi)` does not *grow* would at least stop the backlog getting
   worse, which is cheap and would have prevented it reaching 1,737.

3. **Finish what `web-reachability.test.ts` started.** Its `ALLOWED_UNCALLED`
   list is 40-odd entries long, each one a screen somebody has not built or code
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
