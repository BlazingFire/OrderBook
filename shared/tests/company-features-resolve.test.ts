/**
 * Resolving the company's switches, once, at each panel's edge.
 *
 * `CompanyFeatures` is optional field by field because a shop mid-update runs a
 * Master and a panel on different versions. "Absent means as before" is only
 * true if every reader agrees on what "before" was — and before this helper
 * there were eleven hand-written `?? true` reads across the two panels, each
 * free to disagree with `settings.ts` the day a fallback changed.
 */

import { describe, expect, it } from 'vitest';

import { SETTINGS, resolveCompanyFeatures } from '../src/index.js';

describe('resolveCompanyFeatures', () => {
  it('answers every switch with its declared fallback when nothing arrived', () => {
    // Read from SETTINGS rather than written out, so this cannot become a
    // second copy of the defaults that agrees with itself.
    expect(resolveCompanyFeatures(undefined)).toEqual({
      freeToSell: SETTINGS['inventory.freeToSell'].fallback,
      offlineSignInEnabled: SETTINGS['security.offlineSignInEnabled'].fallback,
      adjustmentNoteRequired: SETTINGS['inventory.adjustmentNoteRequired'].fallback,
      followUpDefaultDays: SETTINGS['leads.followUpDefaultDays'].fallback,
      packagingRequiredOnConvert: SETTINGS['leads.packagingRequiredOnConvert'].fallback,
    });
  });

  it('treats null the same as absent', () => {
    expect(resolveCompanyFeatures(null)).toEqual(resolveCompanyFeatures(undefined));
  });

  it('fills only what is missing from a partial answer', () => {
    // An older Master sends `freeToSell` and nothing else. Every other switch
    // has to read as "as before", not as false.
    const resolved = resolveCompanyFeatures({ freeToSell: false });

    expect(resolved.freeToSell).toBe(false);
    expect(resolved.packagingRequiredOnConvert).toBe(true);
    expect(resolved.offlineSignInEnabled).toBe(true);
    expect(resolved.adjustmentNoteRequired).toBe(false);
    expect(resolved.followUpDefaultDays).toBe(0);
  });

  it('keeps a false that was actually sent, rather than coalescing it away', () => {
    // The trap: `??` is correct and `||` is not. Four of these are booleans
    // whose fallback is `true`, so `||` would silently re-enable every switch
    // a company had turned off.
    const resolved = resolveCompanyFeatures({
      freeToSell: false,
      offlineSignInEnabled: false,
      packagingRequiredOnConvert: false,
    });

    expect(resolved.offlineSignInEnabled).toBe(false);
    expect(resolved.packagingRequiredOnConvert).toBe(false);
  });

  it('keeps a followUpDefaultDays of 0, which is a real answer meaning today', () => {
    // The same trap on a number, and the one that would be hardest to notice:
    // 0 is both the fallback and a legal setting, so `||` reads correct here
    // until somebody changes the fallback.
    expect(resolveCompanyFeatures({ freeToSell: true, followUpDefaultDays: 0 }).followUpDefaultDays)
      .toBe(0);
    expect(resolveCompanyFeatures({ freeToSell: true, followUpDefaultDays: 7 }).followUpDefaultDays)
      .toBe(7);
  });
});
