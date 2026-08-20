import type { Lead, LeadInput, LeadItem, LeadStatus, Paginated } from '@orderbook/shared';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';

import { db } from '../db/knex.js';
import { firstCount, mapLead, mapLeadItem } from './mappers.js';

const TABLE = 'leads';
const ITEM_TABLE = 'lead_items';

function baseQuery(runner: Knex | Knex.Transaction = db()) {
  return runner(`${TABLE} as l`)
    .join('parties as pa', 'pa.id', 'l.party_id')
    .select('l.*', 'pa.name as party_name');
}

export async function listLeads(options: {
  statuses?: LeadStatus[];
  search?: string;
  limit: number;
  offset: number;
}): Promise<Paginated<Lead>> {
  const base = baseQuery();

  if (options.statuses?.length) base.whereIn('l.status', options.statuses);

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder.whereILike('l.lead_number', pattern).orWhereILike('pa.name', pattern),
    );
  }

  const countRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<{ count: string }[]>('l.id as count');

  const rows = await base
    .clone()
    .orderBy('l.created_at', 'desc')
    .limit(options.limit)
    .offset(options.offset);

  const itemsByLead = await loadItemsFor(rows.map((row) => String(row.id)));

  return {
    items: rows.map((row) => mapLead(row, itemsByLead.get(String(row.id)) ?? [])),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

export async function findLeadById(
  id: string,
  runner: Knex | Knex.Transaction = db(),
): Promise<Lead | null> {
  const row = await baseQuery(runner).where('l.id', id).first();
  if (!row) return null;
  const items = await loadItemsFor([id], runner);
  return mapLead(row, items.get(id) ?? []);
}

/**
 * Creates the lead and every line item atomically: a half-written order with
 * missing lines would be worse than a failed save the user can retry.
 */
export async function insertLead(
  input: LeadInput,
  context: { sourcePanelId: string | null; createdByUserId: string | null },
): Promise<Lead> {
  return db().transaction(async (trx) => {
    const { rows } = await trx.raw<{ rows: [{ number: string }] }>(
      `SELECT 'L-' || lpad(nextval('lead_number_seq')::text, 6, '0') AS number`,
    );
    const leadNumber = rows[0].number;
    const leadId = uuid();

    await trx(TABLE).insert({
      id: leadId,
      lead_number: leadNumber,
      party_id: input.partyId,
      status: 'new',
      source_panel_id: context.sourcePanelId,
      created_by_user_id: context.createdByUserId,
      notes: input.notes ?? null,
      total_amount: 0,
    });

    for (const item of input.items) {
      await trx(ITEM_TABLE).insert({
        id: uuid(),
        lead_id: leadId,
        product_id: item.productId,
        quantity_boxes: item.quantityBoxes ?? null,
        quantity_sqft: item.quantitySqft ?? null,
        unit_price: item.unitPrice ?? null,
        line_total: computeLineTotal(item.unitPrice, item.quantityBoxes),
        parameters: JSON.stringify(item.parameters ?? {}),
      });
    }

    await recalculateTotal(leadId, trx);

    const created = await findLeadById(leadId, trx);
    if (!created) throw new Error('Lead disappeared immediately after insert');
    return created;
  });
}

/**
 * `onCommitted` runs inside the same transaction as the status change, after
 * the row is updated — used to move stock so an order and its stock movements
 * commit or fail together.
 */
export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
  onCommitted?: (lead: Lead, trx: Knex.Transaction) => Promise<void>,
): Promise<Lead | null> {
  return db().transaction(async (trx) => {
    const patch: Record<string, unknown> = { status, updated_at: trx.fn.now() };
    // order_date is the moment the lead was finalised, so it is stamped on the
    // transition rather than recomputed from updated_at later.
    if (status === 'order') patch.order_date = trx.fn.now();

    const updated = await trx(TABLE).where({ id }).update(patch);
    if (!updated) return null;

    const lead = await findLeadById(id, trx);
    if (!lead) return null;

    if (onCommitted) await onCommitted(lead, trx);
    return lead;
  });
}

export async function countLeadsByStatus(statuses: LeadStatus[]): Promise<number> {
  const rows = await db()(TABLE)
    .whereIn('status', statuses)
    .count<{ count: string }[]>('id as count');
  return firstCount(rows);
}

/** Quantities are NUMERIC; money stays an integer count of the smallest unit. */
function computeLineTotal(unitPrice: number | null | undefined, quantity: number | null | undefined): number | null {
  if (unitPrice == null || quantity == null) return null;
  return Math.round(unitPrice * quantity);
}

async function recalculateTotal(leadId: string, runner: Knex | Knex.Transaction): Promise<void> {
  await runner.raw(
    `UPDATE leads
        SET total_amount = COALESCE((SELECT SUM(line_total) FROM lead_items WHERE lead_id = ?), 0),
            updated_at = now()
      WHERE id = ?`,
    [leadId, leadId],
  );
}

/** Single query for all requested leads, so a list of N leads is 2 queries, not N+1. */
async function loadItemsFor(
  leadIds: string[],
  runner: Knex | Knex.Transaction = db(),
): Promise<Map<string, LeadItem[]>> {
  const grouped = new Map<string, LeadItem[]>();
  if (leadIds.length === 0) return grouped;

  const rows = await runner(`${ITEM_TABLE} as li`)
    .join('products as p', 'p.id', 'li.product_id')
    .select('li.*', 'p.product_code as product_code', 'p.name as product_name')
    .whereIn('li.lead_id', leadIds)
    .orderBy('li.created_at', 'asc');

  for (const row of rows) {
    const item = mapLeadItem(row);
    const bucket = grouped.get(item.leadId);
    if (bucket) bucket.push(item);
    else grouped.set(item.leadId, [item]);
  }

  return grouped;
}
