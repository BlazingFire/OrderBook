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
 * both harder to provoke, not easier. The exception is how long a download may
 * take — see `handAnswered` for why that one needs a real socket.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type * as Fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Shared from '@orderbook/shared';
import type { PanelKind, ReleaseManifest } from '@orderbook/shared';
import { canonicalManifestPayload } from '@orderbook/shared';

/*
 * Taken before any test fakes the clock or stubs `fetch`: the timing tests
 * below wait on sockets and disk in real time, and forward a request to a real
 * `fetch`, whatever the fakes are doing.
 */
const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;

/*
 * The manifests below carry no `platform`, which the reader defaults to the
 * Windows build every pre-platform release was — and then compares against
 * `process.platform`. On the Linux CI runner that comparison refused every
 * fixture and nine tests failed with no release ever landing. The fixtures
 * describe Windows builds; run the suite as Windows. `updates.test.ts` does
 * the same, for the same reason.
 */
const HOST_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: HOST_PLATFORM, configurable: true });
});

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

/**
 * The asset name a release publishes `manifest` under — the rule the release
 * workflow follows: the Windows build keeps the pre-platform name.
 */
function manifestAssetName(manifest: ReleaseManifest): string {
  const platform = manifest.platform ?? 'win32';
  return platform === 'win32'
    ? `latest-${manifest.panel}.json`
    : `latest-${manifest.panel}-${platform}.json`;
}

/** A release listing GitHub would answer with, describing `manifest`. */
function listing(manifest: ReleaseManifest, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${manifest.version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: manifestAssetName(manifest),
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

/**
 * One URL's answer. Handed the request's own `init` — its `signal` included —
 * so a route can pass the request on to a real server (`forwardTo`).
 */
type Route = (init?: RequestInit) => Response | Promise<Response>;

/** Route by URL; anything unrouted is a 404, which reads as "not published". */
function serve(routes: Record<string, Route>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      return Promise.resolve(route ? route(init) : new Response(null, { status: 404 }));
    }),
  );
}

/**
 * A body that delivers what the test pushes, when it pushes it, and ends when
 * the test says.
 *
 * For holding a download open while something else happens — a panel asking,
 * an operator preparing an install — or trickling it for as long as a test
 * likes, without anything but the test deciding when it ends.
 */
function openBody(): { response: Route; push: (bytes: Buffer) => void; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;
    },
  });
  return {
    response: () => new Response(body, { status: 200 }),
    push: (bytes) => {
      try {
        controller.enqueue(new Uint8Array(bytes));
      } catch {
        // The reader has gone: the download was given up, which is what a
        // test pushing into it may be waiting to see.
      }
    },
    end: () => controller.close(),
  };
}

/**
 * Counts the poll's finished runs through its `afterPoll` hook, and waits for
 * the n-th. A poll downloads, hashes and renames real files, so how long it
 * takes is real time, not fake timer time: `vi.waitFor` gave it its default
 * 1 s and, under a loaded full suite, timed out before the manifest landed
 * (UPD-63 and UPD-67 failed about one run in five with six CPU burners).
 */
