/**
 * The one backup or restore the Master runs at a time, and the maintenance
 * flag a restore holds while it replaces the database
 * (`docs/7-STORAGE-BACKUP-RESTORE.md`).
 *
 * **One slot.** A backup and a restore read and write the same files and the
 * same tables, and either can run for minutes on a slow USB drive, so a second
 * start is refused rather than queued. The status is kept after the job ends,
 * so a screen polling for it sees `done` or `failed` and why.
 *
 * **Maintenance.** While a restore drops and rebuilds the schema, every HTTP
 * route but the job's own status and health answers 503
 * (`http/middleware/maintenance-gate.ts`), the hub refuses new sockets and
 * every command on a socket that raced the disconnect, and the push gate's
 * waiting pushes are refused. Entering it ends every session and closes every
 * socket before anything touches the schema, in the order `resetAllData` uses.
 */

import { randomUUID } from 'node:crypto';

import type { BackupJobKind, BackupJobStatus } from '@orderbook/shared';

import { AppError, ConflictError, toErrorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { disconnectEverySocket } from '../realtime/hub.js';
import { resetAuthState } from './auth.service.js';
import { rejectQueuedPushes, whenGateIdle } from './push-gate.js';

const log = createLogger('backup-job');

/** What a running job may change about its own status. */
export type JobProgress = Partial<Pick<BackupJobStatus, 'phase' | 'done' | 'total' | 'fileName' | 'path'>>;

let current: BackupJobStatus | null = null;
let running = false;
let maintenance = false;

/** The refusal every gated route, socket and command answers with during maintenance. */
export function maintenanceError(): AppError {
  return new AppError('error.unavailable.maintenance', {}, 503, 'unavailable');
}

export function isMaintenance(): boolean {
  return maintenance;
}

/** A copy of the latest job's status, running or finished, or `null` before the first. */
export function currentJob(): BackupJobStatus | null {
  return current ? { ...current } : null;
}

export function isJobRunning(): boolean {
  return running;
}

/**
 * Take the slot and run `work` detached. Returns the job's first status at
 * once, and `finished`, which settles with the last status and never rejects:
 * a failure is the status's `failed` phase and its message.
 *
 * `work` reports progress through `update`. When it resolves, the job is `done`
 * with whatever it last reported.
 */
export function startJob(
  kind: BackupJobKind,
  work: (update: (progress: JobProgress) => void, jobId: string) => Promise<void>,
): { status: BackupJobStatus; finished: Promise<BackupJobStatus> } {
  if (running) throw new ConflictError('error.conflict.backupBusy');
  running = true;

  const job: BackupJobStatus = {
    id: randomUUID(),
    kind,
    phase: kind === 'backup' ? 'preparing' : 'checking',
    done: 0,
    total: 0,
    startedAt: new Date().toISOString(),
  };
  current = job;
  const update = (progress: JobProgress) => {
    // A late progress call from a job that has already finished changes nothing.
    if (current === job && !job.finishedAt) Object.assign(job, progress);
  };

  const finished = (async () => {
    try {
      await work(update, job.id);
      job.phase = 'done';
    } catch (error) {
      log.warn(`The ${kind} failed: ${toErrorMessage(error)}`);
      job.phase = 'failed';
      job.message =
        error instanceof AppError
          ? { messageKey: error.messageKey, params: error.params as Record<string, string | number> }
          : { messageKey: 'error.generic.internal' };
    } finally {
      job.finishedAt = new Date().toISOString();
      running = false;
    }
    return { ...job };
  })();

  return { status: { ...job }, finished };
}

/**
 * Close the Master for a restore. Sessions end and sockets close first, then
 * the push gate refuses what is waiting and finishes what it is applying, so
 * nothing is mid-write when the caller drops the schema.
 */
export async function enterMaintenance(): Promise<void> {
  maintenance = true;
  resetAuthState();
  disconnectEverySocket();
  rejectQueuedPushes(maintenanceError());
  await whenGateIdle();
}

export function leaveMaintenance(): void {
  maintenance = false;
}

/** Test seam: the flag alone, without the side effects, and an empty slot. */
export function __resetBackupJobForTests(options: { maintenance?: boolean } = {}): void {
  maintenance = options.maintenance ?? false;
  running = false;
  current = null;
}
