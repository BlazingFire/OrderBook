/**
 * Comparing build versions.
 *
 * Until this existed, every "is that machine behind?" judgement in the product
 * was a string `!==` — which is why the Updates screens say *"Different
 * version"* rather than *"behind"*: they genuinely could not tell. A screen
 * whose whole job is telling an administrator which machines to update should
 * be able to say which way round it is.
 *
 * Hand-rolled rather than a `semver` dependency. This product mints its own
 * version numbers from one `package.json`; it never has to interpret a range,
 * a pre-release precedence rule, or a build-metadata tag written by somebody
 * else. Twenty lines against a package is not a trade worth making — and the
 * same reasoning is why this repo has its own discovery protocol, env parser
 * and CSV writer.
 */

import type { IsoTimestamp } from './entities.js';

/**
 * `major.minor.patch`, each a run of digits, with anything after the patch
 * number ignored. A version this cannot read is not an error: it sorts as
 * `0.0.0`, which is exactly what `appVersion()` falls back to when it cannot
 * read `package.json`, so an unreadable version reads as "very old" rather
 * than crashing a screen.
 */
export function parseVersion(value: string | null | undefined): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec((value ?? '').trim());
  if (!match) return [0, 0, 0];

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older, positive when newer, `0` when the same build. */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

/** Whether `candidate` is a build worth installing over `running`. */
export function isNewer(
  candidate: string | null | undefined,
  running: string | null | undefined,
): boolean {
  return compareVersions(candidate, running) > 0;
}

/**
 * How one machine's build relates to a reference build.
 *
 * `'unknown'` is a real answer, not a missing one: a panel that has not
 * reported yet, or has not heard from the Master since it started, genuinely
 * does not know — and saying so is better than guessing "up to date" and
 * quietly leaving a machine behind.
 */
export type VersionStanding = 'same' | 'behind' | 'ahead' | 'unknown';

export function standing(
  version: string | null | undefined,
  reference: string | null | undefined,
): VersionStanding {
  if (!version || !reference) return 'unknown';

  const difference = compareVersions(version, reference);
  if (difference === 0) return 'same';
  return difference < 0 ? 'behind' : 'ahead';
}

// --- Releases --------------------------------------------------------------

export type PanelKind = 'master' | 'office';

/**
 * The operating systems a panel is built for.
 *
 * The strings are Node's own `process.platform` values rather than prettier
 * ones, so every comparison in the update path is against something a running
 * panel can produce without a lookup table.
 *
 * `'win7'` is the one exception: it is not a `process.platform` value but the
 * legacy Office line built on Electron 22 for Windows 7, 8 and 8.1. Those PCs
 * report `win32` like any other Windows, so the channel is worked out from the
 * Electron version instead (`releasePlatformFor`).
 */
export type ReleasePlatform = 'win32' | 'darwin' | 'linux' | 'win7';

/**
 * The first Electron major that no longer runs on Windows 7, 8 or 8.1. A
 * Windows panel on anything older is the legacy build.
 */
export const LEGACY_ELECTRON_CEILING = 23;

/**
 * Which release channel a running panel belongs to.
 *
 * `'win7'` for a Windows panel whose Electron major is below
 * `LEGACY_ELECTRON_CEILING`; otherwise the platform itself. No Electron
 * version at all is a plain-Node dev run, which is never the legacy build.
 */
export function releasePlatformFor(
  platform: string,
  electronVersion: string | null | undefined,
): ReleasePlatform {
  if (platform === 'win32' && electronVersion) {
    const major = parseVersion(electronVersion)[0];
    if (major > 0 && major < LEGACY_ELECTRON_CEILING) return 'win7';
  }

  return platform as ReleasePlatform;
}

/**
 * Every release before platform-aware manifests existed was a Windows build —
 * 1.0.1 through 1.0.3 are all `-Setup.exe`. A manifest on disk with no
 * `platform` is therefore a Windows one, and reading it as such is what keeps
 * an already-deployed shop updating across this change.
 */
export const LEGACY_RELEASE_PLATFORM: ReleasePlatform = 'win32';

/**
 * `latest.json`, the file that sits beside a setup file in the releases folder
 * and says what it is.
 *
 * A manifest rather than "read the version out of the filename": a filename is
 * a label anybody can rename, and `sha256` has to live somewhere a rename
 * cannot silently invalidate. It is written by the release script and read on
 * both sides of the LAN.
 */
export interface ReleaseManifest {
  panel: PanelKind;
  /**
   * Which OS this build installs on.
   *
   * Signed, for the same reason `panel` is: without it a Windows manifest
   * could be handed to a Mac as its own, and the shell would download 160 MB
   * of `.exe` it can never run. A manifest read off disk without the field is
   * `LEGACY_RELEASE_PLATFORM`.
   */
  platform: ReleasePlatform;
  version: string;
  /** Filename only, resolved against the folder the manifest was found in. */
  file: string;
  sizeBytes: number;
  /** Lowercase hex. Checked before anything is ever executed. */
  sha256: string;
  releasedAt: IsoTimestamp;
  /** Plain sentences for the person deciding whether to install now. */
  notes?: string;

  /**
   * Base64 Ed25519 signature over `canonicalManifestPayload`, and the id of the
   * key that made it.
   *
   * Optional because the local-folder source predates them: a site that copies
   * builds in on a USB stick has no signing machine, and its manifests stay
   * legal unsigned. A manifest that arrived over the internet is held to a
   * stricter rule — see `release-signature.ts`.
   */
  signature?: string;
  keyId?: string;
}

/** One machine's answer to "should I update, and to what?". */
export interface UpdateAvailability {
  /** What this machine is running now. */
  current: string;
  /** The release on offer, or `null` when the folder holds nothing newer. */
  available: ReleaseManifest | null;
  /**
   * Why there is nothing to install, when there is nothing to install. Named
   * rather than implied: "no releases folder configured" and "the folder holds
   * the build you are already running" are the same empty state on screen and
   * two completely different things to do about it.
   */
  reason?: 'upToDate' | 'noFolder' | 'noRelease' | 'unreadable';
}
