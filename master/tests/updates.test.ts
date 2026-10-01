/**
 * The releases folder, and what the Master will and will not offer from it.
 *
 * Pure — a real temp directory, no cluster — so this suite cannot silently
 * skip. That matters more here than usual: the whole point of these assertions
 * is that a **damaged or mismatched setup file is never handed to something
 * that would run it**, and a gate that skips is indistinguishable from a gate
 * that passes.
 *
 * `config.releasesDir` is read at import time, so each test points
 * `ORDERBOOK_RELEASES_DIR` at a temp folder and re-imports the module rather
 * than mutating a frozen config.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseManifest, ReleasePlatform } from '@orderbook/shared';

import type * as UpdateService from '../src/services/update.service.js';

let root: string;

/**
 * Fresh module graph per test, so `config` re-reads the env var.
 *
 * These manifests are unsigned, and that is the case under test: this suite is
 * the air-gapped site that copies a build in on a USB stick, which is the one
 * situation where a folder full of unsigned releases is legitimate. Signing is
 * covered by `release-signature.test.ts`, and the default — refuse anything
 * unsigned — is asserted there rather than opted out of here by accident.
 */
async function loadService(): Promise<typeof UpdateService> {
  vi.resetModules();
  process.env.ORDERBOOK_RELEASES_DIR = root;
  process.env.ORDERBOOK_ALLOW_UNSIGNED_RELEASES = '1';
  return import('../src/services/update.service.js');
}

/**
 * The platform the assertions below run under.
 *
 * `availability()` and `prepareMasterUpdate()` default to `process.platform`
 * and refuse a manifest for any other OS, so a fixture pinned to `win32` made
 * four of these tests pass only on Windows — they went red on a Linux or macOS
 * checkout with `it is a win32 release, and this panel is linux`, which reads
 * like a product bug and is not one. The tests that are *about* platform pass
 * theirs explicitly; the rest publish for whatever host they are running on.
 */
const HOST_PLATFORM = process.platform as ReleasePlatform;

async function publish(
  panel: 'master' | 'office',
  version: string,
  options: {
    corrupt?: boolean;
    missingFile?: boolean;
    wrongSize?: boolean;
    platform?: ReleasePlatform;
  } = {},
): Promise<ReleaseManifest> {
  const dir = path.join(root, panel === 'master' ? 'master-panel' : 'office-panel');
  await mkdir(dir, { recursive: true });

  const body = `setup-bytes-for-${version}`;
  const file = `OrderBook-${panel}-${version}-Setup.exe`;

  const manifest: ReleaseManifest = {
    panel,
    // These fixtures write `latest.json`, the legacy name, and every legacy
    // manifest describes a Windows build — which is what the reader defaults
    // an absent field to. Stated here so the fixture and the reader agree; a
    // test that needs the manifest to match the running host passes its own.
    platform: options.platform ?? 'win32',
    version,
    file,
    sizeBytes: options.wrongSize ? body.length + 99 : body.length,
    sha256: options.corrupt
      ? createHash('sha256').update('something else entirely').digest('hex')
      : createHash('sha256').update(body).digest('hex'),
    releasedAt: '2026-08-27T00:00:00.000Z',
    notes: 'Test build',
  };

  await writeFile(path.join(dir, 'latest.json'), JSON.stringify(manifest));
  if (!options.missingFile) await writeFile(path.join(dir, file), body);

  return manifest;
}

/**
 * Publish under `latest-<platform>.json`, the name a panel built from the
 * platform-aware change onwards looks for first. A `win7` build carries the
 * `Win7` tag `tools/release.mjs` names it with.
 */
async function publishFor(
  panel: 'master' | 'office',
  platform: 'win32' | 'darwin' | 'win7',
  version: string,
): Promise<ReleaseManifest> {
  const dir = path.join(root, panel === 'master' ? 'master-panel' : 'office-panel');
  await mkdir(dir, { recursive: true });

  const body = `setup-bytes-for-${platform}-${version}`;
  const tag = platform === 'win7' ? 'Win7-' : '';
  const file = `OrderBook-${panel}-${tag}${version}-Setup.${platform === 'darwin' ? 'dmg' : 'exe'}`;

  const manifest: ReleaseManifest = {
    panel,
    platform,
    version,
    file,
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    releasedAt: '2026-09-10T00:00:00.000Z',
  };

  await writeFile(path.join(dir, `latest-${platform}.json`), JSON.stringify(manifest));
  await writeFile(path.join(dir, file), body);

  return manifest;
}

