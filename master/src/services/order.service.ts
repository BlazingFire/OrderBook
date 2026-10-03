/**
 * Orders: conversion from a lead, their own pipeline, and dispatch
 * (docs/LEAD_GENERATION_FLOW.md §5, §6).
 *
 * Conversion and dispatch each run in a single transaction. That is not
 * incidental tidiness — an order that saved without its reservations, or a
 * dispatch that consumed reservations without writing the ledger entry, would
 * leave stock permanently disagreeing with itself, and nothing in the UI would
 * reveal which half was wrong.
 */

import { fieldFor, ORDER_COLUMNS, recordNumber } from '@orderbook/shared';
import type {
  BinBlocker,
  BinRestoreResult,
  LeadConvertInput,
  Order,
  OrderDispatchInput,
  OrderListQuery,
  OrderUpdateInput,
  Paginated,
} from '@orderbook/shared';

import { assertFieldsFresh } from '../domain/access.js';
import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import {
  assertConvertible,
  copyLinesForOrder,
  planDispatchMovements,
  planReservations,
} from '../domain/conversion.js';
import { normalizeCustomFields } from '../domain/custom-fields.js';
import { clampPaging } from '../domain/paging.js';
import { resolvePartyScope, UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import {
  assertStageFresh,
  assertStageMove,
  defaultStage,
  findStage,
  stageChangeMessage,
  type StageEdit,
} from '../domain/pipeline.js';
import { assertParentsLive } from '../domain/recycle-bin.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as inventoryRepo from '../repositories/inventory.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as lineItemRepo from '../repositories/line-item.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as recycleBinRepo from '../repositories/recycle-bin.repository.js';
import * as reservationRepo from '../repositories/reservation.repository.js';
import * as timelineRepo from '../repositories/timeline.repository.js';
import { publishStockFor } from './inventory.service.js';
import { actorStamp, publishChange } from './change-bus.js';
import { requirePartyAccess } from './party-access.service.js';
import * as inventoryService from './inventory.service.js';
import { getSetting } from './settings.service.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

export async function listOrders(
  query: OrderListQuery,
  actor: ActorContext,
): Promise<Paginated<Order>> {
  requirePermission(actor, 'orders.view');

  const page = await orderRepo.listOrders(actor.tenantId, {
    ...query,
    ...clampPaging(query, PAGING),
    partyScope: resolvePartyScope(actor),
  });

  return page;
}

export async function getOrder(id: string, actor: ActorContext): Promise<Order> {
  requirePermission(actor, 'orders.view');

  // Scoped at the query, so an order on somebody else's party is a 404 rather
  // than a 403 — on a read, confirming the record exists is itself the leak.
  const order = await orderRepo.findOrderById(actor.tenantId, id, resolvePartyScope(actor));
  if (!order) throw new NotFoundError('Order');

  return order;
}

/**
 * Convert a lead to an order (§5.1).
 *
 * The lead is not deleted, moved, or emptied. It keeps its lines and gains
 * `convertedOrderId`, so the question "what did we quote, and what became of
 * it?" stays answerable from the lead alone.
 */
export async function convertLead(
  input: LeadConvertInput,
  actor: ActorContext,
): Promise<Order> {
  requirePermission(actor, 'lead.convert');

  const lead = await leadRepo.findLeadById(actor.tenantId, input.leadId, UNSCOPED_PARTY_ACCESS);
  if (!lead) throw new NotFoundError('Lead');

  // Conversion is the only way an order comes into existence, so this is the
  // one place that has to refuse an order on a party the caller does not
  // manage — there is no `createOrder` to guard as well.
  await requirePartyAccess(lead.partyId, 'manage', actor);

  // Read the lines back as domain snapshots, the shape the copy rule takes.
  const leadLines = await lineItemRepo.loadSnapshots(actor.tenantId, 'lead', lead.id);

  // Read here, outside the transaction below. `getSetting` takes a pooled
  // connection, and the lock-order note inside that transaction is why: a
  // second connection acquired while holding `master_clock`'s lock is how a
  // pool this size deadlocks under load.
  assertConvertible(
    { convertedOrderId: lead.convertedOrderId, items: leadLines },
    {
      packagingRequired: await getSetting(actor.tenantId, 'leads.packagingRequiredOnConvert'),
    },
  );

  const orderStages = await pipelineRepo.stagesFor(actor.tenantId, 'order');
  const orderLines = copyLinesForOrder(leadLines);
  const reservationPlan = planReservations(orderLines);

  const orderId = await db().transaction(async (trx) => {
    // Stamped before the row lock, not after: every other write path takes
    // `master_clock`'s lock before the entity row's lock
    // (`catalog.service.ts`, ordinary lead/order updates), and taking them
    // in the opposite order here would deadlock (`40P01`) against one of
    // those the moment both race the same row. Safe to take unconditionally
    // — a throw below rolls this stamp back with the rest of the transaction.
    const hlc = await nextHlc(trx);

    // Re-check under the row's lock: the read above and `assertConvertible`
    // are both outside this transaction, so a second `convertLead` (or a
    // `deleteLead`) racing this one could otherwise commit between that read
    // and this write. The lock makes the second caller through this door
    // wait for the first to finish, then see the lead already converted.
    const locked = await leadRepo.lockLead(actor.tenantId, lead.id, trx);
    if (!locked) throw new NotFoundError('Lead');
    if (locked.convertedOrderId) throw new ValidationError('validation.lead.alreadyConverted');

    const { id, lineItemIds } = await orderRepo.insertOrder(
      {
        tenantId: actor.tenantId,
        leadId: lead.id,
        partyId: lead.partyId,
        ownerId: lead.ownerId || null,
        stageId: defaultStage(orderStages).id,
        dispatchAddressLabel: input.dispatchAddressLabel ?? null,
        expectedDispatchDate: input.expectedDispatchDate ?? null,
        notes: null,
        customFields: {},
        sourcePanelId: actor.actorType === 'office_panel' ? actor.actorId : null,
        createdByUserId: actorUserId(actor),
        hlc,
        temporaryId: null,
      },
      orderLines,
      trx,
    );

    await reservationRepo.insertReservations(
      { tenantId: actor.tenantId, orderId: id },
      reservationPlan.map((entry) => ({
        lineItemId: lineItemIds[entry.lineIndex] ?? '',
        productId: entry.productId,
        variantId: entry.variantId,
        quantity: entry.quantity,
      })),
      trx,
    );

    await leadRepo.markConverted(actor.tenantId, lead.id, id, trx);

    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'lead',
        parentId: lead.id,
        kind: 'system',
        message: `Converted to order ${id}`,
        actorUserId: actorUserId(actor),
      },
      trx,
    );

    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'order',
        parentId: id,
        kind: 'system',
        message: `Created from lead ${lead.id}`,
        toStageId: defaultStage(orderStages).id,
        actorUserId: actorUserId(actor),
      },
      trx,
    );

    // Last in the transaction, after every row lock above — see the lock-order
    // note in `activity-log.repository.ts`.
    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'order',
      entityId: id,
      action: 'created',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { leadId: lead.id, reservations: reservationPlan.length, poNumber: lead.poNumber ?? null },
    }, actor, trx);

    // The lead's own history says where it went. Both entries close the
    // transaction, one after the other.
    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'lead',
      entityId: lead.id,
      action: 'converted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { orderId: id, number: recordNumber(lead), poNumber: lead.poNumber ?? null },
    }, actor, trx);

    return id;
  });

  const order = await orderRepo.findOrderById(actor.tenantId, orderId, UNSCOPED_PARTY_ACCESS);
  const updatedLead = await leadRepo.findLeadById(actor.tenantId, lead.id, UNSCOPED_PARTY_ACCESS);
  if (!order) throw new Error('Order disappeared immediately after conversion');

  publishChange({ entity: 'order', action: 'created', id: order.id, payload: order, ...actorStamp(actor) });
  if (updatedLead) {
    publishChange({ entity: 'lead', action: 'updated', id: lead.id, payload: updatedLead, ...actorStamp(actor) });
  }
  // Reserving changes what the next order can draw on, so every panel's stock
  // view has to move even though no boxes left the building.
  await inventoryService.publishStockFor(
    actor.tenantId,
    reservationPlan.map((entry) => entry.variantId),
  );

  return order;
}

