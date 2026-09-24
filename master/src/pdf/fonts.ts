/**
 * The four vendored SIL OFL faces, registered with PDFKit once per document.
 *
 * **Fails loudly at startup when a face is missing**, rather than at first
 * export. PDFKit's fallback for an unregistered font is Helvetica, one of the
 * 14 standard PDF fonts — which has no Devanagari glyphs at all, so a missing
 * `NotoSansDevanagari-Regular.ttf` would not error: it would silently render
 * every Hindi party name as a row of blank boxes on a report somebody has
 * already printed. A startup crash naming the missing file is strictly better
 * than a page nobody notices is wrong.
 *
 * Infrastructure, a peer of `realtime/` — it knows about PDFKit and the disk,
 * and holds no business rule.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type PDFDocument from 'pdfkit';

import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import type { ScriptTag } from './text.js';

/** The PDFKit font names the rest of the module refers to faces by. */
export type FaceName = 'body' | 'bodyBold' | 'devanagari' | 'mono';

/**
 * `mono` is **Source Code Pro, not IBM Plex Mono** as `02-FILE-STRUCTURE.md`
 * §3.7 names. Every IBM Plex Mono TTF build available to this project carries
 * a space glyph whose `loca` entry points past the end of the `glyf` table:
 * fontkit throws `RangeError: Offset is outside the bounds of the DataView`
 * from `_getCBox` the moment PDFKit subsets a string containing a space —
 * which is every page this renderer draws. The one IBM Plex source that
 * survives (the official `@ibm/plex-mono` WOFF2) is not subset by PDFKit at
 * all and adds ~260 KB to every rendered file, against ~4 KB here.
 *
 * Source Code Pro is SIL OFL 1.1 like the other three, covers everything this
 * renderer needs, and subsets correctly. Swapping it back is one
 * line plus the asset — worth doing if a future fontkit fixes the read.
 */
const FACE_FILES: Record<FaceName, string> = {
  body: 'Inter-Regular.ttf',
  bodyBold: 'Inter-SemiBold.ttf',
  devanagari: 'NotoSansDevanagari-Regular.ttf',
  mono: 'SourceCodePro-Regular.ttf',
};

function fontPath(face: FaceName): string {
  return path.join(config.pdf.fontsDir, FACE_FILES[face]);
}

/**
 * Called at boot. Throws on the first absent face rather than collecting them:
 * one missing font and four missing fonts have the same fix (the assets
 * directory did not ship), and the first name is enough to find it.
 */
export function assertFontsPresent(): void {
  for (const face of Object.keys(FACE_FILES) as FaceName[]) {
    const file = fontPath(face);
    if (!existsSync(file)) {
      throw new AppError(
        'error.pdf.fontMissing',
        { file: FACE_FILES[face] },
        500,
        'font_missing',
        { file: FACE_FILES[face], expectedAt: file },
      );
    }
  }
}

/**
 * Registers all four faces on one document.
 *
 * Per-document rather than a process-wide cache: PDFKit's font registry lives
 * on the `PDFDocument` instance, so there is nothing global to warm. The files
 * themselves are read by fontkit each time, which for four TTFs totalling
 * ~1 MB is not worth optimising against an export that also does layout.
 */
export function registerFonts(doc: typeof PDFDocument.prototype): void {
  for (const face of Object.keys(FACE_FILES) as FaceName[]) {
    doc.registerFont(face, fontPath(face));
  }
}

/**
 * Which registered face draws a given script run.
 *
 * `bold` only applies to the body face. Neither the Devanagari nor the mono
 * face is vendored in a second weight — a bold Devanagari heading would
 * otherwise silently fall back to Helvetica and vanish, which is the exact
 * failure `assertFontsPresent` exists to prevent, arriving by another door.
 */
export function faceFor(script: ScriptTag, bold = false): FaceName {
  if (script === 'devanagari') return 'devanagari';
  if (script === 'mono') return 'mono';
  return bold ? 'bodyBold' : 'body';
}
