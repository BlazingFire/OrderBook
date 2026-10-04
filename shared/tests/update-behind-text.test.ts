/**
 * The Office "Update needed" screen blocks the app until this PC is updated, so the
 * paragraph under it must say that, and that saved work is safe. It used to say
 * "Nothing is wrong — it keeps working and syncing exactly as it does now", which
 * contradicted the block. Pinned in English and in Hindi.
 */

import { describe, expect, it } from 'vitest';

import { EN_MESSAGES, HI_MESSAGES } from '../src/index.js';

const KEY = 'updates.panel.behindBody';

describe('updates.panel.behindBody', () => {
  const en: string = EN_MESSAGES[KEY];
  const hi: string = HI_MESSAGES[KEY];

  it('tells the person this PC must install the update, and that saved work is safe and will sync', () => {
    expect(en).toContain('{version}');
    expect(en).toMatch(/must install the update to continue/);
    expect(en).toMatch(/saved on this PC is safe/);
    expect(en).toMatch(/sync to the Master once it has been updated/);
  });

  it('no longer says nothing is wrong or that it keeps working as now', () => {
    for (const text of [en, hi]) {
      expect(text).not.toMatch(/Nothing is wrong/i);
      expect(text).not.toMatch(/exactly as it does now/i);
    }
  });

  it('is real Hindi, with the same placeholder and the same three statements', () => {
    expect(hi).toContain('{version}');
    expect(hi).toMatch(/[ऀ-ॿ]{5}/);
    expect(hi.replace('{version}', '')).not.toMatch(/[A-Za-z]{4}/);
    expect(hi).toContain('अपडेट इंस्टॉल करना होगा');
    expect(hi).toContain('सुरक्षित');
    expect(hi).toContain('सिंक');
  });
});
