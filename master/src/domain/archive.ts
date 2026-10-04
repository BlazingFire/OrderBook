/**
 * Pure rules for the plain-zip "backup all" archive, format version 2
 * (`docs/7-STORAGE-BACKUP-RESTORE.md`). No I/O: the zip itself is
 * `lib/archive-zip.ts`, the rows are `repositories/backup.repository.ts`.
 *
 * An archive is read from a drive somebody plugged in, so everything here
 * treats it as hostile until checked: only four kinds of entry name are
 * honoured, an upload path can never climb out of the folder it is unpacked
 * into, and every entry's size must match what the manifest says before a
 * single byte is written anywhere.
 */

import path from 'node:path';

import { ARCHIVE_FORMAT_VERSION, type ArchiveManifest } from '@orderbook/shared';

import { BackupError } from '../lib/errors.js';

export const MANIFEST_ENTRY = 'manifest.json';
export const README_ENTRY = 'README.txt';

const MIB = 1024 * 1024;

/** Read into memory whole, so capped. A manifest listing a large photo library is a few MB. */
export const MAX_MANIFEST_BYTES = 32 * MIB;
export const MAX_README_BYTES = 64 * 1024;
/**
 * Entries in one archive. Each upload costs the manifest about a hundred bytes,
 * so a manifest under its cap lists fewer than this; a zip with more is not
 * one this app wrote, and is refused before its entry list fills memory.
 */
export const MAX_ARCHIVE_ENTRIES = 500_000;
/** One photo or avatar. Real ones are well under a few MB; this only stops a lie. */
export const MAX_UPLOAD_ENTRY_BYTES = 256 * MIB;

/** FAT32 holds no file of 4 GiB or more; the margin covers the zip's own headers. */
export const FAT32_MAX_ARCHIVE_BYTES = 4 * 1024 * MIB - 64 * MIB;
/**
 * The estimate is a guess, so the drive must have a tenth more than it. In
 * integers, so 100 MB needs exactly 110 MB rather than a float's hair more.
 */
function withMargin(bytes: number): number {
  return Math.ceil((bytes * 11) / 10);
}

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** Characters Windows refuses in a file name, plus every control character. */
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT_CHARS = /[<>:"|?*\\\u0000-\u001f]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type ArchiveEntryKind =
  | { kind: 'manifest' }
  | { kind: 'readme' }
  | { kind: 'table'; table: string }
  | { kind: 'upload' };

export function tableEntryName(table: string): string {
  return `data/${table}.ndjson`;
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !BAD_SEGMENT_CHARS.test(segment) &&
    // Windows drops a trailing dot or space, so `a.` and `a` would be one file.
    !/[. ]$/.test(segment) &&
    !WINDOWS_DEVICE.test(segment)
  );
}

/**
 * What an entry name is, or `null` when it is not one the archive may hold.
 *
 * The allowlist: `manifest.json`, `README.txt`, `data/<table>.ndjson` and
 * `uploads/**`. Absolute names, drive letters, backslashes, `.` and `..`
 * segments, empty segments and directory entries are all refused, whatever
 * the zip library already checked.
 */
export function classifyArchiveEntry(name: string): ArchiveEntryKind | null {
  if (name === MANIFEST_ENTRY) return { kind: 'manifest' };
  if (name === README_ENTRY) return { kind: 'readme' };

  const data = /^data\/([^/]+)\.ndjson$/.exec(name);
  if (data) return TABLE_NAME.test(data[1]!) ? { kind: 'table', table: data[1]! } : null;

  if (!name.startsWith('uploads/')) return null;
  const segments = name.slice('uploads/'.length).split('/');
  return segments.every(isSafeSegment) ? { kind: 'upload' } : null;
}

/**
 * Where an `uploads/**` entry lands under `stagingDir`, or `null` when it
 * would land anywhere else. `classifyArchiveEntry` already refuses every
 * climbing name; this resolves the real path and checks again, so a rule
 * missed there still cannot write outside the folder.
 */
