/**
 * Pure rules for the storage export/import format (`docs/7-STORAGE-BACKUP-RESTORE.md`
 * §4, §7). No I/O — the encryption, the database, and the filesystem all live
 * in `lib/backup-crypto.ts`, `repositories/backup.repository.ts` and
 * `services/backup-*.service.ts`.
 */

import { BACKUP_FORMAT_VERSION, BACKUP_PASSPHRASE_MIN_LENGTH, type BackupManifest } from '@orderbook/shared';

import { BackupError, ValidationError } from '../lib/errors.js';

/**
 * A newer export than this build knows how to read is refused with the exact
 * reason (§7 "Exported on newer app version, restored on older"). An *older*
 * export is always accepted — the payload is table rows keyed by the table's
 * current name, read into whatever schema this build's own migrations have
 * already produced, the same as a fresh install ever would.
 */
export function assertImportableFormatVersion(manifest: BackupManifest): void {
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError('migration_too_new', 'error.validation.backupFormatTooNew', {
      fileAppVersion: manifest.appVersion,
    });
  }
}

export function assertPassphraseStrong(passphrase: string): void {
  if (passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new ValidationError('validation.backup.passphraseTooShort', { min: BACKUP_PASSPHRASE_MIN_LENGTH });
  }
}

/**
 * Human-readable lines for the restore confirmation screen (§5.1 step 3) —
 * shown from the unencrypted manifest, before a passphrase is even asked for.
 */
export function summarizeManifest(manifest: BackupManifest): string[] {
  const lines: string[] = [];
  lines.push(manifest.sourcePanelType === 'master' ? 'Master Panel export' : 'Office Panel export');
  lines.push(`Scope: ${manifest.scope === 'whole' ? 'whole data' : describeScopeDetail(manifest)}`);
  lines.push(`Created: ${manifest.createdAt}`);
  lines.push(`Exported by app version: ${manifest.appVersion}`);
  return lines;
}

function describeScopeDetail(manifest: BackupManifest): string {
  if (Array.isArray(manifest.scopeDetail)) return `${manifest.scopeDetail.length} compan(y/ies)`;
  return manifest.scopeDetail === 'settings-only' ? 'local settings only' : 'full device replica';
}
