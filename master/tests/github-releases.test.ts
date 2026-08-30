/**
 * Fetching a release from GitHub, and the refusals that matter more.
 *
 * This is the one place in the product where a shop PC downloads an executable
 * from the internet, so the tests are written around what an attacker who can
 * answer for `api.github.com` — a hostile DNS server, a captive portal, a
 * compromised release repository — would try next. Every case below leaves the
 * releases folder either correct or empty; there is no state in between where
 * `latest.json` names a file that is not fully there.
 *
 * `fetch` is stubbed rather than a server being stood up: the interesting
 * behaviour is redirect handling and stream limits, and a real server makes
 * both harder to provoke, not easier.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Shared from '@orderbook/shared';
import type { PanelKind, ReleaseManifest } from '@orderbook/shared';
import { canonicalManifestPayload } from '@orderbook/shared';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = [
  {
    keyId: 'test-key',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    addedAt: '2026-08-31',
  },
];

const REPO = 'orderbook/releases';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const SETUP_URL = 'https://github.com/orderbook/releases/releases/download/v2.0.0/setup.exe';
const MANIFEST_URL = 'https://github.com/orderbook/releases/releases/download/v2.0.0/manifest.json';

/** The bytes a release pretends to ship. Small — nothing here is about size. */
const PAYLOAD = Buffer.from('a fake windows installer');

let dir: string;
let requested: string[];

function signed(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const manifest = {
    panel: 'master' as PanelKind,
    version: '2.0.0',
    file: 'OrderBook-Master-2.0.0-Setup.exe',
    sizeBytes: PAYLOAD.length,
    sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
    releasedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  } as ReleaseManifest;

  return {
    ...manifest,
    keyId: 'test-key',
    signature: sign(null, Buffer.from(canonicalManifestPayload(manifest), 'utf8'), privateKey)
      .toString('base64'),
  } as ReleaseManifest;
}

/** A release listing GitHub would answer with, describing `manifest`. */
function listing(manifest: ReleaseManifest, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${manifest.version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: manifest.panel === 'master' ? 'latest-master.json' : 'latest-office.json',
        size: 500,
        browser_download_url: MANIFEST_URL,
        url: MANIFEST_URL,
      },
      {
        name: path.basename(manifest.file),
        size: manifest.sizeBytes,
        browser_download_url: SETUP_URL,
        url: SETUP_URL,
      },
    ],
    ...overrides,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'text/json' } });

const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { location: to } });

function stream(bytes: Buffer): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** Route by URL; anything unrouted is a 404, which reads as "not published". */
function serve(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      return Promise.resolve(route ? route() : new Response(null, { status: 404 }));
    }),
  );
}

/**
 * Import the service with a repo configured and the test key trusted.
 *
 * `config` reads `process.env` once at module load and the trusted key list is
 * compiled in, so both have to be in place before the import rather than
 * after — which is why every test goes through here.
 */
async function loadService(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env.ORDERBOOK_RELEASES_GITHUB_REPO = REPO;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'orderbook-gh-'));
  requested = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock('@orderbook/shared');
  delete process.env.ORDERBOOK_RELEASES_GITHUB_REPO;
  delete process.env.ORDERBOOK_ALLOW_UNSIGNED_RELEASES;
  await rm(dir, { recursive: true, force: true });
});

