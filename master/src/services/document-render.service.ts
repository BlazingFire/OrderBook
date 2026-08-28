/**
 * The render use case — **the only importer of `pdf/`**.
 *
 * The order of operations is the security property, not an implementation
 * detail:
 *
 *   1. `documents.render`
 *   2. the subject's **own** view key (`leads.view` / `orders.view`)
 *   3. read the subject through the existing service, so it arrives already
 *      masked by `maskLead`/`maskOrder`
 *   4. `ratesIncluded = template.showRates && canSeeRates(actor)`
 *   5. `buildDocumentModel` — where redaction becomes a layout fact
 *   6. `renderPdf`
 *   7. write the file durably
 *   8. one transaction: `markSuperseded` + `insertExport` + `recordActivity`
 *
 * Step 2 is what stops `documents.render` becoming a way to read a lead you
 * may not open, formatted as a PDF. Step 3 means the renderer is never handed
 * a rate the actor could not have seen through any other endpoint.
 *
 * The file is complete and fsynced **before** the transaction opens, so a
 * crash can leave a file with no row (swept at startup) but never a row with
 * no file — which is the direction that matters, because a row with no file is
 * a broken download link in somebody's history.
 *
 * `previewDocument` runs the identical path with nothing persisted, so a
 * preview cannot diverge from the document that is eventually sent.
 */

import { randomUUID } from 'node:crypto';
import type {
  CursorPage,
  DocumentExport,
  DocumentExportQuery,
  DocumentRenderResult,
  DocumentSubjectKind,
  DocumentType,
  Lead,
  Order,
  PreviewDocumentInput,
  RenderDocumentInput,
} from '@orderbook/shared';

import { actorCan, actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { buildDocumentModel } from '../domain/document-model.js';
import {
  clampDocumentPage,
  decodeExportCursor,
  encodeExportCursor,
} from '../domain/document-cursor.js';
import {
  assertTemplateAppliesTo,
  assertTemplateValid,
  type TemplateShape,
} from '../domain/document-template.js';
import { canSeeRates } from '../domain/visibility.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import {
  readStoredFile,
  sha256Of,
  writeExportFile,
} from '../lib/document-files.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as assetRepo from '../repositories/document-asset.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import * as exportRepo from '../repositories/document-export.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as templateRepo from '../repositories/document-template.repository.js';
import { renderPdf } from '../pdf/renderer.js';
import * as documentService from './document.service.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';
import * as setupService from './setup.service.js';
import { publishChange } from './change-bus.js';

const SUBJECT_KINDS: readonly DocumentSubjectKind[] = ['lead', 'order'];

function assertSubjectKind(value: unknown): DocumentSubjectKind {
  if (typeof value !== 'string' || !SUBJECT_KINDS.includes(value as DocumentSubjectKind)) {
    throw new ValidationError(
      'validation.documents.subjectKind.unknown',
      {},
      { field: 'subjectKind', allowed: [...SUBJECT_KINDS] },
    );
  }
  return value as DocumentSubjectKind;
}

/** The subject's own view key. Never optional — see the file header. */
function viewKeyFor(subjectKind: DocumentSubjectKind): 'leads.view' | 'orders.view' {
  return subjectKind === 'lead' ? 'leads.view' : 'orders.view';
}

/**
 * Reads the subject through the service that owns it, so it arrives masked
 * exactly as any other read of the same record would be.
 */
async function readSubject(
  subjectKind: DocumentSubjectKind,
  subjectId: string,
  actor: ActorContext,
): Promise<Lead | Order> {
  return subjectKind === 'lead'
    ? leadService.getLead(subjectId, actor)
    : orderService.getOrder(subjectId, actor);
}

/** `stock.colour` hex values, so the renderer can draw a real swatch. */
async function colourHexMap(tenantId: string): Promise<Map<string, string>> {
  const options = await customFieldRepo.listOptions(tenantId);
  const map = new Map<string, string>();

  for (const option of options) {
    if (option.listKey === 'stock.colour' && option.hex) map.set(option.value, option.hex);
  }

  return map;
}

async function loadAsset(tenantId: string, assetId: string | null): Promise<Buffer | null> {
  if (!assetId) return null;

  const asset = await assetRepo.findAssetPath(tenantId, assetId);
  if (!asset) return null;

  return readStoredFile(asset.storagePath);
}

interface PreparedRender {
  bytes: Buffer;
  pageCount: number;
  ratesIncluded: boolean;
  subject: Lead | Order;
  documentType: DocumentType;
}

