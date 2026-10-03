/**
 * The Master's own nightly update, and the "a new version is out" notice
 * (1.4 R6 and R8).
 *
 * **What happens at 23:00** (the default; the time and an off switch are in
 * Settings): if a newer build, verified, is in the releases folder, the Master
 * takes a copy of its data, prepares the installer the way the Install button
 * would, and leaves one line for its desktop shell — "an unattended install is
 * due". The shell, which alone may run an installer, then stops the server, runs
 * the setup silently, and the new version starts itself. Nobody has to sign in
 * for the server to come back and serve the Offices; the window it opens shows
 * the sign-in screen, which is all that a person has to do in the morning.
 *
 * **Per PC, not a company setting.** `<dataDir>/auto-update.json`, like the
 * automatic backup: whether *this* PC may restart itself at night is a fact
 * about it. A restore onto another PC does not bring the schedule along.
 *
 * **Due** when it is on, the local time (the business time zone) is inside the
 * window that starts at the chosen time and lasts `WINDOW_MINUTES`, and no
 * attempt has started yet today. The window stops a PC that was off overnight
 * from restarting itself in the middle of the next working day.
 *
 * **The notice** is separate and does not depend on the schedule: the first
 * time a poll or a check finds a build newer than the one running, everybody
 * with an active account gets one bell notice for that version. It is recorded
 * here, not left to `dedupeKey` (which only holds while a notice is unread), so
 * reading it and the next poll finding the same build does not send it again.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_AUTO_UPDATE_CONFIG,
  type AutoUpdateConfig,
  type AutoUpdateRequest,
  type AutoUpdateRun,
  type AutoUpdateStatus,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import { companySlug } from '../domain/archive.js';
import { toErrorMessage, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import { findAllActiveUserIds } from '../repositories/user.repository.js';
import { exportArchive } from './archive-export.service.js';
import { isJobRunning, isMaintenance } from './backup-job.js';
import { localClock, pruneCandidates } from './backup-scheduler.js';
import { notify } from './notification.service.js';
import { getIdentity } from './setup.service.js';
import { masterAvailability, prepareMasterUpdate, syncAll } from './update.service.js';

const log = createLogger('auto-update');

const TICK_MS = 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A night-time choice may start any time until this hour the next morning. */
export const NIGHT_ENDS_AT = '05:00';
/** A daytime choice (before 20:00, from 05:00) may start this many minutes after the chosen time. */
export const DAYTIME_WINDOW_MINUTES = 180;
/** Pre-update copies kept in `<dataDir>/pre-update-backups`. */
export const KEEP_PRE_UPDATE_COPIES = 3;
/** How long the shell has to act on a request before it lapses. */
export const REQUEST_LIFETIME_MS = 30 * 60_000;

interface AutoUpdateFile extends AutoUpdateConfig {
  lastRun: AutoUpdateRun | null;
  /** The night (the local date it began, `yyyy-mm-dd`) the update last started: one a night. */
  lastAttemptDate: string | null;
  /** The newest version everybody has been told about. */
  lastNotifiedVersion: string | null;
}

const settingsFile = () => path.join(config.dataDir, 'auto-update.json');
const preUpdateDir = () => path.join(config.dataDir, 'pre-update-backups');

function defaults(): AutoUpdateFile {
  return { ...DEFAULT_AUTO_UPDATE_CONFIG, lastRun: null, lastAttemptDate: null, lastNotifiedVersion: null };
}

/** A missing or hand-edited file falls back to the defaults, field by field. */
export async function readAutoUpdate(): Promise<AutoUpdateFile> {
  const base = defaults();
  let raw: Partial<Record<keyof AutoUpdateFile, unknown>>;
  try {
    raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as typeof raw;
  } catch {
    return base;
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    // On unless the file says otherwise: a half-written file must not turn it off.
    enabled: raw.enabled !== false,
    time: TIME_PATTERN.test(text(raw.time) ?? '') ? (raw.time as string) : base.time,
    lastRun: raw.lastRun && typeof raw.lastRun === 'object' ? (raw.lastRun as AutoUpdateRun) : null,
    lastAttemptDate: text(raw.lastAttemptDate),
    lastNotifiedVersion: text(raw.lastNotifiedVersion),
  };
}

