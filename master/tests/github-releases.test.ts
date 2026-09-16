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

/*
 * Every `syncFromGitHub` call below passes `'win32'` explicitly.
 *
 * This suite is about the Windows release path throughout — the asset names,
 * the `.exe` filename, the legacy `latest-master.json` manifest name. Its calls
 * used to let the platform default to `process.platform`, so on a Linux or
 * macOS checkout the service asked GitHub for `latest-master-linux.json`, found
 * nothing, and nine tests failed with what read like a product bug. Platform
 * *selection* is covered where it belongs, in `updates.test.ts` (UPD-43).
 */

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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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
    const landed = await syncFromGitHub('master', dir, null, 'win32');

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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).not.toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
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

    expect(await syncFromGitHub('office', dir, null, 'win32')).toBeNull();
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

      expect(await syncFromGitHub('master', dir, null, 'win32'), JSON.stringify(state)).toBeNull();
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

    expect(await syncFromGitHub('master', dir, null, 'win32')).not.toBeNull();
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

    await expect(syncFromGitHub('master', dir, null, 'win32')).resolves.toBeNull();
  });
});

describe('polling for releases in the background', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ORDERBOOK_RELEASES_POLL_MINUTES;
    delete process.env.ORDERBOOK_RELEASES_DIR;
  });

  it('UPD-39: does nothing at all when no repository is configured', async () => {
    // The air-gapped case, which is still the default. A folder on a USB stick
    // must not start a timer that talks to the internet every three hours.
    vi.resetModules();
    delete process.env.ORDERBOOK_RELEASES_GITHUB_REPO;
    serve({});

    const { startReleasePolling } = await import('../src/services/update.service.js');
    const stop = startReleasePolling();

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);

    expect(requested).toEqual([]);
    expect(() => stop()).not.toThrow();
  });

  it('UPD-39: fills both panels folders, and stops when disposed', async () => {
    // The Master downloads the office build it will never install: every panel
    // on the LAN asks the Master for it, so the Master has to be holding one.
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    await loadService({
      ORDERBOOK_RELEASES_POLL_MINUTES: '60',
      ORDERBOOK_RELEASES_DIR: dir,
    });
    const { startReleasePolling } = await import('../src/services/update.service.js');

    vi.useFakeTimers();
    const stop = startReleasePolling();

    const asks = () => requested.filter((url) => url === API).length;

    // Nothing at boot: a shop PC starts up before it downloads 150 MB.
    expect(requested).toEqual([]);

    // `waitFor` rather than a bare assertion after advancing: the poll writes
    // to disk, and file I/O is not something advancing a timer flushes.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await vi.waitFor(() => expect(asks()).toBe(2)); // one ask per panel

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    await vi.waitFor(() => expect(asks()).toBe(4));

    stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(asks()).toBe(4);
  });
});

