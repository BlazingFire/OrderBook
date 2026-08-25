/**
 * The Master's dashboard counters (`docs/backend-modules/04-API-CONTRACT.md`
 * §7.1) — every figure gated **inside this service**, absent rather than
 * `0` when the actor does not hold the key governing the data behind it.
 * There is deliberately no `dashboard.view` key: each figure is already
 * governed by the module key that owns its data, so this is a *view over*
 * permissions, not a permission of its own.
 */

import type { DashboardSummary } from '@orderbook/shared';

import { actorCan, type ActorContext } from '../domain/actor.js';
import * as catalogService from './catalog.service.js';
import * as conflictService from './conflict.service.js';
import * as dashboardRepo from '../repositories/dashboard.repository.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';

export async function getDashboardSummary(actor: ActorContext): Promise<DashboardSummary> {
  const canLeads = actorCan(actor, 'leads.view');
  const canOrders = actorCan(actor, 'orders.view');
  const canParties = actorCan(actor, 'parties.view');
  const canProducts = actorCan(actor, 'products.view');
  const canInventory = actorCan(actor, 'inventory.view');
  const canSync = actorCan(actor, 'sync.resolveConflicts');

  const [leadFigures, orderCount, openOrderCount, dispatchedThisWeekCount, partyCount, productCount, lowStockCount, pipelineBreakdown, openConflictCount, pendingSyncCount] =
    await Promise.all([
      canLeads ? leadService.getDashboardCounts(actor.tenantId) : Promise.resolve(null),
      canOrders ? orderService.countOrders(actor.tenantId) : Promise.resolve(null),
      canOrders ? dashboardRepo.openOrderCount(actor.tenantId) : Promise.resolve(null),
      canOrders ? dashboardRepo.dispatchedThisWeek(actor.tenantId) : Promise.resolve(null),
      canParties ? catalogService.countParties(actor.tenantId) : Promise.resolve(null),
      canProducts ? catalogService.countProducts(actor.tenantId) : Promise.resolve(null),
      canInventory ? inventoryService.countLowStock(actor.tenantId) : Promise.resolve(null),
      canLeads ? dashboardRepo.leadCountsByStage(actor.tenantId) : Promise.resolve(null),
      canSync ? conflictService.countOpen(actor.tenantId) : Promise.resolve(null),
      canSync ? dashboardRepo.countRecentMutations(actor.tenantId) : Promise.resolve(null),
    ]);

  const summary: DashboardSummary = { asOf: new Date().toISOString() };

  if (leadFigures) {
    summary.leadCount = leadFigures.leadCount;
    summary.followUpsDueCount = leadFigures.followUpsDueCount;
  }
  if (pipelineBreakdown) {
    summary.pipelineBreakdown = pipelineBreakdown.map((stage) => ({
      stageId: stage.stageId,
      stageName: stage.stageName,
      sequence: stage.sequence,
      colourHex: stage.colourHex,
      leadCount: stage.leadCount,
    }));
  }
  if (orderCount !== null) summary.orderCount = orderCount;
  if (openOrderCount !== null) summary.openOrderCount = openOrderCount;
  if (dispatchedThisWeekCount !== null) summary.dispatchedThisWeekCount = dispatchedThisWeekCount;
  if (partyCount !== null) summary.partyCount = partyCount;
  if (productCount !== null) summary.productCount = productCount;
  if (lowStockCount !== null) summary.lowStockCount = lowStockCount;
  if (openConflictCount !== null) summary.openConflictCount = openConflictCount;
  if (pendingSyncCount !== null) summary.pendingSyncCount = pendingSyncCount;

  return summary;
}