/** Upper-cased, spaces collapsed; null when blank. Shared with the offline merge. */
export function normaliseVehicleNumber(value: string | null): string | null {
  const vehicle = value?.trim().toUpperCase().replace(/\s+/g, ' ') || null;
  if (vehicle !== null && !/^[A-Z0-9 -]{1,20}$/.test(vehicle)) {
    throw new ValidationError('validation.order.vehicleInvalid');
  }
  return vehicle;
}

export async function updateOrder(
  id: string,
  input: OrderUpdateInput,
  actor: ActorContext,
): Promise<Order> {
  requirePermission(actor, 'orders.edit');

  const existing = await orderRepo.findOrderById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Order');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  if (existing.dispatchedAt) {
    throw new ValidationError('validation.order.dispatchedLocked');
  }

  const definitions = await customFieldRepo.definitionsFor(actor.tenantId, 'order');
  const patch: Record<string, unknown> = {};

  if (input.dispatchAddressLabel !== undefined) {
    patch.dispatch_address_label = input.dispatchAddressLabel;
  }
  if (input.expectedDispatchDate !== undefined) {
    patch.expected_dispatch_date = input.expectedDispatchDate;
  }
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.customFields !== undefined) {
    patch.custom_fields = JSON.stringify(normalizeCustomFields(input.customFields, definitions));
  }

  if (input.totalWeightKgOverride !== undefined) {
    if (input.totalWeightKgOverride !== null && input.totalWeightKgOverride < 0) {
      throw new ValidationError('validation.order.weightNegative');
    }
    // Setting it to null returns the UI to the computed figure. The computed
    // value is never discarded, so an override can always be undone.
    patch.total_weight_kg_override = input.totalWeightKgOverride;
  }

  if (input.vehicleNumber !== undefined) {
    patch.vehicle_number = normaliseVehicleNumber(input.vehicleNumber);
  }

  const fields = Object.keys(patch).map((column) => fieldFor(ORDER_COLUMNS, column));

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    // Clock, then row, as every write takes them. The clocks are read under
    // the lock: a save that landed since the read above must be neither
    // overwritten unseen (the stale-edit check) nor stamped over.
    const locked = await orderRepo.lockOrder(actor.tenantId, id, trx);
    if (!locked) throw new NotFoundError('Order');
    if (locked.dispatchedAt) throw new ValidationError('validation.order.dispatchedLocked');
    assertFieldsFresh(fields, locked.fieldHlc, input.baseFieldHlc);

    // Keyed by wire field, not column. `mergeFields` looks these up by wire
    // field, so stamping `total_weight_kg_override` wrote the clock somewhere
    // nothing reads and left the real key unset — every offline edit to those
    // fields then merged as if the Master had never touched them.
    const fieldHlc = { ...locked.fieldHlc };
    for (const field of fields) fieldHlc[field] = hlc;

    await orderRepo.updateOrderColumns(actor.tenantId, id, patch, { hlc, fieldHlc }, trx);

    // Audited like `updateLead`. This edit used to record nothing, although
    // `activity.order.updated` was already in the catalogue waiting for it.
    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'order',
      entityId: id,
      action: 'updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
    }, actor, trx);
  });

  const order = await orderRepo.findOrderById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'updated', id, payload: order, ...actorStamp(actor) });
  return order;
}

