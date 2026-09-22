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
  ReleasePlatform,
  UpdateAvailability,
} from '@orderbook/shared';
import { isNewer, LEGACY_RELEASE_PLATFORM } from '@orderbook/shared';

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
export async function readManifest(
  panel: PanelKind,
  platform: ReleasePlatform = process.platform as ReleasePlatform,
): Promise<ReleaseManifest | null> {
  /*
   * `latest-<platform>.json` first, then plain `latest.json`.
   *
   * The fallback is not tidiness: every folder published before this change
   * holds one `latest.json` describing a Windows build, and a shop that
   * updated its Master would otherwise find no manifest at all and be told
   * nothing had been published. The release script still writes the legacy
   * name for Windows builds for exactly as long as panels older than this
   * change are in the field — see `tools/release.mjs`.
   */
  const candidates = [
    path.join(releaseDirFor(panel), `latest-${platform}.json`),
    path.join(releaseDirFor(panel), 'latest.json'),
  ];

  let manifestPath = candidates[0];
  let raw: string | null = null;

  for (const candidate of candidates) {
    try {
      raw = await readFile(candidate, 'utf8');
      manifestPath = candidate;
      break;
    } catch (error) {
      // A missing file is the ordinary state — the next candidate gets a turn.
      // Anything else is a folder we can see and cannot read, which is worth
      // saying out loud rather than silently falling through to the legacy name.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Ignoring ${candidate}: it could not be read (${String(error)})`);
        return null;
      }
    }
  }

  // Neither name is there, which on a machine nobody has published a build to
  // is the ordinary state and says nothing worth logging.
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A file that is there but will not parse is the opposite: every other
    // refusal in this function explains itself, and this one used to report "no
    // update available" with a good 150 MB build sitting in the folder and
    // nothing anywhere saying why.
    log.warn(`Ignoring ${manifestPath}: it could not be read (${String(error)})`);
    return null;
  }

  if (!isManifest(parsed)) {
    log.warn(`Ignoring ${manifestPath}: not a release manifest`);
    return null;
  }

  /*
   * A manifest with no `platform` predates the field, and every release that
   * old was a Windows build. Defaulted on the way in rather than left absent,
   * so everything below — the signature payload included — sees one shape.
   *
   * Nothing else is rewritten here. `panel` in particular comes from the
   * manifest, not from the folder it was found in: it used to be overwritten —
   * `{ ...parsed, panel }` — which quietly defeated the point of signing it, as
   * a Master manifest dropped into the office folder would be relabelled
   * 'office' before anything checked and the signature would then verify
   * against a payload this code had just rewritten.
   */
  const manifest: ReleaseManifest = {
    ...(parsed as ReleaseManifest),
    platform: (parsed as ReleaseManifest).platform ?? LEGACY_RELEASE_PLATFORM,
  };

  if (manifest.panel && manifest.panel !== panel) {
    log.warn(`Ignoring ${manifestPath}: it is a ${manifest.panel} release, in the ${panel} folder`);
    return null;
  }

  /*
   * The same refusal as the panel mismatch above, and it matters more: a
   * Windows setup file offered to a Mac downloads 160 MB the shell then
   * refuses to run, with nothing on screen saying why.
   */
  if (manifest.platform !== platform) {
    log.warn(
      `Ignoring ${manifestPath}: it is a ${manifest.platform} release, and this panel is ${platform}`,
    );
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
export async function availability(
  panel: PanelKind,
  running: string,
  /** The asking panel's OS, which for the Master's own check is this process's. */
  platform: ReleasePlatform = process.platform as ReleasePlatform,
): Promise<UpdateAvailability> {
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
  await syncFromGitHub(panel, releaseDirFor(panel), pinnedInstaller(), platform).catch(() => null);

  const manifest = await readManifest(panel, platform);

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

/**
 * The filename a sweep must not remove, or null.
 *
 * `prepareMasterUpdate` verifies a build and holds its path while the shell
 * polls health, the operator reads a dialog, and somebody finally clicks. Setup
 * filenames carry their version, so a newer release landing in that gap would
 * otherwise make the pinned file "superseded" and delete it mid-gesture.
 */
function pinnedInstaller(): string | null {
  return prepared ? path.basename(prepared.path) : null;
}

export function preparedInstaller(): PreparedInstaller | null {
  return prepared;
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

/** First poll two minutes after boot, so a shop PC starts up before it downloads. */
const FIRST_POLL_MS = 2 * 60_000;

/**
 * Keep the releases folder in step with GitHub in the background.
 *
 * Without this the Master only learns about a build when somebody opens the
 * Updates screen — and then waits for 150 MB with the screen open. Polling
 * means the setup file is usually already on disk by the time anybody presses
 * Update, which is the difference between "it updated" and "it downloaded for
 * ten minutes and then updated".
 *
 * Both panels' folders are filled, one after the other rather than at once:
 * the Master serves the office build to every panel over the LAN, so it has to
 * hold a copy it never installs itself.
 *
 * Returns the way to stop it, per this codebase's disposable convention.
 * Configuring no repository, or `ORDERBOOK_RELEASES_POLL_MINUTES=0`, makes it a
 * no-op — the folder alone still works, which is the air-gapped case.
 */
export function startReleasePolling(): () => void {
  const minutes = config.releases.pollMinutes;
  if (!config.releases.githubRepo || !Number.isFinite(minutes) || minutes <= 0) {
    return () => undefined;
  }

  // A slow poll must not overlap the next one. `syncFromGitHub` also shares an
  // in-flight run per panel, which is what covers the poll-versus-request case
  // this flag cannot see; this one just stops the timer queueing up behind a
  // download that is taking longer than the interval.
  let running = false;

  const poll = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const panel of ['master', 'office'] as const) {
        await syncFromGitHub(panel, releaseDirFor(panel), pinnedInstaller()).catch(
          (error: unknown) => {
            log.warn(`Could not sync the ${panel} release: ${String(error)}`);
            return null;
          },
        );
      }
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void poll(), FIRST_POLL_MS);
  first.unref?.();

  const timer = setInterval(() => void poll(), minutes * 60_000);
  timer.unref?.();

  log.info(`Watching ${config.releases.githubRepo} for releases every ${minutes} minutes`);

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
