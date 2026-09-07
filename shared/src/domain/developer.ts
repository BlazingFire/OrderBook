/**
 * Developer mode — the one door to the two actions no ordinary role may take:
 * erasing an installation back to first run, and seeding throwaway accounts.
 *
 * It is gated by a **developer password**, not by a permission, because the
 * person who needs it is usually not a user of the company at all (support,
 * or the owner testing a fresh install) and may not be able to sign in as one.
 * The built-in password is hashed below in the same `scrypt$…` form both
 * panels already verify (`master/src/lib/password.ts`, `office/src/lib/password.ts`);
 * `ORDERBOOK_DEVELOPER_PASSWORD` in a `.env` overrides it for a deployment that
 * wants its own. The plaintext of the built-in one lives in
 * `docs/DEVELOPER_MODE.md` and nowhere in code.
 *
 * An unlock is a short-lived token held in the server's memory, sent back as a
 * header on every developer call. It expires on its own; it never touches disk.
 */

import type { RoleTier } from './permissions.js';

export const DEVELOPER_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DEVELOPER_TOKEN_HEADER = 'x-developer-token';

/** Wrong passwords tolerated before the caller has to wait. */
export const DEVELOPER_UNLOCK_MAX_FAILURES = 5;
export const DEVELOPER_UNLOCK_LOCKOUT_MS = 60_000;

/** `scrypt$N$r$p$salt$hash` of the built-in developer password. */
export const DEVELOPER_PASSWORD_HASH =
  'scrypt$16384$8$1$iAx7QDU8ngvPKb3Mw9wRsA==$IJtGfqpZlbtez9aYBpUwykdd9gWKRQlaip33aPk7SyGcrNkLTDFEVOtxkKnFAVh001h0lhYZZGSNV5BnfOqLeQ==';

/** The word a person types to confirm an erase. Not translated: it is a key, not a sentence. */
export const DEVELOPER_RESET_CONFIRMATION = 'RESET';

export interface DeveloperUnlock {
  token: string;
  /** ISO timestamp after which the token is refused. */
  expiresAt: string;
}

export interface DeveloperStatus {
  unlocked: boolean;
  expiresAt: string | null;
  /** Whether a `.env` overrides the built-in password. Never the password itself. */
  passwordOverridden: boolean;
}

/**
 * The throwaway accounts `seedDummyUsers` creates — one per tier, with fixed,
 * documented passwords. Test data, deliberately in the open: they exist so a
 * fresh install can be exercised without reading a generated secret off a
 * screen, and `docs/DEVELOPER_MODE.md` lists them.
 */
export interface DummyUserSpec {
  username: string;
  password: string;
  displayName: string;
  tier: RoleTier;
}

export const DUMMY_USERS: readonly DummyUserSpec[] = [
  { username: 'admin', password: 'Admin@1234', displayName: 'Admin (test)', tier: 'admin' },
  {
    username: 'management',
    password: 'Manage@1234',
    displayName: 'Management (test)',
    tier: 'management',
  },
  { username: 'office', password: 'Office@1234', displayName: 'Office (test)', tier: 'office' },
];

export interface DummyUserCredential extends DummyUserSpec {
  /** `created` when the row is new, `reset` when an existing user's password was overwritten. */
  outcome: 'created' | 'reset';
}

export interface SeedDummyUsersResult {
  users: DummyUserCredential[];
  /** Set only when the seed had to run first-time setup itself. Shown once. */
  pairingPassword: string | null;
  companyName: string | null;
}

export interface ResetAllResult {
  ok: true;
  /** What the panel is now: the Master returns to first-run, the Office to unpaired. */
  state: 'first-run' | 'unpaired';
}