// One queue, read-change-write, written to `.tmp` and renamed: the same care as
// the automatic backup's file, for the same reason.
let queue: Promise<unknown> = Promise.resolve();

function changeAutoUpdate(edit: (file: AutoUpdateFile) => AutoUpdateFile): Promise<AutoUpdateFile> {
  const next = queue.then(async () => {
    const updated = edit(await readAutoUpdate());
    await fs.mkdir(config.dataDir, { recursive: true });
    const tmp = `${settingsFile()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(updated, null, 2));
    await fs.rename(tmp, settingsFile());
    return updated;
  });
  queue = next.catch(() => undefined);
  return next;
}

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The calendar day before `date` (`yyyy-mm-dd`), by calendar arithmetic and no time zone. */
export function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * Which night `clock` falls in, or `null` outside the window.
 *
 * A night-time choice (20:00 to 05:00) runs from the chosen time **until
 * 05:00 the next morning**, so a 23:30 setting, or a Master that was busy or
 * restarting at 23:00, still gets its run after midnight. The night is named by
 * the date it began on, which is what `lastAttemptDate` holds, so a run at 00:40
 * and one at 23:10 the evening before are the same night, and one a day.
 * A daytime choice keeps a three-hour window and the date it is on.
 */
export function updateNight(time: string, clock: { date: string; time: string }): string | null {
  const start = minutesOf(time);
  const now = minutesOf(clock.time);
  const end = minutesOf(NIGHT_ENDS_AT);
  if (start >= 20 * 60) {
    if (now >= start) return clock.date;
    if (now < end) return previousDate(clock.date);
    return null;
  }
  if (start < end) {
    return now >= start && now < end ? clock.date : null;
  }
  return now >= start && now < start + DAYTIME_WINDOW_MINUTES ? clock.date : null;
}

/** Whether tonight's update may start now: on, inside the window, not yet tried this night. */
export function isAutoUpdateDue(
  file: Pick<AutoUpdateFile, 'enabled' | 'time' | 'lastAttemptDate'>,
  clock: { date: string; time: string },
): boolean {
  if (!file.enabled) return false;
  const night = updateNight(file.time, clock);
  return night !== null && file.lastAttemptDate !== night;
}

/**
 * Tell everybody about a build newer than the one running, once per version.
 * Called after each poll and each Check now. Returns the version announced, or
 * `null` when there was nothing new to say.
 */
export async function announceNewVersion(): Promise<string | null> {
  const { available } = await masterAvailability();
  if (!available) return null;

  const file = await readAutoUpdate();
  if (file.lastNotifiedVersion === available.version) return null;

  const identity = await getIdentity();
  if (!identity) return null;

  const userIds = await findAllActiveUserIds(identity.tenantId);
  await notify(identity.tenantId, userIds, {
    kind: 'update.available',
    params: { version: available.version },
    link: { kind: 'update', id: available.version },
    dedupeKey: `update.available:${available.version}`,
  });
  await changeAutoUpdate((current) => ({ ...current, lastNotifiedVersion: available.version }));
  log.info(`Told everybody that ${available.version} is available`);
  return available.version;
}

/** What the shell has been asked to do, until it is acted on or lapses. */
let request: AutoUpdateRequest | null = null;

/** The unattended install the shell should run, or `null`. Read by the loopback health route. */
export function pendingAutoUpdate(now: number = Date.now()): AutoUpdateRequest | null {
  if (request && now - Date.parse(request.requestedAt) > REQUEST_LIFETIME_MS) request = null;
  return request;
}

export function __resetAutoUpdateForTests(): void {
  request = null;
  queue = Promise.resolve();
}

async function copyBeforeUpdate(tenantCompany: string | null): Promise<string> {
  const folder = preUpdateDir();
  await fs.mkdir(folder, { recursive: true });
  // The database and the settings, not the uploaded photos: the point is to be
  // able to go back to last night's data, and photos are not touched by an update.
  const { path: copied } = await exportArchive({ folder, includeUploads: false });
  const names = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const name of pruneCandidates(names, companySlug(tenantCompany), KEEP_PRE_UPDATE_COPIES)) {
    await fs.rm(path.join(folder, name)).catch((error: unknown) => {
      log.warn(`Could not remove the old pre-update copy ${name}: ${toErrorMessage(error)}`);
    });
  }
  return copied;
}

/** One tick: update tonight if due. Exported so a test can run it without waiting a minute. */
export async function runScheduledUpdate(now: Date = new Date()): Promise<void> {
  // A restore or a hand-started backup is using the database: the next tick will do.
  if (isMaintenance() || isJobRunning()) return;
  const file = await readAutoUpdate();
  const clock = localClock(now);
  if (!isAutoUpdateDue(file, clock)) return;

  const identity = await getIdentity();
  if (!identity) return;
  const at = now.toISOString();
  // Marked before anything else: whatever happens, this is tonight's one attempt.
  const night = updateNight(file.time, clock) ?? clock.date;
  await changeAutoUpdate((current) => ({ ...current, lastAttemptDate: night }));

  const record = (run: AutoUpdateRun) => changeAutoUpdate((current) => ({ ...current, lastRun: run }));

  try {
    // The poll may be minutes behind a release published this evening.
    await syncAll();
    const { available } = await masterAvailability();
    if (!available) {
      await record({ at, outcome: 'skipped' });
      return;
    }

    const backupPath = await copyBeforeUpdate(identity.companyName);
    // Verifies the setup file and holds it for the shell, exactly as the Install button does.
    await prepareMasterUpdate({ ...systemActor(identity.tenantId), actorName: 'Master PC' });

    // Tell everybody the Master is about to restart, so a dropped link on an
    // Office is expected and not a fault. A failed notice never stops the update.
    try {
      const userIds = await findAllActiveUserIds(identity.tenantId);
      await notify(identity.tenantId, userIds, {
        kind: 'update.installing',
        params: { version: available.version },
        link: { kind: 'update', id: available.version },
        dedupeKey: `update.installing:${available.version}:${night}`,
      });
    } catch (error) {
      log.warn(`Could not send the update.installing notice: ${toErrorMessage(error)}`);
    }

    request = { version: available.version, requestedAt: new Date().toISOString() };
    await record({ at, outcome: 'installing', version: available.version, backupPath });
    log.info(`Asked the shell to install ${available.version} unattended`);
  } catch (error) {
    request = null;
    const message = toErrorMessage(error);
    log.warn(`The nightly update could not be prepared: ${message}`);
    await record({ at, outcome: 'failed', message: { messageKey: 'updates.auto.failedBody', params: { error: message } } });
  }
}

/** Start the minute tick. Returns the way to stop it. */
export function startAutoUpdateScheduler(): () => void {
  const timer = setInterval(() => {
    void runScheduledUpdate().catch((error: unknown) => {
      log.warn(`Auto-update tick failed: ${toErrorMessage(error)}`);
    });
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function getAutoUpdateStatus(): Promise<AutoUpdateStatus> {
  const file = await readAutoUpdate();
  return { enabled: file.enabled, time: file.time, lastRun: file.lastRun };
}

/** Save the schedule from Settings. Fields left out keep their value; a change is audited. */
export async function updateAutoUpdateConfig(input: unknown, actor: ActorContext): Promise<AutoUpdateStatus> {
  const body = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof AutoUpdateConfig, unknown>>;
  const current = await readAutoUpdate();

  const enabled = body.enabled === undefined ? current.enabled : body.enabled === true;
  const time = body.time === undefined ? current.time : body.time;
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) throw new ValidationError('validation.autoUpdate.time');

  if (enabled !== current.enabled || time !== current.time) {
    await changeAutoUpdate((file) => ({ ...file, enabled, time }));
    await recordDetachedActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'master_update',
        entityId: 'auto-update',
        action: 'schedule_updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { enabled, time },
      },
      actor,
      db(),
    );
  }
  return getAutoUpdateStatus();
}
