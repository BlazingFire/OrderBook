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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseManifest } from '@orderbook/shared';

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

async function publish(
  panel: 'master' | 'office',
  version: string,
  options: { corrupt?: boolean; missingFile?: boolean; wrongSize?: boolean } = {},
): Promise<ReleaseManifest> {
  const dir = path.join(root, panel === 'master' ? 'master-panel' : 'office-panel');
  await mkdir(dir, { recursive: true });

  const body = `setup-bytes-for-${version}`;
  const file = `OrderBook-${panel}-${version}-Setup.exe`;

  const manifest: ReleaseManifest = {
    panel,
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

describe('the releases folder', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'orderbook-releases-'));
  });

  afterEach(async () => {
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
    await publish('master', '1.1.0');
    const service = await loadService();

    expect((await service.availability('master', '1.0.0')).available?.version).toBe('1.1.0');
    expect((await service.availability('master', '1.1.0')).reason).toBe('upToDate');
    // The one a string comparison gets wrong.
    expect((await service.availability('master', '1.2.0')).reason).toBe('upToDate');
  });

  it('UPD-4: ignores a manifest whose setup file is not beside it', async () => {
    await publish('master', '1.1.0', { missingFile: true });
    const service = await loadService();

    // Worse than no manifest: it would render an Install button that cannot work.
    expect((await service.availability('master', '1.0.0')).available).toBeNull();
  });

  it('UPD-5: ignores a manifest whose size disagrees with the file on disk', async () => {
    await publish('master', '1.1.0', { wrongSize: true });
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
    const manifest = await publish('master', '1.1.0', { corrupt: true });
    const service = await loadService();

    await expect(service.verifyRelease('master', manifest)).rejects.toThrow(/checksum/i);
    await expect(service.prepareMasterUpdate()).rejects.toThrow(/checksum/i);
  });

  it('UPD-8: hands back a path only once the checksum has passed', async () => {
    await publish('master', '9.9.9');
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

  it('UPD-10: keeps the two panels’ folders separate', async () => {
    await publish('office', '2.0.0');
    const service = await loadService();

    expect((await service.availability('office', '1.0.0')).available?.version).toBe('2.0.0');
    // Publishing an office build must not offer itself to the Master.
    expect((await service.availability('master', '1.0.0')).reason).toBe('noFolder');
  });
});
