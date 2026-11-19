/**
 * The pending order PDF (V8, 2026-10-07): the same sheet as the Dispatch note, with a header and footer made for
 * a document that goes to a dealer. A fixed layout, no designer and no templates — the PDF Designer stays
 * removed.
 *
 * The owner asked for "the same format" as the notes: named lines on the left, coded products as a grid on the
 * right (three to a line, seven when they have the page), the same page strip. So this does not lay anything out:
 * it builds the note model and cuts it into pages with the notes' own `buildOrderNote` / `paginateOrderNote`
 * (`shared/src/domain/order-note.ts`), the code the preview and the print use, and hands the pages and the few
 * strings of this document's header to `pdf/note-renderer.ts`. Only the head and the foot differ: no vehicle,
 * the party in the strip, and a signature row whose Supervisor line carries the creator's name.
 *
 * The signature row is a correction (owner, 2026-11-18): it used to be left out — `signatures: false` — so no
 * PDF ever printed "Supervisor" at all. It is now drawn, with the record's `createdByName` filling that line.
 *
 * Pure: no PDFKit, no database, no clock (the moment is passed in). There is no money on this document: no line
 * carries any.
 *
 * Headings are English literals. Report PDFs print in English too, and the document goes to a dealer, not to
 * whoever clicked Preview in their own locale.
 */

import {
  buildOrderNote,
  paginateOrderNote,
  recordNumber,
  t,
  type ColourLabelOf,
  type NoteColumns,
} from '@orderbook/shared';
import type { Lead, Order, Party } from '@orderbook/shared';

import type { NotePdfInput } from '../pdf/note-renderer.js';

export function leadNotePdf(
  lead: Lead | Order,
  party: Party | null,
  companyName: string,
  printedAt: Date,
  /** The colour list's label for a stored value (`colourLabeller`), resolved at print time. */
  labelOf: ColourLabelOf = (colour) => colour,
  /** The saved tick boxes: an unticked column vanishes from this PDF too. */
  columns?: NoteColumns,
  /** The company switch (notes.defaultBold): regular faces when false. */
  bold?: boolean,
): NotePdfInput {
  const model = buildOrderNote(lead, labelOf);
  // An Order carries `leadCreatedAt`; a Lead does not — that is the whole difference
  // in what the sheet calls itself ("Final order" vs "New order").
  const isOrder = 'leadCreatedAt' in lead;
  return {
    title: isOrder ? t('en', 'orderNote.finalOrder') : t('en', 'orderNote.pendingOrder'),
    companyName,
    printedAt,
    partyName: party?.name?.trim() || lead.partyName,
    partyMeta: [party?.partyCode, party?.city].map((part) => part?.trim()).filter(Boolean).join(' · '),
    numberText: recordNumber(lead),
    notes: lead.notes?.trim() ?? '',
    // The signature row is drawn (owner, 2026-11-18): it carries the creator's
    // name at Supervisor, so its room is reserved here rather than given to lines.
    pages: paginateOrderNote(model, 'dispatch', { notes: lead.notes }),
    createdByName: (lead as { createdByName?: string | null }).createdByName ?? null,
    columns,
    bold,
    namedCount: model.named.length,
    codedCount: model.coded.reduce((sum, group) => sum + group.lines.length, 0),
    itemCount: model.itemCount,
    totalQuantity: model.totalQuantity,
    totalWeightKg: model.totalWeightKg,
  };
}

/**
 * The final order PDF: the same Dispatch sheet as the pending order PDF, with
 * a Final Order head (15x — closes the audit gap that final-order records had
 * no Preview PDF).
 */
export function orderNotePdf(
  order: Order,
  party: Party | null,
  companyName: string,
  printedAt: Date,
  /** The colour list's label for a stored value (`colourLabeller`), resolved at print time. */
  labelOf: ColourLabelOf = (colour) => colour,
  /** The saved tick boxes: an unticked column vanishes from this PDF too. */
  columns?: NoteColumns,
  /** The company switch (notes.defaultBold): regular faces when false. */
  bold?: boolean,
): NotePdfInput {
  const model = buildOrderNote(order, labelOf);
  return {
    title: t('en', 'orderNote.finalOrder'),
    companyName,
    printedAt,
    partyName: party?.name?.trim() || order.partyName,
    partyMeta: [party?.partyCode, party?.city].map((part) => part?.trim()).filter(Boolean).join(' · '),
    numberText: recordNumber(order),
    notes: order.notes?.trim() ?? '',
    // The signature row is drawn, as on the pending order's sheet (owner, 2026-11-18).
    pages: paginateOrderNote(model, 'dispatch', { notes: order.notes }),
    createdByName: order.createdByName ?? null,
    columns,
    bold,
    namedCount: model.named.length,
    codedCount: model.coded.reduce((sum, group) => sum + group.lines.length, 0),
    itemCount: model.itemCount,
    totalQuantity: model.totalQuantity,
    totalWeightKg: model.totalWeightKg,
  };
}
