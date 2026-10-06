#!/usr/bin/env node
/**
 * Render the application icon for both panels and the clean-install tool.
 *
 * electron-builder takes `icon.png` (1024×1024) from each app's
 * `buildResources` folder and produces the `.icns` from it; the Windows `.ico`
 * is written here too (`ico()` below). The geometry is `ui/src/logoCells.ts` and
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
  { dir: 'master', background: '#111318', ico: true },
  // A shade lighter, so a desk that has both installed can tell the two apart.
  { dir: 'office', background: '#1c2230', ico: true },
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

/*
 * The Windows icon, written beside the PNG (U11). electron-builder's own PNG-to-ICO
 * conversion gives a single 256 px image, which Windows shrinks to a blur in the
 * taskbar, the Start menu and Explorer's small views. One image per size Windows asks
 * for, each one a PNG, which Windows Vista and later (so Windows 7) and NSIS 3 read.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function ico(png) {
  const images = await Promise.all(ICO_SIZES.map((size) => sharp(png).resize(size, size).png().toBuffer()));
  // A 6-byte header, then one 16-byte entry per image, then the images.
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type 1: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const at = 6 + 16 * i;
    header[at] = ICO_SIZES[i] % 256; // 0 means 256
    header[at + 1] = ICO_SIZES[i] % 256;
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

// Only the panels: the clean-install tool's exe is not stamped (no afterPack hook there).
for (const { dir, background, ico: withIco } of apps) {
  const target = path.join(ROOT, dir, 'installer', 'icon.png');
  const png = await sharp(Buffer.from(svg(background))).png().toBuffer();
  await writeFile(target, png);
  if (withIco) await writeFile(target.replace(/\.png$/, '.ico'), await ico(png));
  console.log(`icon -> ${path.relative(ROOT, target)}${withIco ? ' (+ .ico)' : ''}`);
}
