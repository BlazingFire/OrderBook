/**
 * The PDF Designer's wire types (`docs/backend-modules/04-API-CONTRACT.md` §6.1).
 *
 * Lives in `shared` because both panels render the designer UI and both read
 * export history — the Office Panel forwards every document command to the
 * Master rather than rendering anything itself, but it still needs the shapes.
 *
 * **The eight visibility switches are typed fields, never keys inside `layout`.**
 * A typed field means the renderer reads `template.showRates` and the compiler
 * knows it exists; a key inside `layout` means it reads `layout.showRates ?? true`
 * forever, and the default becomes a fact nothing declares. `layout` carries
 * block *order* and per-block options, and nothing else. The database agrees:
 * eight BOOLEAN columns and one JSONB (`03-DATABASE.md` §5.2).
 */

import type { IsoTimestamp, RecordId, Uuid } from './entities.js';

/**
 * Three members. The product does not raise invoices, and the CHECK on
 * `document_templates.document_type` has the same three.
 */
export type DocumentType = 'quotation' | 'order_confirmation' | 'dispatch_note';

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  'quotation',
  'order_confirmation',
  'dispatch_note',
];

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** Matches the CHECK on `document_templates.paper_size`. */
export type PaperSize = 'A4' | 'A5' | 'Letter';

export const PAPER_SIZES: readonly PaperSize[] = ['A4', 'A5', 'Letter'];

export type PageOrientation = 'portrait' | 'landscape';

export const PAGE_ORIENTATIONS: readonly PageOrientation[] = ['portrait', 'landscape'];

export type DocumentAssetKind = 'logo' | 'signature';

export const DOCUMENT_ASSET_KINDS: readonly DocumentAssetKind[] = ['logo', 'signature'];

/** Which record a document was rendered about. */
export type DocumentSubjectKind = 'lead' | 'order';

export const DOCUMENT_SUBJECT_KINDS: readonly DocumentSubjectKind[] = ['lead', 'order'];

// --- The layout grammar ----------------------------------------------------

export type DocumentBlockKind =
  | 'header'
  | 'party'
  | 'lines'
  | 'totals'
  | 'terms'
  | 'signature';

export type DocumentBlock =
  | { kind: 'header'; align: 'left' | 'centre' }
  | { kind: 'party' }
  | { kind: 'lines'; groupByProduct: boolean }
  | { kind: 'totals'; showBoxCount: boolean }
  | { kind: 'terms'; text: string }
  | { kind: 'signature'; label: string };

/** Block order and per-block options. Never a toggle — see the file header. */
export interface DocumentLayout {
  blocks: DocumentBlock[];
}

/** The five ways a `layout` can be ill-formed, as `details.reason` on a 400. */
export type LayoutViolation =
  | 'duplicate_kind'
  | 'missing_lines'
  | 'header_not_first'
  | 'signature_not_last'
  | 'terms_too_long';

/** `terms.text` ceiling, in characters. */
export const MAX_TERMS_LENGTH = 500;

// --- Records ---------------------------------------------------------------

export interface DocumentTemplate {
  id: Uuid;
  tenantId: Uuid;
  name: string;
  documentType: DocumentType;
  paperSize: PaperSize;
  orientation: PageOrientation;
  /** Millimetres. */
  margins: { top: number; right: number; bottom: number; left: number };

  // The eight switches. Typed BOOLEAN columns on `document_templates`.
  showRates: boolean;
  showColourChips: boolean;
  showTerms: boolean;
  showLogo: boolean;
  showSignature: boolean;
  showPageNumbers: boolean;
  showWatermark: boolean;
  showPartyBlock: boolean;

  watermarkText: string | null;
  termsText: string | null;
  footerText: string | null;
  /** `#RRGGBB`, matching the `pipeline_stages.colour` convention. */
  accentColour: string | null;
  locale: string | null;

  /** Block order and per-block options only. */
  layout: DocumentLayout;

