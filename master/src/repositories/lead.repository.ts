/**
 * Leads. A lead no longer becomes an order by changing status — it is converted,
 * gaining `converted_order_id`, and survives as history
 * (docs/LEAD_GENERATION_FLOW.md §5.1).
 */

import type { Lead, LeadListQuery, Paginated, PartyScopeFilter } from '@orderbook/shared';
import type { Knex } from 'knex';

import { evaluateCompleteness } from '../domain/custom-fields.js';
import type { LineSnapshot } from '../domain/line-items.js';
import { UNSCOPED_PARTY_ACCESS, type PartyScope } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import * as customFields from './custom-field.repository.js';
import { allocatePermanentId } from './identity.repository.js';
import * as lineItems from './line-item.repository.js';
import { firstCount, mapLead } from './mappers.js';
import { applyRecordSearch } from './record-search.js';
import { applyPartyScope } from './party-access.repository.js';
import * as timeline from './timeline.repository.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'leads';

type Runner = Knex | Knex.Transaction;

/**
 * `scope` is required, not optional. Every read of a lead goes through here, so
 * this is the one place the party scope has to hold — and an optional
 * parameter would let any caller disable it by omission, which is exactly how
 * `expectedVersion` came to be unenforced everywhere it mattered. Internal
 * reads that legitimately need the row regardless pass `UNSCOPED_PARTY_ACCESS`
 * and say so.
 */
function baseQuery(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
  options: { includeDeleted?: boolean; filter?: PartyScopeFilter } = {},
) {
  const query = runner(`${TABLE} as l`)
    .join('parties as pa', 'pa.id', 'l.party_id')
    .join('pipeline_stages as st', 'st.id', 'l.stage_id')
    .leftJoin('users as ow', 'ow.id', 'l.owner_id')
    .where('l.tenant_id', tenantId)
    .select(
      'l.*',
      'pa.name as party_name',
      'st.name as stage_name',
      'st.sequence as stage_sequence',
      'ow.display_name as owner_name',
    );

  applyPartyScope(query, tenantId, 'l.party_id', scope, { level: 'view', filter: options.filter });

  if (!options.includeDeleted) query.whereNull('l.deleted_at');
  return query;
}

export async function listLeads(
  tenantId: string,
  options: LeadListQuery & { limit: number; offset: number; partyScope: PartyScope },
): Promise<Paginated<Lead>> {
  const base = baseQuery(tenantId, options.partyScope, db(), { filter: options.scope });

  if (options.stageIds?.length) base.whereIn('l.stage_id', options.stageIds);
  if (options.ownerId) base.where('l.owner_id', options.ownerId);

  // A converted lead is history: it stays out of the board unless asked for,
  // otherwise every won deal would clutter the pipeline forever.
  // `convertedOnly` is the opposite slice, so it skips that guard rather than
  // contradicting it.
  if (options.convertedOnly) base.whereNotNull('l.converted_order_id');
  else if (!options.includeConverted) base.whereNull('l.converted_order_id');
  if (options.partyId) base.where('l.party_id', options.partyId);

  if (options.followUpDueOnly) {
    base.whereNotNull('l.follow_up_date').andWhere('l.follow_up_date', '<=', db().fn.now());
  }

  applyRecordSearch(base, options.search, {
    alias: 'l',
    parentType: 'lead',
    columns: ['l.id', 'pa.name', 'ow.display_name', 'st.name', 'l.notes', 'l.converted_order_id'],
  });

  const countRows = await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<Array<{ count: string }>>('l.id as count');

  const rows = await base
    .clone()
    // A tiebreaker, not decoration: two leads created in the same instant
    // have no guaranteed relative order otherwise, and offset pagination
    // relies on that order staying identical between the count query above
    // and every subsequent page — without one, a page boundary landing on a
    // tie can skip or repeat a row.
    .orderBy([
      { column: 'l.created_at', order: 'desc' },
      { column: 'l.id', order: 'desc' },
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

export async function findLeadById(
  tenantId: string,
  id: string,
  scope: PartyScope,
  runner: Runner = db(),
  options: { includeDeleted?: boolean } = {},
): Promise<Lead | null> {
  const row = await baseQuery(tenantId, scope, runner, options).where('l.id', id).first();
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
    .update({ updated_at: trx.fn.now() });
}

/**
 * Row-locks the lead within the caller's transaction, before checking
 * whether it may still be converted or deleted — mirrors
 * `party.repository.ts`'s `lockParty`. Without it, two `convertLead` calls
 * (or a `convertLead` and a `deleteLead`) that overlap before either commits
 * both read `converted_order_id` as null under READ COMMITTED and both
 * proceed. `null` means the lead does not exist or is already soft-deleted.
 */
export async function lockLead(
  tenantId: string,
  id: string,
  trx: TransactionContext,
): Promise<{ convertedOrderId: string | null } | null> {
  const row = await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('deleted_at')
    .forUpdate()
    .first<{ converted_order_id: string | null } | undefined>('converted_order_id');

  if (!row) return null;
  return { convertedOrderId: row.converted_order_id };
}

export async function markConverted(
  tenantId: string,
  id: string,
  orderId: string,
  trx: TransactionContext,
): Promise<void> {
  // Defense in depth alongside the caller's `lockLead` re-check: harmless
  // once the row is locked for the transaction's duration, but cheap enough
  // to keep even if a future caller ever calls this without the lock.
  await trx(TABLE)
    .where({ tenant_id: tenantId, id })
    .whereNull('converted_order_id')
    .update({
      converted_order_id: orderId,
      converted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
}

/**
 * Soft delete. Line items are not themselves marked — they carry no
 * `deleted_at` of their own and are only ever reached through their parent,
 * so once the lead is gone they are unreachable through any surface the
 * product exposes. Restoring the lead makes them visible again exactly as
 * they were, which is what "cascades to its line items" means here: nothing
 * is copied or rewritten, the parent's own tombstone is the whole mechanism.
 */
export async function softDeleteLead(
  tenantId: string,
  id: string,
  actorUserId: string | null,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Lead | null> {
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

  // Unscoped: the service checked access before this write, and refusing to
  // read back a row we just wrote would report a phantom failure.
  return updated
    ? findLeadById(tenantId, id, UNSCOPED_PARTY_ACCESS, trx, { includeDeleted: true })
    : null;
}

export async function restoreLead(
  tenantId: string,
  id: string,
  meta: { hlc: string; fieldHlc: Record<string, string> },
  trx: TransactionContext,
): Promise<Lead | null> {
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

  // Unscoped: the service checked access before this write, and refusing to
  // read back a row we just wrote would report a phantom failure.
  return updated
    ? findLeadById(tenantId, id, UNSCOPED_PARTY_ACCESS, trx, { includeDeleted: true })
    : null;
}

export async function countOpenLeads(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<number> {
  const query = runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('converted_order_id')
    .whereNull('deleted_at');

  applyPartyScope(query, tenantId, `${TABLE}.party_id`, scope, { level: 'view' });

  const rows = await query.count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}

export async function countFollowUpsDue(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<number> {
  const query = runner(TABLE)
    .where({ tenant_id: tenantId })
    .whereNull('converted_order_id')
    .whereNull('deleted_at')
    .whereNotNull('follow_up_date')
    .andWhere('follow_up_date', '<=', runner.fn.now());

  applyPartyScope(query, tenantId, `${TABLE}.party_id`, scope, { level: 'view' });

  const rows = await query.count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}
