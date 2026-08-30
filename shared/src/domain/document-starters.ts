/**
 * Ready-made designs, for "add templates" — the request was for something to
 * duplicate and edit, not a blank page every time.
 *
 * Constants, not seeded rows, for the reason `TEMPLATE_DEFAULTS` already is
 * one: the migration seeds nothing on purpose, and a seeded row is a row
 * somebody can edit into something the code did not expect. "Use this design"
 * is a plain `createTemplate` call against the endpoint that already exists —
 * there is no new route, no new table, and nothing here is more than a
 * `TemplateDefaults` plus a name and a description.
 *
 * Each one is described as ordered blocks, the same as `TEMPLATE_DEFAULTS`,
 * because a starter says what a document *is* rather than where it sits on a
 * particular sheet — `blocksToElements` turns it into geometry once a page
 * size is known, at the same boundary every existing template goes through.
 */

import type { DocumentType } from './documents.js';
import { TEMPLATE_DEFAULTS, type TemplateDefaults } from './documents.js';
import type { MessageKey } from '../i18n/keys.js';

export interface StarterDesign {
  id: string;
  nameToken: MessageKey;
  descriptionToken: MessageKey;
  documentType: DocumentType;
  template: TemplateDefaults;
}

const QUOTATION = TEMPLATE_DEFAULTS.quotation;
const ORDER_CONFIRMATION = TEMPLATE_DEFAULTS.order_confirmation;
const DISPATCH_NOTE = TEMPLATE_DEFAULTS.dispatch_note;

export const STARTER_DESIGNS: readonly StarterDesign[] = [
  {
    id: 'quotation-classic',
    nameToken: 'documents.starter.quotationClassic.name',
    descriptionToken: 'documents.starter.quotationClassic.description',
    documentType: 'quotation',
    // The shipped default itself, under a name that says what it is next to
    // five others — this is the one a company with no strong opinion should
    // pick.
    template: { ...QUOTATION, name: 'Quotation — Classic' },
  },
  {
    id: 'quotation-compact',
    nameToken: 'documents.starter.quotationCompact.name',
    descriptionToken: 'documents.starter.quotationCompact.description',
    documentType: 'quotation',
    template: {
      ...QUOTATION,
      name: 'Quotation — Compact',
      margins: { top: 14, right: 12, bottom: 14, left: 12 },
      accentColour: '#0F766E',
      showColourChips: false,
      termsText: 'Rates valid for 15 days. E. & O.E.',
      layout: {
        blocks: [
          { kind: 'header', align: 'centre' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'totals', showBoxCount: false },
          { kind: 'terms', text: '' },
        ],
      },
    },
  },
  {
    id: 'order-confirmation',
    nameToken: 'documents.starter.orderConfirmation.name',
    descriptionToken: 'documents.starter.orderConfirmation.description',
    documentType: 'order_confirmation',
    template: { ...ORDER_CONFIRMATION, name: 'Order Confirmation' },
  },
  {
    id: 'dispatch-note',
    nameToken: 'documents.starter.dispatchNote.name',
    descriptionToken: 'documents.starter.dispatchNote.description',
    documentType: 'dispatch_note',
    template: { ...DISPATCH_NOTE, name: 'Dispatch Note' },
  },
  {
    id: 'proforma',
    nameToken: 'documents.starter.proforma.name',
    descriptionToken: 'documents.starter.proforma.description',
    // A proforma is a quotation with a heavier claim to being final — it
    // reads correctly against a lead or an order, which is what `quotation`
    // already means to `assertTemplateAppliesTo`.
    documentType: 'quotation',
    template: {
      ...QUOTATION,
      name: 'Proforma Invoice',
      accentColour: '#7C3AED',
      showWatermark: true,
      watermarkText: 'PROFORMA',
      showSignature: true,
      termsText: 'This is a proforma invoice for reference only and is not a demand for payment.',
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: false },
          { kind: 'totals', showBoxCount: true },
          { kind: 'terms', text: '' },
          { kind: 'signature', label: 'For the Seller' },
        ],
      },
    },
  },
  {
    id: 'letterhead',
    nameToken: 'documents.starter.letterhead.name',
    descriptionToken: 'documents.starter.letterhead.description',
    // `quotation` again, for the same reason as the proforma — nothing here
    // depends on rates, and the type only decides which subjects it can be
    // rendered against.
    documentType: 'quotation',
    template: {
      ...QUOTATION,
      name: 'Letterhead',
      // No rates, no party block, no terms: this is company stationery with a
      // small table on it, not a priced document. The table itself cannot be
      // dropped — a layout with none is refused, the same rule that has always
      // meant a document needs somewhere to put its line items.
      showRates: false,
      showPartyBlock: false,
      showTerms: false,
      showColourChips: false,
      termsText: null,
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'lines', groupByProduct: false },
        ],
      },
    },
  },
] as const;
