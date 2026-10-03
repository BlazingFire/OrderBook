/**
 * How the shell starts a verified setup file (1.4 R7 and R8).
 *
 * Decided here, not in `shell.ts`, because that file imports `electron` and
 * cannot run under the suite and because getting this wrong has a cost no
 * screen shows: by the time the installer starts, the server is already
 * stopped.
 *
 * **Windows.** The setup file is a per-machine NSIS installer, so it needs
 * elevation. It is run `/S --force-run`: silent (no wizard to click through) and
 * relaunching the app when it finishes, which electron-builder's template does
 * only for `--force-run` in a silent install.
 *
 *  - **Somebody is there to answer UAC** (the Install button): PowerShell's
 *    `Start-Process -Verb RunAs` raises the prompt. `spawn` could not: it is
 *    `CreateProcess`, which cannot elevate.
 *  - **Nobody is** (the nightly update): a prompt on the secure desktop would
 *    wait for an answer that is not coming, with the server already stopped and
 *    the shop's Master down all night. So the nightly update never raises one:
 *      - already elevated: it runs the setup directly;
 *      - not elevated, but the installer registered the "OrderBook Master Update"
 *        task at install time: it asks Windows to run that task (`task`), which
 *        verifies the signed manifest itself and installs (`lib/staged-update.ts`);
 *      - neither: it declines (`needs-approval`) and leaves everything running.
 *
 * macOS opens the `.dmg`; Linux is the AppImage path and does not come here.
 */

import { TASK_NAME } from './staged-update.js';

/** The arguments the NSIS setup is run with: silent, and start the app afterwards. */
export const INSTALLER_ARGUMENTS: readonly string[] = ['/S', '--force-run'];

export type InstallerLaunch =
  /** Hand the file to the OS shell (a `.dmg`). */
  | { how: 'open' }
  /** Run it directly: this process is already elevated. */
  | { how: 'spawn'; command: string; args: string[] }
  /** Ask Windows to elevate it, which raises the UAC prompt. */
  | { how: 'elevate'; command: string; args: string[] }
  /** Ask Windows to run the pre-approved update task; the task does the checking and the install. */
  | { how: 'task'; command: string; args: string[] }
  /** Cannot be done without somebody to approve it. Nothing was started. */
  | { how: 'needs-approval' };

/** The "High Mandatory Level" SID `whoami /groups` lists for an elevated token. */
const HIGH_INTEGRITY_SID = 'S-1-16-12288';

/** Whether `whoami /groups` output says this process runs with an elevated token. */
export function isHighIntegrity(whoamiGroups: string): boolean {
  return whoamiGroups.includes(HIGH_INTEGRITY_SID);
}

/** A string as a PowerShell single-quoted literal: only `'` needs doubling. */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function planInstallerLaunch(input: {
  platform: NodeJS.Platform;
  file: string;
  /** True when nobody is at the keyboard to approve a prompt. */
  unattended: boolean;
  /** Whether this process already holds an elevated token (Windows). */
  elevated: boolean;
  /** Whether the installer's update task is registered and its folders are in place. */
  taskReady?: boolean;
}): InstallerLaunch {
  if (input.platform !== 'win32') return { how: 'open' };

  if (input.elevated) {
    return { how: 'spawn', command: input.file, args: [...INSTALLER_ARGUMENTS] };
  }
  if (input.unattended) {
    return input.taskReady
      ? { how: 'task', command: 'schtasks.exe', args: ['/Run', '/TN', TASK_NAME] }
      : { how: 'needs-approval' };
  }

  const list = INSTALLER_ARGUMENTS.map(powershellQuote).join(',');
  return {
    how: 'elevate',
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `Start-Process -FilePath ${powershellQuote(input.file)} -ArgumentList ${list} -Verb RunAs`,
    ],
  };
}

/**
 * Whether a health report is asking for tonight's unattended install, and for
 * the build that is actually prepared. The version must match: a request for
 * 1.3.1 with 1.3.0 prepared is a stale request, and installing the wrong build
 * on a timer is worse than not installing.
 */
export function unattendedInstallDue(
  health: { autoUpdate?: { version: string } | null; installer?: { version: string } | null },
  alreadyStarted: string | null,
): string | null {
  const wanted = health.autoUpdate?.version;
  if (!wanted || health.installer?.version !== wanted) return null;
  return wanted === alreadyStarted ? null : wanted;
}
