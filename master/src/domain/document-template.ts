/**
 * Template invariants and the `layout` block grammar
 * (`docs/backend-modules/04-API-CONTRACT.md` §6.1).
 *
 * Pure: no database, no PDF library. Called by the service inside the
 * transaction on create and update — and also on **preview**, which takes an
 * unsaved template, so an invalid layout is refused before the renderer ever
 * sees it rather than crashing somewhere inside PDFKit.
 *
 * The ordering rules cannot live in a SQL `CHECK`: "header must be first" is a
 * statement about an array's order, which a per-row constraint cannot see.
 */

import {
  DOCUMENT_ASSET_KINDS,
  DOCUMENT_TYPES,
  MAX_TERMS_LENGTH,
  PAGE_ORIENTATIONS,
  PAPER_SIZES,
  type DocumentAssetKind,
  type DocumentBlock,
  type DocumentBlockKind,
  type DocumentLayout,
  type DocumentType,
  type PageOrientation,
  type PaperSize,
} from '@orderbook/shared';

import { ConflictError, ValidationError } from '../lib/errors.js';

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Millimetres. The database CHECK allows 0–100; the product refuses the extremes. */
export const MIN_MARGIN_MM = 5;
export const MAX_MARGIN_MM = 50;

/**
 * The shortest page this product supports is A5 landscape — 148mm tall. A
 * document needs meaningfully more than a strip left over, so top+bottom must
 * leave at least this much.
 */
const MIN_BODY_HEIGHT_MM = 100;

/** A5 portrait height in millimetres — the tightest page the geometry has to fit. */
const SHORTEST_PAGE_MM = 148;

const BLOCK_KINDS: readonly DocumentBlockKind[] = [
  'header',
  'party',
  'lines',
  'totals',
  'terms',
  'signature',
];

export interface TemplateShape {
  name: string;
  documentType: DocumentType;
  paperSize: PaperSize;
  orientation: PageOrientation;
  margins: { top: number; right: number; bottom: number; left: number };
  showWatermark: boolean;
  watermarkText: string | null;
  accentColour: string | null;
  layout: DocumentLayout;
}

