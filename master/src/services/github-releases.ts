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
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { PanelKind, ReleaseManifest, ReleasePlatform } from '@orderbook/shared';
import { LEGACY_RELEASE_PLATFORM } from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { writeDurable } from '../lib/durable-file.js';
import { verifyManifest } from '../lib/release-signature.js';

const log = createLogger('github-releases');

/**
 * Long enough for a slow shop connection, short enough not to hang a screen.
 *
 * What every hop gets to *answer* — the headers — and all a release listing or
 * a manifest gets, body included: a few kilobytes that have not arrived in 15 s
 * are not coming.
 */
const METADATA_TIMEOUT_MS = 15_000;

/**
 * A setup file's body is not held to that. It used to be — the 15 s covered
 * the whole request — so a 150 MB download on a shop connection was cut off
 * every time and never landed at all.
 *
 * What stops a dead connection holding a sync for ever is silence instead. A
 * slow link still delivers something every few seconds; a minute of nothing at
 * all is a connection that has died, and every later sync for the same panel
 * shares this one (`inFlight`), so it has to end.
 */
const DOWNLOAD_STALL_MS = 60_000;

/**
 * And an outer limit, because silence is not the only way never to finish: a
 * byte every fifty seconds is never a minute of nothing, and 150 MB at that
 * rate takes centuries. Three hours is 150 MB at about 110 kbit/s, and the
 * default poll interval, so a download that was never going to land holds the
 * poll up for one interval at most.
 */
const DOWNLOAD_LIMIT_MS = 3 * 60 * 60_000;

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

/**
 * The manifest asset for one panel on one OS.
 *
 * Two axes, because a GitHub release holds every platform's build at once and
 * one asset name per panel could only ever describe one of them. The Windows
 * names are the ones already published, so a shop pinned to an existing
 * release keeps finding its manifest.
 */
function manifestAsset(panel: PanelKind, platform: ReleasePlatform): string {
  return platform === LEGACY_RELEASE_PLATFORM
    ? `latest-${panel}.json`
    : `latest-${panel}-${platform}.json`;
}

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
 *
 * Every hop has `METADATA_TIMEOUT_MS` to answer. Left alone, that clock keeps
 * running over the body too, which is right for JSON. `body` is for the one
 * caller whose body is 150 MB: once headers are in, the hop's clock stops and
 * the body is bounded by `body` alone. `fetch`'s signal covers the body as well
 * as the request — which is how a single 15 s timeout here once cut off every
 * setup file mid-download — so the only way to give the body a different limit
 * is a clock that can be stopped.
 */
async function guardedFetch(
  url: string,
  init: RequestInit = {},
  body?: AbortSignal,
): Promise<Response> {
  let current = url;

  for (let hop = 0; hop < 5; hop += 1) {
    const host = new URL(current).host;
    if (!ALLOWED_HOSTS.has(host)) {
      throw new Error(`Refusing to follow an update download to ${host}`);
    }

    const answer = new AbortController();
    const clock = setTimeout(
      () =>
        answer.abort(new Error(`${host} did not answer within ${METADATA_TIMEOUT_MS / 1000} s`)),
      METADATA_TIMEOUT_MS,
    );
    clock.unref?.();

    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: body ? AbortSignal.any([answer.signal, body]) : answer.signal,
      });
    } catch (error) {
      clearTimeout(clock);
      throw error;
    }
    if (body) clearTimeout(clock);

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
 *
 * `pinned` is the setup file the sweep must spare (see `supersededBy`), or a
 * way to ask for the ones it must. The Master passes the way to ask: a sync can
 * outlive the request that started it by many minutes, and an operator can pin
 * a build in that time — so the answer that counts is the one at the moment of
 * sweeping, not the one when the sync began.
 */
