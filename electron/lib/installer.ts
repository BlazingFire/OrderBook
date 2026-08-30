/**
 * Deciding whether a setup file the renderer asked us to run may be run.
 *
 * The shell's one genuinely dangerous power is launching an executable. The
 * previous check was `typeof filePath === 'string' && filePath.endsWith('.exe')`
 * — which accepts any path on the machine, so a compromised renderer could ask
 * the shell to run anything already on disk. The path must instead be inside
 * the directory that panel downloads its updates to, and the panel tells us
 * that directory over its own loopback health route rather than the renderer
 * supplying it.
 *
 * Pure, so the traversal vectors can be tested without a window.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/** The setup-file extension for each platform we build for. */
export function installerExtension(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '.dmg' : '.exe';
}

/**
 * @returns the resolved absolute path to run, or `null` to refuse.
 *
 * Refuses when the candidate is not a string, when we never learned the
 * allowed directory (so we cannot check containment and must not guess), when
 * the path escapes that directory, or when the extension is not this
 * platform's installer.
 */
export function resolveInstaller(
  candidate: unknown,
  allowedDir: string | null,
  platform: NodeJS.Platform,
): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (!allowedDir) return null;

  const resolved = path.resolve(candidate);
  if (path.extname(resolved).toLowerCase() !== installerExtension(platform)) return null;

  // Containment by resolved-prefix. `path.relative` rather than `startsWith`
  // so that `…/updates-evil` is not accepted as being inside `…/updates`.
  // This mirrors the private `isInside` in `office/src/config/paths.ts`; the
  // shell cannot import panel source, so the two are pinned by the same
  // vectors instead of shared.
  const base = path.resolve(allowedDir);
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  return resolved;
}

/**
 * Hash a setup file, for the process that is about to run it.
 *
 * The panel checksummed these bytes when it downloaded them. That is a
 * different process, at a different time, and the file has been sitting in a
 * folder on disk in between — so the digest it reported is a statement about
 * the past. This is the one that decides whether anything runs, taken by the
 * process doing the running, with nothing happening in between.
 *
 * Streamed because these files are 100–200 MB and the shell is holding a
 * window open while it works.
 */
export async function digestOf(file: string): Promise<string> {
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
 * Everything that has to be true before a setup file is launched.
 *
 * Returns the resolved path, or `null` having said why. The order matters and
 * is the reverse of how it reads: containment is cheap and rejects the obvious,
 * the digest is expensive and rejects the deliberate.
 */
export async function approveInstaller(
  candidate: unknown,
  expectedSha256: unknown,
  allowedDir: string | null,
  platform: NodeJS.Platform,
): Promise<{ path: string } | { refused: string }> {
  const resolved = resolveInstaller(candidate, allowedDir, platform);
  if (!resolved) return { refused: `outside ${allowedDir ?? 'an unknown folder'}` };

  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    // No digest is a refusal, never a pass. An older panel that does not report
    // one must not be the reason an unverified installer runs.
    return { refused: 'the panel did not say what it should hash to' };
  }

  let actual: string;
  try {
    actual = await digestOf(resolved);
  } catch (error) {
    return { refused: `it could not be read: ${String(error)}` };
  }

  if (actual !== expectedSha256.toLowerCase()) {
    return { refused: `it hashes to ${actual}, not ${expectedSha256.toLowerCase()}` };
  }

  return { path: resolved };
}
