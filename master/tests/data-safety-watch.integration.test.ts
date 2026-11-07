/**
 * The warnings in the Server Masters' bell (`data-safety-watch.ts`): no backup for a
 * week, and a disk nearly full. They must reach the right people and must not nag.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/db/knex.js';
import { exportArchive } from '../src/services/archive-export.service.js';
import { LOW_DISK_BYTES, runDataSafetyCheck } from '../src/services/data-safety-watch.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { resetData, setUpFirstRun, setupDatabase, teardownDatabase } from './helpers/fixtures.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);
const plentyOfRoom = async (): Promise<number> => LOW_DISK_BYTES * 10;
const notices = (kind: string) => db()('user_notifications').where({ kind });

describe.skipIf(!canRunIntegrationTests)('the data safety warnings (integration)', () => {
  let folder: string;

  beforeAll(setupDatabase);
  afterAll(teardownDatabase);
  beforeEach(async () => {
    await resetData();
    folder = await mkdtemp(path.join(os.tmpdir(), 'ob-data-safety-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('stays quiet on a PC nobody has set up', async () => {
    await runDataSafetyCheck(new Date(), async () => 0);
    expect(await notices('backup.stale')).toHaveLength(0);
    expect(await notices('storage.lowDisk')).toHaveLength(0);
  });

  it('tells each Server Master, and only them, when there has never been a backup', async () => {
    await setUpFirstRun('Shree Ceramics');
    await runDataSafetyCheck(new Date(), plentyOfRoom);
    // `setUpFirstRun` creates two Server Masters.
    expect(await notices('backup.stale')).toHaveLength(2);
  });

  it('does not come back an hour after somebody read it, only a week later', async () => {
    await setUpFirstRun('Shree Ceramics');
    await runDataSafetyCheck(new Date(), plentyOfRoom);
    await db()('user_notifications').update({ read_at: db().fn.now() });

    await runDataSafetyCheck(new Date(Date.now() + 60 * 60 * 1000), plentyOfRoom);
    await runDataSafetyCheck(inDays(6), plentyOfRoom);
    expect(await notices('backup.stale')).toHaveLength(2);

    await runDataSafetyCheck(inDays(8), plentyOfRoom);
    expect(await notices('backup.stale')).toHaveLength(4);
  });

  it('says nothing while a backup is recent, and speaks up once it is a week old', async () => {
    await setUpFirstRun('Shree Ceramics');
    await exportArchive({ folder, includeUploads: false });

    await runDataSafetyCheck(inDays(6), plentyOfRoom);
    expect(await notices('backup.stale')).toHaveLength(0);

    await runDataSafetyCheck(inDays(8), plentyOfRoom);
    expect(await notices('backup.stale')).toHaveLength(2);
  });

  it('warns about a nearly full disk once a day, saying how much is left', async () => {
    await setUpFirstRun('Shree Ceramics');
    await exportArchive({ folder, includeUploads: false });
    const nearlyFull = async (): Promise<number> => LOW_DISK_BYTES / 2;

    await runDataSafetyCheck(new Date(), nearlyFull);
    const [first] = await notices('storage.lowDisk');
    expect(first.params).toEqual({ free: '1.0' });

    await db()('user_notifications').update({ read_at: db().fn.now() });
    await runDataSafetyCheck(new Date(Date.now() + 60 * 60 * 1000), nearlyFull);
    expect(await notices('storage.lowDisk')).toHaveLength(2);

    await runDataSafetyCheck(inDays(1.5), nearlyFull);
    expect(await notices('storage.lowDisk')).toHaveLength(4);
  });

  it('says nothing about a disk with room, or one it cannot measure', async () => {
    await setUpFirstRun('Shree Ceramics');
    await runDataSafetyCheck(new Date(), plentyOfRoom);
    await runDataSafetyCheck(new Date(), async () => null);
    expect(await notices('storage.lowDisk')).toHaveLength(0);
  });
});
