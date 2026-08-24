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

import type {
  LeadConvertInput,
  Order,
  OrderDispatchInput,
  OrderListQuery,
  OrderUpdateInput,
  Paginated,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import {
  assertConvertible,
  copyLinesForOrder,
  planDispatchMovements,
  planReservations,
} from '../domain/conversion.js';
import { normalizeCustomFields } from '../domain/custom-fields.js';
import { computeTotalWeightKg } from '../domain/line-items.js';
import { clampPaging } from '../domain/paging.js';
import { assertStageMove, defaultStage, findStage, stageChangeMessage } from '../domain/pipeline.js';
import { canSeeRates, maskOrder } from '../domain/visibility.js';
import { db } from '../db/knex.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as inventoryRepo from '../repositories/inventory.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as lineItemRepo from '../repositories/line-item.repository.js';
import * as orderRepo from '../repositories/order.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as reservationRepo from '../repositories/reservation.repository.js';
import * as timelineRepo from '../repositories/timeline.repository.js';
import { publishChange } from './change-bus.js';
import * as inventoryService from './inventory.service.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

export async function listOrders(
  query: OrderListQuery,
  actor: ActorContext,
): Promise<Paginated<Order>> {
  requirePermission(actor, 'orders.view');

  const page = await orderRepo.listOrders(actor.tenantId, {
    ...query,
    ...clampPaging(query, PAGING),
  });

  const allowed = canSeeRates(actor);
  return { ...page, items: page.items.map((order) => maskOrder(order, allowed)) };
}

export async function getOrder(id: string, actor: ActorContext): Promise<Order> {
  requirePermission(actor, 'orders.view');

  const order = await orderRepo.findOrderById(actor.tenantId, id);
  if (!order) throw new NotFoundError('Order');

  return maskOrder(order, canSeeRates(actor));
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

  const lead = await leadRepo.findLeadById(actor.tenantId, input.leadId);
  if (!lead) throw new NotFoundError('Lead');

  // Read the lines back as domain snapshots rather than reusing the masked
  // entities: a converter without `field.saleRate.view` must still carry the
  // rate across, they just may not see it.
  const leadLines = await lineItemRepo.loadSnapshots(actor.tenantId, 'lead', lead.id);
  assertConvertible({ convertedOrderId: lead.convertedOrderId, items: leadLines });

  const orderStages = await pipelineRepo.stagesFor(actor.tenantId, 'order');
  const orderLines = copyLinesForOrder(leadLines);
  const reservationPlan = planReservations(orderLines);

  const orderId = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

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
        colour: entry.colour,
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

    return id;
  });

  const order = await orderRepo.findOrderById(actor.tenantId, orderId);
  const updatedLead = await leadRepo.findLeadById(actor.tenantId, lead.id);
  if (!order) throw new Error('Order disappeared immediately after conversion');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'order',
    entityId: order.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { leadId: lead.id, reservations: reservationPlan.length },
  }, db());

  publishChange({ entity: 'order', action: 'created', id: order.id, payload: order });
  if (updatedLead) {
    publishChange({ entity: 'lead', action: 'updated', id: lead.id, payload: updatedLead });
  }
  // Reserving changes what the next order can draw on, so every panel's stock
  // view has to move even though no boxes left the building.
  await inventoryService.publishStockFor(
    actor.tenantId,
    reservationPlan.map((entry) => ({ productId: entry.productId, colour: entry.colour })),
  );

  return maskOrder(order, canSeeRates(actor));
}

export async function updateOrder(
  id: string,
  input: OrderUpdateInput,
  actor: ActorContext,
): Promise<Order> {
  requirePermission(actor, 'orders.edit');

  const existing = await orderRepo.findOrderById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Order');
  if (existing.dispatchedAt) {
    throw new ValidationError('This order has been dispatched and can no longer be edited');
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
      throw new ValidationError('Weight cannot be negative');
    }
    // Setting it to null returns the UI to the computed figure. The computed
    // value is never discarded, so an override can always be undone.
    patch.total_weight_kg_override = input.totalWeightKgOverride;
  }

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const column of Object.keys(patch)) fieldHlc[column] = hlc;

    await orderRepo.updateOrderColumns(actor.tenantId, id, patch, { hlc, fieldHlc }, trx);
  });

  const order = await orderRepo.findOrderById(actor.tenantId, id);
  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'updated', id, payload: order });
  return maskOrder(order, canSeeRates(actor));
}

