/**
 * Line items and their colour quantities — one table serving both leads and
 * orders, discriminated by `(parent_type, parent_id)`.
 *
 * That shared table is what makes conversion a straight copy rather than a
 * translation between two shapes, and it is what lets one search index cover
 * both (docs/LEAD_GENERATION_FLOW.md §5.1, §9.3).
 */

import type { LineItem, LineItemParentType } from '@orderbook/shared';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';

import { lineTotal, totalQuantity, type LineSnapshot } from '../domain/line-items.js';
import { db } from '../db/knex.js';
import { allocatePermanentIds } from './identity.repository.js';
import { mapLineItem, mapLineItemQuantity } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'line_items';
const QUANTITY_TABLE = 'line_item_quantities';

type Runner = Knex | Knex.Transaction;

export async function loadLinesFor(
  tenantId: string,
  parentType: LineItemParentType,
  parentIds: string[],
  runner: Runner = db(),
): Promise<Map<string, LineItem[]>> {
  const byParent = new Map<string, LineItem[]>();
  if (parentIds.length === 0) return byParent;

  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId, parent_type: parentType })
    .whereIn('parent_id', parentIds)
    .orderBy(['parent_id', 'sequence'])
    .select('*');

  const quantities = await loadQuantitiesFor(
    rows.map((row) => String(row.id)),
    runner,
  );

  for (const row of rows) {
    const id = String(row.id);
    const line = mapLineItem(row, quantities.get(id) ?? []);
    const bucket = byParent.get(line.parentId);
    if (bucket) bucket.push(line);
    else byParent.set(line.parentId, [line]);
  }

  return byParent;
}

async function loadQuantitiesFor(lineIds: string[], runner: Runner) {
  const byLine = new Map<string, ReturnType<typeof mapLineItemQuantity>[]>();
  if (lineIds.length === 0) return byLine;

  const rows = await runner(QUANTITY_TABLE)
    .whereIn('line_item_id', lineIds)
    .orderBy('colour')
    .select('*');

  for (const row of rows) {
    const lineId = String(row.line_item_id);
    const quantity = mapLineItemQuantity(row);
    const bucket = byLine.get(lineId);
    if (bucket) bucket.push(quantity);
    else byLine.set(lineId, [quantity]);
  }

  return byLine;
}

/**
 * Write a parent's lines. Ids are allocated as one contiguous block so a lead
 * with eight lines takes one trip to the id counter, not eight.
 */
export async function insertLines(
  context: { tenantId: string; parentType: LineItemParentType; parentId: string },
  lines: LineSnapshot[],
  trx: TransactionContext,
): Promise<string[]> {
  if (lines.length === 0) return [];

  const ids = await allocatePermanentIds(context.tenantId, 'line_item', lines.length, trx);

  await trx(TABLE).insert(
    lines.map((line, index) => ({
      id: ids[index],
      tenant_id: context.tenantId,
      parent_type: context.parentType,
      parent_id: context.parentId,
      product_id: line.productId,
      product_name: line.productName,
      alias: line.alias,
      rate: line.rate,
      code: line.code,
      sin: line.sin,
      size: line.size,
      weight_kg: line.weightKg,
      grade: line.grade,
      product_type: line.productType,
      packaging: line.packaging,
      sequence: line.sequence,
      from_party_variant: line.fromPartyVariant,
      image_path: line.imagePath,
      notes: line.notes,
      total_quantity: totalQuantity(line),
      line_total: lineTotal(line),
    })),
  );

  const quantityRows = lines.flatMap((line, index) =>
    line.quantities.map((quantity) => ({
      id: uuid(),
      line_item_id: ids[index],
      colour: quantity.colour,
      quantity: quantity.quantity,
      variant_code: quantity.variantCode ?? null,
    })),
  );

  if (quantityRows.length > 0) await trx(QUANTITY_TABLE).insert(quantityRows);

  return ids;
}

/**
 * Replace a parent's whole line set.
 *
 * Wholesale rather than a per-line diff because lines carry no client-stable
 * identity — the panel sends the set it believes is correct. The delete
 * cascades to the quantity rows.
 */
export async function replaceLines(
  context: { tenantId: string; parentType: LineItemParentType; parentId: string },
  lines: LineSnapshot[],
  trx: TransactionContext,
): Promise<string[]> {
  await trx(TABLE)
    .where({
      tenant_id: context.tenantId,
      parent_type: context.parentType,
      parent_id: context.parentId,
    })
    .delete();

  return insertLines(context, lines, trx);
}

/** Read lines back as the pure domain shape, for copying or recomputation. */
export async function loadSnapshots(
  tenantId: string,
  parentType: LineItemParentType,
  parentId: string,
  runner: Runner = db(),
): Promise<LineSnapshot[]> {
  const byParent = await loadLinesFor(tenantId, parentType, [parentId], runner);

  return (byParent.get(parentId) ?? []).map((line) => ({
    productId: line.productId,
    productName: line.productName,
    alias: line.alias,
    rate: line.rate ?? null,
    code: line.code,
    sin: line.sin,
    size: line.size,
    weightKg: line.weightKg,
    grade: line.grade,
    productType: line.productType,
    packaging: line.packaging,
    sequence: line.sequence,
    fromPartyVariant: line.fromPartyVariant,
    imagePath: line.imagePath,
    notes: line.notes,
    quantities: line.quantities.map((quantity) => ({
      colour: quantity.colour,
      quantity: quantity.quantity,
    })),
  }));
}
