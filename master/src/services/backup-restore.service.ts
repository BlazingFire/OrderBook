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
import { assertImportableFormatVersion, summarizeManifest } from '../domain/backup.js';
import { BackupError } from '../lib/errors.js';
import { decryptBackup, readManifest, verifyContentHash, BackupFileError } from '../lib/backup-crypto.js';
import {
  listUserTables,
  loadTables,
  regeneratePairingPasswordHash,
  revokeAllOfficePanels,
  tenantScopedTables,
  verifyActivityLogChain,
} from '../repositories/backup.repository.js';
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

export async function restoreBackup(file: Buffer, passphrase: string, confirmWipe: boolean): Promise<RestoreOutcome> {
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

    if (tables.includes('office_panels')) await revokeAllOfficePanels(trx);
    if (tables.includes('master_config')) await regeneratePairingPasswordHash(trx, newPairingHash);

    const chainTenantIds = tenantIds ?? (await trx('tenants').select<{ id: string }[]>('id')).map((row) => row.id);
    const chainOk = await verifyActivityLogChain(trx, chainTenantIds);
    if (!chainOk) {
      throw new BackupError('hash_chain_invalid', 'error.internal.backupHashChainInvalid');
    }
  });

  return { manifest: parsed.manifest, newPairingPassword };
}
