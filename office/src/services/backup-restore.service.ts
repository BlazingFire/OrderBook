/**
 * Office Panel restore (`docs/7-STORAGE-BACKUP-RESTORE.md` §5.2, §5.3, §6.3).
 *
 * "Populated" for this panel means paired — `credentials.store.ts` holds a
 * `panelId`. A never-paired device always has a `device.json` (created on
 * first read, `sync/device.ts`), so pairing state is the meaningful signal,
 * not file existence.
 *
 * Every in-memory cache this restore's files back is reset after the write so
 * the running process serves the restored state immediately — a stale cache
 * here is the same bug class `HANDOFF.md` already warns about for panel
 * actors: the file on disk changed, but nothing told the object holding a
 * copy of the old one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { BackupManifest, BackupRestorePreview } from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { assertImportableFormatVersion, summarizeManifest } from '../domain/backup.js';
import { decryptBackup, readManifest, verifyContentHash, BackupFileError } from '../lib/backup-crypto.js';
import { clearCredentials, loadCredentials } from './credentials.store.js';
import { resetDeviceCache } from '../sync/device.js';
import { resetClockCache } from '../sync/clock.js';
import { resetOutboxCache } from '../sync/outbox.store.js';
import { resetLocalStore } from '../sync/local-store.js';
import { resetUserStore } from './user-store.js';
import { resetSignInAttempts } from './sign-in-attempts.store.js';

/** Read through `paths()` on each restore — the data folder can move at runtime. */
function filePaths(): Record<string, string> {
  const current = paths();
  return {
    'device.json': current.deviceFile,
    'clock.json': current.clockFile,
    'outbox.json': current.outboxFile,
    'refusals.json': current.refusalsFile,
    'snapshot.json': current.snapshotFile,
    'users.json': current.usersFile,
    'sign-in-attempts.json': current.signInAttemptsFile,
  };
}

export class RestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Both panels write the same container, the same manifest and the same
 * `formatVersion`; `sourcePanelType` is the only thing separating them, and
 * their payloads share nothing — a Master export carries `tables`, this one
 * carries `files`. A Master file therefore passes every other check and would
 * be discovered only once the write loop reached for a key that is not there.
 */
function assertOfficeExport(manifest: BackupManifest): void {
  if (manifest.sourcePanelType !== 'office') {
    throw new RestoreError(
      'backup_wrong_panel_type',
      'This is a Master Panel export. It can only be restored onto a Master Panel.',
    );
  }
}

export function previewRestore(file: Buffer): BackupRestorePreview {
  const parsed = readManifest(file);
  try {
    verifyContentHash(parsed);
  } catch {
    throw new RestoreError('backup_corrupt_file', 'This backup file is corrupt or incomplete');
  }
  assertImportableFormatVersion(parsed.manifest);
  assertOfficeExport(parsed.manifest);

  return { manifest: parsed.manifest, summaryLines: summarizeManifest(parsed.manifest) };
}

export interface RestoreOutcome {
  manifest: BackupManifest;
}

export async function restoreBackup(file: Buffer, passphrase: string, confirmWipe: boolean): Promise<RestoreOutcome> {
  const parsed = readManifest(file);
  assertImportableFormatVersion(parsed.manifest);
  assertOfficeExport(parsed.manifest);

  const alreadyPaired = (await loadCredentials()) !== null;
  if (alreadyPaired && !confirmWipe) {
    throw new RestoreError('backup_populated_data_directory', 'This panel is already paired. Confirm you want to wipe it before restoring.');
  }

  let payloadBuffer: Buffer;
  try {
    payloadBuffer = await decryptBackup(parsed, passphrase);
  } catch (error) {
    if (error instanceof BackupFileError) {
      throw new RestoreError(
        `backup_${error.reason}`,
        error.reason === 'wrong_passphrase' ? 'Incorrect passphrase' : 'This backup file is corrupt or incomplete',
      );
    }
    throw error;
  }

  const { gunzipSync } = await import('node:zlib');
  let payload: { files: Record<string, unknown> };
  try {
    payload = JSON.parse(gunzipSync(payloadBuffer).toString('utf8'));
  } catch {
    throw new RestoreError('backup_corrupt_file', 'This backup file is corrupt or incomplete');
  }

  for (const [name, filePath] of Object.entries(filePaths())) {
    const value = payload.files[name];
    if (value === undefined || value === null) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  // Pairing credentials never travel in an export (§4.1 adapted) and are never
  // written by a restore either — a restored panel comes up unpaired and goes
  // through the normal pairing screen next (§5.2 step 4), same as this
  // device's real secret is never carried by any export in the first place.
  // Dropped last, and through the store rather than the file, so a restore
  // that fails part way leaves a panel that is still paired instead of one
  // holding a `panelId` in memory that no longer exists on disk.
  await clearCredentials();

  resetDeviceCache();
  resetClockCache();
  resetOutboxCache();
  resetLocalStore();
  resetUserStore();
  resetSignInAttempts();

  return { manifest: parsed.manifest };
}
