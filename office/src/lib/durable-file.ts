/**
 * Write a file so a power cut cannot lose it: temp, fsync, rename.
 *
 * Without the fsync the rename can reach the disk before the contents do, and the
 * file comes back empty after a power cut. A file written straight over itself is
 * worse: a crash mid-write loses the old contents as well. For the files an Office
 * cannot get back from the Master: queued changes, the pairing, the device's id
 * counter. Not for the snapshot, which is large, rewritten often, and comes back
 * from the Master.
 *
 * Writes to one file run in order, because they share a temp name. Windows refuses
 * a rename for a moment while an antivirus scan holds the file, so that is retried.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const chains = new Map<string, Promise<unknown>>();

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

async function writeNow(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });

  const handle = await fs.open(temporary, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }

  await renameWithRetry(temporary, file);
}

export function writeDurable(file: string, text: string): Promise<void> {
  const write = (chains.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => writeNow(file, text));
  chains.set(file, write);
  return write;
}
