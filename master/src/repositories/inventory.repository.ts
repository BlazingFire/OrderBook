/**
 * Stock data access.
 *
 * Two tables work together (docs/schema/03-leads-orders-inventory.md):
 *  - `stock_movements` is an append-only ledger, never edited, so "why is
 *    stock at 42 boxes?" always has a reconstructible answer.
 *  - `inventory_stock` is a derived snapshot for fast reads.
 *
 * Every write goes through `applyMovement`, which updates both inside one
 * transaction — a ledger entry without its snapshot update (or the reverse)
 * would leave the two permanently disagreeing.
 */

import type { InventoryStockLevel, StockMovement, StockMovementType } from '@orderbook/shared';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { toIso, toNumber, toRequiredIso, toRequiredNumber } from './mappers.js';

type Row = Record<string, unknown>;

function mapStockLevel(row: Row): InventoryStockLevel {
  const quantityBoxes = toRequiredNumber(row.quantity_boxes);
  const reorderLevel = toNumber(row.reorder_level);

  return {
    productId: String(row.product_id),
    productCode: String(row.product_code),
    productName: String(row.product_name),
    categoryName: (row.category_name as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    quantityBoxes,
    quantitySqft: toRequiredNumber(row.quantity_sqft),
    reorderLevel,
    isLow: reorderLevel !== null && quantityBoxes <= reorderLevel,
    updatedAt: toIso(row.updated_at),
  };
}

function mapMovement(row: Row): StockMovement {
  return {
    id: Number(row.id),
    productId: String(row.product_id),
    productCode: String(row.product_code ?? ''),
    productName: String(row.product_name ?? ''),
    movementType: row.movement_type as StockMovementType,
    quantityBoxes: toRequiredNumber(row.quantity_boxes),
    referenceType: (row.reference_type as string | null) ?? null,
    referenceId: (row.reference_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdAt: toRequiredIso(row.created_at),
  };
}

/**
 * Left join from products, so a product with no stock row yet still appears
 * (at zero) rather than vanishing from the inventory screen.
 */
function stockQuery(runner: Knex | Knex.Transaction = db()) {
  return runner('products as p')
    .leftJoin('inventory_stock as s', 's.product_id', 'p.id')
    .leftJoin('product_categories as c', 'c.id', 'p.category_id')
    .where('p.is_active', true)
    .select(
      'p.id as product_id',
      'p.product_code',
      'p.name as product_name',
      'p.size',
      'c.name as category_name',
      db().raw('COALESCE(s.quantity_boxes, 0) as quantity_boxes'),
      db().raw('COALESCE(s.quantity_sqft, 0) as quantity_sqft'),
      's.reorder_level',
      's.updated_at',
    );
}

export async function listStockLevels(options: {
  search?: string;
  lowOnly?: boolean;
  limit: number;
  offset: number;
}): Promise<InventoryStockLevel[]> {
  const query = stockQuery();

  if (options.search) {
    const pattern = `%${options.search}%`;
    query.andWhere((builder) =>
      builder
        .whereILike('p.name', pattern)
        .orWhereILike('p.product_code', pattern)
        .orWhereILike('c.name', pattern),
    );
  }

  if (options.lowOnly) {
    query.andWhereRaw('s.reorder_level IS NOT NULL AND COALESCE(s.quantity_boxes, 0) <= s.reorder_level');
  }

  const rows = await query.orderBy('p.name', 'asc').limit(options.limit).offset(options.offset);
  return rows.map(mapStockLevel);
}

export async function findStockLevel(
  productId: string,
  runner: Knex | Knex.Transaction = db(),
): Promise<InventoryStockLevel | null> {
  const row = await stockQuery(runner).andWhere('p.id', productId).first();
  return row ? mapStockLevel(row) : null;
}

export async function listMovements(options: {
  productId?: string;
  limit: number;
}): Promise<StockMovement[]> {
  const query = db()('stock_movements as m')
    .join('products as p', 'p.id', 'm.product_id')
    .select('m.*', 'p.product_code', 'p.name as product_name');

  if (options.productId) query.where('m.product_id', options.productId);

  // Newest first: the movement list is read as "what happened recently".
  const rows = await query.orderBy('m.id', 'desc').limit(options.limit);
  return rows.map(mapMovement);
}

export interface MovementRequest {
  productId: string;
  movementType: StockMovementType;
  /** Signed delta in boxes. Negative removes stock. */
  deltaBoxes: number;
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
  createdByUserId?: string | null;
}

/**
 * Appends a ledger row and moves the snapshot by the same amount, atomically.
 *
 * The snapshot is updated with a relative `quantity_boxes + delta` rather than
 * a value read beforehand, so two concurrent movements cannot overwrite each
 * other's result — the row lock Postgres takes for the UPDATE serialises them.
 */
export async function applyMovement(
  request: MovementRequest,
  existingTrx?: Knex.Transaction,
): Promise<InventoryStockLevel> {
  const run = async (trx: Knex.Transaction): Promise<InventoryStockLevel> => {
    await trx('stock_movements').insert({
      product_id: request.productId,
      movement_type: request.movementType,
      quantity_boxes: request.deltaBoxes,
      reference_type: request.referenceType ?? null,
      reference_id: request.referenceId ?? null,
      note: request.note ?? null,
      created_by_user_id: request.createdByUserId ?? null,
    });

    // Coverage is read per movement so the sqft mirror reflects the product's
    // current box coverage; boxes remain the authoritative quantity.
    const product = await trx('products').select('box_coverage_sqft').where({ id: request.productId }).first();
    const coverage = toNumber(product?.box_coverage_sqft) ?? 0;
    const deltaSqft = request.deltaBoxes * coverage;

    await trx.raw(
      `INSERT INTO inventory_stock (id, product_id, quantity_boxes, quantity_sqft, updated_at)
            VALUES (?, ?, ?, ?, now())
       ON CONFLICT (product_id) DO UPDATE
              SET quantity_boxes = inventory_stock.quantity_boxes + EXCLUDED.quantity_boxes,
                  quantity_sqft  = inventory_stock.quantity_sqft  + EXCLUDED.quantity_sqft,
                  updated_at     = now()`,
      [uuid(), request.productId, request.deltaBoxes, deltaSqft],
    );

    const level = await findStockLevel(request.productId, trx);
    if (!level) throw new Error('Stock level missing immediately after movement');
    return level;
  };

  return existingTrx ? run(existingTrx) : db().transaction(run);
}

export async function setReorderLevel(
  productId: string,
  reorderLevel: number | null,
): Promise<InventoryStockLevel | null> {
  await db().raw(
    `INSERT INTO inventory_stock (id, product_id, quantity_boxes, quantity_sqft, reorder_level, updated_at)
          VALUES (?, ?, 0, 0, ?, now())
     ON CONFLICT (product_id) DO UPDATE
            SET reorder_level = EXCLUDED.reorder_level,
                updated_at = now()`,
    [uuid(), productId, reorderLevel],
  );

  return findStockLevel(productId);
}

/**
 * Whether this lead has already moved stock in the given direction. Status can
 * be changed more than once, and the ledger is the only honest record of what
 * has already been applied.
 */
export async function hasMovementForLead(
  leadId: string,
  movementType: StockMovementType,
  runner: Knex | Knex.Transaction = db(),
): Promise<boolean> {
  const row = await runner('stock_movements')
    .where({ reference_type: 'order', reference_id: leadId, movement_type: movementType })
    .first();
  return row !== undefined;
}

export async function countLowStock(): Promise<number> {
  const rows = await db()('inventory_stock')
    .whereNotNull('reorder_level')
    .andWhereRaw('quantity_boxes <= reorder_level')
    .count<{ count: string }[]>('id as count');
  return Number(rows[0]?.count ?? 0);
}