export function safeUploadTarget(stagingDir: string, entryName: string): string | null {
  if (classifyArchiveEntry(entryName)?.kind !== 'upload') return null;
  const root = path.resolve(stagingDir);
  const target = path.resolve(root, ...entryName.slice('uploads/'.length).split('/'));
  return target.startsWith(root + path.sep) ? target : null;
}

function rejected(entry: string): BackupError {
  return new BackupError('entryRejected', 'error.validation.archiveEntryRejected', { entry });
}

function notAnArchive(): BackupError {
  return new BackupError('notAnArchive', 'error.validation.archiveNotAnArchive');
}

function newerThanApp(fileAppVersion: string): BackupError {
  return new BackupError('newerThanApp', 'error.validation.backupFormatTooNew', { fileAppVersion });
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * `manifest.json` as text, checked field by field. Anything that is not a
 * version-2 manifest is `notAnArchive`, except a higher format version, which
 * is `newerThanApp` so the screen can say "update first" instead of "wrong file".
 */
export function parseArchiveManifest(text: string): ArchiveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw notAnArchive();
  }
  if (typeof raw !== 'object' || raw === null) throw notAnArchive();
  const value = raw as Record<string, unknown>;

  if (!isCount(value.formatVersion)) throw notAnArchive();
  if (value.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw newerThanApp(isString(value.appVersion) ? value.appVersion : '?');
  }
  if (value.formatVersion !== ARCHIVE_FORMAT_VERSION) throw notAnArchive();

  const { appVersion, createdAt, company, masterUniqueId, appliedMigrations, tables, uploads, sealed } = value;
  if (![appVersion, createdAt, company, masterUniqueId].every(isString)) throw notAnArchive();
  if (!Array.isArray(appliedMigrations) || !appliedMigrations.every(isString)) throw notAnArchive();
  if (!Array.isArray(tables) || !Array.isArray(uploads)) throw notAnArchive();

  const seenTables = new Set<string>();
  for (const table of tables as unknown[]) {
    const entry = table as Record<string, unknown> | null;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !isString(entry.name) ||
      !isCount(entry.rows) ||
      !isCount(entry.bytes) ||
      !isString(entry.sha256) ||
      !SHA256.test(entry.sha256)
    ) {
      throw notAnArchive();
    }
    if (!TABLE_NAME.test(entry.name) || seenTables.has(entry.name)) throw rejected(tableEntryName(entry.name));
    seenTables.add(entry.name);
  }

  const seenUploads = new Set<string>();
  for (const upload of uploads as unknown[]) {
    const entry = upload as Record<string, unknown> | null;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !isString(entry.path) ||
      !isCount(entry.bytes) ||
      !isString(entry.sha256) ||
      !SHA256.test(entry.sha256)
    ) {
      throw notAnArchive();
    }
    // Case-folded: Windows would write `A.webp` and `a.webp` to one file.
    const folded = entry.path.toLowerCase();
    if (classifyArchiveEntry(entry.path)?.kind !== 'upload' || seenUploads.has(folded)) throw rejected(entry.path);
    if (entry.bytes > MAX_UPLOAD_ENTRY_BYTES) throw rejected(entry.path);
    seenUploads.add(folded);
  }

  if (sealed !== undefined) {
    const counts = sealed as Record<string, unknown> | null;
    if (typeof counts !== 'object' || counts === null) throw notAnArchive();
    if (!isCount(counts.secretSettings) || !isCount(counts.connectorCredentials)) throw notAnArchive();
  }

  return value as unknown as ArchiveManifest;
}

/**
 * Refuses an archive this build cannot replay: one naming a migration it does
 * not ship was made by a newer version, and its rows belong to a schema this
 * build cannot produce.
 */
export function assertArchiveRestorable(manifest: ArchiveManifest, knownMigrations: readonly string[]): void {
  const known = new Set(knownMigrations);
  if (manifest.appliedMigrations.some((name) => !known.has(name))) throw newerThanApp(manifest.appVersion);
}

export interface ArchiveSizes {
  /** Every entry, uncompressed: what reading the whole archive produces. */
  totalBytes: number;
  /** `data/*`: what the database load reads. */
  dataBytes: number;
  /** `uploads/**`: what is unpacked to disk. */
  uploadBytes: number;
}

