/**
 * The only SQL for `document_exports` — the ledger of every PDF this
 * installation has actually produced.
 *
 * Keyset on `id DESC`. `document_exports.id` is BIGSERIAL and the feed is
 * append-mostly, so an offset pager would shift under every new row while
 * somebody was reading page two. The id stays a **string** end to end:
 * `Number()` loses precision above 2^53.
 *
 * `insertExport` and `markSuperseded` both take a required
 * `TransactionContext`, because an export row, its `superseded_by` stamp and
 * the `activity_log` entry describing the render all have to commit together
 * or the history is a lie in one of three directions.
 */

import type { DocumentExport, DocumentSubjectKind, DocumentType } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { applyPartyScope } from './party-access.repository.js';
import { toIso, toRequiredNumber } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'document_exports';

type Runner = Knex | Knex.Transaction;
type Row = Record<string, unknown>;

function mapDocumentExport(row: Row): DocumentExport {
  return {
    // BIGSERIAL arrives from node-postgres as a string already; `String()` is
    // belt and braces, never `Number()`.
    id: String(row.id),
    tenantId: String(row.tenant_id),
    templateId: (row.template_id as string | null) ?? null,
    templateName: String(row.template_name),
    documentType: row.document_type as DocumentType,
    subjectKind: row.subject_type as DocumentSubjectKind,
    subjectId: String(row.subject_id),
    subjectLabel: (row.subject_label as string | null) ?? String(row.subject_id),
    fileName: String(row.file_name ?? `${String(row.storage_key)}.pdf`),
    byteSize: toRequiredNumber(row.byte_size),
    pageCount: toRequiredNumber(row.page_count),
    ratesIncluded: Boolean(row.rates_included),
    renderedBy: (row.rendered_by_user_id as string | null) ?? null,
    renderedByName: (row.rendered_by_name as string | null) ?? null,
    supersededBy: row.superseded_by === null || row.superseded_by === undefined
      ? null
      : String(row.superseded_by),
    createdAt: toIso(row.created_at) ?? '',
  };
}

/**
 * The display columns the ledger does not itself store. `template_name` is
 * denormalised on the row (so history survives a rename), but the subject's
 * label and the renderer's display name are looked up here rather than frozen,
 * because a party renamed since the render should read by its current name.
 */
const SELECT_WITH_LABELS = `
  e.*,
  u.display_name AS rendered_by_name,
  CASE e.subject_type
    WHEN 'lead'  THEN (SELECT p.name FROM leads  l JOIN parties p ON p.id = l.party_id WHERE l.id = e.subject_id)
    WHEN 'order' THEN (SELECT p.name FROM orders o JOIN parties p ON p.id = o.party_id WHERE o.id = e.subject_id)
  END AS subject_label,
  (e.storage_key || '.pdf') AS file_name
`;

export interface ExportListQuery {
  scope: PartyScope;
  subjectKind?: DocumentSubjectKind;
  subjectId?: string;
  /** Exclusive upper bound — the feed reads newest-first. */
  beforeId?: string;
  /**
   * Which subject kinds the caller may see. Rows of any other kind are
   * filtered OUT of the page rather than refusing the whole request, so a
   * dispatch clerk holding `orders.view` but not `leads.view` gets a coherent
   * list of order documents instead of a 403 — the `search.service.ts` rule.
   */
  permittedKinds: DocumentSubjectKind[];
  limit: number;
}

export async function listExports(
  tenantId: string,
  query: ExportListQuery,
  runner: Runner = db(),
): Promise<DocumentExport[]> {
  // No permitted kinds means no rows are visible; short-circuit rather than
  // sending `IN ()` to Postgres.
  if (query.permittedKinds.length === 0) return [];

  const builder = runner(`${TABLE} as e`)
    .leftJoin('users as u', 'u.id', 'e.rendered_by_user_id')
    .where('e.tenant_id', tenantId)
    .whereNull('e.deleted_at')
    .whereIn('e.subject_type', query.permittedKinds);

  if (query.subjectKind) builder.andWhere('e.subject_type', query.subjectKind);
  if (query.subjectId) builder.andWhere('e.subject_id', query.subjectId);
  if (query.beforeId) builder.andWhere('e.id', '<', query.beforeId);

  // A rendered document carries the subject's contents, so its ledger row is as
  // private as the lead or order it was rendered from.
  applyExportPartyScope(builder, tenantId, query.scope);

  const rows = await builder
    .orderBy('e.id', 'desc')
    .limit(query.limit)
    .select<Row[]>(runner.raw(SELECT_WITH_LABELS));

  return rows.map(mapDocumentExport);
}

