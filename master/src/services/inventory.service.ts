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
import {
  ProductValidationError,
  isBlankNote,
  validateStockLevels,
  withDefaultReorderLevel,
  withoutReservations,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { clampLimit, clampPaging } from '../domain/paging.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as inventoryRepo from '../repositories/inventory.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import { publishChange } from './change-bus.js';
import { freeToSell } from './company-features.js';
import { getSetting } from './settings.service.js';

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
    reservations: await freeToSell(actor.tenantId),
    defaultReorderLevel: await getSetting(actor.tenantId, 'inventory.defaultReorderLevel'),
    ...clampPaging(query, PAGING),
  });
}

/**
 * A single level as the company's switches have it read: collapsed to the floor
 * count while free-to-sell is off, then judged against the company's default
 * low-stock level if the line has none of its own. Every level this service
 * returns or publishes passes through here, so a panel never sees a reserved
 * figure the switch says does not exist — and `emptyLevel`'s hardcoded
 * `isLow: false` is corrected here rather than at its own site.
 */
async function outgoing(tenantId: string, level: InventoryStockLevel): Promise<InventoryStockLevel> {
  const base = (await freeToSell(tenantId)) ? level : withoutReservations(level);
  return withDefaultReorderLevel(base, await getSetting(tenantId, 'inventory.defaultReorderLevel'));
}

export async function listMovements(
  query: { productId?: string; variantId?: string; limit?: number },
  actor: ActorContext,
): Promise<StockMovement[]> {
  requirePermission(actor, 'inventory.view');

  return inventoryRepo.listMovements(actor.tenantId, {
    productId: query.productId,
    variantId: query.variantId,
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

  const moved = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: variant.productId,
    variantId: variant.id,
    movementType: 'inbound',
    deltaBoxes: input.quantityBoxes,
    referenceType: 'purchase',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });
  const level = await outgoing(actor.tenantId, moved);

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
    return outgoing(actor.tenantId, current ?? emptyLevel(variant, productName));
  }

  /*
   * Below the `delta === 0` return, never above it.
   *
   * Confirming a count that already matches writes no movement and no activity
   * row, so a reason collected there would be taken and thrown away — a form
   * that asks for something it then discards. Above this line is the tempting
   * placement and it is the wrong one.
   *
   * A note of spaces counts as no note: `isBlankNote` is shared with both
   * panels' forms so the server cannot refuse something a form let through.
   */
  if (
    isBlankNote(input.note) &&
    (await getSetting(actor.tenantId, 'inventory.adjustmentNoteRequired'))
  ) {
    throw new ValidationError('validation.stock.adjustmentNoteRequired');
  }

  const moved = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: variant.productId,
    variantId: variant.id,
    movementType: 'adjustment',
    deltaBoxes: delta,
    referenceType: 'manual',
    note: input.note ?? null,
    createdByUserId: actorUserId(actor),
  });
  const level = await outgoing(actor.tenantId, moved);

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

  const stored = await inventoryRepo.setStockLevels(
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
  if (!stored) throw new NotFoundError('Stock level');
  const level = await outgoing(actor.tenantId, stored);

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
    if (level) {
      publishChange({
        entity: 'stock',
        action: 'updated',
        id: variantId,
        payload: await outgoing(tenantId, level),
      });
    }
  }
}

export async function countLowStock(tenantId: string): Promise<number> {
  return inventoryRepo.countLowStock(
    tenantId,
    await freeToSell(tenantId),
    await getSetting(tenantId, 'inventory.defaultReorderLevel'),
  );
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
    reorderLevel: null,
    minStockLevel: null,
    maxStockLevel: null,
    isLow: false,
    updatedAt: null,
  };
}