/** `edit` is the offline sync path's clock, as on `lead.service.ts#setStage`. */
export async function setStage(
  input: { id: string; stageId: string; remark?: string | null },
  actor: ActorContext,
  edit?: StageEdit,
): Promise<Order> {
  requirePermission(actor, 'orders.edit');

  const existing = await orderRepo.findOrderById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Order');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  // Before the same-stage and move checks, so a stale move becomes a conflict
  // rather than a refusal.
  if (edit) {
    assertStageFresh({ stageId: existing.stageId, fieldHlc: existing.sync.fieldHlc }, input.stageId, edit);
  }

  if (existing.stageId === input.stageId) return existing;

  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'order');
  let from = findStage(stages, existing.stageId);
  let to = assertStageMove(stages, existing.stageId, input.stageId);

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    let fieldHlc = { ...existing.sync.fieldHlc, stageId: hlc };

    if (edit) {
      // Clock, then row, as every write takes them. Re-read under the lock:
      // another move may have landed since the read above.
      await orderRepo.lockOrder(actor.tenantId, input.id, trx);
      const current = await orderRepo.findOrderById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS, trx);
      if (!current) throw new NotFoundError('Order');
      assertStageFresh({ stageId: current.stageId, fieldHlc: current.sync.fieldHlc }, input.stageId, edit);
      if (current.stageId === input.stageId) return;
      if (current.stageId !== existing.stageId) {
        from = findStage(stages, current.stageId);
        to = assertStageMove(stages, current.stageId, input.stageId);
      }
      fieldHlc = { ...current.sync.fieldHlc, stageId: edit.hlc };
    }

    await orderRepo.updateOrderColumns(
      actor.tenantId,
      input.id,
      { stage_id: to.id },
      { hlc, fieldHlc },
      trx,
    );

    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'order',
        parentId: input.id,
        kind: 'system',
        message: stageChangeMessage(from, to),
        fromStageId: from.id,
        toStageId: to.id,
        actorUserId: actorUserId(actor),
      },
      trx,
    );

    if (input.remark?.trim()) {
      await timelineRepo.appendEntry(
        {
          tenantId: actor.tenantId,
          parentType: 'order',
          parentId: input.id,
          kind: 'remark',
          message: input.remark.trim(),
          actorUserId: actorUserId(actor),
        },
        trx,
      );
    }

    // Audited like the lead's stage move always was; the order's recorded nothing.
    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'order',
      entityId: input.id,
      action: 'stage_changed',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { from: from.name, to: to.name },
    }, actor, trx);
  });

  const order = await orderRepo.findOrderById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS);
  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'updated', id: input.id, payload: order, ...actorStamp(actor) });
  return order;
}

