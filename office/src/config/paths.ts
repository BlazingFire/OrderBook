/**
 * Where this panel keeps its files — as a live answer, not a frozen one.
 *
 * `config.dataDir` is fixed at import time from `ORDERBOOK_OFFICE_DATA_DIR`,
 * which is right for startup and wrong for the Master's "move this panel's
 * storage" action: every store reading `config.outboxFile` directly would keep
 * writing to the old folder until somebody restarted the process, and the work
 * saved in between would be stranded there. So the stores read `paths()`
 * instead, and relocation is a change to one variable plus a copy.
 *
 * The initial value still comes from `config`, so nothing about a normal start
 * changes — this module is only interesting on the day somebody moves a folder.
 */

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { statfs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from './index.js';
import { createLogger } from '../lib/logger.js';
import { writeEnvValue } from '../lib/env-file.js';

const log = createLogger('storage');
const statfsAsync = promisify(statfs);

export interface PanelPaths {
  dataDir: string;
  credentialsFile: string;
  deviceFile: string;
  clockFile: string;
  outboxFile: string;
  snapshotFile: string;
  usersFile: string;
  signInAttemptsFile: string;
  imagesDir: string;
  /** Cached profile pictures, so the sign-in screen has faces while offline. */
  avatarsDir: string;
}

/** Files the panel owns, by the name they keep inside the data folder. */
const FILE_NAMES = {
  credentialsFile: 'pairing.json',
  deviceFile: 'device.json',
  clockFile: 'clock.json',
  outboxFile: 'outbox.json',
  snapshotFile: 'snapshot.json',
  usersFile: 'users.json',
  signInAttemptsFile: 'sign-in-attempts.json',
} as const;

/**
 * Set only by a relocation. Null means "whatever the environment configured",
 * read fresh on every call rather than captured at import: `config` is a live
 * object, and a module that snapshots it at load time answers with a stale
 * path for the rest of the process.
 */
let relocatedTo: string | null = null;

function currentDataDir(): string {
  return relocatedTo ?? config.dataDir;
}

export function paths(): PanelPaths {
  const dataDir = currentDataDir();

  return {
    dataDir,
    credentialsFile: path.join(dataDir, FILE_NAMES.credentialsFile),
    deviceFile: path.join(dataDir, FILE_NAMES.deviceFile),
    clockFile: path.join(dataDir, FILE_NAMES.clockFile),
    outboxFile: path.join(dataDir, FILE_NAMES.outboxFile),
    snapshotFile: path.join(dataDir, FILE_NAMES.snapshotFile),
    usersFile: path.join(dataDir, FILE_NAMES.usersFile),
    signInAttemptsFile: path.join(dataDir, FILE_NAMES.signInAttemptsFile),
    imagesDir: path.join(dataDir, 'images'),
    avatarsDir: path.join(dataDir, 'avatars'),
  };
}

export class StorageRelocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageRelocationError';
  }
}

export interface RelocationResult {
  dataDir: string;
  previousDataDir: string;
  filesMoved: number;
  bytesMoved: number;
  diskFreeBytes: number | null;
}

/**
 * Point this panel's storage at another folder on this PC.
 *
 * Everything that can be checked is checked *before* anything moves, and the
 * old folder is left where it is afterwards. Both are deliberate: this runs
 * unattended, triggered from a Master on another machine by somebody who
 * cannot see this screen, so a half-finished move with the original deleted
 * would be unrecoverable from where they are standing. Cleaning up the old
 * folder is a decision for whoever is sitting at this PC.
 *
 * The order — copy, then persist the environment, then switch — is what keeps
 * a failure harmless: a copy that fails leaves the panel running on the old
 * folder, and an `.env` that cannot be written leaves duplicate files at the
 * target and the panel still working.
 */
export async function relocateDataDir(
  target: string,
  options: { moveExisting: boolean },
): Promise<RelocationResult> {
  const previousDataDir = currentDataDir();
  const resolved = path.resolve(target);

  if (resolved === previousDataDir) {
    throw new StorageRelocationError('This panel already keeps its files there');
  }

  // Nesting either way turns the copy into a walk over its own output.
  if (isInside(resolved, previousDataDir) || isInside(previousDataDir, resolved)) {
    throw new StorageRelocationError(
      'Choose a folder that is not inside the current one, and does not contain it',
    );
  }

  try {
    await fs.mkdir(resolved, { recursive: true });
    await fs.access(resolved, constants.W_OK);
  } catch {
    throw new StorageRelocationError(`Cannot write to ${resolved} on this PC`);
  }

  const [needed, free] = await Promise.all([
    options.moveExisting ? directorySize(previousDataDir) : Promise.resolve(0),
    freeDiskBytes(resolved),
  ]);

  if (free !== null && needed > free) {
    throw new StorageRelocationError(
      `That drive has ${formatBytes(free)} free and this panel needs ${formatBytes(needed)}`,
    );
  }

  let filesMoved = 0;
  if (options.moveExisting) {
    filesMoved = await copyTree(previousDataDir, resolved);
  }

  // Written before the switch so a restart lands where this run just moved to.
  //
  // `config.settingsFile`, not `packageRoot/.env`: once this panel is installed
  // under Program Files the package folder is read-only, and this write is the
  // one that decides where the panel looks on its next start. Writing it
  // somewhere unwritable would move the files and then forget it had.
  await writeEnvValue(config.settingsFile, 'ORDERBOOK_OFFICE_DATA_DIR', resolved);

  relocatedTo = resolved;
  log.warn(`Storage moved to ${resolved} (${filesMoved} files, was ${previousDataDir})`);

  return {
    dataDir: resolved,
    previousDataDir,
    filesMoved,
    bytesMoved: options.moveExisting ? needed : 0,
    diskFreeBytes: await freeDiskBytes(resolved),
  };
}

/** Bytes the data folder occupies. 0 when it does not exist yet. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // A file can vanish mid-walk — the image cache rewrites itself.
      }
    }
  }

  return total;
}

/** How many files sit under a folder, for the image-cache count. */
export async function countFiles(dir: string): Promise<number> {
  let total = 0;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }

  return total;
}

export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfsAsync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function totalDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfsAsync(dir);
    return stats.blocks * stats.bsize;
  } catch {
    return null;
  }
}

/** Test seam: drops any relocation, back to whatever the environment configured. */
export function resetPathsForTest(): void {
  relocatedTo = null;
}

async function copyTree(from: string, to: string): Promise<number> {
  let copied = 0;

  let entries;
  try {
    entries = await fs.readdir(from, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(destination, { recursive: true });
      copied += await copyTree(source, destination);
    } else if (entry.isFile()) {
      // 0o600 on the originals is the point of `copyFile` over a read/write
      // pair: the pairing secret and the offline verifiers must not land at
      // the new path world-readable.
      await fs.copyFile(source, destination);
      await fs.chmod(destination, 0o600).catch(() => {});
      copied += 1;
    }
  }

  return copied;
}

/** True when `candidate` sits at or under `parent`. */
function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