function pollWatcher() {
  let finished = 0;
  let wake: (() => void) | null = null;
  return {
    afterPoll: async (): Promise<void> => {
      finished += 1;
      wake?.();
    },
    async until(runs: number): Promise<void> {
      while (finished < runs) await new Promise<void>((resolve) => (wake = resolve));
    },
  };
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
  // Fetching is on unless a test says otherwise, whatever the shell running the
  // suite set: a scratch gate often has `0` here, which now stops every fetch.
  process.env.ORDERBOOK_RELEASES_POLL_MINUTES = '2';
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
  delete process.env.ORDERBOOK_RELEASES_POLL_MINUTES;
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

  it('UPD-29: lands the setup file and writes its manifest last', async () => {
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

    // Both names a Windows build is published under, as `tools/release.mjs`
    // writes them — see UPD-48 for why the platform one is not optional.
    for (const name of ['latest-win32.json', 'latest.json']) {
      const written = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      expect(written.sha256, name).toBe(manifest.sha256);
      expect(written.signature, name).toBe(manifest.signature);
    }

    // No `.part` survives a good download either.
    expect((await readdir(dir)).sort()).toEqual(
      [manifest.file, 'latest-win32.json', 'latest.json'].sort(),
    );
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

describe('ORDERBOOK_RELEASES_POLL_MINUTES=0', () => {
  // A scratch Master with `0` still downloaded a release about 90 s after it
  // started: the setting stopped only the timer, and the Updates screen's
  // status call synced from GitHub anyway. `0` means no fetch of any kind.
  for (const minutes of ['0', '-5', 'off']) {
    it(`makes no network request on any path when it is ${JSON.stringify(minutes)}`, async () => {
      const manifest = signed();
      serve({
        [API]: () => json(listing(manifest)),
        [MANIFEST_URL]: () => json(manifest),
        [SETUP_URL]: () => stream(PAYLOAD),
      });

      const { syncFromGitHub } = await loadService({
        ORDERBOOK_RELEASES_POLL_MINUTES: minutes,
        ORDERBOOK_RELEASES_DIR: dir,
      });
      const update = await import('../src/services/update.service.js');

      expect(await syncFromGitHub('master', dir, null, 'win32')).toBeNull();
      await update.availability('office', '0.0.0', 'win32');
      await update.masterAvailability();
      await update.checkNow();
      await update.syncAll();

      vi.useFakeTimers();
      const stop = update.startReleasePolling();
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
      stop();
      vi.useRealTimers();

      expect(requested).toEqual([]);
    });
  }

  it('still fetches when it is a positive number (the guard is not simply off)', async () => {
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });
    const { syncFromGitHub } = await loadService({ ORDERBOOK_RELEASES_POLL_MINUTES: '60' });

    expect(await syncFromGitHub('master', dir, null, 'win32')).not.toBeNull();
    expect(requested).toContain(API);
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
    const polls = pollWatcher();
    const stop = startReleasePolling(polls.afterPoll);

    const asks = () => requested.filter((url) => url === API).length;

    // Nothing at boot: a shop PC starts up before it downloads 150 MB.
    expect(requested).toEqual([]);

    // Waited for rather than asserted straight after advancing: the poll writes
    // to disk, and file I/O is not something advancing a timer flushes.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await polls.until(1);
    expect(asks()).toBe(2); // one ask per panel

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    await polls.until(2);
    expect(asks()).toBe(4);

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

    expect((await readdir(dir)).sort()).toEqual(
      [manifest.file, 'latest-win32.json', 'latest.json'].sort(),
    );
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

    expect((await readdir(dir)).sort()).toEqual(
      [manifest.file, 'latest-win32.json', 'latest.json'].sort(),
    );
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

    expect((await readdir(dir)).sort()).toEqual(
      [manifest.file, 'latest-win32.json', 'latest.json'].sort(),
    );
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

/** Where a release's files are downloaded from, one URL per asset. */
const DOWNLOADS = 'https://github.com/orderbook/releases/releases/download/v2.0.0';

/**
 * One release carrying several builds — one per OS, as the release workflow
 * publishes them — and the routes that serve it, each asset at its own URL.
 */
function publishedTogether(...manifests: ReleaseManifest[]): Record<string, Route> {
  const asset = (name: string, size: number) => ({
    name,
    size,
    browser_download_url: `${DOWNLOADS}/${name}`,
    url: `${DOWNLOADS}/${name}`,
  });

  const routes: Record<string, Route> = {
    [API]: () =>
      json({
        tag_name: 'v2.0.0',
        draft: false,
        prerelease: false,
        assets: manifests.flatMap((manifest) => [
          asset(manifestAssetName(manifest), 500),
          asset(manifest.file, manifest.sizeBytes),
        ]),
      }),
  };

  for (const manifest of manifests) {
    routes[`${DOWNLOADS}/${manifestAssetName(manifest)}`] = () => json(manifest);
    routes[`${DOWNLOADS}/${manifest.file}`] = () => stream(PAYLOAD);
  }
  return routes;
}

/** Each OS's setup file extension, as `tools/release.mjs` builds them. */
const SETUP_EXTENSION = { win32: 'exe', darwin: 'dmg', linux: 'AppImage' } as const;

/** A signed office build for one OS. */
const officeBuild = (platform: keyof typeof SETUP_EXTENSION, version = '2.0.0') =>
  signed({
    panel: 'office',
    platform,
    version,
    file: `OrderBook-Office-${version}-Setup.${SETUP_EXTENSION[platform]}`,
  });

/** A signed office build for the legacy Windows 7 line, named as `tools/release.mjs` tags it. */
const win7Build = (version = '2.0.0') =>
  signed({
    panel: 'office',
    platform: 'win7',
    version,
    file: `OrderBook-Office-Win7-${version}-Setup.exe`,
  });

describe('one releases folder, several operating systems', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ORDERBOOK_RELEASES_DIR;
    delete process.env.ORDERBOOK_RELEASES_POLL_MINUTES;
    delete process.env.APPIMAGE;
  });

  it('UPD-48: writes the manifest the reader looks for first, so one the release script left cannot shadow it', async () => {
    // `tools/release.mjs` writes `latest-win32.json` beside the legacy
    // `latest.json`, and `readManifest` reads the platform name first and stops
    // at the first file it can read. A sync that rewrote only `latest.json` left
    // the reader on the script's old manifest — whose setup file that same sync
    // had just swept as superseded — so the shop was told nothing had been
    // published, with the new build sitting in the folder.
    const masterDir = path.join(dir, 'master-panel');
    await mkdir(masterDir, { recursive: true });

    const byHand = signed({
      version: '1.0.0',
      file: 'OrderBook-Master-1.0.0-Setup.exe',
      platform: 'win32',
    });
    await writeFile(path.join(masterDir, byHand.file), PAYLOAD);
    for (const name of ['latest-win32.json', 'latest.json']) {
      await writeFile(path.join(masterDir, name), JSON.stringify(byHand));
    }

    const published = signed({ platform: 'win32' });
    serve({
      [API]: () => json(listing(published)),
      [MANIFEST_URL]: () => json(published),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    await loadService({ ORDERBOOK_RELEASES_DIR: dir });
    const { availability } = await import('../src/services/update.service.js');

    expect((await availability('master', '1.5.0', 'win32')).available?.version).toBe('2.0.0');
  });

  it('UPD-49: a Mac build does not overwrite the Windows latest.json', async () => {
    // What `tools/release.mjs` refuses to do, for its reason: `latest.json` is
    // the only name a pre-platform reader knows, and every one of those is
    // Windows. The Mac build gets its own name and leaves that one alone.
    const windows = officeBuild('win32', '1.0.0');
    await writeFile(path.join(dir, windows.file), PAYLOAD);
    await writeFile(path.join(dir, 'latest.json'), JSON.stringify(windows));

    const mac = officeBuild('darwin');
    serve(publishedTogether(mac));

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('office', dir, null, 'darwin')).not.toBeNull();

    const read = async (name: string) =>
      (JSON.parse(await readFile(path.join(dir, name), 'utf8')) as ReleaseManifest).file;
    expect(await read('latest.json')).toBe(windows.file);
    expect(await read('latest-darwin.json')).toBe(mac.file);
  });

  it("UPD-50: sweeps superseded builds for its own OS, and leaves every other OS's alone", async () => {
    // A Master serving Windows and Mac panels holds both office builds in one
    // folder. Each OS's sync used to sweep every setup file but its own, so the
    // two deleted each other's build on every ask and fetched 150 MB apiece to
    // put it back. And another OS's `.part` or manifest `.tmp` is not debris:
    // the two OSes' syncs run at once, so it may be being written right now.
    const otherOs = [
      'OrderBook-Office-1.0.0-Setup.exe',
      'OrderBook-Office-1.0.0-Setup.AppImage',
      'OrderBook-Office-2.0.0-Setup.exe.part',
      'latest-win32.json.tmp',
    ];
    const superseded = [
      'OrderBook-Office-1.0.0-Setup.dmg',
      'OrderBook-Office-1.9.0-Setup.dmg.part',
    ];
    for (const name of [...otherOs, ...superseded]) await writeFile(path.join(dir, name), PAYLOAD);

    serve(publishedTogether(officeBuild('darwin')));

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('office', dir, null, 'darwin')).not.toBeNull();

    const left = await readdir(dir);
    for (const name of superseded) expect(left, name).not.toContain(name);
    for (const name of otherOs) expect(left, name).toContain(name);
  });

  it('UPD-51: sweeps a superseded Linux AppImage', async () => {
    // The Linux setup file is an AppImage, and the sweep knew only `.exe` and
    // `.dmg` — so a Linux Master kept every build it had ever fetched.
    const old = 'OrderBook-Office-1.0.0-Setup.AppImage';
    await writeFile(path.join(dir, old), PAYLOAD);

    const linux = officeBuild('linux');
    serve(publishedTogether(linux));

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('office', dir, null, 'linux')).not.toBeNull();

    expect((await readdir(dir)).sort()).toEqual([linux.file, 'latest-linux.json'].sort());
  });

  it('UPD-52: a Windows panel and a Mac panel asking in turn each get their own build, fetched once', async () => {
    // The Master's poll fetches the office build for its own OS; a panel on
    // another OS has its first build fetched when it asks. That works only if
    // the two builds can share the folder — which they could not while each
    // sync rewrote `latest.json` and swept the other's setup file.
    const windows = officeBuild('win32');
    const mac = officeBuild('darwin');
    serve(publishedTogether(windows, mac));

    await loadService({ ORDERBOOK_RELEASES_DIR: dir });
    const { availability, readManifest } = await import('../src/services/update.service.js');

    for (const platform of ['win32', 'darwin', 'win32', 'darwin'] as const) {
      const offered = await availability('office', '1.0.0', platform);
      expect(offered.available?.file, platform).toBe(
        platform === 'win32' ? windows.file : mac.file,
      );
    }

    // What `/office/download` reads before it streams the file, for each OS.
    expect((await readManifest('office', 'win32'))?.file).toBe(windows.file);
    expect((await readManifest('office', 'darwin'))?.file).toBe(mac.file);

    for (const file of [windows.file, mac.file]) {
      expect(
        requested.filter((url) => url === `${DOWNLOADS}/${file}`),
        file,
      ).toHaveLength(1);
    }
  });

  it('UPD-62: never sweeps the AppImage this Master is running from', async () => {
    // An AppImage is not an installer but the program itself, run from wherever
    // it was put — this folder included. Its name keeps the version it was
    // downloaded as, so by name it is always superseded — and sweeping it
    // deletes the running Master's own program, which is fine until it next starts.
    const running = 'OrderBook-Master-1.0.0-Setup.AppImage';
    const superseded = 'OrderBook-Master-1.5.0-Setup.AppImage';
    for (const name of [running, superseded]) await writeFile(path.join(dir, name), PAYLOAD);
    process.env.APPIMAGE = path.join(dir, running);

    const linux = signed({ platform: 'linux', file: 'OrderBook-Master-2.0.0-Setup.AppImage' });
    serve(publishedTogether(linux));

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('master', dir, null, 'linux')).not.toBeNull();

    expect((await readdir(dir)).sort()).toEqual([linux.file, running, 'latest-linux.json'].sort());
  });

  it('UPD-62: still sweeps a build that only shares its name with the running AppImage', async () => {
    // The same file name in another folder is another file: a Master run from
    // `~/Applications` must not keep a copy here for ever because the copy it
    // runs was first downloaded as the same version.
    const elsewhere = path.join(dir, 'Applications');
    await mkdir(elsewhere);
    const name = 'OrderBook-Master-1.0.0-Setup.AppImage';
    await writeFile(path.join(elsewhere, name), PAYLOAD);
    await writeFile(path.join(dir, name), PAYLOAD);
    process.env.APPIMAGE = path.join(elsewhere, name);

    const linux = signed({ platform: 'linux', file: 'OrderBook-Master-2.0.0-Setup.AppImage' });
    serve(publishedTogether(linux));

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('master', dir, null, 'linux')).not.toBeNull();

    expect(await readdir(dir)).not.toContain(name);
    expect(await readdir(elsewhere)).toEqual([name]);
  });

  it('UPD-63: the poll also fetches the office build for every other OS a panel has had one for', async () => {
    // A panel on another OS has its build fetched when it asks, and the ask is
    // answered after 5 s from the folder as it stands — "nothing new", until
    // the download lands. Left at that, the first ask after every release said
    // so. A manifest for that OS in the folder means a panel there has asked
    // before, so the poll fetches its next build ahead of the ask, as it does
    // the Master's own; an OS nobody here has asked for is not fetched at all.
    const officeDir = path.join(dir, 'office-panel');
    await mkdir(officeDir, { recursive: true });
    const macBefore = officeBuild('darwin', '1.0.0');
    await writeFile(path.join(officeDir, macBefore.file), PAYLOAD);
    await writeFile(path.join(officeDir, 'latest-darwin.json'), JSON.stringify(macBefore));

    const master = signed({ platform: 'win32' });
    const windows = officeBuild('win32');
    const mac = officeBuild('darwin');
    const linux = officeBuild('linux');
    serve(publishedTogether(master, windows, mac, linux));

    await loadService({ ORDERBOOK_RELEASES_POLL_MINUTES: '60', ORDERBOOK_RELEASES_DIR: dir });
    const { readManifest, startReleasePolling } = await import('../src/services/update.service.js');

    vi.useFakeTimers();
    const polls = pollWatcher();
    const stop = startReleasePolling(polls.afterPoll);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await polls.until(1);
    stop();

    expect((await readManifest('office', 'darwin'))?.file).toBe(mac.file);

    expect((await readManifest('office', 'win32'))?.file).toBe(windows.file);
    expect((await readManifest('master', 'win32'))?.file).toBe(master.file);
    expect(requested).not.toContain(`${DOWNLOADS}/${linux.file}`);
  });

  it('UPD-64: a Windows sync and a Win7 sync each sweep only their own superseded build', async () => {
    // Both builds are `.exe`, so a sweep keyed on the extension alone read them
    // as one OS: each sync took the other's setup file as "superseded" and
    // fetched 150 MB to put its own back on the next ask.
    const windowsOld = 'OrderBook-Office-1.0.0-Setup.exe';
    const win7Old = 'OrderBook-Office-Win7-1.0.0-Setup.exe';
    await writeFile(path.join(dir, windowsOld), PAYLOAD);
    await writeFile(path.join(dir, win7Old), PAYLOAD);
    const before = officeBuild('win32', '1.0.0');
    for (const name of ['latest-win32.json', 'latest.json']) {
      await writeFile(path.join(dir, name), JSON.stringify(before));
    }
    await writeFile(path.join(dir, 'latest-win7.json'), JSON.stringify(win7Build('1.0.0')));

    const windows = officeBuild('win32');
    const win7 = win7Build();
    serve(publishedTogether(windows, win7));
    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('office', dir, null, 'win32')).not.toBeNull();
    let left = await readdir(dir);
    expect(left).not.toContain(windowsOld);
    expect(left).toContain(win7Old);

    expect(await syncFromGitHub('office', dir, null, 'win7')).not.toBeNull();
    left = await readdir(dir);
    expect(left).not.toContain(win7Old);
    expect(left).toContain(windows.file);
    expect(left).toContain(win7.file);
  });

  it("UPD-65: a Win7 sync leaves the Windows sync's half-written files alone", async () => {
    // The two syncs can run at once, so the Windows `.part` and manifest
    // `.tmp` may be being written right now. Only the Win7 line's are debris.
    const windowsInFlight = [
      'OrderBook-Office-2.0.0-Setup.exe.part',
      'latest-win32.json.tmp',
      'latest.json.tmp',
    ];
    const win7Debris = ['OrderBook-Office-Win7-1.9.0-Setup.exe.part', 'latest-win7.json.tmp'];
    for (const name of [...windowsInFlight, ...win7Debris]) {
      await writeFile(path.join(dir, name), PAYLOAD);
    }

    serve(publishedTogether(win7Build()));
    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('office', dir, null, 'win7')).not.toBeNull();

    const left = await readdir(dir);
    for (const name of windowsInFlight) expect(left, name).toContain(name);
    for (const name of win7Debris) expect(left, name).not.toContain(name);
  });

  it('UPD-66: a Win7 sync reads latest-office-win7.json and writes only latest-win7.json', async () => {
    // Plain `latest.json` is what a Windows panel older than per-OS names
    // reads. A Win7 sync writing it would hand those panels a build their
    // Electron cannot be replaced by.
    const win7 = win7Build();
    serve(publishedTogether(win7));
    const { syncFromGitHub } = await loadService();

    expect(await syncFromGitHub('office', dir, null, 'win7')).not.toBeNull();

    expect(requested).toContain(`${DOWNLOADS}/latest-office-win7.json`);
    expect((await readdir(dir)).sort()).toEqual([win7.file, 'latest-win7.json'].sort());
  });

  it('UPD-67: the poll fetches the Win7 office build once a Win7 panel has had one', async () => {
    // `win7` is never the Master's own platform, so a `latest-win7.json` in the
    // folder is the only thing that puts it on the poll.
    const officeDir = path.join(dir, 'office-panel');
    await mkdir(officeDir, { recursive: true });
    const win7Before = win7Build('1.0.0');
    await writeFile(path.join(officeDir, win7Before.file), PAYLOAD);
    await writeFile(path.join(officeDir, 'latest-win7.json'), JSON.stringify(win7Before));

    const master = signed({ platform: 'win32' });
    const windows = officeBuild('win32');
    const win7 = win7Build();
    serve(publishedTogether(master, windows, win7));

    await loadService({ ORDERBOOK_RELEASES_POLL_MINUTES: '60', ORDERBOOK_RELEASES_DIR: dir });
    const { readManifest, startReleasePolling } = await import('../src/services/update.service.js');

    vi.useFakeTimers();
    const polls = pollWatcher();
    const stop = startReleasePolling(polls.afterPoll);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await polls.until(1);
    stop();

    expect((await readManifest('office', 'win7'))?.file).toBe(win7.file);

    expect((await readManifest('office', 'win32'))?.file).toBe(windows.file);
  });
});

