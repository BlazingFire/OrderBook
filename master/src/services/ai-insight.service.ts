/**
 * The observations the dashboard shows, and the one sentence beside each.
 *
 * **The figures always render.** They come from SQL and are computed whether or
 * not a model is configured; with the assistant off, the sentence comes from
 * the catalogue instead. That order matters — a feature whose numbers depend on
 * a language model being reachable is a feature that stops working when the
 * shop's internet does.
 *
 * Each insight is gated by the module key that owns its data, exactly as the
 * dashboard's own figures are: absent for somebody who may not see that module,
 * never zero. A zero is a claim about the business; an absence is a claim about
 * the reader.
 *
 * Money is dropped rather than masked. An "unusually large order" whose value
 * is missing is not a smaller insight, it is an unreadable one — so for a
 * caller without `field.saleRate.view` that insight is omitted entirely.
 */

import type { Insight } from '@orderbook/shared';

import { actorCan, requirePermission, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import * as insightRepo from '../repositories/insight.repository.js';

/** How long stock has to sit still before it is worth mentioning. */
const IDLE_DAYS = 60;

/** Recomputed at most this often per tenant — these are four aggregate queries. */
const CACHE_MS = 6 * 60 * 60 * 1000;

const cache = new Map<string, { at: number; insights: Insight[] }>();

export function invalidateInsightCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function listInsights(actor: ActorContext): Promise<Insight[]> {
  requirePermission(actor, 'ai.use');

  // Keyed by who is asking, not just by tenant: two people see different
  // parties, so they have different insights, and a shared cache would hand one
  // person the other's.
  const key = `${actor.tenantId}:${actor.userId ?? 'none'}:${actorCan(actor, 'field.saleRate.view')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.insights;

  const scope = resolvePartyScope(actor);
  const insights: Insight[] = [];

  if (actorCan(actor, 'inventory.view')) {
    for (const row of await insightRepo.slowMovingStock(actor.tenantId, IDLE_DAYS)) {
      insights.push({
        code: 'stock.slowMoving',
        severity: 'warn',
        subjectKind: 'product',
        subjectId: row.productId,
        figures: { name: row.name, boxes: row.onHand, days: row.idleDays },
      });
    }
  }

  if (actorCan(actor, 'leads.view')) {
    for (const row of await insightRepo.overdueFollowUps(actor.tenantId, scope)) {
      insights.push({
        code: 'lead.overdueFollowUp',
        severity: 'warn',
        subjectKind: 'lead',
        subjectId: row.leadId,
        figures: { party: row.partyName, days: row.daysOverdue },
      });
    }
  }

  // An order insight without its value is unreadable rather than merely
  // narrower, so it is omitted for a rate-blind caller instead of being shown
  // with a hole in it.
  if (actorCan(actor, 'orders.view') && actorCan(actor, 'field.saleRate.view')) {
    for (const row of await insightRepo.unusualOrders(actor.tenantId, scope)) {
      insights.push({
        code: 'order.unusualSize',
        severity: 'info',
        subjectKind: 'party',
        subjectId: row.partyId,
        figures: {
          party: row.partyName,
          value: row.value,
          median: row.medianValue,
        },
      });
    }
  }

  if (actorCan(actor, 'orders.view')) {
    const trend = await insightRepo.dispatchTrend(actor.tenantId, scope);
    // ±20%: below that a month-to-month wobble is noise, and an alert about
    // noise is one people learn to ignore.
    if (trend && Math.abs(trend.changePercent) >= 20) {
      insights.push({
        code: 'dispatch.trend',
        severity: trend.changePercent < 0 ? 'warn' : 'info',
        subjectKind: null,
        subjectId: null,
        figures: {
          thisMonth: trend.thisMonth,
          average: trend.priorMean,
          change: trend.changePercent,
        },
      });
    }
  }

  cache.set(key, { at: Date.now(), insights });
  return insights;
}
