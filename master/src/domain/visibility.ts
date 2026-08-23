/**
 * Field-level visibility (docs/LEAD_GENERATION_FLOW.md §1, §9.5).
 *
 * A role without `field.saleRate.view` must receive records with the money
 * **absent** — key omitted, not set to null. The distinction is not pedantry:
 * `rate: null` is a factual claim that the line has no rate, which would show
 * up in the UI as a blank price rather than as a hidden one, and would let a
 * client compute a total of zero in perfect good faith.
 *
 * Applied on the way out of the service layer, over every read path including
 * search — search is just another read, so it goes through the same rule.
 */

import type { Lead, LineItem, Order, PartyProductVariant, Product } from '@orderbook/shared';
import { hasPermission } from '@orderbook/shared';

import type { ActorContext } from './actor.js';

export function canSeeRates(actor: ActorContext): boolean {
  return hasPermission(actor.permissions, 'field.saleRate.view');
}

export function maskLineItem(line: LineItem, allowed: boolean): LineItem {
  if (allowed) return line;

  const { rate: _rate, lineTotal: _lineTotal, ...visible } = line;
  return visible as LineItem;
}

export function maskProduct(product: Product, allowed: boolean): Product {
  if (allowed) return product;

  const { rate: _rate, pricePerSqft: _pricePerSqft, ...visible } = product;
  return visible as Product;
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
