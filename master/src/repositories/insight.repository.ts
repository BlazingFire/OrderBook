/**
 * Four questions worth asking about a shop's own data, answered in SQL.
 *
 * The division of labour is the point: **SQL computes, the model narrates.**
 * The figures on an insight card are the result of one of these queries and
 * render whether or not a model is configured; the sentence beside them is the
 * only thing the assistant contributes, and its absence costs nothing.
 *
 * Shaped like `report.repository.ts` — positional bindings, tenant first, half-
 * open ranges, party scope spliced into the `WHERE`. Three of the four carry
 * `partyScopeSql`. The fourth does not, and that is stated rather than quietly
 * true: `inventory_stock` has no party column anywhere in this product, so
 * slow-moving stock is gated on `inventory.view` alone.
 */

import type { Knex } from 'knex';

import { db } from '../db/knex.js';
import type { PartyScope } from '../domain/party-scope.js';
import { partyScopeSql } from './party-access.repository.js';
import { toNumber } from './mappers.js';

type Runner = Knex | Knex.Transaction;

export interface SlowMovingRow {
  productId: string;
  name: string;
  onHand: number;
  idleDays: number;
}

/**
 * Stock that has not moved.
 *
 * Aggregated **per product**, not per row: `inventory_stock` is keyed by
 * (product, colour), so grouping by the row would report one product four times
 * and call each of them slow. And the anchor is `MAX(m.created_at)` falling back
 * to `MIN(s.updated_at)` — that table has no `created_at` at all, which an
 * earlier draft of this query assumed and would have failed on at runtime.
 */
export async function slowMovingStock(
  tenantId: string,
  idleDays: number,
  runner: Runner = db(),
): Promise<SlowMovingRow[]> {
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT s.product_id,
            p.name,
            SUM(s.quantity_boxes) AS on_hand,
            (now()::date - COALESCE(MAX(m.created_at)::date, MIN(s.updated_at)::date)) AS idle_days
       FROM inventory_stock s
       JOIN products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
       LEFT JOIN stock_movements m
              ON m.tenant_id = s.tenant_id
             AND m.product_id = s.product_id
             AND m.movement_type = 'outbound'
      WHERE s.tenant_id = ? AND p.deleted_at IS NULL
      GROUP BY s.product_id, p.name
     HAVING SUM(s.quantity_boxes) > 0
        AND (now()::date - COALESCE(MAX(m.created_at)::date, MIN(s.updated_at)::date)) >= ?
      ORDER BY idle_days DESC
      LIMIT 20`,
    [tenantId, idleDays],
  );

  return rows.map((row) => ({
    productId: String(row.product_id),
    name: String(row.name),
    onHand: toNumber(row.on_hand) ?? 0,
    idleDays: toNumber(row.idle_days) ?? 0,
  }));
}

export interface OverdueFollowUpRow {
  leadId: string;
  partyName: string;
  followUpDate: string;
  daysOverdue: number;
}

/** Follow-ups whose day has passed on a lead nobody has converted or closed. */
export async function overdueFollowUps(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<OverdueFollowUpRow[]> {
  const narrowed = partyScopeSql('l.party_id', tenantId, scope);

  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT l.id,
            pa.name AS party_name,
            l.follow_up_date,
            (now()::date - l.follow_up_date) AS days_overdue
       FROM leads l
       JOIN parties pa ON pa.id = l.party_id AND pa.tenant_id = l.tenant_id
       JOIN pipeline_stages st ON st.id = l.stage_id
      WHERE l.tenant_id = ?
        AND l.deleted_at IS NULL
        AND l.converted_order_id IS NULL
        AND st.is_terminal = false
        AND l.follow_up_date IS NOT NULL
        AND l.follow_up_date < now()::date${narrowed.sql}
      ORDER BY l.follow_up_date ASC
      LIMIT 20`,
    [tenantId, ...narrowed.bindings],
  );

  return rows.map((row) => ({
    leadId: String(row.id),
    partyName: String(row.party_name),
    followUpDate: String(row.follow_up_date),
    daysOverdue: toNumber(row.days_overdue) ?? 0,
  }));
}

export interface UnusualOrderRow {
  orderId: string;
  partyId: string;
  partyName: string;
  value: number;
  medianValue: number;
}

/**
 * An order several times the size this party usually places.
 *
 * The comparison is a **median**, not a mean: one exceptional order a year ago
 * would drag a mean up far enough to hide the next one. `percentile_cont` over
 * the trailing twelve months against the last thirty days.
 */
export async function unusualOrders(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<UnusualOrderRow[]> {
  const narrowed = partyScopeSql('o.party_id', tenantId, scope);

  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `WITH history AS (
        SELECT o.party_id,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(o.total_amount, 0)) AS median_value
          FROM orders o
         WHERE o.tenant_id = ?
           AND o.deleted_at IS NULL
           AND o.created_at >= now() - interval '12 months'
         GROUP BY o.party_id
      )
      SELECT o.id, o.party_id, pa.name AS party_name,
             COALESCE(o.total_amount, 0) AS value,
             history.median_value
        FROM orders o
        JOIN parties pa ON pa.id = o.party_id AND pa.tenant_id = o.tenant_id
        JOIN history ON history.party_id = o.party_id
       WHERE o.tenant_id = ?
         AND o.deleted_at IS NULL
         AND o.created_at >= now() - interval '30 days'
         AND history.median_value > 0
         AND COALESCE(o.total_amount, 0) > history.median_value * 3${narrowed.sql}
       ORDER BY value DESC
       LIMIT 10`,
    [tenantId, tenantId, ...narrowed.bindings],
  );

  return rows.map((row) => ({
    orderId: String(row.id),
    partyId: String(row.party_id),
    partyName: String(row.party_name),
    value: toNumber(row.value) ?? 0,
    medianValue: toNumber(row.median_value) ?? 0,
  }));
}

export interface DispatchTrend {
  thisMonth: number;
  priorMean: number;
  changePercent: number;
}

/** This month's dispatches against the trailing three-month mean. */
export async function dispatchTrend(
  tenantId: string,
  scope: PartyScope,
  runner: Runner = db(),
): Promise<DispatchTrend | null> {
  const narrowed = partyScopeSql('o.party_id', tenantId, scope);

  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT
        COUNT(*) FILTER (WHERE o.dispatched_at >= date_trunc('month', now())) AS this_month,
        COUNT(*) FILTER (
          WHERE o.dispatched_at >= date_trunc('month', now()) - interval '3 months'
            AND o.dispatched_at <  date_trunc('month', now())
        ) AS prior_three
       FROM orders o
      WHERE o.tenant_id = ?
        AND o.deleted_at IS NULL
        AND o.dispatched_at IS NOT NULL${narrowed.sql}`,
    [tenantId, ...narrowed.bindings],
  );

  const row = rows[0];
  if (!row) return null;

  const thisMonth = toNumber(row.this_month) ?? 0;
  const priorMean = (toNumber(row.prior_three) ?? 0) / 3;
  if (priorMean === 0) return null;

  return {
    thisMonth,
    priorMean: Math.round(priorMean * 10) / 10,
    changePercent: Math.round(((thisMonth - priorMean) / priorMean) * 100),
  };
}
