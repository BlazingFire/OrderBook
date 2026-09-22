/**
 * Lead → Order conversion rules (docs/LEAD_GENERATION_FLOW.md §5).
 *
 * The three guarantees §5.2 asks to be explicitly tested all live here, in pure
 * functions with no I/O, so a test can assert them directly instead of
 * inferring them from database state:
 *
 *   1. Lines are copied **unchanged** — no recalculation, no re-reading the
 *      catalogue. A rate or a weight edited on the variant after conversion
 *      must not move what the order was quoted at.
 *   2. `packaging` is **never** auto-filled during conversion.
 *   3. Stock is reserved per **variant** — never aggregated to a product
 *      total, because a white basin does not satisfy a reservation for a
 *      blue one.
 */

import { ValidationError } from '../lib/errors.js';
import type { LineSnapshot } from './line-items.js';

/** One reservation to write: a single variant from a single line. */
export interface ReservationPlanEntry {
  productId: string;
  variantId: string;
  quantity: number;
  /** Which line it came from, so releasing one line does not release the rest. */
  lineIndex: number;
}

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
 * Which reservations an order's lines imply: one per line. Lines are kept
 * separate even when two of them name the same variant — releasing a single
 * line on a part-cancelled order has to release exactly that line's hold.
 */
export function planReservations(lines: LineSnapshot[]): ReservationPlanEntry[] {
  const plan: ReservationPlanEntry[] = [];

  lines.forEach((line, lineIndex) => {
    if (line.quantity <= 0) return;
    plan.push({ productId: line.productId, variantId: line.variantId, quantity: line.quantity, lineIndex });
  });

  return plan;
}

/**
 * What dispatching an order takes off the ledger: the reserved quantities,
 * summed per variant because the ledger records stock movements, not line
 * items.
 *
 * Always negative — the ledger stores a signed delta, never an absolute value,
 * so that replaying it reconstructs the running total.
 */
export function planDispatchMovements(
  reservations: Array<{ productId: string; variantId: string; quantity: number }>,
): Array<{ productId: string; variantId: string; quantityBoxes: number }> {
  const totals = new Map<string, { productId: string; variantId: string; quantityBoxes: number }>();

  for (const reservation of reservations) {
    const existing = totals.get(reservation.variantId);

    if (existing) {
      existing.quantityBoxes -= reservation.quantity;
    } else {
      totals.set(reservation.variantId, {
        productId: reservation.productId,
        variantId: reservation.variantId,
        quantityBoxes: -reservation.quantity,
      });
    }
  }

  return [...totals.values()];
}

/**
 * Guard the preconditions for converting.
 *
 * Note what is *not* checked: available stock, and whether every variant has
 * a weight. An order is never blocked by insufficient stock — a dealer
 * routinely sells against an undelivered factory order — and a missing weight
 * is surfaced on the order as a partial total rather than refused here.
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
    // Packaging is never inferred, so an unset one has to be caught before the
    // order exists rather than quietly defaulted on the way through — unless
    // the company has said otherwise, because a shop that packs to order
    // cannot state the packaging at the moment the lead converts. Off, what was
    // entered is still carried onto the order; only the refusal goes.
    throw new ValidationError('validation.lead.packagingMissing', {
      items: unpackaged.map((line) => line.productName).join(', '),
    });
  }
}
