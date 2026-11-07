/**
 * Product variants — the rows that own every product code and weight
 * (`docs/schema/02-parties-and-products.md` §`product_variants`).
 *
 * A product has at least one. One with no colour or pattern choices has
 * exactly one row with a null label, so "the product's code" and "the
 * variant's code" are the same column everywhere: the unique index over
 * `(tenant_id, lower(code))` is what guards duplicates for both kinds of
 * product, and a line item, a stock row or a reservation always points at a
 * variant id whichever kind it came from.
 *
 * Imported as `productVariantRepo` — `variantRepo` already means a party's
 * own versions of products (`party-variant.repository.ts`) throughout the
 * services.
 */

import type { ProductVariant, ProductVariantInput } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { ConflictError } from '../lib/errors.js';
import { allocatePermanentIds } from './identity.repository.js';
import { mapProductVariant } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'product_variants';

/**
 * Prefix for the per-row placeholder `replaceVariants` parks codes and labels
 * on mid-save. ASCII Unit Separator: valid in a TEXT column (NUL is not) and
 * impossible in a code or label somebody typed.
 */
const PARKED = String.fromCharCode(0x1f);

type Runner = Knex | Knex.Transaction;

/** Every variant of each product, in the order the form shows them. */
export async function loadVariantsFor(
  tenantId: string,
  productIds: string[],
  runner: Runner = db(),
): Promise<Map<string, ProductVariant[]>> {
  const byProduct = new Map<string, ProductVariant[]>();
  if (productIds.length === 0) return byProduct;

  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereIn('product_id', productIds)
    .orderBy([
      { column: 'sequence', order: 'asc' },
      { column: 'code', order: 'asc' },
    ])
    .select('*');

  for (const row of rows) {
    const variant = mapProductVariant(row);
    const bucket = byProduct.get(variant.productId);
    if (bucket) bucket.push(variant);
    else byProduct.set(variant.productId, [variant]);
  }

  return byProduct;
}

/**
 * The live variant behind a code, case-insensitively.
 *
 * Live only — the unique index is partial on the same tombstone, so a code
 * freed by the Recycle Bin is reusable and this lookup agrees with the
 * database about it.
 */
export async function findVariantByCode(
  tenantId: string,
  code: string,
  runner: Runner = db(),
): Promise<ProductVariant | null> {
  const row = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereRaw('lower(code) = lower(?)', [code.trim()])
    .first('*');
  return row ? mapProductVariant(row) : null;
}

/** Which of these codes are already on a live variant, keyed by lower-cased code. */
export async function findLiveVariantsByCodes(
  tenantId: string,
  codes: readonly string[],
  runner: Runner = db(),
): Promise<Map<string, { variantId: string; productId: string }>> {
  const found = new Map<string, { variantId: string; productId: string }>();
  const wanted = [...new Set(codes.map((code) => code.trim().toLowerCase()).filter(Boolean))];

  for (let at = 0; at < wanted.length; at += 1000) {
    const rows = await runner(TABLE)
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereRaw('lower(code) = ANY(?)', [wanted.slice(at, at + 1000)])
      .select<Array<{ id: string; product_id: string; code: string }>>('id', 'product_id', 'code');
    for (const row of rows) {
      found.set(String(row.code).toLowerCase(), {
        variantId: String(row.id),
        productId: String(row.product_id),
      });
    }
  }

  return found;
}

/**
 * Variants of this product that something still points at: a line on any
 * lead or order. Such a row is deactivated rather than deleted when the
 * administrator takes it off the form — the history that quotes it stays
 * readable. Rows left in the retired stock tables do not count: OrderBook keeps
 * no stock (1.4), so they are cleared with the variant (`deleteLegacyStock`).
 */
