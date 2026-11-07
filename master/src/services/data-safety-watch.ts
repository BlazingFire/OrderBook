/**
 * Warnings the Server Masters get in the bell before a problem loses data: no
 * backup for a week, and a disk running out of room.
 *
 * Only ever looks and tells. It changes no setting, starts no backup and takes no
 * lock. An hourly `statfs` and two small queries, so it costs a running Master
 * nothing, and a failure here is a line in the log.
 *
 * How often a notice repeats is read from when it was last sent, because a dedupe
 * key only holds while the notice is unread: this would otherwise come back an hour
 * after somebody read it.
 */

import type { NotificationKind } from '@orderbook/shared';

import { config } from '../config/index.js';
import { toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { lastBackupCreatedAt } from '../repositories/activity-log.repository.js';
import { lastSentAt } from '../repositories/notification.repository.js';
import { findActiveUserIdsWithPermission } from '../repositories/user.repository.js';
import { isMaintenance } from './backup-job.js';
import { notify } from './notification.service.js';
import { getIdentity } from './setup.service.js';
import { freeDiskBytes } from './storage.service.js';

const log = createLogger('data-safety');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 60 * 1000;
const BYTES_PER_GB = 1024 ** 3;

export const BACKUP_STALE_MS = 7 * DAY_MS;
/** Below this PostgreSQL is in reach of a full disk, which stops it writing. */
export const LOW_DISK_BYTES = 2 * BYTES_PER_GB;

export async function runDataSafetyCheck(
  now: Date = new Date(),
  freeBytes: () => Promise<number | null> = () => freeDiskBytes(config.dataDir),
): Promise<void> {
  // During a restore the database is being replaced; the next check will do.
  if (isMaintenance()) return;
  const identity = await getIdentity();
  if (!identity) return;
  const { tenantId } = identity;

  const sendAtMostEvery = async (
    kind: NotificationKind,
    everyMs: number,
    params: Record<string, string | number>,
  ): Promise<void> => {
    const last = await lastSentAt(tenantId, kind);
    if (last && now.getTime() - last.getTime() < everyMs) return;
    const userIds = await findActiveUserIdsWithPermission(tenantId, 'storage.backupAll');
    await notify(tenantId, userIds, { kind, params });
  };

  const lastBackup = await lastBackupCreatedAt(tenantId);
  if (!lastBackup || now.getTime() - lastBackup.getTime() >= BACKUP_STALE_MS) {
    await sendAtMostEvery('backup.stale', BACKUP_STALE_MS, {});
  }

  const free = await freeBytes();
  if (free !== null && free < LOW_DISK_BYTES) {
    const gb = (free / BYTES_PER_GB).toFixed(1);
    log.warn(`Low disk space on the data drive: ${gb} GB free`);
    await sendAtMostEvery('storage.lowDisk', DAY_MS, { free: gb });
  }
}

/** Start the hourly check. Returns the way to stop it. */
export function startDataSafetyWatch(): () => void {
  const check = (): void => {
    void runDataSafetyCheck().catch((error: unknown) => {
      log.warn(`Data safety check failed: ${toErrorMessage(error)}`);
    });
  };
  const first = setTimeout(check, FIRST_CHECK_AFTER_MS);
  const timer = setInterval(check, CHECK_EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
