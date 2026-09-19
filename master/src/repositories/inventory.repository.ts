/**
 * Stock data access, keyed per product variant
 * (docs/LEAD_GENERATION_FLOW.md §5.1).
 *
 * Three things work together:
 *  - `stock_movements` is an append-only ledger of **signed deltas**, never
 *    edited, so "why is stock at 42 boxes?" always has a reconstructible answer.
 *  - `inventory_stock` is a derived snapshot for fast reads.
 *  - `stock_reservations` holds what is committed to undispatched orders, so
 *    the snapshot can answer "free to sell" rather than only "on the floor".
 *
 * Every write goes through `applyMovement`, which updates ledger and snapshot in
 * one transaction — a ledger entry without its snapshot update (or the reverse)
 * would leave the two permanently disagreeing.
 */

import type { InventoryStockLevel, StockMovement, StockMovementType } from '@orderbook/shared';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { firstCount, mapStockLevel, mapStockMovement, toNumber } from './mappers.js';
import * as reservations from './reservation.repository.js';

type Runner = Knex | Knex.Transaction;

/**
 * Driven from `inventory_stock` joined back to its variant and product: a
 * product has one row *per variant*, so there is no single row to left-join
 * to. Variants that are reserved but have never been stocked are unioned in
 * at zero by `listStockLevels`, so nothing vanishes from the inventory screen.
 */
function stockQuery(tenantId: string, runner: Runner = db()) {
  return runner('inventory_stock as s')
    .join('product_variants as v', 'v.id', 's.variant_id')
    .join('products as p', 'p.id', 'v.product_id')
    .leftJoin('product_categories as c', 'c.id', 'p.category_id')
    .where('s.tenant_id', tenantId)
    .andWhere('p.is_active', true)
    .whereNull('p.deleted_at')
    .select(
      's.product_id',
      's.variant_id',
      'v.code as variant_code',
      'v.label as variant_label',
      'v.weight_kg',
      'p.name as product_name',
      'p.size',
      'p.box_coverage_sqft',
      'c.name as category_name',
      's.quantity_boxes',
      's.reorder_level',
      's.min_stock_level',
      's.max_stock_level',
      's.updated_at',
    );
}

export async function listStockLevels(
  tenantId: string,
  options: { search?: string; lowOnly?: boolean; limit: number; offset: number },
): Promise<InventoryStockLevel[]> {
  const query = stockQuery(tenantId);

  if (options.search) {
    const pattern = `%${options.search}%`;
    query.andWhere((builder) =>
      builder
        .whereILike('p.name', pattern)
        .orWhereILike('v.code', pattern)
        .orWhereILike('v.label', pattern)
        .orWhereILike('c.name', pattern),
    );
  }

  const rows = await query
    .orderBy(['p.name', 'v.sequence', 'v.code'])
    .limit(options.limit)
    .offset(options.offset);

  const held = await reservations.reservedTotals(tenantId);

  const levels = rows.map((row) =>
    mapStockLevel({ ...row, reserved_boxes: held.get(String(row.variant_id)) ?? 0 }),
  );

  // A variant can be reserved that has no stock row at all — someone sold blue
  // basins the shop has never carried. Driving the list from `inventory_stock`
  // alone would hide exactly that case, which is the one worth seeing, so the
  // reserved-but-unstocked variants are folded in at zero.
  levels.push(...(await unstockedReservations(tenantId, held, levels)));

  // Filtered after the reservation totals are known, because "low" is judged on
  // what is free to sell and SQL cannot see those totals in the same pass.
  const visible = options.lowOnly ? levels.filter((level) => level.isLow) : levels;

  return visible.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName) ||
      (a.variantLabel ?? '').localeCompare(b.variantLabel ?? '') ||
      a.variantCode.localeCompare(b.variantCode),
  );
}

/**
 * Stock rows that exist only as a reservation.
 *
 * Synthesised rather than written to `inventory_stock`, because nothing has
 * physically moved — inventing a zero row would put a variant in the ledger's
 * derived snapshot that no movement ever created.
 */
