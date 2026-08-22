/**
 * Leads and orders. A lead becomes an order by changing status — the record
 * itself never moves or gets copied (docs/schema/03-leads-orders-inventory.md).
 */

import type { DashboardSummary, Lead, LeadInput, LeadStatus, Paginated } from '@orderbook/shared';

import { actorUserId, type ActorContext } from '../domain/actor.js';
import { canTransitionLead, stockEffectOfTransition } from '../domain/lead-workflow.js';
import { clampPaging } from '../domain/paging.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { publishChange } from './change-bus.js';
import * as inventoryService from './inventory.service.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

export async function listLeads(query: {
  statuses?: LeadStatus[];
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Paginated<Lead>> {
  return leadRepo.listLeads({
    statuses: query.statuses,
    search: query.search,
    ...clampPaging(query, PAGING),
  });
}

export async function getLead(id: string): Promise<Lead> {
  const lead = await leadRepo.findLeadById(id);
  if (!lead) throw new NotFoundError('Lead');
  return lead;
}

export async function createLead(
  input: LeadInput,
  context: { sourcePanelId: string | null; actor: ActorContext },
): Promise<Lead> {
  if (!input.partyId) throw new ValidationError('Select a party for this lead');
  if (!input.items?.length) throw new ValidationError('Add at least one product to this lead');

  if (!(await partyRepo.findPartyById(input.partyId))) {
    throw new ValidationError('The selected party no longer exists');
  }

  // Resolve prices server-side when the panel did not send one, so a lead
  // always records what the product actually cost at the time it was created.
  const items = await Promise.all(
    input.items.map(async (item) => {
      const product = await productRepo.findProductById(item.productId);
      if (!product) throw new ValidationError('One of the selected products no longer exists');

      const quantityBoxes = item.quantityBoxes ?? null;
      if (quantityBoxes !== null && quantityBoxes <= 0) {
        throw new ValidationError(`Quantity for ${product.name} must be greater than zero`);
      }

      return { ...item, unitPrice: item.unitPrice ?? product.pricePerBox ?? null };
    }),
  );

  const lead = await leadRepo.insertLead(
    { ...input, items },
    { sourcePanelId: context.sourcePanelId, createdByUserId: actorUserId(context.actor) },
  );

  await activityLog.recordActivity({
    entityType: 'lead',
    entityId: lead.id,
    action: 'created',
    actorType: context.actor.actorType,
    actorId: context.actor.actorId,
    details: { leadNumber: lead.leadNumber, itemCount: lead.items.length },
  });
  publishChange({ entity: 'lead', action: 'created', id: lead.id, payload: lead });

  return lead;
}

export async function changeLeadStatus(
  id: string,
  status: LeadStatus,
  actor: ActorContext,
): Promise<Lead> {
  const existing = await leadRepo.findLeadById(id);
  if (!existing) throw new NotFoundError('Lead');

  if (existing.status === status) return existing;

  if (!canTransitionLead(existing.status, status)) {
    throw new ValidationError(`Cannot move a lead from "${existing.status}" to "${status}"`);
  }

  const stockEffect = stockEffectOfTransition(existing.status, status);

  // Stock moves in the same transaction as the status change: an order that
  // saved but did not reduce stock (or the reverse) would leave the two
  // permanently out of step.
  const lead = await leadRepo.updateLeadStatus(id, status, async (updated, trx) => {
    if (stockEffect === 'deduct') {
      await inventoryService.applyOrderDeduction(updated, actor, trx);
    } else if (stockEffect === 'restore') {
      await inventoryService.reverseOrderDeduction(updated, actor, trx);
    }
  });

  if (!lead) throw new NotFoundError('Lead');

  await activityLog.recordActivity({
    entityType: 'lead',
    entityId: lead.id,
    action: 'status_changed',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { from: existing.status, to: status },
  });
  publishChange({ entity: 'lead', action: 'updated', id: lead.id, payload: lead });

  // Published after the transaction commits so panels never see stock figures
  // from a transaction that could still roll back.
  if (stockEffect) {
    await inventoryService.publishStockFor(lead.items.map((item) => item.productId));
  }

  return lead;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [leadCount, orderCount, partyCount, productCount, lowStockCount] = await Promise.all([
    leadRepo.countLeadsByStatus(['new', 'verified']),
    leadRepo.countLeadsByStatus(['order']),
    partyRepo.countParties(),
    productRepo.countProducts(),
    inventoryService.countLowStock(),
  ]);

  return { leadCount, orderCount, partyCount, productCount, lowStockCount };
}