/** Every `handAnswered` server a test opened, for `afterEach` to close. */
const hosts: Array<{ close: () => Promise<void> }> = [];

/**
 * A server on 127.0.0.1 that answers one request by hand, as slowly as the test
 * likes.
 *
 * A stubbed `Response` cannot show what the timing tests are about. The limit
 * lives on the `signal` handed to `fetch`, and whether that signal cuts a body
 * off halfway is up to a real `fetch` reading a real socket — a stub ignores
 * it, and every download would pass however it was timed. So the stub forwards
 * this one URL, `init` and all, to a real `fetch` against this server.
 */
async function handAnswered() {
  let answer!: (response: http.ServerResponse) => void;
  const answered = new Promise<http.ServerResponse>((resolve) => (answer = resolve));
  const server = http.createServer((_request, response) => answer(response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  let arrived!: () => void;
  const headersIn = new Promise<void>((resolve) => (arrived = resolve));

  const host = {
    /** The route to hand `serve`. */
    route: ((init?: RequestInit) =>
      realFetch(url, init).then((response) => {
        arrived();
        return response;
      })) as Route,
    /** The server's side of the one request, for the test to write to. */
    answered,
    /** Resolves once `fetch` has the headers — the body is all that is left. */
    headersIn,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  hosts.push(host);
  return host;
}

/**
 * Put every time limit on a clock the test turns by hand.
 *
 * Vitest fakes `setTimeout`. `AbortSignal.timeout` runs on a timer of Node's
 * own that no fake reaches, so it is rebuilt on the faked `setTimeout` here.
 * With both covered, these tests hold whichever way a limit is written — which
 * is what let them be watched failing against the version that put the whole
 * download on one 15 s `AbortSignal.timeout`.
 */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('The operation timed out', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
}

/** Let sockets and the disk catch up: real time, whatever the fake clock says. */
const settle = (ms = 50) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** What `promise` settled to, or 'pending' if it has not within `ms` of real time. */
const within = <T>(promise: Promise<T>, ms = 3_000): Promise<T | 'pending'> =>
  Promise.race([
    promise,
    new Promise<'pending'>((resolve) => realSetTimeout(() => resolve('pending'), ms)),
  ]);

describe('how long a download may take', () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  it('UPD-53: a setup file that takes longer than 15 s to arrive still lands', async () => {
    // 15 s is how long GitHub gets to *answer*. It used to be how long the
    // whole download got, body and all, so a 150 MB setup file on a shop
    // connection was cut off every time and never landed.
    const manifest = signed();
    const host = await handAnswered();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: host.route,
    });

    const { syncFromGitHub } = await loadService();
    fakeClock();
    const landing = syncFromGitHub('master', dir, null, 'win32');

    const response = await host.answered;
    response.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    response.flushHeaders();
    await host.headersIn;
    await settle();

    // A few bytes every ten seconds, for 40 s: slow, and never silent for long.
    for (let at = 0; at < PAYLOAD.length; at += 6) {
      response.write(PAYLOAD.subarray(at, at + 6));
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    response.end();

    expect((await within(landing)) as ReleaseManifest | null).toMatchObject({ version: '2.0.0' });
    expect(await readFile(path.join(dir, manifest.file))).toEqual(PAYLOAD);
  });

  it('UPD-54: a download that goes silent is given up after a minute, and leaves nothing', async () => {
    // A slow link still delivers something every few seconds; a minute of
    // nothing at all is a connection that has died. Waiting on it for ever
    // would hold every later sync for this panel, which all share this one.
    const manifest = signed();
    const host = await handAnswered();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: host.route,
    });

    const { syncFromGitHub } = await loadService();
    fakeClock();
    const landing = syncFromGitHub('master', dir, null, 'win32');

    const response = await host.answered;
    response.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    response.write(PAYLOAD.subarray(0, 4));
    await host.headersIn;
    await settle();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(await within(landing, 200)).toBe('pending');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await within(landing)).toBeNull();
    expect(await readdir(dir)).toEqual([]); // no `.part` left behind
  });

  it('UPD-55: the manifest is still given 15 s, and no more', async () => {
    // The longer limits are for the setup file's body alone. A manifest is a
    // few hundred bytes; one that has not arrived in 15 s is not coming, and an
    // Updates screen may be waiting on it.
    const manifest = signed();
    const host = await handAnswered();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: host.route,
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    fakeClock();
    const landing = syncFromGitHub('master', dir, null, 'win32');

    const response = await host.answered;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"panel":"master",');
    await host.headersIn;
    await settle();

    await vi.advanceTimersByTimeAsync(14_000);
    expect(await within(landing, 200)).toBe('pending');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await within(landing)).toBeNull();
    expect(requested).not.toContain(SETUP_URL);
  });

  it('UPD-56: a download that never finishes is given up after three hours', async () => {
    // A trickle defeats a silence limit: a byte every fifty seconds is never a
    // minute of nothing, and 150 MB at that rate takes centuries. Without an
    // overall limit the sync never settles — and every later sync for the
    // panel shares it, and the poll waits on it, for as long as the Master runs.
    const manifest = signed({ sizeBytes: 1_000_000 });
    const body = openBody();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: body.response,
    });

    const { syncFromGitHub } = await loadService();
    fakeClock();
    const landing = syncFromGitHub('master', dir, null, 'win32');
    await settle();

    const trickle = async (forMs: number) => {
      for (let elapsed = 0; elapsed < forMs; elapsed += 50_000) {
        body.push(Buffer.from('x'));
        await settle(0);
        await vi.advanceTimersByTimeAsync(50_000);
      }
    };

    await trickle(179 * 60_000);
    expect(await within(landing, 200)).toBe('pending');

    await trickle(2 * 60_000);
    expect(await within(landing)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('UPD-59: a setup file behind GitHub s redirect gets the same limits as one without', async () => {
    // Every real download is two hops: github.com answers 302 at once, and the
    // object store sends the body. Each hop has its own 15 s to answer, so the
    // clock that has to stop at headers is the second hop's, not the first's.
    const objects = 'https://objects.githubusercontent.com/orderbook/setup.exe';
    const manifest = signed();
    const host = await handAnswered();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => redirect(objects),
      [objects]: host.route,
    });

    const { syncFromGitHub } = await loadService();
    fakeClock();
    const landing = syncFromGitHub('master', dir, null, 'win32');

    const response = await host.answered;
    response.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    response.flushHeaders();
    await host.headersIn;
    await settle();

    for (let at = 0; at < PAYLOAD.length; at += 6) {
      response.write(PAYLOAD.subarray(at, at + 6));
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    response.end();

    expect((await within(landing)) as ReleaseManifest | null).toMatchObject({ version: '2.0.0' });
    expect(requested).toContain(objects);
    expect(await readFile(path.join(dir, manifest.file))).toEqual(PAYLOAD);
  });

  it('UPD-60: a setup file whose host never answers is given up after 15 s', async () => {
    // The body's minute of silence starts at headers. Before them, the setup
    // file's request is held to the 15 s every hop gets, like any other: the
    // longer limits must not have taken that one away with them.
    const manifest = signed();
    const host = await handAnswered();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: host.route,
    });

    const { syncFromGitHub } = await loadService();
    fakeClock();
    const landing = syncFromGitHub('master', dir, null, 'win32');

    await host.answered; // asked, and never answered
    await settle();

    await vi.advanceTimersByTimeAsync(14_000);
    expect(await within(landing, 200)).toBe('pending');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await within(landing)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('answering while a download runs', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock('node:fs');
    delete process.env.ORDERBOOK_RELEASES_DIR;
  });

  it('UPD-57: a panel asking while its build downloads is answered from the folder, not kept waiting', async () => {
    // An Office panel gives the Master 10 s to answer and the Master's own
    // browser 15; a setup file takes minutes. Waiting for the download told the
    // first panel of a new OS to ask — whose first build the poll does not
    // fetch — "Could not reach the Master Panel", every time, until the
    // download it had started finished behind its back.
    const mac = officeBuild('darwin');
    const body = openBody();
    serve({ ...publishedTogether(mac), [`${DOWNLOADS}/${mac.file}`]: body.response });

    const { syncFromGitHub } = await loadService({ ORDERBOOK_RELEASES_DIR: dir });
    const { availability } = await import('../src/services/update.service.js');
    fakeClock();

    const asking = availability('office', '1.0.0', 'darwin');
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    const answer = await within(asking);
    expect(answer).not.toBe('pending');
    expect(answer).toMatchObject({ available: null });

    // The download carried on without the request — asking again joins it
    // rather than starting another — and the next ask has the build.
    body.push(PAYLOAD);
    body.end();
    const officeDir = path.join(dir, 'office-panel');
    expect(await within(syncFromGitHub('office', officeDir, null, 'darwin'))).toMatchObject({
      file: mac.file,
    });
    expect((await availability('office', '1.0.0', 'darwin')).available?.file).toBe(mac.file);
    expect(requested.filter((url) => url === `${DOWNLOADS}/${mac.file}`)).toHaveLength(1);
  });

  it('UPD-58: a download that outlives its request still spares an installer pinned meanwhile', async () => {
    // Answering before the download finishes means a sync can still be running
    // when an operator prepares the build already here. The sync was handed the
    // pinned file when it started — nothing, then — and so swept the operator's
    // installer the moment the newer one landed, out from under the click.
    const { masterDir, here, newer, body } = await aBuildHereAndANewerOneDownloading();

    const { syncFromGitHub } = await loadService({ ORDERBOOK_RELEASES_DIR: dir });
    const { prepareMasterUpdate } = await import('../src/services/update.service.js');
    fakeClock();

    const preparing = prepareMasterUpdate();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    const prepared = await within(preparing);
    expect(prepared).not.toBe('pending');
    expect(prepared).toMatchObject({ manifest: { version: '90.0.0' } });

    body.push(PAYLOAD);
    body.end();
    expect(await within(syncFromGitHub('master', masterDir, null, 'win32'))).toMatchObject({
      version: '91.0.0',
    });

    const left = await readdir(masterDir);
    expect(left).toContain(newer.file);
    expect(left).toContain(here.file); // pinned: the operator is about to run it
  });

  it('UPD-61: a download landing while the operator s build is being verified spares it too', async () => {
    // `prepareMasterUpdate` hashes 150 MB before the build becomes `prepared`,
    // and a sync still running from the ask that found it can land in that
    // time. Pinned only once verified, the build was unpinned while it was
    // hashed and swept as superseded — the hash still finished on the open
    // file, and the shell's copy of the path it was handed then failed.
    const { masterDir, here, newer, body } = await aBuildHereAndANewerOneDownloading();

    // Hold the hash of the operator's build, with its file already open, until
    // the newer build has landed and been swept around it.
    let hashing!: () => void;
    const hashStarted = new Promise<void>((resolve) => (hashing = resolve));
    let letHashFinish!: () => void;
    const hashMayFinish = new Promise<void>((resolve) => (letHashFinish = resolve));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof Fs>('node:fs');
      return {
        ...actual,
        createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
          const stream = actual.createReadStream(...args);
          if (String(args[0]).endsWith(here.file)) {
            stream.pause();
            stream.once('open', () => hashing());
            void hashMayFinish.then(() => stream.resume());
          }
          return stream;
        }) as typeof actual.createReadStream,
      };
    });

    const { syncFromGitHub } = await loadService({ ORDERBOOK_RELEASES_DIR: dir });
    const { prepareMasterUpdate } = await import('../src/services/update.service.js');
    fakeClock();

    const preparing = prepareMasterUpdate();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await within(hashStarted)).not.toBe('pending');

    body.push(PAYLOAD);
    body.end();
    expect(await within(syncFromGitHub('master', masterDir, null, 'win32'))).toMatchObject({
      version: '91.0.0',
    });

    letHashFinish();
    expect(await within(preparing)).toMatchObject({ manifest: { version: '90.0.0' } });

    const left = await readdir(masterDir);
    expect(left).toContain(newer.file);
    expect(left).toContain(here.file); // being verified, then pinned: the operator's next step
  });
});

