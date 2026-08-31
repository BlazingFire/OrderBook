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
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { PreparedInstaller, ReleaseManifest, UpdateAvailability } from '@orderbook/shared';
import { isNewer } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { appVersion } from '../lib/app-version.js';
import { createLogger } from '../lib/logger.js';
import { loadCredentials } from './credentials.store.js';
import { masterFetch } from '../lib/master-fetch.js';
import { verifyManifest } from '../lib/release-signature.js';

const log = createLogger('updates');

/** Long enough for a slow LAN, short enough that a dead Master is not a hang. */
const METADATA_TIMEOUT_MS = 10_000;

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly code: 'unpaired' | 'unreachable' | 'noRelease' | 'checksum' | 'untrusted',
  ) {
    super(message);
  }
}

/** Refuse early and by name, so "not paired" never reads as "no update". */
async function assertPaired(): Promise<void> {
  if (!(await loadCredentials())) {
    throw new UpdateError('This panel is not paired with a Master yet', 'unpaired');
  }
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

  await assertPaired();

  let payload: UpdateAvailability;
  try {
    // `masterFetch`, so the request carries this panel's pairing credentials.
    // The route refuses a stranger now, which is half of why the answer below
    // is worth anything.
    const response = await masterFetch('/api/updates/office/latest', {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Master answered ${response.status}`);
    payload = (await response.json()) as UpdateAvailability;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('Could not reach the Master Panel to ask about updates', 'unreachable');
  }

  const manifest = payload.available;
  if (!manifest)
    return { current: running, available: null, reason: payload.reason ?? 'noRelease' };

  /*
   * Verified here, on the panel, not merely at the Master.
   *
   * The Master relays this manifest; it does not vouch for it, and a panel that
   * trusted the relay would be trusting whoever is answering on that address.
   * The signature is checked against keys compiled into *this* build, before
   * the version comparison and long before anything is written to disk — so a
   * forged manifest cannot even get as far as looking newer.
   */
  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    log.error(`Refusing office release ${manifest.version}: ${verdict.reason}`);
    throw new UpdateError(
      'The update the Master offered is not signed by a key this panel trusts',
      'untrusted',
    );
  }

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

  // Debris from an attempt that died, cleared before this one starts. Finished
  // installers wait until there is a verified replacement — see the two
  // functions at the bottom of this file.
  await pruneDebris();

  /*
   * Already downloaded and still intact — a retry after a failed install, or a
   * second click, should not re-pull 100 MB over the office network.
   *
   * The size is only the cheap half of that question. This folder is writable
   * by the signed-in operator, the filename is deterministic, and the byte
   * count is published alongside the release — so "right size" was a test
   * anything could pass on purpose. Reuse costs a hash of a local file; being
   * wrong costs an installer of somebody else's choosing running with the
   * elevation the operator is about to grant.
   */
  try {
    const existing = await stat(target);
    if (
      existing.size === available.sizeBytes &&
      (await digestOf(target)) === available.sha256.toLowerCase()
    ) {
      log.info(`Reusing already-downloaded ${available.file}`);
      await pruneOldDownloads(path.basename(target));
      remember(target, available);
      return { path: target, manifest: available };
    }
  } catch {
    // Not there yet, or unreadable. Fall through and fetch it.
  }

  const response = await masterFetch('/api/updates/office/download');
  if (!response.ok || !response.body) {
    throw new UpdateError('The Master would not send the update file', 'unreachable');
  }

  /*
   * Download to `.part` and rename, rather than writing the final name.
   *
   * Two faults, one fix. This used to stream straight into the name the shell's
   * allowlist accepts, so a process killed mid-download left a truncated 100 MB
   * file that looks in every way like a finished installer — only the digest
   * check at launch stood between it and being run, and nothing removed it. And
   * because `createWriteStream` truncates before the first byte arrives, a
   * re-download that then failed destroyed a perfectly good installer that was
   * already on disk.
   *
   * A rename is atomic, so the final name only ever exists once the bytes are
   * all there and have been checked. This is the same temp-then-rename the
   * Master uses for its own downloads and `writeDurable` uses for documents.
   */
  const partial = `${target}.part`;
  await rm(partial, { force: true }).catch(() => undefined);

  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => hash.update(chunk));

  try {
    await pipeline(source, createWriteStream(partial));
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    log.error(`Could not download ${available.file}: ${String(error)}`);
    throw new UpdateError('The update file did not download completely', 'unreachable');
  }

  const digest = hash.digest('hex');
  if (digest !== available.sha256.toLowerCase()) {
    await rm(partial, { force: true });
    log.error(`Discarded ${available.file}: expected ${available.sha256}, got ${digest}`);
    throw new UpdateError(
      'The downloaded file did not match its checksum, so it was discarded',
      'checksum',
    );
  }

  await rename(partial, target);

  log.info(`Downloaded ${available.file} (${available.version})`);
  await pruneOldDownloads(path.basename(target));
  remember(target, available);
  return { path: target, manifest: available };
}

/**
 * Hash a file already on disk.
 *
 * Separate from the streaming hash above because that one checks bytes as they
 * arrive off the wire, and this one checks bytes that have been sitting in a
 * writable folder since.
 */
async function digestOf(file: string): Promise<string> {
  const hash = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });

  return hash.digest('hex');
}

/**
 * The last setup file this process verified, for the shell to ask about over
 * loopback. In memory on purpose: it describes this run, and a restart should
 * forget it. The shell re-hashes before running anything regardless.
 */
let prepared: PreparedInstaller | null = null;

function remember(file: string, manifest: ReleaseManifest): void {
  prepared = { path: file, sha256: manifest.sha256.toLowerCase(), version: manifest.version };
}

export function preparedInstaller(): PreparedInstaller | null {
  return prepared;
}

/**
 * Delete every installer in the updates folder except the one just proved good.
 *
 * These are ~100 MB each and nothing else ever removes them, so a panel that
 * has taken four updates is holding 400 MB of files it will never open again.
 *
 * Runs only once there is a **verified** installer to keep, because until then
 * the old one is the only thing on this panel anybody could still install. The
 * debris a failed attempt leaves is a different question with a different
 * answer — see `pruneDebris`, which runs first and unconditionally.
 *
 * Failures are swallowed on purpose: on Windows a running installer holds a
 * lock on its own file, and refusing to complete an update because last
 * month's setup file is busy would be a worse outcome than the disk space.
 */
/**
 * Delete half-written downloads before starting a new one.
 *
 * A `.part` is by definition the residue of an attempt that did not finish:
 * this panel never reads one, never installs one, and never serves one. So
 * unlike a finished installer it can be removed at any time, and it has to be
 * removed by *something* — the failure path that created it may have been a
 * power cut, which runs no cleanup at all.
 *
 * Keyed to the suffix rather than the filename on purpose. Every name in this
 * folder carries a version, so a `.part` left by 1.9.9 is invisible to any
 * cleanup that only knows about the version being fetched today.
 */
async function pruneDebris(): Promise<void> {
  try {
    for (const entry of await readdir(updatesDir())) {
      if (!entry.endsWith('.part')) continue;
      await rm(path.join(updatesDir(), entry), { force: true }).catch(() => {});
    }
  } catch {
    // No folder, or unreadable. Nothing to prune either way.
  }
}

async function pruneOldDownloads(keep: string): Promise<void> {
  try {
    for (const entry of await readdir(updatesDir())) {
      if (entry === keep) continue;
      await rm(path.join(updatesDir(), entry), { force: true, recursive: true }).catch(() => {});
    }
  } catch {
    // No folder, or unreadable. Nothing to prune either way.
  }
}
