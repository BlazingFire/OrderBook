/**
 * Does this release manifest carry a signature one of our keys made?
 *
 * Ed25519 through `node:crypto`, so no dependency: Node has had it since 12 and
 * this is one `verify` call over bytes `shared` computes. The bytes are
 * computed there precisely so the release script, the Master and an Office
 * panel cannot disagree about what was signed.
 *
 * Duplicated in `office/src/lib/` rather than shared, for the same reason
 * `electron/lib/installer.ts` duplicates `isInside`: these are separate
 * packages that cannot import each other's source, and `shared` is bundled into
 * two browsers where `node:crypto` does not exist. What must not drift is the
 * payload, and that is the half that *is* shared.
 */

import { createPublicKey, verify } from 'node:crypto';

import type { ReleaseManifest } from '@orderbook/shared';
import {
  allowUnsignedReleases,
  canonicalManifestPayload,
  isManifestSigned,
  trustedKeyById,
} from '@orderbook/shared';

import { createLogger } from './logger.js';

const log = createLogger('releases');

export type SignatureVerdict =
  | { ok: true; reason: 'signed' | 'unsignedAllowed' }
  | { ok: false; reason: 'unsigned' | 'unknownKey' | 'badSignature' };

/**
 * @param manifest the manifest exactly as it arrived — never re-serialised.
 *
 * Re-serialising is how a relay breaks a signature it is only meant to pass
 * along: a manifest rebuilt field by field is a different object, and any field
 * the rebuilder does not know about is dropped.
 */
export function verifyManifest(manifest: ReleaseManifest): SignatureVerdict {
  if (!isManifestSigned(manifest)) {
    // Absent is not "fine": it is the shape an attacker produces by deleting
    // two keys from a JSON document. Only an explicit local setting excuses it.
    return allowUnsignedReleases(process.env)
      ? { ok: true, reason: 'unsignedAllowed' }
      : { ok: false, reason: 'unsigned' };
  }

  const trusted = trustedKeyById(manifest.keyId);
  if (!trusted) {
    log.warn(`Refusing ${manifest.version}: signed by unknown key ${manifest.keyId}`);
    return { ok: false, reason: 'unknownKey' };
  }

  const key = createPublicKey({
    key: Buffer.from(trusted.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const good = verify(
    null,
    Buffer.from(canonicalManifestPayload(manifest), 'utf8'),
    key,
    Buffer.from(manifest.signature, 'base64'),
  );

  if (!good) {
    log.error(`Refusing ${manifest.version}: signature does not verify against ${manifest.keyId}`);
    return { ok: false, reason: 'badSignature' };
  }

  return { ok: true, reason: 'signed' };
}
