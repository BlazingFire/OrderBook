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
  | 'hash_chain_invalid'
  // The plain-zip archive (version 2, below).
  | 'notAnArchive'
  | 'entryRejected'
  | 'newerThanApp'
  | 'insufficientSpace'
  | 'fat32TooLarge';

// --- Backup all: the plain-zip archive, version 2 ---------------------------
//
// A different thing from the encrypted `.obbackup` above, which stays as it
// is. The archive is one ordinary zip written to a folder the owner picks
// (usually a USB drive) and restored on a new Master PC at first run
// (`docs/7-STORAGE-BACKUP-RESTORE.md`). Its contents:
//
//   manifest.json          what follows, with a sha256 for every file
//   README.txt             what the file is, for whoever finds the drive
//   data/<table>.ndjson    one JSON row per line, every table but the excluded ones
//   uploads/**             product photos and avatars, byte for byte

export const ARCHIVE_FORMAT_VERSION = 2;

/** One `data/<table>.ndjson` entry. `bytes` is its uncompressed size. */
export interface ArchiveTableEntry {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

/** One `uploads/**` entry. `path` is the whole entry name, `uploads/` included. */
export interface ArchiveUploadEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArchiveManifest {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  /** The company name, for the preview and the file name. */
  company: string;
  masterUniqueId: string;
  /** Knex migration names in the order they ran: the schema level the rows belong to. */
  appliedMigrations: string[];
  tables: ArchiveTableEntry[];
  uploads: ArchiveUploadEntry[];
  /**
   * Sealed values carried in the rows that cannot be opened on another PC,
   * because the key that seals them (`secrets/vault.key`) never leaves this
   * one. The restore lists them as "enter again".
   */
  sealed?: { secretSettings: number; connectorCredentials: number };
}

/** What an archive holds, read from its manifest before anything is restored. */
export interface ArchivePreview {
  fileName: string;
  company: string;
  createdAt: string;
  appVersion: string;
  masterUniqueId: string;
  /** Row counts of the tables a person recognises. */
  counts: { parties: number; products: number; users: number; leads: number; orders: number };
  photos: number;
  /** Every entry, uncompressed. */
  totalBytes: number;
  /** Sealed values that must be entered again on this PC (see `ArchiveManifest.sealed`). */
  sealed: { secretSettings: number; connectorCredentials: number };
}

export type BackupJobKind = 'backup' | 'restore';

export type BackupJobPhase =
  | 'preparing'
  | 'data'
  | 'photos'
  | 'verifying'
  | 'checking'
  | 'database'
  | 'upgrading'
  | 'finishing'
  | 'done'
  | 'failed';

/** The one backup or restore running on the Master, polled by the screen showing it. */
export interface BackupJobStatus {
  id: string;
  kind: BackupJobKind;
  phase: BackupJobPhase;
  /** Progress within the phase, in whatever unit `total` uses (rows, bytes). */
  done: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  /** Why it failed, as a message key and its params. Only when `phase` is `failed`. */
  message?: { messageKey: string; params?: Record<string, string | number> };
  /** The finished archive's file name and full path, after a backup. */
  fileName?: string;
  path?: string;
}

/**
 * Daily automatic backup, kept per PC in `<dataDir>/auto-backup.json` because
 * the folder names a drive on this machine.
 */
export interface AutoBackupConfig {
  enabled: boolean;
  folder: string;
  /** Local time of day, `HH:MM`, 24-hour. */
  time: string;
  /** How many of this company's automatic archives to keep in the folder. */
  keepLast: number;
}

export const DEFAULT_AUTO_BACKUP_CONFIG: AutoBackupConfig = {
  enabled: false,
  folder: '',
  time: '21:00',
  keepLast: 7,
};

/** The automatic backup's settings, plus how its last run went, for Settings. */
export interface AutoBackupStatus extends AutoBackupConfig {
  /** The last scheduled attempt: done, skipped (drive missing) or failed. */
  lastRun: {
    at: string;
    ok: boolean;
    fileName?: string;
    /** Why it did not run or failed. */
    message?: { messageKey: string; params?: Record<string, string | number> };
  } | null;
  /** Whether the folder can be reached right now (the drive is plugged in). */
  folderReachable: boolean;
}

/** One archive found in a folder, for the list under "Back up everything". */
export interface ArchiveListEntry {
  fileName: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}
