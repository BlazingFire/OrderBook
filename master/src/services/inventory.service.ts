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
  Product,
  ReorderLevelInput,
  StockAdjustmentInput,
  StockInboundInput,
  StockListQuery,
  StockMovement,
} from '@orderbook/shared';
import {
  ProductValidationError,
  validateStockLevels,
  withDefaultReorderLevel,
  withoutReservations,
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
  const product = await assertProductExists(actor.tenantId, input.productId);

  if (!Number.isFinite(input.quantityBoxes) || input.quantityBoxes <= 0) {
    throw new ValidationError('validation.stock.boxesArrivedRequired');
  }

  const moved = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: input.productId,
    colour,
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
      entityId: input.productId,
      action: 'inbound',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { product: product.name, quantity: input.quantityBoxes, colour },
    },
    actor,
    db(),
  );
  publishChange({
    entity: 'stock',
    action: 'updated',
    id: stockKey(input.productId, colour),
    payload: level,
  });

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
  const product = await assertProductExists(actor.tenantId, input.productId);

  if (!Number.isFinite(input.quantityBoxes) || input.quantityBoxes < 0) {
    throw new ValidationError('validation.stock.countedBoxesRequired');
  }

  const current = await inventoryRepo.findStockLevel(actor.tenantId, input.productId, colour);
  const delta = input.quantityBoxes - (current?.quantityBoxes ?? 0);

  if (delta === 0) {
    return outgoing(actor.tenantId, current ?? { ...emptyLevel(input.productId, colour) });
  }

  const moved = await inventoryRepo.applyMovement({
    tenantId: actor.tenantId,
    productId: input.productId,
    colour,
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
      entityId: input.productId,
      action: 'adjusted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { product: product.name, colour, countedBoxes: input.quantityBoxes, delta },
    },
    actor,
    db(),
  );
  publishChange({
    entity: 'stock',
    action: 'updated',
    id: stockKey(input.productId, colour),
    payload: level,
  });

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

  const colour = requireColour(input.colour);
  await assertProductExists(actor.tenantId, input.productId);

  // The band, checked here as well as by the database's own CHECK — a person
  // waiting on a form deserves a sentence, not a constraint name.
  assertStockLevels(input);

  let level: InventoryStockLevel | null;
  try {
    level = await inventoryRepo.setStockLevels(actor.tenantId, input.productId, colour, {
      // Passed through as-is, `undefined` included: absent means untouched, and
      // the repository writes only what was asserted.
      reorderLevel: input.reorderLevel,
      minStockLevel: input.minStockLevel,
      maxStockLevel: input.maxStockLevel,
      variantCode: normalizeVariantCode(input.variantCode),
    });
  } catch (error) {
    // The partial unique index is the enforcement; this only turns it into a
    // sentence. Two people can reach it at once, so a pre-check would be a
    // race with a nicer message, not a substitute.
    const pg = error as { code?: string; constraint?: string } | null;
    if (pg?.code === '23505' && (pg.constraint ?? '').includes('variant_code')) {
      throw new ValidationError('validation.stock.variantCodeTaken');
    }
    throw error;
  }
  if (!level) throw new NotFoundError('Stock level');
  level = await outgoing(actor.tenantId, level);

  publishChange({
    entity: 'stock',
    action: 'updated',
    id: stockKey(input.productId, colour),
    payload: level,
  });
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
    if (level) {
      publishChange({
        entity: 'stock',
        action: 'updated',
        id: key,
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

export async function coloursFor(tenantId: string, productId: string): Promise<string[]> {
  return inventoryRepo.coloursFor(tenantId, productId);
}

/**
 * The typed code, trimmed — or `null` when it is being cleared.
 *
 * Blank and `null` mean the same thing here, unlike the stock bands above: a
 * code is a name somebody chose, and "" is not one. Clearing has to be
 * possible, because a code cannot move to another colour while this row still
 * holds it.
 */
function normalizeVariantCode(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function requireColour(colour: string | undefined): string {
  const trimmed = colour?.trim();
  if (!trimmed) {
    // Not defaulted: stock is tracked per colour, and silently filing boxes
    // under "Default" would put real stock somewhere nobody looks for it.
    throw new ValidationError('validation.stock.colourRequired');
  }
  return trimmed;
}

/**
 * The product this movement is against, or a 404.
 *
 * Returns it rather than merely asserting, because the audit entry needs its
 * name: the catalogue renders "recorded {quantity} boxes in for {product}", and
 * with nothing to fill `{product}` the Activity log printed the placeholder.
 */
async function assertProductExists(tenantId: string, productId: string): Promise<Product> {
  const product = await productRepo.findProductById(tenantId, productId);
  if (!product) throw new NotFoundError('Product');
  return product;
}

function emptyLevel(productId: string, colour: string): InventoryStockLevel {
  return {
    productId,
    productCode: '',
    productName: '',
    categoryName: null,
    size: null,
    colour,
    variantCode: null,
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
