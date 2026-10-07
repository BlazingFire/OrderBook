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
 *
 * **Two scopes, both on the range.** `scope` is Party Access (which parties the
 * caller may open); `ownerId` is whose records — the signed-in user's own for
 * the Office and Management tiers, a chosen user or `null` (everyone) for an
 * administrator. Carried on `DateRange` and not as a separate argument so no
 * report can be added that forgets either: an unscoped total tells somebody
 * how much business sits on the parties, or the colleagues, they cannot see.
 *
 * **Units.** *Pieces* are `line_items.quantity` of an order's lines. *Kilograms*
 * are the order's own weight (`COALESCE(override, computed)`) wherever the
 * grain is an order, and `quantity × weight_kg` over the lines that have a
 * weight wherever the grain is a product — an unentered weight is left out, not
 * counted as zero. *Boxes* are the quantities on a dispatched order's lines, and only
 * the legacy Dispatches report reports them. There is no money anywhere.
 */

import type { Knex } from 'knex';

import { config } from '../config/index.js';
import { db } from '../db/knex.js';
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
  /**
   * Whose records. A user id restricts every query to that owner
   * (`leads.owner_id` / `orders.owner_id`); `null` is everyone's. Required, so
   * a new report cannot leave it out.
   */
  ownerId: string | null;
}

/** ` AND <column> = ?` for an owner, nothing for everyone. */
function ownerSql(column: string, ownerId: string | null): { sql: string; bindings: string[] } {
  return ownerId === null ? { sql: '', bindings: [] } : { sql: ` AND ${column} = ?`, bindings: [ownerId] };
}

/** `col` inside `[from, to)` in the business time zone — four bindings, see `rangeBindings`. */
function inRange(column: string): string {
  return `${column} >= (?::timestamp AT TIME ZONE ?) AND ${column} < (?::timestamp AT TIME ZONE ?)`;
}

function rangeBindings(range: DateRange, tz: string): string[] {
  return [range.fromDate, tz, range.toDateExclusive, tz];
}

/** Both scopes on one alias, as a SQL tail and its bindings. */
function scoped(range: DateRange, alias: string): { sql: string; bindings: Array<string | number> } {
  const party = partyScopeSql(`${alias}.party_id`, range.tenantId, range.scope);
  const owner = ownerSql(`${alias}.owner_id`, range.ownerId);
  return { sql: `${party.sql}${owner.sql}`, bindings: [...party.bindings, ...owner.bindings] };
}

export interface DispatchMonthRow {
  month: string;
  orderCount: number;
  pieces: number;
}

export interface DispatchColourRow {
  colour: string;
  pieces: number;
}

/** Order-level month buckets. Box counts joined separately so a multi-line order is not double-counted. */
export async function dispatchesByMonth(range: DateRange, runner: Runner = db()): Promise<DispatchMonthRow[]> {
  const tz = config.locale.timeZone;
  const orderAggScope = partyScopeSql('orders.party_id', range.tenantId, range.scope);
  const orderAggOwner = ownerSql('orders.owner_id', range.ownerId);
  const boxAggScope = partyScopeSql('o.party_id', range.tenantId, range.scope);
  const boxAggOwner = ownerSql('o.owner_id', range.ownerId);
  const { rows } = await runner.raw<{
    rows: Array<{ month: string; order_count: string; piece_count: string }>;
  }>(
    `WITH order_agg AS (
       SELECT to_char(date_trunc('month', dispatched_at AT TIME ZONE ?), 'YYYY-MM') AS month,
              count(*) AS order_count
         FROM orders
        WHERE tenant_id = ?
          AND dispatched_at >= (?::timestamp AT TIME ZONE ?)
          AND dispatched_at <  (?::timestamp AT TIME ZONE ?)
          AND deleted_at IS NULL${orderAggScope.sql}${orderAggOwner.sql}
        GROUP BY 1
     ),
     box_agg AS (
       SELECT to_char(date_trunc('month', o.dispatched_at AT TIME ZONE ?), 'YYYY-MM') AS month,
              SUM(li.quantity) AS piece_count
         FROM orders o
         JOIN line_items li
           ON li.tenant_id = o.tenant_id AND li.parent_type = 'order' AND li.parent_id = o.id
        WHERE o.tenant_id = ?
          AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
          AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
          AND o.deleted_at IS NULL${boxAggScope.sql}${boxAggOwner.sql}
        GROUP BY 1
     )
     SELECT oa.month, oa.order_count, COALESCE(ba.piece_count, 0) AS piece_count
       FROM order_agg oa
       LEFT JOIN box_agg ba ON ba.month = oa.month
      ORDER BY oa.month`,
    [
      tz, range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...orderAggScope.bindings, ...orderAggOwner.bindings,
      tz, range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...boxAggScope.bindings, ...boxAggOwner.bindings,
    ],
  );

  return rows.map((row) => ({
    month: row.month,
    orderCount: toNumber(row.order_count) ?? 0,
    pieces: toNumber(row.piece_count) ?? 0,
  }));
}

