#!/usr/bin/env node
/**
 * Render the application icons for both panels and the clean-install tool
 * from the mark (the Icons and Panels artboards).
 *
 * electron-builder takes `icon.png` (1024 × 1024) from each app's
 * `buildResources` folder and makes the `.icns` from it. The Windows `.ico` is
 * written here too, and it is not that PNG shrunk: every size is drawn on its
 * own, with the proportions the Icons artboard gives it, and at 24 px and below
 * the two ghost squares are left out so the mark stays crisp. The afterPack hook
 * (`tools/flip-fuses.cjs`, `tools/exe-icon.cjs`) stamps that `.ico` into the exe,
 * so it is also the window, taskbar and shortcut icon.
 *
 * The geometry is `ui/src/logoCells.ts` and the cobalt is the light accent,
 * `--glaze-50` in `ui/src/tokens.css`, both read here, so the icon cannot drift from the mark the
 * app draws.
 *
 *   node tools/make-icons.mjs
 *
 * `renderIcons()` is exported for `master/tests/app-icons.test.ts`, which checks
 * that the committed icons are exactly what this renders.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function geometry() {
  const source = await readFile(path.join(ROOT, 'ui', 'src', 'logoCells.ts'), 'utf8');
  const cellsOf = (name) => {
    const block = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(source)?.[1];
    if (!block) throw new Error(`${name} not found in ui/src/logoCells.ts`);
    return [...block.matchAll(/\[\s*(\d+),\s*(\d+)\s*\]/g)].map(([, x, y]) => [Number(x), Number(y)]);
  };
  const radius = Number(/export const CELL_RADIUS = ([\d.]+);/.exec(source)?.[1]);
  const ghostlessMax = Number(/export const GHOSTLESS_MAX_PX = (\d+);/.exec(source)?.[1]);
  if (!radius || !ghostlessMax) throw new Error('CELL_RADIUS or GHOSTLESS_MAX_PX not found in ui/src/logoCells.ts');

  // The light theme's accent, the first `--glaze-50` in the file (dark redefines it later).
  const tokens = await readFile(path.join(ROOT, 'ui', 'src', 'tokens.css'), 'utf8');
  const cobalt = /--glaze-50:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
  if (!cobalt) throw new Error('--glaze-50 not found in ui/src/tokens.css');

  return { cells: cellsOf('CELLS'), ghosts: cellsOf('GHOST_CELLS'), radius, ghostlessMax, cobalt };
}

/**
 * Tile corner radius and mark size, as fractions of the icon, per size (the
 * Icons artboard: 240 tile with radius 24 and mark 168 for the Windows master,
 * 128/16/96, 64/10/48, 48/8/36, 32/6/26, 24/4/20, 16/3/14). The 1024 PNG is the
 * macOS master: radius 54 and mark 156 on a 240 tile.
 */
const PROPORTIONS = {
  16: { radius: 3 / 16, mark: 14 / 16 },
  24: { radius: 4 / 24, mark: 20 / 24 },
  32: { radius: 6 / 32, mark: 26 / 32 },
  48: { radius: 8 / 48, mark: 36 / 48 },
  64: { radius: 10 / 64, mark: 48 / 64 },
  128: { radius: 16 / 128, mark: 96 / 128 },
  256: { radius: 24 / 240, mark: 168 / 240 },
  1024: { radius: 54 / 240, mark: 156 / 240 },
};

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * The three programs (the Panels artboard). The Office is the cobalt tile with
 * the white mark; the Master the white tile with a hairline and the cobalt mark,
 * so a desk with both can tell them apart. The clean-install tool is not on the
 * artboard: it keeps the warning colour, because it is the one of the three
 * that erases a company's database and must never be opened for the Master at a
 * glance.
 */
function apps(cobalt) {
  return [
    { dir: 'master', ico: true, tile: '#ffffff', border: '#b9c1c6', ink: cobalt, ghost: 0.2 },
    { dir: 'office', ico: true, tile: cobalt, ink: '#ffffff', ghost: 0.3 },
    { dir: 'cleaner', ico: false, tile: '#331716', ink: '#ffffff', ghost: 0.3 },
  ];
}

function svg(size, app, g) {
  const { radius, mark } = PROPORTIONS[size];
  const markPx = size * mark;
  const offset = (size - markPx) / 2;
  const unit = markPx / 24;
  const square = ([x, y]) =>
    `<rect x="${offset + x * unit}" y="${offset + y * unit}" width="${4 * unit}" height="${4 * unit}" rx="${g.radius * unit}"/>`;
  // The Master's hairline is 1 px on the artboard's 88 px tile.
  const border = app.border ? Math.max(1, size / 88) : 0;
  const tile = app.border
    ? `<rect x="${border / 2}" y="${border / 2}" width="${size - border}" height="${size - border}" rx="${size * radius}" fill="${app.tile}" stroke="${app.border}" stroke-width="${border}"/>`
    : `<rect width="${size}" height="${size}" rx="${size * radius}" fill="${app.tile}"/>`;
  const ghosts =
    size > g.ghostlessMax ? `<g fill="${app.ink}" opacity="${app.ghost}">${g.ghosts.map(square).join('')}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${tile}<g fill="${app.ink}">${g.cells.map(square).join('')}</g>${ghosts}</svg>`;
}

const png = (size, app, g) => sharp(Buffer.from(svg(size, app, g))).png().toBuffer();

/** One PNG per size, each in a 16-byte directory entry: Windows Vista and later (so Windows 7) and NSIS 3 read it. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type 1: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header[at] = size % 256; // 0 means 256
    header[at + 1] = size % 256;
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

/** Every icon file, by its path relative to the repository root. */
export async function renderIcons() {
  const g = await geometry();
  const files = new Map();
  for (const app of apps(g.cobalt)) {
    files.set(`${app.dir}/installer/icon.png`, await png(1024, app, g));
    if (app.ico) {
      const images = await Promise.all(ICO_SIZES.map(async (size) => ({ size, data: await png(size, app, g) })));
      files.set(`${app.dir}/installer/icon.ico`, ico(images));
    }
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, data] of await renderIcons()) {
    await writeFile(path.join(ROOT, file), data);
    console.log(`icon -> ${file}`);
  }
}
