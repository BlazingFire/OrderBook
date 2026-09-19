# Developer mode

Three things this software can do are too destructive to leave behind an
ordinary permission, and are needed most often by somebody who cannot sign in as
anybody: **erasing an installation back to first run**, **seeding throwaway test
accounts**, and **filling a Master with sample data** to look at. All three live
behind a *developer password* on the Settings screen's **Developer** tab (the
Master has all three; the Office has the reset).

It is a password and not a permission on purpose. The person who needs it is
usually not a user of the company at all — support on the phone, or the owner
testing a fresh install before there is any data to sign in against. A
permission would have to be granted by an administrator who may be exactly the
account that is locked out.

## The password

```
Dev@OrderBook2026
```

Only its scrypt hash ships, in `shared/src/domain/developer.ts`
(`DEVELOPER_PASSWORD_HASH`). The plaintext above exists in this file and nowhere
in the source.

A deployment that wants its own password sets one in `.env` beside the panel:

```
ORDERBOOK_DEVELOPER_PASSWORD=something-only-you-know
```

When that is set it **replaces** the built-in one — the built-in stops working.
The Developer tab says `passwordOverridden` so an operator can tell which is in
force without being shown either.

### What unlocking gets you

A token, held in the server's memory and in the page's React state — never on
disk, never in `localStorage`. It expires **15 minutes** after it is issued
(`DEVELOPER_TOKEN_TTL_MS`) and the tab shows the countdown. Reloading the page
locks it again; switching to another screen and back does not.

Five wrong passwords in a row lock the unlock route for **60 seconds**
(`DEVELOPER_UNLOCK_MAX_FAILURES`, `DEVELOPER_UNLOCK_LOCKOUT_MS`). The counter is
per server process, not per address: on a shop LAN everybody shares a handful of
addresses, and a guesser who could reset the count by changing address would have
no limit at all.

## Test users

`admin`, `management` and `office` — one per role tier, with fixed passwords
that are meant to be read off this page and typed:

| Username     | Password      | Tier         | Display name        |
| ------------ | ------------- | ------------ | ------------------- |
| `admin`      | `Admin@1234`  | `admin`      | Admin (test)        |
| `management` | `Manage@1234` | `management` | Management (test)   |
| `office`     | `Office@1234` | `office`     | Office (test)       |

They are declared once, in `shared/src/domain/developer.ts` (`DUMMY_USERS`), and
both ways of seeding them read that list.

### Seeding them

**From the app** — Settings → Developer → unlock → *Seed test users*. The result
table shows each account and whether it was `created` or `reset`.

**From a checkout**, with no browser and nobody to sign in as:

```bash
npm run seed:dummy
```

The CLI (`master/src/db/seed-dummy-users-cli.ts`) starts the database the way the
Master does, migrates, seeds, prints the credentials and shuts down. It obeys the
same `.env` the Master does — including `DATABASE_URL`, so on a development
machine it seeds whichever database that names, not a fresh one.

### Two things it does that you should know before running it

- **On a Master nobody has set up yet it runs first-time setup itself**, under the
  company name *OrderBook Test Company* — a user row needs a tenant and a
  `master_config` to mean anything. The pairing password that setup generates is
  shown **once**, in the result; it is not recoverable afterwards, exactly as on
  the first-run screen.
- **An existing `admin` is re-armed, not skipped.** Every set-up Master already
  has an `admin` — first-time setup creates it — so seeding **overwrites that
  account's password with `Admin@1234`**, sets its display name to *Admin (test)*,
  reactivates it, and ends its sessions. Whoever was signed in as `admin` is
  signed out and their old password no longer works. On a real installation that
  is a deliberate act; the tool says so before you run it.

Everything else in the database is untouched — other users, parties, products,
leads and orders stay exactly as they were.

## Sample data

A fresh Master with three sign-ins and nothing to look at teaches nobody
anything. *Sample data* fills it with six months of a small ceramic-tile trade so
every screen on both panels has something to show: sixteen parties across
Gujarat, Maharashtra, Rajasthan and Madhya Pradesh; twenty-three products in six
categories, each with a generated photo; opening stock and later arrivals,
physical counts, reorder bands and a per-colour stock code on every row; thirty-three
leads at every pipeline stage with remarks along the way; the won ones converted
to orders — in progress, postponed, cancelled, and fourteen dispatched across
the months so the reports have a curve; party-wise rates, party-access
assignments, custom fields on all four entities, values in every option list,
and one party, one product and one lead in the Recycle Bin.

**From the app** — Settings → Developer → unlock → *Seed sample data*. The result
lists what was made, and the three sign-ins beside it.

**From a checkout:**

```bash
npm run seed:sample
```

The CLI (`master/src/db/seed-sample-data-cli.ts`) behaves like `seed:dummy`:
same `.env`, same database, prints the credentials and the counts, shuts down.

### How it is made, and why that matters

Every record is written **through the same services the panels call**, as one of
the three test users — the administrator sets up the catalogue and the lists,
the management user handles stock and the builders' accounts, the office user
raises leads on the dealers assigned to it. Nothing is inserted by hand. That is
why the activity log, the timelines, the stock ledger, the reservations and the
party-access rules come out exactly as real use would leave them: they came from
the real code path.

The one thing the services cannot do is write history — every row they insert
is stamped *now* — so the seed runs its events in date order and, after each
one, moves the timestamps that event created back to the day it was meant to
happen on. The dataset (`master/src/domain/sample-data.ts`) is written in day
offsets from the start of a 170-day window ending today; the times of day are
jittered from a fixed seed, so two machines produce the same history. The
activity log is append-only by trigger, so that one table's guard is taken
down and put back inside the same transaction as each backdate — the way
`20260310000000_activity_log_actor_name.ts` backfilled a column — and the hash
chain, which covers a row's content and sequence rather than its time, still
verifies afterwards (the integration test checks that it does; *Verify chain*
on the Activity log screen shows it).

