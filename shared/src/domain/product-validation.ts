/**
 * The rules a sub product's own fields are constrained to, checked *before*
 * the database gets to.
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

/**
 * A category's software code (`OPT`, `V1812`): letters and digits only, so it
 * types cleanly into the product bar and prefixes the generated sub-product
 * codes (`OPT-0001`) without a separator of its own. One pattern for the
 * catalogue file, the category service and its form.
 */
export const CATEGORY_CODE_PATTERN = /^[A-Za-z0-9]+$/;

/** Thrown with a catalogue token, so the message reaches a person translated. */
export class ProductValidationError extends Error {
  constructor(readonly messageKey: MessageKey) {
    super(messageKey);
    this.name = 'ProductValidationError';
  }
}

/**
 * What a sub-product write asserts, on the same two paths: the catalogue
 * order is what its INTEGER column holds; a weight, when given, is a
 * positive number (the column's CHECK); the print side is one of its three
 * settings (its CHECK); and every offered colour is real text, once —
 * `blue` and `Blue` are one colour. Uniqueness of the code *across*
 * products is the database's job (the partial unique index) and the
 * service's friendly pre-check — this function sees one product at a time.
 * A blank code is not an error here: on create it means "next in sequence",
 * which only the service can mint.
 */
export function validateProductInput(input: ProductInput): void {
  const { sortOrder, weightKg, printSide, colours } = input;
  if (sortOrder !== undefined && sortOrder !== null && !(Number.isInteger(sortOrder) && sortOrder >= 0)) {
    throw new ProductValidationError('validation.category.sortOrder');
  }
  if (weightKg !== undefined && weightKg !== null) {
    if (typeof weightKg !== 'number' || !Number.isFinite(weightKg) || weightKg <= 0) {
      throw new ProductValidationError('validation.product.weightPositive');
    }
  }
  if (printSide !== undefined && printSide !== 'default' && printSide !== 'left' && printSide !== 'right') {
    throw new ProductValidationError('validation.product.printSideInvalid');
  }
  if (colours !== undefined) {
    const seen = new Set<string>();
    for (const colour of colours) {
      if (typeof colour !== 'string' || colour.trim() === '') {
        throw new ProductValidationError('validation.product.colourBlank');
      }
      const key = colour.trim().toLowerCase();
      if (seen.has(key)) {
        throw new ProductValidationError('validation.product.coloursDuplicate');
      }
      seen.add(key);
    }
  }
}
