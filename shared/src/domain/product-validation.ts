/**
 * The rules a product's variant set is constrained to, checked *before* the
 * database gets to.
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

import type { ProductInput, ProductVariantInput } from './inputs.js';
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
 * The product master holds no closed sets or ranges any more — a model is a
 * name, a category, an alias, a size and a colour switch — so the product-level
 * check is that the variant set, when asserted, obeys its rules, and that the
 * catalogue order is what its INTEGER column holds: anything else reached the
 * database as a 500, and on the offline merge as a rejection replayed forever.
 */
export function validateProductInput(input: ProductInput): void {
  const { sortOrder } = input;
  if (sortOrder !== undefined && sortOrder !== null && !(Number.isInteger(sortOrder) && sortOrder >= 0)) {
    throw new ProductValidationError('validation.category.sortOrder');
  }
  if (input.variants !== undefined) {
    validateProductVariants(input.variants, input.hasVariants ?? input.variants.some((v) => hasText(v.label)));
  }
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The variant set, on the same two paths.
 *
 * Every row needs a code; codes, and any labels given, must be unique within the set
 * (case-insensitively — `blue` and `Blue` are one colour, and the database's
 * indexes agree); a weight, when given, is a positive number. A product
 * without variants is exactly one row with no label; one with variants has
 * a colour that may be left blank, which prints nothing.
 *
 * Uniqueness *across* products is the database's job (the partial unique
 * index on the code) and the service's friendly pre-check — this function
 * sees one product at a time.
 */
export function validateProductVariants(
  variants: readonly ProductVariantInput[],
  hasVariants: boolean,
): void {
  if (variants.length === 0) throw new ProductValidationError('validation.product.variantRequired');

  const codes = new Set<string>();
  const labels = new Set<string>();

  for (const variant of variants) {
    const code = typeof variant.code === 'string' ? variant.code.trim() : '';
    if (!code) throw new ProductValidationError('validation.product.variantCodeRequired');
    const codeKey = code.toLowerCase();
    if (codes.has(codeKey)) throw new ProductValidationError('validation.product.variantCodeDuplicate');
    codes.add(codeKey);

    const label = hasText(variant.label) ? String(variant.label).trim() : '';
    // A variant's colour may be blank (code-only variants; nothing prints for it). Only
    // the colours that are given must differ.
    if (label) {
      const labelKey = label.toLowerCase();
      if (labels.has(labelKey)) throw new ProductValidationError('validation.product.variantLabelDuplicate');
      labels.add(labelKey);
    }

    const weight = variant.weightKg;
    if (weight !== undefined && weight !== null) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        throw new ProductValidationError('validation.product.weightPositive');
      }
    }
  }

  if (!hasVariants && (variants.length !== 1 || hasText(variants[0]?.label))) {
    throw new ProductValidationError('validation.product.variantLabelUnexpected');
  }
}
