/**
 * The search box on the Pending Order and Final Order lists.
 *
 * One rule for every list on both panels: the words typed must each appear
 * somewhere in the record — its id, its PO number, party, owner, stage,
 * notes, the order it came from, or any of its lines (product, sub product,
 * code, colour, packaging, grade). Case-blind, order-blind, so "damru grass" finds a record
 * with a Damru line packed in Grass.
 */

import type { LineItem } from './entities.js';

export interface SearchableRecord {
  id: string;
  /** `PO/2026-27/00042`; a final order carries its pending order's. */
  poNumber?: string | null;
  partyName: string;
  ownerName?: string | null;
  stageName?: string | null;
  notes?: string | null;
  /** A final order's pending order, or a pending order's final order. */
  leadId?: string | null;
  convertedOrderId?: string | null;
  items: readonly LineItem[];
}

export function matchesRecordSearch(record: SearchableRecord, term: string): boolean {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const haystack = [
    record.id,
    record.poNumber,
    record.partyName,
    record.ownerName,
    record.stageName,
    record.notes,
    record.leadId,
    record.convertedOrderId,
    ...record.items.flatMap((item) => [
      item.productName,
      item.categoryName,
      item.brandName,
      item.code,
      item.variantLabel,
      item.colour,
      item.packaging,
      item.grade,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return words.every((word) => haystack.includes(word));
}
