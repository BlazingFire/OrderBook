/**
 * App updates for an Office Panel — asking the Master, over the LAN it is
 * already paired to.
 *
 * The office build is published once, on the Master, and every panel pulls it
 * from there. That is the whole point: without it, updating five office PCs
 * means walking to five office PCs with a USB stick, and in practice means
 * they stay on last year's build.
 *
 * Plain HTTP to `masterBaseUrl`, not a socket command. The download is 100 MB
 * of installer and belongs in a streamed response rather than a Socket.IO
 * acknowledgement, and the panel already builds that URL to open its socket —
 * so this adds a call, not a channel.
 *
 * **Nothing here runs anything.** It downloads, it checks the file is
 * byte-for-byte what the Master said, and it hands back a path. Launching the
 * installer and quitting is the desktop shell's job, because the thing being
 * replaced is the program this process is running from.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ReleaseManifest, UpdateAvailability } from '@orderbook/shared';
import { isNewer } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { appVersion } from '../lib/app-version.js';
import { createLogger } from '../lib/logger.js';
import { loadCredentials, masterBaseUrl } from './credentials.store.js';

const log = createLogger('updates');

/** Long enough for a slow LAN, short enough that a dead Master is not a hang. */
const METADATA_TIMEOUT_MS = 10_000;

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly code: 'unpaired' | 'unreachable' | 'noRelease' | 'checksum',
  ) {
    super(message);
  }
}

async function masterUrl(suffix: string): Promise<string> {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new UpdateError('This panel is not paired with a Master yet', 'unpaired');
  }
  return `${masterBaseUrl(credentials)}${suffix}`;
}

/**
 * What the Master is offering, judged against what this panel is running.
 *
 * The Master answers with its own view of the office release and a placeholder
 * `current`; the comparison against *this* panel's version happens here,
 * because the Master does not know which build this particular panel has until
 * the panel's next five-minute report — and an update screen should not have
 * to wait for one.
 */
export async function availableUpdate(): Promise<UpdateAvailability> {
  const running = appVersion();

  let payload: UpdateAvailability;
  try {
    const response = await fetch(await masterUrl('/api/updates/office/latest'), {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Master answered ${response.status}`);
    payload = (await response.json()) as UpdateAvailability;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      'Could not reach the Master Panel to ask about updates',
      'unreachable',
    );
  }

  const manifest = payload.available;
  if (!manifest) return { current: running, available: null, reason: payload.reason ?? 'noRelease' };
  if (!isNewer(manifest.version, running)) {
    return { current: running, available: null, reason: 'upToDate' };
  }

  return { current: running, available: manifest };
}

/**
 * The one folder this panel downloads installers into.
 *
 * Exported because the desktop shell will only run a setup file from inside
 * it, and it learns the path from this panel's own health route. Having
 * `downloadPath` call this rather than rebuilding the join is the point: the
 * allowlist and the download target cannot drift apart.
 */
export function updatesDir(): string {
  return path.join(paths().dataDir, 'updates');
}

function downloadPath(manifest: ReleaseManifest): string {
  return path.join(updatesDir(), path.basename(manifest.file));
}

/**
 * Fetch the installer and prove it is intact before anybody can run it.
 *
 * Hashed while writing rather than in a second pass over the file: a 100 MB
 * re-read on a shop PC's disk is a wait a person is watching, and the bytes
 * are already going past.
 *
 * A file that fails the check is **deleted**, not left in place. A rejected
 * installer sitting in a folder is exactly the file somebody double-clicks
 * next week wondering why the update never worked.
 */
export async function downloadUpdate(): Promise<{ path: string; manifest: ReleaseManifest }> {
  const { available } = await availableUpdate();
  if (!available) throw new UpdateError('There is no newer version to install', 'noRelease');

  const target = downloadPath(available);
  await mkdir(path.dirname(target), { recursive: true });

  // Already downloaded and still intact — a retry after a failed install, or a
  // second click, should not re-pull 100 MB over the office network.
  try {
    const existing = await stat(target);
    if (existing.size === available.sizeBytes) {
      log.info(`Reusing already-downloaded ${available.file}`);
      return { path: target, manifest: available };
    }
  } catch {
    // Not there yet. Fall through and fetch it.
  }

  const response = await fetch(await masterUrl('/api/updates/office/download'));
  if (!response.ok || !response.body) {
    throw new UpdateError('The Master would not send the update file', 'unreachable');
  }

  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => hash.update(chunk));

  await pipeline(source, createWriteStream(target));

  const digest = hash.digest('hex');
  if (digest !== available.sha256.toLowerCase()) {
    await rm(target, { force: true });
    log.error(`Discarded ${available.file}: expected ${available.sha256}, got ${digest}`);
    throw new UpdateError(
      'The downloaded file did not match its checksum, so it was discarded',
      'checksum',
    );
  }

  log.info(`Downloaded ${available.file} (${available.version})`);
  return { path: target, manifest: available };
}
