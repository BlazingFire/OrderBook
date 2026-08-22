/**
 * Stock management.
 *
 * Deliberate policy decision: an order is **never blocked** by insufficient
 * stock. A ceramic dealer routinely sells against a factory order that has not
 * arrived yet, so refusing to record the sale would break the actual business
 * workflow. Stock is allowed to go negative, and the shortfall is surfaced in
 * the UI instead — a negative figure is a signal to reorder, not a bug.
 */

import type {
  InventoryStockLevel,
  Lead,
  StockAdjustmentInput,
  StockInboundInput,
  StockMovement,
} from '@orderbook/shared';

import { actorUserId, type ActorContext } from '../domain/actor.js';
import { clampLimit, clampPaging } from '../domain/paging.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as inventoryRepo from '../repositories/inventory.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import type { TransactionContext } from '../repositories/transaction.js';
import { publishChange } from './change-bus.js';

const log = createLogger('inventory');

const PAGING = { defaultLimit: 200, maxLimit: 1000 };
const MOVEMENT_PAGING = { defaultLimit: 50, maxLimit: 200 };

export async function listStock(query: {
  search?: string;
  lowOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<InventoryStockLevel[]> {
  return inventoryRepo.listStockLevels({
    search: query.search,
    lowOnly: query.lowOnly ?? false,
    ...clampPaging(query, PAGING),
  });
}

export async function listMovements(query: {
  productId?: string;
  limit?: number;
}): Promise<StockMovement[]> {
  return inventoryRepo.listMovements({
    productId: query.productId,
    limit: clampLimit(query.limit, MOVEMENT_PAGING),
  });
}

export async function recordInbound(
  input: StockInboundInput,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  const quantity = Number(input.quantityBoxes);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ValidationError('Enter how many boxes arrived');
  }
  await assertProductExists(input.productId);

  const level = await inventoryRepo.applyMovement({
    productId: input.productId,
    movementType: 'inbound',
    deltaBoxes: quantity,
    referenceType: 'purchase',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });

  await recordAndPublish(level, actor, 'stock_in', { quantityBoxes: quantity, note: input.note ?? null });
  return level;
}

/**
 * Takes the counted total and derives the delta itself — staff count what is
 * physically on the floor rather than working out a difference.
 */
export async function recordAdjustment(
  input: StockAdjustmentInput,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  const counted = Number(input.quantityBoxes);
  if (!Number.isFinite(counted) || counted < 0) {
    throw new ValidationError('Enter the counted number of boxes');
  }
  await assertProductExists(input.productId);

  const current = await inventoryRepo.findStockLevel(input.productId);
  const delta = counted - (current?.quantityBoxes ?? 0);

  if (delta === 0) {
    // Nothing changed, so no ledger row: an audit trail full of no-ops is
    // harder to read than one that only records real movements.
    return current ?? (await requireStockLevel(input.productId));
  }

  const level = await inventoryRepo.applyMovement({
    productId: input.productId,
    movementType: 'adjustment',
    deltaBoxes: delta,
    referenceType: 'manual',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });

  await recordAndPublish(level, actor, 'stock_adjusted', {
    countedBoxes: counted,
    deltaBoxes: delta,
    note: input.note ?? null,
  });
  return level;
}

export async function setReorderLevel(
  productId: string,
  reorderLevel: number | null,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
    throw new ValidationError('Reorder level cannot be negative');
  }
  await assertProductExists(productId);

  const level = await inventoryRepo.setReorderLevel(productId, reorderLevel);
  if (!level) throw new NotFoundError('Product');

  await recordAndPublish(level, actor, 'reorder_level_set', { reorderLevel });
  return level;
}

/**
 * Called when a lead becomes an order. Runs inside the caller's transaction so
 * the status change and the stock movements commit or fail together.
 *
 * Idempotent: a lead that has already been deducted is left alone, so a status
 * change that reaches 'order' more than once cannot double-count.
 */
export async function applyOrderDeduction(
  lead: Lead,
  actor: ActorContext,
  trx: TransactionContext,
): Promise<void> {
  if (await inventoryRepo.hasMovementForLead(lead.id, 'outbound', trx)) {
    log.debug(`Lead ${lead.leadNumber} already deducted from stock; skipping`);
    return;
  }

  for (const item of lead.items) {
    const quantity = item.quantityBoxes;
    if (quantity == null || quantity <= 0) continue;

    await inventoryRepo.applyMovement(
      {
        productId: item.productId,
        movementType: 'outbound',
        deltaBoxes: -quantity,
        referenceType: 'order',
        referenceId: lead.id,
        note: `Order ${lead.leadNumber}`,
        createdByUserId: actorUserId(actor),
      },
      trx,
    );
  }

  log.info(`Stock deducted for order ${lead.leadNumber}`);
}

/**
 * Called when an order is cancelled: the goods were never delivered, so the
 * stock goes back. Recorded as a new inbound movement rather than by deleting
 * the outbound one — the ledger is append-only, and "sold then returned to
 * stock" is the truth.
 */
export async function reverseOrderDeduction(
  lead: Lead,
  actor: ActorContext,
  trx: TransactionContext,
): Promise<void> {
  const wasDeducted = await inventoryRepo.hasMovementForLead(lead.id, 'outbound', trx);
  if (!wasDeducted) return;

  if (await inventoryRepo.hasMovementForLead(lead.id, 'inbound', trx)) {
    log.debug(`Lead ${lead.leadNumber} stock already restored; skipping`);
    return;
  }

  for (const item of lead.items) {
    const quantity = item.quantityBoxes;
    if (quantity == null || quantity <= 0) continue;

    await inventoryRepo.applyMovement(
      {
        productId: item.productId,
        movementType: 'inbound',
        deltaBoxes: quantity,
        referenceType: 'order',
        referenceId: lead.id,
        note: `Cancelled order ${lead.leadNumber}`,
        createdByUserId: actorUserId(actor),
      },
      trx,
    );
  }

  log.info(`Stock restored for cancelled order ${lead.leadNumber}`);
}

/** Broadcast after a transaction commits, so listeners never see uncommitted state. */
export async function publishStockFor(productIds: string[]): Promise<void> {
  const unique = [...new Set(productIds)];

  for (const productId of unique) {
    const level = await inventoryRepo.findStockLevel(productId);
    if (level) publishChange({ entity: 'stock', action: 'updated', id: productId, payload: level });
  }
}

export async function countLowStock(): Promise<number> {
  return inventoryRepo.countLowStock();
}

async function assertProductExists(productId: string): Promise<void> {
  if (!(await productRepo.findProductById(productId))) throw new NotFoundError('Product');
}

async function requireStockLevel(productId: string): Promise<InventoryStockLevel> {
  const level = await inventoryRepo.findStockLevel(productId);
  if (!level) throw new NotFoundError('Product');
  return level;
}

async function recordAndPublish(
  level: InventoryStockLevel,
  actor: ActorContext,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await activityLog.recordActivity({
    entityType: 'stock',
    entityId: level.productId,
    action,
    actorType: actor.actorType,
    actorId: actor.actorId,
    details,
  });
  publishChange({ entity: 'stock', action: 'updated', id: level.productId, payload: level });
}