export function syncFromGitHub(
  panel: PanelKind,
  releaseDir: string,
  pinned: Pinned = null,
  platform: ReleasePlatform = process.platform as ReleasePlatform,
): Promise<ReleaseManifest | null> {
  // One sync per panel at a time, shared rather than started twice.
  //
  // The background poller has its own guard, but it only covers poll-vs-poll:
  // `availability()` syncs on every request, so an Office panel polling
  // `/office/latest` and a browser sitting on the Updates screen can each start
  // one at any moment. Two runs on the same folder write the same `.part` file,
  // and the loser corrupts the winner.
  //
  // Keyed on the pair, not the panel: a Master serving a mixed shop syncs a
  // Windows office build and a Mac one into the same folder, and each OS's run
  // writes and sweeps only its own files (`manifestNames`, `isDebrisOf`,
  // `supersededBy`) so that the two can run at once.
  const key = `${panel}:${platform}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = runSync(panel, releaseDir, pinned, platform).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

const inFlight = new Map<string, Promise<ReleaseManifest | null>>();

/**
 * One setup file to spare, fixed when the sync starts, or a way to ask for
 * every one to spare at the moment of sweeping.
 */
type Pinned = string | null | (() => readonly string[]);

async function runSync(
  panel: PanelKind,
  releaseDir: string,
  pinned: Pinned,
  platform: ReleasePlatform,
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

  const wanted = manifestAsset(panel, platform);
  const found = release.assets.find((asset) => asset.name === wanted);
  if (!found) return null;

  let manifest: ReleaseManifest;
  try {
    const response = await guardedFetch(found.browser_download_url, {
      headers: { 'user-agent': 'OrderBook-Master' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    manifest = (await response.json()) as ReleaseManifest;
  } catch (error) {
    log.warn(`Could not read ${wanted}: ${String(error)}`);
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
    log.error(`Refusing ${wanted}: it describes a ${manifest.panel} release`);
    return null;
  }

  // The same refusal on the other axis. An asset name is a label; what the
  // manifest says it is for is the part the signature covers.
  const declared = manifest.platform ?? LEGACY_RELEASE_PLATFORM;
  if (declared !== platform) {
    log.error(
      `Refusing ${wanted}: it describes a ${declared} release, and this panel is ${platform}`,
    );
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

  const file = path.basename(manifest.file);
  const target = path.join(releaseDir, file);

  // What the superseded sweep must leave, beside the file it keeps: whatever
  // is pinned at the moment it asks, and the program this Master is running.
  const running = await runningAppImageIn(releaseDir);
  const spared = (): readonly string[] => {
    const pinnedNow = typeof pinned === 'function' ? pinned() : pinned === null ? [] : [pinned];
    return running ? [running, ...pinnedNow] : pinnedNow;
  };

  // Debris from an earlier attempt, cleared before this one starts. Only the
  // half-written files, and only this OS's: see `sweep` for why the finished
  // ones have to wait, and `isDebrisOf` for why another OS's are not debris.
  await sweep(releaseDir, isDebrisOf(file, platform));

  // Already here at the right size — the digest is checked by `verifyRelease`
  // before anything runs it, so there is nothing to gain from re-downloading
  // a hundred megabytes to find out.
  try {
    if ((await stat(target)).size === manifest.sizeBytes) {
      await writeManifest(releaseDir, manifest, platform);
      await sweep(releaseDir, supersededBy(file, spared));
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
    // an earlier run — which the manifest may still be naming and an Office
    // panel may still be asking for. A transient network failure must not cost
    // a shop the build it already had.
    log.warn(`Could not download ${manifest.file}: ${String(error)}`);
    return null;
  }

  await writeManifest(releaseDir, manifest, platform);

  // Only now. Until the manifest names the new file, the old one is the
  // release, and something on the LAN is very likely still asking for it.
  await sweep(releaseDir, supersededBy(file, spared));

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

  // The body's own limits (`DOWNLOAD_STALL_MS`, `DOWNLOAD_LIMIT_MS`), on one
  // signal. It goes to `fetch`, which ends a real body when it fires, and to
  // `pipeline` as well, which ends the copy whatever the body does about it.
  const gaveUp = new AbortController();
  const giveUp = (reason: string) => () => gaveUp.abort(new Error(reason));

  const limit = setTimeout(
    giveUp(`still downloading after ${DOWNLOAD_LIMIT_MS / 3_600_000} hours`),
    DOWNLOAD_LIMIT_MS,
  );
  limit.unref?.();
  let silence: NodeJS.Timeout | undefined;

  // Every failure below deletes the partial file on the way out. It has to
  // happen here rather than in the caller, which knows `target` and not this
  // name — and a rejected download that leaves half a setup file behind is the
  // disk-filling the byte cap exists to prevent, just slower.
  try {
    const response = await guardedFetch(
      asset.browser_download_url,
      { headers: { 'user-agent': 'OrderBook-Master' } },
      gaveUp.signal,
    );

    if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`);

    silence = setTimeout(
      giveUp(`nothing arrived for ${DOWNLOAD_STALL_MS / 1000} s`),
      DOWNLOAD_STALL_MS,
    );
    silence.unref?.();

    // A cap, not a progress bar: without one, a lying `Content-Length` or an
    // endless body fills the disk the company's database lives on.
    let received = 0;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      silence?.refresh();
      received += chunk.length;
      if (received > expectedBytes) source.destroy(new Error('asset is larger than its manifest'));
    });

    await pipeline(source, createWriteStream(partial), { signal: gaveUp.signal });

    if (received !== expectedBytes) {
      throw new Error(`asset is ${received} bytes, manifest says ${expectedBytes}`);
    }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    // The reason rather than whatever `fetch` or `pipeline` wrapped it in, so
    // the log says which limit it was.
    throw gaveUp.signal.aborted ? gaveUp.signal.reason : error;
  } finally {
    clearTimeout(limit);
    clearTimeout(silence);
  }

  await rename(partial, target);
}

