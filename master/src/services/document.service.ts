/**
 * Document template CRUD, and asset upload (`docs/backend-modules/06-WORKFLOWS.md`).
 *
 * Separate from `document-render.service.ts` because the two orchestrate
 * different collaborators: this one never touches `pdf/`, and rendering never
 * writes a template. Every write is permission, then the pure domain
 * assertions, then one transaction threading `trx` into both the repository
 * write and `recordActivity`, so a template change and the entry recording it
 * commit together or not at all.
 */

import { randomUUID } from 'node:crypto';
import type {
  CursorPage,
  DocumentAsset,
  DocumentAssetInput,
  DocumentTemplate,
  DocumentTemplateInput,
  DocumentTemplateQuery,
  DocumentType,
} from '@orderbook/shared';
import { TEMPLATE_DEFAULTS, isDocumentType, isLocale, normaliseLayout } from '@orderbook/shared';

import { assertVersionMatches, fieldDiff } from '../domain/access.js';
import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import {
  clampDocumentPage,
  decodeTemplateCursor,
  encodeTemplateCursor,
} from '../domain/document-cursor.js';
import {
  assertDefaultSwap,
  assertTemplateValid,
  isDocumentAssetKind,
  nameTakenError,
  type TemplateShape,
} from '../domain/document-template.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { sha256Of, writeAssetFile } from '../lib/document-files.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as assetRepo from '../repositories/document-asset.repository.js';
import * as templateRepo from '../repositories/document-template.repository.js';
import { publishChange } from './change-bus.js';

// --- Reads -----------------------------------------------------------------

export async function listTemplates(
  query: DocumentTemplateQuery,
  actor: ActorContext,
): Promise<CursorPage<DocumentTemplate>> {
  requirePermission(actor, 'documents.view');

  const limit = clampDocumentPage(query.limit);
  const after = query.cursor ? decodeTemplateCursor(query.cursor) : undefined;

  // One more than asked for, so "is there a next page" costs no COUNT.
  const rows = await templateRepo.listTemplates(actor.tenantId, {
    documentType: query.documentType,
    after,
    limit: limit + 1,
  });

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeTemplateCursor({ name: last.name.toLowerCase(), id: last.id })
        : null,
    // A template list is read in one direction only.
    prevCursor: null,
    limit,
  };
}

export async function getTemplate(id: string, actor: ActorContext): Promise<DocumentTemplate> {
  requirePermission(actor, 'documents.view');

  const template = await templateRepo.findTemplateById(actor.tenantId, id);
  if (!template) throw new NotFoundError('Document template');
  return template;
}

/**
 * What the render path uses when the caller named no template: the tenant's
 * default for that document type, or — when they have saved none —
 * `TEMPLATE_DEFAULTS` in memory. A fresh installation can therefore print
 * before anybody has opened the designer.
 */
export async function resolveTemplateForRender(
  tenantId: string,
  documentType: DocumentType,
): Promise<{ template: TemplateShape & DocumentTemplateFlags; id: string | null; name: string }> {
  const stored = await templateRepo.defaultTemplateFor(tenantId, documentType);
  if (stored) return { template: stored, id: stored.id, name: stored.name };

  // The in-memory default is described as blocks, because a default says what
  // a quotation *is* rather than where it sits on a particular sheet. It gains
  // geometry here, against the paper it is about to be printed on.
  const fallback = TEMPLATE_DEFAULTS[documentType];
  return {
    template: {
      ...fallback,
      layout: normaliseLayout(
        fallback.layout,
        {
          paperSize: fallback.paperSize,
          orientation: fallback.orientation,
          margins: fallback.margins,
        },
        { hasLogo: fallback.showLogo, hasSignature: fallback.showSignature },
      ),
    },
    id: null,
    name: fallback.name,
  };
}

/** The switch fields the model builder needs alongside the geometry. */
export interface DocumentTemplateFlags {
  showRates: boolean;
  showColourChips: boolean;
  showTerms: boolean;
  showLogo: boolean;
  showSignature: boolean;
  showPageNumbers: boolean;
  showPartyBlock: boolean;
  termsText: string | null;
  footerText: string | null;
  logoAssetId?: string | null;
  signatureAssetId?: string | null;
}

