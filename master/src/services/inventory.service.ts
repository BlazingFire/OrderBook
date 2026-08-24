/**
 * Inventory, now per (product, colour) and split between stock on the floor and
 * stock reserved for orders (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * The policy worth knowing before changing anything here: **an order is never
 * blocked by insufficient stock.** A ceramic dealer routinely sells against a
 * factory order that has not arrived, so a shortfall is surfaced — as a
 * negative available figure — rather than refused.
 */

import type {
  InventoryStockLevel,
  ReorderLevelInput,
  StockAdjustmentInput,
  StockInboundInput,
  StockListQuery,
  StockMovement,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampLimit, clampPaging } from '../domain/paging.js';
import { stockKey } from '../domain/stock-key.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as inventoryRepo from '../repositories/inventory.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { publishChange } from './change-bus.js';

const PAGING = { defaultLimit: 200, maxLimit: 1000 };
const MOVEMENT_PAGING = { defaultLimit: 50, maxLimit: 200 };

export async function listStock(
  query: StockListQuery,
  actor: ActorContext,
): Promise<InventoryStockLevel[]> {
  requirePermission(actor, 'inventory.view');

  return inventoryRepo.listStockLevels(actor.tenantId, {
    search: query.search,
    lowOnly: query.lowOnly,
    ...clampPaging(query, PAGING),
  });
}

export async function listMovements(
  query: { productId?: string; limit?: number },
  actor: ActorContext,
): Promise<StockMovement[]> {
  requirePermission(actor, 'inventory.view');

  return inventoryRepo.listMovements(actor.tenantId, {
    productId: query.productId,
    limit: clampLimit(query.limit, MOVEMENT_PAGING),
  });
}

/** Stock arriving from the factory or a purchase — always a positive delta. */
export async function recordInbound(
  input: StockInboundInput,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  requirePermission(actor, 'inventory.edit');

  const colour = requireColour(input.colour);
  await assertProductExists(actor.tenantId, input.productId);

  if (!Number.isFinite(input.quantityBoxes) || input.quantityBoxes <= 0) {
    throw new ValidationError('Enter how many boxes arrived');
  }

  const level = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: input.productId,
    colour,
    movementType: 'inbound',
    deltaBoxes: input.quantityBoxes,
    referenceType: 'purchase',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'stock',
    entityId: input.productId,
    action: 'inbound',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { colour, quantityBoxes: input.quantityBoxes },
  }, db());
  publishChange({ entity: 'stock', action: 'updated', id: stockKey(input.productId, colour), payload: level });

  return level;
}

/**
 * A correction after a physical count.
 *
 * `quantityBoxes` is the **counted total**, not a delta — staff count what is
 * on the shelf, they do not do arithmetic. The service computes the signed
 * difference, because the ledger only ever stores deltas.
 */
export async function recordAdjustment(
  input: StockAdjustmentInput,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  // Correcting a count is a distinct capability from ordinary stock entry: it
  // rewrites a figure nobody can re-derive, so it is granted separately.
  requirePermission(actor, 'stock.adjust');

  const colour = requireColour(input.colour);
  await assertProductExists(actor.tenantId, input.productId);

  if (!Number.isFinite(input.quantityBoxes) || input.quantityBoxes < 0) {
    throw new ValidationError('Enter the counted number of boxes');
  }

  const current = await inventoryRepo.findStockLevel(actor.tenantId, input.productId, colour);
  const delta = input.quantityBoxes - (current?.quantityBoxes ?? 0);

  if (delta === 0) {
    return (
      current ?? {
        ...emptyLevel(input.productId, colour),
      }
    );
  }

  const level = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: input.productId,
    colour,
    movementType: 'adjustment',
    deltaBoxes: delta,
    referenceType: 'manual',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'stock',
    entityId: input.productId,
    action: 'adjusted',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { colour, countedBoxes: input.quantityBoxes, delta },
  }, db());
  publishChange({ entity: 'stock', action: 'updated', id: stockKey(input.productId, colour), payload: level });

  return level;
}

export async function setReorderLevel(
  input: ReorderLevelInput,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  requirePermission(actor, 'inventory.edit');

  const colour = requireColour(input.colour);
  await assertProductExists(actor.tenantId, input.productId);

  if (input.reorderLevel !== null && input.reorderLevel < 0) {
    throw new ValidationError('A reorder level cannot be negative');
  }

  const level = await inventoryRepo.setReorderLevel(
    actor.tenantId,
    input.productId,
    colour,
    input.reorderLevel,
  );
  if (!level) throw new NotFoundError('Stock level');

  publishChange({ entity: 'stock', action: 'updated', id: stockKey(input.productId, colour), payload: level });
  return level;
}

/**
 * Push fresh stock figures for the given (product, colour) pairs.
 *
 * Called after a transaction commits, never inside one — a panel that received
 * figures from a transaction which then rolled back would show numbers that
 * never existed, and nothing would arrive later to correct them.
 */
export async function publishStockFor(
  tenantId: string,
  targets: Array<{ productId: string; colour: string }>,
): Promise<void> {
  const seen = new Set<string>();

  for (const target of targets) {
    const key = stockKey(target.productId, target.colour);
    if (seen.has(key)) continue;
    seen.add(key);

    const level = await inventoryRepo.findStockLevel(tenantId, target.productId, target.colour);
    if (level) publishChange({ entity: 'stock', action: 'updated', id: key, payload: level });
  }
}

export async function countLowStock(tenantId: string): Promise<number> {
  return inventoryRepo.countLowStock(tenantId);
}

export async function coloursFor(tenantId: string, productId: string): Promise<string[]> {
  return inventoryRepo.coloursFor(tenantId, productId);
}

function requireColour(colour: string | undefined): string {
  const trimmed = colour?.trim();
  if (!trimmed) {
    // Not defaulted: stock is tracked per colour, and silently filing boxes
    // under "Default" would put real stock somewhere nobody looks for it.
    throw new ValidationError('Choose which colour this stock is for');
  }
  return trimmed;
}

async function assertProductExists(tenantId: string, productId: string): Promise<void> {
  if (!(await productRepo.findProductById(tenantId, productId))) {
    throw new NotFoundError('Product');
  }
}

function emptyLevel(productId: string, colour: string): InventoryStockLevel {
  return {
    productId,
    productCode: '',
    productName: '',
    categoryName: null,
    size: null,
    colour,
    quantityBoxes: 0,
    reservedBoxes: 0,
    availableBoxes: 0,
    quantitySqft: 0,
    reorderLevel: null,
    isLow: false,
    updatedAt: null,
  };
}
