/**
 * Sync bookkeeping: mutation idempotency and the conflict log
 * (docs/LEAD_GENERATION_FLOW.md §4.5, §7).
 *
 * `applied_mutations` is what makes an outbox flush safe to repeat. A panel
 * that pushes a batch, loses the link before the acknowledgement lands, and
 * pushes again on reconnect must not apply anything twice — so the Master
 * remembers each mutation id and returns the original result.
 */

import type { MutationResult, SyncConflict } from '@orderbook/shared';
import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { applyPartyScope } from './party-access.repository.js';
import { firstCount, mapSyncConflict } from './mappers.js';
import type { TransactionContext } from './transaction.js';

type Runner = Knex | Knex.Transaction;

export async function findAppliedMutations(
  tenantId: string,
  mutationIds: string[],
  runner: Runner = db(),
): Promise<Map<string, MutationResult>> {
  if (mutationIds.length === 0) return new Map();

  const rows = await runner('applied_mutations')
    .where({ tenant_id: tenantId })
    .whereIn('mutation_id', mutationIds)
    .select<Array<{ mutation_id: string; result: MutationResult }>>('mutation_id', 'result');

  return new Map(rows.map((row) => [row.mutation_id, row.result]));
}

export async function recordAppliedMutation(
  record: { tenantId: string; mutationId: string; entity: string; entityId: string },
  result: MutationResult,
  trx: TransactionContext,
): Promise<void> {
  await trx('applied_mutations')
    .insert({
      tenant_id: record.tenantId,
      mutation_id: record.mutationId,
      entity: record.entity,
      entity_id: record.entityId,
      status: result.status,
      result: JSON.stringify(result),
    })
    .onConflict(['tenant_id', 'mutation_id'])
    .ignore();
}

export interface NewConflict {
  tenantId: string;
  entity: string;
  entityId: string;
  field: string;
  losingValue: unknown;
  losingHlc: string;
  losingDeviceCode: string;
  winningValue: unknown;
  winningHlc: string;
  winningDeviceCode: string;
}

export async function recordConflicts(
  conflicts: NewConflict[],
  trx: TransactionContext,
): Promise<SyncConflict[]> {
  if (conflicts.length === 0) return [];

  const rows = await trx('sync_conflicts')
    .insert(
      conflicts.map((conflict) => ({
        tenant_id: conflict.tenantId,
        entity: conflict.entity,
        entity_id: conflict.entityId,
        field: conflict.field,
        // JSONB, so a losing value of any shape survives — a string, a number,
        // or a whole line-item array.
        losing_value: JSON.stringify(conflict.losingValue ?? null),
        losing_hlc: conflict.losingHlc,
        losing_device_code: conflict.losingDeviceCode,
        winning_value: JSON.stringify(conflict.winningValue ?? null),
        winning_hlc: conflict.winningHlc,
        winning_device_code: conflict.winningDeviceCode,
      })),
    )
    .returning('*');

  return rows.map(mapSyncConflict);
}

export async function listConflicts(
  tenantId: string,
  options: { includeResolved?: boolean; limit?: number; scope?: PartyScope } = {},
  runner: Runner = db(),
): Promise<SyncConflict[]> {
  const query = runner('sync_conflicts').where({ tenant_id: tenantId });
  if (!options.includeResolved) query.whereNull('resolved_at');

  // A conflict names an entity and both competing values, so a lead conflict
  // discloses the lead. Only the two party-scoped entities are narrowed; a
  // `product` conflict belongs to the catalogue and stays visible to everyone.
  if (options.scope) {
    const scope = options.scope;
    query.where((outer) => {
      outer.whereNotIn('entity', ['lead', 'order']);

      for (const [entity, table] of [
        ['lead', 'leads'],
        ['order', 'orders'],
      ] as const) {
        outer.orWhere((branch) => {
          branch.where('entity', entity).whereExists((sub) => {
            const parent = sub
              .select(db().raw('1'))
              .from(`${table} as scoped_parent`)
              .where('scoped_parent.tenant_id', tenantId)
              .whereRaw('scoped_parent.id = sync_conflicts.entity_id');

            return applyPartyScope(parent, tenantId, 'scoped_parent.party_id', scope, {
              level: 'view',
            });
          });
        });
      }
    });
  }

  const rows = await query.orderBy('created_at', 'desc').limit(options.limit ?? 200).select('*');
  return rows.map(mapSyncConflict);
}

export async function findConflict(
  tenantId: string,
  id: number,
  runner: Runner = db(),
): Promise<SyncConflict | null> {
  const row = await runner('sync_conflicts').where({ tenant_id: tenantId, id }).first();
  return row ? mapSyncConflict(row) : null;
}

export async function markResolved(
  tenantId: string,
  id: number,
  userId: string | null,
  trx: TransactionContext,
): Promise<SyncConflict | null> {
  const [row] = await trx('sync_conflicts')
    .where({ tenant_id: tenantId, id })
    .update({ resolved_at: trx.fn.now(), resolved_by_user_id: userId })
    .returning('*');

  return row ? mapSyncConflict(row) : null;
}

export async function countOpenConflicts(tenantId: string): Promise<number> {
  const rows = await db()('sync_conflicts')
    .where({ tenant_id: tenantId })
    .whereNull('resolved_at')
    .count<Array<{ count: string }>>('id as count');
  return firstCount(rows);
}
