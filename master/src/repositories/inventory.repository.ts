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
import { withDefaultReorderLevel } from '@orderbook/shared';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { mapStockLevel, mapStockMovement } from './mappers.js';
import * as reservationsRepo from './reservation.repository.js';

type Runner = Knex | Knex.Transaction;

/**
 * Driven from the **variant**, with its `inventory_stock` row left-joined: every
 * variant is a stock line whether or not a box of it was ever counted
 * (`docs/catalogue/CATALOGUE_MODEL.md` §7), so one never stocked reads 0 rather
 * than vanishing — and a variant reserved but never stocked needs no second
 * query to show its shortfall.
 *
 * No liveness filter here. This is also the single-row read behind every
 * movement, and a dispatch against a model deactivated since the order was
 * taken must still find its row; the listing adds its own filter.
 */
function stockQuery(tenantId: string, runner: Runner = db()) {
  return runner('product_variants as v')
    .join('products as p', 'p.id', 'v.product_id')
    .leftJoin('product_categories as c', 'c.id', 'p.category_id')
    .leftJoin('inventory_stock as s', (join) =>
      join.on('s.variant_id', 'v.id').andOn('s.tenant_id', 'v.tenant_id'),
    )
    .where('v.tenant_id', tenantId)
    .select(
      'v.product_id',
      'v.id as variant_id',
      'v.code as variant_code',
      'v.label as variant_label',
      'v.weight_kg',
      'p.name as product_name',
      'p.size',
      'p.multi_colour',
      'p.category_id',
      'c.name as category_name',
      'c.code as category_code',
      'c.brand',
      runner.raw('coalesce(s.quantity_boxes, 0) as quantity_boxes'),
      's.reorder_level',
      's.min_stock_level',
      's.max_stock_level',
      's.updated_at',
    );
}

export async function listStockLevels(
  tenantId: string,
  options: {
    search?: string;
    lowOnly?: boolean;
    /** A `product.brand` value, matched case-insensitively. */
    brand?: string;
    /** The category (the owner's Product). */
    categoryId?: string;
    /** Absent means every row — the low-stock count reads the whole list. */
    limit?: number;
    offset?: number;
    /**
     * False with the company's free-to-sell switch off: nothing is held back,
     * so free is the floor count, low stock is judged on it, and a variant
     * taken off the form that exists only as a reservation is not a row.
     */
    reservations?: boolean;
    /**
     * The company's low-stock level for any line that has none of its own.
     * `null`/absent means no default, which is exactly today's behaviour.
     */
    defaultReorderLevel?: number | null;
  },
): Promise<InventoryStockLevel[]> {
  const held =
    options.reservations === false ? new Map<string, number>() : await reservationsRepo.reservedTotals(tenantId);

  // Live, on-offer models only: a deleted or deactivated model is never a
  // stock line. A variant taken off the form stays while boxes of it are on
  // the floor or held for an order — those exist whatever the form says.
  const query = stockQuery(tenantId)
    .andWhere('p.is_active', true)
    .whereNull('p.deleted_at')
    .whereNull('v.deleted_at')
    .andWhere((builder) => {
      builder.where('v.is_active', true).orWhere('s.quantity_boxes', '<>', 0);
      if (held.size > 0) builder.orWhereIn('v.id', [...held.keys()]);
    });

  if (options.brand) query.whereRaw('lower(c.brand) = lower(?)', [options.brand]);
  if (options.categoryId) query.andWhere('p.category_id', options.categoryId);

  if (options.search) {
    const pattern = `%${options.search}%`;
    query.andWhere((builder) =>
      builder
        .whereILike('p.name', pattern)
        .orWhereILike('v.code', pattern)
        .orWhereILike('v.label', pattern)
        .orWhereILike('c.name', pattern)
        .orWhereILike('c.code', pattern)
        .orWhereILike('c.brand', pattern),
    );
  }

  // Catalogue order: the category's place, then the sub product's, then the
  // variant's. A name sort put `Vitrosa 100` before `Vitrosa 41`.
  query.orderByRaw(
    'c.sort_order ASC NULLS LAST, lower(c.name), c.id, p.sort_order ASC NULLS LAST, lower(p.name), p.id, v.sequence, v.id',
  );

  // Paged in SQL only when every row fetched is a row shown. "Low" is judged
  // on reservation totals SQL does not see in this pass, so a low-only page
  // filters first and slices after — slicing first returned short pages.
  const offset = options.offset ?? 0;
  if (!options.lowOnly && options.limit !== undefined) query.limit(options.limit).offset(offset);

  const rows = await query;
  const levels = rows.map((row) =>
    mapStockLevel({ ...row, reserved_boxes: held.get(String(row.variant_id)) ?? 0 }),
  );

  // The company's default low-stock level, for any line with none of its own.
  // Applied here rather than in the service because `lowOnly` filters on the
  // next line — a service-side pass would filter on the un-defaulted `isLow`
  // and then correct rows that had already been dropped.
  const judged =
    options.defaultReorderLevel === undefined || options.defaultReorderLevel === null
      ? levels
      : levels.map((level) => withDefaultReorderLevel(level, options.defaultReorderLevel ?? null));

  if (!options.lowOnly) return judged;

  const low = judged.filter((level) => level.isLow);
  return options.limit === undefined ? low : low.slice(offset, offset + options.limit);
}

