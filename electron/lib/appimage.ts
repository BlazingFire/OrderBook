/**
 * Updating the Linux AppImage in place.
 *
 * Windows and macOS hand a verified setup file to the operating system — the
 * NSIS setup through ShellExecute, the `.dmg` through Finder — and quit. The
 * Linux build has nothing to hand it to: an AppImage *is* the program, one
 * self-mounting file the person keeps wherever they like, with no installer
 * and nothing registered anywhere. Updating it means replacing that file and
 * starting it again, which is what this does. The `.deb` is dpkg's to
 * replace, and the shell refuses it (`updateMethod` in `lib/installer.ts`).
 *
 * What the shell replaces the AppImage *with* has been through everything a
 * Windows setup file goes through first: taken from the folder the panel
 * names, copied into the per-user staging folder and hashed there by
 * `approveInstaller`. Only that verified copy reaches this file.
 *
 * `node:fs` only, and nothing here imports `electron`, so it runs under
 * Vitest without a window.
 */

import { constants, realpathSync } from 'node:fs';
import { chmod, copyFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { isInside } from './installer.js';

/**
 * @returns the AppImage file this copy was launched from, or `null` when it
 * was not launched from one.
 *
 * The AppImage runtime sets `APPIMAGE` (the file, symlinks resolved) and
 * `APPDIR` (where it mounted it) before it starts the app, and everything the
 * app starts inherits both. So `APPIMAGE` alone proves nothing: a `.deb` copy
 * started from a terminal inside some *other* AppImage — an editor's built-in
 * terminal is the usual one — carries that application's variables, and
 * believing them would overwrite somebody else's program with ours. What
 * cannot be inherited is that this very executable is running from inside
 * `APPDIR`.
 *
 * The mount is compared by its real path. The runtime reports it as it made
 * it, under `$TMPDIR`, while the executable's own path has every link
 * resolved — so a temporary folder under a linked home (Fedora Silverblue's
 * `/home` is one) would otherwise read as "not an AppImage".
 *
 * `packaged` first, for the reason `detectStandaloneBuild` gives: a panel run
 * from source is never the thing to replace.
 */
export function detectAppImage(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  execPath: string,
  packaged: boolean,
): string | null {
  if (!packaged || platform !== 'linux') return null;

  const file = env.APPIMAGE;
  const mount = env.APPDIR;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  if (typeof mount !== 'string' || !path.isAbsolute(mount)) return null;

  let realMount = mount;
  try {
    realMount = realpathSync.native(mount);
  } catch {
    // Unreadable: compare the path as the runtime gave it.
  }

  return isInside(realMount, execPath) ? path.resolve(file) : null;
}

/**
 * Put the verified AppImage where the running one is: a new file beside it,
 * made executable and flushed to disk, then renamed over it.
 *
 * - **Beside it**, because a rename is only atomic within one filesystem, and
 *   the staging folder under the profile is often on a different one from
 *   wherever the person keeps the AppImage.
 * - **Renamed over it, never written into.** The running copy is served from
 *   its own file by the AppImage runtime, which holds it open; writing into
 *   that file would change the program underneath the process running it. A
 *   rename leaves the old bytes to whatever still has them open and the new
 *   ones at the name, so there is no moment at which the path holds half of
 *   either.
 * - **0755**, because nothing made the staged copy executable — it has
 *   whatever mode the download was written with — and an AppImage that is not
 *   executable is a file that will not start.
 * - **Synced before the rename**, for the reason `writeDurable` gives in
 *   `master/src/lib/durable-file.ts`: a power cut between an unflushed write
 *   and the rename leaves a correctly named file with nothing in it — here,
 *   a panel that no longer starts at all.
 * - **Created, never opened.** The folder is the person's, so whatever sits at
 *   the temporary name — a half-copy from an attempt that died, or a link —
 *   is removed first, and the new file is created exclusively, so nothing
 *   put there in between can redirect the write.
 *
 * The same path, whatever version its name carries, so that a desktop entry
 * or a symlink pointing at it still works tomorrow. Throws on any failure,
 * having removed its temporary file and left the running copy as it was.
 */
export async function replaceAppImage(verified: string, target: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.update`);

  await rm(temporary, { force: true });
  try {
    await copyFile(verified, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o755);

    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The command that starts the new AppImage once this process has exited.
 *
 * Not simply the AppImage, spawned now: this copy still holds the
 * single-instance lock until it exits, so a new copy started now would say
 * "already running" and quit, and the person would be left with nothing
 * running at all. And not `app.relaunch`, whose helper is this copy's own
 * Electron binary, served from the mount that goes away with this process.
 *
 * So `/bin/sh`, which lives outside the mount, waits for this process to be
 * gone — sixty checks half a second apart, twice the fifteen seconds a quit
 * is allowed to take — and then becomes the new AppImage. The paths are
 * arguments to the script, never part of its text, so no folder name can be
 * read as a command.
 *
 * Before that it closes descriptors 3 to 9. The AppImage runtime keeps its
 * mount alive through a pipe this process holds without close-on-exec — among
 * the first descriptors the runtime opens, so in that range — and Node passes
 * such descriptors on to what it spawns. Carried into the new copy, it would
 * keep the old image mounted, and its file's space in use, for as long as the
 * new copy runs.
 *
 * `args` are the ones this copy was started with, as `app.relaunch` would
 * pass them — `--no-sandbox` among them on a system that needs it.
 */
export function relaunchCommand(
  target: string,
  pid: number,
  args: readonly string[],
): { file: string; args: string[] } {
  const script = [
    'i=0',
    'while kill -0 "$0" 2>/dev/null && [ "$i" -lt 60 ]; do',
    '  sleep 0.5 2>/dev/null || sleep 1',
    '  i=$((i + 1))',
    'done',
    'exec 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&-',
    'exec "$@"',
  ].join('\n');

  return { file: '/bin/sh', args: ['-c', script, String(pid), target, ...args] };
}
