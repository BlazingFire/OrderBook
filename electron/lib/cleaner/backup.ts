/**
 * Copying the data folders somewhere safe before they are erased.
 *
 * A plain recursive file copy, deliberately, rather than the Master's own
 * backup service. That service produces a smaller, restorable archive — but it
 * needs the Master running and its database up, and the machines that need
 * this tool are the ones where that is not true. A folder copy works on a PC
 * whose install is broken beyond starting, which is the whole point.
 *
 * It is not a substitute for a real backup and the window says so: a copy of a
 * PostgreSQL cluster taken while the server is running can be inconsistent.
 * The tool stops every OrderBook process before it copies, which is what makes
 * it sound in the normal case.
 */

import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface BackupPlan {
  /** Absolute source folder, as the uninstall script named it. */
  readonly from: string;
  /** Where it lands: `<chosen>/<name>`, never the chosen folder itself. */
  readonly to: string;
}

export interface BackupResult {
  readonly copied: BackupPlan[];
  readonly failures: Array<{ readonly from: string; readonly reason: string }>;
}

/**
 * Where each source folder lands under the folder somebody chose.
 *
 * Named after the *panel*, not the leaf: two panels' data folders are both
 * called `master` and `office` on one PC, but a relocated one could be
 * `D:\OrderBookData` and a second could be anything. Colliding leaf names
 * would silently merge two folders into one, so a numbered suffix is added
 * rather than trusted not to happen.
 */
export function planBackup(sources: readonly string[], into: string): BackupPlan[] {
  const used = new Set<string>();

  return sources.map((from) => {
    const base = path.basename(from) || 'data';
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}-${n}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    return { from, to: path.join(into, name) };
  });
}

/**
 * Copy each folder, reporting what failed rather than stopping.
 *
 * One unreadable file must not abandon the rest: the operator is about to
 * erase all of it, and a partial copy of two folders beats a complete copy of
 * none. Every failure is returned, and the caller refuses to continue to the
 * wipe unless somebody has seen them.
 */
export async function runBackup(plans: readonly BackupPlan[]): Promise<BackupResult> {
  const copied: BackupPlan[] = [];
  const failures: BackupResult['failures'] = [];

  for (const plan of plans) {
    try {
      await mkdir(path.dirname(plan.to), { recursive: true });
      // `dereference` so a symlinked data folder is copied as its contents,
      // not as a link into a folder that is about to be deleted.
      await cp(plan.from, plan.to, { recursive: true, dereference: true, force: true });
      copied.push(plan);
    } catch (error) {
      failures.push({ from: plan.from, reason: error instanceof Error ? error.message : 'unknown' });
    }
  }

  return { copied, failures };
}

/** Refuse a destination inside something about to be erased. */
export function isSafeDestination(into: string, sources: readonly string[]): boolean {
  const target = path.resolve(into);
  return !sources.some((source) => {
    const from = path.resolve(source);
    // Equal, or the destination sits under a folder the sweep will remove —
    // either way the backup goes with the thing it was taken from.
    return target === from || target.startsWith(from + path.sep);
  });
}
