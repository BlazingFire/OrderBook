/**
 * What a release manifest's signature actually covers.
 *
 * The setup file already carries a SHA-256, and that has been enough while
 * releases arrived on a USB stick: the hash catches a truncated copy, and the
 * folder is operator territory. Fetching builds from the internet changes the
 * threat. A hash that travels next to the file it describes proves only that
 * the two agree — whoever can replace the file can replace the hash.
 *
 * So the manifest is signed with a key that lives on the release machine and
 * nowhere else, and the public half is compiled into the app. An attacker who
 * takes the GitHub account can serve any bytes they like; they cannot make this
 * app run them. That is worth more here than a code-signing certificate, and
 * unlike a certificate it costs nothing.
 *
 * **This module is deliberately browser-safe.** It computes the bytes to sign
 * and nothing else — no `node:crypto`, because `shared` is bundled into both
 * web apps. Signing and verifying live on the panels, which are Node. What has
 * to be identical on all three sides is *which bytes*, and that lives here so
 * it cannot drift.
 */

import type { ReleaseManifest } from './version.js';

/**
 * The fields the signature covers, in the order they are serialised.
 *
 * A fixed list rather than "the whole object", for two reasons that both bite
 * later: a future unsigned field (a download count, a mirror URL) must not
 * invalidate every signature ever issued, and `JSON.stringify` over an object
 * literal preserves insertion order — so two callers building the same manifest
 * in a different order would produce different bytes and a signature that
 * verifies on one machine and not the other.
 *
 * `panel` is in here and that is not incidental. Without it, a signed Master
 * manifest could be served to an Office panel as its own, and every office PC
 * in the shop would install the Master build. `platform` is in here for the
 * identical reason: a Windows manifest relabelled for a Mac sends every Mac in
 * the shop an installer it cannot open.
 */
export const SIGNED_MANIFEST_FIELDS = [
  'panel',
  'platform',
  'version',
  'file',
  'sizeBytes',
  'sha256',
  'releasedAt',
] as const;

export type SignedManifestField = (typeof SIGNED_MANIFEST_FIELDS)[number];

/**
 * The exact string a signature is made over.
 *
 * Deterministic by construction: a fixed field order, no whitespace, and every
 * value narrowed to a primitive. `sha256` is lowercased because a manifest
 * written by hand with uppercase hex describes the same file and must not
 * produce a different signature.
 */
export function canonicalManifestPayload(
  manifest: Pick<ReleaseManifest, SignedManifestField>,
): string {
  const parts = SIGNED_MANIFEST_FIELDS.map((field) => {
    const value = manifest[field];

    const normalised =
      field === 'sha256' && typeof value === 'string' ? value.toLowerCase() : value;

    return `${field}=${String(normalised)}`;
  });

  // Newline-separated rather than JSON: there is no nesting to represent, and a
  // line-oriented payload is one somebody can eyeball against a manifest when
  // they are trying to work out why a signature will not verify at 6pm.
  return parts.join('\n');
}

/**
 * Everything a manifest needs to be checkable, beyond the fields it already had.
 *
 * Both are optional on the type because the local-folder source predates them:
 * a site that copies builds in on a USB stick has no signing machine and its
 * manifests are unsigned, which stays legal. What is *not* legal is an unsigned
 * manifest arriving over the internet — that is a policy decision the panels
 * make, not a shape the type can express.
 */
export interface ManifestSignature {
  /** Base64 Ed25519 signature over `canonicalManifestPayload`. */
  signature: string;
  /**
   * Which public key made it.
   *
   * Present so a key can be rotated without every older build refusing every
   * newer release: an app can hold more than one trusted key and pick by id,
   * and a key that has to be retired can be dropped from the next build's list
   * rather than from history.
   */
  keyId: string;
}

export const isManifestSigned = (
  manifest: Partial<ReleaseManifest>,
): manifest is ReleaseManifest & ManifestSignature =>
  typeof manifest.signature === 'string' &&
  manifest.signature.length > 0 &&
  typeof manifest.keyId === 'string' &&
  manifest.keyId.length > 0;
