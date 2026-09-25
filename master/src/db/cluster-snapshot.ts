/**
 * A copy of the database cluster, taken before the first boot of a new build.
 *
 * An update replaces the program and never the data: the cluster lives under
 * the data directory, outside the program folder, and the installer does not
 * know it exists. What an update *does* do to the data is run migrations on
 * the next boot — and a migration is code, written by a person, applied to a
 * company's records with no undo. From 1.2.0 on the rule is that a migration
 * only adds (`master/tests/migration-data-safety.test.ts` fails the build on
 * one that does not), but a rule is a promise and this is the insurance behind
 * it: before the first boot of a version, while the cluster is still stopped,
 * the whole `postgres/` directory is copied beside itself. If the update goes
 * wrong, the operator puts the copy back and reinstalls the previous build,
 * and the company is exactly where it was.
 *
 * Why a file copy and not the encrypted export: the export needs a passphrase
 * somebody types, runs through the application's own tables and is meant for
 * moving a company between machines. This is automatic, needs nothing from
 * anyone and restores by renaming a folder.
 *
 * Why *before the cluster starts*: a running PostgreSQL rewrites its files
 * continuously, and a copy taken underneath it is not guaranteed to be
 * restorable. A stopped cluster copied wholesale — `base/`, `pg_wal/`,
 * `global/`, everything — is exactly what PostgreSQL's own documentation
 * calls a file-system-level backup.
 *
 * Fails **soft**: a snapshot that could not be taken is logged in words and
 * the boot continues, because a Master that refuses to start over a full disk
 * or an odd file system is a shop that cannot take orders, which is a worse
 * outcome than one missing safety copy. The one exception is disk space,
 * which is checked *before* copying so a snapshot never fills the drive the
 * database is about to grow on.
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Under the data directory, beside `postgres/`. */
export const SNAPSHOT_DIR_NAME = 'backups';
const SNAPSHOT_PREFIX = 'before-';
/** `<dataDir>/booted-version` — the version that last completed a boot. */
export const BOOTED_VERSION_FILE = 'booted-version';
/** How many `before-*` copies to keep; older ones are removed after a new one lands. */
export const SNAPSHOTS_KEPT = 2;
/** Headroom the drive must keep after the copy, on top of the copy itself. */
const FREE_SPACE_HEADROOM_BYTES = 256 * 1024 * 1024;

export interface SnapshotLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface SnapshotOptions {
  dataDir: string;
  clusterDir: string;
  /** The build about to boot. */
  version: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Called once, right before the copy starts, so the boot screen can say so. */
  onCopyStart?: () => void;
  /** Test seam for the `postmaster.pid` check. */
  isProcessAlive?: (pid: number) => boolean;
  /** Test seam for the free-space check; bytes available on the data drive. */
  freeBytes?: (dir: string) => Promise<number>;
  log: SnapshotLogger;
}

export type SnapshotOutcome =
  | { kind: 'taken'; path: string }
  | {
      kind: 'skipped';
      reason: 'sameVersion' | 'noCluster' | 'disabled' | 'clusterRunning' | 'noSpace' | 'failed';
    };

export async function readBootedVersion(dataDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, BOOTED_VERSION_FILE), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Record that `version` booted and migrated successfully.
 *
 * Written **after** migrations, never before: the marker means "this version's
 * schema is in place", so a boot that fails half-way leaves the previous
 * version on record and the next attempt takes a fresh copy — which, since
 * the copy is of the still-stopped cluster, costs one more folder and nothing
 * else.
 */
export async function recordBootedVersion(dataDir: string, version: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, BOOTED_VERSION_FILE), `${version}\n`, 'utf8');
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** First line of `postmaster.pid`, or null when there is no such file. */
async function postmasterPid(clusterDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(clusterDir, 'postmaster.pid'), 'utf8');
    const pid = Number.parseInt(raw.split(/\r?\n/)[0] ?? '', 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
    } catch {
      // Gone between listing and stat; a smaller estimate is the safe error.
    }
  }
  return total;
}

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Remove every `before-*` copy but the newest {@link SNAPSHOTS_KEPT}, and any
 * `.partial` folder an interrupted copy left behind.
 *
 * Sorted by name: the stamp is fixed-width and lexically ordered, so no
 * timestamps have to be trusted from the file system.
 */
