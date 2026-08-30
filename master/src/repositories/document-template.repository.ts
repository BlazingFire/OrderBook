/**
 * The only SQL for `document_templates`.
 *
 * Every read leads with `tenant_id`, so a query that forgets the filter
 * degrades into a visibly wrong full scan rather than a silent cross-company
 * leak. Every write takes a required `TransactionContext`, because a template
 * change and its `activity_log` entry must commit together.
 */

import type { DocumentTemplate, DocumentType, PageOrientation, PaperSize } from '@orderbook/shared';
import { normaliseLayout } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { toIso, toRequiredNumber } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'document_templates';

type Runner = Knex | Knex.Transaction;
type Row = Record<string, unknown>;

export function mapDocumentTemplate(row: Row): DocumentTemplate {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    documentType: row.document_type as DocumentType,
    paperSize: row.paper_size as PaperSize,
    orientation: row.orientation as PageOrientation,
    margins: {
      top: toRequiredNumber(row.margin_top_mm),
      right: toRequiredNumber(row.margin_right_mm),
      bottom: toRequiredNumber(row.margin_bottom_mm),
      left: toRequiredNumber(row.margin_left_mm),
    },
    showRates: Boolean(row.show_rates),
    showColourChips: Boolean(row.show_colour_chips),
    showTerms: Boolean(row.show_terms),
    showLogo: Boolean(row.show_logo),
    showSignature: Boolean(row.show_signature),
    showPageNumbers: Boolean(row.show_page_numbers),
    showWatermark: Boolean(row.show_watermark),
    showPartyBlock: Boolean(row.show_party_block),
    watermarkText: (row.watermark_text as string | null) ?? null,
    termsText: (row.terms_text as string | null) ?? null,
    footerText: (row.footer_text as string | null) ?? null,
    accentColour: (row.accent_colour as string | null) ?? null,
    locale: (row.locale as string | null) ?? null,
    // JSONB comes back parsed from `pg`. Narrowed to version 2 here and only
    // here: a row written before the page designer existed carries ordered
    // blocks, and converting at the boundary means nothing above this mapper
    // has to know that version 1 was ever a thing — including a row restored
    // from a backup taken before the change.
    layout: normaliseLayout(
      row.layout,
      {
        paperSize: (row.paper_size as PaperSize) ?? 'A4',
        orientation: (row.orientation as PageOrientation) ?? 'portrait',
        margins: {
          top: toRequiredNumber(row.margin_top_mm),
          right: toRequiredNumber(row.margin_right_mm),
          bottom: toRequiredNumber(row.margin_bottom_mm),
          left: toRequiredNumber(row.margin_left_mm),
        },
      },
      {
        hasLogo: Boolean(row.show_logo) && Boolean(row.logo_asset_id),
        hasSignature: Boolean(row.show_signature) && Boolean(row.signature_asset_id),
      },
    ),
    logoAssetId: (row.logo_asset_id as string | null) ?? null,
    signatureAssetId: (row.signature_asset_id as string | null) ?? null,
    isDefault: Boolean(row.is_default),
    version: toRequiredNumber(row.version),
    deletedAt: toIso(row.deleted_at),
    deletedBy: (row.deleted_by as string | null) ?? null,
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

export interface TemplateListQuery {
  documentType?: DocumentType;
  /** Exclusive lower bound on `(lower(name), id)` — the keyset position. */
  after?: { name: string; id: string };
  limit: number;
}

/**
 * Alphabetical, keyset-paged. Ascending on `(lower(name), id)` because that is
 * how somebody looks for a template — never newest-first, which is right for a
 * ledger and wrong for a list of named things.
 */
export async function listTemplates(
  tenantId: string,
  query: TemplateListQuery,
  runner: Runner = db(),
): Promise<DocumentTemplate[]> {
  const builder = runner(TABLE).where({ tenant_id: tenantId }).whereNull('deleted_at');

  if (query.documentType) builder.andWhere({ document_type: query.documentType });

  if (query.after) {
    builder.andWhereRaw('(lower(name), id) > (?, ?)', [query.after.name, query.after.id]);
  }

  const rows = await builder
    .orderByRaw('lower(name) ASC, id ASC')
    .limit(query.limit)
    .select<Row[]>('*');

  return rows.map(mapDocumentTemplate);
}

/** `includeDeleted` sits in the `findRoleById` position, so the two read the same way. */
export async function findTemplateById(
  tenantId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
  runner: Runner = db(),
): Promise<DocumentTemplate | null> {
  const builder = runner(TABLE).where({ tenant_id: tenantId, id });
  if (!options.includeDeleted) builder.whereNull('deleted_at');

  const row = await builder.first<Row>('*');
  return row ? mapDocumentTemplate(row) : null;
}

/** The render path's lookup: the tenant's default template for one document type. */
export async function defaultTemplateFor(
  tenantId: string,
  documentType: DocumentType,
  runner: Runner = db(),
): Promise<DocumentTemplate | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, document_type: documentType, is_default: true })
    .whereNull('deleted_at')
    .first<Row>('*');

  return row ? mapDocumentTemplate(row) : null;
}

