/**
 * What the "OrderBook Master Update" scheduled task runs, elevated (1.4 R8,
 * option B). The reasoning is in `lib/staged-update.ts`; this is the part that
 * touches the disk.
 *
 * It is started as `ELECTRON_RUN_AS_NODE=1 "<OrderBook Master Panel.exe>" apply-staged-update.js`
 * by `apply-update.cmd`, both installed under `resources/apply-update` (a folder
 * only an administrator can write), so it is Node with no window and no app.
 *
 * It imports nothing from `node_modules` but the installed `@orderbook/shared`
 * (for the release keys and the signed payload), loaded by absolute path from
 * `resources/panel`, which is also administrator-only. Exit codes: 0 the
 * installer ran and finished; 2 refused (the log says why); 3 could not run.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  STAGED_MANIFEST,
  judgeInstallerFile,
  judgeStagedManifest,
  sha256OfFile,
  stagedUpdateDirs,
  type ReleaseTrust,
} from './lib/staged-update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(here, '..');
const { stage, work } = stagedUpdateDirs(process.env);
const logFile = path.join(work, 'apply.log');

async function say(message: string): Promise<void> {
  await appendFile(logFile, `${new Date().toISOString()} ${message}\n`).catch(() => undefined);
}

async function main(): Promise<number> {
  // The administrators-only folder is made by the installer. Not there means it
  // was never made (or was removed): nothing here may be trusted to sit still.
  try {
    await stat(work);
  } catch {
    return 3;
  }
  await say('Nightly update task started');

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
    await say(`Refused: the staged manifest could not be read (${String(error)})`);
    return 2;
  }

  const verdict = judgeStagedManifest(raw, installed, trust);
  if (!verdict.ok) {
    await say(`Refused: ${verdict.reason}`);
    return 2;
  }
  const { manifest } = verdict;

  // Copied into the administrators-only folder first, and the copy is what is
  // hashed and run: the staged original can be rewritten by anyone, at any time.
  const copy = path.join(work, manifest.file);
  try {
    await mkdir(work, { recursive: true });
    await rm(copy, { force: true });
    await copyFile(path.join(stage, manifest.file), copy);
  } catch (error) {
    await say(`Refused: the setup file could not be copied (${String(error)})`);
    return 2;
  }

  const sizeBytes = (await stat(copy)).size;
  const check = judgeInstallerFile(manifest, { sizeBytes, sha256: await sha256OfFile(copy) });
  if (!check.ok) {
    await rm(copy, { force: true });
    await say(`Refused: ${check.reason}`);
    return 2;
  }

  await say(`Running ${manifest.file} (${manifest.version}) silently`);
  // Not detached, and waited for: a task's processes can end with the task, and
  // the installer must outlive this script by the length of the install.
  const child = spawn(copy, ['/S', '--force-run'], { stdio: 'ignore', windowsHide: true });
  const [code] = (await once(child, 'exit')) as [number | null];
  await say(`The installer exited with ${String(code)}`);
  await rm(copy, { force: true }).catch(() => undefined);
  return code === 0 ? 0 : 3;
}

main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    await say(`Failed: ${String(error)}`);
    process.exit(3);
  },
);
