/**
 * **The Devanagari gate** (`docs/backend-modules/11-BUILD-SEQUENCE.md` §2.2,
 * `10-TESTING.md` §6.7). Pure — it reads the vendored font files and drives
 * fontkit directly, so it needs no cluster and cannot silently skip.
 *
 * The claim being tested is narrower than "the font loaded". A renderer that
 * maps codepoints to glyphs in order — no Indic shaper at all — loads the font
 * perfectly happily and produces text that is wrong in a way an English
 * reviewer cannot see. The two assertions below are the ones such a renderer
 * fails:
 *
 *   1. **Conjunct formation** — `'हिन्दी'` must shape to FEWER glyphs than it
 *      has codepoints, because न + ् + द becomes one conjunct form.
 *   2. **Reordering** — in `'कि'` the i-matra is stored *after* its consonant
 *      but must be drawn *before* it.
 *
 * A note for anybody extending this suite: comparing a shaped glyph's **id**
 * against the same character shaped in isolation is not a valid test. The
 * i-matra is contextual — it takes a different glyph id depending on the
 * preceding consonant's width — so an isolated shaping yields a different
 * variant and the comparison reports a false failure. Compare glyph *names*,
 * whose `uniXXXX` prefix is stable across the variants.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';

import { config } from '../src/config/index.js';

const VENDORED = [
  'Inter-Regular.ttf',
  'Inter-SemiBold.ttf',
  'NotoSansDevanagari-Regular.ttf',
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

  it('PDF-2: Devanagari conjuncts form — "हिन्दी" shapes to fewer glyphs than codepoints', () => {
    const font = open('NotoSansDevanagari-Regular.ttf');
    const text = 'हिन्दी';

    const codepoints = Array.from(text).length;
    const glyphs = font.layout(text).glyphs.length;

    expect(codepoints).toBe(6);
    // A shaper-free renderer returns exactly 6 here. The conjunct न्द collapses
    // three codepoints into one glyph, so a real shaper returns 5.
    expect(glyphs).toBeLessThan(codepoints);
  });

  it('PDF-3: the i-matra reorders — "कि" draws the vowel sign before its consonant', () => {
    const font = open('NotoSansDevanagari-Regular.ttf');

    // Stored order is consonant (U+0915 क) then vowel sign (U+093F ि).
    const names = font.layout('कि').glyphs.map((glyph) => glyph.name ?? '');

    const matra = names.findIndex((name) => name.startsWith('uni093F'));
    const consonant = names.findIndex((name) => name.startsWith('uni0915'));

    expect(matra).toBeGreaterThanOrEqual(0);
    expect(consonant).toBeGreaterThanOrEqual(0);
    // Drawn order must be the reverse of stored order.
    expect(matra).toBeLessThan(consonant);
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

  it('PDF-5: the mono face covers the rupee sign, which the text splitter treats as script-neutral', () => {
    const font = open('SourceCodePro-Regular.ttf');
    expect(font.hasGlyphForCodePoint('₹'.codePointAt(0)!)).toBe(true);
  });
});
