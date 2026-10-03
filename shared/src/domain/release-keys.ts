/**
 * The public keys a build will accept a release from.
 *
 * Public halves only — there is nothing secret in this file, which is the
 * point: it is compiled into every panel so that trust travels with the
 * software rather than with whatever server happened to answer.
 *
 * **Rewritten by `tools/make-release-key.mjs`.** The private half is generated
 * once, on the release machine, and never leaves it. If you are reading this
 * because a release will not install, the question is which `keyId` signed it
 * and whether that id is below.
 *
 * More than one key is allowed on purpose. Rotation without a flag day needs an
 * overlap: publish the new key in a release signed by the old one, wait for the
 * fleet to take it, then start signing with the new. A key that has to be
 * retired in a hurry is dropped from this list in the next build — which is
 * exactly as fast as the fleet updates, and is the reason a compromised key is
 * a bad day rather than a catastrophe.
 */

/** Base64 DER SPKI, as `crypto.createPublicKey` reads it. */
export interface TrustedReleaseKey {
  keyId: string;
  publicKey: string;
  /** When this key started signing, for a human reading the list later. */
  addedAt: string;
}

export const TRUSTED_RELEASE_KEYS: readonly TrustedReleaseKey[] = [
  // Populated by `npm run release:keygen`. Empty until somebody has generated
  // one — see `allowUnsignedReleases` for what a panel does in the meantime.
  {
    keyId: 'release-2026-10-01',
    publicKey: 'MCowBQYDK2VwAyEACC8l4564Y0QIQM+pjQnDPqErh2YZXRxtsd7AbAQeE98=',
    addedAt: '2026-10-01',
  },
];

/**
 * The public repository releases are published to and fetched from by default
 * (1.4): installers and manifests only, no source, so it downloads anonymously.
 * `ORDERBOOK_RELEASES_GITHUB_REPO` overrides it, and an empty value switches
 * fetching off.
 */
export const DEFAULT_RELEASES_REPO = 'BlazingFire/OrderBook-Releases';

/**
 * Which repository this machine fetches releases from, or `null` for none.
 *
 * Unset: the default. Set to a name: that one. Set to nothing: none, which is how
 * an air-gapped site keeps the folder as its only source. Under tests
 * (`NODE_ENV=test`) the default is off, so no suite reaches for the network.
 */
export function releasesRepo(env: Record<string, string | undefined>): string | null {
  const raw = env.ORDERBOOK_RELEASES_GITHUB_REPO;
  if (raw !== undefined) return raw.trim() || null;
  return env.NODE_ENV === 'test' ? null : DEFAULT_RELEASES_REPO;
}

export const trustedKeyById = (keyId: string): TrustedReleaseKey | undefined =>
  TRUSTED_RELEASE_KEYS.find((key) => key.keyId === keyId);

/**
 * Whether a panel will install a release nobody signed.
 *
 * Signing did not exist for the first year of this product: releases arrived on
 * a USB stick, into a folder an operator controlled, and a SHA-256 beside the
 * file was a fair answer to the only threat there was — a truncated copy.
 * Fetching builds over a network is a different question, and one a checksum
 * published beside its own file cannot answer.
 *
 * So the default is to require a signature, and the escape hatch is explicit,
 * per-machine, and named after what it actually does. A site still copying
 * builds in by hand sets it; nothing sets it for them.
 */
export const allowUnsignedReleases = (env: Record<string, string | undefined>): boolean =>
  env.ORDERBOOK_ALLOW_UNSIGNED_RELEASES === '1';