/**
 * The manifest names one OS's build is published under in the releases folder:
 * the names `tools/release.mjs` writes, so a folder filled from GitHub has the
 * same shape as one filled by hand.
 *
 * `latest-<platform>.json` is the one that matters. `readManifest` reads it
 * first and stops at the first file it can read, so a sync that wrote only
 * `latest.json` — as this once did — left the reader on whatever manifest the
 * release script had last put there, naming a setup file this sync had just
 * swept as superseded: "no update available", with the new build in the folder.
 *
 * Plain `latest.json` is the pre-platform name, and every reader that knows
 * only it is Windows — so the Windows build writes it too, and no other OS's
 * does. A Mac sync overwriting it with a `.dmg` manifest was the other half of
 * why a mixed shop's builds could not share the folder.
 */
function manifestNames(platform: ReleasePlatform): string[] {
  return platform === LEGACY_RELEASE_PLATFORM
    ? [`latest-${platform}.json`, 'latest.json']
    : [`latest-${platform}.json`];
}

/**
 * Write the manifest last, so the folder never names a file that is not there.
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
 * A `latest-win32.json.tmp` stranded by a crash is swept as debris by the next
 * sync for that OS (`isDebrisOf`).
 */
async function writeManifest(
  releaseDir: string,
  manifest: ReleaseManifest,
  platform: ReleasePlatform,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  for (const name of manifestNames(platform)) {
    await writeDurable(path.join(releaseDir, name), bytes);
  }
}

/**
 * A setup file this code could have written.
 *
 * The sweep is an allowlist of things to *delete*, not of things to keep, and
 * that distinction is the whole safety argument. `docs/UPDATES.md` promises an
 * operator can copy a build into this folder by hand, and a Master that also
 * polls GitHub would otherwise delete their notes, their subfolders, and any
 * file whose name it did not recognise. Anything not matching this pattern is
 * somebody else's and is left exactly where it is.
 *
 * One extension per OS, as `tools/release.mjs` builds them: `.exe`, `.dmg`, and
 * the Linux `.AppImage` — which this pattern once left out, so a Linux Master
 * kept every build it had ever fetched.
 */
const isOurArtefact = (entry: string): boolean =>
  /^OrderBook-(Master|Office)-.+-Setup\.(exe|dmg|AppImage)$/i.test(entry);

/**
 * Whether `entry` is a build for the same OS as `file`, by its extension.
 *
 * Every sweep is limited to the OS being synced. One folder holds a build per
 * OS the shop runs — the Master's poll fetches its own, and a panel on another
 * OS has its build fetched when it asks — and the syncs for two OSes run at
 * once. A sweep that took every setup file but its own deleted the other OS's
 * build on every ask, so each re-fetched 150 MB to put it back, and a panel
 * could be offered a file that was gone by the time it asked for it.
 */
const sameOs = (entry: string, file: string): boolean =>
  path.extname(entry).toLowerCase() === path.extname(file).toLowerCase();

