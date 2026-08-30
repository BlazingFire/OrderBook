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
 * The traversal vectors are testable without a window.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
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
 * Returns the path to run, or refuses having said why. The order matters and
 * is the reverse of how it reads: containment is cheap and rejects the obvious,
 * the digest is expensive and rejects the deliberate.
 *
 * ### Why it copies before hashing
 *
 * The releases folder is writable by whoever is logged in — it has to be, since
 * an operator copies a build there from a USB stick and the panel downloads
 * into it. That leaves a gap between hashing a file and spawning it, in which
 * another account on the same PC can swap the bytes: the digest that was
 * checked and the bytes that run are two different reads of a folder anybody
 * can write.
 *
 * So the file is copied into `stagingDir` first — a per-user directory nobody
 * else can write — and it is the **copy** that is hashed and the copy that
 * runs. Swapping the original mid-copy produces a copy that fails its digest,
 * and after the copy the original no longer matters. This is the cheapest fix
 * that does not require the releases folder to become unwritable, which would
 * break both the USB stick and the download.
 */
export async function approveInstaller(
  candidate: unknown,
  expectedSha256: unknown,
  allowedDir: string | null,
  platform: NodeJS.Platform,
  stagingDir: string,
): Promise<{ path: string } | { refused: string }> {
  const resolved = resolveInstaller(candidate, allowedDir, platform);
  if (!resolved) return { refused: `outside ${allowedDir ?? 'an unknown folder'}` };

  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    // No digest is a refusal, never a pass. An older panel that does not report
    // one must not be the reason an unverified installer runs.
    return { refused: 'the panel did not say what it should hash to' };
  }

  const staged = path.join(path.resolve(stagingDir), path.basename(resolved));

  let actual: string;
  try {
    await mkdir(path.dirname(staged), { recursive: true });
    await rm(staged, { force: true });
    await copyFile(resolved, staged);
    actual = await digestOf(staged);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    return { refused: `it could not be read: ${String(error)}` };
  }

  if (actual !== expectedSha256.toLowerCase()) {
    await rm(staged, { force: true }).catch(() => undefined);
    return { refused: `it hashes to ${actual}, not ${expectedSha256.toLowerCase()}` };
  }

  return { path: staged };
}