  logoAssetId: Uuid | null;
  signatureAssetId: Uuid | null;
  isDefault: boolean;
  version: number;
  deletedAt: IsoTimestamp | null;
  /** A `US…` user id. */
  deletedBy: RecordId | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface DocumentAsset {
  id: Uuid;
  tenantId: Uuid;
  kind: DocumentAssetKind;
  filename: string;
  mimeType: 'image/png' | 'image/jpeg';
  byteSize: number;
  createdAt: IsoTimestamp;
}

export interface DocumentExport {
  /** BIGSERIAL as TEXT — `Number()` loses precision above 2^53. */
  id: string;
  tenantId: Uuid;
  /** Null once the template it was rendered from is deleted. */
  templateId: Uuid | null;
  /** Denormalised, so history still reads correctly after a rename. */
  templateName: string;
  documentType: DocumentType;
  subjectKind: DocumentSubjectKind;
  subjectId: RecordId;
  subjectLabel: string;
  fileName: string;
  byteSize: number;
  pageCount: number;
  /** The audit-grade fact that the copy sent to this customer carried no prices. */
  ratesIncluded: boolean;
  /** A `US…` user id, or null when an unattended panel rendered it. */
  renderedBy: RecordId | null;
  renderedByName: string | null;
  /** The id of the export that replaced this one, or null if this is the current one. */
  supersededBy: string | null;
  createdAt: IsoTimestamp;
}

export interface DocumentRenderResult {
  exportId: string;
  fileName: string;
  byteSize: number;
  pageCount: number;
  ratesIncluded: boolean;
  downloadPath: string;
}

/** Bytes travelling through a socket ack, for the Office Panel's forwarding path. */
export interface DocumentFilePayload {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

// --- Defaults --------------------------------------------------------------

/**
 * What the designer prefills with, and the in-memory template the renderer
 * falls back to when a tenant has saved none.
 *
 * Deliberately a constant rather than a seeded row, for the same reason
 * `ROLE_TEMPLATES` are templates rather than seeded roles: a seeded row is a
 * row somebody can edit into something the code did not expect, and a constant
 * cannot drift per installation. The migration seeds nothing.
 */
export type TemplateDefaults = Omit<
  DocumentTemplate,
  | 'id'
  | 'tenantId'
  | 'version'
  | 'deletedAt'
  | 'deletedBy'
  | 'createdAt'
  | 'updatedAt'
  | 'logoAssetId'
  | 'signatureAssetId'
  | 'isDefault'
>;

const SHARED_DEFAULTS = {
  paperSize: 'A4',
  orientation: 'portrait',
  margins: { top: 18, right: 15, bottom: 18, left: 15 },
  showColourChips: true,
  showTerms: true,
  showLogo: true,
  showSignature: false,
  showPageNumbers: true,
  showWatermark: false,
  showPartyBlock: true,
  watermarkText: null,
  footerText: null,
  accentColour: null,
  locale: null,
} as const;

export const TEMPLATE_DEFAULTS: Record<DocumentType, TemplateDefaults> = {
  quotation: {
    ...SHARED_DEFAULTS,
    name: 'Quotation',
    documentType: 'quotation',
    // A quotation exists to state a price. Rendering one with rates off is
    // legal — the actor may simply not hold `field.saleRate.view` — but it is
    // not what the default should assume.
    showRates: true,
    termsText: 'Rates are valid for 15 days from the date of this quotation.',
    layout: {
      blocks: [
        { kind: 'header', align: 'left' },
        { kind: 'party' },
        { kind: 'lines', groupByProduct: false },
        { kind: 'totals', showBoxCount: true },
        { kind: 'terms', text: '' },
      ],
    },
  },
  order_confirmation: {
    ...SHARED_DEFAULTS,
    name: 'Order Confirmation',
    documentType: 'order_confirmation',
    showRates: true,
    termsText: 'Goods once sold are not returnable.',
    layout: {
      blocks: [
        { kind: 'header', align: 'left' },
        { kind: 'party' },
        { kind: 'lines', groupByProduct: false },
        { kind: 'totals', showBoxCount: true },
        { kind: 'terms', text: '' },
        { kind: 'signature', label: 'Authorised Signatory' },
      ],
    },
  },
  dispatch_note: {
    ...SHARED_DEFAULTS,
    name: 'Dispatch Note',
    documentType: 'dispatch_note',
    // A dispatch note travels with the goods and is read by a driver and a
    // storeman. Prices on it are a liability, not a feature — so this is the
    // one default that ships with rates off.
    showRates: false,
    termsText: null,
    showTerms: false,
    layout: {
      blocks: [
        { kind: 'header', align: 'left' },
        { kind: 'party' },
        { kind: 'lines', groupByProduct: false },
        { kind: 'signature', label: 'Received in good condition' },
      ],
    },
  },
};