/**
 * Aggregated across the whole range, not per month, by the colour the LINE
 * was sold in: the colour chosen on it (a multicolour product), else the
 * colour text frozen on it from its variant, else `''` (the UI's "—" bucket).
 *
 * The line's own snapshot, never the live `product_variants.label`: grouping
 * by the live label counted every multicolour line as blank (their variant has
 * no label) and a line sold as Ivory as White after the product was corrected
 * to a fixed White (W2-2, 2026-10-07).
 */
export async function dispatchesByColour(range: DateRange, runner: Runner = db()): Promise<DispatchColourRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<{ colour: string; piece_count: string }> }>(
    `SELECT COALESCE(NULLIF(li.colour, ''), NULLIF(li.variant_label, ''), '') AS colour,
            SUM(li.quantity) AS piece_count
       FROM orders o
       JOIN line_items li
         ON li.tenant_id = o.tenant_id AND li.parent_type = 'order' AND li.parent_id = o.id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY 1
      ORDER BY piece_count DESC`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings],
  );

  return rows.map((row) => ({ colour: row.colour, pieces: toNumber(row.piece_count) ?? 0 }));
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
 * the company's `leads.quietAfterDays` (computed as a plain date subtraction,
 * never through a JS `Date`) decides `quiet` vs `open`. The caller reads the
 * setting and passes it, so both halves are given the same number rather than
 * each reading its own.
 */
export async function leadOutcomesByMonth(
  range: DateRange,
  /**
   * A second parameter, deliberately not a field on `DateRange`. That type is
   * shared by every repository function here and exists so no report can forget
   * a field; an optional one reintroduces exactly that failure, and a required
   * one breaks unrelated construction sites.
   */
  quietAfterDays: number,
  runner: Runner = db(),
): Promise<LeadOutcomeRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'l');
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
    [tz, tz, tz, quietAfterDays, range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings],
  );

  return rows.map((row) => ({ month: row.month, outcome: row.outcome, count: toNumber(row.count) ?? 0 }));
}

export interface TopPartyRowInternal {
  partyId: string;
  partyName: string;
  partyCode: string | null;
  city: string | null;
  orderCount: number;
}

/**
 * Anchored on `orders.dispatched_at`, not `created_at` — "dispatched in the
 * selected period", goods that left, matching `dispatchesByMonth`'s anchor so
 * the two reports never disagree about what a period means. Served by
 * `idx_orders_dispatched`, not `idx_orders_party` (whose second column is the
 * grouping key, not the filtered one).
 */
export async function topPartiesByOrderCount(
  range: DateRange,
  limit: number,
  runner: Runner = db(),
): Promise<TopPartyRowInternal[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'o');
  const { rows } = await runner.raw<{
    rows: Array<{
      party_id: string;
      party_name: string;
      party_code: string | null;
      city: string | null;
      order_count: string;
    }>;
  }>(
    `SELECT p.id AS party_id, p.name AS party_name, p.party_code, p.city,
            count(o.id) AS order_count
       FROM orders o
       JOIN parties p ON p.id = o.party_id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY p.id, p.name, p.party_code, p.city
      ORDER BY order_count DESC, p.name
      LIMIT ?`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    partyId: row.party_id,
    partyName: row.party_name,
    partyCode: row.party_code,
    city: row.city,
    orderCount: toNumber(row.order_count) ?? 0,
  }));
}

export interface TopCityRowInternal {
  city: string | null;
  partyCount: number;
  orderCount: number;
}

