/**
 * The "backup all" export reads every table in keyset pages, so a large table
 * costs one page of memory, not the table (`backup.repository.ts#streamTableNdjson`),
 * and it refuses a drive it cannot fill before writing anything
 * (`archive-export.service.ts`).
 *
 * The paging cases run against throwaway tables made here: a composite key, a
 * timestamp key whose rows are a microsecond apart (a bound read back through
 * a JavaScript Date would lose them), and a table with no key at all.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Knex } from 'knex';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const drive = vi.hoisted(() => ({ free: null as number | null, fileSystem: null as string | null }));

vi.mock('../src/services/storage.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  freeDiskBytes: vi.fn(async () => drive.free),
  volumeFileSystem: vi.fn(async () => drive.fileSystem),
}));

const { db } = await import('../src/db/knex.js');
const { MANIFEST_ENTRY, MAX_MANIFEST_BYTES, parseArchiveManifest } = await import('../src/domain/archive.js');
const { openZipReader } = await import('../src/lib/archive-zip.js');
const { streamTableNdjson } = await import('../src/repositories/backup.repository.js');
const { exportArchive } = await import('../src/services/archive-export.service.js');
const { canRunIntegrationTests } = await import('./helpers/db.js');
const { resetData, setUpFirstRun, setupDatabase, teardownDatabase } = await import('./helpers/fixtures.js');

const PROBES = ['archive_paging_composite', 'archive_paging_time', 'archive_paging_heap'];

async function dropProbes(): Promise<void> {
  for (const table of PROBES) await db().raw(`DROP TABLE IF EXISTS ${table}`);
}

/** Every row the stream hands over, and how many queries it took. */
async function streamAll(table: string, pageSize: number): Promise<{ rows: Array<Record<string, unknown>>; queries: number }> {
  let queries = 0;
  const counting = {
    raw: (...args: Parameters<Knex['raw']>) => {
      queries += 1;
      return db().raw(...args);
    },
  } as unknown as Knex;
  const rows: Array<Record<string, unknown>> = [];
  const count = await streamTableNdjson(table, (json) => void rows.push(JSON.parse(json) as Record<string, unknown>), {
    runner: counting,
    pageSize,
  });
  expect(count).toBe(rows.length);
  return { rows, queries };
}

describe.skipIf(!canRunIntegrationTests)('archive export paging (integration)', () => {
  beforeAll(async () => {
    await setupDatabase();
    await dropProbes();
    await db().raw(`CREATE TABLE archive_paging_composite (a int, b text, note text, PRIMARY KEY (a, b))`);
    await db().raw(`
      INSERT INTO archive_paging_composite
      SELECT i / 10, 'k' || lpad((i % 10)::text, 2, '0'), 'row ' || i FROM generate_series(0, 1049) i`);
    await db().raw(`CREATE TABLE archive_paging_time (at timestamptz PRIMARY KEY, n int)`);
    await db().raw(`
      INSERT INTO archive_paging_time
      SELECT timestamptz '2026-01-01 00:00:00+00' + i * interval '1 microsecond', i FROM generate_series(1, 250) i`);
    await db().raw(`CREATE TABLE archive_paging_heap (v int)`);
    await db().raw(`INSERT INTO archive_paging_heap SELECT i FROM generate_series(1, 230) i`);
  });

  afterAll(async () => {
    await dropProbes();
    await teardownDatabase();
  });

  beforeEach(() => {
    drive.free = null;
    drive.fileSystem = null;
  });

  it('pages a composite key 100 rows at a time, every row once and in key order', async () => {
    const { rows, queries } = await streamAll('archive_paging_composite', 100);

    expect(rows).toHaveLength(1050);
    expect(rows.map((row) => row.note)).toEqual(Array.from({ length: 1050 }, (_, i) => `row ${i}`));
    // One for the key columns, then eleven pages: ten full and one of fifty.
    // Never one query for the whole table, which is what bounds the memory.
    expect(queries).toBe(1 + 11);
  });

  it('keeps a timestamp key exact to the microsecond across page bounds', async () => {
    const { rows } = await streamAll('archive_paging_time', 100);
    expect(rows.map((row) => row.n)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  });

  it('pages a table with no primary key by its row position', async () => {
    const { rows } = await streamAll('archive_paging_heap', 100);
    expect(rows.map((row) => row.v).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 230 }, (_, i) => i + 1),
    );
  });

  describe('the export', () => {
    let folder: string;

    beforeEach(async () => {
      await resetData();
      await setUpFirstRun('Paging Ceramics');
      folder = await mkdtemp(path.join(os.tmpdir(), 'ob-archive-paging-'));
    });

    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    it('writes every page of a table into the archive, and leaves no .partial behind', async () => {
      const result = await exportArchive({ folder, pageSize: 100 });

      expect(await readdir(folder)).toEqual([result.fileName]);
      expect(result.fileName).toMatch(/^OrderBook-Backup-Paging-Ceramics-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);

      const reader = await openZipReader(result.path);
      try {
        const manifest = parseArchiveManifest(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST_BYTES));
        expect(manifest.tables.find((table) => table.name === 'archive_paging_composite')?.rows).toBe(1050);
        const text = await reader.readText('data/archive_paging_composite.ndjson', 10 * 1024 * 1024);
        expect(text.trimEnd().split('\n')).toHaveLength(1050);
      } finally {
        reader.close();
      }
    });

    it('refuses a drive without room before writing anything', async () => {
      drive.free = 1024;

      await expect(exportArchive({ folder })).rejects.toMatchObject({
        reason: 'insufficientSpace',
        messageKey: 'error.validation.backupInsufficientSpace',
      });
      expect(await readdir(folder)).toEqual([]);
    });

    it('refuses a folder that is not there, such as a drive that was unplugged', async () => {
      await expect(exportArchive({ folder: path.join(folder, 'missing') })).rejects.toMatchObject({
        messageKey: 'error.validation.backupFolderMissing',
      });
    });

    it('writes a small backup to a FAT32 drive: only one too big for it is refused', async () => {
      drive.fileSystem = 'FAT32';
      const result = await exportArchive({ folder });
      expect(await readdir(folder)).toEqual([result.fileName]);
    });
  });
});
