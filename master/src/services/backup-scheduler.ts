/**
 * The daily automatic backup (`docs/7-STORAGE-BACKUP-RESTORE.md`): "Back up
 * everything" to a folder on this PC, once a day at the chosen time.
 *
 * **Per PC, not a company setting.** The settings live in
 * `<dataDir>/auto-backup.json`, because the folder names a drive letter on this
 * machine. A restore onto another PC does not bring them along, so it never
 * starts writing to the old PC's drive. Off by default, 21:00, keep 7.
 *
 * **Due** when it is on, the local time (the business time zone) is at or past
 * the chosen time and no scheduled backup has started yet today. A PC that was
 * off at 21:00 catches up at the next tick that evening.
 *
 * **Drive missing:** it tries again every minute, and the Server Masters get one
 * bell notice a day. **Failed:** one notice; the next try is tomorrow, and a
 * backup can still be started by hand.
 *
 * **Pruning** after a good backup keeps the newest `keepLast` archives of this
 * company in that folder, matched by exact file name. Nothing else in the
 * folder is ever touched.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_AUTO_BACKUP_CONFIG,
  type ArchiveListEntry,
  type AutoBackupConfig,
  type AutoBackupStatus,
  type MessageParams,
  type NotificationKind,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import type { ActorContext } from '../domain/actor.js';
import { companySlug } from '../domain/archive.js';
import { toErrorMessage, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import { findActiveUserIdsWithPermission } from '../repositories/user.repository.js';
import { exportArchive } from './archive-export.service.js';
import { isJobRunning, isMaintenance, startJob } from './backup-job.js';
import { notify } from './notification.service.js';
import { getIdentity } from './setup.service.js';

const log = createLogger('backup-scheduler');

const TICK_MS = 60_000;
export const KEEP_LAST_MAX = 60;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Any archive, for the list under "Back up everything". */
const ARCHIVE_NAME = /^OrderBook-Backup-.+\.zip$/i;

/** What `auto-backup.json` holds: the settings and the scheduler's own memory. */
export interface AutoBackupFile extends AutoBackupConfig {
  lastRun: AutoBackupStatus['lastRun'];
  /** The local date (`yyyy-mm-dd`) a scheduled backup last started: one a day. */
  lastAttemptDate: string | null;
  /** The local date the "drive missing" notice last went out: one a day. */
  lastSkippedNoticeDate: string | null;
}

const settingsFile = () => path.join(config.dataDir, 'auto-backup.json');

function defaults(): AutoBackupFile {
  return { ...DEFAULT_AUTO_BACKUP_CONFIG, lastRun: null, lastAttemptDate: null, lastSkippedNoticeDate: null };
}

/** A local path typed or chosen on the Master PC. Anything else is refused. */
export function requireLocalPath(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !path.isAbsolute(text) || text.includes('\0')) {
    throw new ValidationError('validation.backup.pathRequired');
  }
  return path.resolve(text);
}

async function isFolder(folder: string): Promise<boolean> {
  return Boolean(folder) && (await fs.stat(folder).catch(() => null))?.isDirectory() === true;
}

/** Throws the "plug in the drive" message when `folder` is not there. */
export async function assertFolderExists(folder: string): Promise<void> {
  if (!(await isFolder(folder))) throw new ValidationError('error.validation.backupFolderMissing', { folder });
}

