/**
 * Deciding whether a setup file is the one it claims to be, before it runs.
 *
 * This tool's last act is to execute something an operator pointed it at, on a
 * machine it has just emptied. That is the moment to be strict: a corrupted
 * download, the wrong panel's installer, or a file swapped on the USB stick it
 * travelled on all look identical in a file picker.
 *
 * The check is the one the product already makes. `tools/release.mjs` writes a
 * `latest-<platform>.json` beside every published setup file, carrying the
 * panel, the platform, the exact filename, the byte count and the SHA-256; the
 * Office panel re-verifies the same manifest before installing an update
 * (`office/src/services/update.service.ts`), and the shell re-hashes the bytes
 * again in its own process immediately before running them
 * (`electron/lib/installer.ts`). So this reads that manifest rather than
 * inventing a rule, and a file published by the release script is checkable
 * with no extra step from whoever published it.
 *
 * Pure. The caller reads the files and hashes the bytes; everything here is a
 * decision over values, which is what makes each refusal below a test.
 */

import type { ReleaseManifest } from '@orderbook/shared';

export type SetupVerdict =
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  /** No manifest beside the file. Installable, but nothing vouches for it. */
  | { readonly ok: true; readonly manifest: null; readonly unverified: true }
  | { readonly ok: false; readonly reason: SetupRefusal; readonly detail: string };

export type SetupRefusal =
  | 'not-a-setup-file'
  | 'wrong-platform'
  | 'name-mismatch'
  | 'size-mismatch'
  | 'hash-mismatch';

export interface SetupCandidate {
  /** Basename only — the manifest names a file, never a path. */
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Lowercase hex SHA-256 of the bytes on disk, or null when not computed yet. */
  readonly sha256: string | null;
  /** The manifest found beside it, or null when there is none. */
  readonly manifest: ReleaseManifest | null;
  readonly platform: NodeJS.Platform;
}

/** What a setup file is called on each OS, per the electron-builder config. */
const EXTENSIONS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['.exe'],
  darwin: ['.dmg'],
  linux: ['.AppImage', '.deb'],
};

export function verifySetupFile(candidate: SetupCandidate): SetupVerdict {
  const { fileName, sizeBytes, sha256, manifest, platform } = candidate;

  const allowed = EXTENSIONS[platform] ?? [];
  if (!allowed.some((extension) => fileName.toLowerCase().endsWith(extension.toLowerCase()))) {
    return {
      ok: false,
      reason: 'not-a-setup-file',
      detail: `${fileName} is not one of ${allowed.join(', ')}`,
    };
  }

  if (!manifest) {
    // Deliberately not a refusal. An air-gapped site copies builds in by hand
    // and `tools/release.mjs` publishes unsigned manifests for exactly that
    // case; refusing here would make the tool useless where it is needed most.
    // The caller shows this and makes somebody agree to it.
    return { ok: true, manifest: null, unverified: true };
  }

  if (manifest.platform !== platform) {
    return {
      ok: false,
      reason: 'wrong-platform',
      detail: `this build is for ${manifest.platform}, and this is ${platform}`,
    };
  }

  if (manifest.file !== fileName) {
    return {
      ok: false,
      reason: 'name-mismatch',
      detail: `the manifest beside it names ${manifest.file}`,
    };
  }

  if (manifest.sizeBytes !== sizeBytes) {
    return {
      ok: false,
      reason: 'size-mismatch',
      detail: `expected ${manifest.sizeBytes} bytes, found ${sizeBytes}`,
    };
  }

  // Checked last because it is the expensive one: the caller hashes ~160 MB
  // only once the cheap facts agree, and passes null until then.
  if (sha256 !== null && sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
    return {
      ok: false,
      reason: 'hash-mismatch',
      detail: 'the bytes on disk are not the bytes that were published',
    };
  }

  return { ok: true, manifest };
}

/**
 * Which manifest filename to look for beside a setup file.
 *
 * `latest-<platform>.json` is what the release script writes; `latest.json` is
 * the compatibility shim it also writes on Windows for panels built before the
 * platform field existed. Both are tried, in that order, so a Windows folder
 * holding only the shim still verifies.
 */
export function manifestNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [`latest-${platform}.json`, 'latest.json']
    : [`latest-${platform}.json`];
}

/** Which panel a setup file installs, from its name, for the report. */
export function panelOf(fileName: string): 'master' | 'office' | null {
  if (/OrderBook-Master-/i.test(fileName)) return 'master';
  if (/OrderBook-Office-/i.test(fileName)) return 'office';
  return null;
}
