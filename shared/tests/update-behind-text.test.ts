/**
 * The Office "Update needed" screen blocks the app until this PC is updated, so the
 * paragraph under it must say that, and that saved work is safe. It used to say
 * "Nothing is wrong — it keeps working and syncing exactly as it does now", which
 * contradicted the block.
 */

import { describe, expect, it } from 'vitest';

import { EN_MESSAGES } from '../src/index.js';

const KEY = 'updates.panel.behindBody';

describe('updates.panel.behindBody', () => {
  const en: string = EN_MESSAGES[KEY];

  it('tells the person this PC must install the update, and that saved work is safe and will sync', () => {
    expect(en).toContain('{version}');
    expect(en).toMatch(/must install the update to continue/);
    expect(en).toMatch(/saved on this PC is safe/);
    expect(en).toMatch(/sync to the Master once it has been updated/);
  });

  it('no longer says nothing is wrong or that it keeps working as now', () => {
    expect(en).not.toMatch(/Nothing is wrong/i);
    expect(en).not.toMatch(/exactly as it does now/i);
  });
});
