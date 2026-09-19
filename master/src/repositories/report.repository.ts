/**
 * All report SQL (`docs/backend-modules/04-API-CONTRACT.md` §3). Follows
 * `search.repository.ts`'s shape — `runner.raw<{rows:T[]}>` with positional
 * bindings, `tenant_id = ?` first.
 *
 * Every calendar boundary is computed **in SQL** against the configured
 * business timezone (`config.locale.timeZone`) and returned as `'YYYY-MM'`
 * TEXT — no date-derived value ever becomes a JS `Date`. `AT TIME ZONE`
 * applied to a `timestamptz` converts it **into** wall-clock for bucketing;
 * applied to the `::timestamp` cast of a plain date string it converts
 * wall-clock **into** a `timestamptz` for a boundary. Same spelling,
 * opposite meanings, decided by the operand's type — every range predicate
 * below is the latter form, and every one is half-open `[from, to)`, never
 * `BETWEEN`.
 */

import type { Knex } from 'knex';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { QUIET_AFTER_DAYS } from '../domain/lead-outcome.js';
import type { PartyScope } from '../domain/party-scope.js';
import { partyScopeSql } from './party-access.repository.js';
import { toNumber } from './mappers.js';

type Runner = Knex | Knex.Transaction;

export interface DateRange {
  tenantId: string;
  fromDate: string;
  toDateExclusive: string;
  /**
   * Carried on the range rather than passed separately so no report can be
   * added later that forgets it — a report is a read like any other, and an
   * unscoped total tells somebody exactly how much business sits on the
   * parties they cannot open.
   */
  scope: PartyScope;
}

export interface DispatchMonthRow {
  month: string;
  orderCount: number;
  boxCount: number;
  totalValue: number | null;
}

export interface DispatchColourRow {
  colour: string;
  boxCount: number;
}

/** Order-level month buckets. Box counts joined separately so a multi-line order is not double-counted. */
export async function dispatchesByMonth(range: DateRange, runner: Runner = db()): Promise<DispatchMonthRow[]> {
  const tz = config.locale.timeZone;
  const orderAggScope = partyScopeSql('orders.party_id', range.tenantId, range.scope);
  const boxAggScope = partyScopeSql('o.party_id', range.tenantId, range.scope);
  const { rows } = await runner.raw<{
    rows: Array<{ month: string; order_count: string; box_count: string; total_value: string | null }>;
  }>(
    `WITH order_agg AS (
       SELECT to_char(date_trunc('month', dispatched_at AT TIME ZONE ?), 'YYYY-MM') AS month,
              count(*) AS order_count,
              SUM(total_amount) AS total_value
         FROM orders
        WHERE tenant_id = ?
          AND dispatched_at >= (?::timestamp AT TIME ZONE ?)
          AND dispatched_at <  (?::timestamp AT TIME ZONE ?)
          AND deleted_at IS NULL${orderAggScope.sql}
        GROUP BY 1
     ),
     box_agg AS (
       SELECT to_char(date_trunc('month', o.dispatched_at AT TIME ZONE ?), 'YYYY-MM') AS month,
              SUM(-m.quantity_boxes) AS box_count
         FROM orders o
         JOIN stock_movements m
           ON m.tenant_id = o.tenant_id AND m.reference_type = 'order' AND m.reference_id = o.id
          AND m.movement_type = 'outbound'
        WHERE o.tenant_id = ?
          AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
          AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
          AND o.deleted_at IS NULL${boxAggScope.sql}
        GROUP BY 1
     )
     SELECT oa.month, oa.order_count, COALESCE(ba.box_count, 0) AS box_count, oa.total_value
       FROM order_agg oa
       LEFT JOIN box_agg ba ON ba.month = oa.month
      ORDER BY oa.month`,
    [
      tz, range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...orderAggScope.bindings,
      tz, range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...boxAggScope.bindings,
    ],
  );

  return rows.map((row) => ({
    month: row.month,
    orderCount: toNumber(row.order_count) ?? 0,
    boxCount: toNumber(row.box_count) ?? 0,
    totalValue: toNumber(row.total_value),
  }));
}

/**
 * Aggregated across the whole range, not per month, by the variant's colour
 * or pattern text (`''` for a no-variant product — the UI's "—" bucket).
 * Carries no `totalValue`: `total_amount` is an order-level figure, and
 * attributing it to one variant on a multi-variant order has no single
 * correct answer — an absent field beats a fabricated one.
 */
export async function dispatchesByColour(range: DateRange, runner: Runner = db()): Promise<DispatchColourRow[]> {
  const tz = config.locale.timeZone;
  const scope = partyScopeSql('o.party_id', range.tenantId, range.scope);
  const { rows } = await runner.raw<{ rows: Array<{ colour: string; box_count: string }> }>(
    `SELECT COALESCE(v.label, '') AS colour, SUM(-m.quantity_boxes) AS box_count
       FROM orders o
       JOIN stock_movements m
         ON m.tenant_id = o.tenant_id AND m.reference_type = 'order' AND m.reference_id = o.id
        AND m.movement_type = 'outbound'
       JOIN product_variants v ON v.id = m.variant_id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY COALESCE(v.label, '')
      ORDER BY box_count DESC`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings],
  );

  return rows.map((row) => ({ colour: row.colour, boxCount: toNumber(row.box_count) ?? 0 }));
}

export interface LeadOutcomeRow {
  month: string;
  outcome: 'converted' | 'lost' | 'quiet' | 'open';
  count: number;
}