/**
 * A Master build in the folder, and a newer one GitHub is part-way through
 * sending: the shape in which a sync outlives the request that started it.
 *
 * Versions far above the running build's, so the one here is an update
 * whatever `package.json` says.
 */
async function aBuildHereAndANewerOneDownloading() {
  const masterDir = path.join(dir, 'master-panel');
  await mkdir(masterDir, { recursive: true });

  const here = signed({
    version: '90.0.0',
    file: 'OrderBook-Master-90.0.0-Setup.exe',
    platform: 'win32',
  });
  await writeFile(path.join(masterDir, here.file), PAYLOAD);
  for (const name of ['latest-win32.json', 'latest.json']) {
    await writeFile(path.join(masterDir, name), JSON.stringify(here));
  }

  const newer = signed({
    version: '91.0.0',
    file: 'OrderBook-Master-91.0.0-Setup.exe',
    platform: 'win32',
  });
  const body = openBody();
  serve({
    [API]: () => json(listing(newer)),
    [MANIFEST_URL]: () => json(newer),
    [SETUP_URL]: body.response,
  });

  return { masterDir, here, newer, body };
}

describe('1.4: Check now and the download bar (R6, R7a)', () => {
  const etagged = (manifest: ReleaseManifest, etag: string) =>
    new Response(JSON.stringify(listing(manifest)), {
      status: 200,
      headers: { 'content-type': 'text/json', etag },
    });
  const apiCalls = () => requested.filter((url) => url === API).length;

  it('R6: one answer from GitHub is shared, so a poll and a roomful of Offices cost one API call', async () => {
    const manifest = signed();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');
    await syncFromGitHub('master', dir, null, 'win32');
    await syncFromGitHub('office', dir, null, 'win32');

    expect(apiCalls()).toBe(1);
  });

  it('R6: a repeat after the cache window is a conditional request, and a 304 is reused', async () => {
    const manifest = signed();
    let conditional: string | null = null;
    let calls = 0;
    serve({
      [API]: (init) => {
        calls += 1;
        if (calls === 1) return etagged(manifest, '"v1"');
        conditional = new Headers(init?.headers).get('if-none-match');
        return new Response(null, { status: 304 });
      },
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: () => stream(PAYLOAD),
    });

    const { syncFromGitHub, forgetLatestRelease } = await loadService();
    await syncFromGitHub('master', dir, null, 'win32');

    // Check now forgets the answer but keeps its etag, so GitHub can say "unchanged".
    forgetLatestRelease();
    const again = await syncFromGitHub('master', dir, null, 'win32');

    expect(calls).toBe(2);
    expect(again?.version).toBe('2.0.0');
    expect(conditional).toBe('"v1"');
  });

  it('R7a: the download reports bytes, the total and the end', async () => {
    const manifest = signed();
    const body = openBody();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: body.response,
    });

    const { syncFromGitHub, downloadProgress } = await loadService();
    expect(downloadProgress('master', 'win32').phase).toBe('idle');

    const landing = syncFromGitHub('master', dir, null, 'win32');
    await vi.waitFor(() => expect(downloadProgress('master', 'win32').phase).toBe('downloading'));
    expect(downloadProgress('master', 'win32')).toMatchObject({
      version: '2.0.0',
      totalBytes: PAYLOAD.length,
      receivedBytes: 0,
    });

    body.push(PAYLOAD.subarray(0, 10));
    await vi.waitFor(() => expect(downloadProgress('master', 'win32').receivedBytes).toBe(10));
    expect(downloadProgress('master', 'win32').percent).toBeGreaterThan(0);

    body.push(PAYLOAD.subarray(10));
    body.end();
    await landing;
    expect(downloadProgress('master', 'win32')).toMatchObject({
      phase: 'done',
      receivedBytes: PAYLOAD.length,
      percent: 100,
    });
  });

  it('R7a: a download that dies is reported as failed, with the reason', async () => {
    const manifest = signed();
    const body = openBody();
    serve({
      [API]: () => json(listing(manifest)),
      [MANIFEST_URL]: () => json(manifest),
      [SETUP_URL]: body.response,
    });

    const { syncFromGitHub, downloadProgress } = await loadService();
    const landing = syncFromGitHub('master', dir, null, 'win32');
    await vi.waitFor(() => expect(downloadProgress('master', 'win32').phase).toBe('downloading'));
    // Fewer bytes than the manifest promised, then the stream ends.
    body.push(PAYLOAD.subarray(0, 5));
    body.end();

    expect(await landing).toBeNull();
    expect(downloadProgress('master', 'win32')).toMatchObject({ phase: 'failed' });
    expect(downloadProgress('master', 'win32').error).toBeTruthy();
  });
});

