/**
 * **The architectural seam.** An already-masked Lead or Order, plus a
 * template, plus the Master's identity, becomes a pure `DocumentModel`.
 * No PDF library is in scope here and none may be added.
 *
 * This is where rate redaction becomes a **layout** fact rather than a
 * rendering one: when `ratesIncluded` is false the rate and line-total columns
 * are **omitted from `model.columns`** and the totals block is dropped
 * entirely. The renderer then has nothing to decide — it draws the columns it
 * is given. A renderer that had to remember not to print a rate is a renderer
 * that will print one the first time somebody adds a code path.
 *
 * The masking has already happened upstream: `maskLead`/`maskOrder` **delete**
 * the `rate`/`lineTotal`/`totalAmount` keys for an actor without
 * `field.saleRate.view`. `ratesIncluded` is the second half of the same
 * decision — a template may also switch rates off for everybody, which is what
 * a dispatch note does.
 */

import type { Lead, LineItem, MasterIdentity, Order, Party } from '@orderbook/shared';

import {
  formatDateForDocument,
  formatMinorUnits,
  type ScriptTag,
} from './document-text.js';
import type { TemplateShape } from './document-template.js';

export type DocumentColumnKey =
  | 'sequence'
  | 'product'
  | 'code'
  | 'size'
  | 'colours'
  | 'quantity'
  | 'rate'
  | 'lineTotal';

export interface DocumentColumn {
  key: DocumentColumnKey;
  /** Already in the reader's language — the model is what gets drawn, not a token bag. */
  heading: string;
  align: 'left' | 'right';
  /** Relative width; the renderer normalises these against the printable width. */
  weight: number;
  /** Which vendored face this column's cells default to. */
  script: ScriptTag;
}

export interface DocumentColourChip {
  colour: string;
  quantity: number;
  /** `#RRGGBB` from the `stock.colour` option list, or null when the colour has no hex. */
  hex: string | null;
}

export interface DocumentRow {
  cells: Partial<Record<DocumentColumnKey, string>>;
  chips: DocumentColourChip[];
}

export interface DocumentTotals {
  boxCount: number;
  /** Absent — not zero — when rates are not included. */
  grandTotal?: string;
}

export interface DocumentModel {
  /** What the page says it is. */
  title: string;
  companyName: string;
  /** `LD…`/`OD…`, printed verbatim in the mono face so it can be typed back in. */
  reference: string;
  issuedOn: string;

  party: {
    name: string;
    lines: string[];
  } | null;

  columns: DocumentColumn[];
  rows: DocumentRow[];
  /** Absent entirely when rates are not included — not a zeroed block. */
  totals: DocumentTotals | null;

  terms: string | null;
  signatureLabel: string | null;
  watermark: string | null;
  footer: string | null;
  accentColour: string | null;

  /** Which blocks to draw, in order, already filtered by the eight switches. */
  blocks: TemplateShape['layout']['blocks'];

  /**
   * Recorded on the export row, and the single source of truth for whether
   * this particular file carried prices.
   */
  ratesIncluded: boolean;
  showColourChips: boolean;
  showPageNumbers: boolean;
}

const TITLES: Record<string, string> = {
  quotation: 'Quotation',
  order_confirmation: 'Order Confirmation',
  dispatch_note: 'Dispatch Note',
};

export interface BuildDocumentModelInput {
  subject: Lead | Order;
  subjectKind: 'lead' | 'order';
  party: Party | null;
  template: TemplateShape & {
    showRates: boolean;
    showColourChips: boolean;
    showTerms: boolean;
    showPartyBlock: boolean;
    showPageNumbers: boolean;
    showSignature: boolean;
    termsText: string | null;
    footerText: string | null;
  };
  identity: MasterIdentity | null;
  /** `template.showRates && canSeeRates(actor)` — decided by the caller, never here. */
  ratesIncluded: boolean;
  /** `#RRGGBB` per colour name, from the `stock.colour` option list. */
  colourHex: Map<string, string>;
  /**
   * The business day the document is issued on, `YYYY-MM-DD`, resolved by the
   * caller against `config.locale.timeZone` the way `report.service.ts` does.
   * It arrives from outside because the business timezone is configuration, and
   * configuration is not something this layer is allowed to read — a default
   * here would quietly fall back to the host machine's own clock, which is
   * wrong the moment the Master runs in a different zone from the business.
   */
  issuedOn: string;
  /** Forced on for a preview regardless of the template. */
  forceWatermark?: string | null;
}

