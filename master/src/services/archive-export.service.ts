/**
 * "Back up everything": one plain zip of every table and every photo, written
 * to a folder the owner picks, usually a USB drive
 * (`docs/7-STORAGE-BACKUP-RESTORE.md`). The format is in `shared/src/protocol/backup.ts`
 * and its rules in `domain/archive.ts`; `archive-restore.service.ts` reads it back.
 *
 * The order is what makes the file trustworthy:
 *
 *  1. **Pre-flight, before a byte is written.** The size is estimated from the
 *     tables and the photos and checked against the drive: a FAT32 drive cannot
 *     hold a file over 4 GiB, and a drive without a tenth more room than the
 *     estimate is refused.
 *  2. **One snapshot.** Every table is read inside a REPEATABLE READ READ ONLY
 *     transaction, so people keep working and the archive is still one moment.
 *     Photos are listed after the snapshot starts: a photo's files are written
 *     before its row, so every row the snapshot sees has its files on disk.
 *     They are copied after it ends, so it holds no table lock meanwhile.
 *  3. **Streamed.** Each table goes out in keyset pages as Postgres renders the
 *     rows, one page in memory at a time, and each photo straight from its file.
 *  4. **Verified, then named.** The zip is written as `<name>.partial`, opened
 *     again and every entry re-hashed against the manifest, and only then
 *     renamed. A half-written or unreadable file never carries the real name.
 *
 * Never in the archive: the password vault, the Master's clock row, the Knex
 * bookkeeping tables (`backup.repository.ts#isExcludedTable`), and anything
 * under `secrets/`, which this file never reads.
 */

