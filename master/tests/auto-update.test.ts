/**
 * The Master's nightly update and the "new version" notice
 * (`services/auto-update.ts`, 1.4 R6 and R8): when the update is due, that it
 * takes a copy of the data first and leaves the shell exactly one request, that
 * a night with nothing new or a failure leaves none, and that everybody is told
 * about a version once, not once per poll.
 *
 * No database: the export, the build lookup, the notices and "who is this
 * Master" are mocked. The settings file is real, in the test data folder.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportArchive: vi.fn(),
  notify: vi.fn(async () => undefined),
  recordDetachedActivity: vi.fn(async () => undefined),
  masterAvailability: vi.fn(),
  prepareMasterUpdate: vi.fn(),
  syncAll: vi.fn(async () => undefined),
}));

vi.mock('../src/services/archive-export.service.js', () => ({ exportArchive: mocks.exportArchive }));
vi.mock('../src/services/notification.service.js', () => ({ notify: mocks.notify }));
vi.mock('../src/repositories/activity-log.repository.js', () => ({
  recordDetachedActivity: mocks.recordDetachedActivity,
}));
vi.mock('../src/repositories/user.repository.js', () => ({
  findAllActiveUserIds: vi.fn(async () => ['u1', 'u2', 'u3']),
}));
vi.mock('../src/services/setup.service.js', () => ({
  getIdentity: vi.fn(async () => ({ tenantId: 'tenant', companyName: 'Shree Ceramics', masterUniqueId: 'm' })),
}));
vi.mock('../src/services/update.service.js', () => ({
  masterAvailability: mocks.masterAvailability,
  prepareMasterUpdate: mocks.prepareMasterUpdate,
  syncAll: mocks.syncAll,
}));
vi.mock('../src/db/knex.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: vi.fn(() => ({})),
}));

const { config } = await import('../src/config/index.js');
const backupJob = await import('../src/services/backup-job.js');
const auto = await import('../src/services/auto-update.js');

const actor = {
  tenantId: 'tenant',
  actorType: 'user',
  actorId: 'u1',
  userId: 'u1',
  permissions: null,
  actorName: 'Owner',
} as never;

const SETTINGS = path.join(config.dataDir, 'auto-update.json');
/** 23:10 in Kolkata on 3 October (17:40 UTC), and the same time the next day. */
const NIGHT = new Date('2026-10-03T17:40:00Z');
const NEXT_NIGHT = new Date('2026-10-04T17:40:00Z');

const offer = (version: string) => ({ available: { version }, current: '1.2.5' });

beforeEach(async () => {
  await rm(SETTINGS, { force: true });
  backupJob.__resetBackupJobForTests();
  auto.__resetAutoUpdateForTests();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.notify.mockResolvedValue(undefined);
  mocks.recordDetachedActivity.mockResolvedValue(undefined);
  mocks.syncAll.mockResolvedValue(undefined);
  mocks.masterAvailability.mockResolvedValue(offer('1.3.0'));
  mocks.prepareMasterUpdate.mockResolvedValue({ path: 'x', manifest: {} });
  mocks.exportArchive.mockResolvedValue({ fileName: 'a.zip', path: 'C:\\data\\pre-update-backups\\a.zip' });
});
afterAll(async () => {
  await rm(SETTINGS, { force: true });
});

