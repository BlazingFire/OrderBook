/**
 * Orders — their own record now, created by conversion and running their own
 * pipeline (docs/LEAD_GENERATION_FLOW.md §5).
 *
 * Structurally a near-twin of the lead repository, which is expected: the two
 * share the `line_items` table and the timeline, and differ only in the fields
 * that exist once something is a commitment rather than a conversation —
 * dispatch address, expected date, weight, reservations.
 */

import type { Order, OrderListQuery, Paginated } from '@orderbook/shared';
import type { Knex } from 'knex';

import { evaluateCompleteness } from '../domain/custom-fields.js';
import type { LineSnapshot } from '../domain/line-items.js';
import { computeTotalWeightKg, orderTotalAmount } from '../domain/line-items.js';
import { db } from '../db/knex.js';
import * as customFields from './custom-field.repository.js';
import { allocatePermanentId } from './identity.repository.js';
import * as lineItems from './line-item.repository.js';
import { firstCount, mapOrder } from './mappers.js';
import * as reservations from './reservation.repository.js';
import * as timeline from './timeline.repository.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'orders';

type Runner = Knex | Knex.Transaction;

function baseQuery(tenantId: string, runner: Runner = db()) {
  return runner(`${TABLE} as o`)
    .join('parties as pa', 'pa.id', 'o.party_id')
    .join('pipeline_stages as st', 'st.id', 'o.stage_id')
    .leftJoin('users as ow', 'ow.id', 'o.owner_id')
    .where('o.tenant_id', tenantId)
    .select(
      'o.*',
      'pa.name as party_name',
      'st.name as stage_name',
      'st.sequence as stage_sequence',
      'ow.full_name as owner_name',
    );
}

export async function listOrders(
  tenantId: string,
  options: OrderListQuery & { limit: number; offset: number },
): Promise<Paginated<Order>> {
  const base = baseQuery(tenantId);

  if (options.stageIds?.length) base.whereIn('o.stage_id', options.stageIds);
  if (options.ownerId) base.where('o.owner_id', options.ownerId);

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder.whereILike('o.id', pattern).orWhereILike('pa.name', pattern),
    );
  }

  const countRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<Array<{ count: string }>>('o.id as count');

  const rows = await base
    .clone()
    .orderBy('o.created_at', 'desc')
    .limit(options.limit)
    .offset(options.offset);

  return {
    items: await hydrate(tenantId, rows),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

export async function findOrderById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<Order | null> {
  const row = await baseQuery(tenantId, runner).where('o.id', id).first();
  if (!row) return null;

  const [order] = await hydrate(tenantId, [row], runner);
  return order ?? null;
}

async function hydrate(
  tenantId: string,
  rows: Array<Record<string, unknown>>,
  runner: Runner = db(),
): Promise<Order[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => String(row.id));
  const [linesByOrder, timelineByOrder, reservationsByOrder, definitions] = await Promise.all([
    lineItems.loadLinesFor(tenantId, 'order', ids, runner),
    timeline.loadTimelinesFor(tenantId, 'order', ids, runner),
    reservations.loadForOrders(tenantId, ids, runner),
    customFields.definitionsFor(tenantId, 'order', runner),
  ]);

  return rows.map((row) => {
    const id = String(row.id);
    return mapOrder(
      row,
      linesByOrder.get(id) ?? [],
      timelineByOrder.get(id) ?? [],
      reservationsByOrder.get(id) ?? [],
      evaluateCompleteness(
        (row.custom_fields as Record<string, unknown> | null) ?? {},
        definitions,
      ),
    );
  });
}

export interface NewOrder {
  tenantId: string;
  leadId: string | null;
  partyId: string;
  ownerId: string | null;
  stageId: string;
  dispatchAddressLabel: string | null;
  expectedDispatchDate: string | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  sourcePanelId: string | null;
  createdByUserId: string | null;
  hlc: string;
  temporaryId: string | null;
  id?: string;
}

export async function insertOrder(
  order: NewOrder,
  lines: LineSnapshot[],
  trx: TransactionContext,
): Promise<{ id: string; lineItemIds: string[] }> {
  const id = order.id ?? (await allocatePermanentId(order.tenantId, 'order', trx));

  await trx(TABLE).insert({
    id,
    tenant_id: order.tenantId,
    lead_id: order.leadId,
    party_id: order.partyId,
    owner_id: order.ownerId,
    stage_id: order.stageId,
    dispatch_address_label: order.dispatchAddressLabel,
    expected_dispatch_date: order.expectedDispatchDate,
    total_weight_kg: computeTotalWeightKg(lines),
    notes: order.notes,
    custom_fields: JSON.stringify(order.customFields),
    total_amount: orderTotalAmount(lines),
    source_panel_id: order.sourcePanelId,
    created_by_user_id: order.createdByUserId,
    hlc: order.hlc,
    field_hlc: JSON.stringify({}),
    temporary_id: order.temporaryId,
  });

  const lineItemIds = await lineItems.insertLines(
    { tenantId: order.tenantId, parentType: 'order', parentId: id },
    lines,
    trx,
  );

  return { id, lineItemIds };
}

export async function updateOrderColumns(
  tenantId: string,
  id: string,
  patch: Record<string, unknown>,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({
      ...patch,
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      version: trx.raw('version + 1'),
      updated_at: trx.fn.now(),
    });
}

export async function markDispatched(
  tenantId: string,
  id: string,
  stageId: string,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id }).update({
    stage_id: stageId,
    dispatched_at: trx.fn.now(),
    updated_at: trx.fn.now(),
  });
}

export async function countOrders(tenantId: string, runner: Runner = db()): Promise<number> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}
