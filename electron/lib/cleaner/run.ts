/**
 * Running one of the uninstall scripts and collecting what it says.
 *
 * The impure half of `detect.ts`: this spawns, that parses. Split so every
 * decision the tool makes is testable without a subprocess, and so the one
 * function that can actually delete a company's records is small enough to
 * read in a sitting.
 *
 * It does not build its own command line. `../uninstall.ts` owns
 * that, because the flag spellings are a contract with the two scripts and
 * `electron/tests/uninstall.test.ts` pins every place they appear — a command
 * assembled here would be one more place, in the one tool whose whole job is
 * to erase things correctly.
 */

import { spawn } from 'node:child_process';

export interface ScriptRun {
  readonly stdout: string;
  readonly exitCode: number | null;
}

/** What to spawn, as `electron/lib/uninstall.ts` builds it. */
export interface Command {
  readonly file: string;
  readonly args: string[];
}

/**
 * Run it, streaming each line out as it arrives.
 *
 * A full sweep stops processes and deletes a PostgreSQL cluster; on a slow
 * disk that is a minute of apparent silence. `onLine` is what lets the window
 * show it working rather than look hung.
 *
 * It never rejects on a non-zero exit. The scripts exit non-zero when they
 * could not remove something, and that is a result to report — the failures
 * are already in the output — not an exception to swallow.
 */
export function runScript(
  command: Command,
  onLine: (line: string) => void,
): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: true });
    let stdout = '';
    let pending = '';

    const take = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      stdout += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      // The last piece may be half a line; hold it until its newline arrives.
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };

    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (pending !== '') onLine(pending);
      resolve({ stdout, exitCode });
    });
  });
}
