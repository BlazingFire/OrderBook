/**
 * Reviewing sync conflicts (docs/LEAD_GENERATION_FLOW.md §4.5).
 *
 * The merge already decided which value the record holds. This is the human
 * follow-up: someone looks at what was shadowed and either accepts it or puts
 * the old value back. Nothing here is automatic — that is the point of keeping
 * the losing value instead of discarding it.
 */

import type { ConflictResolutionInput, SyncConflict } from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import { publishChange } from './change-bus.js';

/** Wire field → column, mirroring the map the merge writes through. */
const COLUMNS: Record<string, Record<string, string>> = {
  lead: {
    partyId: 'party_id',
    ownerId: 'owner_id',
    stageId: 'stage_id',
    sourcePlatform: 'source_platform',
    followUpDate: 'follow_up_date',
    partyWiseMode: 'party_wise_mode',
    notes: 'notes',
    customFields: 'custom_fields',
  },
  order: {
    dispatchAddressLabel: 'dispatch_address_label',
    expectedDispatchDate: 'expected_dispatch_date',
    totalWeightKgOverride: 'total_weight_kg_override',
    notes: 'notes',
    customFields: 'custom_fields',
  },
  party: { name: 'name', phone: 'phone', notes: 'notes', customFields: 'custom_fields' },
  product: { name: 'name', alias: 'alias', rate: 'rate', customFields: 'custom_fields' },
};

export async function listConflicts(
  actor: ActorContext,
  options: { includeResolved?: boolean } = {},
): Promise<SyncConflict[]> {
  requirePermission(actor, 'sync.resolveConflicts');
  return syncRepo.listConflicts(actor.tenantId, options);
}

export async function resolveConflict(
  input: ConflictResolutionInput,
  actor: ActorContext,
): Promise<SyncConflict> {
  requirePermission(actor, 'sync.resolveConflicts');

  const conflict = await syncRepo.findConflict(actor.tenantId, input.conflictId);
  if (!conflict) throw new NotFoundError('Conflict');
  if (conflict.resolvedAt) throw new ValidationError('That conflict was already reviewed');

  const resolved = await db().transaction(async (trx) => {
    if (input.action === 'restoreLoser') {
      const column = COLUMNS[conflict.entity]?.[conflict.field];
      if (!column) {
        throw new ValidationError(
          `Cannot restore "${conflict.field}" automatically — edit the record directly`,
        );
      }

      const hlc = await nextHlc(trx);
      const value =
        column === 'custom_fields'
          ? JSON.stringify(conflict.losingValue ?? {})
          : (conflict.losingValue as unknown);

      // Written as a fresh edit with a new HLC, not by rewinding the clock.
      // Restoring is a decision made now; back-dating it would let the value it
      // replaced win again on the next sync.
      await writeRestore(conflict.entity, actor.tenantId, conflict.entityId, column, value, hlc, trx);
    }

    const row = await syncRepo.markResolved(
      actor.tenantId,
      input.conflictId,
      actorUserId(actor),
      trx,
    );
    if (!row) throw new NotFoundError('Conflict');
    return row;
  });

  if (input.action === 'restoreLoser') await republish(conflict.entity, actor.tenantId, conflict.entityId);
  publishChange({
    entity: 'sync_conflict',
    action: 'updated',
    id: String(resolved.id),
    payload: resolved,
  });

  return resolved;
}

async function writeRestore(
  entity: string,
  tenantId: string,
  id: string,
  column: string,
  value: unknown,
  hlc: string,
  trx: Parameters<typeof leadRepo.updateLeadColumns>[4],
): Promise<void> {
  const patch = { [column]: value };
  const meta = { hlc, fieldHlc: {} };

  switch (entity) {
    case 'lead':
      return leadRepo.updateLeadColumns(tenantId, id, patch, meta, trx);
    case 'order':
      return orderRepo.updateOrderColumns(tenantId, id, patch, meta, trx);
    case 'party':
      return partyRepo.updatePartyColumns(tenantId, id, patch, meta, trx);
    case 'product':
      return productRepo.updateProductColumns(tenantId, id, patch, meta, trx);
    default:
      throw new ValidationError(`Cannot restore a ${entity} value automatically`);
  }
}

async function republish(entity: string, tenantId: string, id: string): Promise<void> {
  const payload =
    entity === 'lead'
      ? await leadRepo.findLeadById(tenantId, id)
      : entity === 'order'
        ? await orderRepo.findOrderById(tenantId, id)
        : entity === 'party'
          ? await partyRepo.findPartyById(tenantId, id)
          : await productRepo.findProductById(tenantId, id);

  if (payload) {
    publishChange({
      entity: entity as 'lead' | 'order' | 'party' | 'product',
      action: 'updated',
      id,
      payload,
    });
  }
}

export async function countOpen(tenantId: string): Promise<number> {
  return syncRepo.countOpenConflicts(tenantId);
}
