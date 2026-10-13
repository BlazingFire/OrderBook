/**
 * One app update from the moment Install now is pressed to the moment the new
 * version answers (1.5). The download bar (`update-progress.ts`) covers the
 * bytes; this covers everything around them, so a person watching the screen
 * always knows which step it is on, how long it has taken and roughly how long
 * is left — and, after the restart, that it really happened.
 *
 * Pure: the screens draw from it and the desktop shell writes the record it
 * reads. The shell cannot import this at run time (it ships without
 * `node_modules`), so `electron/lib/update-run.ts` keeps its own copy of the
 * record's shape, held equal to `UpdateRunFile` by its test.
 */

import type { UpdateDownloadProgress } from './update-progress.js';

/**
 * The steps, in the order they run. Each panel shows the ones it takes: the
 * Office downloads from the Master; the Master's build is already in its
 * releases folder and is checked again before it is handed over.
 */
export type UpdateStepId = 'download' | 'verify' | 'save' | 'close' | 'install' | 'restart';

export const MASTER_UPDATE_STEPS: readonly UpdateStepId[] = [
  'verify',
  'save',
  'close',
  'install',
  'restart',
];
export const OFFICE_UPDATE_STEPS: readonly UpdateStepId[] = [
  'download',
  'save',
  'close',
  'install',
  'restart',
];

export type UpdateStepState = 'done' | 'active' | 'pending' | 'failed';

/**
 * What the installer and the restart usually take when this PC has never been
 * timed: the silent setup, Windows' permission prompt and the first start of
 * the new version. Shown as "about", never as a countdown to the second.
 */
export const DEFAULT_INSTALL_SECONDS = 120;

/** Each step's state, given the one running now (or that failed). */
export function updateStepStates(
  steps: readonly UpdateStepId[],
  current: UpdateStepId,
  failed: boolean,
): UpdateStepState[] {
  const at = steps.indexOf(current);
  return steps.map((_, index) =>
    index < at ? 'done' : index === at ? (failed ? 'failed' : 'active') : 'pending',
  );
}

/**
 * How far through the whole update this is, 0–1: whole steps done, plus the
 * download's real fraction while it runs. A step without a measure counts as
 * not started until it ends, so the bar never runs ahead of what has happened.
 */
export function updateRunFraction(
  steps: readonly UpdateStepId[],
  current: UpdateStepId,
  download?: UpdateDownloadProgress | null,
): number {
  const at = Math.max(0, steps.indexOf(current));
  let within = 0;
  if (current === 'download' && download && download.totalBytes > 0) {
    within = Math.min(1, download.receivedBytes / download.totalBytes);
  }
  return Math.min(1, (at + within) / steps.length);
}

/**
 * Seconds left, or `null` when it cannot honestly be said: the download's own
 * time left (unknown while the speed is unknown) plus the install, timed on
 * this PC last time or the default.
 */
export function updateSecondsLeft(input: {
  current: UpdateStepId;
  download?: UpdateDownloadProgress | null;
  installSeconds: number | null;
}): number | null {
  const install = input.installSeconds ?? DEFAULT_INSTALL_SECONDS;
  if (input.current === 'download') {
    const eta = input.download?.etaSeconds;
    return eta === null || eta === undefined ? null : eta + install;
  }
  return install;
}

/** `0:07`, `1:42`, `1:02:05`: a running clock. */
export function formatClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * What the desktop shell remembers about updates, in `update-run.json` in its
 * own folder. `pending` is written just before the installer starts and
 * settled into `last` by the next start; `installSeconds` is the last update
 * that did finish, timed from the hand-over to the new version answering.
 */
export interface UpdateRunFile {
  pending: { from: string; to: string; startedAt: string } | null;
  last: UpdateRunRecord | null;
  installSeconds: number | null;
}

export interface UpdateRunRecord {
  from: string;
  to: string;
  /** `updated`: this start runs `to`. `notInstalled`: it still runs something else. */
  outcome: 'updated' | 'notInstalled';
  startedAt: string;
  finishedAt: string;
  /** From the hand-over to the new version answering. `null` when it did not install. */
  seconds: number | null;
}

/**
 * The "updated" notice shown once after a start, or `null`. The shell's record
 * is the precise one; without it (a browser tab, or an update started by a
 * shell older than 1.5) the version this browser last saw stands in, with no
 * times.
 */
export interface FinishedUpdateNotice {
  from: string | null;
  to: string;
  outcome: 'updated' | 'notInstalled';
  startedAt: string | null;
  finishedAt: string | null;
  seconds: number | null;
  /** What marks it seen, so it shows once. */
  key: string;
}

export function finishedUpdateNotice(input: {
  running: string;
  shell: UpdateRunRecord | null;
  /** The version this browser last ran, or `null` the first time. */
  lastSeenVersion: string | null;
  /** The notice keys already acknowledged. */
  seen: readonly string[];
}): FinishedUpdateNotice | null {
  const { shell } = input;
  if (shell) {
    const key = `run:${shell.to}:${shell.finishedAt}`;
    if (input.seen.includes(key)) return null;
    return { ...shell, key };
  }
  if (input.lastSeenVersion && input.lastSeenVersion !== input.running) {
    const key = `version:${input.lastSeenVersion}:${input.running}`;
    if (input.seen.includes(key)) return null;
    return {
      from: input.lastSeenVersion,
      to: input.running,
      outcome: 'updated',
      startedAt: null,
      finishedAt: null,
      seconds: null,
      key,
    };
  }
  return null;
}
