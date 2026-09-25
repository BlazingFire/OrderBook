/**
 * The files published beside a setup file survive the Master's releases folder.
 *
 * `tools/release.mjs` publishes two kinds of file that no manifest names: the
 * Windows `-Standalone.exe` and the Linux `-Setup.deb`, each with a `.sha256`.
 * Both reach a Master's releases folder only by an operator copying a release
 * folder in, and nothing on the Master ever writes one — so the sweep that
 * clears superseded builds after a GitHub sync must never take one, and the
 * reader must go on answering with the file the manifest names.
 *
 * `github-releases.test.ts` covers the sweep's own rules. This pins the two
 * names the release script publishes against it, so that widening the sweep's
 * pattern (to take old AppImages, say) cannot quietly start deleting a `.deb`
 * somebody put there to install by hand.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Shared from '@orderbook/shared';
import type { ReleaseManifest, ReleasePlatform } from '@orderbook/shared';
import { canonicalManifestPayload } from '@orderbook/shared';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = [
  {
    keyId: 'test-key',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    addedAt: '2026-09-24',
  },
];

const REPO = 'orderbook/releases';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const MANIFEST_URL = 'https://github.com/orderbook/releases/releases/download/v2.0.0/manifest.json';
const SETUP_URL = 'https://github.com/orderbook/releases/releases/download/v2.0.0/setup';

const PAYLOAD = Buffer.from('a fake setup file');

let dir: string;

function signed(platform: ReleasePlatform, file: string): ReleaseManifest {
  const manifest = {
    panel: 'master',
    platform,
    version: '2.0.0',
    file,
    sizeBytes: PAYLOAD.length,
    sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
    releasedAt: '2026-09-24T00:00:00.000Z',
  } as ReleaseManifest;

  return {
    ...manifest,
    keyId: 'test-key',
    signature: sign(
      null,
      Buffer.from(canonicalManifestPayload(manifest), 'utf8'),
      privateKey,
    ).toString('base64'),
  } as ReleaseManifest;
}

/** GitHub answering for one release holding `manifest` and its setup file. */
function serve(manifest: ReleaseManifest, manifestAsset: string): void {
  const routes: Record<string, () => Response> = {
    [API]: () =>
      Response.json({
        tag_name: 'v2.0.0',
        draft: false,
        prerelease: false,
        assets: [
          { name: manifestAsset, size: 500, browser_download_url: MANIFEST_URL, url: MANIFEST_URL },
          {
            name: manifest.file,
            size: manifest.sizeBytes,
            browser_download_url: SETUP_URL,
            url: SETUP_URL,
          },
        ],
      }),
    [MANIFEST_URL]: () => Response.json(manifest),
    [SETUP_URL]: () => new Response(new Uint8Array(PAYLOAD), { status: 200 }),
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const route = routes[String(input)];
      return Promise.resolve(route ? route() : new Response(null, { status: 404 }));
    }),
  );
}

/** The service with a repository configured and the test key trusted. */
async function loadService() {
  vi.resetModules();
  process.env.ORDERBOOK_RELEASES_GITHUB_REPO = REPO;
  vi.doMock('@orderbook/shared', async () => {
    const actual = await vi.importActual<typeof Shared>('@orderbook/shared');
    return {
      ...actual,
      TRUSTED_RELEASE_KEYS: KEYS,
      trustedKeyById: (id: string) => KEYS.find((key) => key.keyId === id),
    };
  });
  return import('../src/services/github-releases.js');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-besides-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock('@orderbook/shared');
  delete process.env.ORDERBOOK_RELEASES_GITHUB_REPO;
  await rm(dir, { recursive: true, force: true });
});

describe('what release.mjs publishes beside a setup file', () => {
  it('keeps every .deb when a GitHub sync lands a newer AppImage', async () => {
    const besides = [
      'OrderBook-Master-2.0.0-Setup.deb',
      'OrderBook-Master-2.0.0-Setup.deb.sha256',
      'OrderBook-Master-1.9.9-Setup.deb',
      'OrderBook-Master-1.9.9-Setup.deb.sha256',
    ];
    for (const file of besides) await writeFile(path.join(dir, file), 'copied in by hand');

    const manifest = signed('linux', 'OrderBook-Master-2.0.0-Setup.AppImage');
    serve(manifest, 'latest-master-linux.json');

    const { syncFromGitHub } = await loadService();
    const landed = await syncFromGitHub('master', dir, null, 'linux');

    // The manifest names the AppImage alone; the .deb is nobody's update. A
    // sync writes the manifest under the platform's own name, the one
    // `readManifest` reads first.
    expect(landed?.file).toBe(manifest.file);
    expect((await readdir(dir)).sort()).toEqual(
      [...besides, manifest.file, 'latest-linux.json'].sort(),
    );
  });

  it('keeps every standalone .exe when a GitHub sync lands a newer setup file', async () => {
    const besides = [
      'OrderBook-Master-2.0.0-Standalone.exe',
      'OrderBook-Master-2.0.0-Standalone.exe.sha256',
      'OrderBook-Master-1.9.9-Standalone.exe',
      'OrderBook-Master-1.9.9-Standalone.exe.sha256',
    ];
    for (const file of besides) await writeFile(path.join(dir, file), 'copied in by hand');

    const manifest = signed('win32', 'OrderBook-Master-2.0.0-Setup.exe');
    serve(manifest, 'latest-master.json');

    const { syncFromGitHub } = await loadService();
    const landed = await syncFromGitHub('master', dir, null, 'win32');

    // Windows keeps the bare `latest.json` beside its platform name, for
    // readers older than the platform-named manifests.
    expect(landed?.file).toBe(manifest.file);
    expect((await readdir(dir)).sort()).toEqual(
      [...besides, manifest.file, 'latest-win32.json', 'latest.json'].sort(),
    );
  });
});
