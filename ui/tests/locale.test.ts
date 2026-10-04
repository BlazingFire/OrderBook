/**
 * The interface is English only. A browser profile that saved another language under
 * `ob.locale` in an older build (Hindi was offered once) must open in English, with
 * no error, and the stored value is left alone: ignored, never read, never migrated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { t, translator } from '../src/i18n.js';

const KEY = 'ob.locale';

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('a language saved by an older build', () => {
  it.each(['hi', 'fr', '', 'null', '{"locale":"hi"}'])('falls back to English for a stored %j, without crashing', (stored) => {
    window.localStorage.setItem(KEY, stored);

    expect(() => t('action.cancel')).not.toThrow();
    expect(t('action.cancel')).toBe('Cancel');
    expect(translator().t('action.cancel')).toBe('Cancel');
    expect(t('modal.close')).toBe('Close');
  });

  it('leaves the stored value as it was: ignored, not rewritten or removed', () => {
    window.localStorage.setItem(KEY, 'hi');
    t('action.cancel');
    expect(window.localStorage.getItem(KEY)).toBe('hi');
  });

  it('reads English when storage itself refuses to answer', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('storage disabled');
    };
    try {
      expect(t('action.cancel')).toBe('Cancel');
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