### Three things it does that you should know before running it

- **It seeds the test users first**, exactly as *Seed test users* does — so the
  same warning applies: an existing `admin` has its password overwritten with
  `Admin@1234` and its sessions ended, and on a Master nobody has set up it
  runs first-time setup itself under *OrderBook Test Company*.
- **It runs once per installation.** The first product code in the dataset is
  the marker; if it exists, the tool refuses before touching anything — the
  users included — and says so. To start over, *Erase everything* first.
- **It adds to whatever is there.** On a development database that already has
  real records the sample ones land beside them; the refusal above is the only
  guard, and it only knows about its own products.

## Reset

### Master — *Reset all data*

Takes the installation back to the moment before first-run setup. You type
`RESET` to confirm.

**Erased:** every table (the schema is dropped and the migrations re-run, which
is the same code path a fresh install takes, so what comes back is by
construction what a fresh install has) — parties, products, leads, orders, users,
roles, settings, panel pairings, the activity log; the uploads folder (and a
`documents` folder left over from before the PDF Designer was removed, if one
is still there); `secrets/vault.key`; every session and every connected panel
socket.

**Kept:** the PostgreSQL cluster itself and its password file (the server is
still running out of it), the `logs` folder (it is where somebody reads what
happened), the data-directory location, and `.env`.

Afterwards the Master answers as an unconfigured install and the browser reloads
onto the first-run screen. Every Office panel must be paired again — their
pairing rows are gone.

### Office — *Reset this panel*

Puts the PC back to the moment before it was paired: the pairing credentials,
the cached users, the offline queue, the snapshot, the sign-in attempt counters
and the cached images all go, and the panel reloads onto the connection screen.
The data-folder **location** is deliberately kept — a reset erases what is in the
folder, it does not forget which folder the operator chose.

An Office reset touches nothing on the Master. Nothing an office panel holds is
the only copy of anything, except mutations still queued in its outbox — flush
them first if the link has been down.

## Uninstalling

Three ways in, all ending at the same two scripts under `tools/uninstall/`.

**From the app** — Settings → Developer → *Uninstall OrderBook*, or Help →
*Uninstall OrderBook…*, which just takes you to that tab. A checkbox decides
whether the data goes with the program; the shell then asks once more in a native
dialog, stops the server (so the PostgreSQL cluster closes properly and nothing
still holds `postgres.exe` open), hands the script to the OS and quits.

**From Windows** — Settings → Apps, or the Start-menu entry. The NSIS uninstaller
now asks whether to delete all OrderBook data on this PC, defaulting to **No**,
and then runs the same script to clear what an uninstaller cannot reach itself.

**By hand**, which is also what the two above end up running:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall\uninstall-orderbook.ps1 -Panel all -DryRun
```

| Flag              | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `-Panel`          | `master`, `office` or `all` (default)                                        |
| `-KeepData`       | Leave the database, uploads and settings on disk; remove only the program    |
| `-Yes`            | Ask nothing                                                                  |
| `-LeftoversOnly`  | Do not run the installed uninstaller — used by the NSIS hook, which is already removing the program |
| `-DryRun`         | Print every action and change nothing. **Always start here.**                |

macOS takes the same shape with long flags:

```bash
bash tools/uninstall/uninstall-orderbook.sh --panel all --dry-run
```

`--keep-data`, `--yes` and `--dry-run` mirror the Windows switches.

### What the scripts remove

The program folders, the Electron profile and its caches, the updater staging
folders, shortcuts on every user's desktop and Start menu, the `OrderBook`
uninstall/Run/AppCompat registry entries, and the two firewall rules the Master's
installer added. Without `-KeepData` they also remove the panel's data directory —
including a relocated one, read from the `<panel>-location.json` pointer — the
pointer itself, the settings file, and (after a separate question) the
`OrderBook-Releases` drop box.

Two deliberate limits, both worth knowing:

- **Processes are stopped by path, never by image name.** Plenty of these machines
  run an unrelated PostgreSQL of their own, and `taskkill /IM postgres.exe` would
  take a company's database down to tidy up after us.
- **Other users' registry hives are not touched.** Loading each `NTUSER.DAT` to
  clean another account's `Run` key is more risk than the leftover is worth; their
  data folders and shortcuts *are* removed, since those are reachable as files.

## Security, stated honestly

The developer password is a **shared secret for the whole product**, not a
per-installation one. Anybody who can sign in to a panel and knows it can erase
that Master's entire database from any PC on the shop LAN. The lockout slows
guessing; it does not stop somebody who has read this file.

That is an acceptable trade only because of what it is weighed against: an
installation whose administrator password is lost, on a machine with no internet
and nobody on site who can help. If a deployment holds real money data and has
staff who should not have this power, set `ORDERBOOK_DEVELOPER_PASSWORD` in the
Master's `.env` and do not write it down where those staff can read it.

Two things the gate deliberately does **not** do:

- It does not appear on the sign-in screen. Every developer route requires a
  signed-in session *as well as* the token, so a forgotten administrator password
  still needs either another user who can sign in, or `npm run seed:dummy` at the
  machine itself.
- It grants no permissions. Unlocking developer mode does not let the caller read
  or write anything an ordinary route would refuse them — it only opens the
  tools on this page.
