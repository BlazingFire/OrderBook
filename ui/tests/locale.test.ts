/**
 * Where a panel's language comes from.
 *
 * Two rules, and both were broken in a way nothing could see: `ob.locale` was
 * read on every render and written nowhere in the tree, and each panel's boot
 * endpoint had served `defaultLocale` since the config was written without a
 * single reader. A complete Hindi catalogue shipped that no installation could
 * reach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptDefaultLocale, locale, setLocale } from '../src/i18n.js';

const KEY = 'ob.locale';

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('locale', () => {
  it('is English until somebody chooses otherwise', () => {
    expect(locale()).toBe('en');
  });

  it('reads back what was stored', () => {
    setLocale('hi');
    expect(window.localStorage.getItem(KEY)).toBe('hi');
    expect(locale()).toBe('hi');
  });

  it('falls back to English on a stored value that is not a language we ship', () => {
    // A hand-edited profile, or a locale removed in a later version.
    window.localStorage.setItem(KEY, 'fr');
    expect(locale()).toBe('en');
  });
});

describe('adoptDefaultLocale', () => {
  it('takes the deployment default on a profile that has never chosen', () => {
    adoptDefaultLocale('hi');
    expect(locale()).toBe('hi');
  });

  it('never overrides a choice somebody made, however often a panel boots', () => {
    // This is what makes it a *default* rather than a setting imposed at every
    // start: changing ORDERBOOK_DEFAULT_LOCALE must not undo the picker.
    setLocale('en');
    adoptDefaultLocale('hi');
    adoptDefaultLocale('hi');

    expect(locale()).toBe('en');
  });

  it('ignores anything that is not a language we ship, rather than storing it', () => {
    // It is fed straight from an HTTP payload, so a typo in an environment
    // variable reaches it as a string the catalogue has never heard of.
    adoptDefaultLocale('fr');
    adoptDefaultLocale(undefined);
    adoptDefaultLocale(null);

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(locale()).toBe('en');
  });
});