describe('clearing out what an earlier run left behind', () => {
  /**
   * Every filename in the releases folder carries a version, so cleanup keyed
   * to a filename stops working the moment the version moves — which is
   * precisely when a failed download is most likely to have left something.
   */
  it('UPD-40: removes a .part stranded by a crashed download of another version', async () => {
    const stranded = path.join(dir, 'OrderBook-Master-1.9.9-Setup.exe.part');
    await writeFile(stranded, Buffer.alloc(4096, 0x41));

    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    expect(await readdir(dir)).not.toContain('OrderBook-Master-1.9.9-Setup.exe.part');
  });

  it('UPD-40: removes a superseded setup file', async () => {
    // 150 MB per release, and nothing has ever deleted one.
    const old = path.join(dir, 'OrderBook-Master-1.9.9-Setup.exe');
    await writeFile(old, Buffer.alloc(2048, 0x42));

    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    expect((await readdir(dir)).sort()).toEqual([manifest.file, 'latest.json'].sort());
  });

  it('UPD-41: keeps the current release, and does not re-download it', async () => {
    // The sweep runs before the reuse check, so a sweep that took the current
    // file would turn every poll into a fresh hundred megabytes.
    const manifest = signed();
    await writeFile(path.join(dir, manifest.file), PAYLOAD);
    await writeFile(path.join(dir, 'latest.json'), JSON.stringify(manifest));

    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    expect(requested).not.toContain(SETUP_URL);
    expect(await readFile(path.join(dir, manifest.file))).toEqual(PAYLOAD);
  });

  it('UPD-42: a failed download leaves the build already on disk intact', async () => {
    // The one that decides where the superseded sweep goes. Until `latest.json`
    // names the new file, the old one IS the release — it is what the manifest
    // names, what the shell would install, and what every Office panel on the
    // LAN is asking the Master to stream. Sweeping it before a download that
    // then fails would leave a manifest pointing at nothing, which is worse
    // than the 150 MB it saves.
    const manifest = signed();
    const held = signed({ version: '1.0.0', file: 'OrderBook-Master-1.0.0-Setup.exe' });

    await writeFile(path.join(dir, held.file), PAYLOAD);
    await writeFile(path.join(dir, 'latest.json'), JSON.stringify(held));

    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD.subarray(0, 3)), // truncated: the download fails
    });

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();

    const left = await readdir(dir);
    expect(left).toContain(held.file); // still installable, still servable
    expect(left).not.toContain(`${manifest.file}.part`); // and no half-file
    expect(JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8')).version).toBe('1.0.0');
  });

  it('UPD-42: the superseded build goes once the new one has landed', async () => {
    // The other half: keeping it forever is the disk leak this started as.
    const manifest = signed();
    const held = signed({ version: '1.0.0', file: 'OrderBook-Master-1.0.0-Setup.exe' });

    await writeFile(path.join(dir, held.file), PAYLOAD);
    await writeFile(path.join(dir, 'latest.json'), JSON.stringify(held));

    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('master', dir, null, 'win32')).not.toBeNull();

    expect((await readdir(dir)).sort()).toEqual([manifest.file, 'latest.json'].sort());
  });

  it('UPD-43: sweeps a latest.json.tmp stranded by a crash mid-write', async () => {
    // `writeDurable` writes through `.tmp` and renames. A power cut between the
    // two leaves the temporary behind, and it is neither the manifest nor the
    // setup file, so the sweep takes it.
    await writeFile(path.join(dir, 'latest.json.tmp'), '{"tor');

    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    expect(await readdir(dir)).not.toContain('latest.json.tmp');
    // And the manifest that did land is readable, not torn.
    expect(JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8')).version).toBe('2.0.0');
  });

  it('UPD-44: sweeps nothing when there is nothing stale', async () => {
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    expect((await readdir(dir)).sort()).toEqual([manifest.file, 'latest.json'].sort());
  });

  it('UPD-45: leaves alone anything it did not write', async () => {
    // docs/UPDATES.md promises an operator can copy a build into this folder by
    // hand. A Master that also polls GitHub must not answer that by deleting
    // their notes, their subfolders, or a file whose name it does not know.
    const manifest = signed();
    await writeFile(path.join(dir, 'READ ME FIRST.txt'), 'do not delete');
    await writeFile(path.join(dir, 'vendor-tool.exe'), 'not ours');

    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    const left = await readdir(dir);
    expect(left).toContain('READ ME FIRST.txt');
    expect(left).toContain('vendor-tool.exe');
  });

  it('UPD-46: does not sweep the installer an operator is part-way through', async () => {
    // `prepareMasterUpdate` pins a verified build while the shell polls health
    // and a person reads a dialog. A newer release landing in that gap must not
    // delete the file out from under the click.
    const pinned = 'OrderBook-Master-1.0.0-Setup.exe';
    await writeFile(path.join(dir, pinned), PAYLOAD);

    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, pinned, 'win32');

    expect(await readdir(dir)).toContain(pinned);
  });

  it('UPD-47: two syncs at once are one sync', async () => {
    // The poller has its own guard, but `availability()` syncs on every
    // request — so an office panel and an open Updates screen can each start
    // one. Two runs on the same folder write the same `.part`, and the loser
    // corrupts the winner.
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    const [a, b] = await Promise.all([
      syncFromGitHub('master', dir, null, 'win32'),
      syncFromGitHub('master', dir, null, 'win32'),
    ]);

    expect(a).toEqual(b);
    expect(requested.filter((url) => url === API).length).toBe(1);
    expect(await readFile(path.join(dir, manifest.file))).toEqual(PAYLOAD);
  });
});
