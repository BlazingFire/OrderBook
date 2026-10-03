/**
 * The daily automatic backup (`services/backup-scheduler.ts`): when it is due,
 * one "drive missing" notice a day however often it retries, one backup a day,
 * and pruning that removes only this company's older archives.
 *
 * No database: the export, the notices, the activity log and "who is this
 * Master" are mocked. The settings file is real, in the test data folder.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportArchive: vi.fn(),
  notify: vi.fn(async () => undefined),
  recordDetachedActivity: vi.fn(async () => undefined),
}));

vi.mock('../src/services/archive-export.service.js', () => ({ exportArchive: mocks.exportArchive }));
vi.mock('../src/services/notification.service.js', () => ({ notify: mocks.notify }));
vi.mock('../src/repositories/activity-log.repository.js', () => ({
  recordDetachedActivity: mocks.recordDetachedActivity,
}));
vi.mock('../src/repositories/user.repository.js', () => ({
  findActiveUserIdsWithPermission: vi.fn(async () => ['server-master-1']),
}));
vi.mock('../src/services/setup.service.js', () => ({
  getIdentity: vi.fn(async () => ({ tenantId: 'tenant', companyName: 'Shree Ceramics', masterUniqueId: 'm' })),
}));
vi.mock('../src/db/knex.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: vi.fn(() => ({})),
}));

const { config } = await import('../src/config/index.js');
const backupJob = await import('../src/services/backup-job.js');
const scheduler = await import('../src/services/backup-scheduler.js');

const actor = {
  tenantId: 'tenant',
  actorType: 'user',
  actorId: 'u1',
  userId: 'u1',
  permissions: null,
  actorName: 'Owner',
} as never;

const SETTINGS = path.join(config.dataDir, 'auto-backup.json');
const ZONE = 'Asia/Kolkata';
/** 21:30 in Kolkata on 3 October, and the same time the next day. */
const EVENING = new Date('2026-10-03T16:00:00Z');
const NEXT_EVENING = new Date('2026-10-04T16:00:00Z');

let folder: string;

beforeEach(async () => {
  await rm(SETTINGS, { force: true });
  backupJob.__resetBackupJobForTests();
  folder = await mkdtemp(path.join(os.tmpdir(), 'ob-auto-backup-'));
  mocks.exportArchive.mockReset();
  mocks.notify.mockClear();
  mocks.recordDetachedActivity.mockClear();
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(SETTINGS, { force: true });
});

/** Turn the schedule on for `folder` at a time already past on every test day. */
async function enable(keepLast = 7): Promise<void> {
  await scheduler.updateAutoBackupConfig({ enabled: true, folder, time: '00:00', keepLast }, actor);
}

describe('when a backup is due', () => {
  const file = (changes: Partial<Awaited<ReturnType<typeof scheduler.readAutoBackup>>> = {}) => ({
    enabled: true,
    folder: 'D:\\Backups',
    time: '21:00',
    keepLast: 7,
    lastRun: null,
    lastAttemptDate: null,
    lastSkippedNoticeDate: null,
    ...changes,
  });

  it('reads the clock in the business time zone', () => {
    expect(scheduler.localClock(new Date('2026-10-03T15:30:00Z'), ZONE)).toEqual({ date: '2026-10-03', time: '21:00' });
    expect(scheduler.localClock(new Date('2026-10-03T19:00:00Z'), ZONE)).toEqual({ date: '2026-10-04', time: '00:30' });
  });

  it('is due at or after the chosen time, once a day, only when on', () => {
    expect(scheduler.isAutoBackupDue(file(), { date: '2026-10-03', time: '20:59' })).toBe(false);
    expect(scheduler.isAutoBackupDue(file(), { date: '2026-10-03', time: '21:00' })).toBe(true);
    expect(scheduler.isAutoBackupDue(file(), { date: '2026-10-03', time: '23:10' })).toBe(true);
    expect(scheduler.isAutoBackupDue(file({ lastAttemptDate: '2026-10-03' }), { date: '2026-10-03', time: '22:00' })).toBe(
      false,
    );
    expect(scheduler.isAutoBackupDue(file({ lastAttemptDate: '2026-10-03' }), { date: '2026-10-04', time: '21:00' })).toBe(
      true,
    );
    expect(scheduler.isAutoBackupDue(file({ enabled: false }), { date: '2026-10-03', time: '22:00' })).toBe(false);
    expect(scheduler.isAutoBackupDue(file({ folder: '' }), { date: '2026-10-03', time: '22:00' })).toBe(false);
  });

  it('is off, at 21:00, keeping 7, until someone turns it on', async () => {
    expect(await scheduler.getAutoBackupStatus()).toMatchObject({
      enabled: false,
      folder: '',
      time: '21:00',
      keepLast: 7,
      lastRun: null,
      folderReachable: false,
    });
  });
});