/** `NULL` and blank collapse into one bucket (`city: null`) — the server never invents "Unknown". */
export async function topPartiesByCity(range: DateRange, runner: Runner = db()): Promise<TopCityRowInternal[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'o');
  const { rows } = await runner.raw<{
    rows: Array<{ city: string | null; party_count: string; order_count: string }>;
  }>(
    `SELECT NULLIF(btrim(MIN(btrim(p.city))), '') AS city,
            count(DISTINCT p.id) AS party_count,
            count(o.id) AS order_count
       FROM orders o
       JOIN parties p ON p.id = o.party_id
      WHERE o.tenant_id = ?
        AND o.dispatched_at >= (?::timestamp AT TIME ZONE ?)
        AND o.dispatched_at <  (?::timestamp AT TIME ZONE ?)
        AND o.deleted_at IS NULL${scope.sql}
      GROUP BY lower(btrim(COALESCE(p.city, '')))
      ORDER BY order_count DESC, city`,
    [range.tenantId, range.fromDate, tz, range.toDateExclusive, tz, ...scope.bindings],
  );

  return rows.map((row) => ({
    city: row.city,
    partyCount: toNumber(row.party_count) ?? 0,
    orderCount: toNumber(row.order_count) ?? 0,
  }));
}

// --- The table reports ------------------------------------------------------
//
// Each returns plain rows keyed exactly as `REPORT_COLUMNS` names the columns
// (`shared/src/domain/reports.ts`), so the service adds nothing but the cap and
// the totals. Every one takes `limit`: the service asks for one row past its
// cap so it can say a report was cut rather than quietly cutting it.

type TableRow = Record<string, string | number | null>;

/** An order's pieces, one row per order: join it, never SUM across it twice. */
const ORDER_PIECES = `(SELECT parent_id, SUM(quantity) AS pieces
                         FROM line_items
                        WHERE tenant_id = ? AND parent_type = 'order'
                        GROUP BY parent_id)`;

/** The order's own weight: the human's override when there is one. */
const ORDER_KG = 'COALESCE(o.total_weight_kg_override, o.total_weight_kg)';

function num(value: unknown): number {
  return toNumber(value as string | number | null) ?? 0;
}

/** Per user: what they raised, what became orders, what was lost, what is open, and what they dispatched. */
export async function byUser(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const leadScope = scoped(range, 'l');
  const orderScope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `WITH lead_part AS (
       SELECT COALESCE(l.owner_id, '') AS uid,
              count(*) AS created,
              count(*) FILTER (WHERE l.converted_order_id IS NOT NULL) AS converted,
              count(*) FILTER (WHERE l.converted_order_id IS NULL AND s.is_terminal) AS lost,
              count(*) FILTER (WHERE l.converted_order_id IS NULL AND NOT s.is_terminal) AS open
         FROM leads l
         JOIN pipeline_stages s ON s.id = l.stage_id
        WHERE l.tenant_id = ? AND ${inRange('l.created_at')} AND l.deleted_at IS NULL${leadScope.sql}
        GROUP BY 1
     ),
     order_part AS (
       SELECT COALESCE(o.owner_id, '') AS uid,
              count(*) AS dispatched,
              COALESCE(SUM(li.pieces), 0) AS pieces,
              COALESCE(SUM(${ORDER_KG}), 0) AS kg
         FROM orders o
         LEFT JOIN ${ORDER_PIECES} li ON li.parent_id = o.id
        WHERE o.tenant_id = ? AND ${inRange('o.dispatched_at')} AND o.deleted_at IS NULL${orderScope.sql}
        GROUP BY 1
     )
     SELECT COALESCE(lp.uid, op.uid) AS uid, u.display_name AS user_name,
            COALESCE(lp.created, 0) AS created, COALESCE(lp.converted, 0) AS converted,
            COALESCE(lp.lost, 0) AS lost, COALESCE(lp.open, 0) AS open,
            COALESCE(op.dispatched, 0) AS dispatched, COALESCE(op.pieces, 0) AS pieces,
            COALESCE(op.kg, 0) AS kg
       FROM lead_part lp
       FULL OUTER JOIN order_part op ON op.uid = lp.uid
       LEFT JOIN users u ON u.id = COALESCE(lp.uid, op.uid)
      ORDER BY lower(COALESCE(u.display_name, '')), COALESCE(lp.uid, op.uid)
      LIMIT ?`,
    [
      range.tenantId, ...rangeBindings(range, tz), ...leadScope.bindings,
      range.tenantId, range.tenantId, ...rangeBindings(range, tz), ...orderScope.bindings,
      limit,
    ],
  );

  return rows.map((row) => ({
    user: (row.user_name as string | null) ?? null,
    created: num(row.created),
    converted: num(row.converted),
    lost: num(row.lost),
    open: num(row.open),
    dispatched: num(row.dispatched),
    pieces: num(row.pieces),
    kg: num(row.kg),
  }));
}

