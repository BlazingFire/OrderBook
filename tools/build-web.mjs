#!/usr/bin/env node
/**
 * Build one web workspace: `tsc -b`, then `vite build`, with the temp
 * directory pointed at a project-local `.tmp/`.
 *
 * Run from a web workspace's `build` script (`node ../../tools/build-web.mjs`).
 *
 * Why a script and not a one-liner in `package.json`: the one-liner was
 * `cmd.exe` syntax — `if not exist … mkdir …` and `set TEMP=…` — because on
 * the owner's PC esbuild's temp files under the system `%TEMP%` fail with
 * "Access is denied" and pointing `TEMP`/`TMP` at a folder inside the
 * repository is the fix (HANDOFF.md, 2026-09-14 and 2026-09-21). But `npm`
 * hands a script to `sh` everywhere else, and `sh` reads that line as a
 * syntax error — so `npm run build` failed on the Linux CI runner on every
 * push since, and a Mac could not build the panels at all. Node is the one
 * shell every machine here has.
 *
 * `INIT_CWD` is where `npm run` was invoked — the repository root when run
 * through `--workspace` — so `.tmp/` lands in one place, and that place is
 * gitignored. It falls back to the workspace itself when the script is run
 * directly.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const tmp = path.join(process.env.INIT_CWD ?? process.cwd(), '.tmp');
mkdirSync(tmp, { recursive: true });

const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };

for (const [command, args] of [
  ['tsc', ['-b']],
  ['vite', ['build']],
]) {
  // `shell` on Windows only: `tsc` and `vite` on PATH there are `.cmd` shims,
  // which `spawn` cannot start without one. Elsewhere they are executables.
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`Could not start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
