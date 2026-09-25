/**
 * Placeholder product photos for the sample dataset: a square tile swatch
 * drawn as SVG and rasterised with sharp, so the seed can push it through the
 * same upload pipeline a real photo takes (variants, blurhash, checksum) and
 * every catalogue screen shows a picture rather than an empty frame.
 *
 * Deliberately no text — SVG text needs a font the rasteriser can find, which
 * differs per machine, and a swatch that renders as boxes on one PC would be
 * worse than none. The pattern and the colour are what identify a tile.
 */

import sharp from 'sharp';

import { createRandom } from '../domain/sample-data.js';

export type SwatchPattern = 'marble' | 'wood' | 'stone' | 'plain';

export interface SwatchSpec {
  /** `#RRGGBB` — the tile's colour, from the `stock.colour` option list. */
  baseHex: string;
  pattern: SwatchPattern;
  /** Distinguishes two products in the same colour and pattern. */
  seed: number;
  /** Pixels per side. */
  size?: number;
}

const DEFAULT_SWATCH_SIZE = 800;

/** The swatch as SVG markup. Pure, so a test can assert on it without sharp. */
export function tileSwatchSvg(spec: SwatchSpec): string {
  const size = spec.size ?? DEFAULT_SWATCH_SIZE;
  const random = createRandom(spec.seed);
  const base = parseHex(spec.baseHex);
  const light = toHex(mix(base, { r: 255, g: 255, b: 255 }, 0.18));
  const dark = toHex(mix(base, { r: 0, g: 0, b: 0 }, 0.22));
  const vein = toHex(mix(base, { r: 0, g: 0, b: 0 }, isDark(base) ? -0.35 : 0.45));

  const body = patternBody(spec.pattern, size, random, { light, dark, vein });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    '<defs>',
    `<linearGradient id="base" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${light}"/>`,
    `<stop offset="1" stop-color="${dark}"/>`,
    '</linearGradient>',
    `<linearGradient id="gloss" x1="0" y1="0" x2="1" y2="1">`,
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>',
    '<stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>',
    '</linearGradient>',
    '</defs>',
    `<rect width="${size}" height="${size}" fill="${spec.baseHex}"/>`,
    `<rect width="${size}" height="${size}" fill="url(#base)"/>`,
    body,
    `<rect width="${size}" height="${size}" fill="url(#gloss)"/>`,
    // A thin bevel, so the swatch reads as a tile rather than a colour chip.
    `<rect x="6" y="6" width="${size - 12}" height="${size - 12}" fill="none" stroke="#000000" stroke-opacity="0.18" stroke-width="12"/>`,
    `<rect x="14" y="14" width="${size - 28}" height="${size - 28}" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="3"/>`,
    '</svg>',
  ].join('');
}

/** The swatch as a PNG, ready for `uploadImage`. */
export async function renderTileSwatch(spec: SwatchSpec): Promise<Buffer> {
  return sharp(Buffer.from(tileSwatchSvg(spec), 'utf8'))
    .png()
    .toBuffer();
}

// --- Patterns --------------------------------------------------------------

interface Palette {
  light: string;
  dark: string;
  vein: string;
}

function patternBody(
  pattern: SwatchPattern,
  size: number,
  random: () => number,
  palette: Palette,
): string {
  switch (pattern) {
    case 'marble':
      return marbleVeins(size, random, palette);
    case 'wood':
      return woodGrain(size, random, palette);
    case 'stone':
      return stoneSpeckle(size, random, palette);
    case 'plain':
    default:
      return '';
  }
}