export async function setStage(
  input: { id: string; stageId: string; remark?: string | null },
  actor: ActorContext,
): Promise<Order> {
  requirePermission(actor, 'orders.edit');

  const existing = await orderRepo.findOrderById(actor.tenantId, input.id);
  if (!existing) throw new NotFoundError('Order');
  if (existing.stageId === input.stageId) return maskOrder(existing, canSeeRates(actor));

  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'order');
  const from = findStage(stages, existing.stageId);
  const to = assertStageMove(stages, existing.stageId, input.stageId);

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    await orderRepo.updateOrderColumns(
      actor.tenantId,
      input.id,
      { stage_id: to.id },
      { hlc, fieldHlc: { ...existing.sync.fieldHlc, stageId: hlc } },
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
  });

  const order = await orderRepo.findOrderById(actor.tenantId, input.id);
  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'updated', id: input.id, payload: order });
  return maskOrder(order, canSeeRates(actor));
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

  const existing = await orderRepo.findOrderById(actor.tenantId, input.orderId);
  if (!existing) throw new NotFoundError('Order');
  if (existing.dispatchedAt) throw new ValidationError('This order was already dispatched');

  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'order');
  const from = findStage(stages, existing.stageId);
  const dispatched = stages.find((stage) => stage.name === 'Dispatched') ?? from;

  const active = await reservationRepo.activeForOrder(actor.tenantId, input.orderId);
  const movements = planDispatchMovements(active);

  await db().transaction(async (trx) => {
    // The ledger is the idempotency check: an order that somehow reaches this
    // path twice cannot double-count, because the first pass left a record.
    if (await inventoryRepo.hasMovementForOrder(actor.tenantId, input.orderId, trx)) {
      throw new ValidationError('Stock has already moved for this order');
    }

    for (const movement of movements) {
      await inventoryRepo.applyMovement(
        {
          tenantId: actor.tenantId,
          productId: movement.productId,
          colour: movement.colour,
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
    await orderRepo.markDispatched(actor.tenantId, input.orderId, dispatched.id, trx);

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
  });

  const order = await orderRepo.findOrderById(actor.tenantId, input.orderId);
  if (!order) throw new NotFoundError('Order');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'order',
    entityId: order.id,
    action: 'dispatched',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { movements: movements.length },
  }, db());

  publishChange({ entity: 'order', action: 'updated', id: order.id, payload: order });
  // Published after the transaction commits, so panels never see stock figures
  // from a transaction that could still roll back.
  await inventoryService.publishStockFor(
    actor.tenantId,
    movements.map((movement) => ({ productId: movement.productId, colour: movement.colour })),
  );

  return maskOrder(order, canSeeRates(actor));
}

export async function addRemark(
  input: { id: string; message: string },
  actor: ActorContext,
): Promise<Order> {
  requirePermission(actor, 'orders.edit');

  const message = input.message?.trim();
  if (!message) throw new ValidationError('A remark needs some text');

  await db().transaction(async (trx) => {
    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'order',
        parentId: input.id,
        kind: 'remark',
        message,
        actorUserId: actorUserId(actor),
      },
      trx,
    );
  });

  const order = await orderRepo.findOrderById(actor.tenantId, input.id);
  if (!order) throw new NotFoundError('Order');

  publishChange({ entity: 'order', action: 'updated', id: input.id, payload: order });
  return maskOrder(order, canSeeRates(actor));
}

/** Recomputed weight, for callers that need it without a round trip. */
export async function recomputeWeight(tenantId: string, orderId: string): Promise<number> {
  const lines = await lineItemRepo.loadSnapshots(tenantId, 'order', orderId);
  return computeTotalWeightKg(lines);
}

export async function countOrders(tenantId: string): Promise<number> {
  return orderRepo.countOrders(tenantId);
}
