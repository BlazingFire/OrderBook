/**
 * The closed sets and ranges a product's new columns are constrained to,
 * checked *before* the database gets to.
 *
 * This exists because of one path with no validation layer at all. The offline
 * merge (`sync.service.ts#mergeUpdate`) writes columns directly — it is
 * documented as bypassing the services — and a CHECK violation there is caught
 * as a permanent `rejected` result and replayed as that rejection forever. An
 * Office panel's offline edit would be silently destroyed rather than bounced
 * with a reason somebody can act on.
 *
 * So the same function runs on both write paths: the service, where a person is
 * waiting for an answer, and the merge, where nobody is. Pure and shared,
 * because a second copy would drift and the drift would only show up as a
 * Postgres error in a log.
 *
 * It validates **only what the input asserts**. An absent key means "leave it
 * alone" everywhere else in this codebase, and a validator that treated absent
 * as invalid would make a two-field patch impossible.
 */

import type { ProductInput } from './inputs.js';
import type { MessageKey } from '../i18n/keys.js';

export const PRODUCT_UOMS = ['box', 'sqft', 'piece'] as const;
export const PRODUCT_EDGE_TYPES = ['rectified', 'non_rectified'] as const;
export const PRODUCT_APPLICATIONS = ['floor', 'wall', 'floor_wall', 'outdoor'] as const;

/** Thrown with a catalogue token, so the message reaches a person translated. */
export class ProductValidationError extends Error {
  constructor(readonly messageKey: MessageKey) {
    super(messageKey);
    this.name = 'ProductValidationError';
  }
}

function asserted(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function assertPercentage(value: number | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ProductValidationError('validation.product.percentage');
  }
}

function assertNonNegative(value: number | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new ProductValidationError('validation.product.negativeAmount');
  }
}

export function validateProductInput(input: ProductInput): void {
  if (asserted(input.uom) && !(PRODUCT_UOMS as readonly string[]).includes(String(input.uom))) {
    throw new ProductValidationError('validation.product.uom');
  }

  if (
    asserted(input.edgeType) &&
    !(PRODUCT_EDGE_TYPES as readonly string[]).includes(String(input.edgeType))
  ) {
    throw new ProductValidationError('validation.product.edgeType');
  }

  if (
    asserted(input.application) &&
    !(PRODUCT_APPLICATIONS as readonly string[]).includes(String(input.application))
  ) {
    throw new ProductValidationError('validation.product.application');
  }

  if (input.peiRating !== undefined && input.peiRating !== null) {
    const rating = Number(input.peiRating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      throw new ProductValidationError('validation.product.peiRating');
    }
  }

  assertPercentage(input.gstRatePct);
  assertPercentage(input.waterAbsorptionPct);

  assertNonNegative(input.mrp);
  assertNonNegative(input.purchaseRate);
}

/**
 * The stock band, checked the same way and on the same two paths.
 *
 * Only the asserted subset again: the existing "set the reorder level" screen
 * knows nothing about min and max, and must not be made to send them.
 */
export function validateStockLevels(levels: {
  reorderLevel?: number | null;
  minStockLevel?: number | null;
  maxStockLevel?: number | null;
}): void {
  for (const value of [levels.reorderLevel, levels.minStockLevel, levels.maxStockLevel]) {
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new ProductValidationError('validation.stock.levelNegative');
    }
  }

  const min = levels.minStockLevel;
  const max = levels.maxStockLevel;

  // Only when both are asserted in the same patch. Checking a new max against a
  // stored min would need a read, and the database's own CHECK is what catches
  // the cross-patch case.
  if (min !== undefined && min !== null && max !== undefined && max !== null && max < min) {
    throw new ProductValidationError('validation.stock.levelRange');
  }
}