describe('a missing drive', () => {
  it('is retried every tick and noticed once a day', async () => {
    await enable();
    await rm(folder, { recursive: true });

    await scheduler.runScheduledBackup(EVENING);
    await scheduler.runScheduledBackup(new Date(EVENING.getTime() + 60_000));

    expect(mocks.exportArchive).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith('tenant', ['server-master-1'], {
      kind: 'backup.autoSkipped',
      params: { folder },
      dedupeKey: 'backup.autoSkipped:2026-10-03',
    });
    expect((await scheduler.getAutoBackupStatus()).lastRun).toMatchObject({
      ok: false,
      message: { messageKey: 'error.validation.backupFolderMissing' },
    });

    await scheduler.runScheduledBackup(NEXT_EVENING);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });
});

describe('a backup that runs', () => {
  const ours = (stamp: string) => `OrderBook-Backup-Shree-Ceramics-${stamp}.zip`;

  it('runs once a day, then keeps only the newest archives of this company', async () => {
    await enable(2);
    const foreign = [
      'OrderBook-Backup-Other-Company-2026-01-01-2100.zip',
      'OrderBook-Backup-Shree-Ceramics-2026-01-01-2100.zip.partial',
      'holiday-photos.zip',
      'notes.txt',
    ];
    for (const name of [...foreign, ours('2026-10-01-2100'), ours('2026-10-02-2100')]) {
      await writeFile(path.join(folder, name), 'x');
    }
    mocks.exportArchive.mockImplementation(async (options: { folder: string }) => {
      const fileName = ours('2026-10-03-2130');
      await writeFile(path.join(options.folder, fileName), 'x');
      return { fileName, path: path.join(options.folder, fileName), bytes: 1, tables: 1, rows: 1, uploads: 0 };
    });

    await scheduler.runScheduledBackup(EVENING);
    await scheduler.runScheduledBackup(new Date(EVENING.getTime() + 60_000));

    expect(mocks.exportArchive).toHaveBeenCalledTimes(1);
    expect(mocks.exportArchive).toHaveBeenCalledWith(expect.objectContaining({ folder }));
    expect((await readdir(folder)).sort()).toEqual(
      [...foreign, ours('2026-10-02-2100'), ours('2026-10-03-2130')].sort(),
    );
    expect((await scheduler.getAutoBackupStatus()).lastRun).toMatchObject({ ok: true, fileName: ours('2026-10-03-2130') });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(backupJob.currentJob()).toMatchObject({ kind: 'backup', phase: 'done' });
  });

  it('sends one failure notice and waits for tomorrow', async () => {
    await enable();
    mocks.exportArchive.mockRejectedValue(new Error('disk on fire'));

    await scheduler.runScheduledBackup(EVENING);
    await scheduler.runScheduledBackup(new Date(EVENING.getTime() + 60_000));

    expect(mocks.exportArchive).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith('tenant', ['server-master-1'], {
      kind: 'backup.autoFailed',
      params: {},
      dedupeKey: 'backup.autoFailed:2026-10-03',
    });
    expect((await scheduler.getAutoBackupStatus()).lastRun).toMatchObject({ ok: false });
  });

  it('skips a tick while another backup or restore holds the slot, and tries again', async () => {
    await enable();
    let release = () => {};
    const held = backupJob.startJob('backup', () => new Promise<void>((resolve) => (release = resolve)));

    await scheduler.runScheduledBackup(EVENING);
    expect(mocks.exportArchive).not.toHaveBeenCalled();

    release();
    await held.finished;
    mocks.exportArchive.mockResolvedValue({ fileName: 'x.zip' });
    await scheduler.runScheduledBackup(new Date(EVENING.getTime() + 60_000));
    expect(mocks.exportArchive).toHaveBeenCalledTimes(1);
  });
});

