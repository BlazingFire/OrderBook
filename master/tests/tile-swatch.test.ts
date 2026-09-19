/**
 * The sample-data swatch: deterministic markup, a real PNG out of sharp, and
 * no text anywhere in it (a font the rasteriser cannot find would render as
 * boxes — see the module header).
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { renderTileSwatch, tileSwatchSvg } from '../src/lib/tile-swatch.js';

describe('tileSwatchSvg', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = tileSwatchSvg({ baseHex: '#F4F4F0', pattern: 'marble', seed: 7 });
    const b = tileSwatchSvg({ baseHex: '#F4F4F0', pattern: 'marble', seed: 7 });
    const c = tileSwatchSvg({ baseHex: '#F4F4F0', pattern: 'marble', seed: 8 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('draws every pattern without text and with the base colour', () => {
    for (const pattern of ['marble', 'wood', 'stone', 'plain'] as const) {
      const svg = tileSwatchSvg({ baseHex: '#7A5230', pattern, seed: 1, size: 200 });
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('fill="#7A5230"');
      expect(svg).not.toContain('<text');
      expect(svg).toContain('width="200"');
    }
  });

  it('lightens the veins on a dark tile and darkens them on a light one', () => {
    const dark = tileSwatchSvg({ baseHex: '#26282B', pattern: 'marble', seed: 3, size: 200 });
    const light = tileSwatchSvg({ baseHex: '#F6F1DC', pattern: 'marble', seed: 3, size: 200 });
    const veinOf = (svg: string) =>
      /stroke="(#[0-9a-f]{6})" stroke-opacity="0.55"/.exec(svg)?.[1] ?? '';
    expect(Number.parseInt(veinOf(dark).slice(1, 3), 16)).toBeGreaterThan(0x26);
    expect(Number.parseInt(veinOf(light).slice(1, 3), 16)).toBeLessThan(0xf6);
  });
});

describe('renderTileSwatch', () => {
  it('produces a square PNG of the requested size', async () => {
    const png = await renderTileSwatch({
      baseHex: '#8E9196',
      pattern: 'stone',
      seed: 2,
      size: 120,
    });
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(120);
  });
});
