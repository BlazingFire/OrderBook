// @vitest-environment node
/**
 * The note preview's lightest greys must be readable on screen (4.5:1 on the white page), while the printed
 * page and the PDF keep the design's colours exactly: the darker greys live in an `@media screen` block.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/order-note.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function luminance(hex: string): number {
  const channel = (index: number): number => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrastOnWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

const screenBlock = css.slice(css.indexOf('@media screen {'), css.indexOf('\n}\n', css.indexOf('@media screen {')) + 3);

describe('the note preview on screen', () => {
  it('uses greys of at least 4.5:1 for the eyebrows, captions and the strip note', () => {
    const muted = /--note-muted:\s*(#[0-9a-f]{6})/i.exec(screenBlock)?.[1];
    const strip = /\.ob-note-strip-note\s*\{\s*color:\s*(#[0-9a-f]{6})/i.exec(screenBlock)?.[1];
    expect(muted).toBeDefined();
    expect(strip).toBeDefined();
    expect(contrastOnWhite(muted as string)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOnWhite(strip as string)).toBeGreaterThanOrEqual(4.5);
  });

  it('measures the originals the way the audit did: 4.30:1 and 2.99:1', () => {
    expect(contrastOnWhite('#6e7c84')).toBeCloseTo(4.3, 1);
    expect(contrastOnWhite('#8c979d')).toBeCloseTo(2.99, 1);
  });
});

describe('the printed note', () => {
  it('keeps the design colours outside the screen block', () => {
    const outside = css.replace(screenBlock, '');
    expect(outside).toContain('--note-muted: #6e7c84;');
    expect(outside).toMatch(/\.ob-note-strip-note\s*\{[^}]*color:\s*#8c979d;/);
    expect(screenBlock.startsWith('@media screen')).toBe(true);
  });
});