/** User × day: the same four figures as `byUser`, one row per person per day they did anything. */
export async function userDaily(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const leadScope = scoped(range, 'l');
  const orderScope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `WITH ev AS (
       SELECT COALESCE(l.owner_id, '') AS uid, (l.created_at AT TIME ZONE ?)::date AS d,
              1 AS created, 0 AS converted, 0 AS dispatched, 0::numeric AS pieces
         FROM leads l
        WHERE l.tenant_id = ? AND ${inRange('l.created_at')} AND l.deleted_at IS NULL${leadScope.sql}
       UNION ALL
       SELECT COALESCE(l.owner_id, ''), (l.converted_at AT TIME ZONE ?)::date, 0, 1, 0, 0::numeric
         FROM leads l
        WHERE l.tenant_id = ? AND l.converted_at IS NOT NULL AND ${inRange('l.converted_at')}
          AND l.deleted_at IS NULL${leadScope.sql}
       UNION ALL
       SELECT COALESCE(o.owner_id, ''), (o.dispatched_at AT TIME ZONE ?)::date, 0, 0, 1, COALESCE(li.pieces, 0)
         FROM orders o
         LEFT JOIN ${ORDER_PIECES} li ON li.parent_id = o.id
        WHERE o.tenant_id = ? AND ${inRange('o.dispatched_at')} AND o.deleted_at IS NULL${orderScope.sql}
     )
     SELECT to_char(ev.d, 'YYYY-MM-DD') AS day, ev.uid, u.display_name AS user_name,
            SUM(ev.created) AS created, SUM(ev.converted) AS converted,
            SUM(ev.dispatched) AS dispatched, SUM(ev.pieces) AS pieces
       FROM ev
       LEFT JOIN users u ON u.id = ev.uid
      GROUP BY ev.d, ev.uid, u.display_name
      ORDER BY ev.d, lower(COALESCE(u.display_name, '')), ev.uid
      LIMIT ?`,
    [
      tz, range.tenantId, ...rangeBindings(range, tz), ...leadScope.bindings,
      tz, range.tenantId, ...rangeBindings(range, tz), ...leadScope.bindings,
      tz, range.tenantId, range.tenantId, ...rangeBindings(range, tz), ...orderScope.bindings,
      limit,
    ],
  );

  return rows.map((row) => ({
    day: row.day as string,
    user: (row.user_name as string | null) ?? null,
    created: num(row.created),
    converted: num(row.converted),
    dispatched: num(row.dispatched),
    pieces: num(row.pieces),
  }));
}

/** Per party: leads raised and orders dispatched in the range, and when it last ordered at all. */
export async function byParty(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const leadScope = scoped(range, 'l');
  const orderScope = scoped(range, 'o');
  const lastScope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `WITH lead_ct AS (
       SELECT l.party_id, count(*) AS leads
         FROM leads l
        WHERE l.tenant_id = ? AND ${inRange('l.created_at')} AND l.deleted_at IS NULL${leadScope.sql}
        GROUP BY 1
     ),
     ord AS (
       SELECT o.party_id, count(*) AS orders, COALESCE(SUM(li.pieces), 0) AS pieces,
              COALESCE(SUM(${ORDER_KG}), 0) AS kg
         FROM orders o
         LEFT JOIN ${ORDER_PIECES} li ON li.parent_id = o.id
        WHERE o.tenant_id = ? AND ${inRange('o.dispatched_at')} AND o.deleted_at IS NULL${orderScope.sql}
        GROUP BY 1
     ),
     last_ord AS (
       SELECT o.party_id, max(o.dispatched_at) AS last_at
         FROM orders o
        WHERE o.tenant_id = ? AND o.dispatched_at IS NOT NULL AND o.deleted_at IS NULL${lastScope.sql}
        GROUP BY 1
     )
     SELECT p.party_code, p.name, p.city,
            COALESCE(lc.leads, 0) AS leads, COALESCE(od.orders, 0) AS orders,
            COALESCE(od.pieces, 0) AS pieces, COALESCE(od.kg, 0) AS kg,
            to_char(lo.last_at AT TIME ZONE ?, 'YYYY-MM-DD') AS last_order,
            CASE WHEN lo.last_at IS NULL THEN NULL
                 ELSE ((now() AT TIME ZONE ?)::date - (lo.last_at AT TIME ZONE ?)::date) END AS days_since
       FROM parties p
       LEFT JOIN lead_ct lc ON lc.party_id = p.id
       LEFT JOIN ord od ON od.party_id = p.id
       LEFT JOIN last_ord lo ON lo.party_id = p.id
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND (lc.leads IS NOT NULL OR od.orders IS NOT NULL)
      ORDER BY COALESCE(od.orders, 0) DESC, COALESCE(lc.leads, 0) DESC, p.name
      LIMIT ?`,
    [
      range.tenantId, ...rangeBindings(range, tz), ...leadScope.bindings,
      range.tenantId, range.tenantId, ...rangeBindings(range, tz), ...orderScope.bindings,
      range.tenantId, ...lastScope.bindings,
      tz, tz, tz, range.tenantId, limit,
    ],
  );

  return rows.map((row) => ({
    partyCode: (row.party_code as string | null) ?? null,
    partyName: row.name as string,
    city: (row.city as string | null) ?? null,
    leads: num(row.leads),
    orders: num(row.orders),
    pieces: num(row.pieces),
    kg: num(row.kg),
    lastOrder: (row.last_order as string | null) ?? null,
    daysSince: row.days_since === null || row.days_since === undefined ? null : num(row.days_since),
  }));
}

