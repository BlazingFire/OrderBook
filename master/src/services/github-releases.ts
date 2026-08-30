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
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { PanelKind, ReleaseManifest } from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
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
export async function syncFromGitHub(
  panel: PanelKind,
  releaseDir: string,
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

  // Already here at the right size — the digest is checked by `verifyRelease`
  // before anything runs it, so there is nothing to gain from re-downloading
  // a hundred megabytes to find out.
  try {
    if ((await stat(target)).size === manifest.sizeBytes) {
      await writeManifest(releaseDir, manifest);
      return manifest;
    }
  } catch {
    // Not here yet.
  }

  try {
    await download(asset, target, manifest.sizeBytes);
  } catch (error) {
    log.warn(`Could not download ${manifest.file}: ${String(error)}`);
    await rm(target, { force: true }).catch(() => undefined);
    return null;
  }

  await writeManifest(releaseDir, manifest);
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

/** Write `latest.json` last, so the folder never names a file that is not there. */
async function writeManifest(releaseDir: string, manifest: ReleaseManifest): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(releaseDir, 'latest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}
