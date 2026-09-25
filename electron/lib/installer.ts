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
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * The setup-file extension for each platform we build for.
 *
 * Linux is the AppImage, the build `tools/release.mjs` publishes there. It
 * used to fall through to `.exe` with everything else, so every AppImage a
 * panel had downloaded and verified was refused below, and an in-app update
 * could never run on Linux. The `.deb` is deliberately not accepted: see
 * `updateMethod`.
 */
export function installerExtension(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '.dmg';
  if (platform === 'linux') return '.AppImage';
  return '.exe';
}

/**
 * How this copy of the panel takes an update. Decided once, at launch, from
 * facts that do not change while the process lives.
 *
 *  - `installer` — hand the verified setup file to the operating system and
 *    quit: the NSIS setup on Windows, the `.dmg` on macOS.
 *  - `appimage` — Linux, launched from an AppImage. There is no installer to
 *    hand anything to: the AppImage *is* the program, so the verified file
 *    replaces it and is started again (`lib/appimage.ts`).
 *  - `standalone` — refuse. The portable `.exe` is replaced by hand
 *    (`lib/standalone.ts`).
 *  - `system-package` — refuse. Linux, but not a running AppImage: in a
 *    shipped build that is the `.deb`, whose files dpkg owns in a folder only
 *    root can write. The shell can neither replace them nor should it try,
 *    and the file a panel downloads is the AppImage in any case. The name is
 *    for that case, not a claim about every copy it covers: a run from
 *    source, from electron-builder's unpacked folder or from an AppImage
 *    unpacked by hand lands here too, with no one file to replace either —
 *    which is why the Updates screen's text starts from "not started from an
 *    AppImage" and only then turns to the `.deb`.
 *
 * Both refusals reach the page up front through `orderbook:getShellSettings`,
 * so the Updates screen says what to do instead of offering a button that
 * could only fail.
 */
export type UpdateMethod = 'installer' | 'appimage' | 'standalone' | 'system-package';

export function updateMethod(
  platform: NodeJS.Platform,
  build: { standalone: boolean; appImage: string | null },
): UpdateMethod {
  if (build.standalone) return 'standalone';
  if (platform !== 'linux') return 'installer';
  return build.appImage ? 'appimage' : 'system-package';
}

/**
 * Whether `candidate` is somewhere under `dir` — and not `dir` itself.
 *
 * `path.relative` rather than `startsWith`, so that `…/updates-evil` is not
 * accepted as being inside `…/updates`. This is the test the private
 * `isInside` in `office/src/config/paths.ts` makes, except that the folder
 * itself does not count here: what is checked is always a file in it. The
 * shell cannot import panel source, so the two are pinned by the same vectors
 * instead of shared.
 */
export function isInside(dir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
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
  if (path.extname(resolved).toLowerCase() !== installerExtension(platform).toLowerCase()) {
    return null;
  }

  return isInside(allowedDir, resolved) ? resolved : null;
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
 * Empty the staging folder before a new installer is copied into it.
 *
 * Two leftovers accumulate here and nothing else ever removes either. A copy
 * that was refused — wrong digest, a download that died halfway, a disk that
 * filled — used to be deleted only when the *next* attempt happened to have
 * the same filename, so a version bump between a failure and a retry stranded
 * 150 MB permanently. And a copy that installed successfully is never cleaned
 * up at all, because the app quits at that moment: a machine that has taken
 * four updates is holding four setup files it will never open again.
 *
 * So the whole folder goes, rather than one name. It holds exactly one file
 * that matters and only for the seconds between approving an installer and
 * spawning it; anything else in there is from a run that is over.
 *
 * Per-entry failures are swallowed on purpose. On Windows a running installer
 * holds a lock on its own file, and refusing to update because last month's
 * setup file is busy would be a worse outcome than the disk space.
 */
async function emptyStaging(stagingDir: string): Promise<void> {
  try {
    for (const entry of await readdir(stagingDir)) {
      await rm(path.join(stagingDir, entry), { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  } catch {
    // No folder yet, or unreadable. Nothing to empty either way.
  }
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
    await emptyStaging(path.dirname(staged));
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
