/**
 * Leads. A lead no longer becomes an order by changing status — it is converted,
 * gaining `converted_order_id`, and survives as history
 * (docs/LEAD_GENERATION_FLOW.md §5.1).
 */

import type { Lead, LeadListQuery, Paginated } from '@orderbook/shared';
import type { Knex } from 'knex';

import { evaluateCompleteness } from '../domain/custom-fields.js';
import type { LineSnapshot } from '../domain/line-items.js';
import { orderTotalAmount } from '../domain/line-items.js';
import { db } from '../db/knex.js';
import * as customFields from './custom-field.repository.js';
import { allocatePermanentId } from './identity.repository.js';
import * as lineItems from './line-item.repository.js';
import { firstCount, mapLead } from './mappers.js';
import * as timeline from './timeline.repository.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'leads';

type Runner = Knex | Knex.Transaction;

function baseQuery(tenantId: string, runner: Runner = db()) {
  return runner(`${TABLE} as l`)
    .join('parties as pa', 'pa.id', 'l.party_id')
    .join('pipeline_stages as st', 'st.id', 'l.stage_id')
    .leftJoin('users as ow', 'ow.id', 'l.owner_id')
    .where('l.tenant_id', tenantId)
    .select(
      'l.*',
      'pa.name as party_name',
      'st.name as stage_name',
      'st.sequence as stage_sequence',
      'ow.full_name as owner_name',
    );
}

export async function listLeads(
  tenantId: string,
  options: LeadListQuery & { limit: number; offset: number },
): Promise<Paginated<Lead>> {
  const base = baseQuery(tenantId);

  if (options.stageIds?.length) base.whereIn('l.stage_id', options.stageIds);
  if (options.ownerId) base.where('l.owner_id', options.ownerId);

  // A converted lead is history: it stays out of the board unless asked for,
  // otherwise every won deal would clutter the pipeline forever.
  if (!options.includeConverted) base.whereNull('l.converted_order_id');

  if (options.followUpDueOnly) {
    base.whereNotNull('l.follow_up_date').andWhere('l.follow_up_date', '<=', db().fn.now());
  }

  if (options.search) {
    const pattern = `%${options.search}%`;
    base.andWhere((builder) =>
      builder.whereILike('l.id', pattern).orWhereILike('pa.name', pattern),
    );
  }

  const countRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<Array<{ count: string }>>('l.id as count');

  const rows = await base
    .clone()
    .orderBy('l.created_at', 'desc')
    .limit(options.limit)
    .offset(options.offset);

  return {
    items: await hydrate(tenantId, rows),
    total: firstCount(countRows),
    limit: options.limit,
    offset: options.offset,
  };
}

export async function findLeadById(
  tenantId: string,
  id: string,
  runner: Runner = db(),
): Promise<Lead | null> {
  const row = await baseQuery(tenantId, runner).where('l.id', id).first();
  if (!row) return null;

  const [lead] = await hydrate(tenantId, [row], runner);
  return lead ?? null;
}

/** Attach lines, timeline and completeness in three queries, not 3×N. */
async function hydrate(
  tenantId: string,
  rows: Array<Record<string, unknown>>,
  runner: Runner = db(),
): Promise<Lead[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => String(row.id));
  const [linesByLead, timelineByLead, definitions] = await Promise.all([
    lineItems.loadLinesFor(tenantId, 'lead', ids, runner),
    timeline.loadTimelinesFor(tenantId, 'lead', ids, runner),
    customFields.definitionsFor(tenantId, 'lead', runner),
  ]);

  return rows.map((row) => {
    const id = String(row.id);
    return mapLead(
      row,
      linesByLead.get(id) ?? [],
      timelineByLead.get(id) ?? [],
      evaluateCompleteness(
        (row.custom_fields as Record<string, unknown> | null) ?? {},
        definitions,
      ),
    );
  });
}

export interface NewLead {
  tenantId: string;
  partyId: string;
  ownerId: string | null;
  stageId: string;
  sourcePlatform: string | null;
  followUpDate: string | null;
  partyWiseMode: boolean;
  notes: string | null;
  customFields: Record<string, unknown>;
  sourcePanelId: string | null;
  createdByUserId: string | null;
  hlc: string;
  fieldHlc: Record<string, string>;
  temporaryId: string | null;
  /** Pre-assigned when a panel's offline id is being promoted. */
  id?: string;
}

export async function insertLead(
  lead: NewLead,
  lines: LineSnapshot[],
  trx: TransactionContext,
): Promise<string> {
  const id = lead.id ?? (await allocatePermanentId(lead.tenantId, 'lead', trx));

  await trx(TABLE).insert({
    id,
    tenant_id: lead.tenantId,
    party_id: lead.partyId,
    owner_id: lead.ownerId,
    stage_id: lead.stageId,
    source_platform: lead.sourcePlatform,
    follow_up_date: lead.followUpDate,
    party_wise_mode: lead.partyWiseMode,
    notes: lead.notes,
    custom_fields: JSON.stringify(lead.customFields),
    total_amount: orderTotalAmount(lines),
    source_panel_id: lead.sourcePanelId,
    created_by_user_id: lead.createdByUserId,
    hlc: lead.hlc,
    field_hlc: JSON.stringify(lead.fieldHlc),
    temporary_id: lead.temporaryId,
  });

  await lineItems.insertLines(
    { tenantId: lead.tenantId, parentType: 'lead', parentId: id },
    lines,
    trx,
  );

  return id;
}

/**
 * Apply a patch of already-merged column values.
 *
 * The merge decided what wins before this is called; the repository's job is to
 * write it and bump the row's version, never to arbitrate.
 */
export async function updateLeadColumns(
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

export async function replaceLeadLines(
  tenantId: string,
  id: string,
  lines: LineSnapshot[],
  trx: TransactionContext,
): Promise<void> {
  await lineItems.replaceLines({ tenantId, parentType: 'lead', parentId: id }, lines, trx);
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .update({ total_amount: orderTotalAmount(lines), updated_at: trx.fn.now() });
}

export async function markConverted(
  tenantId: string,
  id: string,
  orderId: string,
  trx: TransactionContext,
): Promise<void> {
  await trx(TABLE).where({ tenant_id: tenantId, id }).update({
    converted_order_id: orderId,
    converted_at: trx.fn.now(),
    updated_at: trx.fn.now(),
  });
}

export async function countOpenLeads(tenantId: string, runner: Runner = db()): Promise<number> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('converted_order_id')
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

export async function countFollowUpsDue(
  tenantId: string,
  runner: Runner = db(),
): Promise<number> {
  const rows = await runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('converted_order_id')
    .whereNotNull('follow_up_date')
    .andWhere('follow_up_date', '<=', runner.fn.now())
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}
