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
  {
    id: 'tax-invoice',
    nameToken: 'documents.starter.taxInvoice.name',
    descriptionToken: 'documents.starter.taxInvoice.description',
    // `quotation` is the type that carries rates and renders against a lead or
    // an order, which is what an invoice needs. The product raises no invoices
    // of its own — this is the priced sheet a buyer files, not a ledger entry.
    documentType: 'quotation',
    template: {
      ...QUOTATION,
      name: 'Tax Invoice',
      accentColour: '#B45309',
      showSignature: true,
      termsText:
        'Payment due within 30 days. Interest at 18% per annum on overdue amounts. E. & O.E.',
      footerText: 'GSTIN and place of supply as registered.',
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
  },
  {
    id: 'quotation-counter-a5',
    nameToken: 'documents.starter.counterQuote.name',
    descriptionToken: 'documents.starter.counterQuote.description',
    documentType: 'quotation',
    template: {
      ...QUOTATION,
      name: 'Counter Quote — A5',
      // Half a sheet, written across a showroom counter while somebody waits.
      // A5 is 148mm tall, so the margins have to leave the 100mm of body the
      // template validator insists on: 10 + 10 is well inside that.
      paperSize: 'A5',
      margins: { top: 10, right: 8, bottom: 10, left: 8 },
      showTerms: false,
      termsText: null,
      showColourChips: false,
      showPageNumbers: false,
      layout: {
        blocks: [
          { kind: 'header', align: 'centre' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'totals', showBoxCount: true },
        ],
      },
    },
  },
  {
    id: 'credit-note',
    nameToken: 'documents.starter.creditNote.name',
    descriptionToken: 'documents.starter.creditNote.description',
    documentType: 'quotation',
    template: {
      ...QUOTATION,
      name: 'Credit Note',
      // Breakage and returns are ordinary in ceramics, and the paper that
      // records them has to be unmistakable at a glance — hence the watermark
      // and the red accent rather than a differently-worded quotation.
      accentColour: '#B91C1C',
      showWatermark: true,
      watermarkText: 'CREDIT NOTE',
      showSignature: true,
      termsText: 'Credit issued against goods returned or short-supplied. Not a demand for payment.',
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
  },
  {
    id: 'order-confirmation-wide',
    nameToken: 'documents.starter.orderConfirmationWide.name',
    descriptionToken: 'documents.starter.orderConfirmationWide.description',
    documentType: 'order_confirmation',
    template: {
      ...ORDER_CONFIRMATION,
      name: 'Order Confirmation — Wide',
      // Landscape, for an order whose lines carry many colours: the chips run
      // along the row, and portrait runs out of width before it runs out of
      // page.
      orientation: 'landscape',
      margins: { top: 14, right: 16, bottom: 14, left: 16 },
      showColourChips: true,
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'totals', showBoxCount: true },
          { kind: 'signature', label: 'Authorised Signatory' },
        ],
      },
    },
  },
  {
    id: 'work-order',
    nameToken: 'documents.starter.workOrder.name',
    descriptionToken: 'documents.starter.workOrder.description',
    documentType: 'order_confirmation',
    template: {
      ...ORDER_CONFIRMATION,
      name: 'Production Work Order',
      // What goes to the kiln floor. Rates are off deliberately: the sheet is
      // handled by people who need the sizes and the colours and have no
      // business seeing what the customer paid.
      accentColour: '#0369A1',
      showRates: false,
      showColourChips: true,
      showTerms: false,
      termsText: null,
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'signature', label: 'Supervisor' },
        ],
      },
    },
  },
  {
    id: 'packing-list',
    nameToken: 'documents.starter.packingList.name',
    descriptionToken: 'documents.starter.packingList.description',
    documentType: 'dispatch_note',
    template: {
      ...DISPATCH_NOTE,
      name: 'Packing List',
      // Grouped by product and showing the colour chips, because this is the
      // sheet somebody ticks off against the boxes as they go on the truck.
      // No totals block: rates are off, and the renderer drops totals whenever
      // they are.
      showColourChips: true,
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'signature', label: 'Packed by' },
        ],
      },
    },
  },
  {
    id: 'delivery-challan',
    nameToken: 'documents.starter.deliveryChallan.name',
    descriptionToken: 'documents.starter.deliveryChallan.description',
    documentType: 'dispatch_note',
    template: {
      ...DISPATCH_NOTE,
      name: 'Delivery Challan',
      // The document that travels with goods in transit. Unpriced, signed at
      // the far end, and named the way a transporter and a checkpoint expect
      // to see it named.
      accentColour: '#334155',
      showTerms: true,
      termsText:
        'Goods described above are sent on delivery challan and remain the property of the consignor until accepted.',
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: false },
          { kind: 'terms', text: '' },
          { kind: 'signature', label: 'Received in good condition' },
        ],
      },
    },
  },
  {
    id: 'sample-dispatch',
    nameToken: 'documents.starter.sampleDispatch.name',
    descriptionToken: 'documents.starter.sampleDispatch.description',
    documentType: 'dispatch_note',
    template: {
      ...DISPATCH_NOTE,
      name: 'Sample Dispatch Note',
      // Samples leave the building constantly and must never be mistaken for
      // a priced consignment — the watermark is the whole point of this one.
      accentColour: '#15803D',
      showWatermark: true,
      watermarkText: 'SAMPLE',
      showColourChips: true,
      showTerms: true,
      termsText: 'Samples issued free of charge for approval. Not for resale.',
      layout: {
        blocks: [
          { kind: 'header', align: 'left' },
          { kind: 'party' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'terms', text: '' },
          { kind: 'signature', label: 'Issued by' },
        ],
      },
    },
  },
] as const;
