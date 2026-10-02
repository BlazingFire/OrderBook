/**
 * Revalidating the people an Office Panel can sign in offline
 * (docs/ROLES_AND_USERS.md §15.2).
 *
 * A panel mints its own password verifier the first time somebody signs in on it
 * online, so they can sign in again with the Master switched off. That verifier
 * has no expiry and no way of knowing the world moved on — so something has to
 * tell it, and this is what the Master answers with.
 *
 * Two ways a verifier goes stale, and both must be caught:
 *
 *  - the person was deactivated, deleted, or lost their role;
 *  - their password was reset, which leaves the panel holding a verifier for a
 *    password the company has already replaced. That is the sharper one: the
 *    whole point of a reset is that the old password stops working, and an
 *    offline panel that never heard about it is a way around that.
 *
 * The second is detected with a **fingerprint**, not the hash. See below.
 */

import { createHash } from 'node:crypto';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';

type Runner = Knex | Knex.Transaction;

const TABLE = 'users';

/**
 * A short, stable marker that changes when the stored password does.
 *
 * Deliberately a digest *of the digest*. The panel needs to answer one question
 * — "is this still the password I minted my verifier from?" — and equality of an
 * opaque token answers it. Sending the hash itself would put every signed-in
 * person's scrypt hash on every panel's disk, which §8.1 exists to prevent, and
 * would buy nothing: the panel already holds its own verifier for that password.
 *
 * Truncated because this is a change marker, not a MAC; the full digest would
 * imply a security property it is not providing.
 */
function credentialFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

export async function fingerprintForUser(
  tenantId: string,
  userId: string,
  runner: Runner = db(),
): Promise<string | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, id: userId })
    .whereNull('deleted_at')
    .first<{ password_hash: string } | undefined>('password_hash');

  return row ? credentialFingerprint(row.password_hash) : null;
}

export interface OfflineCredentialClaim {
  userId: string;
  credentialFingerprint: string;
}

/**
 * Which of the panel's stored verifiers are no longer valid.
 *
 * Answered from the database, never from the in-memory session map, so a
 * revocation that landed while the panel was switched off is still reported.
 * Anything the Master cannot positively confirm is returned for forgetting —
 * failing closed here costs the person one online sign-in, while failing open
 * leaves a door the company believes it has already shut.
 */
export async function findRevokedOfflineCredentials(
  tenantId: string,
  claims: readonly OfflineCredentialClaim[],
  runner: Runner = db(),
): Promise<string[]> {
  if (claims.length === 0) return [];

  const rows = await runner(`${TABLE} as u`)
    .leftJoin('roles as r', function join() {
      this.on('r.id', '=', 'u.role_id').andOn('r.tenant_id', '=', 'u.tenant_id');
    })
    .where('u.tenant_id', tenantId)
    .whereIn(
      'u.id',
      claims.map((claim) => claim.userId),
    )
    .select<
      Array<{
        id: string;
        password_hash: string;
        is_active: boolean;
        deleted_at: Date | null;
        role_deleted_at: Date | null;
        role_id: string | null;
        role_tier: string | null;
      }>
    >(
      'u.id',
      'u.password_hash',
      'u.is_active',
      'u.deleted_at',
      'u.role_id',
      'r.deleted_at as role_deleted_at',
      'r.tier as role_tier',
    );

  const live = new Map(rows.map((row) => [row.id, row]));

  return claims
    .filter((claim) => {
      const row = live.get(claim.userId);

      // Unknown to this Master at all — a deleted row, or a panel carrying a
      // record from a company it is no longer paired with.
      if (!row) return true;

      if (row.deleted_at !== null || !row.is_active) return true;
      if (!row.role_id || row.role_deleted_at !== null) return true;

      // Now a Server Master, who never signs in on a panel, online or off.
      if (row.role_tier === 'server_master') return true;

      // The password moved on. The panel's verifier is for the old one.
      return credentialFingerprint(row.password_hash) !== claim.credentialFingerprint;
    })
    .map((claim) => claim.userId);
}
