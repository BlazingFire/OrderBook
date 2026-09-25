/**
 * Orders — their own record now, created by conversion and running their own
 * pipeline (docs/LEAD_GENERATION_FLOW.md §5).
 *
 * Structurally a near-twin of the lead repository, which is expected: the two
 * share the `line_items` table and the timeline, and differ only in the fields
 * that exist once something is a commitment rather than a conversation —
 * dispatch address, expected date, weight, reservations.
 */

import type { Order, OrderListQuery, Paginated, PartyScopeFilter } from '@orderbook/shared';
import type { Knex } from 'knex';

import { evaluateCompleteness } from '../domain/custom-fields.js';
import type { LineSnapshot } from '../domain/line-items.js';
import { computeTotalWeightKg } from '../domain/line-items.js';
import { UNSCOPED_PARTY_ACCESS, type PartyScope } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import * as customFields from './custom-field.repository.js';
import { allocatePermanentId } from './identity.repository.js';
import * as lineItems from './line-item.repository.js';
import { firstCount, mapOrder, toJsonObject } from './mappers.js';
import { applyPartyScope } from './party-access.repository.js';
import * as reservations from './reservation.repository.js';
import * as timeline from './timeline.repository.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'orders';

type Runner = Knex | Knex.Transaction;

/** `scope` is required for the same reason it is on leads — see that file. */
function baseQuery(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
  options: { includeDeleted?: boolean; filter?: PartyScopeFilter } = {},
) {
  const query = runner(`${TABLE} as o`)
    .join('parties as pa', 'pa.id', 'o.party_id')
    .join('pipeline_stages as st', 'st.id', 'o.stage_id')
    .leftJoin('users as ow', 'ow.id', 'o.owner_id')
    .where('o.tenant_id', tenantId)
    .select(
      'o.*',
      'pa.name as party_name',
      'st.name as stage_name',
      'st.sequence as stage_sequence',
      'ow.display_name as owner_name',
    );

  applyPartyScope(query, tenantId, 'o.party_id', scope, { level: 'view', filter: options.filter });

  if (!options.includeDeleted) query.whereNull('o.deleted_at');
  return query;
}

export async function listOrders(
  tenantId: string,
  options: OrderListQuery & { limit: number; offset: number; partyScope: PartyScope },
): Promise<Paginated<Order>> {
  const base = baseQuery(tenantId, options.partyScope, db(), { filter: options.scope });

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
    // A tiebreaker, not decoration: two orders created in the same instant
    // have no guaranteed relative order otherwise, and offset pagination
    // relies on that order staying identical between the count query above
    // and every subsequent page — without one, a page boundary landing on a
    // tie can skip or repeat a row.
    .orderBy([
      { column: 'o.created_at', order: 'desc' },
      { column: 'o.id', order: 'desc' },
    ])
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
  scope: PartyScope,
  runner: Runner = db(),
  options: { includeDeleted?: boolean } = {},
): Promise<Order | null> {
  const row = await baseQuery(tenantId, scope, runner, options).where('o.id', id).first();
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

/**
 * Row-locks the order within the caller's transaction, before checking
 * whether it may still be dispatched — mirrors `product.repository.ts`'s
 * `lockProduct`/`party.repository.ts`'s `lockParty`. Without it, two
 * `dispatchOrder` calls that overlap before either commits both read
 * `dispatched_at` as null under READ COMMITTED and both write stock
 * movements. `null` means the order does not exist (or is soft-deleted);
 * the returned `dispatchedAt` is the caller's authoritative, freshly-locked
 * answer to "has this already been dispatched?", and `stageId` and `fieldHlc`
 * the stage and per-field clocks as they stand under the lock, for the write
 * that follows.
 */
export async function lockOrder(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<{ dispatchedAt: string | null; stageId: string; fieldHlc: Record<string, string> } | null> {
  const row = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .forUpdate()
    .first<{ dispatched_at: string | null; stage_id: string; field_hlc: unknown } | undefined>(
      'dispatched_at',
      'stage_id',
      'field_hlc',
    );

  if (!row) return null;
  return {
    dispatchedAt: row.dispatched_at,
    stageId: row.stage_id,
    fieldHlc: toJsonObject(row.field_hlc) as Record<string, string>,
  };
}

/**
 * Stamps the sync clock like `updateOrderColumns` does. It used to set only the
 * stage and `dispatched_at`, leaving `version`, `hlc` and `field_hlc` as they
 * were — so the offline merge bookkeeping never saw a dispatch happen.
 */
export async function markDispatched(
  tenantId: string,
  id: string,
  stageId: string,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id }).update({
    stage_id: stageId,
    dispatched_at: trx.fn.now(),
    hlc: meta.hlc,
    field_hlc: JSON.stringify(meta.fieldHlc),
    version: trx.raw('version + 1'),
    updated_at: trx.fn.now(),
  });
}

/**
 * Soft delete. Active reservations are the caller's responsibility to
 * release first (`reservation.repository.ts:releaseForOrder`) — this
 * function only stamps the tombstone and the sync clock.
 */
export async function softDeleteOrder(
  tenantId: string,
  id: string,
  actorUserId: string | null,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Order | null> {
  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .update({
      deleted_at: trx.fn.now(),
      deleted_by: actorUserId,
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    });

  // Unscoped: the service already checked access before asking for this write,
  // and refusing to read back a row we just wrote would report a phantom failure.
  return updated
    ? findOrderById(tenantId, id, UNSCOPED_PARTY_ACCESS, trx, { includeDeleted: true })
    : null;
}

export async function restoreOrder(
  tenantId: string,
  id: string,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Order | null> {
  const updated = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNotNull('deleted_at')
    .update({
      deleted_at: null,
      deleted_by: null,
      version: trx.raw('version + 1'),
      hlc: meta.hlc,
      field_hlc: JSON.stringify(meta.fieldHlc),
      updated_at: trx.fn.now(),
    });

  // Unscoped: the service already checked access before asking for this write,
  // and refusing to read back a row we just wrote would report a phantom failure.
  return updated
    ? findOrderById(tenantId, id, UNSCOPED_PARTY_ACCESS, trx, { includeDeleted: true })
    : null;
}

export async function countOrders(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<number> {
  const query = runner(TABLE).where({ tenant_id: tenantId }).whereNull('deleted_at');

  applyPartyScope(query, tenantId, `${TABLE}.party_id`, scope, { level: 'view' });

  const rows = await query.count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}
