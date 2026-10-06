// @vitest-environment node
/**
 * Two small things the printed note must get right: month names are three letters (Chromium's
 * `toLocaleString` writes "Sept"), and the bold IBM Plex Mono the design uses is bundled, so those
 * figures are not drawn from a lighter face.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { stamp } from '../src/OrderNote.js';

describe('the note date stamp', () => {
  it('writes every month as three letters, September as "Sep", with a 24-hour time', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    months.forEach((name, index) => {
      expect(stamp(new Date(2026, index, 5, 9, 41))).toBe(`05 ${name} 2026 · 09:41`);
    });
    expect(stamp(new Date(2026, 8, 19, 9, 41))).toBe('19 Sep 2026 · 09:41');
    expect(stamp(new Date(2026, 0, 31, 0, 5))).toBe('31 Jan 2026 · 00:05');
  });

  it('takes an ISO string, and shows a dash for nothing or for a date that is not one', () => {
    expect(stamp(new Date(2026, 8, 19, 17, 3).toISOString())).toBe('19 Sep 2026 · 17:03');
    expect(stamp(null)).toBe('—');
    expect(stamp(undefined)).toBe('—');
    expect(stamp('not a date')).toBe('—');
  });
});

describe('the bundled fonts', () => {
  const css = readFileSync(new URL('../src/fonts.css', import.meta.url), 'utf8');

  it.each([400, 500, 600, 700])('ship IBM Plex Mono %i as a local file, declared and present', (weight) => {
    const file = `IBMPlexMono-${weight}-latin.woff2`;
    expect(css).toContain(`./fonts/${file}`);
    expect(existsSync(new URL(`../src/fonts/${file}`, import.meta.url))).toBe(true);
    const face = css.split('@font-face').find((block) => block.includes(file)) ?? '';
    expect(face).toContain(`font-weight: ${weight};`);
  });

  it('never reaches for the network', () => {
    expect(css).not.toMatch(/https?:\/\//);
  });
});

describe('the note quantity unit', () => {
  it('is "box", as the owner chose from the design, not "pcs"', async () => {
    const { t } = await import('../src/i18n.js');
    expect(t('orderNote.unit')).toBe('box');
  });
});
