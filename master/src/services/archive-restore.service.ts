/**
 * Restoring a "backup all" archive (`archive-export.service.ts`): Magic restore
 * on a new Master PC at first run, or a replace on a Master already in use
 * (`docs/7-STORAGE-BACKUP-RESTORE.md`).
 *
 * The order, and why:
 *
 *  1. **Check everything before touching anything.** The entry list is checked
 *     against the manifest, every data entry is re-hashed and every photo is
 *     unpacked to a staging folder and hashed. A wrong byte anywhere stops here
 *     with the live data and photos untouched.
 *  2. **A safety copy** (replace only): a data-only archive of the current
 *     database in `<dataDir>/backups`, the newest two kept. If the load below
 *     fails, it is replayed the same way.
 *  3. **Maintenance**: sessions end and sockets close, then the API answers 503
 *     (`backup-job.ts`).
 *  4. **Replay at the archive's own schema level.** The schema is dropped and
 *     migrated up only as far as the migrations the archive names, the rows
 *     are loaded in replica mode (no triggers, no foreign-key order), the
 *     audit chain is verified, and the transaction commits. Then the rest of
 *     the migrations run over the restored rows, exactly as an in-place update
 *     would have, so backfills such as pending-order numbers reach them.
 *  5. **Photos swapped in after the commit**, by renaming the staging folder,
 *     so the orphan sweep at the next boot sees rows for every photo.
 *  6. The stored LAN address, the Server Master role, every process cache, and
 *     a `backup.restored` entry in the restored trail.
 *
 * Pairing is kept: the Master's unique id, the pairing password and each
 * Office panel's secret and proof key come back as they were, so the Offices
 * find this PC through their proof-checked rediscovery and carry on. The v1
 * `.obbackup` restore (`backup-restore.service.ts`) re-pairs instead and is
 * unchanged.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import type { ArchiveManifest, ArchivePreview, ArchiveTableEntry } from '@orderbook/shared';

import { config } from '../config/index.js';
import { db, runMigrations } from '../db/knex.js';
import { migrations } from '../db/migrations/index.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import {
  MANIFEST_ENTRY,
  MAX_MANIFEST_BYTES,
  type ArchiveSizes,
  assertArchiveFits,
  assertArchiveRestorable,
  checkArchiveEntries,
  parseArchiveManifest,
  safeUploadTarget,
  tableEntryName,
} from '../domain/archive.js';
import { type EntryDigest, type ZipReader, openZipReader } from '../lib/archive-zip.js';
import { writeDurable } from '../lib/durable-file.js';
import { AppError, BackupError, ConflictError, ValidationError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import {
  appliedMigrationNames,
  insertJsonBatch,
  insertableColumns,
  isExcludedTable,
  listTenantIds,
  listUserTables,
  resyncSequences,
  truncateTables,
  verifyActivityLogChain,
} from '../repositories/backup.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { findActiveUserIdsWithPermission } from '../repositories/user.repository.js';
import { assertDigest, exportArchive } from './archive-export.service.js';
import { enterMaintenance, leaveMaintenance, type JobProgress } from './backup-job.js';
import { stopCataloguePhotos } from './catalogue-photos.service.js';
import { notify } from './notification.service.js';
import { scheduleLongOfflineNoticesAtBoot } from './panel.service.js';
import { resetProcessCaches } from './process-caches.js';
import { ensureServerMasterRole } from './server-master.service.js';
import { isSetupComplete, refreshStoredLanIp } from './setup.service.js';
import { freeDiskBytes } from './storage.service.js';

const log = createLogger('archive-restore');

/** Where the safety copies go, beside the cluster snapshots. */
const SAFETY_PREFIX = 'pre-restore-';
const SAFETY_KEPT = 2;
/** Rows per INSERT, or fewer when they pass this much text. */
const BATCH_ROWS = 1000;
const BATCH_TEXT = 4 * 1024 * 1024;
/** The longest single row line read from an archive. */
const MAX_LINE = 64 * 1024 * 1024;

export type ArchiveRestoreMode = 'first-run' | 'replace';

export interface ArchiveRestoreOptions {
  mode: ArchiveRestoreMode;
  /** Who asked; only their name is kept, since they may not exist in the restored users. */
  actor?: ActorContext;
  progress?: (progress: JobProgress) => void;
  /** Names the staging folder; the job's id when run as one. */
  jobId?: string;
}