/** A missing or hand-edited file falls back to the defaults, field by field. */
export async function readAutoBackup(): Promise<AutoBackupFile> {
  const base = defaults();
  let raw: Partial<Record<keyof AutoBackupFile, unknown>>;
  try {
    raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as typeof raw;
  } catch {
    return base;
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const keepLast = raw.keepLast;
  return {
    enabled: raw.enabled === true,
    folder: text(raw.folder) ?? base.folder,
    time: TIME_PATTERN.test(text(raw.time) ?? '') ? (raw.time as string) : base.time,
    keepLast:
      Number.isInteger(keepLast) && (keepLast as number) >= 1 && (keepLast as number) <= KEEP_LAST_MAX
        ? (keepLast as number)
        : base.keepLast,
    lastRun: raw.lastRun && typeof raw.lastRun === 'object' ? (raw.lastRun as AutoBackupFile['lastRun']) : null,
    lastAttemptDate: text(raw.lastAttemptDate),
    lastSkippedNoticeDate: text(raw.lastSkippedNoticeDate),
  };
}

/*
 * Every write goes through one queue, read-change-write, so the scheduler
 * recording a run and Settings saving new times never lose each other's change.
 * Written to a `.tmp` file and renamed, so a crash never leaves half a file.
 */
let queue: Promise<unknown> = Promise.resolve();

function changeAutoBackup(edit: (file: AutoBackupFile) => AutoBackupFile): Promise<AutoBackupFile> {
  const next = queue.then(async () => {
    const updated = edit(await readAutoBackup());
    await fs.mkdir(config.dataDir, { recursive: true });
    const tmp = `${settingsFile()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(updated, null, 2));
    await fs.rename(tmp, settingsFile());
    return updated;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** The local date and time of day in the business time zone. */
export function localClock(now: Date, timeZone: string = config.locale.timeZone): { date: string; time: string } {
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
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function isAutoBackupDue(file: AutoBackupFile, clock: { date: string; time: string }): boolean {
  // `HH:MM`, zero-padded, so the strings compare as times.
  return file.enabled && file.folder !== '' && clock.time >= file.time && file.lastAttemptDate !== clock.date;
}

/** The archives of this company in a folder past the newest `keepLast`, by exact name. */
export function pruneCandidates(names: readonly string[], slug: string, keepLast: number): string[] {
  // The slug is letters, digits and dashes only (`companySlug`), so it is safe in a pattern.
  const ours = new RegExp(`^OrderBook-Backup-${slug}-\\d{4}-\\d{2}-\\d{2}-\\d{4}\\.zip$`);
  // The stamp in the name sorts as the time, newest last.
  return names
    .filter((name) => ours.test(name))
    .sort()
    .reverse()
    .slice(keepLast);
}

async function prune(folder: string, slug: string, keepLast: number): Promise<void> {
  const names = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const name of pruneCandidates(names, slug, keepLast)) {
    await fs.rm(path.join(folder, name)).catch((error: unknown) => {
      log.warn(`Could not remove the old backup ${name}: ${toErrorMessage(error)}`);
    });
  }
}

async function notifyBackupHolders(
  tenantId: string,
  kind: NotificationKind,
  params: MessageParams,
  date: string,
): Promise<void> {
  try {
    const userIds = await findActiveUserIdsWithPermission(tenantId, 'storage.backupAll');
    await notify(tenantId, userIds, { kind, params, dedupeKey: `${kind}:${date}` });
  } catch (error) {
    log.warn(`Could not send the ${kind} notice: ${toErrorMessage(error)}`);
  }
}

/** One tick: back up if due. Exported so a test can run it without waiting a minute. */
export async function runScheduledBackup(now: Date = new Date()): Promise<void> {
  // During a restore the database is being replaced; the next tick will do.
  if (isMaintenance()) return;
  const file = await readAutoBackup();
  const clock = localClock(now);
  if (!isAutoBackupDue(file, clock)) return;

  const identity = await getIdentity();
  if (!identity) return;
  const at = now.toISOString();

  if (!(await isFolder(file.folder))) {
    const noticeDue = file.lastSkippedNoticeDate !== clock.date;
    await changeAutoBackup((current) => ({
      ...current,
      lastRun: {
        at,
        ok: false,
        message: { messageKey: 'error.validation.backupFolderMissing', params: { folder: file.folder } },
      },
      lastSkippedNoticeDate: noticeDue ? clock.date : current.lastSkippedNoticeDate,
    }));
    if (noticeDue) await notifyBackupHolders(identity.tenantId, 'backup.autoSkipped', { folder: file.folder }, clock.date);
    return;
  }

  // A backup started by hand is running: try again next minute.
  if (isJobRunning()) return;
  let fileName: string | undefined;
  const { finished } = startJob('backup', async (update) => {
    ({ fileName } = await exportArchive({ folder: file.folder, progress: update }));
  });
  await changeAutoBackup((current) => ({ ...current, lastAttemptDate: clock.date }));

  const status = await finished;
  if (status.phase !== 'done') {
    await changeAutoBackup((current) => ({ ...current, lastRun: { at, ok: false, message: status.message } }));
    await notifyBackupHolders(identity.tenantId, 'backup.autoFailed', {}, clock.date);
    return;
  }

  await changeAutoBackup((current) => ({ ...current, lastRun: { at, ok: true, fileName } }));
  await prune(file.folder, companySlug(identity.companyName), file.keepLast).catch((error: unknown) => {
    log.warn(`Could not prune old backups in ${file.folder}: ${toErrorMessage(error)}`);
  });
}

/** Start the minute tick. Returns the way to stop it. */
export function startBackupScheduler(): () => void {
  const timer = setInterval(() => {
    void runScheduledBackup().catch((error: unknown) => {
      log.warn(`Auto-backup tick failed: ${toErrorMessage(error)}`);
    });
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function getAutoBackupStatus(): Promise<AutoBackupStatus> {
  const file = await readAutoBackup();
  return {
    enabled: file.enabled,
    folder: file.folder,
    time: file.time,
    keepLast: file.keepLast,
    lastRun: file.lastRun,
    folderReachable: await isFolder(file.folder),
  };
}

/**
 * Save the schedule from Settings. Fields left out keep their value. Turning it
 * on needs a folder that exists now. A change is written to the activity log.
 */
export async function updateAutoBackupConfig(input: unknown, actor: ActorContext): Promise<AutoBackupStatus> {
  const body = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof AutoBackupConfig, unknown>>;
  const current = await readAutoBackup();

  const enabled = body.enabled === undefined ? current.enabled : body.enabled === true;
  const time = body.time === undefined ? current.time : body.time;
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) throw new ValidationError('validation.autoBackup.time');
  const keepLast = body.keepLast === undefined ? current.keepLast : body.keepLast;
  if (typeof keepLast !== 'number' || !Number.isInteger(keepLast) || keepLast < 1 || keepLast > KEEP_LAST_MAX) {
    throw new ValidationError('validation.autoBackup.keepLast');
  }
  const rawFolder = body.folder === undefined ? current.folder : body.folder;
  const folder = rawFolder === '' ? '' : requireLocalPath(rawFolder);
  if (enabled) {
    if (!folder) throw new ValidationError('validation.backup.pathRequired');
    await assertFolderExists(folder);
  }

  const next: AutoBackupConfig = { enabled, folder, time, keepLast };
  const changed = (Object.keys(next) as Array<keyof AutoBackupConfig>).some((key) => next[key] !== current[key]);
  if (changed) {
    await changeAutoBackup((file) => ({ ...file, ...next }));
    await recordDetachedActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'backup',
        entityId: 'auto-backup',
        action: 'schedule_updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { ...next },
      },
      actor,
      db(),
    );
  }
  return getAutoBackupStatus();
}

/** The archives in a folder, newest first. Only `OrderBook-Backup-*.zip` files are listed. */
export async function listArchives(folder: string): Promise<ArchiveListEntry[]> {
  await assertFolderExists(folder);
  const entries = (await fs.readdir(folder, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && ARCHIVE_NAME.test(entry.name),
  );
  const listed: ArchiveListEntry[] = [];
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    const stats = await fs.stat(file).catch(() => null);
    if (stats) listed.push({ fileName: entry.name, path: file, bytes: stats.size, modifiedAt: stats.mtime.toISOString() });
  }
  return listed.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
