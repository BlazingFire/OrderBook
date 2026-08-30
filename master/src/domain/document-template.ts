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
  PAGE_ORIENTATIONS,
  PAPER_SIZES,
  type DocumentAssetKind,
  type DocumentLayoutV2,
  type ElementTextStyle,
  type PageGeometry,
  DOCUMENT_ELEMENT_KINDS,
  MAX_ELEMENTS,
  MAX_ELEMENT_CHARS,
  pageSizeMm,
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

export interface TemplateShape {
  name: string;
  documentType: DocumentType;
  paperSize: PaperSize;
  orientation: PageOrientation;
  margins: { top: number; right: number; bottom: number; left: number };
  showWatermark: boolean;
  watermarkText: string | null;
  accentColour: string | null;
  layout: DocumentLayoutV2;
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

function assertMargins(margins: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): void {
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
 * Every rule a placed layout has to satisfy.
 *
 * Version 1's five block rules survive in spirit rather than in form. "Each
 * kind at most once" becomes "exactly one table", because that is the rule
 * that was actually load-bearing — a second table has no defined behaviour when
 * rows flow. "A lines block is mandatory" survives unchanged: a document with
 * nowhere to put line items is a letterhead. "Header first" and "signature
 * last" do not survive, and should not: they were ordering rules for a flow
 * renderer, and the signature's own draw code had already stopped honouring the
 * second one.
 *
 * `details.element` is the offending element's id, or `null` for a rule that is
 * a property of the whole layout.
 */
export function assertLayoutValid(layout: DocumentLayoutV2, geometry?: PageGeometry): void {
  const elements = layout?.elements ?? [];

  if (elements.length > MAX_ELEMENTS) {
    throw new ValidationError(
      'validation.documents.layout.tooManyElements',
      { max: MAX_ELEMENTS },
      { field: 'layout', element: null, reason: 'too_many_elements', max: MAX_ELEMENTS },
    );
  }

  const page = geometry ? pageSizeMm(geometry.paperSize, geometry.orientation) : null;
  const ids = new Set<string>();
  let tables = 0;

  for (const element of elements) {
    if (!element || !(DOCUMENT_ELEMENT_KINDS as readonly string[]).includes(element.kind)) {
      throw new ValidationError(
        'validation.documents.layout.elementKindUnknown',
        {},
        {
          field: 'layout',
          element: element?.id ?? null,
          reason: 'unknown_kind',
          allowed: [...DOCUMENT_ELEMENT_KINDS],
        },
      );
    }

    if (ids.has(element.id)) {
      throw new ValidationError(
        'validation.documents.layout.duplicateElementId',
        {},
        { field: 'layout', element: element.id, reason: 'duplicate_id' },
      );
    }
    ids.add(element.id);

    if (element.kind === 'table') tables += 1;

    // A rule is a line, so it is allowed no height. Everything else needs to
    // occupy the page it claims to be on.
    const needsHeight = element.kind !== 'rule';
    if (element.w <= 0 || (needsHeight && element.h <= 0)) {
      throw new ValidationError(
        'validation.documents.layout.elementEmpty',
        {},
        { field: 'layout', element: element.id, reason: 'element_empty' },
      );
    }

    if (page) {
      // Refused rather than nudged. Changing paper size can push a design off
      // the sheet, and moving somebody's elements for them without saying so is
      // worse than telling them the page got smaller.
      const offPage =
        element.x < -0.001 ||
        element.y < -0.001 ||
        element.x + element.w > page.width + 0.001 ||
        element.y + element.h > page.height + 0.001;

      if (offPage) {
        throw new ValidationError(
          'validation.documents.layout.elementOffPage',
          {},
          { field: 'layout', element: element.id, reason: 'element_off_page' },
        );
      }
    }

    if (element.kind === 'text' || element.kind === 'field') {
      assertTextStyleValid(element.style, element.id);
    }

    if (element.kind === 'text' && element.text.length > MAX_ELEMENT_CHARS) {
      throw new ValidationError(
        'validation.documents.layout.textTooLong',
        { max: MAX_ELEMENT_CHARS },
        { field: 'layout', element: element.id, reason: 'text_too_long', max: MAX_ELEMENT_CHARS },
      );
    }

    /*
     * A literal that looks like a merge token.
     *
     * Nothing substitutes into static text today, so `{party.name}` typed into
     * a text box prints verbatim and is merely odd. The day somebody adds
     * substitution it becomes a way to name data the binding catalogue would
     * have permission-checked. Refusing it now costs an operator nothing and
     * closes the hole before it exists.
     */
    if (element.kind === 'text' && /\{[A-Za-z][A-Za-z.]*\}/.test(element.text)) {
      throw new ValidationError(
        'validation.documents.layout.placeholderInLiteral',
        {},
        { field: 'layout', element: element.id, reason: 'placeholder_in_literal' },
      );
    }
  }

  // A document with nowhere to put its line items is a letterhead, and the one
  // table is what the flow region is built around.
  if (tables !== 1) {
    throw new ValidationError(
      tables === 0
        ? 'validation.documents.layout.missingLines'
        : 'validation.documents.layout.duplicateTable',
      {},
      {
        field: 'layout',
        element: null,
        reason: tables === 0 ? 'missing_lines' : 'duplicate_table',
      },
    );
  }
}

function assertTextStyleValid(style: ElementTextStyle, id: string): void {
  if (!(style.size > 0) || style.size > 200) {
    throw new ValidationError(
      'validation.documents.layout.fontSizeOutOfRange',
      {},
      { field: 'layout', element: id, reason: 'font_size_out_of_range' },
    );
  }

  if (style.maxChars < 0 || style.maxChars > MAX_ELEMENT_CHARS) {
    throw new ValidationError(
      'validation.documents.layout.maxCharsOutOfRange',
      { max: MAX_ELEMENT_CHARS },
      { field: 'layout', element: id, reason: 'max_chars_out_of_range', max: MAX_ELEMENT_CHARS },
    );
  }

  if (style.colour !== null && !HEX_PATTERN.test(style.colour)) {
    throw new ValidationError(
      'validation.documents.layout.colourInvalid',
      {},
      { field: 'layout', element: id, reason: 'colour_invalid' },
    );
  }
}

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
