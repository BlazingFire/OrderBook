/**
 * Fetching a published build from GitHub, into the folder the Master already
 * serves from.
 *
 * The deliberate smallness of this file is the design. Everything downstream of
 * the releases folder — verifying the digest, refusing an unsigned manifest,
 * serving the office build to panels over the LAN, the shell hashing the bytes
 * again before it spawns them — already exists and is unchanged. GitHub is a
 * way of *filling that folder*, not a second path to running an installer.
 *
 * **Only the Master talks to the internet.** Office panels keep asking the
 * Master over the LAN exactly as they did, which is what lets a shop floor with
 * no route to the outside world still update every till from one PC.
 *
 * ### Why a separate public repository
 *
 * The source repository is private, and release assets on a private repository
 * require an `Authorization` header. Shipping a token that can read them means
 * shipping, to every customer machine, a credential that can generally read the
 * whole source repository. So releases are published to their own **public**
 * repository containing nothing but assets: the source stays private, the
 * installers download anonymously, and no secret is ever on a shop PC.
 *
 * A token may still be configured for a private release repository, and the
 * setting is named so that nobody does it by accident.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { PanelKind, ReleaseManifest } from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { writeDurable } from '../lib/document-files.js';
import { verifyManifest } from '../lib/release-signature.js';

const log = createLogger('github-releases');

/** Long enough for a slow shop connection, short enough not to hang a screen. */
const METADATA_TIMEOUT_MS = 15_000;

/**
 * The only hosts an update may come from.
 *
 * `fetch` follows redirects by default, and a GitHub asset URL deliberately
 * redirects to its object store — so "we asked github.com" says nothing about
 * where the bytes came from. Every hop is checked against this list instead.
 */
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const MANIFEST_ASSET: Record<PanelKind, string> = {
  master: 'latest-master.json',
  office: 'latest-office.json',
};

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

export const isConfigured = (): boolean => Boolean(config.releases.githubRepo);

function headers(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'OrderBook-Master',
    ...(config.releases.githubToken
      ? { authorization: `Bearer ${config.releases.githubToken}` }
      : {}),
  };
}

/**
 * Fetch, refusing any hop that leaves the hosts above.
 *
 * `redirect: 'manual'` and a hand-run loop rather than letting `fetch` follow:
 * the point is to inspect each `Location` before going there, which the
 * automatic mode gives no opportunity to do.
 */
async function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;

  for (let hop = 0; hop < 5; hop += 1) {
    const host = new URL(current).host;
    if (!ALLOWED_HOSTS.has(host)) {
      throw new Error(`Refusing to follow an update download to ${host}`);
    }

    const response = await fetch(current, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    current = new URL(location, current).toString();
  }

  throw new Error('Update download redirected too many times');
}

/** The newest published release, ignoring drafts and pre-releases. */
async function latestRelease(): Promise<GitHubRelease | null> {
  const repo = config.releases.githubRepo;
  if (!repo) return null;

  const response = await guardedFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: headers(),
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

  const release = (await response.json()) as GitHubRelease;
  return release.draft || release.prerelease ? null : release;
}

/**
 * Bring the releases folder up to date with what GitHub is publishing.
 *
 * Returns the manifest it landed, or null when there is nothing to do. Fails
 * soft in exactly the way the rest of this service does: no internet, a rate
 * limit, a half-published release — all of them are "nothing new", never an
 * error that takes down an Updates screen.
 *
 * The manifest is verified **before** the 100 MB asset is fetched. Downloading
 * first and checking afterwards would let anyone who can answer for GitHub
 * spend a shop's bandwidth and disk at will.
 */
export function syncFromGitHub(
  panel: PanelKind,
  releaseDir: string,
  pinned: string | null = null,
): Promise<ReleaseManifest | null> {
  // One sync per panel at a time, shared rather than started twice.
  //
  // The background poller has its own guard, but it only covers poll-vs-poll:
  // `availability()` syncs on every request, so an Office panel polling
  // `/office/latest` and a browser sitting on the Updates screen can each start
  // one at any moment. Two runs on the same folder write the same `.part` file,
  // and the loser corrupts the winner.
  const existing = inFlight.get(panel);
  if (existing) return existing;

  const run = runSync(panel, releaseDir, pinned).finally(() => inFlight.delete(panel));
  inFlight.set(panel, run);
  return run;
}

const inFlight = new Map<PanelKind, Promise<ReleaseManifest | null>>();