export function isDocumentAssetKind(value: unknown): value is DocumentAssetKind {
  return typeof value === 'string' && (DOCUMENT_ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * Every template invariant, in one pass.
 *
 * Throws on the first violation rather than collecting them. The designer is a
 * form with live validation, so a caller reaching here has already been told
 * about anything the browser could see; what arrives at this function is
 * either correct or the result of somebody talking to the API directly, and
 * the first honest reason is enough for both.
 */
export function assertTemplateValid(template: TemplateShape): void {
  if (template.name.trim().length === 0) {
    throw new ValidationError('validation.documents.name.required', {}, { field: 'name' });
  }

  if (!(DOCUMENT_TYPES as readonly string[]).includes(template.documentType)) {
    throw new ValidationError(
      'validation.documents.documentType.unknown',
      {},
      { field: 'documentType', allowed: [...DOCUMENT_TYPES] },
    );
  }

  if (!(PAPER_SIZES as readonly string[]).includes(template.paperSize)) {
    throw new ValidationError(
      'validation.documents.paperSize.unknown',
      {},
      { field: 'paperSize', allowed: [...PAPER_SIZES] },
    );
  }

  if (!(PAGE_ORIENTATIONS as readonly string[]).includes(template.orientation)) {
    throw new ValidationError(
      'validation.documents.orientation.unknown',
      {},
      { field: 'orientation', allowed: [...PAGE_ORIENTATIONS] },
    );
  }

  assertMargins(template.margins);

  if (template.accentColour !== null && !HEX_PATTERN.test(template.accentColour)) {
    throw new ValidationError(
      'validation.documents.accentColour.invalid',
      {},
      { field: 'accentColour' },
    );
  }

  // A watermark with no text draws nothing, which reads on screen as the
  // toggle being broken rather than as a field being blank.
  if (template.showWatermark && (template.watermarkText ?? '').trim().length === 0) {
    throw new ValidationError(
      'validation.documents.watermarkText.required',
      {},
      { field: 'watermarkText' },
    );
  }

  assertLayoutValid(template.layout);
}

function assertMargins(margins: { top: number; right: number; bottom: number; left: number }): void {
  for (const [edge, value] of Object.entries(margins)) {
    if (!Number.isInteger(value) || value < MIN_MARGIN_MM || value > MAX_MARGIN_MM) {
      throw new ValidationError(
        'validation.documents.margins.invalid',
        { min: MIN_MARGIN_MM, max: MAX_MARGIN_MM },
        { field: 'margins', edge, min: MIN_MARGIN_MM, max: MAX_MARGIN_MM },
      );
    }
  }

  if (SHORTEST_PAGE_MM - margins.top - margins.bottom < MIN_BODY_HEIGHT_MM) {
    throw new ValidationError(
      'validation.documents.margins.exceedsPage',
      {},
      { field: 'margins', reason: 'exceeds_page' },
    );
  }
}

/**
 * The block grammar's five rules. `details.block` is the zero-based index of
 * the offending block, or `null` for the one rule with no single offender
 * (a missing `lines` block is a property of the whole array).
 */
export function assertLayoutValid(layout: DocumentLayout): void {
  const blocks: DocumentBlock[] = layout?.blocks ?? [];

  const seen = new Set<DocumentBlockKind>();

  blocks.forEach((block, index) => {
    if (!block || !(BLOCK_KINDS as readonly string[]).includes(block.kind)) {
      throw new ValidationError(
        'validation.documents.layout.blockKindUnknown',
        {},
        { field: 'layout', block: index, reason: 'unknown_kind', allowed: [...BLOCK_KINDS] },
      );
    }

    // Rule 1 — every kind at most once. Two totals blocks is not a layout.
    if (seen.has(block.kind)) {
      throw new ValidationError(
        'validation.documents.layout.duplicateKind',
        { kind: block.kind },
        { field: 'layout', block: index, reason: 'duplicate_kind' },
      );
    }
    seen.add(block.kind);

    // Rule 3 — header first if present.
    if (block.kind === 'header' && index !== 0) {
      throw new ValidationError(
        'validation.documents.layout.headerNotFirst',
        {},
        { field: 'layout', block: index, reason: 'header_not_first' },
      );
    }

    // Rule 4 — signature last if present.
    if (block.kind === 'signature' && index !== blocks.length - 1) {
      throw new ValidationError(
        'validation.documents.layout.signatureNotLast',
        {},
        { field: 'layout', block: index, reason: 'signature_not_last' },
      );
    }

    // Rule 5 — terms are a paragraph, not an essay.
    if (block.kind === 'terms' && block.text.length > MAX_TERMS_LENGTH) {
      throw new ValidationError(
        'validation.documents.layout.termsTooLong',
        { max: MAX_TERMS_LENGTH },
        { field: 'layout', block: index, reason: 'terms_too_long', max: MAX_TERMS_LENGTH },
      );
    }
  });

  // Rule 2 — a document with no line items is a letterhead.
  if (!seen.has('lines')) {
    throw new ValidationError(
      'validation.documents.layout.missingLines',
      {},
      { field: 'layout', block: null, reason: 'missing_lines' },
    );
  }
}

/**
 * A template's `documentType` decides which records it can be rendered for.
 *
 * A dispatch note for a lead is not a rendering mistake to be tidied up in the
 * layout — nothing has been dispatched, so the document would be a statement
 * about goods that have not moved.
 */
export function assertTemplateAppliesTo(
  documentType: DocumentType,
  subjectKind: 'lead' | 'order',
): void {
  const applies =
    documentType === 'quotation'
      ? true // a quotation reads correctly for either
      : subjectKind === 'order';

  if (!applies) {
    throw new ValidationError(
      'validation.documents.templateType.mismatch',
      { documentType },
      { field: 'templateId', documentType },
    );
  }
}

/**
 * Promoting a default demotes the previous one **in the same transaction**.
 *
 * `document_templates_one_default` is a *partial* unique index, so unlike the
 * Fields sequence constraint it cannot be made deferrable — a partial index
 * has no constraint to defer. The swap must therefore be clear-then-set, never
 * set-then-clear, or the second statement collides with the first mid-way.
 */
export function assertDefaultSwap(
  promotingId: string,
  currentDefaultId: string | null,
): { demote: string | null } {
  if (currentDefaultId === null || currentDefaultId === promotingId) {
    return { demote: null };
  }
  return { demote: currentDefaultId };
}

/** A duplicate template name, as the 409 the API contract specifies. */
export function nameTakenError(value: string): ConflictError {
  return new ConflictError(
    'error.conflict.nameTaken.documentTemplate',
    { value },
    { field: 'name', value },
  );
}