/**
 * Everything both `renderDocument` and `previewDocument` do, up to the bytes.
 * Sharing it is what makes a preview structurally unable to differ from the
 * document that gets sent.
 */
async function prepare(
  template: TemplateShape & documentService.DocumentTemplateFlags,
  subjectKind: DocumentSubjectKind,
  subjectId: string,
  actor: ActorContext,
  forceWatermark: string | null,
): Promise<PreparedRender> {
  const subject = await readSubject(subjectKind, subjectId, actor);

  // A document about a record in the recycle bin would be a statement about
  // something the company has decided is gone.
  if ((subject as { deletedAt?: string | null }).deletedAt) {
    throw new ConflictError(
      'error.conflict.subjectDeleted',
      {},
      { reason: 'subject_deleted' },
    );
  }

  const ratesIncluded = template.showRates && canSeeRates(actor);

  const [party, colourHex, identity, logo, signature] = await Promise.all([
    partyRepo.findPartyById(actor.tenantId, subject.partyId),
    colourHexMap(actor.tenantId),
    setupService.getIdentity(),
    template.showLogo ? loadAsset(actor.tenantId, template.logoAssetId ?? null) : null,
    template.showSignature ? loadAsset(actor.tenantId, template.signatureAssetId ?? null) : null,
  ]);

  const model = buildDocumentModel({
    subject,
    subjectKind,
    party,
    template,
    identity,
    ratesIncluded,
    colourHex,
    forceWatermark,
    // The business's own configured timezone, never the host machine's — a
    // PDF rendered near midnight must show the same date to a signed-in
    // operator regardless of which OS clock the Master happens to run under.
    issuedOn: new Intl.DateTimeFormat('en-CA', { timeZone: config.locale.timeZone }).format(new Date()),
  });

  const { bytes, pageCount } = await renderPdf(model, {
    paperSize: template.paperSize,
    orientation: template.orientation,
    margins: template.margins,
    logo,
    signature,
  });

  return { bytes, pageCount, ratesIncluded, subject, documentType: template.documentType };
}

export async function renderDocument(
  input: RenderDocumentInput,
  actor: ActorContext,
): Promise<DocumentRenderResult> {
  requirePermission(actor, 'documents.render');

  const subjectKind = assertSubjectKind(input.subjectKind);
  requirePermission(actor, viewKeyFor(subjectKind));

  const stored = await templateRepo.findTemplateById(actor.tenantId, input.templateId);
  if (!stored) throw new NotFoundError('Document template');

  assertTemplateAppliesTo(stored.documentType, subjectKind);

  const prepared = await prepare(stored, subjectKind, input.subjectId, actor, null);

  // Durable on disk before the transaction opens: a crash after this point
  // leaves an orphan file the startup sweep removes, never a row whose file
  // is missing.
  const storageKey = randomUUID();
  const storagePath = await writeExportFile(storageKey, prepared.bytes);

  const exportId = await db().transaction(async (trx) => {
    const id = await exportRepo.insertExport(
      {
        tenantId: actor.tenantId,
        subjectKind,
        subjectId: input.subjectId,
        documentType: stored.documentType,
        templateId: stored.id,
        templateName: stored.name,
        storageKey,
        storagePath,
        byteSize: prepared.bytes.length,
        sha256: sha256Of(prepared.bytes),
        pageCount: prepared.pageCount,
        ratesIncluded: prepared.ratesIncluded,
        locale: stored.locale,
        renderedByUserId: actorUserId(actor),
        renderedByPanelId: actor.actorType === 'office_panel' ? actor.actorId : null,
      },
      trx,
    );

    // Same transaction as the insert: a history where two exports both claim
    // to be current is worse than one that is briefly missing a row.
    await exportRepo.markSuperseded(
      actor.tenantId,
      { kind: subjectKind, id: input.subjectId, documentType: stored.documentType },
      id,
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'document_export',
        entityId: id,
        action: 'rendered',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          documentType: stored.documentType,
          subject: input.subjectId,
          subjectKind,
          template: stored.name,
          ratesIncluded: prepared.ratesIncluded,
        },
      },
      actor,
      trx,
    );

    return id;
  });

  publishChange({
    entity: 'document_export',
    action: 'created',
    id: exportId,
    payload: { subjectKind, subjectId: input.subjectId },
  });

  return {
    exportId,
    fileName: `${storageKey}.pdf`,
    byteSize: prepared.bytes.length,
    pageCount: prepared.pageCount,
    ratesIncluded: prepared.ratesIncluded,
    downloadPath: `/api/documents/exports/${exportId}/file`,
  };
}

