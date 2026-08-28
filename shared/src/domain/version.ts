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
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
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
  version: string;
  /** Filename only, resolved against the folder the manifest was found in. */
  file: string;
  sizeBytes: number;
  /** Lowercase hex. Checked before anything is ever executed. */
  sha256: string;
  releasedAt: IsoTimestamp;
  /** Plain sentences for the person deciding whether to install now. */
  notes?: string;
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
