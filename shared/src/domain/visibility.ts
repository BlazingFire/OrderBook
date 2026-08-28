/**
 * Field-level masking (docs/ROLES_AND_USERS.md §11, `roles-ui.md` §6).
 *
 * A role without `field.saleRate.view` must receive records with the money
 * **absent** — key omitted, not set to null. The distinction is not pedantry:
 * `rate: null` is a factual claim that the line has no rate, which shows up in a
 * UI as a blank price rather than a hidden one, and lets a client compute a
 * total of zero in perfect good faith.
 *
 * These live in `shared` rather than in the Master because **both** ends apply
 * them. The Master masks on the way out of its service layer; the Office Panel
 * has to mask again when it serves its *cached* snapshot, because the snapshot
 * on disk was fetched for whoever was signed in when the link last worked, and
 * the person signed in now may not be them. A second copy of these rules would
 * drift, and the drift would be a leak nobody could see.
 *
 * Deliberately pure and actor-free: whoever calls them decides `allowed`.
 */

import type { Lead, LineItem, Order, PartyProductVariant, Product } from './entities.js';

export function maskLineItem(line: LineItem, allowed: boolean): LineItem {
  if (allowed) return line;

  const { rate: _rate, lineTotal: _lineTotal, ...visible } = line;
  return visible as LineItem;
}

/**
 * A product is masked along **two** independent axes.
 *
 * What the company charges and what it pays are different secrets with
 * different audiences: a sales desk quotes the sale rate all day and must never
 * see the margin. Collapsing them into one boolean is what let `purchaseRate`
 * ride out to anybody holding `field.saleRate.view`.
 */
export interface ProductVisibility {
  rates: boolean;
  cost: boolean;
}

export function maskProduct(product: Product, visible: ProductVisibility): Product {
  let masked = product;

  if (!visible.rates) {
    const { rate: _rate, pricePerSqft: _pricePerSqft, ...rest } = masked;
    masked = rest as Product;
  }

  if (!visible.cost) {
    const { purchaseRate: _purchaseRate, ...rest } = masked;
    masked = rest as Product;
  }

  // `mrp` is deliberately never masked: it is printed on the box, so hiding it
  // would be theatre. Setting it is still gated, on `field.saleRate.edit`.
  return masked;
}

export function maskVariant(
  variant: PartyProductVariant,
  allowed: boolean,
): PartyProductVariant {
  if (allowed) return variant;

  const { rate: _rate, ...visible } = variant;
  return visible as PartyProductVariant;
}

export function maskLead(lead: Lead, allowed: boolean): Lead {
  if (allowed) return lead;

  const { totalAmount: _totalAmount, ...visible } = lead;
  return { ...visible, items: lead.items.map((line) => maskLineItem(line, false)) } as Lead;
}

export function maskOrder(order: Order, allowed: boolean): Order {
  if (allowed) return order;

  const { totalAmount: _totalAmount, ...visible } = order;
  return { ...visible, items: order.items.map((line) => maskLineItem(line, false)) } as Order;
}

/**
 * Ignore a client-supplied rate the actor is not allowed to set.
 *
 * Dropped rather than rejected, deliberately. A panel that has been offline for
 * a day replays whole line drafts, and those drafts legitimately carry the rate
 * the catalogue had at the time; refusing the entire mutation would reject work
 * somebody did in good faith. Dropping the field lets the line fall back to the
 * variant or the catalogue — the value the actor was entitled to anyway.
 */
export function withPermittedRate<T extends { rate?: number | null }>(
  draft: T,
  allowed: boolean,
): T {
  if (allowed || draft.rate === undefined) return draft;

  const { rate: _rate, ...rest } = draft;
  return rest as T;
}

/**
 * The same courtesy for the purchase rate, and for the same reason.
 *
 * Dropped rather than rejected: a panel replaying a day-old draft legitimately
 * carries whatever the catalogue held then, and refusing the whole mutation
 * would throw away work somebody did in good faith.
 */
export function withPermittedPurchaseRate<T extends { purchaseRate?: number | null }>(
  draft: T,
  allowed: boolean,
): T {
  if (allowed || draft.purchaseRate === undefined) return draft;

  const { purchaseRate: _purchaseRate, ...rest } = draft;
  return rest as T;
}