export async function pruneSnapshots(dataDir: string, keep = SNAPSHOTS_KEPT): Promise<string[]> {
  const root = path.join(dataDir, SNAPSHOT_DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const removed: string[] = [];
  const complete = entries
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && !name.endsWith('.partial'))
    .sort()
    .reverse();

  for (const name of entries.filter((entry) => entry.endsWith('.partial'))) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  for (const name of complete.slice(keep)) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

const README = (version: string, previous: string | null, clusterDir: string): string =>
  [
    `OrderBook database copy, taken automatically before ${version} started for the first time.`,
    `The cluster it copies was last used by ${previous ?? 'a build that did not record its version'}.`,
    '',
    'To go back to it:',
    `  1. Close the Master Panel (File > Quit) and make sure no postgres.exe from it is still running.`,
    `  2. Rename ${clusterDir} to postgres.broken (keep it until you are sure).`,
    `  3. Copy the "postgres" folder beside this file to ${clusterDir}.`,
    `  4. Install the previous version of the Master Panel (${previous ?? 'the one that was running before'}) and start it.`,
    '',
    'This copy is complete on its own. It is not encrypted; it is on the same disk as the live database,',
    'so it protects against a bad update, not against a lost or stolen PC — take the Backup export for that.',
    `OrderBook keeps the newest ${SNAPSHOTS_KEPT} of these copies and removes older ones by itself.`,
    '',
  ].join('\n');

/**
 * Copy the stopped cluster if this build has not booted against it before.
 *
 * Set `ORDERBOOK_UPGRADE_SNAPSHOT=0` to turn it off on a machine that keeps
 * its own backups and cannot spare the disk.
 */
export async function snapshotClusterBeforeUpgrade(
  options: SnapshotOptions,
): Promise<SnapshotOutcome> {
  const { dataDir, clusterDir, version, log } = options;
  const env = options.env ?? process.env;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const freeBytes = options.freeBytes ?? defaultFreeBytes;

  if (env.ORDERBOOK_UPGRADE_SNAPSHOT === '0') {
    log.info('Pre-upgrade database copy is turned off (ORDERBOOK_UPGRADE_SNAPSHOT=0)');
    return { kind: 'skipped', reason: 'disabled' };
  }

  if (!existsSync(path.join(clusterDir, 'PG_VERSION'))) {
    // First run: there is nothing yet to protect.
    return { kind: 'skipped', reason: 'noCluster' };
  }

  const previous = await readBootedVersion(dataDir);
  if (previous === version) return { kind: 'skipped', reason: 'sameVersion' };

  const pid = await postmasterPid(clusterDir);
  if (pid !== null && isAlive(pid)) {
    log.warn(
      `Not copying the database before ${version}: a PostgreSQL process (pid ${pid}) is still ` +
        'running on it, so a copy would not be consistent. Quit the Master Panel completely and ' +
        'start it again to take the copy.',
    );
    return { kind: 'skipped', reason: 'clusterRunning' };
  }

  const root = path.join(dataDir, SNAPSHOT_DIR_NAME);
  const name = `${SNAPSHOT_PREFIX}${version}-${stamp(options.now ?? new Date())}`;
  const partial = path.join(root, `${name}.partial`);
  const final = path.join(root, name);

  try {
    await fs.mkdir(root, { recursive: true });

    // Room for the copy, plus headroom the live database will need afterwards.
    const needed = (await directorySize(clusterDir)) + FREE_SPACE_HEADROOM_BYTES;
    const free = await freeBytes(root);
    if (free < needed) {
      log.warn(
        `Not copying the database before ${version}: it needs about ` +
          `${Math.ceil(needed / 1024 / 1024)} MB free and the drive has ` +
          `${Math.floor(free / 1024 / 1024)} MB. Free some space or take a Backup export by hand.`,
      );
      return { kind: 'skipped', reason: 'noSpace' };
    }

    options.onCopyStart?.();
    log.info(
      `Copying the database to ${final} before ${version} runs its first migrations ` +
        `(previous build: ${previous ?? 'unknown'})`,
    );

    await fs.rm(partial, { recursive: true, force: true });
    await fs.cp(clusterDir, path.join(partial, 'postgres'), {
      recursive: true,
      // A stale pid file from a crash must not travel with the copy: PostgreSQL
      // would refuse to start on the restored folder until somebody deleted it.
      filter: (source) => path.basename(source) !== 'postmaster.pid',
    });
    await fs.writeFile(path.join(partial, 'README.txt'), README(version, previous, clusterDir));
    // Complete copies have no suffix; an interrupted one keeps `.partial` and
    // is removed by the next prune rather than mistaken for a good backup.
    await fs.rename(partial, final);

    const removed = await pruneSnapshots(dataDir);
    if (removed.length > 0) log.info(`Removed older database copies: ${removed.join(', ')}`);

    log.info(`Database copy complete: ${final}`);
    return { kind: 'taken', path: final };
  } catch (error) {
    await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    log.warn(
      `Could not copy the database before ${version}: ${String(error)}. Starting anyway — ` +
        'take a Backup export from Settings before making changes if this worries you.',
    );
    return { kind: 'skipped', reason: 'failed' };
  }
}
