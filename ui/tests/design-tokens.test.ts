/**
 * The tokens and base CSS of the 2026-10-07 redesign (Tokens and Scroll
 * artboards). jsdom has no layout, so the CSS is pinned as text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const tokens = readFileSync(join(root, 'ui', 'src', 'tokens.css'), 'utf8');
const reset = readFileSync(join(root, 'ui', 'src', 'reset.css'), 'utf8');

describe('scrollbars (Scroll artboard)', () => {
  it('draw the thumb at rest in a neutral grey, darker on hover and drag', () => {
    expect(tokens).toMatch(/--scrollbar-thumb:\s*var\(--porcelain-30\)/);
    expect(tokens).toMatch(/--scrollbar-thumb-hover:\s*var\(--porcelain-50-fill\)/);
    expect(tokens).toMatch(/--scrollbar-thumb-active:\s*var\(--porcelain-70\)/);
    // At rest on every element, not only under :hover or :focus-within.
    expect(reset).toMatch(/\*::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--scrollbar-thumb\)/);
    expect(reset).not.toMatch(/\*:hover::-webkit-scrollbar-thumb/);
    expect(reset).toMatch(/\*::-webkit-scrollbar-thumb:active\s*\{[^}]*var\(--scrollbar-thumb-active\)/);
    expect(reset).toMatch(/\*::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*4px/);
  });
});

describe('design values kept for fills only (CH1, 2026-10-07)', () => {
  it('keeps the accessible text values and adds the artboard ones as -fill tokens', () => {
    // Text: #5d6b73 and #8a5200 hold 4.5:1; the artboard's #6e7c84 and #b26a00 do not.
    expect(tokens).toMatch(/--porcelain-50:\s*#5d6b73/);
    expect(tokens).toMatch(/--kiln-amber:\s*#8a5200/);
    expect(tokens).toMatch(/--porcelain-50-fill:\s*#6e7c84/);
    expect(tokens).toMatch(/--kiln-amber-fill:\s*#b26a00/);
    expect(tokens).toMatch(/--state-offline-fill:\s*var\(--kiln-amber-fill\)/);
  });
});

describe('one density, and no retired tokens', () => {
  it('has a single comfortable row and control set, with no density switch', () => {
    expect(tokens).not.toMatch(/data-density/);
    expect(tokens).toMatch(/--row-h:\s*2\.2857rem/); // 32 at 14
    expect(tokens).toMatch(/--ctl-h-md:\s*2\.1429rem/); // 30 at 14
  });

  it('sizes the status footer at 26 px (Navigation artboard)', () => {
    expect(tokens).toMatch(/--shell-footer-h:\s*1\.8571rem/);
  });

  it('has dropped the glossy tile set and the old scrollbar tints', () => {
    expect(tokens).not.toMatch(/--tile-|--r-xl|--glaze-30|--glaze-40|--scrollbar-track/);
  });

  it('keeps --glaze-50 #14509e first, which make-icons.mjs reads for the icon colour', () => {
    expect(/--glaze-50:\s*(#[0-9a-f]{6})/.exec(tokens)?.[1]).toBe('#14509e');
  });
});
