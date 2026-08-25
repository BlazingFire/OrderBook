/**
 * Pure rules for the storage export/import format, mirroring
 * `master/src/domain/backup.ts` (see that file's header for the format
 * itself). Office Panel has no `domain/` layer elsewhere in this package —
 * its architecture is thinner by design (`http/app.ts`'s header) — but this
 * one small piece of shared logic is worth keeping alongside its Master
 * counterpart rather than inlined into the service, since the two must agree
 * on what a valid export looks like.
 */

import { BACKUP_FORMAT_VERSION, BACKUP_PASSPHRASE_MIN_LENGTH, type BackupManifest } from '@orderbook/shared';

export class BackupValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assertImportableFormatVersion(manifest: BackupManifest): void {
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupValidationError(
      'backup_migration_too_new',
      `This backup was created by a newer version of OrderBook (app ${manifest.appVersion}) than this installation can import. Update this installation first.`,
    );
  }
}

export function assertPassphraseStrong(passphrase: string): void {
  if (passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new BackupValidationError(
      'validation_error',
      `The export passphrase must be at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters long`,
    );
  }
}

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