async function referencedVariantIds(
  tenantId: string,
  productId: string,
  runner: Runner = db(),
): Promise<Set<string>> {
  const { rows } = await runner.raw<{ rows: Array<{ id: string }> }>(
    `SELECT v.id
       FROM product_variants v
      WHERE v.tenant_id = ? AND v.product_id = ?
        AND (
          EXISTS (SELECT 1 FROM line_items li WHERE li.variant_id = v.id)
        )`,
    [tenantId, productId],
  );
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * The retired stock tables still hold foreign keys to a variant that carried
 * stock before 1.4. They are dead data (nothing reads them), so the rows go with
 * the variant rather than blocking its delete.
 */
async function deleteLegacyStock(tenantId: string, variantId: string, trx: TransactionContext): Promise<void> {
  for (const table of ['stock_reservations', 'stock_movements', 'inventory_stock']) {
    await trx(table).where({ tenant_id: tenantId, variant_id: variantId }).delete();
  }
}

/**
 * Which stored row each incoming row is, or null for a new one: by id, then by
 * code, then by label, each pass over every input so that a row's own id or code
 * is never lost to another row's weaker match. Several rows may have a blank
 * label, so a blank only identifies a row when it is the only blank one.
 *
 * Both the save and the guard on retiring a quoted variant ask this, so they
 * cannot disagree about which rows a form leaves out.
 */
export function matchVariantRows(
  existing: ReadonlyArray<{ id: string; code: string; label: string | null }>,
  inputs: ReadonlyArray<{ id?: string | undefined; code: string; label?: string | null | undefined }>,
): Array<string | null> {
  const codeKey = (code: string): string => code.trim().toLowerCase();
  const blanks = existing.filter((row) => !labelKey(row.label));
  const passes: Array<(input: (typeof inputs)[number]) => (typeof existing)[number] | undefined> = [
    (input) => existing.find((row) => row.id === input.id),
    (input) => existing.find((row) => codeKey(row.code) === codeKey(input.code)),
    (input) => {
      const key = labelKey(input.label);
      if (key) return existing.find((row) => labelKey(row.label) === key);
      return blanks.length === 1 ? blanks[0] : undefined;
    },
  ];

  const matched = inputs.map((): string | null => null);
  const claimed = new Set<string>();
  for (const pass of passes) {
    inputs.forEach((input, index) => {
      if (matched[index]) return;
      const row = pass(input);
      if (row && !claimed.has(row.id)) {
        claimed.add(row.id);
        matched[index] = row.id;
      }
    });
  }
  return matched;
}

/**
 * Make the product's variant set equal to `inputs`.
 *
 * Rows are matched by `matchVariantRows`, so a form that re-sends a row without
 * its id still updates the row rather than duplicating it. Matched rows are
 * updated and reactivated; new rows are inserted with fresh ids; rows left
 * out are deleted, unless something references them, in which case they are
 * deactivated and keep their id.
 *
 * A code already on another live product surfaces as `error.conflict.productCodeTaken`
 * — the partial unique index is the enforcement, this only turns it into a
 * sentence a person can act on.
 */
export async function replaceVariants(
  tenantId: string,
  productId: string,
  inputs: readonly ProductVariantInput[],
  trx: TransactionContext,
): Promise<ProductVariant[]> {
  const existing = await trx(TABLE)
    .where({ tenant_id: tenantId, product_id: productId })
    .forUpdate()
    .select<Array<{ id: string; code: string; label: string | null }>>('id', 'code', 'label');

  const matches = matchVariantRows(
    existing.map((row) => ({ ...row, id: String(row.id) })),
    inputs,
  );
  const claimed = new Set(matches.filter((id): id is string => id !== null));

  const updates: Array<{ id: string; input: ProductVariantInput; sequence: number }> = [];
  const inserts: Array<{ input: ProductVariantInput; sequence: number }> = [];

  inputs.forEach((input, index) => {
    const sequence = input.sequence ?? index + 1;
    const matchedId = matches[index];

    if (matchedId) {
      updates.push({ id: matchedId, input, sequence });
    } else {
      inserts.push({ input, sequence });
    }
  });

  const removed = existing.map((row) => String(row.id)).filter((id) => !claimed.has(id));
  const referenced = removed.length > 0 ? await referencedVariantIds(tenantId, productId, trx) : new Set<string>();

  try {
    // Deactivate or delete first, so a label freed by a removed row can be
    // taken by a new one within the same save.
    for (const id of removed) {
      if (referenced.has(id)) {
        await trx(TABLE)
          .where({ tenant_id: tenantId, id })
          .update({ is_active: false, updated_at: trx.fn.now() });
      } else {
        await deleteLegacyStock(tenantId, id, trx);
        await trx(TABLE).where({ tenant_id: tenantId, id }).delete();
      }
    }

    // Park the codes and labels of every row about to change on a per-row
    // placeholder first. Two rows swapping labels (or codes) would otherwise
    // collide on the unique indexes halfway through, whichever order the
    // updates ran in.
    for (const update of updates) {
      await trx(TABLE)
        .where({ tenant_id: tenantId, id: update.id })
        .update({ code: `${PARKED}${update.id}`, label: `${PARKED}${update.id}` });
    }

    for (const update of updates) {
      await trx(TABLE)
        .where({ tenant_id: tenantId, id: update.id })
        .update({
          code: update.input.code.trim(),
          label: normaliseLabel(update.input.label),
          weight_kg: update.input.weightKg ?? null,
          sequence: update.sequence,
          is_active: true,
          updated_at: trx.fn.now(),
        });
    }

    if (inserts.length > 0) {
      const ids = await allocatePermanentIds(tenantId, 'product_variant', inserts.length, trx);
      await trx(TABLE).insert(
        inserts.map((entry, index) => ({
          id: ids[index],
          tenant_id: tenantId,
          product_id: productId,
          code: entry.input.code.trim(),
          label: normaliseLabel(entry.input.label),
          weight_kg: entry.input.weightKg ?? null,
          sequence: entry.sequence,
          is_active: true,
        })),
      );
    }
  } catch (error) {
    throw translateUniqueViolation(error, inputs);
  }

  const variants = await loadVariantsFor(tenantId, [productId], trx);
  return variants.get(productId) ?? [];
}

/**
 * Many variants in one INSERT for the bulk import, ids already allocated by
 * the caller alongside the product ids. No re-read, like `insertProductRows`.
 */
export async function insertVariantRows(
  rows: ReadonlyArray<{ id: string; productId: string; input: ProductVariantInput; sequence: number }>,
  tenantId: string,
  trx: TransactionContext,
): Promise<void> {
  if (rows.length === 0) return;

  await trx(TABLE).insert(
    rows.map((row) => ({
      id: row.id,
      tenant_id: tenantId,
      product_id: row.productId,
      code: row.input.code.trim(),
      label: normaliseLabel(row.input.label),
      weight_kg: row.input.weightKg ?? null,
      sequence: row.sequence,
      is_active: true,
    })),
  );
}

/**
 * Mirror the product's tombstone onto its variants, so the code index frees
 * (or reclaims) their codes together with the product.
 */
export async function setDeletedAt(
  tenantId: string,
  productId: string,
  deletedAt: 'now' | null,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, product_id: productId })
    .update({ deleted_at: deletedAt === 'now' ? trx.fn.now() : null, updated_at: trx.fn.now() });
}

