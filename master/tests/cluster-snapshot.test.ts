/**
 * The safety copy behind "an update never touches the data".
 *
 * Pure file-system work on a temporary directory: the cluster is a folder
 * with a `PG_VERSION` in it as far as this module is concerned, so no
 * PostgreSQL is needed to prove every branch.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOOTED_VERSION_FILE,
  pruneSnapshots,
  readBootedVersion,
  recordBootedVersion,
  SNAPSHOT_DIR_NAME,
  SNAPSHOTS_KEPT,
  snapshotClusterBeforeUpgrade,
} from '../src/db/cluster-snapshot.js';

let dataDir: string;
let clusterDir: string;
let lines: string[];

const log = {
  info: (message: string) => void lines.push(`INFO ${message}`),
  warn: (message: string) => void lines.push(`WARN ${message}`),
};

const PLENTY = async () => 10 * 1024 * 1024 * 1024;

async function fakeCluster(): Promise<void> {
  await mkdir(path.join(clusterDir, 'base', '16384'), { recursive: true });
  await mkdir(path.join(clusterDir, 'pg_wal'), { recursive: true });
  await writeFile(path.join(clusterDir, 'PG_VERSION'), '17\n');
  await writeFile(path.join(clusterDir, 'base', '16384', '1259'), 'table bytes');
  await writeFile(path.join(clusterDir, 'pg_wal', '000000010000000000000001'), 'wal bytes');
}

function snapshot(overrides: Partial<Parameters<typeof snapshotClusterBeforeUpgrade>[0]> = {}) {
  return snapshotClusterBeforeUpgrade({
    dataDir,
    clusterDir,
    version: '1.2.0',
    env: {},
    now: new Date(2026, 8, 22, 9, 30, 0),
    freeBytes: PLENTY,
    log,
    ...overrides,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-snapshot-'));
  clusterDir = path.join(dataDir, 'postgres');
  lines = [];
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('the booted-version marker', () => {
  it('is absent on a data directory no build has recorded itself in', async () => {
    expect(await readBootedVersion(dataDir)).toBeNull();
  });

  it('round-trips, and a blank file reads as absent', async () => {
    await recordBootedVersion(dataDir, '1.2.0');
    expect(await readBootedVersion(dataDir)).toBe('1.2.0');

    await writeFile(path.join(dataDir, BOOTED_VERSION_FILE), '  \n');
    expect(await readBootedVersion(dataDir)).toBeNull();
  });
});

describe('copying the cluster before a new version boots', () => {
  it('copies a cluster the new version has never booted on — including one no version recorded', async () => {
    // The 1.0.3 → 1.2.0 case: nothing wrote the marker before this module
    // existed, so the very first boot of the build that carries it takes a copy.
    await fakeCluster();

    const outcome = await snapshot();
    expect(outcome.kind).toBe('taken');
    if (outcome.kind !== 'taken') return;

    expect(path.basename(outcome.path)).toBe('before-1.2.0-20260922-093000');
    expect(await readFile(path.join(outcome.path, 'postgres', 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(
      await readFile(path.join(outcome.path, 'postgres', 'base', '16384', '1259'), 'utf8'),
    ).toBe('table bytes');
    expect(await readFile(path.join(outcome.path, 'README.txt'), 'utf8')).toContain(clusterDir);
    // No `.partial` left behind: the copy was renamed into place when complete.
    expect(await readdir(path.join(dataDir, SNAPSHOT_DIR_NAME))).toEqual([
      'before-1.2.0-20260922-093000',
    ]);
  });

  it('leaves a stale postmaster.pid out of the copy', async () => {
    await fakeCluster();
    // A pid nothing is running under: 2^22 is above Linux's default pid_max
    // and far above anything Windows hands out in practice.
    await writeFile(path.join(clusterDir, 'postmaster.pid'), '4194304\nrest\n');

    const outcome = await snapshot({ isProcessAlive: () => false });
    expect(outcome.kind).toBe('taken');
    if (outcome.kind !== 'taken') return;
    expect(await readdir(path.join(outcome.path, 'postgres'))).not.toContain('postmaster.pid');
  });

  it('does nothing when this version already booted here', async () => {
    await fakeCluster();
    await recordBootedVersion(dataDir, '1.2.0');

    expect(await snapshot()).toEqual({ kind: 'skipped', reason: 'sameVersion' });
    expect(await readdir(dataDir)).not.toContain(SNAPSHOT_DIR_NAME);
  });

  it('copies again when the version moves on', async () => {
    await fakeCluster();
    await recordBootedVersion(dataDir, '1.2.0');

    const outcome = await snapshot({ version: '1.3.0' });
    expect(outcome.kind).toBe('taken');
    if (outcome.kind === 'taken') expect(path.basename(outcome.path)).toMatch(/^before-1\.3\.0-/);
  });

  it('has nothing to copy on a first run', async () => {
    expect(await snapshot()).toEqual({ kind: 'skipped', reason: 'noCluster' });
  });

  it('can be turned off per machine', async () => {
    await fakeCluster();
    expect(await snapshot({ env: { ORDERBOOK_UPGRADE_SNAPSHOT: '0' } })).toEqual({
      kind: 'skipped',
      reason: 'disabled',
    });
  });

  it('refuses to copy underneath a PostgreSQL that is still running', async () => {
    await fakeCluster();
    await writeFile(path.join(clusterDir, 'postmaster.pid'), `${process.pid}\n`);

    expect(await snapshot({ isProcessAlive: () => true })).toEqual({
      kind: 'skipped',
      reason: 'clusterRunning',
    });
    expect(
      lines.some((line) => line.startsWith('WARN') && line.includes(String(process.pid))),
    ).toBe(true);
  });

  it('refuses to fill the drive the database lives on', async () => {
    await fakeCluster();

    expect(await snapshot({ freeBytes: async () => 1024 })).toEqual({
      kind: 'skipped',
      reason: 'noSpace',
    });
    expect(lines.some((line) => line.startsWith('WARN') && /MB free/.test(line))).toBe(true);
    expect(await readdir(path.join(dataDir, SNAPSHOT_DIR_NAME))).toEqual([]);
  });

  it('fails soft, in words, when the copy itself fails', async () => {
    await fakeCluster();

    const outcome = await snapshot({ freeBytes: async () => Promise.reject(new Error('statfs?')) });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'failed' });
    expect(lines.some((line) => line.startsWith('WARN') && line.includes('statfs?'))).toBe(true);
  });
});

describe('keeping only the newest copies', () => {
  it(`keeps the newest ${SNAPSHOTS_KEPT} and removes an interrupted copy`, async () => {
    const root = path.join(dataDir, SNAPSHOT_DIR_NAME);
    for (const name of [
      'before-1.0.3-20260801-090000',
      'before-1.1.0-20260901-090000',
      'before-1.2.0-20260922-090000',
      'before-1.2.0-20260922-093000.partial',
      'notes.txt',
    ]) {
      await mkdir(path.join(root, name), { recursive: true });
    }

    const removed = await pruneSnapshots(dataDir);

    expect(removed.sort()).toEqual([
      'before-1.0.3-20260801-090000',
      'before-1.2.0-20260922-093000.partial',
    ]);
    expect((await readdir(root)).sort()).toEqual([
      'before-1.1.0-20260901-090000',
      'before-1.2.0-20260922-090000',
      'notes.txt',
    ]);
  });

  it('prunes after a new copy lands, never before', async () => {
    await fakeCluster();
    const root = path.join(dataDir, SNAPSHOT_DIR_NAME);
    await mkdir(path.join(root, 'before-1.0.3-20260801-090000'), { recursive: true });
    await mkdir(path.join(root, 'before-1.1.0-20260901-090000'), { recursive: true });

    await snapshot();

    expect((await readdir(root)).sort()).toEqual([
      'before-1.1.0-20260901-090000',
      'before-1.2.0-20260922-093000',
    ]);
  });
});
