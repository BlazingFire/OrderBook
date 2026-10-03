/**
 * Reviewing sync conflicts (docs/LEAD_GENERATION_FLOW.md §4.5).
 *
 * The merge already decided which value the record holds. This is the human
 * follow-up: someone looks at what was shadowed and either accepts it or puts
 * the old value back. Nothing here is automatic — that is the point of keeping
 * the losing value instead of discarding it.
 */

import type { ConflictResolutionInput, SyncConflict } from '@orderbook/shared';
import { JSON_COLUMNS, ProductValidationError, validateProductInput } from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { MASTER_MERGE_COLUMNS } from '../domain/merge-columns.js';
import { resolvePartyScope, UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as productVariantRepo from '../repositories/product-variant.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as syncRepo from '../repositories/sync.repository.js';
import { publishChange } from './change-bus.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';
import { requirePartyAccess } from './party-access.service.js';
import {
  assertMergeAllowed,
  assertMergeUnlocked,
  loadMergeTarget,
  lockMergeTarget,
  normaliseVariants,
} from './sync.service.js';

/**
 * Wire field → column, for restoring a losing value. Reuses the merge's own
 * map rather than a second, hand-maintained copy — this one used to list
 * only 4 of `product`'s mergeable fields, so restoring the losing value of
 * anything else (weightKg, size, ...) threw
 * `cannotRestoreField` even though the merge itself had correctly detected
 * the clash and the losing value really was recoverable. `conflict.entity`
 * is a plain `string` (not `MergeableEntity`), so the wider `Record` type
 * keeps the existing `?.` runtime guard for an entity this map has no entry
 * for.
 */
const COLUMNS: Record<string, Record<string, string>> = MASTER_MERGE_COLUMNS;

export async function listConflicts(
  actor: ActorContext,
  options: { includeResolved?: boolean } = {},
): Promise<SyncConflict[]> {
  requirePermission(actor, 'sync.resolveConflicts');
  return syncRepo.listConflicts(actor.tenantId, {
    ...options,
    scope: resolvePartyScope(actor),
  });
}

export async function resolveConflict(
  input: ConflictResolutionInput,
  actor: ActorContext,
): Promise<SyncConflict> {
  requirePermission(actor, 'sync.resolveConflicts');

  const conflict = await syncRepo.findConflict(actor.tenantId, input.conflictId);
  if (!conflict) throw new NotFoundError('Conflict');
  if (conflict.resolvedAt) throw new ValidationError('validation.conflict.alreadyReviewed');

  // Same scope `listConflicts` narrows by: a conflict on a party the caller
  // cannot see is not theirs to review, restore or dismiss.
  await requireConflictScope(conflict, actor);

  // A stage is put back as a move through the service, so the move rules, the
  // timeline entry and the activity entry apply as they do to any move. It
  // runs before the review is marked, in its own transaction, as the service
  // always does.
  const restoreStage =
    input.action === 'restoreLoser' &&
    conflict.field === 'stageId' &&
    (conflict.entity === 'lead' || conflict.entity === 'order');
  if (restoreStage) {
    if (typeof conflict.losingValue !== 'string') {
      throw new ValidationError('validation.conflict.cannotRestoreField', { field: conflict.field });
    }
    const move = { id: conflict.entityId, stageId: conflict.losingValue };
    if (conflict.entity === 'lead') await leadService.setStage(move, actor);
    else await orderService.setStage(move, actor);
  }

  const resolved = await db().transaction(async (trx) => {
    if (input.action === 'restoreLoser' && !restoreStage) {
      // Sets, not columns: the lead's lines and a product's variants are child
      // tables, restored as a whole set like they were merged.
      if (
        (conflict.entity === 'lead' && conflict.field === 'items') ||
        (conflict.entity === 'product' && conflict.field === 'variants')
      ) {
        await restoreSet(conflict, actor, trx);
      } else {
        await restoreColumn(conflict, actor, trx);
      }
    }

    const row = await syncRepo.markResolved(
      actor.tenantId,
      input.conflictId,
      actorUserId(actor),
      trx,
    );
    if (!row) throw new NotFoundError('Conflict');

    // Logged under the conflicted record's own type, so a party-restricted
    // reader's log narrows it like any other entry about that record. Two
    // call sites with literal actions rather than a ternary, so a search for
    // either action finds where it is written; the entity type is a variable,
    // so `i18n-tokens.test.ts` checks both tokens by hand.
    const entry = {
      tenantId: actor.tenantId,
      entityType: conflict.entity,
      entityId: conflict.entityId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { field: conflict.field, conflictId: String(conflict.id) },
    };
    if (input.action === 'restoreLoser') {
      await activityLog.recordActivity({ ...entry, action: 'conflict_restored' }, actor, trx);
    } else {
      await activityLog.recordActivity({ ...entry, action: 'conflict_kept' }, actor, trx);
    }
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

type Trx = Parameters<typeof leadRepo.updateLeadColumns>[4];

async function requireConflictScope(conflict: SyncConflict, actor: ActorContext): Promise<void> {
  const { entity, entityId } = conflict;
  if (entity === 'party') return requirePartyAccess(entityId, 'view', actor);
  if (entity !== 'lead' && entity !== 'order') return;
  const target = await db().transaction((trx) => loadMergeTarget(entity, actor.tenantId, entityId, trx));
  if (typeof target?.values.partyId === 'string') {
    await requirePartyAccess(target.values.partyId, 'view', actor);
  }
}

/** The merge's own gates, so a restore is no way around what a sync refuses. */
async function assertRestorable(
  entity: string,
  target: { values: Record<string, unknown> },
  fields: string[],
  patch: Record<string, unknown>,
  actor: ActorContext,
): Promise<void> {
  const kind = entity as keyof typeof MASTER_MERGE_COLUMNS;
  if (kind === 'party') await requirePartyAccess(String(target.values.id), 'manage', actor);
  else if (typeof target.values.partyId === 'string') {
    await requirePartyAccess(target.values.partyId, 'manage', actor);
  }
  assertMergeUnlocked(kind, target.values, fields);
  await assertMergeAllowed(kind, target.values, patch, actor);
}

async function restoreColumn(conflict: SyncConflict, actor: ActorContext, trx: Trx): Promise<void> {
  const tenantId = actor.tenantId;
  const column = COLUMNS[conflict.entity]?.[conflict.field];
  if (!column) {
    throw new ValidationError('validation.conflict.cannotRestoreField', {
      field: conflict.field,
    });
  }

  const hlc = await nextHlc(trx);
  const value = JSON_COLUMNS.has(column)
    ? JSON.stringify(conflict.losingValue ?? {})
    : (conflict.losingValue as unknown);

  // A category that has since been deleted cannot be put back.
  if (conflict.entity === 'product' && column === 'category_id') {
    const live =
      typeof value === 'string' && (await productRepo.findCategoryById(tenantId, value, trx)) !== null;
    if (!live) throw new ValidationError('validation.product.categoryRequired');
  }

  // Written as a fresh edit with a new HLC, not by rewinding the clock.
  // Restoring is a decision made now; back-dating it would let the value it
  // replaced win again on the next sync.
  await writeRestore(conflict, actor, column, value, hlc, trx);
}

/**
 * Locks the record and reads its field clocks, so a restore stamps only the
 * one field it changed. Writing a bare `{ [field]: hlc }` replaced the whole
 * map and wiped every other field's clock, after which a stale offline edit
 * to any of them would win again.
 */
async function lockedTarget(entity: string, tenantId: string, id: string, trx: Trx) {
  if (!(entity in MASTER_MERGE_COLUMNS)) {
    throw new ValidationError('validation.conflict.cannotRestoreEntity', { entity });
  }
  const kind = entity as keyof typeof MASTER_MERGE_COLUMNS;
  await lockMergeTarget(kind, tenantId, id, trx);
  const target = await loadMergeTarget(kind, tenantId, id, trx);
  if (!target) throw new NotFoundError(entity);
  return target;
}

async function restoreSet(conflict: SyncConflict, actor: ActorContext, trx: Trx): Promise<void> {
  const tenantId = actor.tenantId;
  const hlc = await nextHlc(trx);
  const target = await lockedTarget(conflict.entity, tenantId, conflict.entityId, trx);
  await assertRestorable(conflict.entity, target, [conflict.field], {}, actor);
  const meta = { hlc, fieldHlc: { ...target.fieldHlc, [conflict.field]: hlc } };

  if (conflict.entity === 'lead') {
    if (target.values.convertedOrderId) throw new ValidationError('validation.lead.convertedLocked');
    const lines = await leadService.buildLines(tenantId, String(target.values.partyId), conflict.losingValue as never, {
      partyWiseMode: Boolean(target.values.partyWiseMode),
    });
    await leadRepo.replaceLeadLines(tenantId, conflict.entityId, lines, trx);
    await leadRepo.updateLeadColumns(tenantId, conflict.entityId, {}, meta, trx);
    return;
  }

  const variants = normaliseVariants(Array.isArray(conflict.losingValue) ? conflict.losingValue : []);
  try {
    validateProductInput({
      hasVariants: Boolean(target.values.hasVariants),
      variants,
    } as Parameters<typeof validateProductInput>[0]);
  } catch (error) {
    if (error instanceof ProductValidationError) throw new ValidationError(error.messageKey);
    throw error;
  }
  await productVariantRepo.replaceVariants(tenantId, conflict.entityId, variants, trx);
  await productRepo.updateProductColumns(tenantId, conflict.entityId, {}, meta, trx);
}

async function writeRestore(
  conflict: SyncConflict,
  actor: ActorContext,
  column: string,
  value: unknown,
  hlc: string,
  trx: Trx,
): Promise<void> {
  const { entity, entityId: id, field } = conflict;
  const tenantId = actor.tenantId;
  const patch = { [column]: value };
  const target = await lockedTarget(entity, tenantId, id, trx);
  // `assertMergeAllowed` checks the wire-named value, and may normalise it.
  const wire: Record<string, unknown> = { [field]: conflict.losingValue };
  await assertRestorable(entity, target, [field], wire, actor);
  if (field in wire && wire[field] !== conflict.losingValue) patch[column] = wire[field];
  const meta = { hlc, fieldHlc: { ...target.fieldHlc, [field]: hlc } };

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
      throw new ValidationError('validation.conflict.cannotRestoreEntity', { entity });
  }
}

async function republish(entity: string, tenantId: string, id: string): Promise<void> {
  const payload =
    entity === 'lead'
      ? await leadRepo.findLeadById(tenantId, id, UNSCOPED_PARTY_ACCESS)
      : entity === 'order'
        ? await orderRepo.findOrderById(tenantId, id, UNSCOPED_PARTY_ACCESS)
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
