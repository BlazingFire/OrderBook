/**
 * The lead PDF's table (`docs/catalogue/CATALOGUE_MODEL.md` §8): a fixed
 * layout, no designer and no templates — the PDF Designer stays removed.
 *
 * `# | [Brand] | Main product | Model | Size | Colour | Code | Qty`
 *
 * Pure: no PDFKit, no database, no clock (the date is passed in). What prints
 * where is decided here and only here; `pdf/table-renderer.ts` lays out the
 * strings it is handed and cannot add a column this file did not build — which
 * is also why there is no money on this document: no line carries any.
 *
 * Headings are English literals. Report PDFs print in English too
 * (`report.service` renders its labels in `en`), and the document goes to a
 * dealer, not to whoever clicked Preview in their own locale.
 */

import { lineColourText, recordNumber, subProductCells } from '@orderbook/shared';
import type { Lead, LineItem, Party } from '@orderbook/shared';

import type { ReportTablePdf } from '../pdf/table-renderer.js';

export function leadPdfTable(
  lead: Lead,
  party: Party | null,
  companyName: string,
  date: string,
): ReportTablePdf {
  // A single-brand lead would repeat one word down the page; the column earns
  // its width only when the lines span two brands.
  const brands = new Set(
    lead.items.map((line) => line.brandName?.trim().toLowerCase()).filter(Boolean),
  );
  const showBrand = brands.size > 1;

  const rows = groupBySubProduct(lead.items).map((lines, index) => {
    const first = lines[0]!;
    // The printed sub product lands in exactly one of Model or Code. The
    // software code (`line.code`, `OPT-0001`) is internal and never prints.
    const subProduct = subProductCells(first.productName);

    return [
      String(index + 1),
      ...(showBrand ? [first.brandName ?? ''] : []),
      first.categoryName ?? '',
      subProduct.model ?? '',
      first.size ?? '',
      lineColourText(lines, first.productName),
      subProduct.code ?? '',
      String(lines.reduce((total, line) => total + line.quantity, 0)),
    ];
  });

  return {
    title: companyName,
    subtitle: `Pending order ${recordNumber(lead)} · ${date}`,
    preamble: partyLines(lead, party),
    columns: [
      // Room for `999`: a figure never wraps, so row 100 would print as `1…`.
      { label: '#', numeric: true, weight: 4 },
      ...(showBrand ? [{ label: 'Brand', weight: 11 }] : []),
      { label: 'Main product', weight: 16 },
      { label: 'Model', weight: 19 },
      { label: 'Size', weight: 9 },
      // Colour gives Qty its width: this cell wraps and grows the row, where a
      // narrow Qty would truncate `1000` to `10…`.
      { label: 'Colour', weight: 14 },
      // Right-aligned: the numbered sub products (`1111`, `41`) read as figures.
      { label: 'Code', numeric: true, weight: 8 },
      { label: 'Qty', numeric: true, weight: 8 },
    ],
    rows,
    paperSize: 'a4',
    orientation: 'portrait',
  };
}

/**
 * The lines of one sub product, in the order the lead first holds each.
 *
 * A multicolour sub product sold in three colours is three lines on one
 * variant (§2); the customer reads it as one row, `White ×10, Ivory ×5,
 * Pink ×4`, with the pieces summed in Qty. Grouping every variant, not only
 * the multicolour ones, costs nothing: a fixed or dedicated sub product entered
 * twice is still one thing ordered.
 */
function groupBySubProduct(items: readonly LineItem[]): LineItem[][] {
  const groups = new Map<string, LineItem[]>();
  for (const line of items) {
    const group = groups.get(line.variantId);
    if (group) group.push(line);
    else groups.set(line.variantId, [line]);
  }
  return [...groups.values()];
}

/** Who the lead is for: the party's name, address, phone and GST, blanks dropped. */
function partyLines(lead: Lead, party: Party | null): string[] {
  return [
    party?.name ?? lead.partyName,
    party?.addressLine1,
    party?.addressLine2,
    [party?.city, party?.state, party?.pincode].filter(Boolean).join(' '),
    party?.phone,
    party?.gstNumber ? `GST: ${party.gstNumber}` : null,
  ]
    .map((line) => line?.trim() ?? '')
    .filter((line) => line.length > 0);
}
