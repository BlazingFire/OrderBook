/**
 * Refusing a setup file before it runs on a machine we have just emptied.
 *
 * Every case here is a refusal except two, which is the point: this is the
 * last step, the PC has nothing left on it, and the operator is about to be
 * handed a fresh install. A wrong file at that moment is not a nuisance.
 */

import { describe, expect, it } from 'vitest';

import type { ReleaseManifest } from '@orderbook/shared';

import { manifestNames, panelOf, verifySetupFile } from '../src/setup-file.js';

const FILE = 'OrderBook-Master-1.1.0-Setup.exe';

const manifest: ReleaseManifest = {
  panel: 'master',
  platform: 'win32',
  version: '1.1.0',
  file: FILE,
  sizeBytes: 168_402_944,
  sha256: 'a'.repeat(64),
  releasedAt: '2026-09-18T00:00:00.000Z',
};

function candidate(overrides: Partial<Parameters<typeof verifySetupFile>[0]> = {}) {
  return verifySetupFile({
    fileName: FILE,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    manifest,
    platform: 'win32',
    ...overrides,
  });
}

describe('a setup file with a manifest beside it', () => {
  it('is accepted when every published fact matches', () => {
    expect(candidate()).toEqual({ ok: true, manifest });
  });

  it('is refused when the bytes are not the bytes that were published', () => {
    // A truncated copy, or one file swapped for another on the USB stick it
    // travelled on.
    expect(candidate({ sha256: 'b'.repeat(64) })).toMatchObject({
      ok: false,
      reason: 'hash-mismatch',
    });
  });

  it('is refused when the size disagrees, before anything is hashed', () => {
    // Checked before the hash so 160 MB is only read once the cheap facts
    // agree — and `sha256: null` is how the caller says it has not read them.
    expect(candidate({ sizeBytes: 12, sha256: null })).toMatchObject({
      ok: false,
      reason: 'size-mismatch',
    });
  });

  it('is refused when the file was renamed away from what the manifest names', () => {
    expect(candidate({ fileName: 'OrderBook-Master-1.0.3-Setup.exe' })).toMatchObject({
      ok: false,
      reason: 'name-mismatch',
    });
  });

  it("is refused when it is another OS's build", () => {
    // Without this a Mac would be handed 160 MB of .exe it can never run —
    // the case `ReleaseManifest.platform` was added for.
    expect(candidate({ platform: 'darwin', fileName: 'OrderBook-Master-1.1.0-Setup.dmg' })).toMatchObject({
      ok: false,
      reason: 'wrong-platform',
    });
  });

  it('accepts a hash in either case, since hex has no canonical one', () => {
    expect(
      candidate({
        sha256: manifest.sha256.toUpperCase(),
        manifest: { ...manifest, sha256: manifest.sha256.toLowerCase() },
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('a setup file with no manifest', () => {
  it('is allowed, and says plainly that nothing vouches for it', () => {
    // An air-gapped site copies builds in by hand and the release script
    // publishes unsigned manifests for exactly that case. Refusing here would
    // break the tool where it is needed most; the caller makes somebody agree.
    expect(candidate({ manifest: null })).toEqual({ ok: true, manifest: null, unverified: true });
  });

  it('is still refused when it is not a setup file at all', () => {
    // The one check that does not need a manifest, and the one that catches
    // somebody picking the folder's README in the file dialog.
    expect(candidate({ manifest: null, fileName: 'notes.txt' })).toMatchObject({
      ok: false,
      reason: 'not-a-setup-file',
    });
  });
});

describe('what counts as a setup file', () => {
  it.each([
    ['win32', 'OrderBook-Master-1.1.0-Setup.exe', true],
    ['win32', 'OrderBook-Master-1.1.0-Setup.dmg', false],
    ['darwin', 'OrderBook-Master-1.1.0-Setup.dmg', true],
    ['linux', 'OrderBook-Master-1.1.0-Setup.AppImage', true],
    ['linux', 'OrderBook-Master-1.1.0-Setup.deb', true],
    ['linux', 'OrderBook-Master-1.1.0-Setup.exe', false],
  ] as const)('%s accepts %s: %s', (platform, fileName, accepted) => {
    const verdict = verifySetupFile({
      fileName,
      sizeBytes: 1,
      sha256: null,
      manifest: null,
      platform,
    });
    expect(verdict.ok).toBe(accepted);
  });
});

describe('finding the manifest', () => {
  it('prefers the platform-specific name', () => {
    expect(manifestNames('win32')[0]).toBe('latest-win32.json');
    expect(manifestNames('darwin')).toEqual(['latest-darwin.json']);
  });

  it('falls back to the bare latest.json on Windows only', () => {
    // The release script writes that shim for panels built before the platform
    // field existed, and writes it for win32 alone so a Mac build cannot break
    // a Windows panel in the field.
    expect(manifestNames('win32')).toContain('latest.json');
    expect(manifestNames('linux')).not.toContain('latest.json');
  });
});

describe('which panel a setup file installs', () => {
  it('reads it from the name the release script gives it', () => {
    expect(panelOf('OrderBook-Master-1.1.0-Setup.exe')).toBe('master');
    expect(panelOf('OrderBook-Office-1.1.0-Setup.exe')).toBe('office');
    expect(panelOf('something-else.exe')).toBeNull();
  });
});
