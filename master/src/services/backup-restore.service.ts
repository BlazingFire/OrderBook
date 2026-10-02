/**
 * Master Panel restore (`docs/7-STORAGE-BACKUP-RESTORE.md` §5, §5.3, §7).
 *
 * The whole restore — truncate/delete, load, and verify the audit hash chain —
 * runs inside one Postgres transaction. If anything fails, Postgres rolls it
 * back and the live schema is exactly as it was before the attempt: the
 * "temp location, verify completely, then swap in" guarantee (§5.3),
 * implemented as a transaction rollback rather than a filesystem copy-then-
 * swap, since what is being restored is a database, not files. See
 * `repositories/backup.repository.ts` for why this is safe without a
 * hand-derived foreign-key insert order.
 */

import bcrypt from 'bcryptjs';

import type { BackupManifest, BackupRestorePreview } from '@orderbook/shared';

import { db } from '../db/knex.js';
import { systemActor, type ActorContext } from '../domain/actor.js';
import { assertImportableFormatVersion, summarizeManifest } from '../domain/backup.js';
import { BackupError } from '../lib/errors.js';
import { recordDetachedActivity } from '../repositories/activity-log.repository.js';
import { decryptBackup, readManifest, verifyContentHash, BackupFileError } from '../lib/backup-crypto.js';
import {
  listUserTables,
  loadTables,
  regeneratePairingPasswordHash,
  revokeAllOfficePanels,
  tenantScopedTables,
  verifyActivityLogChain,
} from '../repositories/backup.repository.js';
import { clearVault } from '../repositories/password-vault.repository.js';
import { invalidateRoleCache } from '../repositories/role.repository.js';
import { invalidateSettingsCache } from './settings.service.js';
import { ensureServerMasterRole } from './server-master.service.js';
import { generateReadableSecret, isSetupComplete } from './setup.service.js';

const BCRYPT_ROUNDS = 10;

export function previewRestore(file: Buffer): BackupRestorePreview {
  const parsed = readManifest(file);
  try {
    verifyContentHash(parsed);
  } catch {
    throw new BackupError('corrupt_file', 'error.validation.backupCorruptFile');
  }
  assertImportableFormatVersion(parsed.manifest);

  return { manifest: parsed.manifest, summaryLines: summarizeManifest(parsed.manifest) };
}

export interface RestoreOutcome {
  manifest: BackupManifest;
  /** Shown once, like the first-run credentials — the old value is never carried over (§4.1). */
  newPairingPassword: string;
}

export async function restoreBackup(
  file: Buffer,
  passphrase: string,
  confirmWipe: boolean,
  actor?: ActorContext,
): Promise<RestoreOutcome> {
  const parsed = readManifest(file);
  assertImportableFormatVersion(parsed.manifest);

  if (await isSetupComplete()) {
    if (!confirmWipe) {
      throw new BackupError('populated_data_directory', 'error.conflict.dataDirectoryPopulated');
    }
  }

  let payloadBuffer: Buffer;
  try {
    payloadBuffer = await decryptBackup(parsed, passphrase);
  } catch (error) {
    if (error instanceof BackupFileError) {
      throw new BackupError(
        error.reason === 'wrong_passphrase' ? 'wrong_passphrase' : 'corrupt_file',
        error.reason === 'wrong_passphrase' ? 'error.validation.backupWrongPassphrase' : 'error.validation.backupCorruptFile',
      );
    }
    throw error;
  }

  const { gunzipSync } = await import('node:zlib');
  let parsedPayload: { tables: Record<string, Record<string, unknown>[]> };
  try {
    parsedPayload = JSON.parse(gunzipSync(payloadBuffer).toString('utf8'));
  } catch {
    throw new BackupError('corrupt_file', 'error.validation.backupCorruptFile');
  }

  const tenantIds =
    parsed.manifest.scope === 'selected' && Array.isArray(parsed.manifest.scopeDetail)
      ? parsed.manifest.scopeDetail
      : null;

  const newPairingPassword = generateReadableSecret();
  const newPairingHash = await bcrypt.hash(newPairingPassword, BCRYPT_ROUNDS);

  await db().transaction(async (trx) => {
    const tables = await listUserTables(trx);
    const scoped = await tenantScopedTables(trx);

    await loadTables(trx, tables, scoped, parsedPayload.tables, tenantIds);

    // The password vault is excluded from the export, so `loadTables` never
    // sees its table and therefore never truncates it either. Clearing it here
    // is not tidiness: a restore reinstates a different set of `users` rows,
    // and a surviving vault entry would be a sealed password keyed to an id
    // that may now mean somebody else entirely. (The table is named in exactly
    // three files, none of them this one — `password-vault-invariants.test.ts`.)
    await clearVault(trx, tenantIds);

    if (tables.includes('office_panels')) await revokeAllOfficePanels(trx);
    if (tables.includes('master_config')) await regeneratePairingPasswordHash(trx, newPairingHash);

    const chainTenantIds = tenantIds ?? (await trx('tenants').select<{ id: string }[]>('id')).map((row) => row.id);
    const chainOk = await verifyActivityLogChain(trx, chainTenantIds);
    if (!chainOk) {
      throw new BackupError('hash_chain_invalid', 'error.internal.backupHashChainInvalid');
    }

    // A backup from before 1.3 has no Server Master role. The migration that
    // seeds it has already run on this database, so nothing else puts it back.
    for (const tenantId of chainTenantIds) await ensureServerMasterRole(tenantId, trx);
  });

  // In-memory caches survive the transaction that replaced the rows behind
  // them. `settings` is the sharp one — a restore can land a database whose
  // password-vault switch is off while this process still believes it is on —
  // but the role cache has had the identical defect since it shipped, and a
  // stale role after a restore is a permission set nobody granted.
  invalidateSettingsCache();
  invalidateRoleCache();

  // Written after the commit, into the restored trail, one entry per company
  // the backup brought back. Detached: the restore has happened and cannot
  // be taken back because its entry failed. The person who ran it may not
  // exist in the restored users, so only their name is kept; a restore from
  // the first-run screen has nobody signed in and is logged as the Master PC.
  const restoredTenantIds =
    tenantIds ?? (await db()('tenants').select<{ id: string }[]>('id')).map((row) => row.id);
  for (const tenantId of restoredTenantIds) {
    await recordDetachedActivity(
      {
        tenantId,
        entityType: 'backup',
        entityId: parsed.manifest.createdAt,
        action: 'restored',
        actorType: 'system',
        actorId: null,
        details: {
          scope: parsed.manifest.scope,
          createdAt: parsed.manifest.createdAt,
          appVersion: parsed.manifest.appVersion,
        },
      },
      { ...systemActor(tenantId), actorName: actor?.actorName ?? 'Master PC' },
      db(),
    );
  }

  return { manifest: parsed.manifest, newPairingPassword };
}
