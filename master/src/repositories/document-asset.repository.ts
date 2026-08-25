/**
 * The only SQL for `document_assets` — the logo and signature images a
 * template draws.
 *
 * **Metadata only.** The bytes live on disk under `config.documents.assetsDir`,
 * never in the database and never under `uploadsDir`: `/uploads` is
 * unauthenticated `express.static`, and a company's letterhead is not
 * something to hand to anybody who guesses a filename.
 *
 * `(tenant_id, sha256)` is unique, so uploading the same logo twice returns
 * the existing row rather than a second copy of the same bytes.
 */

import type { DocumentAsset, DocumentAssetKind } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { toIso, toRequiredNumber } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'document_assets';

type Runner = Knex | Knex.Transaction;
type Row = Record<string, unknown>;

function mapDocumentAsset(row: Row): DocumentAsset {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    kind: row.kind as DocumentAssetKind,
    filename: String(row.filename),
    mimeType: row.mime_type as 'image/png' | 'image/jpeg',
    byteSize: toRequiredNumber(row.byte_size),
    createdAt: toIso(row.created_at) ?? '',
  };
}

export async function listAssets(
  tenantId: string,
  kind?: DocumentAssetKind,
  runner: Runner = db(),
): Promise<DocumentAsset[]> {
  const builder = runner(TABLE).where({ tenant_id: tenantId });
  if (kind) builder.andWhere({ kind });

  const rows = await builder.orderBy('created_at', 'desc').select<Row[]>('*');
  return rows.map(mapDocumentAsset);
}

export async function findAssetById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<DocumentAsset | null> {
  const row = await runner(TABLE).where({ tenant_id: tenantId, id }).first<Row>('*');
  return row ? mapDocumentAsset(row) : null;
}

/** The stored path, for the authenticated file route and for the renderer. */
export async function findAssetPath(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<{ storagePath: string; mimeType: string; filename: string } | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .first<{ storage_path: string; mime_type: string; filename: string }>(
      'storage_path',
      'mime_type',
      'filename',
    );

  if (!row) return null;
  return { storagePath: row.storage_path, mimeType: row.mime_type, filename: row.filename };
}

/** An identical upload already on file, so the same bytes are never stored twice. */
export async function findAssetBySha(
  tenantId: string,
  sha256: string,
  runner: Runner = db(),
): Promise<DocumentAsset | null> {
  const row = await runner(TABLE).where({ tenant_id: tenantId, sha256 }).first<Row>('*');
  return row ? mapDocumentAsset(row) : null;
}

export interface NewAsset {
  id: string;
  tenantId: string;
  kind: DocumentAssetKind;
  filename: string;
  mimeType: 'image/png' | 'image/jpeg';
  byteSize: number;
  sha256: string;
  storagePath: string;
  uploadedBy: string | null;
}

export async function insertAsset(
  record: NewAsset,
  trx: TransactionContext,
): Promise<DocumentAsset> {
  const [row] = await trx(TABLE)
    .insert({
      id: record.id,
      tenant_id: record.tenantId,
      kind: record.kind,
      filename: record.filename,
      mime_type: record.mimeType,
      byte_size: record.byteSize,
      sha256: record.sha256,
      storage_path: record.storagePath,
      uploaded_by: record.uploadedBy,
    })
    .returning<Row[]>('*');

  return mapDocumentAsset(row!);
}

/**
 * A hard delete — there is no Recycle Bin branch for an asset.
 *
 * `document_templates.logo_asset_id`/`signature_asset_id` are `ON DELETE NO
 * ACTION` on purpose, so Postgres refuses this outright while any template
 * still points at the row. That refusal is the check; there is deliberately no
 * service-layer scan that could drift out of step with it.
 */
export async function deleteAsset(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<number> {
  return trx(TABLE).where({ tenant_id: tenantId, id }).delete();
}