/** A few meandering veins, each a smooth cubic path with a fainter echo. */
function marbleVeins(size: number, random: () => number, palette: Palette): string {
  const veins: string[] = [];
  const count = 3 + Math.floor(random() * 3);

  for (let i = 0; i < count; i += 1) {
    const startX = random() * size;
    const startY = i % 2 === 0 ? 0 : random() * size;
    let d = `M ${startX.toFixed(1)} ${startY.toFixed(1)}`;
    let x = startX;
    let y = startY;
    const steps = 4 + Math.floor(random() * 3);
    for (let s = 0; s < steps; s += 1) {
      const nx = x + (random() - 0.5) * size * 0.6;
      const ny = y + size / steps + (random() - 0.5) * size * 0.2;
      const c1x = x + (random() - 0.5) * size * 0.4;
      const c1y = y + (ny - y) * 0.3;
      const c2x = nx + (random() - 0.5) * size * 0.4;
      const c2y = y + (ny - y) * 0.7;
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${nx.toFixed(1)} ${ny.toFixed(1)}`;
      x = nx;
      y = ny;
    }
    const width = (1.5 + random() * 3).toFixed(1);
    veins.push(
      `<path d="${d}" fill="none" stroke="${palette.vein}" stroke-opacity="0.55" stroke-width="${width}" stroke-linecap="round"/>`,
      `<path d="${d}" fill="none" stroke="${palette.vein}" stroke-opacity="0.16" stroke-width="${(Number(width) * 4).toFixed(1)}" stroke-linecap="round"/>`,
    );
  }
  return veins.join('');
}

/** Horizontal planks with a grain of slightly wavy lines. */
function woodGrain(size: number, random: () => number, palette: Palette): string {
  const parts: string[] = [];
  const plankHeight = size / 4;

  for (let p = 0; p < 4; p += 1) {
    const top = p * plankHeight;
    parts.push(
      `<rect x="0" y="${top.toFixed(1)}" width="${size}" height="${plankHeight.toFixed(1)}" fill="${p % 2 === 0 ? palette.light : palette.dark}" fill-opacity="0.25"/>`,
      `<line x1="0" y1="${top.toFixed(1)}" x2="${size}" y2="${top.toFixed(1)}" stroke="#000000" stroke-opacity="0.35" stroke-width="3"/>`,
    );
    const lines = 6 + Math.floor(random() * 5);
    for (let l = 0; l < lines; l += 1) {
      const y = top + 8 + random() * (plankHeight - 16);
      const wobble = (random() - 0.5) * 18;
      parts.push(
        `<path d="M 0 ${y.toFixed(1)} Q ${(size / 2).toFixed(1)} ${(y + wobble).toFixed(1)} ${size} ${y.toFixed(1)}" fill="none" stroke="${palette.vein}" stroke-opacity="${(0.12 + random() * 0.2).toFixed(2)}" stroke-width="${(1 + random() * 2).toFixed(1)}"/>`,
      );
    }
  }
  return parts.join('');
}

/** Speckles of two tones, the way a sugar or rustic finish reads from a metre away. */
function stoneSpeckle(size: number, random: () => number, palette: Palette): string {
  const dots: string[] = [];
  const count = 260 + Math.floor(random() * 140);
  for (let i = 0; i < count; i += 1) {
    const cx = (random() * size).toFixed(1);
    const cy = (random() * size).toFixed(1);
    const r = (1 + random() * 5).toFixed(1);
    const fill = random() < 0.5 ? palette.vein : palette.light;
    dots.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${(0.15 + random() * 0.3).toFixed(2)}"/>`,
    );
  }
  return dots.join('');
}

// --- Colour arithmetic -----------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  if (!Number.isFinite(value)) return { r: 128, g: 128, b: 128 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function toHex(rgb: Rgb): string {
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/** `amount` of `towards` blended into `from`; a negative amount moves away from it. */
function mix(from: Rgb, towards: Rgb, amount: number): Rgb {
  return {
    r: from.r + (towards.r - from.r) * amount,
    g: from.g + (towards.g - from.g) * amount,
    b: from.b + (towards.b - from.b) * amount,
  };
}

function isDark(rgb: Rgb): boolean {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b < 110;
}
