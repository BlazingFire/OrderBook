/**
 * The sealed-password table.
 *
 * One of exactly three files under `master/src` allowed to name
 * `user_password_vault` — this one, the migration that creates it, and
 * `backup.repository.ts`, which excludes it from every export.
 * `password-vault-invariants.test.ts` fails if a fourth appears, because the
 * table's containment is the whole reason the feature is shippable.
 *
 * `credential_fingerprint` is `credentialFingerprint(password_hash)` from
 * `panel-credential.repository.ts` — **reused, never reimplemented**, and read
 * through that module's `fingerprintForUser()` so no second query in this
 * codebase selects `password_hash`. `credential-invariants.test.ts` asserts
 * that count stays at one.
 */

import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { SealedValue } from '../lib/secret-box.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;

const TABLE = 'user_password_vault';

export interface VaultRow {
  userId: string;
  sealed: SealedValue;
  credentialFingerprint: string;
  keyVersion: number;
  updatedAt: Date;
}

interface RawRow {
  user_id: string;
  sealed: SealedValue;
  credential_fingerprint: string;
  key_version: number;
  updated_at: Date;
}

export async function upsertVaultEntry(
  tenantId: string,
  userId: string,
  sealed: SealedValue,
  fingerprint: string,
  keyVersion: number,
  actorId: string | null,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      sealed: JSON.stringify(sealed),
      credential_fingerprint: fingerprint,
      key_version: keyVersion,
      updated_at: new Date(),
      updated_by: actorId,
    })
    .onConflict(['tenant_id', 'user_id'])
    .merge(['sealed', 'credential_fingerprint', 'key_version', 'updated_at', 'updated_by']);
}

export async function readVaultEntry(
  tenantId: string,
  userId: string,
  runner: Runner = db(),
): Promise<VaultRow | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, user_id: userId })
    .first<RawRow | undefined>(
      'user_id',
      'sealed',
      'credential_fingerprint',
      'key_version',
      'updated_at',
    );

  if (!row) return null;

  return {
    userId: row.user_id,
    sealed: row.sealed,
    credentialFingerprint: row.credential_fingerprint,
    keyVersion: row.key_version,
    updatedAt: row.updated_at,
  };
}

/**
 * Empty the vault, for one tenant or for all of them.
 *
 * `tenantIds` is a list rather than a single id because a restore can be
 * scoped to selected tenants; `null` means every row, which is what switching
 * the feature off has to mean.
 */
export async function clearVault(
  trx: TransactionContext,
  tenantIds: string[] | null,
): Promise<number> {
  const query = trx(TABLE);
  if (tenantIds) query.whereIn('tenant_id', tenantIds);
  return query.delete();
}

/**
 * How many live users have a sealed password, out of how many there are.
 *
 * `total` comes from `userRepo.countUsers`, which excludes soft-deleted rows,
 * so coverage can actually reach 100% rather than asymptotically approaching a
 * count that includes people who left.
 */
export async function countVaultEntries(
  tenantId: string,
  runner: Runner = db(),
): Promise<number> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .count<{ count: string }>({ count: '*' })
    .first();

  return Number(row?.count ?? 0);
}