async function unstockedReservations(
  tenantId: string,
  held: Map<string, number>,
  existing: InventoryStockLevel[],
  runner: Runner = db(),
): Promise<InventoryStockLevel[]> {
  const known = new Set(existing.map((level) => level.variantId));
  const missing = [...held.entries()].filter(([variantId]) => !known.has(variantId));
  if (missing.length === 0) return [];

  const variants = await runner('product_variants as v')
    .join('products as p', 'p.id', 'v.product_id')
    .leftJoin('product_categories as c', 'c.id', 'p.category_id')
    .where('v.tenant_id', tenantId)
    .whereIn(
      'v.id',
      missing.map(([variantId]) => variantId),
    )
    .select(
      'v.id as variant_id',
      'v.product_id',
      'v.code as variant_code',
      'v.label as variant_label',
      'v.weight_kg',
      'p.name as product_name',
      'p.size',
      'p.box_coverage_sqft',
      'c.name as category_name',
    );

  const byId = new Map(variants.map((variant) => [String(variant.variant_id), variant]));

  return missing.flatMap(([variantId, quantity]) => {
    const variant = byId.get(variantId);
    if (!variant) return [];

    return [
      mapStockLevel({
        ...variant,
        quantity_boxes: 0,
        reserved_boxes: quantity,
        reorder_level: null,
        updated_at: null,
      }),
    ];
  });
}

export async function findStockLevel(
  tenantId: string,
  variantId: string,
  runner: Runner = db(),
): Promise<InventoryStockLevel | null> {
  const row = await stockQuery(tenantId, runner).andWhere('s.variant_id', variantId).first();

  const held = await reservations.reservedTotals(tenantId, runner);
  const reserved = held.get(variantId) ?? 0;

  if (row) return mapStockLevel({ ...row, reserved_boxes: reserved });

  // No stock row, but stock is reserved against this variant — report the
  // shortfall rather than nothing.
  if (reserved === 0) return null;

  const [synthetic] = await unstockedReservations(
    tenantId,
    new Map([[variantId, reserved]]),
    [],
    runner,
  );
  return synthetic ?? null;
}

export async function listMovements(
  tenantId: string,
  options: { productId?: string; variantId?: string; limit: number },
): Promise<StockMovement[]> {
  const query = db()('stock_movements as m')
    .join('products as p', 'p.id', 'm.product_id')
    .join('product_variants as v', 'v.id', 'm.variant_id')
    .where('m.tenant_id', tenantId)
    .select('m.*', 'p.name as product_name', 'v.code as variant_code', 'v.label as variant_label');

  if (options.productId) query.andWhere('m.product_id', options.productId);
  if (options.variantId) query.andWhere('m.variant_id', options.variantId);

  // Newest first: the movement list is read as "what happened recently".
  const rows = await query.orderBy('m.id', 'desc').limit(options.limit);
  return rows.map(mapStockMovement);
}

export interface MovementRequest {
  tenantId: string;
  productId: string;
  variantId: string;
  movementType: StockMovementType;
  /** Signed delta in boxes. Negative removes stock. */
  deltaBoxes: number;
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
  createdByUserId?: string | null;
}

/**
 * Append a ledger row and move the snapshot by the same amount, atomically.
 *
 * The snapshot moves by a relative `quantity_boxes + delta` rather than a value
 * read beforehand, so two concurrent movements cannot overwrite each other's
 * result — the row lock Postgres takes for the UPDATE serialises them.
 */
export async function applyMovement(
  request: MovementRequest,
  existingTrx?: Knex.Transaction,
): Promise<InventoryStockLevel> {
  const run = async (trx: Knex.Transaction): Promise<InventoryStockLevel> => {
    await trx('stock_movements').insert({
      tenant_id: request.tenantId,
      product_id: request.productId,
      variant_id: request.variantId,
      movement_type: request.movementType,
      quantity_boxes: request.deltaBoxes,
      reference_type: request.referenceType ?? null,
      reference_id: request.referenceId ?? null,
      note: request.note ?? null,
      created_by_user_id: request.createdByUserId ?? null,
    });

    await trx.raw(
      `INSERT INTO inventory_stock (id, tenant_id, product_id, variant_id, quantity_boxes, updated_at)
            VALUES (?, ?, ?, ?, ?, now())
       ON CONFLICT (tenant_id, variant_id) DO UPDATE
              SET quantity_boxes = inventory_stock.quantity_boxes + EXCLUDED.quantity_boxes,
                  updated_at     = now()`,
      [uuid(), request.tenantId, request.productId, request.variantId, request.deltaBoxes],
    );

    const level = await findStockLevel(request.tenantId, request.variantId, trx);
    if (!level) throw new Error('Stock level missing immediately after movement');
    return level;
  };

  return existingTrx ? run(existingTrx) : db().transaction(run);
}

