/**
 * The Master's dashboard counters (`docs/backend-modules/04-API-CONTRACT.md`
 * §7.1) — every figure gated **inside this service**, absent rather than
 * `0` when the actor does not hold the key governing the data behind it.
 * There is deliberately no `dashboard.view` key: each figure is already
 * governed by the module key that owns its data, so this is a *view over*
 * permissions, not a permission of its own.
 */

import type { DashboardSummary } from '@orderbook/shared';

import { actorCan, actorKey, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { seqCached } from '../lib/seq-cache.js';
import * as catalogService from './catalog.service.js';
import * as conflictService from './conflict.service.js';
import * as dashboardRepo from '../repositories/dashboard.repository.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';

/** Cached for a few seconds, and dropped by any change (`lib/seq-cache.ts`): every panel reconnect builds one. */
export function getDashboardSummary(actor: ActorContext): Promise<DashboardSummary> {
  return seqCached(`dashboard:${actorKey(actor)}`, 5_000, () => computeDashboardSummary(actor));
}

async function computeDashboardSummary(actor: ActorContext): Promise<DashboardSummary> {
  const canLeads = actorCan(actor, 'leads.view');
  const canOrders = actorCan(actor, 'orders.view');
  const canParties = actorCan(actor, 'parties.view');
  const canProducts = actorCan(actor, 'products.view');
  const canSync = actorCan(actor, 'sync.resolveConflicts');

  // Every lead/order/party figure below counts only what this person may see.
  // A count is a disclosure: "you have 40 open orders" tells somebody exactly
  // how much business sits on the parties they cannot open.
  const scope = resolvePartyScope(actor);

  const [leadFigures, orderCount, openOrderCount, dispatchedThisWeekCount, convertedTodayCount, dispatchedTodayCount, partyCount, productCount, pipelineBreakdown, openConflictCount, pendingSyncCount] =
    await Promise.all([
      canLeads ? leadService.getDashboardCounts(actor) : Promise.resolve(null),
      canOrders ? orderService.countOrders(actor) : Promise.resolve(null),
      canOrders ? dashboardRepo.openOrderCount(actor.tenantId, scope) : Promise.resolve(null),
      canOrders ? dashboardRepo.dispatchedSince(actor.tenantId, scope, 'week') : Promise.resolve(null),
      canOrders ? dashboardRepo.convertedToday(actor.tenantId, scope) : Promise.resolve(null),
      canOrders ? dashboardRepo.dispatchedSince(actor.tenantId, scope, 'day') : Promise.resolve(null),
      canParties ? catalogService.countParties(actor) : Promise.resolve(null),
      canProducts ? catalogService.countProducts(actor.tenantId) : Promise.resolve(null),
      canLeads ? dashboardRepo.leadCountsByStage(actor.tenantId, scope) : Promise.resolve(null),
      canSync ? conflictService.countOpen(actor.tenantId, scope) : Promise.resolve(null),
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
  if (convertedTodayCount !== null) summary.convertedTodayCount = convertedTodayCount;
  if (dispatchedTodayCount !== null) summary.dispatchedTodayCount = dispatchedTodayCount;
  if (partyCount !== null) summary.partyCount = partyCount;
  if (productCount !== null) summary.productCount = productCount;
  if (openConflictCount !== null) summary.openConflictCount = openConflictCount;
  if (pendingSyncCount !== null) summary.pendingSyncCount = pendingSyncCount;

  return summary;
}
