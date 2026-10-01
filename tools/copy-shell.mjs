/**
 * Put the built desktop shell where each panel expects to find it.
 *
 * One shell serves both panels, but `electron-builder.yml` packages
 * `electron/dist/**` from *inside* the panel folder, and the shell locates its
 * server by walking up from its own directory. So the compiled output is
 * copied into `<panel>/electron/dist` rather than either the yml or the shell
 * learning about a path outside the panel.
 *
 * `tools/release.mjs` does the same thing for a real build; this exists so
 * `npm run build:shell` gives the same layout for running from source.
 *
 * `--legacy` (`npm run build:shell:legacy`) copies the CommonJS build of the
 * shell for the Windows 7 Office instead (docs/WINDOWS7.md), to the Office
 * only, and writes `{"type":"commonjs"}` beside it. The panel's own
 * package.json says `"type": "module"`, so without that marker Electron 22
 * would read the compiled `.js` files as ES modules and fail on the first
 * `require`. The marker covers only `electron/dist`; the Office server in
 * `office/dist` stays ESM. `npm run build:shell` puts the ESM shell back.
 */

import { cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = process.argv.includes('--legacy');
const SOURCE = LEGACY
  ? path.join(ROOT, 'build', 'shell-legacy')
  : path.join(ROOT, 'electron', 'dist');

for (const panel of LEGACY ? ['office'] : ['master', 'office']) {
  const target = path.join(ROOT, panel, 'electron', 'dist');
  await rm(target, { recursive: true, force: true });
  await cp(SOURCE, target, { recursive: true });
  if (LEGACY) await writeFile(path.join(target, 'package.json'), '{"type":"commonjs"}\n');
  console.log(`shell${LEGACY ? ' (legacy, CommonJS)' : ''} -> ${path.relative(ROOT, target)}`);
}