describe('pruneCandidates', () => {
  it('names only this company’s archives past the newest N, by exact name', () => {
    const names = [
      'OrderBook-Backup-Acme-2026-10-01-2100.zip',
      'OrderBook-Backup-Acme-2026-10-03-2100.zip',
      'OrderBook-Backup-Acme-2026-10-02-2100.zip',
      'OrderBook-Backup-Acme-Tiles-2026-09-01-2100.zip',
      'OrderBook-Backup-Acme-2026-09-01-2100.zip.partial',
      'orderbook-backup-acme-2026-09-01-2100.zip',
      'OrderBook-Backup-Acme-latest.zip',
    ];
    expect(scheduler.pruneCandidates(names, 'Acme', 1)).toEqual([
      'OrderBook-Backup-Acme-2026-10-02-2100.zip',
      'OrderBook-Backup-Acme-2026-10-01-2100.zip',
    ]);
    expect(scheduler.pruneCandidates(names, 'Acme', 7)).toEqual([]);
  });
});

describe('saving the schedule', () => {
  it('checks the time, the count and the folder', async () => {
    await expect(scheduler.updateAutoBackupConfig({ time: '25:00' }, actor)).rejects.toMatchObject({
      messageKey: 'validation.autoBackup.time',
    });
    await expect(scheduler.updateAutoBackupConfig({ keepLast: 0 }, actor)).rejects.toMatchObject({
      messageKey: 'validation.autoBackup.keepLast',
    });
    await expect(scheduler.updateAutoBackupConfig({ keepLast: 61 }, actor)).rejects.toMatchObject({
      messageKey: 'validation.autoBackup.keepLast',
    });
    await expect(scheduler.updateAutoBackupConfig({ folder: 'relative\\path' }, actor)).rejects.toMatchObject({
      messageKey: 'validation.backup.pathRequired',
    });
    await expect(scheduler.updateAutoBackupConfig({ enabled: true }, actor)).rejects.toMatchObject({
      messageKey: 'validation.backup.pathRequired',
    });
    await expect(
      scheduler.updateAutoBackupConfig({ enabled: true, folder: path.join(folder, 'not-there') }, actor),
    ).rejects.toMatchObject({ messageKey: 'error.validation.backupFolderMissing' });
    expect(mocks.recordDetachedActivity).not.toHaveBeenCalled();
  });

  it('writes the activity log on a change only', async () => {
    const saved = await scheduler.updateAutoBackupConfig({ enabled: true, folder, time: '20:30', keepLast: 3 }, actor);
    expect(saved).toMatchObject({ enabled: true, folder, time: '20:30', keepLast: 3, folderReachable: true });
    expect(mocks.recordDetachedActivity).toHaveBeenCalledTimes(1);
    expect(mocks.recordDetachedActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'backup', action: 'schedule_updated' }),
      actor,
      expect.anything(),
    );

    await scheduler.updateAutoBackupConfig({ enabled: true, folder, time: '20:30', keepLast: 3 }, actor);
    expect(mocks.recordDetachedActivity).toHaveBeenCalledTimes(1);
  });
});