/** Parties whose latest order of any date fell before the range (none in it, none after), longest silent first. */
export async function partyDormant(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const lastScope = scoped(range, 'o');
  const inScope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `WITH last_ord AS (
       SELECT o.party_id, max(o.dispatched_at) AS last_at
         FROM orders o
        WHERE o.tenant_id = ? AND o.dispatched_at IS NOT NULL AND o.deleted_at IS NULL${lastScope.sql}
        GROUP BY 1
     ),
     in_range AS (
       SELECT o.party_id, count(*) AS orders
         FROM orders o
        WHERE o.tenant_id = ? AND ${inRange('o.dispatched_at')} AND o.deleted_at IS NULL${inScope.sql}
        GROUP BY 1
     )
     SELECT p.party_code, p.name, p.city,
            to_char(lo.last_at AT TIME ZONE ?, 'YYYY-MM-DD') AS last_order,
            ((now() AT TIME ZONE ?)::date - (lo.last_at AT TIME ZONE ?)::date) AS days_since,
            COALESCE(ir.orders, 0) AS orders
       FROM last_ord lo
       JOIN parties p ON p.id = lo.party_id
       LEFT JOIN in_range ir ON ir.party_id = lo.party_id
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ir.orders IS NULL
        AND lo.last_at < (?::timestamp AT TIME ZONE ?)
      ORDER BY lo.last_at ASC, p.name
      LIMIT ?`,
    [
      range.tenantId, ...lastScope.bindings,
      range.tenantId, ...rangeBindings(range, tz), ...inScope.bindings,
      tz, tz, tz, range.tenantId, range.fromDate, tz, limit,
    ],
  );

  return rows.map((row) => ({
    partyCode: (row.party_code as string | null) ?? null,
    partyName: row.name as string,
    city: (row.city as string | null) ?? null,
    lastOrder: (row.last_order as string | null) ?? null,
    daysSince: num(row.days_since),
    orders: num(row.orders),
  }));
}

