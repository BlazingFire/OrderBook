/**
 * App updates — reading the releases folder and deciding what is on offer.
 *
 * `docs/PROJECT_PLAN.md` §12 carried this as an open question for months:
 * *"How a new build should actually reach the machines."* The answer is a
 * folder, not a feed. This network has no internet by design, so there is no
 * update server to poll and inventing one would mean running a second service
 * on the shop floor for no benefit. An operator copies a setup file into
 * `C:\OrderBook-Releases\{master,office}-panel\`, and:
 *
 *  - the **Master** finds its own build there and offers to install it;
 *  - a paired **Office Panel** asks the Master over the LAN it is already
 *    connected to, downloads the office build, and installs that.
 *
 * Nothing here executes anything. This service reads, verifies and describes;
 * running an installer is the desktop shell's job, because that process is the
 * one that can quit to let a setup file replace the files underneath it.
 *
 * **Every path here fails soft.** A missing folder, an unreadable manifest, a
 * setup file that has been deleted out from under its manifest — each resolves
 * to "nothing to install" with a named reason, never a thrown error. A broken
 * releases folder must not be able to take down the Updates screen, let alone
 * the Master.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  PanelKind,
  PreparedInstaller,
  ReleaseManifest,
  UpdateAvailability,
} from '@orderbook/shared';
import { isNewer } from '@orderbook/shared';

import { config } from '../config/index.js';
import { appVersion } from '../lib/app-version.js';
import { createLogger } from '../lib/logger.js';
import { verifyManifest } from '../lib/release-signature.js';
import { syncFromGitHub } from './github-releases.js';
import { ValidationError } from '../lib/errors.js';

const log = createLogger('updates');

const FOLDER: Record<PanelKind, string> = {
  master: 'master-panel',
  office: 'office-panel',
};

export function releaseDirFor(panel: PanelKind): string {
  return path.join(config.releasesDir, FOLDER[panel]);
}

/**
 * The setup file a manifest names, resolved against its own folder.
 *
 * `path.basename` is not decoration: `file` comes out of a JSON file on disk,
 * and a manifest carrying `..\..\Windows\System32\something.exe` must resolve
 * inside the releases folder or not at all. The releases folder is operator
 * territory rather than attacker territory, but this value flows into a
 * download route and eventually into a process launch, and neither of those is
 * a place to start trusting a string because of where it came from.
 */
export function releaseFileFor(panel: PanelKind, manifest: ReleaseManifest): string {
  return path.join(releaseDirFor(panel), path.basename(manifest.file));
}

function isManifest(value: unknown): value is ReleaseManifest {
  const candidate = value as Partial<ReleaseManifest> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.version === 'string' &&
    typeof candidate.file === 'string' &&
    typeof candidate.sha256 === 'string' &&
    typeof candidate.sizeBytes === 'number'
  );
}

/**
 * Read `latest.json` for one panel, or `null` when there is nothing readable.
 *
 * The manifest is only believed once the file it names is confirmed present at
 * the size it claims. A manifest whose setup file was deleted is worse than no
 * manifest at all: it produces an Install button that cannot work.
 */
export async function readManifest(panel: PanelKind): Promise<ReleaseManifest | null> {
  const manifestPath = path.join(releaseDirFor(panel), 'latest.json');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }

  if (!isManifest(parsed)) {
    log.warn(`Ignoring ${manifestPath}: not a release manifest`);
    return null;
  }

  /*
   * `panel` comes from the manifest, not from the folder it was found in.
   *
   * It used to be overwritten here — `{ ...parsed, panel }` — which quietly
   * defeated the point of signing it: a Master manifest dropped into the office
   * folder would be relabelled 'office' before anything checked, and the
   * signature would then verify against a payload this code had just rewritten.
   * A manifest that says which panel it is for is only useful if that is the
   * field we read.
   */
  const manifest = parsed as ReleaseManifest;

  if (manifest.panel && manifest.panel !== panel) {
    log.warn(`Ignoring ${manifestPath}: it is a ${manifest.panel} release, in the ${panel} folder`);
    return null;
  }

  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    log.error(`Ignoring ${manifestPath}: ${verdict.reason}`);
    return null;
  }

  try {
    const stats = await stat(releaseFileFor(panel, manifest));
    if (stats.size !== manifest.sizeBytes) {
      log.warn(
        `Ignoring ${manifest.file}: ${stats.size} bytes on disk, manifest says ${manifest.sizeBytes}`,
      );
      return null;
    }
  } catch {
    log.warn(`Ignoring ${manifestPath}: ${manifest.file} is not beside it`);
    return null;
  }

  return manifest;
}