/**
 * The SQL half of the classifier in `domain/lead-outcome.ts` — the two must
 * agree, which is why both are pinned by `RPT-9`. `converted_order_id` wins
 * outright; a terminal, unconverted lead is `lost` regardless of which
 * terminal stage it is in; otherwise a date-difference against
 * `QUIET_AFTER_DAYS` (computed as a plain date subtraction, never through a
 * JS `Date`) decides `quiet` vs `open`.
 */
export async function leadOutcomesByMonth(range: DateRange, runner: Runner = db()): Promise<LeadOutcomeRow[]> {
  const tz = config.locale.timeZone;
  const scope = partyScopeSql('l.party_id', range.tenantId, range.scope);
  const { rows } = await runner.raw<{ rows: Array<{ month: string; outcome: LeadOutcomeRow['outcome']; count: string }> }>(
    `SELECT to_char(date_trunc('month', l.created_at AT TIME ZONE ?), 'YYYY-MM') AS month,
            CASE
              WHEN l.converted_order_id IS NOT NULL THEN 'converted'
              WHEN s.is_terminal THEN 'lost'
              WHEN ((now() AT TIME ZONE ?)::date - (l.updated_at AT TIME ZONE ?)::date) >= ? THEN 'quiet'
              ELSE 'open'
            END AS outcome,
            count(*) AS count
       FROM leads l
       JOIN pipeline_stages s ON s.id = l.stage_id
      WHERE l.tenant_id = ?
        AND l.created_at >= (?::timestamp AT TIME ZONE ?)
        AND l.created_at <  (?::timestamp AT TIME ZONE ?)
        AND l.deleted_at IS NULL${scope.sql}
      GROUP BY 1, 2`,
    [tz, tz, tz, QUIET_AFTER_DAYS, range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings],
  );

  return rows.map((row) => ({ month: row.month, outcome: row.outcome, count: toNumber(row.count) ?? 0 }));
}

export interface TopPartyRowInternal {
  partyId: string;
  partyName: string;
  partyCode: string | null;
  city: string | null;
  orderCount: number;
  totalValue: number;
}

/**
 * Anchored on `orders.dispatched_at`, not `created_at` — "dispatched value
 * in the selected period", goods that left, matching `dispatchesByMonth`'s
 * anchor so the two reports never disagree about what a period means.
 * Served by `idx_orders_dispatched`, not `idx_orders_party` (whose second
 * column is the grouping key, not the filtered one).
 */
export async function topPartiesByValue(
  range: DateRange,
  limit: number,
  runner: Runner = db(),
): Promise<TopPartyRowInternal[]> {
  const tz = config.locale.timeZone;
  const scope = partyScopeSql('o.party_id', range.tenantId, range.scope);
  const { rows } = await runner.raw<{
    rows: Array<{
      party_id: string;
      party_name: string;
      party_code: string | null;
      city: string | null;
      order_count: string;
      total_value: string;
    }>;
  }>(
    `SELECT p.id AS party_id, p.name AS party_name, p.party_code, p.city,
            count(o.id) AS order_count, SUM(o.total_amount) AS total_value
       FROM orders o
       JOIN parties p ON p.id = o.party_id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY p.id, p.name, p.party_code, p.city
      ORDER BY total_value DESC
      LIMIT ?`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    partyId: row.party_id,
    partyName: row.party_name,
    partyCode: row.party_code,
    city: row.city,
    orderCount: toNumber(row.order_count) ?? 0,
    totalValue: toNumber(row.total_value) ?? 0,
  }));
}

/** Same ordering rule, by `orderCount` — used when the caller may not see rates. */
export async function topPartiesByOrderCount(
  range: DateRange,
  limit: number,
  runner: Runner = db(),
): Promise<TopPartyRowInternal[]> {
  const tz = config.locale.timeZone;
  const scope = partyScopeSql('o.party_id', range.tenantId, range.scope);
  const { rows } = await runner.raw<{
    rows: Array<{
      party_id: string;
      party_name: string;
      party_code: string | null;
      city: string | null;
      order_count: string;
      total_value: string;
    }>;
  }>(
    `SELECT p.id AS party_id, p.name AS party_name, p.party_code, p.city,
            count(o.id) AS order_count, SUM(o.total_amount) AS total_value
       FROM orders o
       JOIN parties p ON p.id = o.party_id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY p.id, p.name, p.party_code, p.city
      ORDER BY order_count DESC
      LIMIT ?`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    partyId: row.party_id,
    partyName: row.party_name,
    partyCode: row.party_code,
    city: row.city,
    orderCount: toNumber(row.order_count) ?? 0,
    totalValue: toNumber(row.total_value) ?? 0,
  }));
}

export interface TopCityRowInternal {
  city: string | null;
  partyCount: number;
  orderCount: number;
  totalValue: number;
}

/** `NULL` and blank collapse into one bucket (`city: null`) — the server never invents "Unknown". */
export async function topPartiesByCity(range: DateRange, runner: Runner = db()): Promise<TopCityRowInternal[]> {
  const tz = config.locale.timeZone;
  const scope = partyScopeSql('o.party_id', range.tenantId, range.scope);
  const { rows } = await runner.raw<{
    rows: Array<{ city: string | null; party_count: string; order_count: string; total_value: string }>;
  }>(
    `SELECT NULLIF(btrim(MIN(btrim(p.city))), '') AS city,
            count(DISTINCT p.id) AS party_count,
            count(o.id) AS order_count,
            SUM(o.total_amount) AS total_value
       FROM orders o
       JOIN parties p ON p.id = o.party_id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY lower(btrim(COALESCE(p.city, '')))
      ORDER BY total_value DESC`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings],
  );

  return rows.map((row) => ({
    city: row.city,
    partyCount: toNumber(row.party_count) ?? 0,
    orderCount: toNumber(row.order_count) ?? 0,
    totalValue: toNumber(row.total_value) ?? 0,
  }));
}
