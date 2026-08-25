/**
 * Disk I/O for rendered documents and their assets.
 *
 * Lives in `lib/` rather than `repositories/` deliberately: that layer's rule
 * is about Knex, and nothing here touches a database.
 *
 * **Temp → fsync → rename**, mirroring the Office outbox's durability
 * convention. The rename is the last act and is atomic on both platforms, so a
 * reader can never observe a half-written PDF. A crash between the write and
 * the database commit leaves a `.tmp` behind and no row —
 * `sweepOrphanTemporaries()` removes those at startup. The reverse (a row with
 * no file) cannot happen, because the file is complete before the transaction
 * opens.
 *
 * **Every path derives from config plus a server-minted UUID, never from
 * client input.** A subject id or a filename from a request body never reaches
 * `path.join` here, so there is no traversal to defend against rather than a
 * defence to get right.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config/index.js';
import { createLogger } from './logger.js';

const log = createLogger('documents');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The last line of defence, not the first. Callers already pass a
 * `randomUUID()` they minted themselves; this refuses anything else so a
 * future caller cannot quietly start passing a value that came from a request.
 */
function assertStorageKey(storageKey: string): void {
  if (!UUID_PATTERN.test(storageKey)) {
    throw new Error(`Refusing a storage key that is not a UUID: ${storageKey}`);
  }
}

export function exportPathFor(storageKey: string): string {
  assertStorageKey(storageKey);
  return path.join(config.documents.exportsDir, `${storageKey}.pdf`);
}

export function assetPathFor(storageKey: string, extension: 'png' | 'jpg'): string {
  assertStorageKey(storageKey);
  return path.join(config.documents.assetsDir, `${storageKey}.${extension}`);
}

/** Relative to `dataDir`, which is what the database stores — never an absolute path. */
export function relativeToData(absolutePath: string): string {
  return path.relative(config.dataDir, absolutePath).split(path.sep).join('/');
}

export function absoluteFromData(relativePath: string): string {
  return path.join(config.dataDir, relativePath);
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/**
 * Writes bytes durably and returns where they landed.
 *
 * The fsync is the point: without it the rename can be visible while the
 * file's contents are still in the OS page cache, and a power cut between the
 * two leaves a correctly-named empty file that every later read believes.
 */
export async function writeDurable(absolutePath: string, bytes: Buffer): Promise<void> {
  await ensureDir(path.dirname(absolutePath));

  const temporary = `${absolutePath}.tmp`;
  await writeFile(temporary, bytes);

  const handle = await open(temporary, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporary, absolutePath);
}

export async function writeExportFile(storageKey: string, bytes: Buffer): Promise<string> {
  const absolutePath = exportPathFor(storageKey);
  await writeDurable(absolutePath, bytes);
  return relativeToData(absolutePath);
}

export async function writeAssetFile(
  storageKey: string,
  extension: 'png' | 'jpg',
  bytes: Buffer,
): Promise<string> {
  const absolutePath = assetPathFor(storageKey, extension);
  await writeDurable(absolutePath, bytes);
  return relativeToData(absolutePath);
}

/** Reads a stored file by its **database-recorded** relative path. */
export async function readStoredFile(relativePath: string): Promise<Buffer | null> {
  const absolutePath = absoluteFromData(relativePath);

  // The path came from our own row, but a row can outlive its file — an
  // operator moving `data/` between machines and forgetting the documents
  // directory is the ordinary case, not an attack.
  if (!existsSync(absolutePath)) return null;

  return readFile(absolutePath);
}

export async function removeStoredFile(relativePath: string): Promise<void> {
  const absolutePath = absoluteFromData(relativePath);
  try {
    await unlink(absolutePath);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/**
 * Removes `.tmp` files left by a crash between the write and the commit.
 *
 * Runs at startup, when nothing else is writing. A `.tmp` that exists at this
 * moment is by definition debris: a live render renames within milliseconds of
 * writing, and the process that was doing it is no longer running.
 */
export async function sweepOrphanTemporaries(): Promise<number> {
  let removed = 0;

  for (const dir of [config.documents.exportsDir, config.documents.assetsDir]) {
    if (!existsSync(dir)) continue;

    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.tmp')) continue;
      try {
        await unlink(path.join(dir, entry));
        removed += 1;
      } catch (error) {
        log.warn(`Could not remove the orphaned temporary ${entry}`, error);
      }
    }
  }

  if (removed > 0) log.info(`Removed ${removed} orphaned document temporary file(s)`);
  return removed;
}

/** Created at startup so the first render is not also the first `mkdir`. */
export async function ensureDocumentDirectories(): Promise<void> {
  await ensureDir(config.documents.exportsDir);
  await ensureDir(config.documents.assetsDir);
}