export function buildDocumentModel(input: BuildDocumentModelInput): DocumentModel {
  const { subject, subjectKind, party, template, identity, ratesIncluded, colourHex } = input;

  const columns = buildColumns(ratesIncluded);
  const rows = subject.items.map((line, index) => buildRow(line, index, ratesIncluded, colourHex));

  const boxCount = subject.items.reduce((sum, line) => sum + line.totalQuantity, 0);

  return {
    title: TITLES[template.documentType] ?? template.name,
    companyName: identity?.companyName ?? '',
    reference: subject.id,
    issuedOn: formatDateForDocument(input.issuedOn),

    party:
      template.showPartyBlock && party
        ? { name: party.name, lines: partyAddressLines(party) }
        : null,

    columns,
    rows,
    // Absent entirely, never a zeroed block — a totals row reading ₹0.00 on a
    // document a customer receives is a claim about the price, not about the
    // reader's permissions.
    totals: ratesIncluded
      ? { boxCount, grandTotal: formatMinorUnits(totalAmountOf(subject)) }
      : null,

    terms: template.showTerms ? (template.termsText?.trim() || null) : null,
    signatureLabel: template.showSignature ? signatureLabelFrom(template) : null,
    watermark:
      input.forceWatermark ?? (template.showWatermark ? template.watermarkText : null),
    footer: template.footerText?.trim() || null,
    accentColour: template.accentColour,

    blocks: filterBlocks(template, ratesIncluded, subjectKind),

    ratesIncluded,
    showColourChips: template.showColourChips,
    showPageNumbers: template.showPageNumbers,
  };
}

/**
 * The rate and line-total columns are simply not built when rates are out.
 * There is deliberately no "present but hidden" state for them to fall into.
 */
function buildColumns(ratesIncluded: boolean): DocumentColumn[] {
  const columns: DocumentColumn[] = [
    { key: 'sequence', heading: '#', align: 'left', weight: 3, script: 'mono' },
    { key: 'product', heading: 'Product', align: 'left', weight: 26, script: 'body' },
    { key: 'code', heading: 'Code', align: 'left', weight: 12, script: 'mono' },
    { key: 'size', heading: 'Size', align: 'left', weight: 10, script: 'body' },
    { key: 'colours', heading: 'Colours', align: 'left', weight: 20, script: 'body' },
    { key: 'quantity', heading: 'Boxes', align: 'right', weight: 8, script: 'mono' },
  ];

  if (ratesIncluded) {
    columns.push(
      { key: 'rate', heading: 'Rate', align: 'right', weight: 10, script: 'mono' },
      { key: 'lineTotal', heading: 'Amount', align: 'right', weight: 11, script: 'mono' },
    );
  }

  return columns;
}

function buildRow(
  line: LineItem,
  index: number,
  ratesIncluded: boolean,
  colourHex: Map<string, string>,
): DocumentRow {
  const cells: Partial<Record<DocumentColumnKey, string>> = {
    sequence: String(index + 1),
    product: line.productName,
    code: line.code ?? '',
    size: line.size ?? '',
    colours: line.quantities.map((q) => `${q.colour} ×${q.quantity}`).join(', '),
    quantity: String(line.totalQuantity),
  };

  // `line.rate` is *absent* rather than null for a rate-blind actor, so the
  // key is never written here either — the redaction survives into the model
  // as the same absence it arrived as.
  if (ratesIncluded) {
    cells.rate = formatMinorUnits(line.rate);
    cells.lineTotal = formatMinorUnits(line.lineTotal);
  }

  return {
    cells,
    chips: line.quantities.map((q) => ({
      colour: q.colour,
      quantity: q.quantity,
      hex: colourHex.get(q.colour) ?? null,
    })),
  };
}

/**
 * `totalAmount` is optional on both Lead and Order and is *deleted* by masking.
 * Reading it through a nullish coalesce would turn "you may not see this" into
 * a confident zero, so the caller only reaches here when rates are included.
 */
function totalAmountOf(subject: Lead | Order): number | null {
  return subject.totalAmount ?? null;
}

function partyAddressLines(party: Party): string[] {
  const lines = [
    party.addressLine1,
    party.addressLine2,
    [party.city, party.state, party.pincode].filter(Boolean).join(' '),
    party.gstNumber ? `GST: ${party.gstNumber}` : null,
    party.phone,
  ];

  return lines.map((line) => line?.trim() ?? '').filter((line) => line.length > 0);
}

function signatureLabelFrom(template: TemplateShape): string | null {
  const block = template.layout.blocks.find((candidate) => candidate.kind === 'signature');
  return block && block.kind === 'signature' ? block.label : null;
}

/**
 * Drop blocks the switches have turned off, and the totals block when rates
 * are out — the model must not hand the renderer a block whose content it
 * deliberately did not build.
 */
function filterBlocks(
  template: BuildDocumentModelInput['template'],
  ratesIncluded: boolean,
  subjectKind: 'lead' | 'order',
): TemplateShape['layout']['blocks'] {
  void subjectKind;

  return template.layout.blocks.filter((block) => {
    switch (block.kind) {
      case 'party':
        return template.showPartyBlock;
      case 'totals':
        return ratesIncluded;
      case 'terms':
        return template.showTerms && (template.termsText?.trim().length ?? 0) > 0;
      case 'signature':
        return template.showSignature;
      default:
        return true;
    }
  });
}