export interface ArchiveRestoreResult {
  manifest: ArchiveManifest;
  /** Sealed values the owner must enter again on this PC. */
  sealed: { secretSettings: number; connectorCredentials: number };
  /** The safety copy written before a replace, kept in `<dataDir>/backups`. */
  safetyArchivePath: string | null;
}

interface OpenArchive {
  reader: ZipReader;
  manifest: ArchiveManifest;
  sizes: ArchiveSizes;
}

const noProgress = (): void => undefined;

function corrupt(): BackupError {
  return new BackupError('corrupt_file', 'error.validation.backupCorruptFile');
}

function rejected(entry: string): BackupError {
  return new BackupError('entryRejected', 'error.validation.archiveEntryRejected', { entry });
}

/**
 * Open an archive and check everything that can be checked without reading
 * the entries: the manifest, the entry list against it, that this build can
 * replay its migrations, and that it names no table a backup never carries.
 */
async function openArchive(file: string): Promise<OpenArchive> {
  const resolved = path.resolve(file);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats?.isFile()) throw new ValidationError('error.validation.backupFileMissing', { file: resolved });

  const reader = await openZipReader(resolved);
  try {
    if (!reader.entries.some((entry) => entry.name === MANIFEST_ENTRY)) {
      throw new BackupError('notAnArchive', 'error.validation.archiveNotAnArchive');
    }
    const manifest = parseArchiveManifest(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST_BYTES));
    if (manifest.appliedMigrations.length === 0) {
      throw new BackupError('notAnArchive', 'error.validation.archiveNotAnArchive');
    }
    assertArchiveRestorable(
      manifest,
      migrations.map((migration) => migration.name),
    );
    const sizes = checkArchiveEntries(manifest, reader.entries);
    const excluded = manifest.tables.find((table) => isExcludedTable(table.name));
    if (excluded) throw rejected(tableEntryName(excluded.name));
    return { reader, manifest, sizes };
  } catch (error) {
    reader.close();
    throw error;
  }
}

function rowsOf(manifest: ArchiveManifest, table: string): number {
  return manifest.tables.find((entry) => entry.name === table)?.rows ?? 0;
}

/** What the archive holds, for the screen to show before anything is restored. Changes nothing. */
export async function previewArchive(file: string): Promise<ArchivePreview> {
  const { reader, manifest, sizes } = await openArchive(file);
  reader.close();
  return {
    fileName: path.basename(file),
    company: manifest.company,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    masterUniqueId: manifest.masterUniqueId,
    counts: {
      parties: rowsOf(manifest, 'parties'),
      products: rowsOf(manifest, 'products'),
      users: rowsOf(manifest, 'users'),
      leads: rowsOf(manifest, 'leads'),
      orders: rowsOf(manifest, 'orders'),
    },
    photos: rowsOf(manifest, 'product_images'),
    totalBytes: sizes.totalBytes,
    sealed: manifest.sealed ?? { secretSettings: 0, connectorCredentials: 0 },
  };
}

/** One entry unpacked to `target` and hashed on the way. */
async function extractEntry(reader: ZipReader, name: string, target: string): Promise<EntryDigest> {
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(
    await reader.openStream(name),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    }),
    // `wx`: never over a file already there. Duplicate names were refused earlier.
    createWriteStream(target, { flags: 'wx' }),
  );
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Migrate a dropped schema up until every migration the archive names has
 * run, and no further: the archive's rows belong to that schema.
 */
async function migrateUpTo(names: readonly string[]): Promise<void> {
  let applied = new Set<string>();
  while (names.some((name) => !applied.has(name))) {
    const [, ran] = (await db().migrate.up()) as [number, string[]];
    // Cannot happen after `assertArchiveRestorable`; a guard, not a path.
    if (ran.length === 0) throw corrupt();
    applied = new Set(await appliedMigrationNames());
  }
}

/**
 * One `data/<table>.ndjson` into the table, in batches. The columns are the
 * table's own that the archive's rows carry: an archive from an older schema
 * level lacks the newer columns, and those keep their defaults. Read chunk by
 * chunk, so memory holds one batch, not the table.
 */
