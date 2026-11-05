#!/usr/bin/env node
/**
 * Build a panel's web bundle, with a temp directory Vite is allowed to delete.
 *
 * ## Why this exists at all
 *
 * On Windows, `vite build` fails with
 * `remove C:\Users\…\AppData\Local\Temp\esbuild-…: Access is denied`. esbuild
 * unpacks a helper binary into the OS temp folder and removes it on exit;
 * Defender (or any scanner) holds a lock on the freshly written executable long
 * enough that the removal loses the race. Pointing `TEMP`/`TMP` at a
 * project-local, gitignored `.tmp/` moves the whole dance somewhere nothing is
 * watching.
 *
 * ## Why it is a script rather than an npm script
 *
 * It was an npm script, written in `cmd` — `if not exist "%INIT_CWD%\.tmp"
 * mkdir … && set "TEMP=…" && …`. That is not a shell command anywhere but
 * Windows, so `npm run build` simply could not run on Linux or macOS: it died
 * with `sh: 1: Syntax error` before compiling anything. The fix for a Windows
 * problem had made the build Windows-only, which among other things means no
 * CI runner can build this project.
 *
 * Node runs the same everywhere, `tools/` is where this repo already puts that
 * kind of thing (`copy-shell.mjs`), and setting an environment
 * variable for a child process needs no shell at all.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repo's own `tsc` and `vite`, resolved by path rather than by PATH.
 *
 * Not fussiness: this machine had a **global TypeScript 6.0.2** ahead of the
 * project's pinned 5.9.3 on PATH, and TS 6 rejects the side-effect CSS imports
 * in `main.tsx` (TS2882) that 5.9 accepts. The build failed with two type
 * errors in code that is fine. Spawning by absolute path means the build uses
 * the compiler the lockfile promises, whatever else is installed.
 */
function bin(name) {
  const local = path.join(ROOT, 'node_modules', '.bin', name);
  const exe = process.platform === 'win32' ? `${local}.cmd` : local;
  // Falling back to the bare name keeps a checkout with a hoisted or otherwise
  // unusual layout working, rather than failing on a missing file.
  return existsSync(exe) ? exe : name;
}

/**
 * The workspace being built.
 *
 * `process.cwd()`, not `INIT_CWD`. npm sets the cwd of a workspace script to
 * that workspace; `INIT_CWD` is where the *user* typed the command, which for
 * `npm run build --workspace @orderbook/master-web` is the repo root. The
 * `cmd` script this replaced used `%INIT_CWD%` and got away with it only
 * because it used it for the temp folder alone — `tsc` still inherited npm's
 * cwd. Using it for both put `tsc -b` at the root, looking for a tsconfig.json
 * that does not exist there.
 */
const workspace = process.cwd();
const tmp = path.join(workspace, '.tmp');

mkdirSync(tmp, { recursive: true });

const env = { ...process.env, TEMP: tmp, TMP: tmp };

for (const [command, ...args] of [
  [bin('tsc'), '-b'],
  [bin('vite'), 'build'],
]) {
  // `shell: true` on Windows only, where the resolved binaries are `.cmd` shims
  // that `spawn` cannot execute directly. Elsewhere it would be an extra
  // process and an extra quoting hazard for no benefit.
  const result = spawnSync(process.platform === "win32" ? `"${command}"` : command, args, {
    cwd: workspace,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
