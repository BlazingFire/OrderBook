/**
 * Master Panel export (`docs/7-STORAGE-BACKUP-RESTORE.md` §2.2, §2.3, §4).
 *
 * The payload is table rows, not a filesystem or `pg_dump` copy — this
 * installation has no `psql` and talks to Postgres only through the `pg`
 * driver (`HANDOFF.md` decision 3), so an export reads every table through the
 * same driver the app already uses, generically, via `information_schema`
 * (`backup.repository.ts`).
 *
 * Deliberately **not** included yet, and named here rather than left silent:
 * uploaded image files (`config.uploadsDir`). Only their metadata rows travel.
 * Bundling the files too needs an archive format inside the encrypted
 * envelope, which is real, scoped work left for a follow-up pass — see
 * `HANDOFF.md`. Rolling debug logs and the two secrets §4.1 names — the
 * Cloudflare tunnel token (this installation has none) and any credential's
 * raw secret — are excluded; `office_panels.secret_hash` and
 * `master_config.pairing_password_hash` are the actual per-installation
 * secrets that play that role here, and restore replaces both rather than
 * carrying them (`backup-restore.service.ts`).
 */

import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BACKUP_FORMAT_VERSION, type BackupExportRequest, type BackupManifest } from '@orderbook/shared';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { assertPassphraseStrong } from '../domain/backup.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import { encryptBackup } from '../lib/backup-crypto.js';
import { dumpTable, listTenantIds, listUserTables, tenantScopedTables } from '../repositories/backup.repository.js';
import { getIdentity } from './setup.service.js';

const appVersion = readAppVersion();

export interface ExportResult {
  fileName: string;
  data: Buffer;
}

export async function exportBackup(request: BackupExportRequest): Promise<ExportResult> {
  assertPassphraseStrong(request.passphrase);

  const identity = await getIdentity();
  if (!identity) throw new ConflictError('error.conflict.notSetUp');

  const tenantIds =
    request.scope === 'selected' ? (request.tenantIds ?? []) : await listTenantIds();
  if (request.scope === 'selected' && tenantIds.length === 0) {
    throw new ValidationError('validation.backup.tenantsRequired');
  }

  const tables = await listUserTables();
  const scoped = await tenantScopedTables();

  const dump: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    dump[table] = await dumpTable(table, request.scope === 'selected' ? tenantIds : null, scoped.has(table), db());
  }

  const payload = gzipSync(Buffer.from(JSON.stringify({ tables: dump }), 'utf8'));

  // `scopeDetail` always names the tenants actually included — every tenant on
  // this Master for a `whole` export, just the chosen ones for `selected` — so
  // a restore preview can show "which companies" either way, off one field.
  const manifestWithoutHash: Omit<BackupManifest, 'contentHash'> = {
    formatVersion: BACKUP_FORMAT_VERSION,
    sourcePanelType: 'master',
    sourcePanelId: identity.masterUniqueId,
    scope: request.scope,
    scopeDetail: tenantIds,
    createdAt: new Date().toISOString(),
    appVersion,
  };

  const data = await encryptBackup(manifestWithoutHash, payload, request.passphrase);
  const fileName = `orderbook-master-${request.scope}-${manifestWithoutHash.createdAt.replace(/[:.]/g, '-')}.obbackup`;

  return { fileName, data };
}

function readAppVersion(): string {
  try {
    const raw = readFileSync(path.join(config.packageRoot, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
