#!/usr/bin/env node
/**
 * Render the application icon for both panels and the clean-install tool.
 *
 * electron-builder takes a single `icon.png` (1024×1024) from each app's
 * `buildResources` folder and produces the `.ico` and `.icns` itself, so one
 * PNG per app is the whole asset. The geometry is `ui/src/logoCells.ts` and
 * the colour is `--glaze-50` from `ui/src/tokens.css`, read at build time so
 * the icon cannot drift from the mark drawn in the sidebar.
 *
 *   node tools/make-icons.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cellsSource = await readFile(path.join(ROOT, 'ui', 'src', 'logoCells.ts'), 'utf8');
const CELLS = [...cellsSource.matchAll(/\[\s*(\d+),\s*(\d+)\s*\]/g)].map(([, x, y]) => [
  Number(x),
  Number(y),
]);
if (CELLS.length === 0) throw new Error('No cells found in ui/src/logoCells.ts');

const tokens = await readFile(path.join(ROOT, 'ui', 'src', 'tokens.css'), 'utf8');
const accent = /--glaze-50:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
if (!accent) throw new Error('--glaze-50 not found in ui/src/tokens.css');

const SIZE = 1024;
// macOS masks its own rounded rectangle; Windows shows the bitmap as-is. A
// rounded dark tile with a 10% margin reads correctly in both.
const RADIUS = Math.round(SIZE * 0.22);
const MARGIN = SIZE * 0.2;
const SCALE = (SIZE - MARGIN * 2) / 24;

function svg(background) {
  const rects = CELLS.map(
    ([x, y]) =>
      `<rect x="${MARGIN + x * SCALE}" y="${MARGIN + y * SCALE}" width="${4 * SCALE}" height="${4 * SCALE}" rx="${SCALE * 0.4}" fill="${accent}"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="${background}"/>${rects}
</svg>`;
}

const apps = [
  { dir: 'master', background: '#111318' },
  // A shade lighter, so a desk that has both installed can tell the two apart.
  { dir: 'office', background: '#1c2230' },
  /*
   * The clean-install tool, in the warning colour rather than a third shade of
   * the same blue-grey.
   *
   * It is the one of the three that erases a company's database, and it will
   * sit in a downloads folder beside two icons it would otherwise be a near
   * match for. Somebody reaching for the Master at a glance must not open this
   * instead. `--kiln-red-05` from `tokens.css`, the same dark red every
   * destructive surface in the product already uses.
   */
  { dir: 'cleaner', background: '#331716' },
];

for (const { dir, background } of apps) {
  const target = path.join(ROOT, dir, 'installer', 'icon.png');
  await writeFile(target, await sharp(Buffer.from(svg(background))).png().toBuffer());
  console.log(`icon -> ${path.relative(ROOT, target)}`);
}
