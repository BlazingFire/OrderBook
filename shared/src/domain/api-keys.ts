/**
 * A key that lets another program on the shop LAN act as one of this
 * company's users.
 *
 * **The token itself is not on this type, and never will be.** `ApiKey`
 * declares neither `token` nor `tokenHash`, so the Master's mapper has nothing
 * to leak: the plaintext exists for exactly one response, at issue, and the
 * digest never leaves the database. That is the same shape the panel pairing
 * secret already has, and `credential-invariants.test.ts` reads this file to
 * hold it.
 *
 * `tokenPrefix` is safe to show and is what makes the key recognisable in a
 * list — it is the indexed lookup handle, not a secret, exactly as
 * `credentialFingerprint` is for an office panel.
 *
 * **A key never exceeds its owner.** Its permissions are the owner's role
 * intersected with the key's own scopes, and its party scope *is* the owner's,
 * read through `resolvePartyScope` like anyone else's. There is deliberately no
 * per-key party pinning: that would be a second grant surface to maintain
 * beside `party_access`, and it would have to be honoured in four places
 * — miss the one in `levelForParty` and a "pinned" key edits any party nobody
 * has claimed. A narrow key is made by owning it from a narrow user.
 */

import type { IsoTimestamp, Uuid } from './entities.js';

export interface ApiKey {
  id: Uuid;
  label: string;
  /** Shown in full. The lookup handle, not a secret. */
  tokenPrefix: string;
  ownerUserId: Uuid;
  ownerName: string | null;
  /** The subset of the owner's permissions this key may use. */
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
  lastUsedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

export interface ApiKeyInput {
  label: string;
  ownerUserId: Uuid;
  scopes: string[];
  /** Absent means the shipped default; the server clamps the range. */
  rateLimitPerMin?: number;
  /** Absent means it never expires, which is a choice the issuer makes. */
  expiresAt?: IsoTimestamp | null;
}

/** The wire prefix, so a leaked token is recognisable in a log or a paste. */
export const API_KEY_TOKEN_PREFIX = 'obk';

export const API_KEY_RATE_LIMIT_DEFAULT = 120;
export const API_KEY_RATE_LIMIT_MIN = 1;
export const API_KEY_RATE_LIMIT_MAX = 6000;

/** What `whoami` answers, so a caller can see what its key actually holds. */
export interface ApiKeyIdentity {
  keyId: Uuid;
  label: string;
  ownerUserId: Uuid;
  ownerName: string | null;
  permissions: string[];
  rateLimitPerMin: number;
  expiresAt: IsoTimestamp | null;
}
