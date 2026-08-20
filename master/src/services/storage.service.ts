/**
 * Disk usage attributable to this application, for the Master's Storage screen.
 * Reports the database cluster and the uploads folder separately so an operator
 * can tell which one is growing.
 */

import { statfs } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StorageUsage } from '@orderbook/shared';

import { config } from '../config/index.js';

const statfsAsync = promisify(statfs);

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

async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfsAsync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
