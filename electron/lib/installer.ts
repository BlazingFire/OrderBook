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