export async function findExportById(
  tenantId: string,
  id: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<DocumentExport | null> {
  const builder = runner(`${TABLE} as e`)
    .leftJoin('users as u', 'u.id', 'e.rendered_by_user_id')
    .where('e.tenant_id', tenantId)
    .andWhere('e.id', id)
    .whereNull('e.deleted_at');

  applyExportPartyScope(builder, tenantId, scope);

  const row = await builder.first<Row>(runner.raw(SELECT_WITH_LABELS));
  return row ? mapDocumentExport(row) : null;
}

/**
 * `document_exports` names its subject as `(subject_type, subject_id)`, so the
 * lead or order has to be joined in a subquery before the party scope has a
 * column to test.
 */
function applyExportPartyScope(
  builder: Knex.QueryBuilder,
  tenantId: string,
  scope: PartyScope,
): void {
  if (scope.seesAll) return;

  builder.where((outer) => {
    for (const [kind, table] of [
      ['lead', 'leads'],
      ['order', 'orders'],
    ] as const) {
      outer.orWhere((branch) => {
        branch.where('e.subject_type', kind).whereExists((sub) => {
          const parent = sub
            .select(db().raw('1'))
            .from(`${table} as scoped_subject`)
            .where('scoped_subject.tenant_id', tenantId)
            .whereRaw('scoped_subject.id = e.subject_id');

          return applyPartyScope(parent, tenantId, 'scoped_subject.party_id', scope, {
            level: 'view',
          });
        });
      });
    }
  });
}

/**
 * The stored path and key, for the authenticated download route.
 *
 * Scoped like every other read of this table: the bytes on the other end are a
 * rendering of the lead or order, so a download is the same disclosure as
 * opening the record — and this is the path that hands over the actual file.
 */
export async function findExportFile(
  tenantId: string,
  id: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<{ storageKey: string; storagePath: string; subjectKind: DocumentSubjectKind } | null> {
  const builder = runner(`${TABLE} as e`).where({ 'e.tenant_id': tenantId, 'e.id': id }).whereNull('e.deleted_at');

  applyExportPartyScope(builder, tenantId, scope);

  const row = await builder.first<{ storage_key: string; storage_path: string; subject_type: string }>(
    'e.storage_key as storage_key',
    'e.storage_path as storage_path',
    'e.subject_type as subject_type',
  );

  if (!row) return null;
  return {
    storageKey: row.storage_key,
    storagePath: row.storage_path,
    subjectKind: row.subject_type as DocumentSubjectKind,
  };
}

export interface NewExport {
  tenantId: string;
  subjectKind: DocumentSubjectKind;
  subjectId: string;
  documentType: DocumentType;
  templateId: string | null;
  templateName: string;
  storageKey: string;
  storagePath: string;
  byteSize: number;
  sha256: string;
  pageCount: number;
  ratesIncluded: boolean;
  locale: string | null;
  renderedByUserId: string | null;
  renderedByPanelId: string | null;
}

export async function insertExport(record: NewExport, trx: TransactionContext): Promise<string> {
  const [row] = await trx(TABLE)
    .insert({
      tenant_id: record.tenantId,
      subject_type: record.subjectKind,
      subject_id: record.subjectId,
      document_type: record.documentType,
      template_id: record.templateId,
      template_name: record.templateName,
      storage_key: record.storageKey,
      storage_path: record.storagePath,
      byte_size: record.byteSize,
      sha256: record.sha256,
      page_count: record.pageCount,
      rates_included: record.ratesIncluded,
      locale: record.locale,
      rendered_by_user_id: record.renderedByUserId,
      rendered_by_panel_id: record.renderedByPanelId,
    })
    .returning<Array<{ id: string }>>('id');

  return String(row!.id);
}

/**
 * Stamps whatever was previously current for this (subject, document type) as
 * superseded by the new row, in the same transaction that inserted it.
 *
 * A column nothing writes is the same defect as a permission nothing enforces:
 * it reads as working history right up until somebody asks which quotation is
 * the current one.
 */
export async function markSuperseded(
  tenantId: string,
  subject: { kind: DocumentSubjectKind; id: string; documentType: DocumentType },
  newExportId: string,
  trx: TransactionContext,
): Promise<number> {
  const affected = await trx(TABLE)
    .where({
      tenant_id: tenantId,
      subject_type: subject.kind,
      subject_id: subject.id,
      document_type: subject.documentType,
    })
    .whereNull('superseded_by')
    .whereNull('deleted_at')
    .andWhereNot({ id: newExportId })
    .update({ superseded_by: newExportId });

  return affected;
}

