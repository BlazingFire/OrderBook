/**
 * Follow the Master's one backup or restore job (`backup-job.ts`) until it
 * finishes.
 *
 * The job runs on the server; the screen only polls it, every half second.
 * A failed poll is not a failed job: during a restore the API answers 503
 * while the database is rebuilt, and a poll can also land while the server is
 * busy. So a failed read is ignored and the next one tried, and only the job's
 * own `done` or `failed` stops the polling.
 *
 * On mount it also reads once, so a job already running (an automatic backup,
 * or one started before the screen was left) is shown rather than hidden.
 *
 * `read` is held in a ref, so a caller may pass a fresh closure every render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackupJobPhase, BackupJobStatus, MessageKey } from '@orderbook/shared';
import { t } from '@orderbook/ui';

const POLL_MS = 500;

export function isJobFinished(job: BackupJobStatus | null): boolean {
  return job === null || job.phase === 'done' || job.phase === 'failed';
}

export function useBackupJob(read: () => Promise<BackupJobStatus | null>): {
  job: BackupJobStatus | null;
  /** Start following a job the caller has just started. */
  follow: (job: BackupJobStatus) => void;
} {
  const readRef = useRef(read);
  readRef.current = read;
  const [job, setJob] = useState<BackupJobStatus | null>(null);

  useEffect(() => {
    let stopped = false;
    readRef
      .current()
      .then((current) => {
        if (!stopped && current && !isJobFinished(current)) setJob(current);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, []);

  const running = !isJobFinished(job);
  const id = job?.id ?? null;

  useEffect(() => {
    if (!running) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      timer = setTimeout(() => {
        readRef.current().then(
          (next) => {
            if (stopped) return;
            // Null: the server restarted and the job went with it.
            setJob(next);
            if (next && !isJobFinished(next)) poll();
          },
          () => {
            if (!stopped) poll();
          },
        );
      }, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, id]);

  const follow = useCallback((started: BackupJobStatus) => setJob(started), []);

  return { job, follow };
}

/**
 * What a phase is called on screen. Written out as a map of keys, not built
 * from the phase, so each key is checked against the catalogue.
 */
const PHASE_KEY: Record<BackupJobPhase, MessageKey> = {
  preparing: 'backupAll.phase.preparing',
  data: 'backupAll.phase.data',
  photos: 'backupAll.phase.photos',
  verifying: 'backupAll.phase.verifying',
  checking: 'backupAll.phase.checking',
  database: 'backupAll.phase.database',
  upgrading: 'backupAll.phase.upgrading',
  finishing: 'backupAll.phase.finishing',
  done: 'backupAll.phase.done',
  failed: 'backupAll.phase.failed',
};

export function phaseLabel(phase: BackupJobPhase): string {
  return t(PHASE_KEY[phase]);
}