async function runSync(
  panel: PanelKind,
  releaseDir: string,
  pinned: string | null,
): Promise<ReleaseManifest | null> {
  if (!isConfigured()) return null;

  let release: GitHubRelease | null;
  try {
    release = await latestRelease();
  } catch (error) {
    log.warn(`Could not ask GitHub for the latest release: ${String(error)}`);
    return null;
  }

  if (!release) return null;

  const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_ASSET[panel]);
  if (!manifestAsset) return null;

  let manifest: ReleaseManifest;
  try {
    const response = await guardedFetch(manifestAsset.browser_download_url, {
      headers: { 'user-agent': 'OrderBook-Master' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    manifest = (await response.json()) as ReleaseManifest;
  } catch (error) {
    log.warn(`Could not read ${MANIFEST_ASSET[panel]}: ${String(error)}`);
    return null;
  }

  // Signed by us, and for this panel — checked before a single byte of the
  // installer is fetched.
  const verdict = verifyManifest(manifest);
  if (!verdict.ok) {
    log.error(`Refusing the ${panel} release GitHub is offering: ${verdict.reason}`);
    return null;
  }

  if (manifest.panel !== panel) {
    log.error(`Refusing ${MANIFEST_ASSET[panel]}: it describes a ${manifest.panel} release`);
    return null;
  }

  const asset = release.assets.find((candidate) => candidate.name === path.basename(manifest.file));
  if (!asset) {
    log.warn(`${manifest.file} is named by the manifest but not attached to the release`);
    return null;
  }

  if (asset.size !== manifest.sizeBytes) {
    log.error(
      `Refusing ${manifest.file}: GitHub lists ${asset.size} bytes, the manifest says ${manifest.sizeBytes}`,
    );
    return null;
  }

  await mkdir(releaseDir, { recursive: true });

  const target = path.join(releaseDir, path.basename(manifest.file));

  // Debris from an earlier attempt, cleared before this one starts. Only the
  // half-written files: see `sweep` for why the finished ones have to wait.
  await sweep(releaseDir, isDebris);

  // Already here at the right size — the digest is checked by `verifyRelease`
  // before anything runs it, so there is nothing to gain from re-downloading
  // a hundred megabytes to find out.
  try {
    if ((await stat(target)).size === manifest.sizeBytes) {
      await writeManifest(releaseDir, manifest);
      await sweep(releaseDir, supersededBy(path.basename(manifest.file), pinned));
      return manifest;
    }
  } catch {
    // Not here yet.
  }

  try {
    await download(asset, target, manifest.sizeBytes);
  } catch (error) {
    // Deliberately no `rm(target)` here. `download` deletes its own partial
    // file, so the only thing this could remove is a complete setup file from
    // an earlier run — which `latest.json` may still be naming and an Office
    // panel may still be asking for. A transient network failure must not cost
    // a shop the build it already had.
    log.warn(`Could not download ${manifest.file}: ${String(error)}`);
    return null;
  }

  await writeManifest(releaseDir, manifest);

  // Only now. Until `latest.json` names the new file, the old one is the
  // release, and something on the LAN is very likely still asking for it.
  await sweep(releaseDir, supersededBy(path.basename(manifest.file), pinned));

  log.info(`Fetched ${manifest.file} (${manifest.version}) from GitHub`);
  return manifest;
}

/**
 * Stream an asset to a temporary name, then rename it into place.
 *
 * The rename is the point: a half-downloaded file that already carries its
 * final name is one the folder — and every Office panel asking the Master for
 * it — will treat as the release.
 */
async function download(asset: GitHubAsset, target: string, expectedBytes: number): Promise<void> {
  const partial = `${target}.part`;
  await rm(partial, { force: true }).catch(() => undefined);

  // Every failure below deletes the partial file on the way out. It has to
  // happen here rather than in the caller, which knows `target` and not this
  // name — and a rejected download that leaves half a setup file behind is the
  // disk-filling the byte cap exists to prevent, just slower.
  try {
    const response = await guardedFetch(asset.browser_download_url, {
      headers: { 'user-agent': 'OrderBook-Master' },
    });

    if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`);

    // A cap, not a progress bar: without one, a lying `Content-Length` or an
    // endless body fills the disk the company's database lives on.
    let received = 0;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > expectedBytes) source.destroy(new Error('asset is larger than its manifest'));
    });

    await pipeline(source, createWriteStream(partial));

    if (received !== expectedBytes) {
      throw new Error(`asset is ${received} bytes, manifest says ${expectedBytes}`);
    }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }

  await rename(partial, target);
}

/**
 * Write `latest.json` last, so the folder never names a file that is not there.
 *
 * `writeDurable` rather than `writeFile`, and it is worth saying why for eight
 * hundred bytes of JSON. This is the file both panels look for, and a torn or
 * empty one is answered by `readManifest` returning null — so the shop would
 * report "no update available" indefinitely, with a perfectly good build
 * sitting in the folder and nothing anywhere saying what went wrong. The
 * temp-fsync-rename this shares with `writeExportFile` and the Office outbox is
 * exactly the guard against that: without the fsync the rename can be visible
 * while the contents are still in the page cache, which is how a power cut
 * produces a correctly-named empty file every later read believes.
 *
 * A `latest.json.tmp` stranded by a crash is swept by `sweepReleaseDir` on the
 * next run, since it is neither the manifest nor the current setup file.
 */
async function writeManifest(releaseDir: string, manifest: ReleaseManifest): Promise<void> {
  await writeDurable(
    path.join(releaseDir, 'latest.json'),
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
  );
}

/**
 * Half-written files: a download that died, or a manifest write that was cut
 * off partway. Nothing reads either, so they can go at any moment.
 */
const isDebris = (entry: string): boolean => entry.endsWith('.part') || entry.endsWith('.tmp');

/**
 * A setup file this code could have written.
 *
 * The sweep is an allowlist of things to *delete*, not of things to keep, and
 * that distinction is the whole safety argument. `docs/UPDATES.md` promises an
 * operator can copy a build into this folder by hand, and a Master that also
 * polls GitHub would otherwise delete their notes, their subfolders, and any
 * file whose name it did not recognise. Anything not matching this pattern is
 * somebody else's and is left exactly where it is.
 */
const isOurArtefact = (entry: string): boolean =>
  /^OrderBook-(Master|Office)-.+-Setup\.(exe|dmg)$/i.test(entry);

/**
 * Finished setup files that are not the one `latest.json` now names, and are
 * not the one an operator is part-way through installing.
 *
 * `pinned` closes a window that is otherwise wide open for as long as a person
 * takes to click a button. `prepareMasterUpdate` verifies a build and pins its
 * path in memory; the shell then polls health, asks the operator, and only then
 * copies the file. Setup filenames carry their version, so a newer release
 * landing in that gap makes the pinned file "superseded" and sweeps it out from
 * under the click. The install then fails safe — the shell re-hashes what it
 * copies — but it fails, and for no reason anybody could see.
 */
const supersededBy =
  (keep: string, pinned: string | null) =>
  (entry: string): boolean =>
    isOurArtefact(entry) && entry !== keep && entry !== pinned;

/**
 * Delete what earlier runs left in the releases folder.
 *
 * Everything written here carries a version in its filename, so any cleanup
 * keyed to a filename stops working the moment the version moves — which is
 * exactly when a failed download is most likely to have left something. A
 * download of 1.4.3 that died halfway leaves
 * `OrderBook-Master-1.4.3-Setup.exe.part`, and once 1.4.4 is published nothing
 * ever looks at that name again: the folder grows by one dead file per failure,
 * at 150 MB each, on a shop PC that also holds the company database. Successful
 * downloads accumulate the same way, since nothing has ever removed a
 * superseded setup file.
 *
 * **Timing is the whole design here, and the two kinds are not the same.**
 *
 *  - **Debris** (`.part`, `.tmp`) is swept *before* a download. Nothing reads
 *    it, so removing it can never take something away from somebody.
 *  - **Superseded setup files** are swept *after* `latest.json` has been
 *    rewritten, never before. Until that moment the old file **is** the
 *    release: it is what the manifest names, what the shell would install, and
 *    what every Office panel on the LAN is asking the Master to stream. Sweeping
 *    it first and then failing the download would leave a manifest pointing at
 *    a file that no longer exists, which is a worse state than the disk space
 *    it saves.
 *
 * Per-entry failures are swallowed. On Windows a file being streamed to an
 * Office panel is locked, and an update that refused to proceed because last
 * month's build was busy would be a worse outcome than the disk space. A locked
 * file is simply swept on the next run.
 *
 * @returns how many entries were removed, so the log can say so rather than
 * being a silent sweep somebody has to trust.
 */
async function sweep(
  releaseDir: string,
  doomed: (entry: string) => boolean,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(releaseDir);
  } catch {
    return 0; // No folder. Nothing to sweep.
  }

  let removed = 0;
  for (const entry of entries) {
    if (!doomed(entry)) continue;

    try {
      await rm(path.join(releaseDir, entry), { force: true, recursive: true });
      removed += 1;
    } catch (error) {
      log.warn(`Could not remove the leftover ${entry}: ${String(error)}`);
    }
  }

  if (removed > 0) log.info(`Cleared ${removed} leftover file(s) from ${releaseDir}`);
  return removed;
}