async function loadTable(
  trx: TransactionContext,
  reader: ZipReader,
  table: ArchiveTableEntry,
  onRows: (count: number) => void,
): Promise<number> {
  let columns: string[] | null = null;
  let batch: string[] = [];
  let batchText = 0;
  let count = 0;

  const flush = async () => {
    if (batch.length === 0 || !columns) return;
    await insertJsonBatch(trx, table.name, columns, batch);
    onRows(batch.length);
    batch = [];
    batchText = 0;
  };
  const take = async (line: string) => {
    if (line.length === 0) return;
    if (!columns) {
      let first: unknown;
      try {
        first = JSON.parse(line);
      } catch {
        throw corrupt();
      }
      if (typeof first !== 'object' || first === null || Array.isArray(first)) throw corrupt();
      columns = await insertableColumns(table.name, trx, Object.keys(first));
    }
    batch.push(line);
    batchText += line.length;
    count += 1;
    if (batch.length >= BATCH_ROWS || batchText >= BATCH_TEXT) await flush();
  };

  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of await reader.openStream(tableEntryName(table.name))) {
    // The carried-over tail holds no newline, so the search starts past it.
    const searched = pending.length;
    pending += decoder.write(chunk as Buffer);
    let start = 0;
    for (let end = pending.indexOf('\n', searched); end !== -1; end = pending.indexOf('\n', start)) {
      await take(pending.slice(start, end));
      start = end + 1;
    }
    pending = pending.slice(start);
    // No row comes near this; a line that never ends is not one this app wrote.
    if (pending.length > MAX_LINE) throw corrupt();
  }
  await take(pending + decoder.end());
  await flush();
  return count;
}

/**
 * Drop the schema and rebuild it from the archive: migrate to its level, load
 * every table in one replica-mode transaction, verify the audit chain, commit,
 * then run the remaining migrations. The caller holds maintenance.
 */
async function replayDatabase(
  reader: ZipReader,
  manifest: ArchiveManifest,
  progress: (progress: JobProgress) => void,
): Promise<void> {
  const totalRows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
  let rowsDone = 0;
  progress({ phase: 'database', done: 0, total: totalRows });

  await db().raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrateUpTo(manifest.appliedMigrations);

  await db().transaction(async (trx) => {
    // Local to this transaction: no trigger fires and no foreign key is checked
    // until it commits, so no table order is needed and the audit chain's own
    // trigger does not re-hash the restored rows.
    await trx.raw(`SET LOCAL session_replication_role = 'replica'`);
    const live = await listUserTables(trx);
    // The rows the migrations just seeded; the archive brings its own.
    await truncateTables(trx, live);

    const liveTables = new Set(live);
    for (const table of manifest.tables) {
      if (!liveTables.has(table.name)) throw rejected(tableEntryName(table.name));
      const loaded = await loadTable(trx, reader, table, (count) => {
        rowsDone += count;
        progress({ done: rowsDone });
      });
      if (loaded !== table.rows) throw corrupt();
    }

    await resyncSequences(trx, live);
    if (!(await verifyActivityLogChain(trx, await listTenantIds(trx)))) {
      throw new BackupError('hash_chain_invalid', 'error.internal.backupHashChainInvalid');
    }
  });

  progress({ phase: 'upgrading', done: 0, total: 0 });
  await runMigrations();
}