/**
 * Checks the zip's own entry list against the manifest, before anything is
 * read: every entry is on the allowlist and appears once, every data and
 * upload entry is the size the manifest says, and nothing the manifest lists
 * is missing. `bytes` is the uncompressed size from the zip's central
 * directory, which the reader also enforces while streaming.
 */
export function checkArchiveEntries(
  manifest: ArchiveManifest,
  entries: ReadonlyArray<{ name: string; bytes: number }>,
): ArchiveSizes {
  const tables = new Map(manifest.tables.map((table) => [tableEntryName(table.name), table.bytes]));
  const uploads = new Map(manifest.uploads.map((upload) => [upload.path, upload.bytes]));

  const seen = new Set<string>();
  const sizes: ArchiveSizes = { totalBytes: 0, dataBytes: 0, uploadBytes: 0 };

  for (const { name, bytes } of entries) {
    const kind = classifyArchiveEntry(name);
    const folded = name.toLowerCase();
    if (!kind || seen.has(folded)) throw rejected(name);
    seen.add(folded);

    switch (kind.kind) {
      case 'manifest':
        if (bytes > MAX_MANIFEST_BYTES) throw rejected(name);
        break;
      case 'readme':
        if (bytes > MAX_README_BYTES) throw rejected(name);
        break;
      case 'table':
        if (tables.get(name) !== bytes) throw rejected(name);
        sizes.dataBytes += bytes;
        break;
      case 'upload':
        if (uploads.get(name) !== bytes) throw rejected(name);
        sizes.uploadBytes += bytes;
        break;
    }
    sizes.totalBytes += bytes;
  }

  const missing = [MANIFEST_ENTRY, ...tables.keys(), ...uploads.keys()].find(
    (name) => !seen.has(name.toLowerCase()),
  );
  if (missing) throw new BackupError('corrupt_file', 'error.validation.backupCorruptFile');

  return sizes;
}

/**
 * How big an archive will be, before it is written: each table's row count
 * times its average row size, plus the photos. Uncompressed, so it errs large,
 * which is the safe side for a free-space check.
 */
export function estimateArchiveBytes(
  tables: ReadonlyArray<{ rows: number; averageRowBytes: number }>,
  uploadBytes: number,
): number {
  return Math.ceil(tables.reduce((sum, table) => sum + table.rows * table.averageRowBytes, 0) + uploadBytes);
}

/**
 * Refuses a backup the target drive cannot hold, before anything is written:
 * one over FAT32's file-size limit (`fileSystem` as Windows names it, `FAT32`
 * or `FAT`), and one larger than the free space allows. FAT32 first, because
 * "format the drive as exFAT" is the advice that actually helps there.
 */
export function assertArchiveFits(target: {
  estimatedBytes: number;
  freeBytes: number;
  fileSystem?: string | null;
}): void {
  const neededMb = Math.ceil(target.estimatedBytes / MIB);

  if (target.fileSystem && /^fat(32)?$/i.test(target.fileSystem.trim())) {
    if (target.estimatedBytes > FAT32_MAX_ARCHIVE_BYTES) {
      throw new BackupError('fat32TooLarge', 'error.validation.backupFat32TooLarge', { neededMb });
    }
  }

  const needed = withMargin(target.estimatedBytes);
  if (needed > target.freeBytes) {
    throw new BackupError('insufficientSpace', 'error.validation.backupInsufficientSpace', {
      neededMb: Math.ceil(needed / MIB),
      freeMb: Math.floor(target.freeBytes / MIB),
    });
  }
}

/**
 * The company name as it goes into a file name: ASCII letters and digits,
 * dashes between words, at most 40 characters, `company` when nothing is left
 * (a name written only in non-Latin letters, say).
 */
export function companySlug(name: string | null | undefined): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'company';
}

/** `OrderBook-Backup-<company>-<yyyy-mm-dd-hhmm>.zip`, the minute read in the business time zone. */
export function archiveFileName(company: string | null | undefined, at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const stamp = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
  return `OrderBook-Backup-${companySlug(company)}-${stamp}.zip`;
}