/**
 * One variant's level — at zero when it has never been stocked, so a released
 * hold publishes the figure a panel should now show rather than nothing.
 * Null only for a variant that does not exist.
 */
export async function findStockLevel(
  tenantId: string,
  variantId: string,
  runner: Runner = db(),
): Promise<InventoryStockLevel | null> {
  const row = await stockQuery(tenantId, runner).andWhere('v.id', variantId).first();
  if (!row) return null;

  const held = await reservationsRepo.reservedTotals(tenantId, runner);
  return mapStockLevel({ ...row, reserved_boxes: held.get(variantId) ?? 0 });
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
 *
 * `runner` is the caller's transaction when there is one, so the write, the
 * read-back and the caller's audit entry commit together.
 */
export async function setStockLevels(
  tenantId: string,
  target: { productId: string; variantId: string },
  levels: {
    reorderLevel?: number | null;
    minStockLevel?: number | null;
    maxStockLevel?: number | null;
  },
  runner: Runner = db(),
): Promise<InventoryStockLevel | null> {
  const asserted: Array<[column: string, value: number | null]> = [];

  if (levels.reorderLevel !== undefined) asserted.push(['reorder_level', levels.reorderLevel]);
  if (levels.minStockLevel !== undefined) asserted.push(['min_stock_level', levels.minStockLevel]);
  if (levels.maxStockLevel !== undefined) asserted.push(['max_stock_level', levels.maxStockLevel]);

  // Nothing asserted is not an error and not a write — it is a read.
  if (asserted.length === 0) return findStockLevel(tenantId, target.variantId, runner);

  const columns = asserted.map(([column]) => column);
  const values = asserted.map(([, value]) => value);

  await runner.raw(
    `INSERT INTO inventory_stock
       (id, tenant_id, product_id, variant_id, quantity_boxes, ${columns.join(', ')}, updated_at)
     VALUES (?, ?, ?, ?, 0, ${columns.map(() => '?').join(', ')}, now())
     ON CONFLICT (tenant_id, variant_id) DO UPDATE
            SET ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')},
                updated_at = now()`,
    [uuid(), tenantId, target.productId, target.variantId, ...values],
  );

  return findStockLevel(tenantId, target.variantId, runner);
}

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

/**
 * Variants at or below their reorder level: the listing's own low-only rows,
 * counted. One query for the Dashboard tile and the Inventory "Low only"
 * filter means the two cannot disagree — the count used to scan
 * `inventory_stock` alone, and so counted deleted models and missed the
 * never-stocked ones the list showed.
 *
 * ponytail: reads the low rows to count them; a SQL count if the catalogue
 * grows past a few thousand variants.
 */
export async function countLowStock(
  tenantId: string,
  reservations = true,
  defaultReorderLevel: number | null = null,
): Promise<number> {
  const low = await listStockLevels(tenantId, { lowOnly: true, reservations, defaultReorderLevel });
  return low.length;
}
