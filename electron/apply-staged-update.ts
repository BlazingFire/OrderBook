/**
 * What the "OrderBook Master Update" scheduled task runs, elevated (1.4 R8,
 * option B). The reasoning is in `lib/staged-update.ts`; this is the part that
 * touches the disk.
 *
 * It is started as `ELECTRON_RUN_AS_NODE=1 "<OrderBook Master Panel.exe>" apply-staged-update.js`
 * by `apply-update.cmd`, which first clears every `NODE_*` and `ELECTRON_*`
 * variable (the Electron fuses also switch `NODE_OPTIONS` and `--inspect` off in
 * the packaged exe). Both files and this script are installed under
 * `resources/apply-update`, a folder only an administrator can write.
 *
 * **It trusts nothing in its environment.** Every path comes from `paths.json`,
 * written by the installer into that same folder; the system's `powershell.exe`
 * is the one named there; the `@orderbook/shared` it loads is the installed one,
 * by absolute path. Before it touches the work folder it asks PowerShell
 * (`update-dirs.ps1 -Mode Check`) whether that folder, and every folder above it,
 * is still owned by Administrators or SYSTEM, writable by nobody else, and not a
 * link.
 *
 * Exit codes: 0 the installer ran and finished; 2 refused (the log says why);
 * 3 could not run. It also writes `result.json` into the work folder, which the
 * shell (a non-administrator) may read, so a refusal brings the server back.
 */

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  STAGED_MANIFEST,
  TASK_RESULT,
  judgeInstallerFile,
  judgeStagedManifest,
  parseUpdatePaths,
  sha256OfFile,
  systemModulePath,
  taskChildEnv,
  UPDATE_PATHS_FILE,
  type ReleaseTrust,
  type TaskStatus,
} from './lib/staged-update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(here, '..');
const applyDir = path.join(resources, 'apply-update');

async function main(): Promise<number> {
  // Where everything lives, from the installer's own file.
  const paths = parseUpdatePaths(await readFile(path.join(applyDir, UPDATE_PATHS_FILE), 'utf8').catch(() => ''));
  if (!paths) return 3;
  const { stage, work, powershell } = paths;
  const logFile = path.join(work, 'apply.log');
  const say = async (message: string): Promise<void> => {
    await appendFile(logFile, `${new Date().toISOString()} ${message}\n`).catch(() => undefined);
  };
  const tell = async (status: TaskStatus, reason?: string): Promise<void> => {
    await writeFile(path.join(work, TASK_RESULT), JSON.stringify({ status, reason })).catch(() => undefined);
  };
  const refuse = async (reason: string): Promise<number> => {
    await say(`Refused: ${reason}`);
    await tell('refused', reason);
    return 2;
  };

  // The work folder must be exactly what the installer made: not a link, owned by
  // Administrators or SYSTEM, and writable by nobody else, with every folder above
  // it the same. Anything else, and nothing here may be trusted to sit still.
  const check = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(applyDir, 'update-dirs.ps1'),
        '-Mode',
        'Check',
        '-Path',
        work,
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        // The account's own PSModulePath would put its writable Documents\Modules first.
        env: taskChildEnv(paths, { PSModulePath: systemModulePath(powershell) }),
      },
      (error, stdout) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, output: String(stdout).trim() }),
    );
  });
  if (check.code !== 0) {
    // Nothing is written: the folder that failed the check may be a link to somewhere
    // else, and writing through it as an administrator is exactly what it would want.
    // The shell, hearing nothing, brings the server back after `TASK_ANSWER_MS`.
    return 2;
  }
  await say('Nightly update task started');
  await tell('checking');

  const panel = path.join(resources, 'panel');
  const trust = (await import(
    pathToFileURL(path.join(panel, 'node_modules', '@orderbook', 'shared', 'dist', 'index.js')).href
  )) as ReleaseTrust;
  const installed = (JSON.parse(await readFile(path.join(panel, 'package.json'), 'utf8')) as { version: string })
    .version;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(stage, STAGED_MANIFEST), 'utf8'));
  } catch (error) {
    return refuse(`the staged manifest could not be read (${String(error)})`);
  }

  const verdict = judgeStagedManifest(raw, installed, trust);
  if (!verdict.ok) return refuse(verdict.reason);
  const { manifest } = verdict;

  // Copied into the administrators-only folder first, and the copy is what is
  // hashed and run: the staged original can be rewritten by anyone, at any time.
  const copy = path.join(work, manifest.file);
  try {
    await rm(copy, { force: true });
    await copyFile(path.join(stage, manifest.file), copy);
  } catch (error) {
    return refuse(`the setup file could not be copied (${String(error)})`);
  }

  const sizeBytes = (await stat(copy)).size;
  const judged = judgeInstallerFile(manifest, { sizeBytes, sha256: await sha256OfFile(copy) });
  if (!judged.ok) {
    await rm(copy, { force: true });
    return refuse(judged.reason);
  }

  // The installer unpacks into TEMP. The account's own TEMP is a folder its other
  // programs can write, so the setup gets this one instead.
  const temp = path.join(work, 'tmp');
  await mkdir(temp, { recursive: true });

  await say(`Running ${manifest.file} (${manifest.version}) silently`);
  await tell('installing');
  // Not detached, and waited for: a task's processes can end with the task, and
  // the installer must outlive this script by the length of the install.
  const child = spawn(copy, ['/S', '--force-run'], {
    stdio: 'ignore',
    windowsHide: true,
    env: taskChildEnv(paths, { TEMP: temp, TMP: temp }),
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  await say(`The installer exited with ${String(code)}`);
  await rm(copy, { force: true }).catch(() => undefined);
  return code === 0 ? 0 : 3;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(3),
);