/**
 * Dispatch (§6): the moment stock actually leaves.
 *
 * Reservations become `consumed` and the ledger gets one **signed** movement
 * per (product, colour) — never an absolute value, so replaying the ledger
 * always reconstructs the running total.
 */
export async function dispatchOrder(
  input: OrderDispatchInput,
  actor: ActorContext,
): Promise<Order> {
  requirePermission(actor, 'orders.dispatch');

  const existing = await orderRepo.findOrderById(actor.tenantId, input.orderId, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Order');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  if (existing.dispatchedAt) throw new ValidationError('validation.order.alreadyDispatched');

  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'order');
  // Keyed on the seeded stage *name*, which the Fields screen can rename — the
  // "never key on a stage name" rule in `lead-outcome.ts` is broken here, and a
  // renamed stage leaves a dispatched order where it was. Not fixable in code
  // alone: nothing on `pipeline_stages` says which stage means "dispatched"
  // (`is_terminal` is also true of Cancelled), so it needs a stage flag added
  // by migration and a way to set it — an owner decision.
  const dispatchedStage = stages.find((stage) => stage.name === 'Dispatched');

  const active = await reservationRepo.activeForOrder(actor.tenantId, input.orderId);
  const movements = planDispatchMovements(active);

  await db().transaction(async (trx) => {
    // Stamped before the row lock, as `convertLead` does and for its reason:
    // every write takes `master_clock`'s lock before the entity row's, and a
    // dispatch taking them the other way round would deadlock (`40P01`)
    // against an edit or an offline merge of the same order. A throw below
    // rolls the stamp back with everything else.
    const hlc = await nextHlc(trx);

    // Row-lock next, before anything is read or written: the
    // `existing.dispatchedAt` check above ran outside any transaction, so two
    // dispatch calls that overlap before either commits would otherwise both
    // read it as null and both write stock movements. The lock serialises
    // them — the second caller waits for the first to commit, then sees the
    // order already dispatched here and stops before touching stock.
    const locked = await orderRepo.lockOrder(actor.tenantId, input.orderId, trx);
    if (!locked) throw new NotFoundError('Order');
    if (locked.dispatchedAt) throw new ValidationError('validation.order.alreadyDispatched');

    // The stage it leaves is the locked row's too, not `existing`'s. A stage
    // move that committed after that read would otherwise be written back over
    // — with no "Dispatched" stage the order stays where it is, and that has to
    // mean where it is now — and the timeline would name the wrong stage.
    const from = findStage(stages, locked.stageId);
    const dispatched = dispatchedStage ?? from;

    // The ledger is a second, independent idempotency check: an order that
    // somehow reaches this path twice cannot double-count, because the first
    // pass left a record.
    if (await inventoryRepo.hasMovementForOrder(actor.tenantId, input.orderId, trx)) {
      throw new ValidationError('validation.order.stockAlreadyMoved');
    }

    for (const movement of movements) {
      await inventoryRepo.applyMovement(
        {
          tenantId: actor.tenantId,
          productId: movement.productId,
          variantId: movement.variantId,
          movementType: 'outbound',
          deltaBoxes: movement.quantityBoxes,
          referenceType: 'order',
          referenceId: input.orderId,
          note: input.note ?? `Dispatched order ${input.orderId}`,
          createdByUserId: actorUserId(actor),
        },
        trx,
      );
    }

    await reservationRepo.consumeForOrder(actor.tenantId, input.orderId, trx);

    // Stamped like every other order write — the stage and `dispatchedAt` are
    // what changed. From the locked row's own clocks, not `existing`'s, which
    // were read before the lock and could miss an edit that committed since.
    const fieldHlc: Record<string, string> = { ...locked.fieldHlc, dispatchedAt: hlc };
    if (dispatched.id !== from.id) fieldHlc.stageId = hlc;
    await orderRepo.markDispatched(actor.tenantId, input.orderId, dispatched.id, { hlc, fieldHlc }, trx);

    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'order',
        parentId: input.orderId,
        kind: 'system',
        message: `Dispatched — ${movements.length} stock movement(s) written`,
        fromStageId: from.id,
        toStageId: dispatched.id,
        actorUserId: actorUserId(actor),
      },
      trx,
    );

    await activityLog.recordActivity({
      tenantId: actor.tenantId,
      entityType: 'order',
      entityId: input.orderId,
      action: 'dispatched',
      actorType: actor.actorType,
      actorId: actor.actorId,
      details: { movements: movements.length },
    }, actor, trx);
  });

  const order = await orderRepo.findOrderById(actor.tenantId, input.orderId, UNSCOPED_PARTY_ACCESS);
  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'updated', id: order.id, payload: order, ...actorStamp(actor) });
  // Published after the transaction commits, so panels never see stock figures
  // from a transaction that could still roll back.
  await inventoryService.publishStockFor(
    actor.tenantId,
    movements.map((movement) => movement.variantId),
  );

  return order;
}

