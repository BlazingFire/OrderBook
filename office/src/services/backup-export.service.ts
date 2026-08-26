/**
 * Office Panel export (`docs/7-STORAGE-BACKUP-RESTORE.md` §2.2, §2.3, §4).
 *
 * This panel owns no database — its entire "replica" is the handful of local
 * JSON files under `config.dataDir` (`config/index.ts`'s file list). The
 * export is simply those files' parsed contents, keyed by the same name a
 * restore writes them back under.
 *
 * `pairing.json` (`credentials.store.ts`) is deliberately excluded — its
 * `panelSecret` is this device's actual credential-store secret (the role
 * §4.1's Ed25519 key / tunnel token play in the source spec's assumed
 * architecture; this codebase pairs with a shared secret instead, see
 * `shared/src/protocol/backup.ts`'s header note). Restoring never carries a
 * live secret — the device re-pairs and gets a fresh one (§6.2).
 *
 * `device.json` (the device code + offline-id counter) is exactly the
 * `device_identity` §4.1 asks for and does travel — it is what makes a
 * restored Office Panel the *same device* for sync purposes (§6.3).
 */

import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

import { BACKUP_FORMAT_VERSION, type BackupExportRequest, type BackupManifest } from '@orderbook/shared';

import { config } from '../config/index.js';
import { appVersion } from '../lib/app-version.js';
import { assertPassphraseStrong } from '../domain/backup.js';
import { deviceCode } from '../sync/device.js';
import { encryptBackup } from '../lib/backup-crypto.js';

/** Relative name -> absolute path, for every file a replica export can carry. Never `credentialsFile`. */
const REPLICA_FILES: Record<string, string> = {
  'device.json': config.deviceFile,
  'clock.json': config.clockFile,
  'outbox.json': config.outboxFile,
  'snapshot.json': config.snapshotFile,
  'users.json': config.usersFile,
  'sign-in-attempts.json': config.signInAttemptsFile,
};

/** `local_settings` (§2.3): the person-facing state, not the sync machinery. */
const SETTINGS_ONLY_FILES = ['users.json', 'sign-in-attempts.json'];

export interface ExportResult {
  fileName: string;
  data: Buffer;
}

export async function exportBackup(request: BackupExportRequest): Promise<ExportResult> {
  assertPassphraseStrong(request.passphrase);

  const officeScope = request.officeScope ?? 'full-replica';
  const names = officeScope === 'settings-only' ? SETTINGS_ONLY_FILES : Object.keys(REPLICA_FILES);

  const files: Record<string, unknown> = {};
  for (const name of names) {
    const filePath = REPLICA_FILES[name];
    if (!filePath) continue;
    files[name] = await readJsonIfPresent(filePath);
  }

  const payload = gzipSync(Buffer.from(JSON.stringify({ files }), 'utf8'));

  const manifestWithoutHash: Omit<BackupManifest, 'contentHash'> = {
    formatVersion: BACKUP_FORMAT_VERSION,
    sourcePanelType: 'office',
    sourcePanelId: await deviceCode(),
    scope: request.scope,
    scopeDetail: officeScope,
    createdAt: new Date().toISOString(),
    appVersion: appVersion(),
  };

  const data = await encryptBackup(manifestWithoutHash, payload, request.passphrase);
  const fileName = `orderbook-office-${officeScope}-${manifestWithoutHash.createdAt.replace(/[:.]/g, '-')}.obbackup`;

  return { fileName, data };
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

