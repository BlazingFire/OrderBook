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
import type {
  CustomFieldDefinition,
  DocumentElement,
  DocumentLayoutV2,
  ElementBand,
  ElementFlow,
  ElementTextStyle,
  TableColumnSpec,
} from '@orderbook/shared';

import { resolveBinding, type BindingContext } from './document-bindings.js';

import { formatDateForDocument, formatMinorUnits, type ScriptTag } from './document-text.js';
import type { TemplateShape } from './document-template.js';

export type DocumentColumnKey =
  | 'sequence'
  | 'category'
  | 'product'
  | 'code'
  | 'colours'
  | 'packaging'
  | 'grade'
  | 'quantity'
  | 'rate'
  | 'lineTotal'
  // Retired, never built — `size` used to sit between code and colours. Stored
  // layouts name columns by key and tolerate unknown ones, so removing the key
  // outright would turn an old layout's heading override into a key error
  // rather than a quiet no-op.
  | 'size';

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

/**
 * A placed element with nothing left to decide.
 *
 * The parallel of `DocumentColumn`: by the time one of these exists its text
 * has been resolved, its permission has been checked and its character limit
 * has been applied. An element the reader may not see is **not in the list** —
 * there is no `hidden` flag here for the same reason there is no zeroed total,
 * because a value on the page behind a flag is a value on the page.
 *
 * The renderer draws these and nothing else. It has no access to a binding, a
 * subject or a template, which is what makes a leak require deleting code
 * rather than forgetting a check.
 */
export type ResolvedElement =
  | {
      kind: 'text';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      z: number;
      band: ElementBand;
      flow: ElementFlow;
      /** Already resolved, already truncated to the element's character limit. */
      text: string;
      label: string | null;
      labelPlacement: 'none' | 'before' | 'above';
      style: ElementTextStyle;
    }
  | {
      kind: 'image';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      z: number;
      band: ElementBand;
      flow: ElementFlow;
      slot: 'logo' | 'signature';
    }
  | {
      kind: 'rule';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      z: number;
      band: ElementBand;
      flow: ElementFlow;
      colour: string | null;
      thickness: number;
    }
  | {
      kind: 'box';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      z: number;
      band: ElementBand;
      flow: ElementFlow;
      fill: string | null;
      stroke: string | null;
      radius: number;
    }
  | {
      kind: 'table';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      z: number;
      band: ElementBand;
      flow: ElementFlow;
      columns: TableColumnSpec[];
      rowHeightMm: number;
      headingHeightMm: number;
      repeatHeadingOnBreak: boolean;
      headingFill: string | null;
      groupByProduct: boolean;
      headingStyle: ElementTextStyle;
      cellStyle: ElementTextStyle;
    };

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

  /**
   * What to draw, in paint order, already resolved and already filtered.
   * An element the reader may not see never reached this list.
   */
  elements: ResolvedElement[];

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
  /** Already narrowed to version 2 by `normaliseLayout` at the mapper. */
  layout: DocumentLayoutV2;
  /**
   * The subject's own `custom_fields` blob and the tenant's definitions, so an
   * element may name a field somebody defined on the Fields screen. A
   * definition that has been deleted resolves to nothing and its element drops.
   */
  customFields?: {
    values: Record<string, unknown>;
    definitions: readonly CustomFieldDefinition[];
  };
}