/** What one panel kind should do, against a version already running. */
export async function availability(panel: PanelKind, running: string): Promise<UpdateAvailability> {
  /*
   * Ask GitHub first, when a repository is configured.
   *
   * This only ever *fills the folder* — everything below is unchanged and still
   * reads from disk, so a release fetched from the internet goes through the
   * same digest check, the same signature check, and the same shell that hashes
   * the bytes again before running them. It fails soft: no connection, a rate
   * limit or a half-published release all leave the folder as it was, which is
   * the honest answer rather than an error on a screen.
   */
  await syncFromGitHub(panel, releaseDirFor(panel)).catch(() => null);

  const manifest = await readManifest(panel);

  if (!manifest) {
    // "Is the folder even there?" is the difference between "somebody has not
    // published a build yet" and "this machine is not set up to receive one".
    try {
      await stat(releaseDirFor(panel));
    } catch {
      return { current: running, available: null, reason: 'noFolder' };
    }
    return { current: running, available: null, reason: 'noRelease' };
  }

  if (!isNewer(manifest.version, running)) {
    return { current: running, available: null, reason: 'upToDate' };
  }

  return { current: running, available: manifest };
}

/** The Master's own standing. */
export function masterAvailability(): Promise<UpdateAvailability> {
  return availability('master', appVersion());
}

/**
 * Confirm a setup file is byte-for-byte what its manifest says before anything
 * runs it.
 *
 * Streamed rather than read whole: these files are 100–200 MB, and buffering
 * one to hash it would spike the Master's memory at exactly the moment an
 * operator is watching it.
 */
export async function verifyRelease(panel: PanelKind, manifest: ReleaseManifest): Promise<void> {
  const file = releaseFileFor(panel, manifest);
  const hash = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });

  const digest = hash.digest('hex');
  if (digest !== manifest.sha256.toLowerCase()) {
    log.error(`Refusing ${file}: expected ${manifest.sha256}, got ${digest}`);
    throw new ValidationError('validation.updates.checksumMismatch');
  }
}

/**
 * The last setup file this process verified, for the shell to ask about.
 *
 * Held in memory rather than written down on purpose: it is a statement about
 * what *this run* checked, and a restart should forget it. The shell reads it
 * over loopback and re-hashes the file before running anything, so this is a
 * pointer, never a permission.
 */
let prepared: PreparedInstaller | null = null;

export function preparedInstaller(): PreparedInstaller | null {
  return prepared;
}

/** Test seam — the module lives as long as the process does. */
export function forgetPreparedInstaller(): void {
  prepared = null;
}

/**
 * The verified path of the Master's own setup file, for the desktop shell to
 * run and quit behind.
 *
 * Returns a path rather than launching anything: this process is the server,
 * and a server that spawns an installer over its own program files is a
 * server that gets replaced mid-request. The shell owns the quit.
 */
export async function prepareMasterUpdate(): Promise<{ path: string; manifest: ReleaseManifest }> {
  const { available } = await masterAvailability();
  if (!available) throw new ValidationError('validation.updates.noneAvailable');

  await verifyRelease('master', available);

  const file = releaseFileFor('master', available);
  prepared = {
    path: file,
    sha256: available.sha256.toLowerCase(),
    version: available.version,
  };

  return { path: file, manifest: available };
}
