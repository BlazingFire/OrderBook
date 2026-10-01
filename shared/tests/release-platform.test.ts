/**
 * Which release channel a running panel asks for.
 *
 * The Win7 Office build reports `win32` like any other Windows, so the only
 * thing that tells it apart is its Electron major. Getting this wrong hands a
 * Windows 7 PC the Electron 33 build, which cannot start there.
 */

import { describe, expect, it } from 'vitest';

import { LEGACY_ELECTRON_CEILING, releasePlatformFor } from '../src/index.js';

describe('releasePlatformFor', () => {
  it('puts Windows on Electron 22 on the win7 channel', () => {
    expect(releasePlatformFor('win32', '22.3.27')).toBe('win7');
  });

  it('keeps Windows on a current Electron on win32', () => {
    expect(releasePlatformFor('win32', '33.4.11')).toBe('win32');
    expect(releasePlatformFor('win32', `${LEGACY_ELECTRON_CEILING}.0.0`)).toBe('win32');
  });

  it('treats a plain-Node run, with no Electron at all, as its own platform', () => {
    expect(releasePlatformFor('win32', undefined)).toBe('win32');
    expect(releasePlatformFor('win32', '')).toBe('win32');
  });

  it('never puts another OS on the win7 channel', () => {
    expect(releasePlatformFor('linux', '22.3.27')).toBe('linux');
    expect(releasePlatformFor('darwin', '22.3.27')).toBe('darwin');
  });
});