export function buildDocumentModel(input: BuildDocumentModelInput): DocumentModel {
  const { subject, party, template, identity, ratesIncluded, colourHex } = input;

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

    terms: template.showTerms ? template.termsText?.trim() || null : null,
    signatureLabel: template.showSignature ? signatureLabelFrom(template) : null,
    watermark: input.forceWatermark ?? (template.showWatermark ? template.watermarkText : null),
    footer: template.footerText?.trim() || null,
    accentColour: template.accentColour,

    elements: resolveElements(input, boxCount, ratesIncluded),

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
  // Main product first, then the model — the hierarchy the counter sells in.
  // Colour reads as text (the `showColourChips` switch stays for the shops
  // that want swatches); packing and grade are the line's own answers.
  const columns: DocumentColumn[] = [
    { key: 'sequence', heading: '#', align: 'left', weight: 3, script: 'mono' },
    { key: 'category', heading: 'Main product', align: 'left', weight: 16, script: 'body' },
    { key: 'product', heading: 'Model', align: 'left', weight: 24, script: 'body' },
    { key: 'code', heading: 'Code', align: 'left', weight: 11, script: 'mono' },
    { key: 'colours', heading: 'Colour', align: 'left', weight: 18, script: 'body' },
    { key: 'packaging', heading: 'Packing', align: 'left', weight: 10, script: 'body' },
    { key: 'grade', heading: 'Grade', align: 'left', weight: 8, script: 'body' },
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
    category: line.categoryName ?? '',
    product: line.productName,
    code: line.code ?? '',
    colours: line.quantities.map((q) => `${q.colour} ×${q.quantity}`).join(', '),
    packaging: line.packaging ?? '',
    grade: line.grade ?? '',
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

/**
 * The signature caption.
 *
 * It used to be dug out of the `signature` block. Conversion turns that block
 * into a `text` element carrying the same words, so the label now travels as
 * part of the layout like every other piece of static text — this stays only
 * because the model still reports whether a signature line is expected at all.
 */
function signatureLabelFrom(template: TemplateShape): string | null {
  void template;
  return null;
}

/**
 * Turn placed elements into drawable ones, dropping every element this reader
 * is not entitled to.
 *
 * The one rule: **null means gone.** A binding that is money to a reader
 * without the rate permission, a binding behind a switch the operator turned
 * off, a custom field whose definition was deleted, a value the record simply
 * does not have — all four collapse into the same answer, and the answer is
 * that the element is not built. That is the same decision `buildColumns` makes
 * about the rate column, applied to geometry.
 */
function resolveElements(
  input: BuildDocumentModelInput,
  boxCount: number,
  ratesIncluded: boolean,
): ResolvedElement[] {
  const { template } = input;

  const context: BindingContext = {
    subject: input.subject,
    party: input.party,
    identity: input.identity,
    title: TITLES[template.documentType] ?? template.name,
    issuedOn: input.issuedOn,
    termsText: template.termsText,
    footerText: template.footerText,
    boxCount,
    grandTotal: ratesIncluded ? formatMinorUnits(totalAmountOf(input.subject)) : null,
  };

  const switches = {
    showPartyBlock: template.showPartyBlock,
    showTerms: template.showTerms,
    showSignature: template.showSignature,
    showRates: ratesIncluded,
  };

  const customFields = input.customFields ?? { values: {}, definitions: [] };
  const resolved: ResolvedElement[] = [];

  for (const element of [...input.layout.elements].sort((a, b) => a.z - b.z)) {
    const placed = resolveElement(
      element,
      context,
      switches,
      ratesIncluded,
      customFields,
      template,
    );
    if (placed) resolved.push(placed);
  }

  return resolved;
}

function resolveElement(
  element: DocumentElement,
  context: BindingContext,
  switches: {
    showPartyBlock: boolean;
    showTerms: boolean;
    showSignature: boolean;
    showRates: boolean;
  },
  ratesIncluded: boolean,
  customFields: {
    values: Record<string, unknown>;
    definitions: readonly CustomFieldDefinition[];
  },
  template: BuildDocumentModelInput['template'],
): ResolvedElement | null {
  const base = {
    id: element.id,
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    z: element.z,
    band: element.band,
    flow: element.flow,
  };

  switch (element.kind) {
    case 'text':
      return element.text.trim().length === 0
        ? null
        : {
            ...base,
            kind: 'text',
            text: applyCharacterLimit(element.text, element.style.maxChars),
            label: null,
            labelPlacement: 'none',
            style: element.style,
          };

    case 'field': {
      const value = resolveBinding(element.binding, context, switches, ratesIncluded, customFields);
      if (value === null) return null;

      return {
        ...base,
        kind: 'text',
        // Truncated here, before anything measures it, so a sixty-character
        // party name cannot burst a forty-millimetre box.
        text: applyCharacterLimit(value, element.style.maxChars),
        label: element.label,
        labelPlacement: element.labelPlacement,
        style: element.style,
      };
    }

    case 'image':
      // A signature is behind its own switch; a logo is behind `showLogo`, and
      // both are behind actually having the bytes, which the renderer checks.
      if (element.slot === 'signature' && !template.showSignature) return null;
      return { ...base, kind: 'image', slot: element.slot };

    case 'rule':
      return { ...base, kind: 'rule', colour: element.colour, thickness: element.thickness };

    case 'box':
      return {
        ...base,
        kind: 'box',
        fill: element.fill,
        stroke: element.stroke,
        radius: element.radius,
      };

    case 'table':
      return {
        ...base,
        kind: 'table',
        columns: element.columns,
        rowHeightMm: element.rowHeightMm,
        headingHeightMm: element.headingHeightMm,
        repeatHeadingOnBreak: element.repeatHeadingOnBreak,
        headingFill: element.headingFill,
        groupByProduct: element.groupByProduct,
        headingStyle: element.headingStyle,
        cellStyle: element.cellStyle,
      };
  }
}

/** 0 means no limit. An ellipsis is not appended here — the renderer's fit mode
 *  owns how overflow looks, and this owns how much data leaves the model. */
function applyCharacterLimit(value: string, maxChars: number): string {
  return maxChars > 0 && value.length > maxChars ? value.slice(0, maxChars) : value;
}
