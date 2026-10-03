# 7 — Storage, backup and restore

How OrderBook keeps a company's data safe and moves it to a new PC. Cited by
section number from the code (`§2.2`, `§5.1` and so on), so keep the numbers
stable when editing.

There are two kinds of backup file, and they do different jobs:

| | Version 1 `.obbackup` | Version 2 "Back up everything" zip |
|---|---|---|
| Made by | Master and Office, Settings → Storage | Master only, Settings → Storage & backup |
| Permission | `storage.manage` | `storage.backupAll` (Server Master tier only) |
| Holds | the database rows (Master) or the local replica files (Office) | every table, every product photo and avatar, and pairing |
| Protected by | a passphrase (AES-256-GCM) | nothing: a plain zip. Keep the drive safe (§3.4) |
| Written to | a browser download | a folder on the Master PC, usually a USB drive |
| Restored by | first run (v1 fork) or Settings | first run (Magic restore) or Settings, Master PC only |
| Automatic | no | yes, once a day (§8) |

The version 1 path is unchanged by version 2 apart from its post-load repairs
(pending-order numbers, the Server Master role) and its cache reset, which now
also clears the public-API tenant cache.

---

## 1. Where the data lives

On the Master, `<dataDir>` (chosen at first run, `firstRun.dataDir.*`) holds:

- `postgres/`: the PostgreSQL cluster;
- `uploads/`: product images and their variants, and avatars;
- `secrets/vault.key`: the key that seals secret settings and connector
  credentials. **It never leaves this PC**, in either kind of backup;
- `auto-backup.json`: this PC's automatic-backup settings (§8);
- `backups/pre-restore-*.zip`: the safety copies a Settings restore writes (§5.5);
- `tmp/restore-*`: a restore's staging folder, removed when it ends.

An Office keeps no database. Its replica is a handful of JSON files under its
own data folder.

## 2. Version 1 export (`.obbackup`)

### 2.1 Who and where

Settings → Storage → Export, with `storage.manage`. The file downloads through
the browser.

### 2.2 Scope

- **Master:** `whole` (every company) or `selected` (named companies; the server
  supports it, the screen offers whole only).
