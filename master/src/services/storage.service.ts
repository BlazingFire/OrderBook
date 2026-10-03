/**
 * Disk usage attributable to this application, for the Master's Storage screen.
 * Reports the database cluster and the uploads folder separately so an operator
 * can tell which one is growing.
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StorageUsage } from '@orderbook/shared';

import { config } from '../config/index.js';

const statfsAsync = promisify(statfs);
const execFileAsync = promisify(execFile);

export async function getStorageUsage(): Promise<StorageUsage> {
  const [databaseBytes, uploadsBytes, diskFreeBytes] = await Promise.all([
    directorySize(config.database.clusterDir),
    directorySize(config.uploadsDir),
    freeDiskBytes(config.dataDir),
  ]);

  return {
    databaseBytes,
    uploadsBytes,
    totalBytes: databaseBytes + uploadsBytes,
    diskFreeBytes,
  };
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(entryPath)).size;
      } catch {
        // A file can vanish mid-walk (Postgres rotates WAL segments); skip it.
      }
    }
  }

  return total;
}

/** Free bytes on the drive holding `dir`, or `null` when it cannot be read. */
export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfsAsync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * The file system of the drive holding `dir` as Windows names it (`NTFS`,
 * `exFAT`, `FAT32`), or `null` when it cannot be told: off Windows, or when
 * PowerShell does not answer.
 *
 * Through PowerShell's `Get-Volume -FilePath`, because `wmic` is no longer
 * installed by default on Windows 11 24H2 and the Master is Windows 10 or
 * later, where the cmdlet always exists. The path travels in an environment
 * variable rather than the command text, so no character in it is parsed.
 */
export async function volumeFileSystem(dir: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Volume -FilePath $env:ORDERBOOK_VOLUME_PATH).FileSystem'],
      { env: { ...process.env, ORDERBOOK_VOLUME_PATH: dir }, timeout: 15_000, windowsHide: true },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