describe('when the nightly update is due', () => {
  const file = (changes: Partial<{ enabled: boolean; time: string; lastAttemptDate: string | null }> = {}) => ({
    enabled: true,
    time: '23:00',
    lastAttemptDate: null,
    ...changes,
  });

  it('is on, at 23:00, until somebody changes it', async () => {
    expect(await auto.getAutoUpdateStatus()).toEqual({ enabled: true, time: '23:00', lastRun: null });
  });

  it('opens at the chosen time and closes two hours later, so a PC switched on next morning does not restart itself', () => {
    expect(auto.isAutoUpdateDue(file(), { date: '2026-10-03', time: '22:59' })).toBe(false);
    expect(auto.isAutoUpdateDue(file(), { date: '2026-10-03', time: '23:00' })).toBe(true);
    expect(auto.isAutoUpdateDue(file(), { date: '2026-10-03', time: '23:59' })).toBe(true);
    // The clock has rolled over to the small hours of the next date.
    expect(auto.isAutoUpdateDue(file(), { date: '2026-10-04', time: '00:30' })).toBe(false);
    expect(auto.isAutoUpdateDue(file(), { date: '2026-10-04', time: '08:00' })).toBe(false);
    expect(auto.isAutoUpdateDue(file({ time: '21:00' }), { date: '2026-10-03', time: '22:59' })).toBe(true);
    expect(auto.isAutoUpdateDue(file({ time: '21:00' }), { date: '2026-10-03', time: '23:00' })).toBe(false);
  });

  it('is once a day, and never when switched off', () => {
    expect(auto.isAutoUpdateDue(file({ lastAttemptDate: '2026-10-03' }), { date: '2026-10-03', time: '23:30' })).toBe(false);
    expect(auto.isAutoUpdateDue(file({ lastAttemptDate: '2026-10-03' }), { date: '2026-10-04', time: '23:30' })).toBe(true);
    expect(auto.isAutoUpdateDue(file({ enabled: false }), { date: '2026-10-03', time: '23:30' })).toBe(false);
  });
});

