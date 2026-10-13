/**
 * The shell's memory of an app update (1.5), in `update-run.json` in its own
 * folder: written just before the installer starts, settled by the next start
 * once the panel answers. It is what lets the new version say "updated from
 * 1.4.9 to 1.5.0 in 1 min 42 s", and what the next update's screen uses as its
 * estimate for the part nobody can watch — the silent setup, after this window
 * has closed.
 *
 * The shape is `UpdateRunFile` in `shared/src/domain/update-run.ts`. The shell
 * ships without `node_modules`, so it is repeated here; the test holds the two
 * equal.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface UpdateRunRecord {
  from: string;
  to: string;
  outcome: 'updated' | 'notInstalled';
  startedAt: string;
  finishedAt: string;
  seconds: number | null;
}

export interface UpdateRunFile {
  pending: { from: string; to: string; startedAt: string } | null;
  last: UpdateRunRecord | null;
  installSeconds: number | null;
}

export const EMPTY_UPDATE_RUN: UpdateRunFile = { pending: null, last: null, installSeconds: null };

/**
 * A measured install longer than this is not an install time: the PC was
 * switched off with the setup half done, or nobody started it again until the
 * morning. It is still reported, but never becomes the next estimate.
 */
export const MAX_ESTIMATE_SECONDS = 30 * 60;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function readRecord(value: unknown): UpdateRunRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !isText(record.from) ||
    !isText(record.to) ||
    !isText(record.startedAt) ||
    !isText(record.finishedAt)
  ) {
    return null;
  }
  if (record.outcome !== 'updated' && record.outcome !== 'notInstalled') return null;
  return {
    from: record.from,
    to: record.to,
    outcome: record.outcome,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    seconds:
      typeof record.seconds === 'number' && Number.isFinite(record.seconds) ? record.seconds : null,
  };
}

/** Absent or corrupt reads as empty: nothing worse than a notice not shown. */
export function readUpdateRun(file: string): UpdateRunFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_UPDATE_RUN };
    const data = parsed as Record<string, unknown>;
    const pending = data.pending as Record<string, unknown> | null | undefined;
    return {
      pending:
        pending && isText(pending.from) && isText(pending.to) && isText(pending.startedAt)
          ? { from: pending.from, to: pending.to, startedAt: pending.startedAt }
          : null,
      last: readRecord(data.last),
      installSeconds:
        typeof data.installSeconds === 'number' &&
        Number.isFinite(data.installSeconds) &&
        data.installSeconds > 0
          ? data.installSeconds
          : null,
    };
  } catch {
    return { ...EMPTY_UPDATE_RUN };
  }
}

/** Temp-then-rename, as `settings.ts` does. A failed write never stops an update. */
export function writeUpdateRun(file: string, run: UpdateRunFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // Only the notice and the estimate are lost.
  }
}

/** The hand-over: the installer is about to start. */
export function beginUpdateRun(
  run: UpdateRunFile,
  from: string,
  to: string,
  now: Date,
): UpdateRunFile {
  return { ...run, pending: { from, to, startedAt: now.toISOString() } };
}

/** The installer did not start after all; nothing to settle. */
export function abandonUpdateRun(run: UpdateRunFile): UpdateRunFile {
  return { ...run, pending: null };
}

/**
 * The first start after a hand-over, once the panel answers: did it install?
 * `running` is this program's own version. `null` when there is nothing to
 * settle.
 */
export function settleUpdateRun(
  run: UpdateRunFile,
  running: string,
  now: Date,
): UpdateRunFile | null {
  const { pending } = run;
  if (!pending) return null;
  const started = Date.parse(pending.startedAt);
  const seconds = Number.isFinite(started)
    ? Math.max(0, Math.round((now.getTime() - started) / 1000))
    : null;
  const updated = running === pending.to;
  return {
    pending: null,
    last: {
      from: pending.from,
      to: pending.to,
      outcome: updated ? 'updated' : 'notInstalled',
      startedAt: pending.startedAt,
      finishedAt: now.toISOString(),
      seconds: updated ? seconds : null,
    },
    installSeconds:
      updated && seconds !== null && seconds > 0 && seconds <= MAX_ESTIMATE_SECONDS
        ? seconds
        : run.installSeconds,
  };
}

/** The line the shell's own splash shows while the new version starts, or `null`. */
export function finishingLine(run: UpdateRunFile, running: string): string | null {
  return run.pending && run.pending.to === running ? `Finishing the update to ${running}…` : null;
}
