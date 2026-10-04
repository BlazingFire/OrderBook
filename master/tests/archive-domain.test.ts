/**
 * The plain-zip "backup all" archive: the pure rules in `domain/archive.ts`
 * (entry allowlist, path traversal, size caps against the manifest, the size
 * estimate and the drive pre-flight) and one round trip through
 * `lib/archive-zip.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import archiver from 'archiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ARCHIVE_FORMAT_VERSION, type ArchiveManifest } from '@orderbook/shared';

import {
  FAT32_MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_MANIFEST_BYTES,
  archiveFileName,
  assertArchiveFits,
  assertArchiveRestorable,
  checkArchiveEntries,
  classifyArchiveEntry,
  companySlug,
  estimateArchiveBytes,
  parseArchiveManifest,
  safeUploadTarget,
} from '../src/domain/archive.js';
import { createZipWriter, openZipReader } from '../src/lib/archive-zip.js';
import { BackupError } from '../src/lib/errors.js';

const HASH = 'a'.repeat(64);
const MIB = 1024 * 1024;

function manifest(overrides: Partial<ArchiveManifest> = {}): ArchiveManifest {
  return {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    appVersion: '1.3.0',
    createdAt: '2026-10-03T12:00:00.000Z',
    company: 'Shree Ceramics',
    masterUniqueId: 'M-1',
    appliedMigrations: ['20260101000000_initial_schema'],
    tables: [{ name: 'parties', rows: 2, bytes: 40, sha256: HASH }],
    uploads: [{ path: 'uploads/images/t1/IM1/thumb.webp', bytes: 10, sha256: HASH }],
    ...overrides,
  };
}

function reason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof BackupError ? error.reason : `not a BackupError: ${String(error)}`;
  }
  return undefined;
}

describe('classifyArchiveEntry: the allowlist', () => {
  it('honours the four kinds of entry', () => {
    expect(classifyArchiveEntry('manifest.json')).toEqual({ kind: 'manifest' });
    expect(classifyArchiveEntry('README.txt')).toEqual({ kind: 'readme' });
    expect(classifyArchiveEntry('data/parties.ndjson')).toEqual({ kind: 'table', table: 'parties' });
    expect(classifyArchiveEntry('uploads/images/t1/IM1/thumb.webp')).toEqual({ kind: 'upload' });
    expect(classifyArchiveEntry('uploads/avatars/US1.webp')).toEqual({ kind: 'upload' });
  });

  it.each([
    'secrets/vault.key',
    'other.txt',
    'data/Parties.ndjson',
    'data/a.b.ndjson',
    'data/sub/parties.ndjson',
    'data/parties.json',
    'uploads/',
    'uploads/images/',
    'uploads//x.webp',
    'uploads/../secrets/vault.key',
    'uploads/images/../../evil.txt',
    'uploads/./x.webp',
    '/uploads/x.webp',
    'C:/uploads/x.webp',
    'uploads/C:x.webp',
    'uploads\\x.webp',
    'uploads/x.webp.',
    'uploads/x ',
    'uploads/nul.webp',
    'uploads/x\u0000.webp',
  ])('refuses %j', (name) => {
    expect(classifyArchiveEntry(name)).toBeNull();
  });
});

describe('safeUploadTarget', () => {
  const staging = path.resolve(tmpdir(), 'restore-job', 'uploads');

  it('resolves an upload inside the staging folder', () => {
    expect(safeUploadTarget(staging, 'uploads/images/t1/a.webp')).toBe(path.join(staging, 'images', 't1', 'a.webp'));
  });

  it.each(['uploads/../evil.txt', 'uploads/../../evil.txt', 'data/parties.ndjson', 'C:/evil.txt', '/etc/passwd'])(
    'refuses %j',
    (name) => {
      expect(safeUploadTarget(staging, name)).toBeNull();
    },
  );
});

describe('parseArchiveManifest', () => {
  it('reads a version-2 manifest', () => {
    expect(parseArchiveManifest(JSON.stringify(manifest()))).toEqual(manifest());
  });

  it('refuses what is not a manifest as notAnArchive', () => {
    for (const text of ['not json', '[]', 'null', JSON.stringify({ formatVersion: 1 })]) {
      expect(reason(() => parseArchiveManifest(text))).toBe('notAnArchive');
    }
    expect(reason(() => parseArchiveManifest(JSON.stringify({ ...manifest(), tables: [{ name: 'x' }] })))).toBe(
      'notAnArchive',
    );
  });

  it('refuses a higher format version as newerThanApp', () => {
    expect(reason(() => parseArchiveManifest(JSON.stringify(manifest({ formatVersion: 3 }))))).toBe('newerThanApp');
  });

  it('refuses a climbing, duplicate or oversized upload, and a bad table name', () => {
    const upload = { path: 'uploads/a.webp', bytes: 1, sha256: HASH };
    const bad: Array<Partial<ArchiveManifest>> = [
      { uploads: [{ ...upload, path: 'uploads/../evil.txt' }] },
      { uploads: [upload, { ...upload, path: 'uploads/A.webp' }] },
      { uploads: [{ ...upload, bytes: 300 * MIB }] },
      { tables: [{ name: 'user-table', rows: 0, bytes: 0, sha256: HASH }] },
    ];
    for (const overrides of bad) {
      expect(reason(() => parseArchiveManifest(JSON.stringify(manifest(overrides))))).toBe('entryRejected');
    }
  });
});

describe('assertArchiveRestorable', () => {
  it('accepts an archive whose migrations this build ships, and refuses one naming another', () => {
    const known = ['20260101000000_initial_schema', '20261007000000_backup_all_permission_grant'];
    expect(reason(() => assertArchiveRestorable(manifest(), known))).toBeUndefined();
    const newer = manifest({ appliedMigrations: [...known, '20271231000000_from_the_future'] });
    expect(reason(() => assertArchiveRestorable(newer, known))).toBe('newerThanApp');
  });
});

describe('checkArchiveEntries: sizes against the manifest', () => {
  const entries = [
    { name: 'manifest.json', bytes: 500 },
    { name: 'README.txt', bytes: 300 },
    { name: 'data/parties.ndjson', bytes: 40 },
    { name: 'uploads/images/t1/IM1/thumb.webp', bytes: 10 },
  ];

  it('totals an archive that matches its manifest', () => {
    expect(checkArchiveEntries(manifest(), entries)).toEqual({ totalBytes: 850, dataBytes: 40, uploadBytes: 10 });
  });

  it('refuses an entry the manifest does not list, or of another size', () => {
    expect(reason(() => checkArchiveEntries(manifest(), [...entries, { name: 'uploads/extra.webp', bytes: 1 }]))).toBe(
      'entryRejected',
    );
    expect(reason(() => checkArchiveEntries(manifest(), [...entries, { name: 'data/users.ndjson', bytes: 1 }]))).toBe(
      'entryRejected',
    );
    const inflated = entries.map((entry) => (entry.name.startsWith('data/') ? { ...entry, bytes: 4 * MIB } : entry));
    expect(reason(() => checkArchiveEntries(manifest(), inflated))).toBe('entryRejected');
  });

  it('refuses an oversized manifest, a duplicate and a name off the allowlist', () => {
    const big = entries.map((entry) => (entry.name === 'manifest.json' ? { ...entry, bytes: MAX_MANIFEST_BYTES + 1 } : entry));
    expect(reason(() => checkArchiveEntries(manifest(), big))).toBe('entryRejected');
    expect(reason(() => checkArchiveEntries(manifest(), [...entries, entries[2]!]))).toBe('entryRejected');
    expect(reason(() => checkArchiveEntries(manifest(), [...entries, { name: 'secrets/vault.key', bytes: 32 }]))).toBe(
      'entryRejected',
    );
  });

  it('calls an archive missing a listed file corrupt', () => {
    expect(reason(() => checkArchiveEntries(manifest(), entries.slice(0, 3)))).toBe('corrupt_file');
    expect(reason(() => checkArchiveEntries(manifest(), entries.slice(1)))).toBe('corrupt_file');
  });
});

describe('estimate and drive pre-flight', () => {
  it('estimates rows times average row size, plus the photos', () => {
    expect(estimateArchiveBytes([{ rows: 1000, averageRowBytes: 250.5 }, { rows: 0, averageRowBytes: 90 }], 5000)).toBe(
      255_500,
    );
  });

  it('refuses a backup over the FAT32 limit on a FAT32 drive only', () => {
    const big = { estimatedBytes: FAT32_MAX_ARCHIVE_BYTES + 1, freeBytes: 64 * 1024 * MIB };
    expect(reason(() => assertArchiveFits({ ...big, fileSystem: 'FAT32' }))).toBe('fat32TooLarge');
    expect(reason(() => assertArchiveFits({ ...big, fileSystem: 'FAT' }))).toBe('fat32TooLarge');
    expect(reason(() => assertArchiveFits({ ...big, fileSystem: 'exFAT' }))).toBeUndefined();
    expect(reason(() => assertArchiveFits({ ...big, fileSystem: 'NTFS' }))).toBeUndefined();
    expect(reason(() => assertArchiveFits({ ...big, fileSystem: 'FAT32', estimatedBytes: FAT32_MAX_ARCHIVE_BYTES }))).toBeUndefined();
  });

  it('wants a tenth more free space than the estimate', () => {
    expect(reason(() => assertArchiveFits({ estimatedBytes: 100 * MIB, freeBytes: 110 * MIB }))).toBeUndefined();
    expect(reason(() => assertArchiveFits({ estimatedBytes: 100 * MIB, freeBytes: 109 * MIB }))).toBe('insufficientSpace');
  });
});

describe('the archive file name', () => {
  it('keeps ASCII words of the company name, dash-separated, and falls back to company', () => {
    expect(companySlug('Shree Ceramics & Tiles Pvt. Ltd.')).toBe('Shree-Ceramics-Tiles-Pvt-Ltd');
    expect(companySlug('  --  ')).toBe('company');
    expect(companySlug('株式会社')).toBe('company');
    expect(companySlug(null)).toBe('company');
    expect(companySlug('A'.repeat(39) + ' B')).toBe('A'.repeat(39));
  });

  it('stamps the minute in the business time zone, not the PC clock', () => {
    // 18:45 UTC is 00:15 the next day in India.
    const at = new Date('2026-10-03T18:45:30Z');
    expect(archiveFileName('Shree Ceramics', at, 'Asia/Kolkata')).toBe(
      'OrderBook-Backup-Shree-Ceramics-2026-10-04-0015.zip',
    );
    expect(archiveFileName('Shree Ceramics', at, 'UTC')).toBe('OrderBook-Backup-Shree-Ceramics-2026-10-03-1845.zip');
    // Every name is one the archive allowlist and Windows both accept.
    expect(classifyArchiveEntry(`uploads/${archiveFileName('x', at, 'UTC')}`)).toEqual({ kind: 'upload' });
  });
});

describe('archive-zip: a round trip', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ob-archive-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes entries one at a time with their digests and reads the same bytes back', async () => {
    const file = path.join(dir, 'round.zip');
    const writer = createZipWriter(file);
    const rows = ['{"id":1}\n', '{"id":2}\n'];
    const photo = Buffer.from([1, 2, 3, 4, 5]);

    const table = await writer.appendEntry('data/parties.ndjson', rows);
    const upload = await writer.appendEntry('uploads/images/a.webp', [photo], { store: true });
    await writer.appendEntry('manifest.json', ['{}']);
    expect(await writer.finalize()).toBeGreaterThan(0);
    expect(table.bytes).toBe(rows.join('').length);

    const reader = await openZipReader(file);
    try {
      expect(reader.entries.map((entry) => entry.name)).toEqual([
        'data/parties.ndjson',
        'uploads/images/a.webp',
        'manifest.json',
      ]);
      expect(await reader.readText('data/parties.ndjson', 1024)).toBe(rows.join(''));
      expect(await reader.hashEntry('uploads/images/a.webp')).toEqual(upload);
      await expect(reader.readText('data/parties.ndjson', 4)).rejects.toMatchObject({ reason: 'entryRejected' });
    } finally {
      reader.close();
    }
  });

  it('refuses a zip with a climbing entry name, and a file that is not a zip', async () => {
    const file = path.join(dir, 'evil.zip');
    const { createWriteStream } = await import('node:fs');
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(file);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append('x', { name: 'uploads/../../evil.txt' });
      void archive.finalize();
    });
    await expect(openZipReader(file)).rejects.toMatchObject({ reason: 'entryRejected' });

    const junk = path.join(dir, 'junk.zip');
    await writeFile(junk, 'not a zip at all');
    await expect(openZipReader(junk)).rejects.toMatchObject({ reason: 'notAnArchive' });
  });

  it('refuses a zip with more entries than the cap before reading them', async () => {
    const file = path.join(dir, 'many.zip');
    const writer = createZipWriter(file);
    for (const name of ['uploads/a', 'uploads/b', 'uploads/c']) await writer.appendEntry(name, ['x']);
    await writer.finalize();

    await expect(openZipReader(file, 2)).rejects.toMatchObject({ reason: 'notAnArchive' });
    const reader = await openZipReader(file, 3);
    reader.close();
    expect(MAX_ARCHIVE_ENTRIES).toBeGreaterThan(MAX_MANIFEST_BYTES / 100);
  });
});