- **Office:** `settings-only` (this device's local settings) or `full-replica`
  (everything the device holds).

### 2.3 The passphrase

At least 10 characters, never stored. A lost passphrase means the file cannot
be opened again.

### 2.4 Office replica export

An Office exports its replica to move to new hardware (§6.3). The pairing
secret is not carried; the new device pairs again.

## 3. Back up everything to a drive (version 2)

Settings → Storage & backup → "Back up everything to a drive"
(`master/web/src/components/BackupAllSection.tsx`). Only a Server Master with
`storage.backupAll`, and only on the Master PC itself: the routes refuse any
other machine (`requireLoopback`), because they read and write paths on the
Master's own drives.

### 3.1 What is in the zip, and what never is

`OrderBook-Backup-<company>-<yyyy-mm-dd-hhmm>.zip`, named in the business time
zone:

- `manifest.json`: format version, app version, created at, company, master
  unique id, the applied migration names, and for every file its size and
  sha256 (§4.1);
- `data/<table>.ndjson`: one JSON row per line, every table except the excluded ones;
- `uploads/**`: product images and avatars, byte for byte (stored, not
  compressed, since they already are);
- `README.txt`: what the file is and how to restore it, for whoever finds the drive.

Never included: `user_password_vault`, `master_clock`, `user_notifications`,
`knex_*`, and `secrets/vault.key`. The repository functions that stream and
load tables refuse those tables outright.

### 3.2 How it is written

1. **Pre-flight**, before anything is written: the folder must exist; the
   estimate (row counts × average row size, plus photo sizes) × 1.1 must fit in
   the free space; and a FAT32 drive is refused when the estimate is over
   4 GiB − 64 MiB (§3.3).
2. One `REPEATABLE READ READ ONLY` transaction, so the rows are one consistent
   moment while people keep working. Each table streams in keyset pages of
   2,000 rows, so memory stays small however big the company is. The photos
   are listed inside the snapshot but copied after it ends, so a slow drive
   never holds a lock on the tables.
3. Everything is written to `<name>.zip.partial`, then the zip is opened again
   and every entry's hash checked, and only then renamed to `.zip`. A failure
   removes the `.partial`.
4. `backup.created` (or `backup.failed`) goes into the activity log.

Only one backup or restore runs at a time (`backup-job.ts`); a second is
refused with "busy". The screen shows progress through Getting ready, Copying
records, Copying photos and Checking the backup.

### 3.3 Which drive format

- **NTFS** or **exFAT**: any size. Use one of these for a company with many photos.
- **FAT32**: no single file over 4 GiB. The backup is refused up front with
  "format as exFAT or NTFS" rather than failing halfway. There are no split archives.

The format is read with PowerShell `Get-Volume` (`storage.service.ts`
`volumeFileSystem`). Formatting a drive erases it; copy anything on it first.

### 3.4 Keep the drive safe

The zip is **not encrypted**. It holds the company's parties, orders and users,
including **password hashes**, the pairing password hash, each Office panel's
secret and **master proof key**. Anyone holding the drive holds all of that.
Keep it locked away like the office keys, and do not leave it plugged into a
shared PC. The screen says so beside the button.

## 4. File formats

### 4.1 Archive version 2

A zip (zip64 when large). The restore accepts only these entry names:
`manifest.json`, `README.txt`, `data/<table>.ndjson` and `uploads/**`. It
rejects absolute paths, drive letters, backslashes, `.` or `..` segments,
control and Windows-invalid characters, device names, duplicates (compared
case-folded) and directory entries. Caps: manifest 32 MiB, README 64 KiB, one
photo 256 MiB. Every entry's size must equal what the manifest says, and every
listed file must be there. The rules are in `master/src/domain/archive.ts`;
the zip reading in `master/src/lib/archive-zip.ts`.

A manifest with a higher `formatVersion`, or naming a migration this build
does not know, is refused as made by a newer version.

### 4.2 Version 1 envelope

An unencrypted manifest header, so a wrong file is caught before the
passphrase is asked for, followed by the payload encrypted with AES-256-GCM
under a scrypt key derived from the passphrase (`lib/backup-crypto.ts`).

### 4.3 Version 1 checks

`formatVersion` 1; the payload's sha256 must match the header; the passphrase
must be at least 10 characters. A wrong passphrase and a damaged file are
reported differently (§7).

## 5. Restoring

### 5.1 The Master's first run

A new Master offers three forks, all on the Master PC only:

1. **Set up new site**: the owner types the two Server Master accounts.
2. **Magic restore from a backup drive**: a version 2 zip (§5.4).
3. **Restore an encrypted backup (.obbackup)**: version 1, with its passphrase.

The setup routes are refused once setup has run.

### 5.2 Office restore (version 1)

An Office restores its own `.obbackup` from Settings → Storage. It then pairs
with the Master again.

### 5.3 Check everything before changing anything

Version 1 runs the whole load in one PostgreSQL transaction and verifies the
activity hash chain before it commits; any failure rolls back to exactly what
was there.

Version 2 (`archive-restore.service.ts`) works in this order:

1. Checks the manifest and the entry list (§4.1), hashes every data file, and
   unpacks and hashes every photo into `<dataDir>/tmp/restore-<id>`.
2. Settings restore only: writes a data-only safety copy to
   `<dataDir>/backups/pre-restore-<time>.zip` (the newest two are kept).
3. Maintenance: everyone is signed out, sockets close, queued pushes are
   refused, and every API call answers 503 "maintenance" until the end.
4. Drops the schema and migrates up to the backup's own level.
5. Loads the rows in one transaction, checks row counts, resyncs sequences and
   verifies the activity chain.
6. Runs the remaining migrations, so a backup from an older version is
   upgraded exactly as an in-place update would have.
7. Moves the photos into place, refreshes this PC's LAN address, makes sure the
   Server Master role exists, and resets every in-process cache.
8. Records `backup.restored`.

If the load fails, a first-run restore goes back to a blank first run, and a
Settings restore replays its safety copy. `backup.restore_failed` is recorded.

Once the load has committed, the restore has happened, so step 7 cannot fail
it: each part is logged when it fails and the job still ends done. If the
photos cannot be moved into place, the unpacked copy is kept beside the uploads
folder as `uploads-restored-<time>` and the log names it.

### 5.4 Magic restore on a new PC

1. Install OrderBook on the new Master PC and start it.
2. Plug in the backup drive.
3. On the first-run screen choose **Magic restore from a backup drive**.
4. Choose the zip (the file chooser), or type its full path, and press
   **Read the backup**. The preview shows the company, when it was made, the
   version that made it, the counts of parties, products, users, pending and
   final orders, the photos and the size.
5. Press **Restore everything** and wait. The progress bar steps through
   Checking, Copying photos, Restoring records, Bringing the records up to this
   version and Finishing.
6. Press **Continue**. Sign in with the usual usernames and passwords.
7. The Office panels need nothing: pairing came back with the data, so they
   find the new PC on the LAN and reconnect by themselves.
8. Enter again the secrets listed (§5.6).

A backup made by a newer version than the one installed is refused; update
OrderBook first.

### 5.5 Restore from Settings

Settings → Storage & backup lists the backups in the chosen folder. **Restore…**
shows the same preview, then needs CONFIRM typed and the master key. It
replaces every record on this Master, writes the safety copy first, and signs
everyone out, including the person who started it, who then signs in again.

### 5.6 Secrets to enter again

Secret settings and connector credentials are sealed with
`secrets/vault.key`, which stays on the PC that made the backup. On another PC
they cannot be opened, so the preview and the finished screen list how many
must be entered again (`countSealedRows`). Passwords are not affected: the
hashes travel, so people sign in as before.

## 6. Moving to a new PC

### 6.1 The Master

Back up everything to a drive (§3) on the old PC, then Magic restore (§5.4) on
the new one. Pairing is kept, so no Office pairs again.

### 6.2 Before 1.3

A version 1 `.obbackup` still restores through the v1 fork (§5.1). It brings a
new pairing password, and every Office pairs again with it.

### 6.3 An Office panel

Export its full replica (§2.4) on the old PC, restore it on the new one (§5.2),
and pair it with the Master.

## 7. Failures and what they say

`BackupError` (`master/src/lib/errors.ts`) carries one of these reasons, each a
400 with its own message:

| Reason | Meaning |
|---|---|
| `wrong_passphrase` | v1: the passphrase does not open the file |
| `corrupt_file` | a hash or size does not match, or a listed file is missing |
| `populated_data_directory` | v1: this Master already has data; CONFIRM to wipe it |
| `migration_too_new` | v1: the file comes from a newer version |
| `hash_chain_invalid` | the activity log's hash chain does not verify |
| `notAnArchive` | v2: not an OrderBook backup zip |
| `entryRejected` | v2: an entry name or size breaks the rules (§4.1) |
| `newerThanApp` | v2: made by a newer version |
| `insufficientSpace` | not enough free space for the backup or the photos |
| `fat32TooLarge` | a FAT32 drive cannot hold this backup (§3.3) |

## 8. Automatic backup

Settings → Storage & backup → Automatic backup
(`master/web/src/components/AutoBackupSection.tsx`,
`master/src/services/backup-scheduler.ts`).

- Off by default; the time is 21:00 and seven backups are kept.
- The settings belong to this Master PC, in `<dataDir>/auto-backup.json`,
  because the folder names one of its drives. They can be read from any PC with
  `storage.backupAll` but changed only on the Master PC.
- Once a day, at or after the chosen time, the scheduler makes the same backup
  as §3 into the folder.
- **Drive not plugged in:** the backup is skipped, retried every minute that
  day, and everyone with `storage.backupAll` gets one bell notice a day.
- **Failure:** one bell notice, and the reason shown in "last run".
- **Pruning:** after a successful run, only this company's
  `OrderBook-Backup-<company>-<date>.zip` files beyond the newest N are
  deleted. Other files and other companies' backups are never touched.
- Changing the schedule records `backup.schedule_updated`.