/**
 * Renders without persisting anything: no file, no export row, no activity
 * entry. Takes a whole template rather than an id, so the designer can preview
 * edits it has not saved — which is why the template is validated here too.
 *
 * The `PREVIEW` watermark is forced on **regardless of the template**, so a
 * preview cannot be passed off as the real document.
 */
export async function previewDocument(
  input: PreviewDocumentInput,
  actor: ActorContext,
): Promise<{ fileName: string; contentType: 'application/pdf'; bytes: Uint8Array }> {
  requirePermission(actor, 'documents.render');

  const subjectKind = assertSubjectKind(input.subjectKind);
  requirePermission(actor, viewKeyFor(subjectKind));

  const shape = documentService.materialise(input.template);
  assertTemplateValid(shape);
  assertTemplateAppliesTo(shape.documentType, subjectKind);

  const prepared = await prepare(shape, subjectKind, input.subjectId, actor, 'PREVIEW');

  if (prepared.bytes.length > config.documents.maxPreviewBytes) {
    throw new ValidationError(
      'error.documents.renderFailed',
      {},
      { reason: 'preview_too_large', maxBytes: config.documents.maxPreviewBytes },
    );
  }

  return {
    fileName: 'preview.pdf',
    contentType: 'application/pdf',
    bytes: prepared.bytes,
  };
}

// --- Export history --------------------------------------------------------

/**
 * Rows whose subject kind the caller may not view are **filtered out**, not
 * refused — the `search.service.ts` rule. A dispatch clerk holding
 * `orders.view` but not `leads.view` gets a coherent list of order documents
 * rather than a 403 on the whole page.
 */
export async function listExports(
  query: DocumentExportQuery,
  actor: ActorContext,
): Promise<CursorPage<DocumentExport>> {
  requirePermission(actor, 'documents.view');

  const permittedKinds = SUBJECT_KINDS.filter((kind) => actorCan(actor, viewKeyFor(kind)));

  const limit = clampDocumentPage(query.limit);
  const beforeId = query.cursor ? decodeExportCursor(query.cursor) : undefined;

  const rows = await exportRepo.listExports(actor.tenantId, {
    scope: resolvePartyScope(actor),
    subjectKind: query.subjectKind,
    subjectId: query.subjectId,
    beforeId,
    permittedKinds: [...permittedKinds],
    limit: limit + 1,
  });

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: rows.length > limit && last ? encodeExportCursor(last.id) : null,
    prevCursor: null,
    limit,
  };
}

/** A single row does refuse, because there is nothing to filter down to. */
export async function getExport(id: string, actor: ActorContext): Promise<DocumentExport> {
  requirePermission(actor, 'documents.view');

  const row = await exportRepo.findExportById(actor.tenantId, id, resolvePartyScope(actor));
  // Another tenant's id answers 404, never 403 — a 403 confirms the id exists.
  if (!row) throw new NotFoundError('Document export');

  requirePermission(actor, viewKeyFor(row.subjectKind));
  return row;
}

export async function fetchExportFile(
  id: string,
  actor: ActorContext,
): Promise<{ fileName: string; contentType: 'application/pdf'; bytes: Uint8Array }> {
  requirePermission(actor, 'documents.view');

  const stored = await exportRepo.findExportFile(actor.tenantId, id, resolvePartyScope(actor));
  if (!stored) throw new NotFoundError('Document export');

  requirePermission(actor, viewKeyFor(stored.subjectKind));

  const bytes = await readStoredFile(stored.storagePath);
  // The row outlived its file — an operator moved `data/` and left the
  // documents directory behind. A 404 is honest; a 500 would suggest a bug.
  if (!bytes) throw new NotFoundError('Document export');

  return {
    fileName: `${stored.storageKey}.pdf`,
    contentType: 'application/pdf',
    bytes,
  };
}

export async function fetchAssetFile(
  id: string,
  actor: ActorContext,
): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }> {
  requirePermission(actor, 'documents.view');

  const asset = await assetRepo.findAssetPath(actor.tenantId, id);
  if (!asset) throw new NotFoundError('Document asset');

  const bytes = await readStoredFile(asset.storagePath);
  if (!bytes) throw new NotFoundError('Document asset');

  return { fileName: asset.filename, contentType: asset.mimeType, bytes };
}