describe('the nightly run', () => {
  it('copies the data, prepares the build and leaves the shell one request', async () => {
    await auto.runScheduledUpdate(NIGHT);

    // The copy comes first, into the data folder, without the photos.
    expect(mocks.exportArchive).toHaveBeenCalledTimes(1);
    const options = mocks.exportArchive.mock.calls[0]?.[0] as { folder: string; includeUploads: boolean };
    expect(options.folder).toBe(path.join(config.dataDir, 'pre-update-backups'));
    expect(options.includeUploads).toBe(false);
    const copied = mocks.exportArchive.mock.invocationCallOrder[0] ?? 0;
    const prepared = mocks.prepareMasterUpdate.mock.invocationCallOrder[0] ?? 0;
    expect(copied).toBeGreaterThan(0);
    expect(prepared).toBeGreaterThan(copied);

    expect(auto.pendingAutoUpdate()).toMatchObject({ version: '1.3.0' });
    // Everybody is told the Master is about to restart, once the build is ready.
    expect(mocks.notify).toHaveBeenCalledWith('tenant', ['u1', 'u2', 'u3'], expect.objectContaining({
      kind: 'update.installing',
      params: { version: '1.3.0' },
    }));
    const status = await auto.getAutoUpdateStatus();
    expect(status.lastRun).toMatchObject({ outcome: 'installing', version: '1.3.0' });
  });

  it('runs once a day, not on every tick of the hour', async () => {
    await auto.runScheduledUpdate(NIGHT);
    await auto.runScheduledUpdate(new Date(NIGHT.getTime() + 60_000));
    expect(mocks.prepareMasterUpdate).toHaveBeenCalledTimes(1);

    await auto.runScheduledUpdate(NEXT_NIGHT);
    expect(mocks.prepareMasterUpdate).toHaveBeenCalledTimes(2);
  });

  it('does nothing, and asks the shell for nothing, when there is nothing newer', async () => {
    mocks.masterAvailability.mockResolvedValue({ available: null, current: '1.3.0', reason: 'upToDate' });
    await auto.runScheduledUpdate(NIGHT);

    expect(mocks.exportArchive).not.toHaveBeenCalled();
    expect(mocks.prepareMasterUpdate).not.toHaveBeenCalled();
    expect(auto.pendingAutoUpdate()).toBeNull();
    expect((await auto.getAutoUpdateStatus()).lastRun).toMatchObject({ outcome: 'skipped' });
  });

  it('asks the shell for nothing when the copy of the data fails: no update without a way back', async () => {
    mocks.exportArchive.mockRejectedValue(new Error('disk full'));
    await auto.runScheduledUpdate(NIGHT);

    expect(mocks.prepareMasterUpdate).not.toHaveBeenCalled();
    expect(auto.pendingAutoUpdate()).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect((await auto.getAutoUpdateStatus()).lastRun).toMatchObject({ outcome: 'failed' });
  });

  it('still asks the shell when the restart notice cannot be sent', async () => {
    mocks.notify.mockRejectedValue(new Error('db down'));
    await auto.runScheduledUpdate(NIGHT);
    expect(auto.pendingAutoUpdate()).toMatchObject({ version: '1.3.0' });
  });

  it('asks the shell for nothing when the build cannot be verified', async () => {
    mocks.prepareMasterUpdate.mockRejectedValue(new Error('checksum'));
    await auto.runScheduledUpdate(NIGHT);

    expect(auto.pendingAutoUpdate()).toBeNull();
    expect((await auto.getAutoUpdateStatus()).lastRun).toMatchObject({ outcome: 'failed' });
  });

  it('waits while a restore or a backup is using the database, and still tries on the next tick', async () => {
    backupJob.__resetBackupJobForTests({ maintenance: true });
    await auto.runScheduledUpdate(NIGHT);
    expect(mocks.prepareMasterUpdate).not.toHaveBeenCalled();

    backupJob.__resetBackupJobForTests();
    await auto.runScheduledUpdate(new Date(NIGHT.getTime() + 60_000));
    expect(mocks.prepareMasterUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not run when switched off', async () => {
    await auto.updateAutoUpdateConfig({ enabled: false }, actor);
    await auto.runScheduledUpdate(NIGHT);
    expect(mocks.syncAll).not.toHaveBeenCalled();
    expect(mocks.prepareMasterUpdate).not.toHaveBeenCalled();
  });

  it('lets the request lapse if the shell never acts on it', async () => {
    await auto.runScheduledUpdate(NIGHT);
    const requestedAt = Date.parse(auto.pendingAutoUpdate()?.requestedAt ?? '');
    expect(auto.pendingAutoUpdate(requestedAt + auto.REQUEST_LIFETIME_MS - 1_000)).not.toBeNull();
    expect(auto.pendingAutoUpdate(requestedAt + auto.REQUEST_LIFETIME_MS + 1_000)).toBeNull();
  });
});

describe('telling everybody about a new version', () => {
  it('notifies every active account once per version, however many polls find it', async () => {
    expect(await auto.announceNewVersion()).toBe('1.3.0');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith('tenant', ['u1', 'u2', 'u3'], {
      kind: 'update.available',
      params: { version: '1.3.0' },
      link: { kind: 'update', id: '1.3.0' },
      dedupeKey: 'update.available:1.3.0',
    });

    // The next poll finds the same build; the first notice may even have been read.
    expect(await auto.announceNewVersion()).toBeNull();
    expect(mocks.notify).toHaveBeenCalledTimes(1);

    mocks.masterAvailability.mockResolvedValue(offer('1.3.1'));
    expect(await auto.announceNewVersion()).toBe('1.3.1');
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it('says nothing when there is no newer build', async () => {
    mocks.masterAvailability.mockResolvedValue({ available: null, current: '1.3.0', reason: 'upToDate' });
    expect(await auto.announceNewVersion()).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe('the settings', () => {
  it('saves the switch and the time, audits a change, and refuses a bad time', async () => {
    const saved = await auto.updateAutoUpdateConfig({ enabled: true, time: '22:30' }, actor);
    expect(saved).toMatchObject({ enabled: true, time: '22:30' });
    expect(mocks.recordDetachedActivity).toHaveBeenCalledTimes(1);

    // The same values again are not a change.
    await auto.updateAutoUpdateConfig({ time: '22:30' }, actor);
    expect(mocks.recordDetachedActivity).toHaveBeenCalledTimes(1);

    await expect(auto.updateAutoUpdateConfig({ time: '25:00' }, actor)).rejects.toThrow();
    await expect(auto.updateAutoUpdateConfig({ time: 'night' }, actor)).rejects.toThrow();
    expect((await auto.getAutoUpdateStatus()).time).toBe('22:30');
  });
});