// --- Writes ----------------------------------------------------------------

/**
 * Fills an input out to a whole template, defaulting from `TEMPLATE_DEFAULTS`
 * for the document type. Used by create, by update (over the stored row), and
 * by preview (which never persists), so all three validate the same shape.
 */
export function materialise(
  input: DocumentTemplateInput,
  base?: DocumentTemplate,
): TemplateShape & DocumentTemplateFlags & { accentColour: string | null; locale: string | null } {
  const documentType = input.documentType ?? base?.documentType ?? 'quotation';
  if (!isDocumentType(documentType)) {
    throw new ValidationError(
      'validation.documents.documentType.unknown',
      {},
      { field: 'documentType' },
    );
  }

  const defaults = TEMPLATE_DEFAULTS[documentType];
  const fallback = base ?? defaults;

  const locale = input.locale ?? base?.locale ?? null;
  if (locale !== null && !isLocale(locale)) {
    throw new ValidationError('validation.documents.locale.unknown', {}, { field: 'locale' });
  }

  // Resolved before the return, because the layout has to be converted against
  // the paper it will actually be printed on.
  const paperSize = input.paperSize ?? fallback.paperSize;
  const orientation = input.orientation ?? fallback.orientation;
  const margins = input.margins ?? fallback.margins;

  return {
    name: input.name ?? fallback.name,
    documentType,
    paperSize,
    orientation,
    margins,
    showRates: input.showRates ?? fallback.showRates,
    showColourChips: input.showColourChips ?? fallback.showColourChips,
    showTerms: input.showTerms ?? fallback.showTerms,
    showLogo: input.showLogo ?? fallback.showLogo,
    showSignature: input.showSignature ?? fallback.showSignature,
    showPageNumbers: input.showPageNumbers ?? fallback.showPageNumbers,
    showWatermark: input.showWatermark ?? fallback.showWatermark,
    showPartyBlock: input.showPartyBlock ?? fallback.showPartyBlock,
    watermarkText: input.watermarkText ?? fallback.watermarkText,
    termsText: input.termsText ?? fallback.termsText,
    footerText: input.footerText ?? fallback.footerText,
    accentColour: input.accentColour ?? fallback.accentColour,
    locale,
    // A draft arriving from the designer is already version 2; a caller sending
    // no layout at all falls back to the default's blocks, which convert here.
    layout: normaliseLayout(
      input.layout ?? base?.layout ?? fallback.layout,
      { paperSize, orientation, margins },
      {
        hasLogo: (input.showLogo ?? fallback.showLogo) === true,
        hasSignature: (input.showSignature ?? fallback.showSignature) === true,
      },
    ),
    logoAssetId: input.logoAssetId ?? base?.logoAssetId ?? null,
    signatureAssetId: input.signatureAssetId ?? base?.signatureAssetId ?? null,
  };
}

function toColumns(
  shape: ReturnType<typeof materialise>,
  isDefault: boolean,
): templateRepo.TemplateWriteColumns {
  return {
    name: shape.name.trim(),
    document_type: shape.documentType,
    paper_size: shape.paperSize,
    orientation: shape.orientation,
    margin_top_mm: shape.margins.top,
    margin_right_mm: shape.margins.right,
    margin_bottom_mm: shape.margins.bottom,
    margin_left_mm: shape.margins.left,
    show_rates: shape.showRates,
    show_colour_chips: shape.showColourChips,
    show_terms: shape.showTerms,
    show_logo: shape.showLogo,
    show_signature: shape.showSignature,
    show_page_numbers: shape.showPageNumbers,
    show_watermark: shape.showWatermark,
    show_party_block: shape.showPartyBlock,
    watermark_text: shape.watermarkText,
    terms_text: shape.termsText,
    footer_text: shape.footerText,
    accent_colour: shape.accentColour,
    locale: shape.locale,
    layout: JSON.stringify(shape.layout),
    logo_asset_id: shape.logoAssetId ?? null,
    signature_asset_id: shape.signatureAssetId ?? null,
    is_default: isDefault,
  };
}