/** Per city: parties that ordered, orders, pieces, kilograms. Blank and `NULL` cities are one bucket. */
export async function byCity(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT NULLIF(btrim(MIN(btrim(p.city))), '') AS city,
            count(DISTINCT p.id) AS parties, count(o.id) AS orders,
            COALESCE(SUM(li.pieces), 0) AS pieces, COALESCE(SUM(${ORDER_KG}), 0) AS kg
       FROM orders o
       JOIN parties p ON p.id = o.party_id
       LEFT JOIN ${ORDER_PIECES} li ON li.parent_id = o.id
      WHERE o.tenant_id = ? AND ${inRange('o.dispatched_at')} AND o.deleted_at IS NULL${scope.sql}
      GROUP BY lower(btrim(COALESCE(p.city, '')))
      ORDER BY orders DESC, city
      LIMIT ?`,
    [range.tenantId, range.tenantId, ...rangeBindings(range, tz), ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    city: (row.city as string | null) ?? null,
    parties: num(row.parties),
    orders: num(row.orders),
    pieces: num(row.pieces),
    kg: num(row.kg),
  }));
}

/**
 * The three product reports share one query shape: dispatched orders' lines,
 * grouped by what each line snapshotted. `orders` counts distinct orders (a
 * two-line order of one product is one order), `pieces` is the quantity, and
 * `kg` leaves out a line with no weight rather than counting it as zero.
 */
async function byLineGroup(
  range: DateRange,
  limit: number,
  select: string,
  group: string,
  runner: Runner,
): Promise<Array<Record<string, unknown>>> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'o');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT ${select},
            count(DISTINCT o.id) AS orders, COALESCE(SUM(li.quantity), 0) AS pieces,
            COALESCE(SUM(li.quantity * li.weight_kg), 0) AS kg
       FROM line_items li
       JOIN orders o ON o.id = li.parent_id AND o.tenant_id = li.tenant_id
      WHERE li.tenant_id = ? AND li.parent_type = 'order'
        AND ${inRange('o.dispatched_at')} AND o.deleted_at IS NULL${scope.sql}
      GROUP BY ${group}
      ORDER BY orders DESC, pieces DESC
      LIMIT ?`,
    [range.tenantId, ...rangeBindings(range, tz), ...scope.bindings, limit],
  );
  return rows;
}

/** Per product (the category a line was entered under, by its code and name). */
export async function byProduct(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const rows = await byLineGroup(
    range,
    limit,
    `COALESCE(li.category_code, '') AS code, COALESCE(li.category_name, '') AS product`,
    `COALESCE(li.category_code, ''), COALESCE(li.category_name, '')`,
    runner,
  );
  return rows.map((row) => ({
    code: row.code as string,
    product: row.product as string,
    orders: num(row.orders),
    pieces: num(row.pieces),
    kg: num(row.kg),
  }));
}

/** Per sub product, by the variant code the line was sold under. */
export async function byVariant(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const rows = await byLineGroup(
    range,
    limit,
    `COALESCE(li.code, '') AS code, li.product_name AS sub_product`,
    `COALESCE(li.code, ''), li.product_name`,
    runner,
  );
  return rows.map((row) => ({
    code: row.code as string,
    subProduct: row.sub_product as string,
    orders: num(row.orders),
    pieces: num(row.pieces),
    kg: num(row.kg),
  }));
}

/** Per brand, as the line snapshotted it (`''` for a line from before brands). */
export async function byBrand(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const rows = await byLineGroup(range, limit, `COALESCE(li.brand_name, '') AS brand`, `COALESCE(li.brand_name, '')`, runner);
  return rows.map((row) => ({
    brand: row.brand as string,
    orders: num(row.orders),
    pieces: num(row.pieces),
    kg: num(row.kg),
  }));
}

/**
 * A picture of now, so the date range does not apply: open pending orders by
 * stage, with how long each has sat there. A lead enters a stage when the last
 * timeline entry that moved it was written, or when it was raised.
 */
export async function stageAgeing(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'l');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT s.name AS stage, count(*) AS open,
            round(avg(x.days)::numeric, 1) AS avg_days, max(x.days) AS oldest_days
       FROM (
         SELECT l.stage_id,
                ((now() AT TIME ZONE ?)::date - (COALESCE(
                  (SELECT max(t.created_at) FROM timeline_entries t
                    WHERE t.tenant_id = l.tenant_id AND t.parent_type = 'lead'
                      AND t.parent_id = l.id AND t.to_stage_id IS NOT NULL),
                  l.created_at) AT TIME ZONE ?)::date) AS days
           FROM leads l
          WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.converted_order_id IS NULL${scope.sql}
       ) x
       JOIN pipeline_stages s ON s.id = x.stage_id
      WHERE NOT s.is_terminal
      GROUP BY s.id, s.name, s.sequence
      ORDER BY s.sequence
      LIMIT ?`,
    [tz, tz, range.tenantId, ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    stage: row.stage as string,
    open: num(row.open),
    avgDays: num(row.avg_days),
    oldestDays: num(row.oldest_days),
  }));
}

/** Per source platform: pending orders raised in the range, how many became orders, and the rate. */
export async function leadSources(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'l');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT COALESCE(l.source_platform, '') AS source, count(*) AS leads,
            count(*) FILTER (WHERE l.converted_order_id IS NOT NULL) AS converted
       FROM leads l
      WHERE l.tenant_id = ? AND ${inRange('l.created_at')} AND l.deleted_at IS NULL${scope.sql}
      GROUP BY 1
      ORDER BY leads DESC, source
      LIMIT ?`,
    [range.tenantId, ...rangeBindings(range, tz), ...scope.bindings, limit],
  );

  return rows.map((row) => {
    const leads = num(row.leads);
    const converted = num(row.converted);
    return {
      source: row.source as string,
      leads,
      converted,
      percent: leads === 0 ? 0 : Math.round((converted / leads) * 1000) / 10,
    };
  });
}

