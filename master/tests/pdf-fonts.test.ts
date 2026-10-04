/**
 * The vendored PDF fonts. Pure — it reads the font files and drives fontkit
 * directly, so it needs no cluster and cannot silently skip.
 *
 * A face that loads is not a face that works: the checks below are the ones a
 * bad font swap fails (a missing file, a space glyph PDFKit cannot subset, a
 * mono face without the rupee sign).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';

const VENDORED = [
  'Inter-Regular.ttf',
  'Inter-SemiBold.ttf',
  'SourceCodePro-Regular.ttf',
];

function open(file: string): fontkit.Font {
  const buffer = readFileSync(path.join(config.pdf.fontsDir, file));
  return fontkit.create(buffer) as fontkit.Font;
}

describe('vendored PDF fonts', () => {
  it('PDF-1: every face the renderer registers is actually present on disk', () => {
    for (const file of VENDORED) {
      expect(existsSync(path.join(config.pdf.fontsDir, file))).toBe(true);
    }
  });

  it('PDF-2: the Latin faces shape plain English text to one glyph per letter', () => {
    for (const file of ['Inter-Regular.ttf', 'Inter-SemiBold.ttf']) {
      const glyphs = open(file).layout('Sharma Tiles').glyphs;
      expect(glyphs.length, file).toBeGreaterThanOrEqual('Sharma Tiles'.length - 2);
      expect(glyphs.every((glyph) => glyph.id > 0), `${file} has a missing glyph`).toBe(true);
    }
  });

  it('PDF-3: no Devanagari face is vendored any more', () => {
    expect(existsSync(path.join(config.pdf.fontsDir, 'NotoSansDevanagari-Regular.ttf'))).toBe(false);
  });

  it('PDF-4: every face can shape a space — the glyph PDFKit subsets on every page', () => {
    // This is not a hypothetical. The IBM Plex Mono build this project first
    // vendored had a space glyph whose `loca` entry pointed past the end of
    // the `glyf` table; fontkit threw from `_getCBox` the moment PDFKit
    // subset any string containing a space, which is every page. The
    // face was replaced with Source Code Pro and this gate added so a future
    // font swap cannot reintroduce it silently.
    for (const file of VENDORED) {
      const font = open(file);
      const glyph = font.glyphsForString(' ')[0];
      expect(glyph, `${file} has no glyph for a space`).toBeDefined();
      expect(() => glyph!.cbox, `${file} cannot measure its space glyph`).not.toThrow();
    }
  });

  it('PDF-5: the mono face covers the rupee sign', () => {
    const font = open('SourceCodePro-Regular.ttf');
    expect(font.hasGlyphForCodePoint('₹'.codePointAt(0)!)).toBe(true);
  });
});