/** A data-only archive of the database as it is now, the newest two kept. */
async function writeSafetyArchive(): Promise<string> {
  const folder = path.join(config.dataDir, 'backups');
  await fs.mkdir(folder, { recursive: true });
  const fileName = `${SAFETY_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const result = await exportArchive({ folder, fileName, includeUploads: false, audit: false });

  const older = (await fs.readdir(folder))
    .filter((name) => name.startsWith(SAFETY_PREFIX) && name.endsWith('.zip'))
    .sort()
    .reverse()
    .slice(SAFETY_KEPT);
  for (const name of older) await fs.rm(path.join(folder, name), { force: true }).catch(() => undefined);

  return result.path;
}

/*
 * The one thing `recover` cannot cover is the process itself dying: the schema is
 * dropped outside any transaction, so a power cut there used to bring the Master
 * back empty, on the first-run screen, with the safety copy sitting unnoticed. This
 * file exists from before the drop until the replay is over, and the next boot
 * finishes the job. Whatever stage it finds, the answer is the data from before:
 * the photos are only swapped once this file is gone, so they always match.
 */
const RESTORE_MARKER = 'restore-pending.json';

export interface RestoreMarker {
  mode: ArchiveRestoreMode;
  safetyArchivePath: string | null;
  /** The archive being restored, by name, for the notice. */
  file: string;
  startedAt: string;
}

const restoreMarkerPath = (): string => path.join(config.dataDir, RESTORE_MARKER);

async function clearRestoreMarker(): Promise<void> {
  // Retried: on Windows a scan may hold it for a moment, and a marker left behind
  // would undo a restore that worked at the next boot.
  await fs.rm(restoreMarkerPath(), { force: true, maxRetries: 5, retryDelay: 200 }).catch((error: unknown) =>
    log.error(`Could not remove ${restoreMarkerPath()}: ${toErrorMessage(error)}`),
  );
}

/**
 * On boot, before the migrations: finish a restore the last run did not. A replace
 * goes back to its safety copy, checked first; a first run goes back to empty, as it
 * was. Answers the marker when it did something, and null otherwise.
 *
 * A copy that cannot be used stops the boot with an error naming it, rather than
 * opening an empty Master somebody might set up over it. Unless the Master still has
 * its data: then the drop never happened, and it carries on with what it has.
 */
export async function resumeInterruptedRestore(): Promise<RestoreMarker | null> {
  let marker: RestoreMarker;
  try {
    marker = JSON.parse(await fs.readFile(restoreMarkerPath(), 'utf8')) as RestoreMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error(`Ignoring ${restoreMarkerPath()}, which could not be read: ${toErrorMessage(error)}`);
    }
    return null;
  }

  log.warn(`The restore of ${marker.file} started ${marker.startedAt} did not finish; putting back the data from before it`);
  if (marker.mode === 'replace' && marker.safetyArchivePath) {
    try {
      const safety = await openArchive(marker.safetyArchivePath);
      try {
        for (const table of safety.manifest.tables) {
          assertDigest(await safety.reader.hashEntry(tableEntryName(table.name)), table);
        }
        await replayDatabase(safety.reader, safety.manifest, noProgress);
      } finally {
        safety.reader.close();
      }
    } catch (error) {
      if (await isSetupComplete().catch(() => false)) {
        log.error(`The safety copy could not be used, and the data is still here: ${toErrorMessage(error)}`);
        await clearRestoreMarker();
        return null;
      }
      throw new Error(
        `A restore was interrupted, and the data from before it could not be put back from ${marker.safetyArchivePath}: ${toErrorMessage(error)}. ` +
          `Nothing has been deleted. To restore by hand, delete ${restoreMarkerPath()}, restart, and choose a backup on the first-run screen.`,
      );
    }
  } else {
    await db().raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations();
  }

  await clearRestoreMarker();
  const work = path.join(config.dataDir, 'tmp');
  for (const name of await fs.readdir(work).catch(() => [] as string[])) {
    if (name.startsWith('restore-')) await fs.rm(path.join(work, name), { recursive: true, force: true }).catch(() => undefined);
  }
  return marker;
}

/** After the migrations: the trail and the Server Masters' bell say what happened. */
export async function reportInterruptedRestore(marker: RestoreMarker): Promise<void> {
  for (const tenantId of await listTenantIds()) {
    await recordDetachedActivity(
      {
        tenantId,
        entityType: 'backup',
        entityId: marker.startedAt,
        action: 'restore_failed',
        actorType: 'system',
        actorId: null,
        details: { file: marker.file },
      },
      { ...systemActor(tenantId), actorName: 'Master PC' },
      db(),
    );
    const userIds = await findActiveUserIdsWithPermission(tenantId, 'storage.backupAll');
    await notify(tenantId, userIds, { kind: 'backup.restoreInterrupted', params: { file: marker.file } });
  }
}

/**
 * Put the database back after a failed replay, then rethrow `error`. First
 * run goes back to an empty first-run schema; a replace replays its safety
 * copy. If that fails too, the error names the copy so it can be restored by
 * hand from the first-run screen.
 */
async function recover(mode: ArchiveRestoreMode, safetyArchivePath: string | null, error: unknown): Promise<never> {
  log.error(`Restore failed; putting the previous data back: ${toErrorMessage(error)}`);
  try {
    if (mode === 'replace' && safetyArchivePath) {
      const safety = await openArchive(safetyArchivePath);
      try {
        await replayDatabase(safety.reader, safety.manifest, noProgress);
      } finally {
        safety.reader.close();
      }
    } else {
      await db().raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await runMigrations();
    }
    await clearRestoreMarker();
  } catch (recoveryError) {
    log.error(`Could not put the previous data back: ${toErrorMessage(recoveryError)}`);
    if (safetyArchivePath) {
      throw new AppError('error.internal.archiveRecoveryFailed', { file: safetyArchivePath }, 500, 'internal');
    }
  }
  throw error;
}

/** Windows refuses a folder rename while anything holds a file in it open (an antivirus scan, say). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/**
 * The staged photos become the uploads folder. The old one is moved aside next
 * to it, not into the work folder that is removed whatever happens, and is
 * deleted only once the new one is in place: if neither the swap nor the move
 * back works, it is the only copy of the photos left.
 */
async function swapUploads(staged: string): Promise<void> {
  const aside = `${config.uploadsDir}-before-restore-${Date.now()}`;
  let movedAside = false;
  try {
    await renameWithRetry(config.uploadsDir, aside);
    movedAside = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await renameWithRetry(staged, config.uploadsDir);
  } catch (error) {
    if (movedAside) {
      await renameWithRetry(aside, config.uploadsDir).catch((moveBack: unknown) =>
        log.error(`The previous photos could not be put back; they are in ${aside}: ${toErrorMessage(moveBack)}`),
      );
    }
    throw error;
  }
  if (movedAside) await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * After the swap failed: the staged folder is the only unpacked copy of the
 * archive's photos, so it is moved beside the uploads folder rather than
 * removed with the work folder. Returns true when it could not be moved and
 * the work folder must be kept instead.
 */
async function keepStagedPhotos(staged: string, error: unknown): Promise<boolean> {
  const kept = `${config.uploadsDir}-restored-${Date.now()}`;
  const where = await renameWithRetry(staged, kept).then(
    () => kept,
    () => staged,
  );
  log.error(
    `Restored the records, but the photos could not be put in place; they are in ${where}: ${toErrorMessage(error)}`,
  );
  return where === staged;
}

/**
 * Restore `file` over this Master. `first-run` needs a Master not yet set up
 * (Magic restore); `replace` needs one that is, and the caller has checked the
 * Server Master and the master key.
 */
export async function restoreArchive(file: string, options: ArchiveRestoreOptions): Promise<ArchiveRestoreResult> {
  const progress = options.progress ?? noProgress;
  progress({ phase: 'checking', done: 0, total: 0 });

  const setUp = await isSetupComplete();
  if (options.mode === 'first-run' && setUp) throw new ConflictError('error.conflict.alreadySetUp');
  if (options.mode === 'replace' && !setUp) throw new ConflictError('error.conflict.notSetUp');

  const { reader, manifest, sizes } = await openArchive(file);
  const workDir = path.join(config.dataDir, 'tmp', `restore-${options.jobId ?? randomUUID()}`);
  const staged = path.join(workDir, 'uploads');
  let inMaintenance = false;
  let cachesReset = false;
  let committed = false;
  let keepWorkDir = false;
  let safetyArchivePath: string | null = null;

  try {
    // 1. Every data entry hashed, every photo unpacked and hashed.
    await fs.mkdir(staged, { recursive: true });
    assertArchiveFits({
      estimatedBytes: sizes.uploadBytes,
      freeBytes: (await freeDiskBytes(workDir)) ?? Number.POSITIVE_INFINITY,
    });

    let done = 0;
    progress({ phase: 'checking', done: 0, total: sizes.dataBytes });
    for (const table of manifest.tables) {
      assertDigest(await reader.hashEntry(tableEntryName(table.name)), table);
      done += table.bytes;
      progress({ done });
    }

    done = 0;
    progress({ phase: 'photos', done: 0, total: sizes.uploadBytes });
    for (const upload of manifest.uploads) {
      const target = safeUploadTarget(staged, upload.path);
      if (!target) throw rejected(upload.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      assertDigest(await extractEntry(reader, upload.path, target), upload);
      done += upload.bytes;
      progress({ done });
    }

    // The shipped photos still being attached on a new install write through
    // the services, which maintenance does not stop: done before the safety
    // copy, so it copies a catalogue nothing is writing to.
    await stopCataloguePhotos();

    // 2. The safety copy, while the current data is still there to copy.
    if (options.mode === 'replace') safetyArchivePath = await writeSafetyArchive();

    // 3. Nobody in, nothing mid-write.
    inMaintenance = true;
    await enterMaintenance();

    // 4. The database, at the archive's level and then upgraded. If this cannot
    // be written the disk is failing or full: better to stop while nothing is lost.
    const marker: RestoreMarker = {
      mode: options.mode,
      safetyArchivePath,
      file: path.basename(file),
      startedAt: new Date().toISOString(),
    };
    await writeDurable(restoreMarkerPath(), Buffer.from(JSON.stringify(marker)));
    try {
      await replayDatabase(reader, manifest, progress);
    } catch (error) {
      await recover(options.mode, safetyArchivePath, error);
    }
    await clearRestoreMarker();

    // From here the restore has happened: the records are the archive's, and
    // at first run this PC now counts as set up, so it cannot be tried again.
    // What follows only completes it, so a failure is logged and the restore
    // still ends as done rather than reported as one that did not happen.
    committed = true;

    // 5. Photos, only now that their rows are committed.
    progress({ phase: 'finishing', done: 0, total: 0 });
    try {
      await swapUploads(staged);
    } catch (error) {
      keepWorkDir = await keepStagedPhotos(staged, error);
    }

    // 6. This PC's address, the tier a pre-1.3 archive lacks, and the caches.
    // The address is refreshed again at every boot.
    await refreshStoredLanIp().catch((error: unknown) =>
      log.error(`Restored, but the LAN address was not refreshed: ${toErrorMessage(error)}`),
    );
    const tenantIds = await listTenantIds().catch((error: unknown) => {
      log.error(`Restored, but the companies could not be listed: ${toErrorMessage(error)}`);
      return [] as string[];
    });
    await db()
      .transaction(async (trx) => {
        for (const tenantId of tenantIds) await ensureServerMasterRole(tenantId, trx);
      })
      .catch((error: unknown) =>
        log.error(`Restored, but the Server Master role was not checked: ${toErrorMessage(error)}`),
      );
    resetProcessCaches();
    cachesReset = true;

    // Detached, into the restored trail, one entry per company: the restore
    // has happened whether or not its entry lands.
    for (const tenantId of tenantIds) {
      await recordDetachedActivity(
        {
          tenantId,
          entityType: 'backup',
          entityId: manifest.createdAt,
          action: 'restored',
          actorType: 'system',
          actorId: null,
          details: { file: path.basename(file), createdAt: manifest.createdAt, appVersion: manifest.appVersion },
        },
        { ...systemActor(tenantId), actorName: options.actor?.actorName ?? 'Master PC' },
        db(),
      );
    }

    log.warn(`Restored ${path.basename(file)} (made ${manifest.createdAt} by ${manifest.appVersion})`);
    return {
      manifest,
      sealed: manifest.sealed ?? { secretSettings: 0, connectorCredentials: 0 },
      safetyArchivePath,
    };
  } catch (error) {
    // A Settings restore that did not complete goes into the trail it left in
    // place (the safety copy, after a failed replay). A first-run restore has
    // no trail to write to, and one that committed did complete.
    if (options.mode === 'replace' && !committed) {
      const tenantIds = await listTenantIds().catch(() => [] as string[]);
      for (const tenantId of tenantIds) {
        await recordDetachedActivity(
          {
            tenantId,
            entityType: 'backup',
            entityId: manifest.createdAt,
            action: 'restore_failed',
            actorType: 'system',
            actorId: null,
            details: { file: path.basename(file) },
          },
          { ...systemActor(tenantId), actorName: options.actor?.actorName ?? 'Master PC' },
          db(),
        );
      }
    }
    throw error;
  } finally {
    reader.close();
    // Whatever the database holds now, no cache may describe the old one.
    if (inMaintenance && !cachesReset) resetProcessCaches();
    if (inMaintenance) {
      leaveMaintenance();
      // The reset cancelled every panel's "offline for an hour" timer, on a
      // failed restore as well; the Offices were disconnected, so re-arm them.
      void scheduleLongOfflineNoticesAtBoot().catch((error: unknown) =>
        log.warn(`Could not schedule the long-offline notices: ${toErrorMessage(error)}`),
      );
    }
    if (!keepWorkDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
