/**
 * The master key: the owner's secret for the Server Master tier.
 *
 * It is checked on the Master PC only, and it gates the operations that could
 * otherwise lock the owner out: changing a Server Master's username or
 * password, moving a user onto or off the Server Master role, deactivating or
 * deleting a Server Master, recovering a forgotten Server Master password, and
 * changing the pairing password.
 *
 * Stored as an scrypt hash in the same `scrypt$N$r$p$salt$hash` form as
 * `DEVELOPER_PASSWORD_HASH` (`./developer.ts`). The plaintext lives only in
 * `docs/MASTER_KEY.md`. There is no `.env` override.
 *
 * A correct key buys a short-lived token held in the Master's memory, sent back
 * in the `x-master-key-token` header. Wrong keys lock the gate for a minute
 * after `DEVELOPER_UNLOCK_MAX_FAILURES` tries, the same rule as developer mode.
 */

/** `scrypt$N$r$p$salt$hash` of the owner's master key. */
export const MASTER_KEY_HASH =
  'scrypt$16384$8$1$ddrQzXPhI6RuFay69tvSbA==$yrv5O+6e41It4BtwtusZxNN0rIYDjlYnju+TFSxVPIzdYoIymgTARp25V4kMP2PC89Zyqayd4hh5Weuxh5BVIQ==';

export const MASTER_KEY_TOKEN_HEADER = 'x-master-key-token';

/** Long enough to finish one dialog, short enough that a walked-away PC is safe. */
export const MASTER_KEY_TOKEN_TTL_MS = 5 * 60 * 1000;

/** At least this many active Server Masters must always remain. */
export const SERVER_MASTER_MIN_ACTIVE = 2;

/** Prefilled in the setup forms; the owner may type anything else. */
export const SUGGESTED_SERVER_MASTER_USERNAMES = ['master', 'master-backup'] as const;

export interface MasterKeyUnlock {
  token: string;
  /** ISO timestamp after which the token is refused. */
  expiresAt: string;
}

/** One Server Master account as the owner types it. */
export interface ServerMasterAccountInput {
  username: string;
  displayName: string;
  password: string;
}

/** A Server Master as the master-key screens list it. Never carries a password. */
export interface ServerMasterAccount {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
}