describe('syncing a release from GitHub', () => {
  it('UPD-28: does nothing, and asks nothing, when no repository is configured', async () => {
    vi.resetModules();
    delete process.env.ORDERBOOK_RELEASES_GITHUB_REPO;
    serve({});

    const { syncFromGitHub } = await import('../src/services/github-releases.js');

    expect(await syncFromGitHub('master', dir)).toBeNull();
    expect(requested).toEqual([]);
  });

  it('UPD-29: lands the setup file and writes latest.json last', async () => {
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    const landed = await syncFromGitHub('master', dir);

    expect(landed?.version).toBe('2.0.0');
    expect(await readFile(path.join(dir, manifest.file))).toEqual(PAYLOAD);

    const written = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8'));
    expect(written.sha256).toBe(manifest.sha256);
    expect(written.signature).toBe(manifest.signature);

    // No `.part` survives a good download either.
    expect((await readdir(dir)).sort()).toEqual([manifest.file, 'latest.json'].sort());
  });

  it('UPD-30: refuses an unsigned manifest without fetching the installer at all', async () => {
    // The ordering is the point. Verifying after downloading would let anyone
    // who can answer for GitHub spend a shop's bandwidth and disk at will,
    // every poll, for as long as they like.
    const { signature: _signature, keyId: _keyId, ...unsigned } = signed();

    serve({
      [API]: () => json(listing(unsigned as ReleaseManifest)),
      [MANIFEST_URL]: () => json(unsigned),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).toBeNull();
    expect(requested).not.toContain(SETUP_URL);
    expect(await readdir(dir)).toEqual([]);
  });

  it('UPD-30: refuses a manifest signed by a key this build does not carry', async () => {
    const stranger = generateKeyPairSync('ed25519');
    const manifest = signed();
    const forged = {
      ...manifest,
      signature: sign(
        null,
        Buffer.from(canonicalManifestPayload(manifest), 'utf8'),
        stranger.privateKey,
      ).toString('base64'),
    };

    serve({
      [API]: () => json(listing(forged as ReleaseManifest)),
      [MANIFEST_URL]: () => json(forged),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).toBeNull();
    expect(requested).not.toContain(SETUP_URL);
  });

  it('UPD-31: refuses to follow a redirect off GitHub', async () => {
    // A signed manifest and a hijacked download: the signature says the bytes
    // must hash to `sha256`, so the worst this achieves is a failed update —
    // but a shop PC should not be making the request in the first place.
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => redirect('https://cdn.example.invalid/setup.exe'),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).toBeNull();
    expect(requested).not.toContain('https://cdn.example.invalid/setup.exe');
    expect(await readdir(dir)).toEqual([]);
  });

  it('UPD-32: follows GitHub s own redirect to its object store', async () => {
    // The allowlist has to permit this one, or no download ever completes:
    // release asset URLs always redirect to the object store.
    const objects = 'https://objects.githubusercontent.com/orderbook/setup.exe';
    const manifest = signed();

    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => redirect(objects),
      [objects]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).not.toBeNull();
    expect(await readFile(path.join(dir, manifest.file))).toEqual(PAYLOAD);
  });

  it('UPD-33: refuses when GitHub s asset size disagrees with the manifest', async () => {
    const manifest = signed();
    const lying = listing(manifest);
    lying.assets = lying.assets.map((asset) =>
      asset.name === path.basename(manifest.file)
        ? { ...asset, size: manifest.sizeBytes + 1_000_000 }
        : asset,
    );

    serve({
      [API]: () => json(lying),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).toBeNull();
    expect(requested).not.toContain(SETUP_URL);
  });

  it('UPD-34: a body longer than the manifest lands nothing', async () => {
    // Without the running cap, a `Content-Length` of nothing and an endless
    // body fills the disk the company database lives on.
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(Buffer.concat([PAYLOAD, Buffer.alloc(4096, 0x41)])),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).toBeNull();
    // Neither the file nor a half-written `.part` is left behind.
    expect(await readdir(dir)).toEqual([]);
  });

  it('UPD-34: a truncated body lands nothing', async () => {
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD.subarray(0, 4)),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('UPD-35: refuses a manifest describing the other panel', async () => {
    // `panel` is inside the signature, so this is a correctly signed Master
    // release published under the office manifest name — the shape that would
    // otherwise install the Master on every till in the shop.
    const manifest = signed({ panel: 'master' });
    const published = listing(manifest);
    const asOffice = {
      ...published,
      assets: published.assets.map((asset) =>
        asset.name === 'latest-master.json' ? { ...asset, name: 'latest-office.json' } : asset,
      ),
    };

    serve({
      [API]: () => json(asOffice),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('office', dir)).toBeNull();
    expect(requested).not.toContain(SETUP_URL);
  });

  it('UPD-36: ignores drafts and pre-releases', async () => {
    // The release workflow publishes a draft when it could not sign, so this
    // is what keeps an unsigned build from reaching a single machine.
    const manifest = signed();

    for (const state of [{ draft: true }, { prerelease: true }]) {
      requested = [];
      serve({
        [API]: () => json(listing(manifest, state)),
        [MANIFEST_URL]: () => json(manifest),
        [SETUP_URL]: () => stream(PAYLOAD),
      });

      const { syncFromGitHub } = await loadService();

      expect(await syncFromGitHub('master', dir), JSON.stringify(state)).toBeNull();
      expect(requested).toEqual([API]);
    }
  });

  it('UPD-37: does not re-download a file already here at the right size', async () => {
    // A hundred megabytes over a shop connection, every poll, to arrive at the
    // file already on disk. The digest is still checked before anything runs.
    const manifest = signed();
    await writeFile(path.join(dir, manifest.file), PAYLOAD);

    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('master', dir)).not.toBeNull();
    expect(requested).not.toContain(SETUP_URL);
    expect(JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8')).version).toBe('2.0.0');
  });

  it('UPD-38: an unreachable GitHub is "nothing new", not an error', async () => {
    // The Updates screen calls this on every open. A shop with no internet
    // must see "you are up to date", not a red banner forever.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'))),
    );

    const { syncFromGitHub } = await loadService();

    await expect(syncFromGitHub('master', dir)).resolves.toBeNull();
  });
});