describe('the releases folder', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'orderbook-releases-'));
  });

  afterEach(async () => {
    vi.doUnmock('../src/http/middleware/require-panel.js');
    delete process.env.ORDERBOOK_RELEASES_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('UPD-1: says "no folder" when nothing has been published to this PC', async () => {
    const service = await loadService();

    const result = await service.availability('master', '1.0.0');
    expect(result.available).toBeNull();
    // Distinct from `noRelease` on purpose: "nobody set this machine up to
    // receive builds" and "nobody has published one yet" are different jobs.
    expect(result.reason).toBe('noFolder');
  });

  it('UPD-2: says "no release" when the folder is there but empty', async () => {
    await mkdir(path.join(root, 'master-panel'), { recursive: true });
    const service = await loadService();

    expect((await service.availability('master', '1.0.0')).reason).toBe('noRelease');
  });

  it('UPD-3: offers a newer build, and only a newer one', async () => {
    await publish('master', '1.1.0', { platform: HOST_PLATFORM });
    const service = await loadService();

    expect((await service.availability('master', '1.0.0')).available?.version).toBe('1.1.0');
    expect((await service.availability('master', '1.1.0')).reason).toBe('upToDate');
    // The one a string comparison gets wrong.
    expect((await service.availability('master', '1.2.0')).reason).toBe('upToDate');
  });

  it('UPD-4: ignores a manifest whose setup file is not beside it', async () => {
    // Host platform, or the manifest is discarded for being the wrong OS and
    // the assertion below passes without ever reaching the missing-file check.
    await publish('master', '1.1.0', { missingFile: true, platform: HOST_PLATFORM });
    const service = await loadService();

    // Worse than no manifest: it would render an Install button that cannot work.
    expect((await service.availability('master', '1.0.0')).available).toBeNull();
  });

  it('UPD-5: ignores a manifest whose size disagrees with the file on disk', async () => {
    await publish('master', '1.1.0', { wrongSize: true, platform: HOST_PLATFORM });
    const service = await loadService();

    expect((await service.availability('master', '1.0.0')).available).toBeNull();
  });

  it('UPD-6: ignores a file that is not a manifest at all', async () => {
    const dir = path.join(root, 'master-panel');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'latest.json'), 'not json at all');
    const service = await loadService();

    // Fails soft: a broken folder must not be able to take the screen down.
    expect((await service.availability('master', '1.0.0')).reason).toBe('noRelease');
  });

  it('UPD-7: refuses a setup file whose checksum does not match — the gate that matters', async () => {
    const manifest = await publish('master', '9.9.9', {
      corrupt: true,
      platform: HOST_PLATFORM,
    });
    const service = await loadService();

    await expect(service.verifyRelease('master', manifest)).rejects.toThrow(/checksum/i);
    await expect(service.prepareMasterUpdate()).rejects.toThrow(/checksum/i);
  });

  it('UPD-8: hands back a path only once the checksum has passed', async () => {
    await publish('master', '9.9.9', { platform: HOST_PLATFORM });
    const service = await loadService();

    const { path: file, manifest } = await service.prepareMasterUpdate();
    expect(manifest.version).toBe('9.9.9');
    expect(file.endsWith('OrderBook-master-9.9.9-Setup.exe')).toBe(true);
  });

  it('UPD-9: resolves the setup file inside the releases folder, whatever the manifest says', async () => {
    const service = await loadService();

    const escaping = {
      panel: 'office',
      version: '1.0.0',
      file: '..\\..\\Windows\\System32\\calc.exe',
      sizeBytes: 1,
      sha256: 'x',
      releasedAt: '2026-08-27T00:00:00.000Z',
    } as ReleaseManifest;

    // The releases folder is operator territory, not attacker territory — but
    // this value ends up in a download route and eventually a process launch,
    // and neither is a place to trust a string for where it came from.
    const resolved = service.releaseFileFor('office', escaping);
    expect(resolved.startsWith(service.releaseDirFor('office'))).toBe(true);
    expect(resolved.endsWith('calc.exe')).toBe(true);
  });

  it('UPD-43: one folder serves a Windows shop and a Mac one at once', async () => {
    await publishFor('office', 'win32', '2.0.0');
    await publishFor('office', 'darwin', '2.0.0');
    const service = await loadService();

    // Each asker gets its own OS's build, out of the same folder. Before
    // manifests carried a platform this was impossible: the second publish
    // overwrote the first and half the shop was offered an installer it
    // could not open.
    const windows = await service.availability('office', '1.0.0', 'win32');
    const mac = await service.availability('office', '1.0.0', 'darwin');

    expect(windows.available?.file).toMatch(/\.exe$/);
    expect(mac.available?.file).toMatch(/\.dmg$/);
  });

  it('UPD-43: refuses a build for another OS rather than offering it', async () => {
    await publishFor('office', 'win32', '2.0.0');
    const service = await loadService();

    // A Mac asking a folder that holds only a Windows build is told nothing is
    // available — not handed 160 MB of .exe it would download and then refuse.
    expect((await service.availability('office', '1.0.0', 'darwin')).available).toBeNull();
  });

  it('UPD-43: reads a pre-platform latest.json as the Windows build it is', async () => {
    // Every folder published before manifests carried a platform holds one
    // `latest.json` naming a `-Setup.exe`. A Windows panel updated across this
    // change must keep finding it, or the shop is told nothing was published
    // with a good build sitting right there.
    await publish('office', '2.0.0');
    const service = await loadService();

    const result = await service.availability('office', '1.0.0', 'win32');
    expect(result.available?.version).toBe('2.0.0');
    expect(result.available?.platform).toBe('win32');
  });

  it('UPD-43: prefers the platform-named manifest over the legacy one', async () => {
    await publish('office', '1.5.0');
    await publishFor('office', 'win32', '2.0.0');
    const service = await loadService();

    // Both names are on disk during the window where the release script writes
    // the shim. The specific one wins, so a newer build is not shadowed by an
    // older compatibility copy.
    expect((await service.availability('office', '1.0.0', 'win32')).available?.version).toBe(
      '2.0.0',
    );
  });

  it('UPD-10: keeps the two panels’ folders separate', async () => {
    await publish('office', '2.0.0', { platform: HOST_PLATFORM });
    const service = await loadService();

    expect((await service.availability('office', '1.0.0')).available?.version).toBe('2.0.0');
    // Publishing an office build must not offer itself to the Master.
    expect((await service.availability('master', '1.0.0')).reason).toBe('noFolder');
  });

  /**
   * The routes an Office panel asks, with the pairing check waved through:
   * what is under test is which manifest a `?platform=` reads, not pairing,
   * which `http-api.integration.test.ts` covers against a real database.
   */
  async function panelRoutes(): Promise<express.Express> {
    await loadService();
    vi.doMock('../src/http/middleware/require-panel.js', () => ({
      requirePanel: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    const { publicUpdateRoutes } = await import('../src/http/routes/update.routes.js');

    const app = express();
    app.use('/api/updates', publicUpdateRoutes);
    return app;
  }

  it('UPD-68: a Win7 panel is answered from latest-win7.json, beside the Windows build', async () => {
    const windows = await publishFor('office', 'win32', '2.0.0');
    const win7 = await publishFor('office', 'win7', '2.0.0');
    const app = await panelRoutes();

    const asked = await request(app).get('/api/updates/office/latest?platform=win7').expect(200);
    expect(asked.body.available?.file).toBe(win7.file);
    expect(asked.body.available?.platform).toBe('win7');

    // The Windows panel next to it still gets its own build out of the same folder.
    const plain = await request(app).get('/api/updates/office/latest?platform=win32').expect(200);
    expect(plain.body.available?.file).toBe(windows.file);

    const download = await request(app)
      .get('/api/updates/office/download?platform=win7')
      .expect(200);
    expect(download.headers['content-disposition']).toContain(win7.file);
  });

  it('UPD-68: a Win7 panel is never handed the Windows build when no Win7 one is there', async () => {
    // Only the plain `latest.json` a Windows release writes. `readManifest`
    // falls back to it, then refuses it for saying `win32`: the Electron 33
    // build it names cannot start on Windows 7.
    await publish('office', '2.0.0');
    const app = await panelRoutes();

    // The same folder is a good Windows build, so the refusal is the platform's.
    const plain = await request(app).get('/api/updates/office/latest?platform=win32').expect(200);
    expect(plain.body.available?.version).toBe('2.0.0');

    const asked = await request(app).get('/api/updates/office/latest?platform=win7').expect(200);
    expect(asked.body.available).toBeNull();
    expect(asked.body.reason).toBe('noRelease');
  });
});
