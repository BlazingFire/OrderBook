# Design: Backup all to external drive, Magic restore at first-time Master setup, and scheduled auto-backup (Master only)

> Written before the code (2026-10-01). Where it disagrees with docs/plans/1.3-BATCH-DETAIL.md, the integrated plan wins.

## Overview

On the Master PC, a Server Master opens Settings > Storage & backup (the tab is renamed from 'Storage'). There they pick a folder with the native folder chooser, which reaches USB drives, or type a path, and press 'Back up everything'. A progress bar steps through Preparing, Data, Photos, Verifying and Done. The result is one plain ZIP written straight to that folder, named OrderBook-Backup-<company>-<yyyy-mm-dd-hhmm>.zip. The zip holds: manifest.json (format 2, app version, created at, company, master unique id, backupId, the applied knex migration names, per-table row counts, and a sha256 plus byte count for every file); data/<table>.ndjson for every table listUserTables() returns (so user_password_vault, master_clock and knex_* stay out by construction); uploads/** (product image variants and avatars, stored uncompressed because webp is already compressed); and README.txt. secrets/ and vault.key are never read. The export runs inside one REPEATABLE READ READ ONLY transaction, so the snapshot is consistent while people keep working. Each table streams in keyset pages of 2000 rows as Postgres-rendered row_to_json text, which gives exact timestamps and numerics and no Node re-serialization. It writes through archiver to a '.partial' file with sequential entries, and memory stays bounded by one page plus zip buffers. A free-space check runs first. After writing, the zip is re-opened with yauzl, every hash is re-checked, and only then is the file renamed to .zip. Under the button, the screen lists the backups already in that folder; each can be previewed and restored. Restoring from Settings needs Server Master, the master key and typing CONFIRM. A pre-restore safety archive (data only) is written to <dataDir>/backups first. The first-run screen gets a third option, 'Magic restore from a backup drive': choose the zip with a native file dialog (new chooseFile IPC) or type its path, see a preview (company, backup date, app version, counts of parties, products, users and pending orders, photo count), press Restore, and watch progress through Checking, Photos, Database, Upgrading and Finishing. The restore checks every hash and extracts photos to a staging folder before touching the database. Then it closes the API with a 503 maintenance gate, ends sessions and sockets, and rebuilds the schema at the backup's own migration level (DROP SCHEMA, then migrate.up until every migration named in the manifest is applied). Next it streams rows back with json_populate_recordset in one replica-mode transaction, resyncs sequences, verifies the audit hash chain and commits. Finally it runs migrate.latest, so data backfills from newer versions replay over the old data exactly as an in-place upgrade would have. After the commit it swaps the staged uploads in, refreshes the stored LAN IP, resets every process cache and the change ring (with a new BOOT_ID), writes a 'backup.restored' audit row, and opens sign-in. Pairing is kept: master_unique_id, the pairing password hash and the office_panels secrets all come back, so Office panels reconnect to the new PC by themselves once connectivity's rediscovery finds the new IP. A backup that names a migration this build does not know is refused as 'too new'. Old encrypted .obbackup (v1) files stay restorable through the unchanged v1 path. Automatic backup is a per-PC config ({enabled, folder, hour, keepLast, lastRun}) stored in <dataDir>/auto-backup.json and edited on the same screen. A 60-second scheduler like connector-scheduler runs the same exporter once a day after the chosen hour and prunes older OrderBook-Backup-<same company>-*.zip files beyond keepLast. If the folder or drive is missing, it skips, retries every tick that day, and raises one bell notification per day. Every success and failure is written to the activity log and shown as a 'last backup' status line, which turns to a warning after 7 days.

## decisions

- Zip libraries: archiver 5.3.2 (write; zip-stream picks zip64 automatically above 65,535 entries or 4 GB) and yauzl 2.10.0 (read; random access from the central directory, lazyEntries). Both are already in node_modules (archiver ships in the production tree via exceljs; yauzl is dev-only today). Both are declared explicitly in master/package.json, with @types/archiver and @types/yauzl as devDependencies. tools/release.mjs needs no change because stage() ships `npm ls --omit=dev --all` of the workspace. No new runtime code is downloaded.
- Rows are dumped as `row_to_json(t)::text` by Postgres and loaded with `INSERT INTO t (cols) SELECT cols FROM json_populate_recordset(NULL::t, $1::json)`. This keeps µs timestamps, numerics, jsonb and text[] exact, avoids the JSONB-array-literal problem that v1 handles with stringifyJsonColumns, and avoids per-row JS object churn on 4 GB PCs.
- Older backups replay migrations instead of loading into the latest schema by column intersection: drop the schema, migrate.up until the manifest's migration names are all applied, load, then migrate.latest. This is the only way UPDATE-only backfills (for example pending-order back-numbering) reach restored rows. A manifest naming an unknown migration, or formatVersion > 2, is refused as migration_too_new before anything is touched.
- v2 restore KEEPS pairing (master_unique_id, pairing_password_hash, office_panels secret hashes) so Offices reconnect to the replacement PC on their own. This is the 'continue magically' part. The v1 .obbackup path keeps its current revoke-and-new-pairing-password behaviour unchanged.
- Plain ZIP, as the owner decided. It carries users' password hashes, which sign-in after a restore needs, and panel secret hashes. Panel secrets are 32 random bytes and the pairing password is bcrypt, so offline cracking is infeasible. Weak user passwords are the residual exposure; README.txt and the screen say 'keep this drive safe'.
- Permission: a new capability `storage.backupAll` with MINIMUM_TIER 'server_master' covers backup-all, archive restore, the archive list and the auto-backup config. The v1 encrypted export stays on `storage.manage` (admins). The v1 Settings restore moves to `storage.backupAll` plus the master key, because a restore replaces the Server Master accounts and the owner tied changing them to the master key.
- The master key is required for a Settings (replace) restore but not for first-run Magic restore: a fresh install has nothing to protect, and the route is loopback-only and refused once setup is complete.
- Every route that takes a filesystem path (backup folder, archive path, folder listing, auto-backup config write) and every unauthenticated archive route is loopback-only, through a new requireLoopback middleware. The Master binds 0.0.0.0, and these routes read or write arbitrary paths on the Master PC.
- Progress is reported by polling one unauthenticated, loopback-only GET /api/setup/archive/job every 500 ms rather than by socket or SSE. It works before sign-in (first run) and after a replace-restore has cleared every session, and it adds nothing to the socket contract.
- One job slot per process (backup or restore). A second start gets ConflictError error.conflict.backupBusy. The scheduler skips a tick when the slot is busy.
- Auto-backup config is per-PC state in <dataDir>/auto-backup.json, not a company SETTINGS entry. The folder is a property of this machine's drive letters. SETTINGS has no text control and is gated by settings.manage, which would let a plain admin point the Master at arbitrary write paths. A restore should also not silently start writing to the old PC's drive letter. Changes are still audit-logged (activity.backup.schedule_updated). resetAllData deletes the file.
- Default schedule: off. Hour 21 (local, config.locale.timeZone). keepLast 7 (range 1-60). Due when enabled, setup is complete, the local date differs from lastSuccessDate and the local hour is at or past the chosen hour, so a PC that was off at 21:00 catches up at the next tick or the next day. Folder missing: retry every tick, notify at most once per local day.
- Pruning only deletes files in the chosen folder that match /^OrderBook-Backup-<same company slug>-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/, never other files. Manual backups are never pruned by the manual action, but they count toward keepLast when the scheduler runs.
- Safety net for a replace-restore: before dropping the schema, a data-only archive is written to <dataDir>/backups/pre-restore-<ts>.zip (2 kept, like cluster-snapshot). If any DB step fails, the same restore routine replays that archive and the error names its path. On a failed first-run restore, the schema is just dropped and migrated to latest again (back to first-run). Live uploads are only swapped after the DB commit, so a failure never loses photos.
- Photos are extracted to <dataDir>/tmp/restore-<jobId>/uploads during the hash-check pass, then swapped by rename (uploads becomes tmp/uploads-old-<id>, staged becomes uploads, old is removed) after commit. tmp/ sits on the same volume as uploads, so the rename is atomic. sweepOrphanImageVariants only runs at boot, by which time the rows already exist.
- Zip-slip guard: only entries under data/ and uploads/ are honoured. Each upload path is path.resolve-checked to stay under the staging dir and rejected if absolute or containing '..'. manifest.json and README.txt are read, never extracted.
- Fixed root cause: change-ring BOOT_ID becomes a live `export let` that resetChangeRing() regenerates. Today resetAllData (and now restore) keep the old BOOT_ID, and an Office whose cursor seq is below the refilled ring would get a wrong delta instead of a full snapshot.
- Cache reset is extracted once into services/process-caches.ts#resetProcessCaches() (the list from resetAllData: settings, role, pipeline, field, public API tenant, rate limits, API key failures, change ring). resetAllData, v1 restore and v2 restore all call it, which also fixes HANDOFF known defect 5 for v1 restore.
- FAT32 USB sticks cannot hold a file over 4 GB. A write error with EFBIG, or the partial file reaching 0xFFFFFFFF bytes, maps to error.validation.backupFileTooLargeForDrive ('use an NTFS or exFAT drive'). Splitting archives is not built; add it if a real shop hits this.
- Windows 7 is unaffected: backup and restore are Master-only, and the Master stays on Windows 10+. The new chooseFile IPC uses dialog.showOpenDialog, which also exists in Electron 22, so the shared preload stays valid for the legacy Office build.
- Sealed secrets (secret settings, connector credentials) are carried but cannot be opened on a new PC because vault.key is never archived. getSetting and the connector repository already fall back on SecretBoxError. The post-restore screen tells the owner to re-enter integration keys. The password vault comes back empty by design.

## dataModel

- 20261008000000_backup_all_permission_grant.ts (new, UPDATE-only, passes migration-data-safety): union-only grant of the frozen key list ['storage.backupAll'] into roles.permissions JSONB for every role with tier = 'server_master' (no-op when the roles domain's tier and seed have not run). Template is 20260311000000_storage_permission_grant.ts; down() removes the key. Appended to master/src/db/migrations/index.ts and pinned in DELIBERATELY_LAST in master/tests/migration-registry.test.ts AFTER the roles domain's server_master tier/seed migration.
- No new tables or columns. Auto-backup config and last-run status live in <dataDir>/auto-backup.json ({version:1, enabled, folder, hour, keepLast, lastRun:{at, ok, trigger:'manual'|'schedule', fileName?, folder?, bytes?, reason?}, lastSuccessAt, lastNotifiedDate}), written atomically (write .tmp, then rename).
- Archive format v2 (on disk, not DB): manifest.json {kind:'orderbook-backup', formatVersion:2, backupId(uuid), appVersion, createdAt(ISO), company:{name, masterUniqueId, tenantIds}, migrations:string[] (knex_migrations ORDER BY id), tables:{[name]:{rows, file}}, uploads:{files, bytes}, files:{[path]:{bytes, sha256}}}; data/<table>.ndjson (one row_to_json per line); uploads/**; README.txt.
- Pre-restore safety archives: <dataDir>/backups/pre-restore-<yyyy-mm-dd-hhmmss>.zip, newest 2 kept (beside cluster-snapshot's before-<version> copies).

## permissions

- storage.backupAll (new CAPABILITIES entry, group 'admin', labelToken permission.storage.backupAll, MINIMUM_TIER 'server_master'). Granted to server_master roles by 20261008000000_backup_all_permission_grant. On fresh databases, the admin role's live allPermissions() from 20260303 may store the key, but effectivePermissions clamps it to the admin ceiling, so admins never hold it at runtime. Gates: POST /api/storage/archive, GET /api/storage/archives, POST /api/storage/archive/preview, POST /api/storage/archive/restore, GET/PUT /api/storage/auto-backup, and (changed) POST /api/storage/restore/preview and /api/storage/restore (v1).
- storage.manage (existing, admin): keeps GET /api/storage and POST /api/storage/export (v1 encrypted download) only.

## interfaces

- POST /api/storage/archive {folder:string} -> 202 BackupJobStatus. requireAuth + needs('storage.backupAll') + requireLoopback. Starts exportArchive(trigger 'manual').
- GET /api/storage/archives?folder=<path> -> ArchiveListEntry[] {fileName, path, bytes, modifiedAt, company?} (matching OrderBook-Backup-*.zip only, newest first). storage.backupAll + loopback.
- POST /api/storage/archive/preview {path} -> ArchivePreview. storage.backupAll + loopback.
- POST /api/storage/archive/restore {path, masterKey, confirm:'CONFIRM'} -> 202 BackupJobStatus. storage.backupAll + loopback + the roles domain's master-key gate (lockout). Mode 'replace'.
- GET /api/storage/auto-backup -> AutoBackupStatus {enabled, folder, hour, keepLast, lastRun|null, lastSuccessAt|null, folderReachable:boolean}; PUT /api/storage/auto-backup {enabled, folder, hour, keepLast} -> AutoBackupStatus (validates hour 0-23, keepLast 1-60, folder absolute and existing when enabled; audits backup.schedule_updated). storage.backupAll (PUT also loopback).
- POST /api/setup/archive/preview {path} -> ArchivePreview. Unauthenticated, requireLoopback, refused with error.conflict.alreadySetUp once setup is complete.
- POST /api/setup/archive/restore {path} -> 202 BackupJobStatus. Unauthenticated, requireLoopback, first-run only (mode 'first-run').
- GET /api/setup/archive/job -> BackupJobStatus | null. Unauthenticated, requireLoopback, exempt from the maintenance gate. Polled by both the Settings and first-run UIs.
- Maintenance gate: while a restore is in its DB/swap phases, every other /api/* request (and every new socket handshake, through hub io.use) gets 503 {error:'unavailable', messageKey:'error.unavailable.restoring'}.
- Changed: POST /api/storage/restore/preview and /api/storage/restore (v1) now need storage.backupAll, and /restore also needs masterKey in the form body.
- shared/src/protocol/backup.ts additions: ARCHIVE_FORMAT_VERSION=2; ArchiveManifest; ArchivePreview {manifest-derived company, createdAt, appVersion, backupId, counts:{parties, products, users, leads, orders, images}, totalBytes, tooNew:boolean, sameMaster:boolean}; BackupJobStatus {id, kind:'backup'|'restore', phase:'preparing'|'data'|'photos'|'verifying'|'checking'|'database'|'upgrading'|'finishing'|'done'|'failed', done:number, total:number, startedAt, finishedAt?, fileName?, path?, error?:{messageKey, params?}, safetyArchivePath?}; ArchiveListEntry; AutoBackupConfig; AutoBackupStatus. BackupFailureReason gains 'folder_missing' | 'not_enough_space' | 'file_too_large_for_drive' | 'not_an_archive'.
- shared/src/protocol/desktop.ts DesktopBridge (optional members): chooseDirectory?(options?: {title?: string}) (existing call sites keep working) and a new chooseFile?(options?: {title?: string; extensions?: string[]}): Promise<string|null>.
- IPC: the existing orderbook:chooseDirectory accepts an optional {title} (string, max 200 chars, default unchanged); new orderbook:chooseFile -> dialog.showOpenDialog({properties:['openFile'], filters:[{name, extensions}]}) returning the path or null.
- Notifications (outbound to the notifications domain): kinds 'backup.autoSkipped' {folder} and 'backup.autoFailed' {reason}, audience Server Master users, at most one per local day.

## settings

- No SETTINGS registry entries (see decisions: auto-backup config is per-PC in <dataDir>/auto-backup.json and is edited only through /api/storage/auto-backup).
- No CompanyFeatures fields; nothing reaches Office panels.

## uiScreens

- Master Settings > 'Storage & backup' tab (rename of settings.tab.storage). The existing usage KeyValueList and StorageBackupActions stay, with the v1 restore button now shown only with storage.backupAll. Two new SettingsSections are shown only with storage.backupAll: (1) BackupAllSection: a folder Input plus a 'Choose folder…' Button when desktopBridge()?.chooseDirectory exists, a free-space line, a 'Back up everything' primary Button, a determinate ProgressBar with the phase label and a 'Done/size' result, a 'Backups in this folder' DataTable (name, date, size) with a per-row 'Restore…' action, and a 'Restore from another file…' Button (chooseFile or typed path). Restore opens the existing Modal confirmation pattern (preview facts, master key password Input, type CONFIRM), then shows progress inline; when done, the app is sent to sign-in. (2) AutoBackupSection: enabled switch, folder field with chooser, hour select (00-23), keep-last number, Save, and a last-run status line (ok, skipped because the drive is missing, failed with reason, or never). It shows a warning tone when the last success is over 7 days old.
- First-run (FirstRunScreen.tsx) choose card gets a third Button 'Magic restore from a backup drive' as the second option. The existing 'Restore from backup' is relabelled 'Restore an encrypted backup (.obbackup)'. MagicRestoreFlow: pick a file (chooseFile when in the shell; a path Input always), preview card (company, backup date, app version, counts, photos, size; a 'too new' banner disables Restore), Restore button, progress bar with phase labels, and a done card ('Everything is back. Sign in with your usual username and password. Office panels will reconnect by themselves.' plus a 're-enter integration keys' note) with Continue, which calls onComplete so setup status is re-read and sign-in shows.
- ui/src/ProgressBar.tsx: a determinate progress bar (value, max, label, role=progressbar, semantic tokens only). Reuse the UI domain's loading-bar component instead if it lands first, adding a `value` prop.
- No nav entries, no new sub-pages, no new shortcuts (this lives inside an existing Settings tab). Office panel UI is untouched.

## steps

### 1. Declare the zip libraries

Files: `master/package.json`, `package-lock.json`

Add dependencies archiver ^5.3.2 and yauzl ^2.10.0, and devDependencies @types/archiver ^5.3.4 and @types/yauzl ^2.10.3 to the @orderbook/master workspace, then run npm install so the lockfile marks yauzl non-dev. Check that `npm ls --omit=dev --workspace @orderbook/master` lists both, so tools/release.mjs stage() ships them with no edit.

### 2. Shared wire types, permission, desktop bridge

Files: `shared/src/protocol/backup.ts`, `shared/src/protocol/desktop.ts`, `shared/src/domain/permissions.ts`

Append ARCHIVE_FORMAT_VERSION, ArchiveManifest, ArchivePreview, BackupJobStatus, ArchiveListEntry, AutoBackupConfig, AutoBackupStatus, and the new BackupFailureReason members (all new fields optional where they extend existing types). Add the optional chooseFile and the chooseDirectory options to DesktopBridge. Add the CAPABILITIES entry {key:'storage.backupAll', group:'admin', labelToken:'permission.storage.backupAll'} and MINIMUM_TIER 'storage.backupAll': 'server_master'. This needs the roles domain's 'server_master' in ROLE_TIERS.

### 3. Pure archive rules

Files: `master/src/domain/archive.ts`

No I/O. companySlug(name) (ASCII, dash-separated, max 40 chars, fallback 'company'); archiveFileName(company, date, timeZone) -> OrderBook-Backup-<slug>-<yyyy-mm-dd-hhmm>.zip; isArchiveFileName(name, slug?); assertArchiveRestorable(manifest, knownMigrationNames) throws BackupError not_an_archive, migration_too_new (formatVersion>2 or any unknown migration) with fileAppVersion; safeUploadTarget(stagingDir, entryName) returns the resolved path or null (zip-slip); pruneCandidates(entries, slug, keepLast); isAutoBackupDue(config, now, timeZone); previewFromManifest(manifest, known) -> ArchivePreview counts (parties, products, users, leads, orders from manifest.tables rows; images from uploads.files).

### 4. Zip helpers

Files: `master/src/lib/archive-zip.ts`

createZipWriter(filePath) wraps archiver('zip', {zlib:{level:6}}) piped to fs.createWriteStream. Its appendEntry(name, source: Readable | AsyncIterable<string|Buffer>, {store?}) pipes through a hashing Transform, waits for archiver's 'entry' event before resolving (strictly sequential, one open file at a time), and returns {bytes, sha256}. finalize() awaits 'close' and maps EFBIG or bytes >= 0xFFFFFFFF on the output to BackupError file_too_large_for_drive. openZipReader(filePath) wraps yauzl.open(lazyEntries, autoClose:false) into {entries: Map<name, Entry>, readStream(name), readText(name, maxBytes), close()}.

### 5. Backup repository streaming primitives

Files: `master/src/repositories/backup.repository.ts`

Add primaryKeyColumns(trx, table) (pg_index indisprimary, ordered by indkey). Add async generator streamTableNdjson(trx, table, pageSize=2000) doing keyset paging `SELECT row_to_json(t)::text AS j, <pk cols> FROM "table" t WHERE (<pk>) > (?) ORDER BY <pk> LIMIT ?`, with a single SELECT when there is no PK. Add insertableColumns(trx, table) (information_schema.columns where is_generated='NEVER'). Add insertJsonBatch(trx, table, columns, jsonArrayText) via json_populate_recordset. Add truncateTables(trx, tables) (RESTART IDENTITY CASCADE) and appliedMigrationNames(runner) (knex_migrations ORDER BY id). Export resyncSequences. loadTables reuses truncateTables, so v1 behaviour is unchanged. Do NOT name user_password_vault anywhere new (password-vault-invariants).

### 6. Single job slot and maintenance gate

Files: `master/src/services/backup-job.ts`, `master/src/http/middleware/maintenance-gate.ts`, `master/src/http/middleware/require-loopback.ts`, `master/src/http/health.ts`, `master/src/http/app.ts`, `master/src/realtime/hub.ts`

backup-job.ts holds the one BackupJobStatus: startJob(kind, run(update)) throws ConflictError('error.conflict.backupBusy') when busy and runs detached, catching an AppError into status.error {messageKey, params}; currentJob(); setMaintenance(on) and isMaintenance(). maintenance-gate.ts returns 503 error.unavailable.restoring for /api/* except /api/setup/archive/job and /health while isMaintenance(); it is mounted in app.ts before attachSession. require-loopback.ts exports isLoopbackRequest(req) (moved from health.ts, which now imports it) and requireLoopback (ForbiddenError messageKey error.forbidden.masterPcOnly). hub.ts io.use refuses handshakes while isMaintenance().

### 7. Process cache reset and BOOT_ID

Files: `master/src/services/process-caches.ts`, `master/src/services/developer.service.ts`, `master/src/services/backup-restore.service.ts`, `master/src/realtime/change-ring.ts`, `master/src/services/storage.service.ts`

process-caches.ts resetProcessCaches() runs the list now inline in resetAllData (invalidateSettingsCache, invalidateRoleCache, invalidatePipelineCache, invalidateFieldCache, resetPublicApiTenantCache, resetRateLimits, resetApiKeyFailures, resetChangeRing). resetAllData calls it and also removes <dataDir>/auto-backup.json and <dataDir>/backups/pre-restore-*. v1 restoreBackup calls it instead of its two invalidations. change-ring.ts: `export let BOOT_ID = randomUUID()`, reassigned in resetChangeRing (ESM live binding, so delta.service and snapshot.service see the new id). storage.service.ts exports directorySize and freeDiskBytes for the exporter's space check.

### 8. Archive exporter

Files: `master/src/services/archive-export.service.ts`

exportArchive({folder, trigger, keepLast?, includeUploads=true, fileNameOverride?}, actor, update). Steps: require setup complete (error.conflict.notSetUp); resolve folder (absolute, exists, is a directory, writable; else BackupError folder_missing with validation key error.validation.backupFolderMissing); estimate = sum pg_total_relation_size(user tables) + directorySize(uploadsDir), require freeDiskBytes(folder) >= estimate*1.05 + 64 MB (error.validation.backupNotEnoughSpace {needed, free}). Open the db().transaction and first run `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. Write README.txt, then each table via streamTableNdjson as data/<t>.ndjson (count rows, progress weighted by relation size), then walk uploadsDir recursively appending uploads/<rel> with store:true (progress by bytes), then manifest.json last. Finalize to <name>.zip.partial. Verify phase: openZipReader, re-hash every manifest.files entry, confirm none are missing. Rename to .zip, and on any failure unlink the .partial. Then recordActivity(entityType 'backup', entityId backupId, action 'created', details {name: fileName, folder, rows, files, bytes, trigger}) in its own transaction, write lastRun into auto-backup.json through backup-scheduler's config helpers, and when keepLast is given, prune with pruneCandidates. Returns {fileName, path, bytes}.

### 9. Archive restore

Files: `master/src/services/archive-restore.service.ts`

previewArchive(path): openZipReader, parse manifest.json (max 32 MB; else not_an_archive), previewFromManifest with the known names from migrations/index.ts. restoreArchive(path, {mode:'first-run'|'replace', actor, masterKeyVerified}, update): (1) assertArchiveRestorable. first-run mode requires !isSetupComplete(); replace mode requires it. (2) 'checking'+'photos': one pass over manifest.files. data/* is hashed and discarded; uploads/* goes through safeUploadTarget to <dataDir>/tmp/restore-<jobId>/uploads, hashed and compared; any mismatch or missing entry gives BackupError corrupt_file with nothing touched. (3) replace mode only: exportArchive({folder: <dataDir>/backups, includeUploads:false, fileNameOverride:'pre-restore-<ts>.zip'}) and keep the newest 2. (4) setMaintenance(true); resetAuthState(); disconnectEverySocket(). (5) 'database': DROP SCHEMA public CASCADE; CREATE SCHEMA public; loop db().migrate.up() until every manifest.migrations name is in knex_migrations. Then one transaction: SET LOCAL session_replication_role='replica'; truncateTables(listUserTables); for each data file, readline the entry stream into batches (1000 rows or 4 MB) and insertJsonBatch with insertableColumns; resyncSequences; verifyActivityLogChain(all tenant ids) or BackupError hash_chain_invalid. (6) 'upgrading': runMigrations(). (7) 'finishing': swap uploads by rename, refreshStoredLanIp(), resetProcessCaches(), then recordActivity('backup','restored',{name:fileName, backupCreatedAt, appVersion}) with actor (system actor for first-run). On failure in steps 5-6: first-run mode drops the schema and runs runMigrations; replace mode re-runs steps 5-7 from the safety archive (no uploads swap) and sets status.safetyArchivePath. Always remove the staging dir and setMaintenance(false) in finally.

### 10. Auto-backup scheduler

Files: `master/src/services/backup-scheduler.ts`, `master/src/index.ts`

readAutoBackupConfig() / writeAutoBackupConfig() for <dataDir>/auto-backup.json (validated, defaults {enabled:false, folder:'', hour:21, keepLast:7}). getAutoBackupStatus() adds folderReachable. updateAutoBackupConfig(input, actor) validates and records activity backup.schedule_updated. startBackupScheduler() runs a 60 s unref'd setInterval like connector-scheduler and returns a disposer. tick(now): skip unless isAutoBackupDue, setup is complete and the job slot is free. If the folder is missing, record lastRun {ok:false, reason:'folder_missing'} and call notifications.notify('backup.autoSkipped') once per local day. Otherwise startJob('backup', exportArchive({trigger:'schedule', keepLast})), and on failure set lastRun.reason and notify 'backup.autoFailed', also recording activity backup.failed. index.ts: disposables.push(startBackupScheduler()) after startConnectorScheduler.

### 11. Routes

Files: `master/src/http/routes/data.routes.ts`, `master/src/http/routes/setup.routes.ts`

data.routes.ts: add the /storage/archive, /storage/archives, /storage/archive/preview, /storage/archive/restore and /storage/auto-backup routes listed in interfaces, with needs('storage.backupAll') + requireLoopback, and with string/absolute-path validation (validation.backup.pathRequired). The archive restore route calls the roles domain's master-key gate before startJob. Switch the v1 /storage/restore/preview and /storage/restore to needs('storage.backupAll'), and make /storage/restore also verify masterKey. setup.routes.ts: add /archive/preview, /archive/restore (requireLoopback, refuse when setup is complete) and GET /archive/job (requireLoopback, returns currentJob()).

### 12. Electron file and folder pickers

Files: `electron/shell.ts`, `electron/preload.cts`

shell.ts: orderbook:chooseDirectory takes an optional {title} (typeof check, slice(0,200), else the current title); add orderbook:chooseFile ({title?, extensions?}, with extensions filtered to /^[a-z0-9]{1,8}$/ and defaulting to ['zip']) using dialog.showOpenDialog({properties:['openFile']}). preload.cts exposes chooseDirectory(options?) and chooseFile(options?). Both are Electron-22-compatible.

### 13. Web client and screens

Files: `master/web/src/api.ts`, `master/web/src/components/useBackupJob.ts`, `master/web/src/components/BackupAllSection.tsx`, `master/web/src/components/AutoBackupSection.tsx`, `master/web/src/components/StorageBackup.tsx`, `master/web/src/screens/SettingsScreen.tsx`, `master/web/src/screens/FirstRunScreen.tsx`, `ui/src/ProgressBar.tsx`, `ui/src/index.ts`

api.ts: startArchiveBackup, listArchives, previewArchive, restoreArchive, archiveJob, autoBackup, saveAutoBackup, setupPreviewArchive, setupRestoreArchive, and restoreStorage gains masterKey. useBackupJob polls api.archiveJob every 500 ms while the job is not done or failed, and tolerates 503 and network errors during the DB phase. BackupAllSection and AutoBackupSection follow the uiScreens spec; phase labels use t(`backupAll.phase.${phase}`) through an exhaustive map rather than a template literal, so the i18n-call-sites scan sees each key. StorageBackup.tsx shows restore only with storage.backupAll and adds a master key field. SettingsScreen renders the two sections when permissions.includes('storage.backupAll'). FirstRunScreen gets MagicRestoreFlow and the relabelled v1 option. ProgressBar goes in ui/ if the UI domain has not shipped one. Controls the role lacks are absent, not disabled.

### 14. Grant migration and registry

Files: `master/src/db/migrations/20261008000000_backup_all_permission_grant.ts`, `master/src/db/migrations/index.ts`, `master/tests/migration-registry.test.ts`

Frozen NEW_KEYS=['storage.backupAll'], unioned into roles where tier='server_master' (UPDATE only). Append to the migrations array and to DELIBERATELY_LAST after the roles domain's server_master migrations.

### 15. i18n

Files: `shared/src/i18n/en.ts`, `shared/tests/activity-tokens.lock.json`

Add: permission.storage.backupAll; settings.tab.storage value changes to 'Storage & backup'; backupAll.* (title, help, folderLabel, chooseFolder, freeSpace, start, phase.preparing|data|photos|verifying|checking|database|upgrading|finishing|done|failed, done, list.title, list.empty, restore.action, restore.fromFile, restore.confirmTitle, restore.warning, restore.masterKeyLabel, restore.typeConfirm, restore.safetyCopy, restore.doneSignIn); autoBackup.* (title, enabled, folder, hour, keepLast, save, lastRun.ok, lastRun.skippedDrive, lastRun.failed, lastRun.never, stale); firstRun.choose.magicRestore and firstRun.choose.restoreEncrypted; magicRestore.* (title, chooseFile, pathLabel, read, company, created, version, counts, photos, size, tooNew, start, doneTitle, doneBody, reenterKeys); error.validation.backupFolderMissing, backupNotEnoughSpace, backupFileTooLargeForDrive, backupNotAnArchive; validation.backup.pathRequired; error.conflict.backupBusy; error.forbidden.masterPcOnly; error.unavailable.restoring; activity.backup.created|restored|failed|schedule_updated (and add these to activity-tokens.lock.json); notification.backup.autoSkipped|autoFailed (key names per the notifications domain).

### 16. Docs

Files: `docs/7-STORAGE-BACKUP-RESTORE.md`, `docs/STRUCTURE.md`, `HANDOFF.md`, `AI_COLLABORATION.md`

Create the long-cited docs/7-STORAGE-BACKUP-RESTORE.md: v1 .obbackup envelope, v2 zip layout and manifest schema, replay-restore algorithm, what is never included (user_password_vault, master_clock, knex_*, secrets/vault.key), pairing-kept rule, FAT32 limit, auto-backup file. Update STRUCTURE §8.3 (auto-backup.json, backups/pre-restore-*, tmp/restore-*), §11.8 and §3.6 (storage.backupAll); update HANDOFF (owed: archive splitting; known defect 5 closed for restore); update AI_COLLABORATION per the working agreement.

## tests

- NEW master/tests/archive-roundtrip.integration.test.ts: seed a party, product + product_images row, real webp variant files under imagesDir/<tenant>/<imageId>/ and an avatar file. Run exportArchive to a tmp folder. Assert: the zip exists, no .partial is left, the manifest lists every listUserTables table, no 'user_password_vault' or 'secrets/' entry exists, hashes verify. Mutate (delete the party, add another, delete uploads), then run restoreArchive in replace mode (masterKeyVerified true) and assert: every table's ordered row_to_json dump equals the pre-export dump, image and avatar bytes are identical, the next party code and activity_log id are past the max, verifyActivityLogChain is true, a 'backup.restored' audit row exists, office_panels rows and pairing_password_hash are unchanged, BOOT_ID changed, and isMaintenance() is false.
- NEW master/tests/archive-replay.integration.test.ts: build an 'older level' archive from a real export (test helper rewrites it with archiver: drop '20260401000000_order_vehicle_number' from manifest.migrations, strip vehicle_number from orders.ndjson, recompute hashes). Restore succeeds, knex_migrations ends with the full registry, and orders.vehicle_number is null. Also: an archive naming an unknown migration is refused with migration_too_new by both preview (tooNew:true) and restore, and the DB is untouched. A flipped byte in data/parties.ndjson gives corrupt_file before the maintenance gate is ever set. An entry named 'uploads/../../evil.txt' is rejected and nothing is written outside staging.
- NEW master/tests/archive-first-run.integration.test.ts: on a not-set-up DB, setup archive restore completes; isSetupComplete() is true, getIdentity().masterUniqueId equals the manifest's, and sign-in with a restored user's password works. A failing load (corrupted chain) leaves the Master in first-run state with migrations at latest.
- NEW master/tests/archive-export-paging.integration.test.ts: streamTableNdjson with pageSize 100 over 1,050 rows, including a composite-PK table, yields every row exactly once in PK order across 11 queries (bounded memory by construction). The export refuses when freeDiskBytes is stubbed below the estimate (backupNotEnoughSpace) and when the folder is missing (backupFolderMissing).
- NEW master/tests/archive-domain.test.ts (pure): companySlug and archiveFileName (timezone-aware), isArchiveFileName, pruneCandidates keeps the newest N of the same slug and never touches foreign files, safeUploadTarget rejects '..', absolute and drive-letter paths, assertArchiveRestorable rejects formatVersion 3 and unknown migrations, and isAutoBackupDue covers before hour, after hour, already done today, and catch-up the next day.
- NEW master/tests/backup-scheduler.test.ts: tick with the folder missing writes lastRun reason folder_missing and calls notify once even across two ticks the same day; tick when due and the folder exists starts exactly one job; a busy job slot skips.
- NEW master/tests/require-loopback.test.ts: isLoopbackRequest accepts 127.0.0.1, ::1 and ::ffff:127.0.0.1 and rejects LAN addresses; the archive routes answer 403 error.forbidden.masterPcOnly for a non-loopback remoteAddress.
- NEW master/tests/maintenance-gate.test.ts: while isMaintenance() is true, /api/parties gets 503 error.unavailable.restoring, and /api/setup/archive/job and /health still answer.
- NEW master/tests/change-ring.test.ts (or extend the existing one): resetChangeRing() changes BOOT_ID, and delta.service refuses a cursor carrying the old boot id.
- NEW master/tests/migration-backup-all-grant.integration.test.ts: the grant adds storage.backupAll only to server_master-tier roles and is idempotent (template: migration-grant.integration.test.ts).
- UNCHANGED but must stay green: backup-chain.integration.test.ts and backup-sequences.integration.test.ts (v1 restoreBackup signature unchanged; loadTables keeps its behaviour after the truncateTables refactor), backup-crypto.test.ts, backup-domain.test.ts, password-vault-invariants.test.ts (no new file names the vault table), password-vault.integration.test.ts, migration-data-safety.test.ts (grant is UPDATE-only), developer.integration.test.ts (resetAllData now calls resetProcessCaches; same observable result), i18n-coverage and i18n call-site scans (phase keys are literal), wire-optionality.test.ts (new fields optional), electron/tests/health.test.ts (isLoopback moved but same behaviour).
- CHANGED deliberately: master/tests/migration-registry.test.ts DELIBERATELY_LAST gains 20261008000000_backup_all_permission_grant (reason: pinned after the server_master seed). shared/tests/activity-tokens.lock.json appends backup.created, backup.restored, backup.failed and backup.schedule_updated (append-only lock). Any permission-catalogue snapshot or grid test (shared/ui PermissionGrid) gains storage.backupAll with the server_master ceiling.

## docs

- docs/7-STORAGE-BACKUP-RESTORE.md (new; it is already cited by backup code but missing): formats v1 and v2, the restore algorithm, exclusions, pairing behaviour, FAT32 note, auto-backup.
- docs/STRUCTURE.md §3.6 (storage.backupAll), §8.3 (auto-backup.json, backups/pre-restore-*, tmp/restore-*), §11.8 (backup-all, Magic restore, scheduler, maintenance gate, BOOT_ID reset).
- HANDOFF.md: the feature, the owed item 'split archives for FAT32 > 4 GB', the restore cache-reset defect closed, and the new loopback-only routes.
- AI_COLLABORATION.md: working-agreement entry for this change.
- README.txt inside every archive: what the file is, 'keep this drive safe' (it is unencrypted), and how to restore (first-run > Magic restore).

## risks

- Plain ZIP exposes user password hashes and party, order and user data to anyone holding the drive. This was the owner's choice; it is mitigated only by README and on-screen wording.
- The replay restore is not one transaction across DROP SCHEMA, migrate.up and migrate.latest. It is covered by the pre-restore safety archive (replace mode) and drop-and-remigrate (first-run mode). If the safety replay also fails, the Master needs the safety archive restored by hand from first-run; the error names its path.
- session_replication_role='replica' needs a superuser-equivalent role. It works on the embedded cluster and may fail on an external DATABASE_URL (an existing v1 limitation). Surface the Postgres error message.
- Long REPEATABLE READ export transactions hold one of the 10 pool connections for minutes and delay vacuum. This is acceptable once a day; the scheduler default of 21:00 avoids business hours.
- FAT32 drives cap a single file at 4 GB. Detection and messaging are built, splitting is not.
- Restoring onto a PC whose clock is behind the backup's newest HLC could make new local edits lose last-writer-wins comparisons until the clock passes. Note it in the docs; the HLC self-heal in identity.repository covers counter monotonicity, not wall-clock skew.
- During a replace-restore, other schedulers (connector, release polling, session sweep) may log errors against the dropped schema. They are harmless but noisy; the gate stops request traffic only.
- Offices only reconnect to a replacement PC if the connectivity domain ships rediscovery by masterUniqueId and auto-reconnect after 'io server disconnect'. Without it, Offices show offline until re-paired or restarted.
- If another domain adds a Postgres sequence not owned by a column (like party_code_seq), resyncSequences must learn it, or restored installs hand out duplicate numbers.
- Large photo libraries on slow USB 2.0 sticks make backup plus verify take a long time. Progress is shown and the work is cancellable only by closing the app (the .partial is cleaned on the next run by the folder-list filter, which ignores .partial files).

## dependsOn

- Roles domain: adds 'server_master' to ROLE_TIERS and the roles_tier_check, and its seed migration must precede 20261008000000_backup_all_permission_grant in the registry. It provides a master-key gate (createDeveloperGate-style, e.g. masterKeyGate.verify(candidate, clientKey) -> throws TooManyRequests/Unauthorized) used by the archive restore and v1 restore routes. Its 'no server_master users → ask master key then two accounts' first-boot flow must also trigger after restoring a pre-update archive. If it also needs loopback detection, it should reuse master/src/http/middleware/require-loopback.ts from this domain (one file, created by whichever lands first).
- Connectivity domain: Office auto-reconnect after 'io server disconnect' (sockets are disconnected on restore) and rediscovery of a moved Master by masterUniqueId (the replacement PC has a new IP). Together these make 'Offices continue magically'.
- Notifications domain: notify(tenantId, {kind:'backup.autoSkipped'|'backup.autoFailed', audience:'server_master', params}) with bell rendering. Until it exists, the scheduler's notify call is a no-op and the last-run line still shows the state.
- UI/shell domain: a determinate ProgressBar/LoadingBar in ui/ (this domain adds ui/src/ProgressBar.tsx if not present). Master Settings layout and the light-theme tokens.
- Pending-order numbering domain (and any domain adding sequences or counters): numbering counters should live in id_sequences rows or a column-owned sequence, so restore's generic resyncSequences covers them; otherwise add them to resyncSequences.
- Every domain adding an in-process cache (presence, chat unread counts, PO counters, report caches) must register its reset in services/process-caches.ts#resetProcessCaches so restore and developer reset clear it.
- Chat/Printroom/other new tables: no action needed. They are picked up by listUserTables() automatically and must carry tenant_id (or a TRANSITIVELY_SCOPED entry) only for the v1 selected-scope export.
- Shared files touched by several domains: shared/src/domain/permissions.ts, shared/src/i18n/en.ts, shared/tests/activity-tokens.lock.json, master/src/db/migrations/index.ts plus DELIBERATELY_LAST, electron/shell.ts and preload.cts, shared/src/protocol/desktop.ts, master/web/src/screens/SettingsScreen.tsx.

## openQuestions

- Do you want the backup-all zip to also include human-readable CSV or Excel copies of products, parties and users (for opening on any PC without OrderBook), or is OrderBook-only readability enough? I have assumed OrderBook-only; the party CSV export from the import/export domain can be added to the zip later as a single extra file.

## effort

About 30 files touched or created: 10 new server files (domain/archive.ts, lib/archive-zip.ts, archive-export/restore services, backup-job, backup-scheduler, process-caches, two middlewares, one migration), 4 new web components or hooks plus ui ProgressBar, and edits to about 15 existing files (routes, index, hub, change-ring, developer/backup-restore/storage services, electron shell and preload, shared protocol, permissions, i18n en, FirstRunScreen, SettingsScreen, StorageBackup, api.ts, the migration registry and its test). Roughly 1,900-2,300 new lines including about 700 lines of tests and roughly 120 i18n keys. Two to three focused implementation sessions, plus one for verification on a real Windows Master with a USB drive (FAT32 and NTFS) and a second PC for the magic restore.
