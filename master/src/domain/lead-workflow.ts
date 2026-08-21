/**
 * The lead lifecycle state machine. A lead becomes an order by changing status
 * — the record never moves or gets copied (docs/schema/03-leads-orders-inventory.md).
 *
 * This module is pure business rules: no database, no transport, no framework.
 */

import type { LeadStatus } from '@orderbook/shared';

/** Which transitions are legal. Cancelled and delivered orders are terminal. */
const ALLOWED_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ['verified', 'cancelled'],
  verified: ['order', 'new', 'cancelled'],
  order: ['cancelled'],
  cancelled: [],
};

export function canTransitionLead(from: LeadStatus, to: LeadStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type StockEffect = 'deduct' | 'restore' | null;

/**
 * What a status transition means for inventory: becoming an order consumes
 * stock, cancelling an order returns it, everything else leaves stock alone.
 * Kept next to the transition table so the two rules cannot drift apart.
 */
export function stockEffectOfTransition(from: LeadStatus, to: LeadStatus): StockEffect {
  if (to === 'order') return 'deduct';
  if (to === 'cancelled' && from === 'order') return 'restore';
  return null;
}