import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ARCHIVE_FORMAT_VERSION,
  type ArchiveManifest,
  type ArchiveTableEntry,
  type ArchiveUploadEntry,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import {
  MANIFEST_ENTRY,
  MAX_MANIFEST_BYTES,
  MAX_UPLOAD_ENTRY_BYTES,
  README_ENTRY,
  archiveFileName,
  assertArchiveFits,
  checkArchiveEntries,
  classifyArchiveEntry,
  estimateArchiveBytes,
  parseArchiveManifest,
  tableEntryName,
} from '../domain/archive.js';
import { appVersion } from '../lib/app-version.js';
import { createZipWriter, type EntryDigest, type ZipReader, type ZipWriter, openZipReader } from '../lib/archive-zip.js';
import { syncFile } from '../lib/durable-file.js';
import { BackupError, ConflictError, ValidationError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import {
  appliedMigrationNames,
  countSealedRows,
  isExcludedTable,
  listUserTables,
  streamTableNdjson,
} from '../repositories/backup.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import type { JobProgress } from './backup-job.js';
import { getIdentity } from './setup.service.js';
import { freeDiskBytes, volumeFileSystem } from './storage.service.js';

const log = createLogger('archive-export');

/** For whoever finds the drive. Plain text and English, like the file names. */
const README_TEXT = [
  'OrderBook backup',
  '',
  'This file is a complete backup of one OrderBook Master Panel: every record',
  'and every product photo, as they were at the moment it was made.',
  '',
  'Keep this drive safe. The backup is not encrypted. It holds the company\'s',
  'parties, orders and users, including the users\' password hashes.',
  '',
  'To restore it on a new Master PC: install OrderBook, and on the first-run',
  'screen choose "Magic restore" and pick this file. People then sign in with',
  'their usual usernames and passwords, and Office panels reconnect by themselves.',
  'Integration keys and other secret settings must be entered again.',
  '',
  'Do not unpack, edit or rename the files inside: every one is checked against',
  'manifest.json before anything is restored, and a changed file is refused.',
  '',
].join('\r\n');

export interface ArchiveExportOptions {
  /** The folder the archive is written to. It must exist. */
  folder: string;
  /** Instead of `OrderBook-Backup-<company>-<date>.zip`: the restore's safety copy. */
  fileName?: string;
  /** False for a data-only archive (the restore's safety copy). Default true. */
  includeUploads?: boolean;
  /** False to write no `backup.created` entry (the restore's safety copy). Default true. */
  audit?: boolean;
  /** Who asked; the Master PC itself when absent (the scheduler). */
  actor?: ActorContext;
  progress?: (progress: JobProgress) => void;
  /** Rows per keyset page; tests make it small. */
  pageSize?: number;
}

export interface ArchiveExportResult {
  fileName: string;
  path: string;
  bytes: number;
  tables: number;
  rows: number;
  uploads: number;
}

interface UploadFile {
  absolute: string;
  /** The entry name, `uploads/...` with forward slashes. */
  name: string;
  bytes: number;
}

const noProgress = (): void => undefined;

function corrupt(): BackupError {
  return new BackupError('corrupt_file', 'error.validation.backupCorruptFile');
}

/** `digest` against what the manifest says the entry holds. */
export function assertDigest(digest: EntryDigest, expected: { bytes: number; sha256: string }): void {
  if (digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256) throw corrupt();
}

/**
 * Re-read every data and upload entry and compare it with the manifest.
 * `onBytes` is told how many uncompressed bytes each entry held, for progress.
 */
export async function verifyArchiveEntries(
  reader: ZipReader,
  manifest: ArchiveManifest,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const expected = [
    ...manifest.tables.map((table) => ({ name: tableEntryName(table.name), bytes: table.bytes, sha256: table.sha256 })),
    ...manifest.uploads.map((upload) => ({ name: upload.path, bytes: upload.bytes, sha256: upload.sha256 })),
  ];
  for (const entry of expected) {
    assertDigest(await reader.hashEntry(entry.name), entry);
    onBytes(entry.bytes);
  }
}

async function assertFolder(folder: string): Promise<void> {
  const stats = await fs.stat(folder).catch(() => null);
  if (!stats?.isDirectory()) throw new ValidationError('error.validation.backupFolderMissing', { folder });
}

/**
 * Every file under the uploads folder, as archive entries, sorted. A file whose
 * name the archive could not hold (a Windows-invalid name, a stray file over
 * the per-photo cap) is left out and logged rather than failing the backup.
 */
async function listUploads(): Promise<UploadFile[]> {
  const found: UploadFile[] = [];
  const walk = async (dir: string, relative: string[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const parts = [...relative, entry.name];
      if (entry.isDirectory()) {
        await walk(absolute, parts);
      } else if (entry.isFile()) {
        const name = `uploads/${parts.join('/')}`;
        const size = (await fs.stat(absolute).catch(() => null))?.size;
        if (size === undefined) continue;
        if (classifyArchiveEntry(name)?.kind !== 'upload' || size > MAX_UPLOAD_ENTRY_BYTES) {
          log.warn(`Left out of the backup: ${name} (${size} bytes)`);
          continue;
        }
        found.push({ absolute, name, bytes: size });
      }
    }
  };
  await walk(config.uploadsDir, []);
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Row count and on-disk size of each table, inside the snapshot. The first query, so it fixes the snapshot. */
async function tableSizes(
  trx: TransactionContext,
  tables: readonly string[],
): Promise<Array<{ name: string; rows: number; bytes: number }>> {
  const sizes = [];
  for (const name of tables) {
    const { rows } = await trx.raw<{ rows: Array<{ rows: string; bytes: string }> }>(
      'SELECT count(*)::text AS rows, pg_table_size(?::regclass)::text AS bytes FROM ??',
      [`public."${name}"`, name],
    );
    sizes.push({ name, rows: Number(rows[0]?.rows ?? 0), bytes: Number(rows[0]?.bytes ?? 0) });
  }
  return sizes;
}

/**
 * One table as `data/<table>.ndjson`, streamed from the snapshot. A page is
 * written only as fast as the zip takes it, so memory stays at one page.
 */
async function writeTable(
  writer: ZipWriter,
  trx: TransactionContext,
  table: string,
  pageSize: number | undefined,
  onRow: () => void,
): Promise<ArchiveTableEntry> {
  const body = new PassThrough();
  const written = writer.appendEntry(tableEntryName(table), body);
  // A zip that fails mid-table fails the body too, so a wait for `drain` below
  // ends with the error instead of never.
  written.catch((error: unknown) => body.destroy(error instanceof Error ? error : new Error(String(error))));
  let rows: number;
  try {
    rows = await streamTableNdjson(
      table,
      async (json) => {
        // Already failed: rethrow the zip's own error rather than write to a dead stream.
        if (body.destroyed) await written;
        if (!body.write(`${json}\n`)) await once(body, 'drain');
        onRow();
      },
      { runner: trx, pageSize },
    );
    body.end();
  } catch (error) {
    body.destroy(error instanceof Error ? error : new Error(String(error)));
    await written.catch(() => undefined);
    throw error;
  }
  const digest = await written;
  return { name: table, rows, bytes: digest.bytes, sha256: digest.sha256 };
}

/**
 * Write a verified archive to `options.folder` and return where it is.
 * Throws before writing anything when the drive is missing, too small or FAT32
 * with too much to hold; removes its `.partial` on any later failure.
 */
export async function exportArchive(options: ArchiveExportOptions): Promise<ArchiveExportResult> {
  const progress = options.progress ?? noProgress;
  progress({ phase: 'preparing', done: 0, total: 0 });

  const identity = await getIdentity();
  if (!identity) throw new ConflictError('error.conflict.notSetUp');

  const folder = path.resolve(options.folder);
  await assertFolder(folder);
  const fileName = options.fileName ?? archiveFileName(identity.companyName, new Date(), config.locale.timeZone);
  const finalPath = path.join(folder, fileName);
  const partialPath = `${finalPath}.partial`;
  const [freeBytes, fileSystem] = await Promise.all([freeDiskBytes(folder), volumeFileSystem(folder)]);
  const actor = options.actor ?? { ...systemActor(identity.tenantId), actorName: 'Master PC' };

  let manifest: ArchiveManifest;
  let archiveBytes: number;
  let started = false;
  try {
    const snapshot = await db().transaction(async (trx) => {
      await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

      const tables = (await listUserTables(trx)).filter((table) => !isExcludedTable(table));
      const sizes = await tableSizes(trx, tables);
      // The moment the snapshot was taken, which is what the archive shows.
      const createdAt = new Date().toISOString();
      const uploads = options.includeUploads === false ? [] : await listUploads();
      const uploadBytes = uploads.reduce((sum, file) => sum + file.bytes, 0);

      assertArchiveFits({
        estimatedBytes: estimateArchiveBytes(
          sizes.map((table) => ({ rows: table.rows, averageRowBytes: table.rows > 0 ? table.bytes / table.rows : 0 })),
          uploadBytes,
        ),
        // Unknown free space (a network share) is not a reason to refuse.
        freeBytes: freeBytes ?? Number.POSITIVE_INFINITY,
        fileSystem,
      });

      started = true;
      const writer = createZipWriter(partialPath);
      try {
        await writer.appendEntry(README_ENTRY, [README_TEXT]);

        const totalRows = sizes.reduce((sum, table) => sum + table.rows, 0);
        let rowsDone = 0;
        progress({ phase: 'data', done: 0, total: totalRows });
        const tableEntries: ArchiveTableEntry[] = [];
        for (const table of tables) {
          tableEntries.push(
            await writeTable(writer, trx, table, options.pageSize, () => {
              rowsDone += 1;
              progress({ done: rowsDone });
            }),
          );
        }

        return {
          writer,
          createdAt,
          uploads,
          uploadBytes,
          tableEntries,
          appliedMigrations: await appliedMigrationNames(trx),
          sealed: await countSealedRows(trx),
        };
      } catch (error) {
        writer.abort();
        throw error;
      }
    });

    // The photos come from disk, not the database, so the snapshot ends first:
    // it holds a lock on every table, and a TRUNCATE or DROP queued behind it
    // would stall every other query for as long as the copy to a slow drive.
    const { writer, uploads } = snapshot;
    try {
      progress({ phase: 'photos', done: 0, total: snapshot.uploadBytes });
      let photoBytes = 0;
      const uploadEntries: ArchiveUploadEntry[] = [];
      for (const file of uploads) {
        // Deleted since the listing: its row went with it, after the snapshot.
        if (!(await fs.stat(file.absolute).catch(() => null))) continue;
        const digest = await writer.appendEntry(file.name, createReadStream(file.absolute), { store: true });
        uploadEntries.push({ path: file.name, bytes: digest.bytes, sha256: digest.sha256 });
        photoBytes += digest.bytes;
        progress({ done: photoBytes });
      }

      manifest = {
        formatVersion: ARCHIVE_FORMAT_VERSION,
        appVersion: appVersion(),
        createdAt: snapshot.createdAt,
        company: identity.companyName ?? '',
        masterUniqueId: identity.masterUniqueId,
        appliedMigrations: snapshot.appliedMigrations,
        tables: snapshot.tableEntries,
        uploads: uploadEntries,
        sealed: snapshot.sealed,
      };
      await writer.appendEntry(MANIFEST_ENTRY, [JSON.stringify(manifest, null, 2)]);
      archiveBytes = await writer.finalize();
    } catch (error) {
      writer.abort();
      throw error;
    }

    const totalBytes =
      manifest.tables.reduce((sum, table) => sum + table.bytes, 0) +
      manifest.uploads.reduce((sum, upload) => sum + upload.bytes, 0);
    let verified = 0;
    progress({ phase: 'verifying', done: 0, total: totalBytes });
    const reader = await openZipReader(partialPath);
    try {
      checkArchiveEntries(manifest, reader.entries);
      parseArchiveManifest(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST_BYTES));
      await verifyArchiveEntries(reader, manifest, (bytes) => {
        verified += bytes;
        progress({ done: verified });
      });
    } finally {
      reader.close();
    }

    // The safety copy a restore relies on, and a USB drive pulled out straight
    // after. Best effort: some network drives refuse this, and that must not fail a good backup.
    await syncFile(partialPath).catch((error: unknown) =>
      log.warn(`Could not flush ${partialPath} to disk: ${toErrorMessage(error)}`),
    );
    await fs.rename(partialPath, finalPath);
  } catch (error) {
    // Retried: on Windows the aborted file's handle may still be closing.
    if (started) await fs.rm(partialPath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    // Detached (it swallows its own failure), so the error below is still the
    // one the caller sees.
    if (options.audit !== false) {
      await recordDetachedActivity(
        {
          tenantId: actor.tenantId,
          entityType: 'backup',
          entityId: fileName,
          action: 'failed',
          actorType: actor.actorType,
          actorId: actor.actorId,
          details: { file: fileName },
        },
        actor,
        db(),
      );
    }
    throw error;
  }

  const rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
  progress({ fileName, path: finalPath });
  log.info(`Backed up ${rows} rows and ${manifest.uploads.length} files to ${finalPath} (${archiveBytes} bytes)`);

  if (options.audit !== false) {
    // Detached: the archive exists and is verified whether or not its entry lands.
    await recordDetachedActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'backup',
        entityId: fileName,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { file: fileName, bytes: archiveBytes, tables: manifest.tables.length },
      },
      actor,
      db(),
    );
  }

  return {
    fileName,
    path: finalPath,
    bytes: archiveBytes,
    tables: manifest.tables.length,
    rows,
    uploads: manifest.uploads.length,
  };
}
