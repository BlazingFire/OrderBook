/**
 * The per-record timeline (docs/LEAD_GENERATION_FLOW.md §3.1, §4.2).
 *
 * Two kinds of entry share one table: `system` entries written automatically by
 * a stage change, and `remark` entries a person typed. Keeping them together —
 * rather than in an audit table and a notes table — is what makes the record's
 * history read as one story in the UI.
 *
 * This is append-only. Nothing here ever updates or deletes: a history you can
 * edit is not a history.
 */

import type { LineItemParentType, TimelineEntry } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import { allocatePermanentId } from './identity.repository.js';
import { mapTimelineEntry } from './mappers.js';
import type { TransactionContext } from './transaction.js';

const TABLE = 'timeline_entries';

type Runner = Knex | Knex.Transaction;

export interface NewTimelineEntry {
  tenantId: string;
  parentType: LineItemParentType;
  parentId: string;
  kind: 'system' | 'remark';
  message: string;
  fromStageId?: string | null;
  toStageId?: string | null;
  actorUserId?: string | null;
}

export async function appendEntry(
  entry: NewTimelineEntry,
  trx: TransactionContext,
): Promise<string> {
  const id = await allocatePermanentId(entry.tenantId, 'timeline_entry', trx);

  await trx(TABLE).insert({
    id,
    tenant_id: entry.tenantId,
    parent_type: entry.parentType,
    parent_id: entry.parentId,
    kind: entry.kind,
    message: entry.message,
    from_stage_id: entry.fromStageId ?? null,
    to_stage_id: entry.toStageId ?? null,
    actor_user_id: entry.actorUserId ?? null,
  });

  return id;
}

export async function loadTimelinesFor(
  tenantId: string,
  parentType: LineItemParentType,
  parentIds: string[],
  runner: Runner = db(),
): Promise<Map<string, TimelineEntry[]>> {
  const byParent = new Map<string, TimelineEntry[]>();
  if (parentIds.length === 0) return byParent;

  const rows = await runner(`${TABLE} as t`)
    .leftJoin('users as u', 'u.id', 't.actor_user_id')
    .where({ 't.tenant_id': tenantId, 't.parent_type': parentType })
    .whereIn('t.parent_id', parentIds)
    .orderBy('t.created_at', 'asc')
    .select('t.*', 'u.full_name as actor_name');

  for (const row of rows) {
    const entry = mapTimelineEntry(row);
    const bucket = byParent.get(entry.parentId);
    if (bucket) bucket.push(entry);
    else byParent.set(entry.parentId, [entry]);
  }

  return byParent;
}
