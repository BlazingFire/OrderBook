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
import { readdir, readFile, stat } from 'node:fs/promises';
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
 * Read the manifest for one panel on one OS, or `null` when there is nothing
 * readable.
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
   * change are in the field — see `tools/release.mjs` — and a GitHub sync
   * writes the same names (`manifestNames` in `github-releases.ts`).
   *
   * The first file that can be read wins, so a writer that updates
   * `latest.json` alone leaves this reading a stale `latest-<platform>.json`
   * for as long as one is there — which is what a GitHub sync once did.
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

/**
 * How long a request waits on GitHub before answering from the folder as it
 * stands.
 *
 * Enough for the listing and a manifest on a slow connection, and well inside
 * the 10 s an Office panel gives the Master to answer and the 15 s the Master's
 * own browser gives it. Not enough for a setup file, and not meant to be: that
 * takes minutes, and waiting for it made every ask while it downloaded time out
 * at the asker — "Could not reach the Master Panel" — which is every first ask
 * from a panel on an OS the poll does not fetch for.
 */
const GITHUB_WAIT_MS = 5_000;

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
   *
   * Waited on for `GITHUB_WAIT_MS` at most. A sync still running then carries
   * on without this request — every later ask for the same panel and OS shares
   * it rather than starting another — and this answer is the folder as it is:
   * "nothing new yet", until the download lands and the next ask finds it.
   * Nothing in that answer says a download is under way — there is no reason
   * for it yet — so `docs/UPDATES.md` tells an operator to check again, and the
   * poll fetches ahead of the ask for every OS it can (`officePlatforms`).
   * `pinnedInstaller` itself rather than its value, because that sync can
   * outlive this request, and an operator can pin a build before it sweeps.
   */
  let waited: NodeJS.Timeout | undefined;
  await Promise.race([
    syncFromGitHub(panel, releaseDirFor(panel), pinnedInstaller, platform).catch(() => null),
    new Promise<void>((resolve) => {
      waited = setTimeout(resolve, GITHUB_WAIT_MS);
      waited.unref?.();
    }),
  ]);
  clearTimeout(waited);

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
 * The setup files `prepareMasterUpdate` is hashing right now, one entry per
 * call in progress — so that one of two at once finishing does not unpin the
 * file the other is still reading.
 *
 * Kept apart from `prepared` because the shell reads that one as "verified",
 * and these are not yet.
 */
const verifying: string[] = [];

/**
 * The filenames a sweep must not remove.
 *
 * `prepareMasterUpdate` verifies a build and holds its path while the shell
 * polls health, the operator reads a dialog, and somebody finally clicks. Setup
 * filenames carry their version, so a newer release landing in that gap would
 * otherwise make the pinned file "superseded" and delete it mid-gesture. The
 * build being hashed is pinned too, and so is the last one prepared until a new
 * one replaces it: the shell may be copying it as a second preparation starts.
 *
 * Handed to `syncFromGitHub` as the function, not its value: a sync started
 * before the operator pinned anything can still be downloading afterwards, and
 * it has to ask at the moment it sweeps.
 */
function pinnedInstaller(): string[] {
  return prepared ? [...verifying, path.basename(prepared.path)] : [...verifying];
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

  // Pinned the moment the manifest names it, not once it is verified. The
  // ask above waits on GitHub for `GITHUB_WAIT_MS` and no longer, so a newer
  // build can still be downloading — for that ask, or for the background poll —
  // and hashing 150 MB gives it time to land, and to sweep this one as
  // superseded while it is being read.
  const file = releaseFileFor('master', available);
  const name = path.basename(file);
  verifying.push(name);
  try {
    await verifyRelease('master', available);
  } finally {
    verifying.splice(verifying.indexOf(name), 1);
  }

  prepared = {
    path: file,
    sha256: available.sha256.toLowerCase(),
    version: available.version,
  };

  return { path: file, manifest: available };
}

/** First poll two minutes after boot, so a shop PC starts up before it downloads. */
const FIRST_POLL_MS = 2 * 60_000;

const ownPlatform = (): ReleasePlatform => process.platform as ReleasePlatform;

/**
 * Every OS a release is built for. Written as the keys of a record over the
 * type so that a platform added to `ReleasePlatform` fails to compile here
 * rather than going unpolled.
 */
const RELEASE_PLATFORMS = Object.keys({
  win32: true,
  darwin: true,
  linux: true,
} satisfies Record<ReleasePlatform, true>) as ReleasePlatform[];

/**
 * The OSes whose office build the poll fetches: the Master's own, and every
 * other one whose manifest is already in the office folder.
 *
 * A manifest for another OS is there because a panel on that OS asked and had
 * its build fetched (or an operator copied one in) — so the shop runs that OS,
 * and its panels will ask again at the next release. Fetched on demand alone,
 * that ask came first every time: it waits on GitHub for `GITHUB_WAIT_MS`,
 * then answers from the folder as it stands, so the first check after each
 * release said there was nothing new while the build downloaded behind it.
 *
 * `latest-<platform>.json` only. Plain `latest.json` is the Windows name, but
 * a Mac or Linux Master that synced before per-OS names existed wrote its own
 * build under it — so it proves nothing about Windows panels. A shop that
 * retires its last panel on an OS stops the fetching by deleting that OS's
 * manifest (`docs/UPDATES.md`).
 */
async function officePlatforms(): Promise<ReleasePlatform[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(releaseDirFor('office'));
  } catch {
    // No folder yet: the first sync makes it.
  }

  const own = ownPlatform();
  return [
    own,
    ...RELEASE_PLATFORMS.filter(
      (platform) => platform !== own && entries.includes(`latest-${platform}.json`),
    ),
  ];
}

/**
 * Keep the releases folder in step with GitHub in the background.
 *
 * Without this the Master only learns about a build when somebody opens the
 * Updates screen — which starts a 150 MB download and says "nothing new" until
 * it has landed (see `availability`). Polling means the setup file is usually
 * already on disk by the time anybody presses Update, which is the difference
 * between "it updated" and "come back in ten minutes".
 *
 * Both panels' folders are filled, one after the other rather than at once:
 * the Master serves the office build to every panel over the LAN, so it has to
 * hold a copy it never installs itself.
 *
 * For the Master's own OS, and for any other OS a panel has asked for
 * (`officePlatforms`). A shop whose Office panels run another OS has that build
 * fetched first when one of those panels asks — `/office/latest` passes the
 * panel's OS to `availability` — and it then sits in the same folder beside
 * this one: each OS's sync writes its own manifest and sweeps only its own
 * files (`github-releases.ts`). Fetching every OS regardless would put 150 MB
 * per unused OS on every Master's disk, every release.
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
        const platforms = panel === 'office' ? await officePlatforms() : [ownPlatform()];
        for (const platform of platforms) {
          await syncFromGitHub(panel, releaseDirFor(panel), pinnedInstaller, platform).catch(
            (error: unknown) => {
              log.warn(`Could not sync the ${panel} release for ${platform}: ${String(error)}`);
              return null;
            },
          );
        }
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
