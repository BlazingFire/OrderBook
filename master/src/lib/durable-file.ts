/**
 * A durable file write: **temp → fsync → rename**, mirroring the Office
 * outbox's convention.
 *
 * Lives in `lib/` rather than `repositories/` deliberately: that layer's rule
 * is about Knex, and nothing here touches a database.
 *
 * The rename is the last act and is atomic on both platforms, so a reader can
 * never observe a half-written file. A crash between the write and the rename
 * leaves a `.tmp` beside the target and nothing at the target's own name.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/** Force a file's contents out of the OS page cache and onto the disk. */
export async function syncFile(absolutePath: string): Promise<void> {
  const handle = await open(absolutePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes bytes durably at `absolutePath`.
 *
 * The fsync is the point: without it the rename can be visible while the
 * file's contents are still in the OS page cache, and a power cut between the
 * two leaves a correctly-named empty file that every later read believes.
 */
export async function writeDurable(
  absolutePath: string,
  bytes: Buffer,
  options: { mode?: number } = {},
): Promise<void> {
  await ensureDir(path.dirname(absolutePath));

  const temporary = `${absolutePath}.tmp`;
  await writeFile(temporary, bytes, options);
  await syncFile(temporary);
  await rename(temporary, absolutePath);
}