/** Codes of this product that a *different* live product now holds. */
export async function codesTakenElsewhere(
  tenantId: string,
  productId: string,
  runner: Runner = db(),
): Promise<string[]> {
  const { rows } = await runner.raw<{ rows: Array<{ code: string }> }>(
    `SELECT mine.code
       FROM product_variants mine
      WHERE mine.tenant_id = ? AND mine.product_id = ?
        AND EXISTS (
          SELECT 1 FROM product_variants other
           WHERE other.tenant_id = mine.tenant_id
             AND other.product_id <> mine.product_id
             AND other.deleted_at IS NULL
             AND lower(other.code) = lower(mine.code)
        )
      ORDER BY mine.sequence`,
    [tenantId, productId],
  );
  return rows.map((row) => String(row.code));
}

function labelKey(label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

function normaliseLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  return trimmed ? trimmed : null;
}

/**
 * `23505` on the code index becomes the catalogue's own conflict. Postgres
 * does not say which value collided in a way worth parsing, so the message
 * names the first code in the set that another live product holds — found
 * by a lookup the caller can no longer do, because the transaction is
 * already aborted. The message therefore names the codes being saved.
 */
function translateUniqueViolation(error: unknown, inputs: readonly ProductVariantInput[]): unknown {
  const pg = error as { code?: string; constraint?: string } | null;
  if (pg?.code !== '23505') return error;
  const constraint = pg.constraint ?? '';
  if (constraint.includes('code')) {
    return new ConflictError('error.conflict.productCodeTaken', {
      productCode: inputs.map((input) => input.code.trim()).join(', '),
    });
  }
  return error;
}