/** Which template currently holds the default for a type, so the service can demote exactly it. */
export async function currentDefaultId(
  tenantId: string,
  documentType: DocumentType,
  runner: Runner = db(),
): Promise<string | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId, document_type: documentType, is_default: true })
    .whereNull('deleted_at')
    .first<{ id: string }>('id');

  return row?.id ?? null;
}

/**
 * Clear-then-set. `document_templates_one_default` is a **partial** unique
 * index, and a partial index has no constraint to defer — so unlike the Fields
 * sequence swap this cannot be done as one transiently-colliding statement.
 * Demoting first is the only order that never collides.
 */
export async function clearDefaultFor(
  tenantId: string,
  documentType: DocumentType,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, document_type: documentType, is_default: true })
    .whereNull('deleted_at')
    .update({ is_default: false });
}

/** True when a live template already holds this name — the 409 the contract specifies. */
export async function isNameTaken(
  tenantId: string,
  name: string,
  excludeId: string | null,
  runner: Runner = db(),
): Promise<boolean> {
  const builder = runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw('lower(name) = lower(?)', [name]);

  if (excludeId) builder.andWhereNot({ id: excludeId });

  const row = await builder.first<{ id: string }>('id');
  return row !== undefined;
}

/**
 * Takes a row lock before the caller compares versions, so the
 * check-then-act race that every older entity in this codebase still carries
 * cannot happen here. Fields established this pattern; the PDF Designer
 * follows it.
 */
export async function lockTemplate(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<DocumentTemplate | null> {
  const row = await trx(TABLE).where({ tenant_id: tenantId, id }).forUpdate().first<Row>('*');

  return row ? mapDocumentTemplate(row) : null;
}

export interface TemplateWriteColumns {
  name: string;
  document_type: DocumentType;
  paper_size: PaperSize;
  orientation: PageOrientation;
  margin_top_mm: number;
  margin_right_mm: number;
  margin_bottom_mm: number;
  margin_left_mm: number;
  show_rates: boolean;
  show_colour_chips: boolean;
  show_terms: boolean;
  show_logo: boolean;
  show_signature: boolean;
  show_page_numbers: boolean;
  show_watermark: boolean;
  show_party_block: boolean;
  watermark_text: string | null;
  terms_text: string | null;
  footer_text: string | null;
  accent_colour: string | null;
  locale: string | null;
  layout: string;
  logo_asset_id: string | null;
  signature_asset_id: string | null;
  is_default: boolean;
}

export async function insertTemplate(
  record: TemplateWriteColumns & { id: string; tenantId: string; createdBy: string | null },
  trx: TransactionContext,
): Promise<DocumentTemplate> {
  const { id, tenantId, createdBy, ...columns } = record;

  const [row] = await trx(TABLE)
    .insert({
      ...columns,
      id,
      tenant_id: tenantId,
      created_by: createdBy,
      updated_by: createdBy,
    })
    .returning<Row[]>('*');

  return mapDocumentTemplate(row!);
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  columns: Partial<TemplateWriteColumns>,
  updatedBy: string | null,
  trx: TransactionContext,
): Promise<DocumentTemplate | null> {
  const runner = trx;

  const [row] = await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update({
      ...columns,
      updated_by: updatedBy,
      // No BEFORE UPDATE trigger exists on this table — `updated_at` has a
      // DEFAULT but nothing maintains it, so the writer sets it explicitly.
      updated_at: runner.fn.now(),
      version: runner.raw('version + 1'),
    })
    .returning<Row[]>('*');

  return row ? mapDocumentTemplate(row) : null;
}

export async function softDeleteTemplate(
  tenantId: string,
  id: string,
  deletedBy: string | null,
  trx: TransactionContext,
): Promise<DocumentTemplate | null> {
  const runner = trx;

  const [row] = await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update({
      deleted_at: runner.fn.now(),
      deleted_by: deletedBy,
      // A deleted template must not keep holding the default slot, or the
      // partial unique index blocks the next promotion for its type.
      is_default: false,
      updated_at: runner.fn.now(),
      version: runner.raw('version + 1'),
    })
    .returning<Row[]>('*');

  return row ? mapDocumentTemplate(row) : null;
}

export async function restoreTemplate(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<DocumentTemplate | null> {
  const runner = trx;

  const [row] = await runner(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      updated_at: runner.fn.now(),
      version: runner.raw('version + 1'),
    })
    .returning<Row[]>('*');

  return row ? mapDocumentTemplate(row) : null;
}