describe('the Office setup a Master carries, and GitHub', () => {
  afterEach(() => {
    delete process.env.ORDERBOOK_RELEASES_DIR;
  });

  /** A carried Office build where `tools/release.mjs` puts it: manifest and setup file. */
  async function carry(bundle: string, version: string): Promise<ReleaseManifest> {
    const build = officeBuild('win32', version);
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'latest-win32.json'), JSON.stringify(build));
    await writeFile(path.join(bundle, build.file), PAYLOAD);
    return build;
  }

  it('UPD-73: a sync never writes an older release over a newer build in the folder', async () => {
    // A Master installed from a local build carries an Office newer than
    // GitHub's newest release. The sync wrote GitHub's manifest over it, swept
    // it as superseded, and the next boot copied 85 MB back in to lose again.
    const officeDir = path.join(dir, 'office-panel');
    const carried = await carry(officeDir, '3.0.0');
    await writeFile(path.join(officeDir, 'latest.json'), JSON.stringify(carried));
    const github = officeBuild('win32', '2.0.0');
    serve(publishedTogether(github));

    const { syncFromGitHub } = await loadService();
    expect(await syncFromGitHub('office', officeDir, null, 'win32')).toBeNull();
    expect(requested).not.toContain(`${DOWNLOADS}/${github.file}`);
    expect((await readdir(officeDir)).sort()).toEqual(
      [carried.file, 'latest-win32.json', 'latest.json'].sort(),
    );

    // Only an offer the panels would be given holds it back: a newer manifest
    // whose setup file is gone names nothing, and GitHub's release fills it.
    await rm(path.join(officeDir, carried.file));
    expect(await syncFromGitHub('office', officeDir, null, 'win32')).toMatchObject({
      version: '2.0.0',
    });
  });

  it('UPD-74: the seed waits for a sync already writing the folder, and keeps its newer build after', async () => {
    // The seed runs at boot, just as the Offices reconnect and ask — each ask
    // can start a sync, and a sync clears this OS's `.part` files before it
    // downloads, the seed's copy among them.
    const github = officeBuild('win32', '2.0.0');
    const body = openBody();
    serve({ ...publishedTogether(github), [`${DOWNLOADS}/${github.file}`]: body.response });
    const bundle = path.join(dir, 'bundle');
    const carried = await carry(bundle, '3.0.0');

    const { syncFromGitHub } = await loadService({ ORDERBOOK_RELEASES_DIR: dir });
    const { readManifest, seedBundledOfficeRelease } =
      await import('../src/services/update.service.js');
    const officeDir = path.join(dir, 'office-panel');

    const syncing = syncFromGitHub('office', officeDir, null, 'win32');
    await vi.waitFor(() => expect(requested).toContain(`${DOWNLOADS}/${github.file}`), {
      timeout: 5_000,
    });

    const seeding = seedBundledOfficeRelease(bundle);
    await settle(200);
    const meanwhile = await readdir(officeDir);
    expect(meanwhile).not.toContain(carried.file); // the seed has not started
    expect(meanwhile).not.toContain(`${carried.file}.part`);

    body.push(PAYLOAD);
    body.end();
    expect(await syncing).toMatchObject({ version: '2.0.0' });
    await seeding;
    expect((await readManifest('office', 'win32'))?.version).toBe('3.0.0');
    expect((await readdir(officeDir)).sort()).toEqual(
      [carried.file, 'latest-win32.json', 'latest.json'].sort(),
    );

    // And the next sync leaves it: GitHub's newest is older than what it carried.
    serve(publishedTogether(github));
    expect(await syncFromGitHub('office', officeDir, null, 'win32')).toBeNull();
    expect((await readManifest('office', 'win32'))?.version).toBe('3.0.0');
  });

  it('UPD-75: a sync asked for while the seed writes the folder shares it, and asks GitHub nothing', async () => {
    serve(publishedTogether(officeBuild('win32')));
    const { aloneInFolder, syncFromGitHub } = await loadService();
    const seeded = officeBuild('win32', '3.0.0');

    let finish!: () => void;
    const seeding = aloneInFolder(
      'office',
      'win32',
      () => new Promise<ReleaseManifest>((resolve) => (finish = () => resolve(seeded))),
    );
    const asked = syncFromGitHub('office', dir, null, 'win32');
    finish();

    expect(await asked).toBe(seeded);
    expect(await seeding).toBe(seeded);
    expect(requested).toEqual([]);
  });
});
