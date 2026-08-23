/**
 * Stock reservations — stock committed to an order but not yet dispatched
 * (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * A reservation is not a ledger entry. Nothing leaves `stock_movements` until
 * dispatch; until then the hold only reduces what the *next* order can draw on.
 * Keeping the two separate is what makes "we have 40 boxes, 30 of them spoken
 * for" expressible, which a single running total cannot say.
 */

import type { StockReservation } from '@orderbook/shared';
import type { Knex } from 'knex';

import { stockKey } from '../domain/stock-key.js';
import { db } from '../db/knex.js';
import { allocatePermanentIds } from './identity.repository.js';
import { mapStockReservation } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'stock_reservations';

type Runner = Knex | Knex.Transaction;

export interface NewReservation {
  lineItemId: string;
  productId: string;
  colour: string;
  quantity: number;
}

export async function insertReservations(
  context: { tenantId: string; orderId: string },
  entries: NewReservation[],
  trx: TransactionContext,
): Promise<void> {
  if (entries.length === 0) return;

  const ids = await allocatePermanentIds(context.tenantId, 'reservation', entries.length, trx);

  await trx(TABLE).insert(
    entries.map((entry, index) => ({
      id: ids[index],
      tenant_id: context.tenantId,
      order_id: context.orderId,
      line_item_id: entry.lineItemId,
      product_id: entry.productId,
      colour: entry.colour,
      quantity: entry.quantity,
      status: 'active',
    })),
  );
}

export async function loadForOrders(
  tenantId: string,
  orderIds: string[],
  runner: Runner = db(),
): Promise<Map<string, StockReservation[]>> {
  const byOrder = new Map<string, StockReservation[]>();
  if (orderIds.length === 0) return byOrder;

  const rows = await runner(`${TABLE} as r`)
    .join('products as p', 'p.id', 'r.product_id')
    .where('r.tenant_id', tenantId)
    .whereIn('r.order_id', orderIds)
    .orderBy(['r.order_id', 'r.colour'])
    .select('r.*', 'p.name as product_name');

  for (const row of rows) {
    const reservation = mapStockReservation(row);
    const bucket = byOrder.get(reservation.orderId);
    if (bucket) bucket.push(reservation);
    else byOrder.set(reservation.orderId, [reservation]);
  }

  return byOrder;
}

export async function activeForOrder(
  tenantId: string,
  orderId: string,
  runner: Runner = db(),
): Promise<Array<{ productId: string; colour: string; quantity: number }>> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, order_id: orderId, status: 'active' })
    .select<Array<{ product_id: string; colour: string; quantity: string }>>(
      'product_id',
      'colour',
      'quantity',
    );

  return rows.map((row) => ({
    productId: row.product_id,
    colour: row.colour,
    quantity: Number(row.quantity),
  }));
}

/** Dispatch: the hold becomes a real movement, so it is consumed, not deleted. */
export async function consumeForOrder(
  tenantId: string,
  orderId: string,
  trx: TransactionContext,
): Promise<number> {
  return trx(TABLE)
    .where({ tenant_id: tenantId, order_id: orderId, status: 'active' })
    .update({ status: 'consumed', settled_at: trx.fn.now() });
}

/** Cancellation: the hold goes away without ever having touched the ledger. */
export async function releaseForOrder(
  tenantId: string,
  orderId: string,
  trx: TransactionContext,
): Promise<number> {
  return trx(TABLE)
    .where({ tenant_id: tenantId, order_id: orderId, status: 'active' })
    .update({ status: 'released', settled_at: trx.fn.now() });
}

/**
 * How much of each (product, colour) is currently held.
 *
 * Feeds the `reservedBoxes` figure on every stock level, which is what turns
 * "in stock" into the more useful "free to sell".
 */
export async function reservedTotals(
  tenantId: string,
  runner: Runner = db(),
): Promise<Map<string, number>> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, status: 'active' })
    .groupBy('product_id', 'colour')
    .select<Array<{ product_id: string; colour: string; total: string }>>(
      'product_id',
      'colour',
      runner.raw('SUM(quantity) as total'),
    );

  return new Map(rows.map((row) => [stockKey(row.product_id, row.colour), Number(row.total)]));
}
