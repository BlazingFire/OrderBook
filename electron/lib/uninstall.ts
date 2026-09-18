/**
 * Turning "uninstall this panel" into a command the OS can run after we quit.
 *
 * The shell cannot remove itself: the uninstaller replaces the files this
 * process is running from, and the data directory holds a PostgreSQL cluster
 * the server has to close first. So the shell stops its server, hands one of
 * the two scripts under `tools/uninstall/` to the platform, and quits — the
 * script does the rest with nothing of ours still running.
 *
 * Pure so the exact command line is pinned by a test. The argument shapes are
 * a contract with those scripts (`-Panel`/`--panel`, `-Yes`/`--yes`,
 * `-KeepData`/`--keep-data`); a flag renamed on one side and not the other
 * would either fail loudly (PowerShell rejects unknown parameters) or, worse,
 * silently fall back to the script's default and erase what was asked to be
 * kept. That is why `keepData` is the only thing that varies here.
 */

import path from 'node:path';

export interface UninstallRequest {
  readonly platform: NodeJS.Platform;
  readonly panel: 'master' | 'office';
  /** `true` leaves the database, uploads and settings on disk. */
  readonly keepData: boolean;
  /** Folder holding `uninstall-orderbook.ps1` and `uninstall-orderbook.sh`. */
  readonly scriptsDir: string;
}

export interface UninstallCommand {
  readonly file: string;
  readonly args: string[];
}

/**
 * Where the scripts live, packaged or not.
 *
 * Packaged, `extraResources` copies `tools/uninstall` to `resources/uninstall`
 * beside the panel. From source `here` is `<panel>/electron/dist` (see
 * `serverRoot()` in `shell.ts`), and `tools/` sits at the repository root one
 * level above the panel — three steps up, not the two `serverRoot` takes.
 */
export function uninstallScriptsDir(
  isPackaged: boolean,
  resourcesPath: string,
  here: string,
): string {
  return isPackaged
    ? path.join(resourcesPath, 'uninstall')
    : path.resolve(here, '..', '..', '..', 'tools', 'uninstall');
}

/** A path inside a POSIX shell single-quoted string: only `'` needs care. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A value inside an AppleScript double-quoted string literal. */
function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * @returns what to spawn, or `null` on a platform we ship no uninstaller for.
 *
 * Windows runs the PowerShell script directly; it elevates itself. macOS goes
 * through Terminal on purpose: the script needs `sudo` for `/Applications`,
 * and a detached `bash` has nowhere to ask for the password — the person
 * would see the app vanish and nothing else happen.
 */
export function uninstallCommand(request: UninstallRequest): UninstallCommand | null {
  const { platform, panel, keepData, scriptsDir } = request;

  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(scriptsDir, 'uninstall-orderbook.ps1'),
        '-Panel',
        panel,
        '-Yes',
        ...(keepData ? ['-KeepData'] : []),
      ],
    };
  }

  if (platform === 'darwin') {
    // `path.posix` deliberately: this branch is pinned by a test that also runs
    // on Windows, where `path.join` would hand a Mac a backslashed path.
    const script = shellQuote(path.posix.join(scriptsDir, 'uninstall-orderbook.sh'));
    const command = `bash ${script} --panel ${panel} --yes${keepData ? ' --keep-data' : ''}`;
    return {
      file: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${appleScriptString(command)}"`],
    };
  }

  if (platform === 'linux') {
    /*
     * The same script, run directly rather than through a terminal.
     *
     * macOS needs Terminal because `/Applications` belongs to root and the
     * script's `sudo` has to have somewhere to ask. A Linux install is
     * per-user — the AppImage sits in `~/Applications`, the profile and data
     * under `$XDG_CONFIG_HOME` — so there is normally nothing to elevate for,
     * and the script already falls back to `sudo` on its own for the case
     * where somebody put the AppImage in `/opt` by hand. Picking a terminal
     * emulator for an arbitrary desktop is a guess with no good default.
     */
    return {
      file: 'bash',
      args: [
        path.posix.join(scriptsDir, 'uninstall-orderbook.sh'),
        '--panel',
        panel,
        '--yes',
        ...(keepData ? ['--keep-data'] : []),
      ],
    };
  }

  return null;
}
