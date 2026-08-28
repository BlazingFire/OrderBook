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
 */

import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'electron', 'dist');

for (const panel of ['master', 'office']) {
  const target = path.join(ROOT, panel, 'electron', 'dist');
  await rm(target, { recursive: true, force: true });
  await cp(SOURCE, target, { recursive: true });
  console.log(`shell -> ${path.relative(ROOT, target)}`);
}
