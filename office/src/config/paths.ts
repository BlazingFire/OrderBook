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

import { execFile } from 'node:child_process';
import fsSync, { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { t } from '@orderbook/shared';

import { config } from './index.js';
import { createLogger } from '../lib/logger.js';
import { writeEnvValue } from '../lib/env-file.js';

const log = createLogger('storage');

export interface PanelPaths {
  dataDir: string;
  credentialsFile: string;
  deviceFile: string;
  clockFile: string;
  outboxFile: string;
  /** Writes the Master refused, kept after they leave the outbox. */
  refusalsFile: string;
  snapshotFile: string;
  usersFile: string;
  signInAttemptsFile: string;
  /** Sign-ins checked offline, waiting to be uploaded to the Master's audit trail. */
  offlineAuthEventsFile: string;
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
  refusalsFile: 'refusals.json',
  snapshotFile: 'snapshot.json',
  usersFile: 'users.json',
  signInAttemptsFile: 'sign-in-attempts.json',
  offlineAuthEventsFile: 'offline-auth-events.json',
} as const;

/**
 * Everything an Office Panel's data folder can hold. A folder holding nothing
 * else is already an Office Panel's — see `foreignEntry` for why that matters.
 */
const PANEL_ENTRIES: ReadonlySet<string> = new Set([
  ...Object.values(FILE_NAMES),
  'images',
  'avatars',
  // A downloaded update (`updatesDir()` in `services/update.service.ts`).
  'updates',
  // The desktop shell's log and its one setting (`logPath` and `settingsPath`
  // in `electron/shell.ts`).
  'logs',
  'shell.json',
  // What Finder and Explorer leave in any folder somebody has opened.
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

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
    refusalsFile: path.join(dataDir, FILE_NAMES.refusalsFile),
    snapshotFile: path.join(dataDir, FILE_NAMES.snapshotFile),
    usersFile: path.join(dataDir, FILE_NAMES.usersFile),
    signInAttemptsFile: path.join(dataDir, FILE_NAMES.signInAttemptsFile),
    offlineAuthEventsFile: path.join(dataDir, FILE_NAMES.offlineAuthEventsFile),
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
 * The same person cannot see what else is in the folder they typed, which is
 * why a move only goes somewhere this panel can own outright — never the top
 * of a drive, a home folder, or a folder already holding somebody else's files
 * (`foreignEntry`). The folder a move lands in is the one "Uninstall, delete
 * data" deletes, whole (`tools/uninstall/`, which reads it from the shell's
 * pointer), so a panel moved into `D:\` or somebody's Documents would one day
 * take everything else in it along with the panel's own files. What this
 * cannot stop is somebody saving their own files into the folder afterwards;
 * an uninstaller that deleted only the panel's own entries would be the answer
 * to that, and it is `tools/uninstall/`'s to give.
 *
 * The order — copy, then record the new folder where the next start will read
 * it, then switch — is what keeps a failure harmless: a copy that fails leaves
 * the panel running on the old folder, and a record that cannot be written
 * leaves duplicate files at the target and the panel still working, and still
 * starting, on the old one.
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

  // Ahead of the nesting rule, which also turns these down whenever the data
  // is on the same drive or under the same home — but not `D:\` with the data
  // on `C:`, and the reason should read the same either way.
  if (path.dirname(resolved) === resolved) {
    throw new StorageRelocationError(t('en', 'storage.refused.driveRoot', { folder: resolved }));
  }
  // `path.relative`, not `===`: on Windows it compares without regard to case,
  // and `c:\users\asha` is the same folder as `C:\Users\Asha`.
  if (path.relative(os.homedir(), resolved) === '') {
    throw new StorageRelocationError(t('en', 'storage.refused.homeFolder', { folder: resolved }));
  }

  // Nesting either way turns the copy into a walk over its own output.
  if (isInside(resolved, previousDataDir) || isInside(previousDataDir, resolved)) {
    throw new StorageRelocationError(
      'Choose a folder that is not inside the current one, and does not contain it',
    );
  }

  let foreign: string | null;
  try {
    await fs.mkdir(resolved, { recursive: true });
    await fs.access(resolved, constants.W_OK);
    foreign = await foreignEntry(resolved);
  } catch {
    throw new StorageRelocationError(`Cannot write to ${resolved} on this PC`);
  }

  if (foreign !== null) {
    throw new StorageRelocationError(
      t('en', 'storage.refused.notEmpty', { folder: resolved, example: foreign }),
    );
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
  await rememberDataDir(resolved);

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

/**
 * Record the new folder in the one file the next start reads it from.
 *
 * Which file that is depends on what starts this process. Under the desktop
 * shell it is the shell's own pointer, `office-location.json`: the shell reads
 * it before every start of this server (`dataDir()` in `electron/shell.ts`) and
 * passes the answer in as `ORDERBOOK_OFFICE_DATA_DIR` in the real environment,
 * which `loadEnvFiles` never overrides. A move recorded only in the settings
 * file was therefore read and discarded, and the panel came back up in the
 * folder it had left — with everything saved since the move stranded at the new
 * one. The settings file is not written as well: under the shell that value is
 * never read, and a second write would only be a second way for the move to
 * fail.
 *
 * Run from source nothing sets the variable, and `config.settingsFile`
 * (`office/.env`) is where the next start finds it. A variable somebody
 * exported by hand in their terminal still wins over that file, as
 * `loadEnvFiles` promises — that is the folder pinned on purpose.
 */
async function rememberDataDir(dataDir: string): Promise<void> {
  if (!config.locationFile) {
    await writeEnvValue(config.settingsFile, 'ORDERBOOK_OFFICE_DATA_DIR', dataDir);
    return;
  }

  // The shell's format (`writeDataDirOverride` in `electron/lib/settings.ts`),
  // but temp-then-rename like the outbox: the shell reads a torn pointer as
  // "no override", and would start the panel in its *default* folder — neither
  // the one it left nor the one it moved to.
  const temporary = `${config.locationFile}.tmp`;
  await fs.mkdir(path.dirname(config.locationFile), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify({ dataDir }, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, config.locationFile);
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
  return (await diskSpace(dir))?.free ?? null;
}

/**
 * Free and total bytes on the drive holding `dir`, or null when this PC cannot
 * say. Callers treat null as "unknown" and carry on.
 *
 * `fs.statfs` arrived in Node 18.15, and the Windows 7 build runs on Node 16,
 * so it is looked up on the module rather than imported by name: a named
 * import of an export that does not exist fails when the module links, which
 * would stop the whole server from starting. Without it, Windows asks `wmic`,
 * and anything else answers null. One `wmic` run answers both figures, so a
 * caller that wants both asks once.
 */
export async function diskSpace(dir: string): Promise<{ free: number; total: number } | null> {
  try {
    // eslint-disable-next-line no-restricted-properties -- feature-detected on the next line; Node 16 takes the wmic fallback
    const statfs = fsSync.statfs;
    if (typeof statfs === 'function') {
      const stats = await promisify(statfs)(dir);
      return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    }
    if (process.platform !== 'win32') return null;

    // Only a plain drive letter goes into the query, so a UNC path or anything
    // odd answers null rather than reaching `wmic`.
    const drive = path.parse(path.resolve(dir)).root.slice(0, 2);
    if (!/^[A-Za-z]:$/.test(drive)) return null;

    const { stdout } = await promisify(execFile)(
      'wmic',
      [
        'logicaldisk',
        'where',
        `DeviceID='${drive.toUpperCase()}'`,
        'get',
        'FreeSpace,Size',
        '/value',
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    return parseWmicDisk(stdout);
  } catch {
    return null;
  }
}

/**
 * Reads `wmic logicaldisk ... get FreeSpace,Size /value`, whose answer is
 * `FreeSpace=<n>` and `Size=<n>` on lines of their own. Null unless both are
 * there and are whole numbers.
 */
export function parseWmicDisk(text: string): { free: number; total: number } | null {
  const free = /^\s*FreeSpace=(\d+)\s*$/m.exec(text)?.[1];
  const total = /^\s*Size=(\d+)\s*$/m.exec(text)?.[1];
  if (free === undefined || total === undefined) return null;
  return { free: Number(free), total: Number(total) };
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

/**
 * The first thing in `dir` that is not an Office Panel's, or null when there is
 * nothing else there — an empty or new folder, or one a panel has used before
 * (the folder this panel moved away from last time keeps its copy).
 *
 * The rule is "nothing but ours" rather than "empty" so that moving back, or
 * onto a folder another Office Panel left, still works; and rather than a list
 * of places to avoid, because nobody can list every folder that holds a
 * company's other files. A temp file left by a write that was cut off
 * (`outbox.json.tmp`) counts as the file it was on its way to becoming, and a
 * queue set aside as unreadable (`outbox.json.unreadable-…`, `setAside` in
 * `sync/outbox.store.ts`) as the file it was.
 */
async function foreignEntry(dir: string): Promise<string | null> {
  const names = (await fs.readdir(dir)).sort();
  const ours = (name: string): boolean =>
    PANEL_ENTRIES.has(name) || PANEL_ENTRIES.has(name.replace(/\.(tmp|unreadable-[^.]+)$/, ''));

  return names.find((name) => !ours(name)) ?? null;
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
