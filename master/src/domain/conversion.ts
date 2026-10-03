/**
 * Lead → Order conversion rules (docs/LEAD_GENERATION_FLOW.md §5).
 *
 * The guarantees §5.2 asks to be explicitly tested all live here, in pure
 * functions with no I/O, so a test can assert them directly instead of
 * inferring them from database state (no stock is reserved: OrderBook keeps none):
 *
 *   1. Lines are copied **unchanged** — no recalculation, no re-reading the
 *      catalogue. A code or a weight edited on the variant after conversion
 *      must not change what the order was taken for.
 *   2. `packaging` is **never** auto-filled during conversion.
 */

import { ValidationError } from '../lib/errors.js';
import type { LineSnapshot } from './line-items.js';

/**
 * Copy a lead's lines onto its order.
 *
 * A structural clone rather than a rebuild. The temptation is to "refresh"
 * fields on the way through — pick up a corrected weight, a new alias — and
 * that temptation is exactly what §5.2 forbids, because the customer agreed to
 * what the lead said, not to what the catalogue says today.
 */
export function copyLinesForOrder(leadLines: LineSnapshot[]): LineSnapshot[] {
  return leadLines.map((line) => ({ ...line }));
}

/**
 * Guard the preconditions for converting.
 *
 * Note what is *not* checked: whether every variant has a weight. A missing
 * weight is surfaced on the order as a partial total rather than refused here.
 *
 * Pure: the company's switches arrive as `rules`, read by the caller. This
 * module does no I/O.
 */
export interface ConversionRules {
  /**
   * `leads.packagingRequiredOnConvert`.
   *
   * **Required, never defaulted.** A default here is precisely how the one call
   * site keeps the old behaviour while the Settings screen advertises a switch
   * that decides nothing — and the compiler would never say so, because a
   * defaulted parameter is exactly what a forgotten argument looks like.
   */
  packagingRequired: boolean;
}

export function assertConvertible(
  lead: {
    convertedOrderId: string | null;
    items: LineSnapshot[];
  },
  rules: ConversionRules,
): void {
  if (lead.convertedOrderId) {
    throw new ValidationError('validation.lead.alreadyConverted');
  }
  if (lead.items.length === 0) {
    throw new ValidationError('validation.lead.noItemsToConvert');
  }

  const empty = lead.items.filter((line) => line.quantity <= 0);
  if (empty.length > 0) {
    throw new ValidationError('validation.lead.quantityMissingOnConvert', {
      items: empty.map((line) => line.productName).join(', '),
    });
  }

  const unpackaged = rules.packagingRequired
    ? lead.items.filter((line) => !line.packaging?.trim())
    : [];
  if (unpackaged.length > 0) {
    // Packaging is never inferred, so for a company that requires it an unset
    // one has to be caught before the order exists rather than quietly
    // defaulted on the way through. Off — the default since catalogue v2,
    // whose lead entry does not ask for packaging — what was entered is still
    // carried onto the order; only the refusal goes.
    throw new ValidationError('validation.lead.packagingMissing', {
      items: unpackaged.map((line) => line.productName).join(', '),
    });
  }
}
