/**
 * Telling the standalone build from an installed one.
 *
 * The standalone build is the same panel packaged by electron-builder's
 * `portable` target: one `.exe` that unpacks itself under `%TEMP%` and runs
 * from there, with nothing written to Program Files, no Start Menu entry and
 * no uninstaller. Its launcher stub sets three environment variables before
 * starting the app, and `PORTABLE_EXECUTABLE_FILE` — the path of the `.exe`
 * the person actually double-clicked — is the one that matters here.
 *
 * Three things differ for such a build, and all three are decided from this
 * one answer:
 *
 *  - **An in-app update cannot run.** The file the panel downloads is the
 *    NSIS setup, and running it from inside a standalone copy would install a
 *    second copy beside this one. A new standalone file replaces the old one
 *    by hand; both builds keep their data in the same directory under
 *    `%APPDATA%\OrderBook`, so nothing moves and nothing is lost.
 *  - **"Start with Windows" must point at the `.exe` the person keeps**, not
 *    at the unpacked copy under `%TEMP%` — that folder is deleted on exit, and
 *    a login item naming it would fail every morning with no message.
 *  - **There is no program folder to uninstall.** The sweep still removes the
 *    profile, the caches and, if asked, the data; the `.exe` is the person's
 *    to delete.
 *
 * Pure, so the decision is testable without Electron.
 */

import path from 'node:path';

export interface StandaloneBuild {
  /** The `.exe` the person launched, wherever they keep it. */
  readonly executable: string;
  /** Its folder. */
  readonly directory: string;
}

/**
 * @returns where the standalone `.exe` lives, or `null` for an installed
 * build and for a panel run from source.
 *
 * `packaged` is consulted first because the variables are inherited: a
 * developer whose terminal happens to carry `PORTABLE_EXECUTABLE_FILE` from
 * an earlier launch must not have `npm run dev` treated as a standalone copy.
 */
export function detectStandaloneBuild(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): StandaloneBuild | null {
  if (!packaged) return null;

  const executable = env.PORTABLE_EXECUTABLE_FILE;
  if (typeof executable !== 'string' || executable.trim() === '') return null;

  const directory = env.PORTABLE_EXECUTABLE_DIR;
  return {
    executable,
    directory:
      typeof directory === 'string' && directory.trim() !== ''
        ? directory
        : path.dirname(executable),
  };
}

/**
 * The extra options every `app.setLoginItemSettings` / `getLoginItemSettings`
 * call needs so that the item names a file that will still exist tomorrow.
 *
 * Electron defaults the login item to `process.execPath` — for a standalone
 * build that is `%TEMP%\<unpack dir>\OrderBook Master Panel.exe`, which the
 * launcher removes on exit.
 */
export function loginItemOptions(standalone: StandaloneBuild | null): { path?: string } {
  return standalone ? { path: standalone.executable } : {};
}