export async function createTemplate(
  input: DocumentTemplateInput,
  actor: ActorContext,
): Promise<DocumentTemplate> {
  requirePermission(actor, 'documents.create');

  const shape = materialise(input);
  assertTemplateValid(shape);

  const id = randomUUID();
  const isDefault = input.isDefault ?? false;

  const created = await db().transaction(async (trx) => {
    if (await templateRepo.isNameTaken(actor.tenantId, shape.name, null, trx)) {
      throw nameTakenError(shape.name);
    }

    // Clear-then-set: the one-default index is partial and cannot be deferred.
    if (isDefault) {
      await templateRepo.clearDefaultFor(actor.tenantId, shape.documentType, trx);
    }

    const row = await templateRepo.insertTemplate(
      {
        ...toColumns(shape, isDefault),
        id,
        tenantId: actor.tenantId,
        createdBy: actorUserId(actor),
      },
      trx,
    );

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'document_template',
        entityId: id,
        action: 'created',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name, documentType: row.documentType },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({ entity: 'document_template', action: 'created', id, payload: created });
  return created;
}

export async function updateTemplate(
  id: string,
  input: DocumentTemplateInput & { expectedVersion: number },
  actor: ActorContext,
): Promise<DocumentTemplate> {
  requirePermission(actor, 'documents.edit');

  const updated = await db().transaction(async (trx) => {
    // Locked before the version is compared, so two concurrent saves cannot
    // both pass the check and the loser is genuinely refused.
    const existing = await templateRepo.lockTemplate(actor.tenantId, id, trx);
    if (!existing || existing.deletedAt) throw new NotFoundError('Document template');

    assertVersionMatches(
      existing.version,
      input.expectedVersion,
      fieldDiff(
        { name: existing.name, isDefault: existing.isDefault, showRates: existing.showRates },
        { name: input.name, isDefault: input.isDefault, showRates: input.showRates },
      ),
    );

    const shape = materialise(input, existing);
    assertTemplateValid(shape);

    if (await templateRepo.isNameTaken(actor.tenantId, shape.name, id, trx)) {
      throw nameTakenError(shape.name);
    }

    const isDefault = input.isDefault ?? existing.isDefault;

    if (isDefault) {
      const currentDefault = await templateRepo.currentDefaultId(
        actor.tenantId,
        shape.documentType,
        trx,
      );
      const { demote } = assertDefaultSwap(id, currentDefault);
      if (demote) await templateRepo.clearDefaultFor(actor.tenantId, shape.documentType, trx);
    }

    const row = await templateRepo.updateTemplate(
      actor.tenantId,
      id,
      toColumns(shape, isDefault),
      actorUserId(actor),
      trx,
    );
    if (!row) throw new NotFoundError('Document template');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'document_template',
        entityId: id,
        action: 'updated',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({ entity: 'document_template', action: 'updated', id, payload: updated });
  return updated;
}

export async function deleteTemplate(
  id: string,
  expectedVersion: number,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'documents.delete');

  const deleted = await db().transaction(async (trx) => {
    const existing = await templateRepo.lockTemplate(actor.tenantId, id, trx);
    if (!existing || existing.deletedAt) throw new NotFoundError('Document template');

    assertVersionMatches(existing.version, expectedVersion);

    const row = await templateRepo.softDeleteTemplate(actor.tenantId, id, actorUserId(actor), trx);
    if (!row) throw new NotFoundError('Document template');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'document_template',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({ entity: 'document_template', action: 'deleted', id, payload: deleted });
  return { id, deletedAt: deleted.deletedAt ?? new Date().toISOString() };
}

/**
 * Restore reuses the **delete** key. No `documents.restore` exists, so restore
 * can never be a back door onto a template somebody may not remove.
 */
export async function restoreTemplate(id: string, actor: ActorContext): Promise<DocumentTemplate> {
  requirePermission(actor, 'documents.delete');

  const restored = await db().transaction(async (trx) => {
    const existing = await templateRepo.findTemplateById(
      actor.tenantId,
      id,
      { includeDeleted: true },
      trx,
    );
    if (!existing) throw new NotFoundError('Document template');
    if (!existing.deletedAt) return existing;

    // A soft delete frees the name immediately, so somebody may have taken it
    // in the meantime. Refusing is better than silently renaming a template
    // whose name is printed on documents.
    if (await templateRepo.isNameTaken(actor.tenantId, existing.name, id, trx)) {
      throw nameTakenError(existing.name);
    }

    const row = await templateRepo.restoreTemplate(actor.tenantId, id, trx);
    if (!row) throw new NotFoundError('Document template');

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'document_template',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { name: row.name },
      },
      actor,
      trx,
    );

    return row;
  });

  publishChange({ entity: 'document_template', action: 'restored', id, payload: restored });
  return restored;
}

// --- Assets ----------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Decodes a `data:` URL and decides the type from the **magic bytes**, not
 * from the declared mime — a client naming `image/png` over a JPEG body would
 * otherwise get a `.png` on disk that no viewer opens. SVG is refused
 * outright: PDFKit draws PNG and JPEG natively, and adding SVG means a second
 * XML parser running on untrusted input for one cosmetic feature.
 */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' } {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) {
    throw new ValidationError(
      'validation.documents.asset.malformed',
      {},
      { field: 'dataUrl', reason: 'malformed' },
    );
  }

  const bytes = Buffer.from(match[2]!, 'base64');

  if (bytes.length === 0) {
    throw new ValidationError(
      'validation.documents.asset.malformed',
      {},
      { field: 'dataUrl', reason: 'empty' },
    );
  }

  if (bytes.length > config.documents.maxAssetBytes) {
    throw new ValidationError(
      'validation.documents.asset.tooLarge',
      { maxBytes: config.documents.maxAssetBytes },
      { field: 'dataUrl', reason: 'too_large', maxBytes: config.documents.maxAssetBytes },
    );
  }

  const isPng = bytes.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = bytes.subarray(0, 3).equals(JPEG_MAGIC);

  if (!isPng && !isJpeg) {
    throw new ValidationError(
      'validation.documents.asset.unsupportedType',
      {},
      {
        field: 'dataUrl',
        reason: 'unsupported_type',
        allowed: ['image/png', 'image/jpeg'],
      },
    );
  }

  return { bytes, mimeType: isPng ? 'image/png' : 'image/jpeg' };
}

