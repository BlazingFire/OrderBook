/**
 * Whether a release was signed by somebody we trust.
 *
 * The SHA-256 beside a setup file answers "did this arrive intact". It cannot
 * answer "did this come from us", because whoever can replace the file can
 * replace the digest printed next to it. That was a fair trade while releases
 * arrived on a USB stick into a folder an operator controlled. It stops being
 * one the moment a build is fetched over a network.
 *
 * Pure: real Ed25519 through `node:crypto`, no cluster, no network. The trusted
 * key list is compiled into the app, so these tests stub that module — which is
 * also the only way to prove the *refusals*, since a real build trusts no key
 * that a test could sign with.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Shared from '@orderbook/shared';
import type { ReleaseManifest } from '@orderbook/shared';
import { canonicalManifestPayload } from '@orderbook/shared';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const PUBLIC_DER = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** A second, untrusted signer — an attacker with a key of their own. */
const stranger = generateKeyPairSync('ed25519');

function unsigned(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    panel: 'master',
    version: '1.2.0',
    file: 'OrderBook-Master-1.2.0-Setup.exe',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    releasedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  } as ReleaseManifest;
}

function signWith(key: typeof privateKey, manifest: ReleaseManifest, keyId = 'test-key') {
  return {
    ...manifest,
    keyId,
    signature: sign(null, Buffer.from(canonicalManifestPayload(manifest), 'utf8'), key).toString(
      'base64',
    ),
  };
}

async function loadVerifier(keys: Array<{ keyId: string; publicKey: string; addedAt: string }>) {
  vi.resetModules();

  vi.doMock('@orderbook/shared', async () => {
    const actual = await vi.importActual<typeof Shared>('@orderbook/shared');
    return {
      ...actual,
      TRUSTED_RELEASE_KEYS: keys,
      trustedKeyById: (id: string) => keys.find((key) => key.keyId === id),
    };
  });

  return import('../src/lib/release-signature.js');
}

const TRUSTED = [{ keyId: 'test-key', publicKey: PUBLIC_DER, addedAt: '2026-08-30' }];

beforeEach(() => {
  delete process.env.ORDERBOOK_ALLOW_UNSIGNED_RELEASES;
});

afterEach(() => {
  delete process.env.ORDERBOOK_ALLOW_UNSIGNED_RELEASES;
  vi.doUnmock('@orderbook/shared');
});

describe('verifying a release manifest', () => {
  it('UPD-20: accepts a manifest signed by a trusted key', async () => {
    const { verifyManifest } = await loadVerifier(TRUSTED);

    expect(verifyManifest(signWith(privateKey, unsigned()))).toEqual({
      ok: true,
      reason: 'signed',
    });
  });

  it('UPD-21: refuses an unsigned manifest by default', async () => {
    // The shape an attacker produces by deleting two keys from a JSON document.
    // Absent must never read as fine.
    const { verifyManifest } = await loadVerifier(TRUSTED);

    expect(verifyManifest(unsigned())).toEqual({ ok: false, reason: 'unsigned' });
  });

  it('UPD-22: accepts an unsigned manifest only when a machine says so explicitly', async () => {
    // The air-gapped site that still copies builds in by hand. Per-machine,
    // opt-in, and named after what it does.
    process.env.ORDERBOOK_ALLOW_UNSIGNED_RELEASES = '1';
    const { verifyManifest } = await loadVerifier(TRUSTED);

    expect(verifyManifest(unsigned())).toEqual({ ok: true, reason: 'unsignedAllowed' });
  });

  it('UPD-23: refuses a manifest signed by a key this build does not carry', async () => {
    const { verifyManifest } = await loadVerifier(TRUSTED);

    expect(verifyManifest(signWith(stranger.privateKey, unsigned()))).toEqual({
      ok: false,
      reason: 'badSignature',
    });
  });

  it('UPD-23: refuses a signature naming a key id that is not in the list', async () => {
    const { verifyManifest } = await loadVerifier(TRUSTED);

    expect(verifyManifest(signWith(privateKey, unsigned(), 'retired-key'))).toEqual({
      ok: false,
      reason: 'unknownKey',
    });
  });

  it('UPD-24: refuses a manifest whose signed fields were altered after signing', async () => {
    const { verifyManifest } = await loadVerifier(TRUSTED);
    const signed = signWith(privateKey, unsigned());

    // Every field the signature covers, changed one at a time. The digest is
    // the one that matters most — swapping it is how a valid signature would
    // be made to vouch for different bytes.
    for (const tamper of [
      { sha256: 'b'.repeat(64) },
      { version: '9.9.9' },
      { file: 'evil.exe' },
      { sizeBytes: 999 },
      { releasedAt: '2030-01-01T00:00:00.000Z' },
    ]) {
      expect(
        verifyManifest({ ...signed, ...tamper } as ReleaseManifest),
        JSON.stringify(tamper),
      ).toEqual({ ok: false, reason: 'badSignature' });
    }
  });

  it('UPD-25: refuses a Master release relabelled as an office one', async () => {
    // `panel` is in the signed payload for exactly this: without it, a signed
    // Master manifest dropped into the office folder would be served to every
    // office PC in the shop, and every one of them would install the Master.
    const { verifyManifest } = await loadVerifier(TRUSTED);
    const signed = signWith(privateKey, unsigned({ panel: 'master' }));

    expect(verifyManifest({ ...signed, panel: 'office' } as ReleaseManifest)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
  });

  it('UPD-26: a build carrying no trusted keys accepts nothing signed', async () => {
    // The state this repo ships in until somebody generates a key. It must fail
    // closed: no keys means no releases, not "no checking".
    const { verifyManifest } = await loadVerifier([]);

    expect(verifyManifest(signWith(privateKey, unsigned()))).toEqual({
      ok: false,
      reason: 'unknownKey',
    });
  });
});