/**
 * Half-written files of this OS's: a download that died, or a manifest write
 * that was cut off partway. Nothing reads either, so they can go before a
 * download starts.
 *
 * Only this OS's, though. Another OS's `.part` may be a download that OS's sync
 * is writing at this moment, and deleting it succeeds on every OS — Windows
 * included, where Node opens every file sharing delete, so there is no lock to
 * refuse it. That download then writes on into a file with no name and dies at
 * its rename, having fetched 150 MB for nothing.
 */
const isDebrisOf = (file: string, platform: ReleasePlatform) => {
  const manifests = new Set(manifestNames(platform).map((name) => `${name}.tmp`));
  return (entry: string): boolean => {
    if (manifests.has(entry)) return true;
    const download = entry.endsWith('.part') ? entry.slice(0, -'.part'.length) : null;
    return download !== null && isOurArtefact(download) && sameOs(download, file);
  };
};

/**
 * Finished setup files for this OS that are not the one its manifest now names,
 * are not one an operator is part-way through installing, and are not the
 * AppImage this Master is running from (`runningAppImageIn`).
 *
 * `pinned` closes a window that is otherwise wide open for as long as a person
 * takes to click a button. `prepareMasterUpdate` verifies a build and pins its
 * path in memory; the shell then polls health, asks the operator, and only then
 * copies the file. Setup filenames carry their version, so a newer release
 * landing in that gap makes the pinned file "superseded" and sweeps it out from
 * under the click. The install then fails safe — the shell re-hashes what it
 * copies — but it fails, and for no reason anybody could see.
 *
 * Asked entry by entry rather than once per sweep, so a build pinned while the
 * sweep is already under way is still spared.
 */
const supersededBy =
  (keep: string, spared: () => readonly string[]) =>
  (entry: string): boolean =>
    isOurArtefact(entry) && sameOs(entry, keep) && entry !== keep && !spared().includes(entry);

/**
 * The name of the AppImage this Master is running from, when that file is in
 * `releaseDir` — the one setup file no sweep may take, whatever its name says.
 *
 * An AppImage is not an installer. It is the program itself, one file, run
 * from wherever somebody put it, and a Linux operator can put it here and run
 * it from here. Its name keeps the version it was downloaded as, even once it
 * has been updated in place, so by name alone the running program is always a
 * superseded build — and a sweep that took it would leave a Master that runs
 * until it is next started, and then is not there to start.
 *
 * `APPIMAGE` is set by the AppImage runtime and inherited by the server the
 * desktop shell starts. Believing it costs nothing: the worst a stray one can
 * do is spare a file. The folder is compared by real path, because the runtime
 * reports the file with its links resolved and `releaseDir` may be a link; the
 * same name in another folder is another file, and is swept as usual.
 */
async function runningAppImageIn(releaseDir: string): Promise<string | null> {
  const running = process.env.APPIMAGE;
  if (!running || !path.isAbsolute(running)) return null;

  try {
    const [here, there] = await Promise.all([
      realpath(releaseDir),
      realpath(path.dirname(running)),
    ]);
    return here === there ? path.basename(running) : null;
  } catch {
    return null; // Either folder gone or unreadable: nothing here to spare.
  }
}

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
 *    it, so removing it can never take something away from somebody — as long
 *    as it is this OS's (`isDebrisOf`).
 *  - **Superseded setup files** are swept *after* the manifest has been
 *    rewritten, never before. Until that moment the old file **is** the
 *    release: it is what the manifest names, what the shell would install, and
 *    what every Office panel on the LAN is asking the Master to stream. Sweeping
 *    it first and then failing the download would leave a manifest pointing at
 *    a file that no longer exists, which is a worse state than the disk space
 *    it saves.
 *
 * Per-entry failures are swallowed. A file this account may not remove, or one
 * another program holds open without sharing delete — on Windows an antivirus
 * scan is the usual one — stays where it is, and an update that refused to
 * proceed because last month's build was busy would be a worse outcome than
 * the disk space. It is simply swept on the next run.
 *
 * A file being streamed to an Office panel is not one of those. Node opens
 * files sharing delete, on Windows too, so removing it succeeds, and the
 * panel's download carries on from the file it already has open.
 *
 * @returns how many entries were removed, so the log can say so rather than
 * being a silent sweep somebody has to trust.
 */
async function sweep(releaseDir: string, doomed: (entry: string) => boolean): Promise<number> {
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