/** Per month converted: how many pending orders became orders and how long each took, in whole days. */
export async function conversionTime(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'l');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT to_char(date_trunc('month', l.converted_at AT TIME ZONE ?), 'YYYY-MM') AS month,
            count(*) AS converted,
            round(avg((l.converted_at AT TIME ZONE ?)::date - (l.created_at AT TIME ZONE ?)::date)::numeric, 1) AS avg_days,
            max((l.converted_at AT TIME ZONE ?)::date - (l.created_at AT TIME ZONE ?)::date) AS max_days
       FROM leads l
      WHERE l.tenant_id = ? AND l.converted_at IS NOT NULL AND ${inRange('l.converted_at')}
        AND l.deleted_at IS NULL${scope.sql}
      GROUP BY 1
      ORDER BY 1
      LIMIT ?`,
    [tz, tz, tz, tz, tz, range.tenantId, ...rangeBindings(range, tz), ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    month: row.month as string,
    converted: num(row.converted),
    avgDays: num(row.avg_days),
    maxDays: num(row.max_days),
  }));
}

/**
 * Every open pending order, oldest first — a list, not a roll-up. A snapshot of
 * now, so the date range does not apply. `number` is the PO number, or the id
 * of a lead that has none.
 */
export async function openPendingOrders(range: DateRange, limit: number, runner: Runner = db()): Promise<TableRow[]> {
  const tz = config.locale.timeZone;
  const scope = scoped(range, 'l');
  const { rows } = await runner.raw<{ rows: Array<Record<string, unknown>> }>(
    `SELECT COALESCE(l.po_number, l.id) AS number, p.name AS party, u.display_name AS owner, s.name AS stage,
            ((now() AT TIME ZONE ?)::date - (l.created_at AT TIME ZONE ?)::date) AS days_open,
            COALESCE(li.pieces, 0) AS pieces
       FROM leads l
       JOIN parties p ON p.id = l.party_id
       JOIN pipeline_stages s ON s.id = l.stage_id
       LEFT JOIN users u ON u.id = l.owner_id
       LEFT JOIN (SELECT parent_id, SUM(quantity) AS pieces
                    FROM line_items
                   WHERE tenant_id = ? AND parent_type = 'lead'
                   GROUP BY parent_id) li ON li.parent_id = l.id
      WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.converted_order_id IS NULL
        AND NOT s.is_terminal${scope.sql}
      ORDER BY l.created_at ASC, l.id
      LIMIT ?`,
    [tz, tz, range.tenantId, range.tenantId, ...scope.bindings, limit],
  );

  return rows.map((row) => ({
    number: row.number as string,
    party: row.party as string,
    owner: (row.owner as string | null) ?? null,
    stage: row.stage as string,
    daysOpen: num(row.days_open),
    pieces: num(row.pieces),
  }));
}

export interface ReportSubjectRow {
  id: string;
  name: string;
}

/** The people an administrator may pick: every live account, A to Z. */
export async function listSubjects(tenantId: string, runner: Runner = db()): Promise<ReportSubjectRow[]> {
  const rows = await runner('users')
    .where({ tenant_id: tenantId, is_active: true })
    .whereNull('deleted_at')
    .orderByRaw('lower(display_name), id')
    .select<Array<{ id: string; display_name: string }>>('id', 'display_name');
  return rows.map((row) => ({ id: row.id, name: row.display_name }));
}

/** One live user's name, for the subject label — null when there is no such live user in this company. */
export async function findSubject(
  tenantId: string,
  userId: string,
  runner: Runner = db(),
): Promise<ReportSubjectRow | null> {
  const row = await runner('users')
    .where({ tenant_id: tenantId, id: userId, is_active: true })
    .whereNull('deleted_at')
    .first<{ id: string; display_name: string }>('id', 'display_name');
  return row ? { id: row.id, name: row.display_name } : null;
}