export async function countOrders(actor: ActorContext): Promise<number> {
  return orderRepo.countOrders(actor.tenantId, resolvePartyScope(actor));
}

/**
 * Refused once an order has been dispatched — goods left the building and
 * the ledger says so, and the dispatch note may already be in a customer's
 * hands. Otherwise releases the order's active reservations in the same
 * transaction, finally giving `releaseForOrder` a caller, and publishes the
 * affected stock levels after commit.
 */
export async function deleteOrder(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'orders.delete');

  const existing = await orderRepo.findOrderById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Order');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  if (existing.dispatchedAt) {
    throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
      blockedBy: [
        { entityType: 'order', id, label: id, reason: 'dispatched' },
      ] satisfies BinBlocker[],
    });
  }

  let releasedTargets: Array<{ productId: string; variantId: string; quantity: number }> = [];

  const order = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    // Re-checked under the row's lock: the `dispatchedAt` check above ran
    // outside any transaction, so a `dispatchOrder` committing in between
    // would otherwise be followed by a delete of a shipped order.
    const locked = await orderRepo.lockOrder(actor.tenantId, id, trx);
    if (!locked) throw new NotFoundError('Order');
    if (locked.dispatchedAt) {
      throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
        blockedBy: [
          { entityType: 'order', id, label: id, reason: 'dispatched' },
        ] satisfies BinBlocker[],
      });
    }

    releasedTargets = await reservationRepo.activeForOrder(actor.tenantId, id, trx);

    const fieldHlc = { ...locked.fieldHlc, deletedAt: hlc };
    const row = await orderRepo.softDeleteOrder(actor.tenantId, id, actorUserId(actor), { hlc, fieldHlc }, trx);

    await reservationRepo.releaseForOrder(actor.tenantId, id, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'order',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // Read by `activityDetail.order.deleted`, so the log names the order and party.
        details: { number: recordNumber(existing), party: existing.partyName },
      },
      actor,
      trx,
    );

    return row;
  });

  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'deleted', id, payload: order, ...actorStamp(actor) });
  await publishStockFor(
    actor.tenantId,
    releasedTargets.map((target) => target.variantId),
  );

  return { id: order.id, deletedAt: order.updatedAt };
}