/**
 * Set whichever of the three stock levels the caller actually asserted.
 *
 * **The subset is the whole point.** A single upsert with
 * `SET reorder_level = EXCLUDED.reorder_level, min_stock_level = …, max_stock_level = …`
 * would null min and max every time somebody used the existing "set the
 * reorder level" screen — which knows nothing about them and never will. That
 * is the same whole-record-replace defect the partial patch on products exists
 * to kill, and it would be reintroduced here by writing the obvious upsert.
 *
 * `undefined` is never bound, either: a knex positional binding of `undefined`
 * throws "Undefined binding(s)" rather than meaning anything.
 */
export async function setStockLevels(
  tenantId: string,
  target: { productId: string; variantId: string },
  levels: {
    reorderLevel?: number | null;
    minStockLevel?: number | null;
    maxStockLevel?: number | null;
  },
): Promise<InventoryStockLevel | null> {
  const asserted: Array<[column: string, value: number | null]> = [];

  if (levels.reorderLevel !== undefined) asserted.push(['reorder_level', levels.reorderLevel]);
  if (levels.minStockLevel !== undefined) asserted.push(['min_stock_level', levels.minStockLevel]);
  if (levels.maxStockLevel !== undefined) asserted.push(['max_stock_level', levels.maxStockLevel]);

  // Nothing asserted is not an error and not a write — it is a read.
  if (asserted.length === 0) return findStockLevel(tenantId, target.variantId);

  const columns = asserted.map(([column]) => column);
  const values = asserted.map(([, value]) => value);

  await db().raw(
    `INSERT INTO inventory_stock
       (id, tenant_id, product_id, variant_id, quantity_boxes, ${columns.join(', ')}, updated_at)
     VALUES (?, ?, ?, ?, 0, ${columns.map(() => '?').join(', ')}, now())
     ON CONFLICT (tenant_id, variant_id) DO UPDATE
            SET ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')},
                updated_at = now()`,
    [uuid(), tenantId, target.productId, target.variantId, ...values],
  );

  return findStockLevel(tenantId, target.variantId);
}

/**
 * The old name, kept so nothing above has to be renamed for a change that is
 * about what a caller may leave out, not about what the operation means.
 */
export const setReorderLevel = setStockLevels;

/**
 * Whether this order has already moved stock. The ledger is the only honest
 * record of what has been applied, so dispatching twice cannot double-count.
 */
export async function hasMovementForOrder(
  tenantId: string,
  orderId: string,
  runner: Runner = db(),
): Promise<boolean> {
  const row = await runner('stock_movements')
    .where({ tenant_id: tenantId, reference_type: 'order', reference_id: orderId })
    .first();
  return row !== undefined;
}

/** Variants at or below their reorder level, judged on free-to-sell stock. */
export async function countLowStock(tenantId: string): Promise<number> {
  const rows = await db()('inventory_stock')
    .where({ tenant_id: tenantId })
    .whereNotNull('reorder_level')
    .select<Array<{ variant_id: string; quantity_boxes: string; reorder_level: string }>>(
      'variant_id',
      'quantity_boxes',
      'reorder_level',
    );

  const held = await reservations.reservedTotals(tenantId);

  return rows.filter((row) => {
    const available = Number(row.quantity_boxes) - (held.get(String(row.variant_id)) ?? 0);
    return available <= Number(row.reorder_level);
  }).length;
}

/** Everything reserved but not stocked is short by definition. */
export async function countUnstockedReservations(tenantId: string): Promise<number> {
  const held = await reservations.reservedTotals(tenantId);
  if (held.size === 0) return 0;

  const rows = await db()('inventory_stock')
    .where({ tenant_id: tenantId })
    .select<Array<{ variant_id: string }>>('variant_id');

  const stocked = new Set(rows.map((row) => String(row.variant_id)));
  return [...held.keys()].filter((variantId) => !stocked.has(variantId)).length;
}

/** Total stock rows, used by the dashboard's product count sanity check. */
export async function countStockRows(tenantId: string): Promise<number> {
  const rows = await db()('inventory_stock')
    .where({ tenant_id: tenantId })
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

/** Box coverage, for the sqft mirror shown next to box quantities. */
export async function boxCoverage(
  tenantId: string,
  productId: string,
  runner: Runner = db(),
): Promise<number> {
  const row = await runner('products')
    .where({ tenant_id: tenantId, id: productId })
    .first<{ box_coverage_sqft: string | null } | undefined>('box_coverage_sqft');

  return toNumber(row?.box_coverage_sqft) ?? 0;
}
