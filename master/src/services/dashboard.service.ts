/**
 * The Master's dashboard counters.
 *
 * Split out of the lead service now that the summary spans leads, orders,
 * inventory and sync health — a "dashboard" that lived inside one entity's
 * service would have to reach across all the others anyway.
 */

import type { DashboardSummary } from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import { db } from '../db/knex.js';
import * as catalogService from './catalog.service.js';
import * as conflictService from './conflict.service.js';
import * as inventoryService from './inventory.service.js';
import * as leadService from './lead.service.js';
import * as orderService from './order.service.js';

export async function getDashboardSummary(actor: ActorContext): Promise<DashboardSummary> {
  const [leads, orderCount, partyCount, productCount, lowStockCount, openConflictCount, pendingSyncCount] =
    await Promise.all([
      leadService.getDashboardCounts(actor.tenantId),
      orderService.countOrders(actor.tenantId),
      catalogService.countParties(actor.tenantId),
      catalogService.countProducts(actor.tenantId),
      inventoryService.countLowStock(actor.tenantId),
      conflictService.countOpen(actor.tenantId),
      countRecentMutations(actor.tenantId),
    ]);

  return {
    leadCount: leads.leadCount,
    orderCount,
    partyCount,
    productCount,
    lowStockCount,
    followUpsDueCount: leads.followUpsDueCount,
    openConflictCount,
    pendingSyncCount,
  };
}

/**
 * Mutations that arrived from panels in the last hour.
 *
 * A proxy for sync health rather than a true "pending" count — the Master
 * cannot see what is still sitting in a disconnected panel's outbox, and
 * pretending otherwise would be worse than measuring what it can.
 */
async function countRecentMutations(tenantId: string): Promise<number> {
  const rows = await db()('applied_mutations')
    .where({ tenant_id: tenantId })
    .andWhere('applied_at', '>=', db().raw("now() - interval '1 hour'"))
    .count<Array<{ count: string }>>('mutation_id as count');

  return Number(rows[0]?.count ?? 0);
}