export async function restoreOrder(id: string, actor: ActorContext): Promise<BinRestoreResult> {
  requirePermission(actor, 'orders.delete');

  const existing = await orderRepo.findOrderById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS, db(), { includeDeleted: true });
  if (!existing) throw new NotFoundError('Order');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);


  const [party, lead] = await Promise.all([
    recycleBinRepo.findParentStatus(actor.tenantId, 'party', existing.partyId),
    existing.leadId
      ? recycleBinRepo.findParentStatus(actor.tenantId, 'lead', existing.leadId)
      : Promise.resolve(null),
  ]);

  assertParentsLive([
    {
      entityType: 'party',
      id: existing.partyId,
      label: party?.label ?? existing.partyId,
      isLive: party?.isLive ?? false,
    },
    // A lead-less order (should one ever exist) has nothing to check here.
    ...(existing.leadId
      ? [
          {
            entityType: 'lead' as const,
            id: existing.leadId,
            label: lead?.label ?? existing.leadId,
            isLive: lead?.isLive ?? false,
          },
        ]
      : []),
  ]);

  let reactivatedTargets: string[] = [];

  const order = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await orderRepo.restoreOrder(actor.tenantId, id, { hlc, fieldHlc }, trx);

    // The mirror image of `deleteOrder` releasing these reservations. An
    // order can only be soft-deleted while `dispatchedAt` is null, so any
    // `released` rows on it can only have come from that same delete —
    // reactivating them here is what lets a later dispatch have something to
    // consume, instead of silently shipping stock with zero ledger movements.
    if (row) {
      reactivatedTargets = await reservationRepo.reactivateForOrder(actor.tenantId, id, trx);
    }

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'order',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
        // Read by `activityDetail.order.restored`, so the log names the order and party.
        details: { number: recordNumber(existing), party: existing.partyName },
      },
      actor,
      trx,
    );

    return row;
  });

  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'restored', id, payload: order, ...actorStamp(actor) });
  // Reactivating changes what the next order can draw on, same as a fresh
  // reservation does — every panel's stock view has to move.
  await publishStockFor(actor.tenantId, reactivatedTargets);
  return { entityType: 'order', id, alsoRestored: [] };
}
