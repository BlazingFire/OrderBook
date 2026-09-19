/**
 * Inventory, per product variant and split between stock on the floor and
 * stock reserved for orders (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * The policy worth knowing before changing anything here: **an order is never
 * blocked by insufficient stock.** A dealer routinely sells against a factory
 * order that has not arrived, so a shortfall is surfaced — as a negative
 * available figure — rather than refused.
 */

import type {
  InventoryStockLevel,
  ProductVariant,
  ReorderLevelInput,
  StockAdjustmentInput,
  StockInboundInput,
  StockListQuery,
  StockMovement,
} from '@orderbook/shared';
import { ProductValidationError, validateStockLevels } from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampLimit, clampPaging } from '../domain/paging.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as inventoryRepo from '../repositories/inventory.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
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

  const { variant, productName } = await requireVariant(actor.tenantId, input.variantId);

  if (!Number.isFinite(input.quantityBoxes) || input.quantityBoxes <= 0) {
    throw new ValidationError('validation.stock.boxesArrivedRequired');
  }

  const level = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: variant.productId,
    variantId: variant.id,
    movementType: 'inbound',
    deltaBoxes: input.quantityBoxes,
    referenceType: 'purchase',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });

  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'stock',
      entityId: variant.productId,
      action: 'inbound',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: {
        product: productName,
        quantity: input.quantityBoxes,
        variant: variant.label ?? variant.code,
        code: variant.code,
      },
    },
    actor,
    db(),
  );
  publishChange({ entity: 'stock', action: 'updated', id: variant.id, payload: level });

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

  const { variant, productName } = await requireVariant(actor.tenantId, input.variantId);

  if (!Number.isFinite(input.quantityBoxes) || input.quantityBoxes < 0) {
    throw new ValidationError('validation.stock.countedBoxesRequired');
  }

  const current = await inventoryRepo.findStockLevel(actor.tenantId, variant.id);
  const delta = input.quantityBoxes - (current?.quantityBoxes ?? 0);

  if (delta === 0) {
    return current ?? emptyLevel(variant, productName);
  }

  const level = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: variant.productId,
    variantId: variant.id,
    movementType: 'adjustment',
    deltaBoxes: delta,
    referenceType: 'manual',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });

  await activityLog.recordDetachedActivity(
    {
      tenantId: actor.tenantId,
      entityType: 'stock',
      entityId: variant.productId,
      action: 'adjusted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: {
        product: productName,
        variant: variant.label ?? variant.code,
        code: variant.code,
        countedBoxes: input.quantityBoxes,
        delta,
      },
    },
    actor,
    db(),
  );
  publishChange({ entity: 'stock', action: 'updated', id: variant.id, payload: level });

  return level;
}

/**
 * The shared stock-level validator, re-thrown in this codebase's currency.
 *
 * Same arrangement as `assertProductInput` in the catalogue service, and for
 * the same reason: the rules live in `shared` because the offline merge path
 * needs them too, and `shared` cannot import the Master's error hierarchy.
 */
function assertStockLevels(input: ReorderLevelInput): void {
  try {
    validateStockLevels(input);
  } catch (error) {
    if (error instanceof ProductValidationError) throw new ValidationError(error.messageKey);
    throw error;
  }
}

export async function setReorderLevel(
  input: ReorderLevelInput,
  actor: ActorContext,
): Promise<InventoryStockLevel> {
  requirePermission(actor, 'inventory.edit');

  const { variant } = await requireVariant(actor.tenantId, input.variantId);

  // The band, checked here as well as by the database's own CHECK — a person
  // waiting on a form deserves a sentence, not a constraint name.
  assertStockLevels(input);

  const level = await inventoryRepo.setStockLevels(
    actor.tenantId,
    { productId: variant.productId, variantId: variant.id },
    {
      // Passed through as-is, `undefined` included: absent means untouched, and
      // the repository writes only what was asserted.
      reorderLevel: input.reorderLevel,
      minStockLevel: input.minStockLevel,
      maxStockLevel: input.maxStockLevel,
    },
  );
  if (!level) throw new NotFoundError('Stock level');

  publishChange({ entity: 'stock', action: 'updated', id: variant.id, payload: level });
  return level;
}

/**
 * Push fresh stock figures for the given variants.
 *
 * Called after a transaction commits, never inside one — a panel that received
 * figures from a transaction which then rolled back would show numbers that
 * never existed, and nothing would arrive later to correct them.
 */
export async function publishStockFor(tenantId: string, variantIds: readonly string[]): Promise<void> {
  for (const variantId of new Set(variantIds)) {
    const level = await inventoryRepo.findStockLevel(tenantId, variantId);
    if (level) publishChange({ entity: 'stock', action: 'updated', id: variantId, payload: level });
  }
}

export async function countLowStock(tenantId: string): Promise<number> {
  return inventoryRepo.countLowStock(tenantId);
}

/**
 * The variant this movement is against, or a refusal.
 *
 * Returns the product's name alongside because the audit entry needs it: the
 * catalogue renders "recorded {quantity} boxes in for {product}", and with
 * nothing to fill `{product}` the Activity log printed the placeholder.
 */
async function requireVariant(
  tenantId: string,
  variantId: string | undefined,
): Promise<{ variant: ProductVariant; productName: string }> {
  const id = variantId?.trim();
  if (!id) {
    // Not defaulted: stock is tracked per variant, and silently filing boxes
    // under some first variant would put real stock somewhere nobody looks.
    throw new ValidationError('validation.stock.variantRequired');
  }

  const variant = await productVariantRepo.findVariantById(tenantId, id);
  if (!variant) throw new NotFoundError('Product variant');

  const product = await productRepo.findProductById(tenantId, variant.productId);
  if (!product) throw new NotFoundError('Product');

  return { variant, productName: product.name };
}

function emptyLevel(variant: ProductVariant, productName: string): InventoryStockLevel {
  return {
    productId: variant.productId,
    productName,
    categoryName: null,
    size: null,
    variantId: variant.id,
    variantCode: variant.code,
    variantLabel: variant.label,
    weightKg: variant.weightKg,
    quantityBoxes: 0,
    reservedBoxes: 0,
    availableBoxes: 0,
    quantitySqft: 0,
    reorderLevel: null,
    minStockLevel: null,
    maxStockLevel: null,
    isLow: false,
    updatedAt: null,
  };
}
