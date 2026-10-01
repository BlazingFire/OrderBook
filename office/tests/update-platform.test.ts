/**
 * Which release channel an Office Panel asks the Master for, and what it does
 * with a build for some other channel.
 *
 * The Windows 7 build runs on Electron 22 and must only ever install a Windows 7
 * build. A Master older than that build reads `?platform=win7` as Windows and
 * would offer the Windows 10 build, which cannot start on Windows 7, so the
 * panel refuses any manifest that is not for its own channel, before it even
 * checks the signature.
 *
 * The Master link, the pairing and the signature check are mocked; nothing here
 * needs a Master or a database.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseManifest } from '@orderbook/shared';

const { masterFetch, verifyManifest, folder } = vi.hoisted(() => ({
  masterFetch: vi.fn(),
  verifyManifest: vi.fn(() => ({ ok: true })),
  folder: { dataDir: '' },
}));

vi.mock('../src/lib/master-fetch.js', () => ({ masterFetch }));
vi.mock('../src/lib/release-signature.js', () => ({ verifyManifest }));
vi.mock('../src/lib/app-version.js', () => ({ appVersion: () => '1.0.0' }));
vi.mock('../src/services/credentials.store.js', () => ({
  loadCredentials: async () => ({ panelId: 'OP0000000001' }),
}));
// A throwaway data folder, so a download never lands in this repository.
vi.mock('../src/config/index.js', () => ({
  config: folder,
}));

const { availableUpdate, downloadUpdate } = await import('../src/services/update.service.js');

const HOST_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
const HOST_VERSIONS = Object.getOwnPropertyDescriptor(process, 'versions')!;

/** Pretend to be a panel on `platform`, running under `electron` (undefined = plain Node). */
function runAs(platform: string, electron: string | undefined): void {
  const versions: Record<string, string | undefined> = { ...process.versions, electron };
  if (electron === undefined) delete versions.electron;
  Object.defineProperty(process, 'platform', { ...HOST_PLATFORM, value: platform });
  Object.defineProperty(process, 'versions', { ...HOST_VERSIONS, value: versions });
}

function manifest(fields: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    panel: 'office',
    platform: 'win7',
    version: '2.0.0',
    file: 'OrderBook-Office-Win7-2.0.0-Setup.exe',
    sizeBytes: 0,
    sha256: '0'.repeat(64),
    releasedAt: new Date(0).toISOString(),
    ...fields,
  } as ReleaseManifest;
}

function offering(offer: ReleaseManifest): Response {
  return new Response(JSON.stringify({ current: '0.0.0', available: offer }));
}

beforeEach(async () => {
  folder.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orderbook-update-platform-'));
  masterFetch.mockReset();
  verifyManifest.mockClear();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', HOST_PLATFORM);
  Object.defineProperty(process, 'versions', HOST_VERSIONS);
  await fs.rm(folder.dataDir, { recursive: true, force: true });
});

describe('the Windows 7 build (win32 on Electron 22)', () => {
  beforeEach(() => runAs('win32', '22.3.27'));

  it('asks the Master for the win7 channel', async () => {
    masterFetch.mockResolvedValueOnce(offering(manifest()));

    await availableUpdate();

    expect(masterFetch).toHaveBeenCalledWith(
      '/api/updates/office/latest?platform=win7',
      expect.anything(),
    );
  });

  it('refuses a Windows 10 build without checking its signature', async () => {
    masterFetch.mockResolvedValueOnce(offering(manifest({ platform: 'win32' })));

    const result = await availableUpdate();

    expect(result).toEqual({ current: '1.0.0', available: null, reason: 'noRelease' });
    expect(verifyManifest).not.toHaveBeenCalled();
  });

  it('refuses a manifest with no platform, which is a Windows 10 one', async () => {
    const legacy = manifest();
    delete (legacy as Partial<ReleaseManifest>).platform;
    masterFetch.mockResolvedValueOnce(offering(legacy));

    expect((await availableUpdate()).available).toBeNull();
    expect(verifyManifest).not.toHaveBeenCalled();
  });

  it('accepts a newer win7 build once its signature checks out', async () => {
    masterFetch.mockResolvedValueOnce(offering(manifest()));

    const result = await availableUpdate();

    expect(verifyManifest).toHaveBeenCalledTimes(1);
    expect(result.available?.version).toBe('2.0.0');
  });

  it('downloads from the win7 channel and streams the file to disk', async () => {
    const bytes = Buffer.from('a Windows 7 installer, or near enough');
    const offer = manifest({
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    masterFetch.mockResolvedValueOnce(offering(offer)).mockResolvedValueOnce(new Response(bytes));

    const result = await downloadUpdate();

    expect(masterFetch).toHaveBeenLastCalledWith('/api/updates/office/download?platform=win7');
    expect(await fs.readFile(result.path)).toEqual(bytes);
  });
});

describe('every other build', () => {
  it('a Windows 10 build (Electron 33) asks for win32 and refuses a win7 build', async () => {
    runAs('win32', '33.4.11');
    masterFetch.mockResolvedValueOnce(offering(manifest({ platform: 'win7' })));

    const result = await availableUpdate();

    expect(masterFetch).toHaveBeenCalledWith(
      '/api/updates/office/latest?platform=win32',
      expect.anything(),
    );
    expect(result.available).toBeNull();
    expect(verifyManifest).not.toHaveBeenCalled();
  });

  it('a Windows 10 build still accepts a manifest with no platform', async () => {
    runAs('win32', '33.4.11');
    const legacy = manifest({ file: 'OrderBook-Office-2.0.0-Setup.exe' });
    delete (legacy as Partial<ReleaseManifest>).platform;
    masterFetch.mockResolvedValueOnce(offering(legacy));

    expect((await availableUpdate()).available?.version).toBe('2.0.0');
  });

  it('plain Node on this host asks for its own platform, as before', async () => {
    runAs(HOST_PLATFORM.value as string, undefined);
    masterFetch.mockResolvedValueOnce(
      offering(manifest({ platform: HOST_PLATFORM.value as ReleaseManifest['platform'] })),
    );

    const result = await availableUpdate();

    expect(masterFetch).toHaveBeenCalledWith(
      `/api/updates/office/latest?platform=${HOST_PLATFORM.value as string}`,
      expect.anything(),
    );
    expect(result.available?.version).toBe('2.0.0');
  });
});