export async function uploadAsset(
  input: DocumentAssetInput,
  actor: ActorContext,
): Promise<DocumentAsset> {
  requirePermission(actor, 'documents.edit');

  if (!isDocumentAssetKind(input.kind)) {
    throw new ValidationError(
      'validation.documents.asset.kindUnknown',
      {},
      { field: 'kind', allowed: ['logo', 'signature'] },
    );
  }

  const { bytes, mimeType } = decodeDataUrl(input.dataUrl);
  const sha256 = sha256Of(bytes);

  // `(tenant_id, sha256)` is unique, so re-uploading the same logo returns the
  // row that already exists rather than a second copy of identical bytes.
  const existing = await assetRepo.findAssetBySha(actor.tenantId, sha256);
  if (existing) return existing;

  const id = randomUUID();
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const storagePath = await writeAssetFile(id, extension, bytes);

  return db().transaction(async (trx) =>
    assetRepo.insertAsset(
      {
        id,
        tenantId: actor.tenantId,
        kind: input.kind,
        filename: `${input.kind}.${extension}`,
        mimeType,
        byteSize: bytes.length,
        sha256,
        storagePath,
        uploadedBy: actorUserId(actor),
      },
      trx,
    ),
  );
}

export async function listAssets(actor: ActorContext): Promise<DocumentAsset[]> {
  requirePermission(actor, 'documents.view');
  return assetRepo.listAssets(actor.tenantId);
}
