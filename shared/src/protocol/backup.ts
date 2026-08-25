/**
 * The storage export/import file format (`docs`/`7-STORAGE-BACKUP-RESTORE.md` §4),
 * shared by Master and Office so there is exactly one manifest shape and one
 * importer contract for whole exports, selected exports, and migrations alike.
 *
 * Adaptation note: the source spec assumes a TLS/Ed25519 pinned-fingerprint
 * pairing model and a Cloudflare tunnel token that this codebase does not have
 * — OrderBook pairs Office Panels over plain HTTP with a device id + shared
 * secret (`shared/src/protocol/pairing.ts`). Every place the spec names an
 * Ed25519 key, a tunnel token, or a pinned fingerprint as a secret to exclude
 * from an export, this format instead excludes the actual per-installation
 * secrets that play that role here: `office_panels.secret_hash` and
 * `master_config.pairing_password_hash`. Re-pairing after a restore reuses the
 * existing manual pairing flow (`PAIRING_ENDPOINT`), not a new trust system.
 */

export const BACKUP_FORMAT_VERSION = 1;

export type BackupPanelType = 'master' | 'office';
export type BackupScope = 'whole' | 'selected';

/**
 * The unencrypted header every export file starts with, so a wrong-file
 * mistake is caught before a passphrase is even asked for (§4.2).
 */
export interface BackupManifest {
  formatVersion: number;
  sourcePanelType: BackupPanelType;
  sourcePanelId: string;
  scope: BackupScope;
  /** Tenant ids for a Master `selected` export; `'settings-only'` | `'full-replica'` for Office. */
  scopeDetail: string[] | 'settings-only' | 'full-replica';
  createdAt: string;
  appVersion: string;
  /** sha256 of the encrypted payload that follows the manifest, hex-encoded. */
  contentHash: string;
}

/** Minimum passphrase length (§4.3) — matches the existing Developer Panel export rule. */
export const BACKUP_PASSPHRASE_MIN_LENGTH = 10;

export interface BackupExportRequest {
  scope: BackupScope;
  /** Master only: tenant ids to include when `scope === 'selected'`. */
  tenantIds?: string[];
  /** Office only: whether a `selected` export is settings-only or the full replica. */
  officeScope?: 'settings-only' | 'full-replica';
  passphrase: string;
}

export interface BackupRestorePreview {
  manifest: BackupManifest;
  /** Human-readable summary lines for the confirmation screen (§5.1 step 3). */
  summaryLines: string[];
}

export interface BackupRestoreRequest {
  passphrase: string;
  /** Required when a populated data directory already exists (§5.3). */
  confirmWipe?: boolean;
}

export type BackupFailureReason =
  | 'wrong_passphrase'
  | 'corrupt_file'
  | 'populated_data_directory'
  | 'migration_too_new'
  | 'hash_chain_invalid';
