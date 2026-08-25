/**
 * Reports — `dispatchReport`, `leadOutcomeReport`, `topPartiesReport`,
 * `exportReport` (`docs/backend-modules/04-API-CONTRACT.md` §3). Per
 * report: permission, resolve the range from local date components, call
 * the repository, zero-fill the month list, then include a money field only
 * when `canSeeRates(actor)` — absent, never null or zero, for a rate-blind
 * caller. Totals are computed here from the repository's own rows under the
 * same rule — a client must never sum masked buckets itself.
 */

import type {
  DispatchColourBucket,
  DispatchesReport,
  DispatchMonthBucket,
  LeadOutcome,
  LeadOutcomesReport,
  ReportKind,
  ReportRange,
  ReportRangeInput,
  TopCityRow,
  TopPartiesReport,
  TopPartyRow,
} from '@orderbook/shared';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import { canSeeRates } from '../domain/visibility.js';
import { QUIET_AFTER_DAYS } from '../domain/lead-outcome.js';
import { resolveReportRange, type DateComponents } from '../domain/report-range.js';
import { config } from '../config/index.js';
import { db } from '../db/knex.js';
import { toCsv } from '../lib/csv.js';
import { ValidationError } from '../lib/errors.js';
import * as activityLogRepo from '../repositories/activity-log.repository.js';
import * as reportRepo from '../repositories/report.repository.js';

const DEFAULT_TOP_LIMIT = 10;
const MIN_TOP_LIMIT = 5;
const MAX_TOP_LIMIT = 50;

function todayInTimeZone(tz: string): DateComponents {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

function buildRange(input: ReportRangeInput): { range: ReportRange; fromDate: string; toDateExclusive: string } {
  const tz = config.locale.timeZone;
  const resolved = resolveReportRange(input, todayInTimeZone(tz));
  return {
    range: {
      period: resolved.period,
      fromDate: resolved.fromDate,
      toDateExclusive: resolved.toDateExclusive,
      months: resolved.months,
      timeZone: tz,
    },
    fromDate: resolved.fromDate,
    toDateExclusive: resolved.toDateExclusive,
  };
}

function clampTopLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_TOP_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), MIN_TOP_LIMIT), MAX_TOP_LIMIT);
}

export async function dispatchReport(input: ReportRangeInput, actor: ActorContext): Promise<DispatchesReport> {
  requirePermission(actor, 'reports.view');
  const { range, fromDate, toDateExclusive } = buildRange(input);
  const ratesIncluded = canSeeRates(actor);

  const [monthRows, colourRows] = await Promise.all([
    reportRepo.dispatchesByMonth({ tenantId: actor.tenantId, fromDate, toDateExclusive }),
    reportRepo.dispatchesByColour({ tenantId: actor.tenantId, fromDate, toDateExclusive }),
  ]);

  const byMonth = new Map(monthRows.map((row) => [row.month, row]));
  const months: DispatchMonthBucket[] = range.months.map((month) => {
    const row = byMonth.get(month);
    const bucket: DispatchMonthBucket = {
      month,
      orderCount: row?.orderCount ?? 0,
      boxCount: row?.boxCount ?? 0,
    };
    if (ratesIncluded) bucket.totalValue = row?.totalValue ?? 0;
    return bucket;
  });

  const colours: DispatchColourBucket[] = colourRows.map((row) => ({ colour: row.colour, boxCount: row.boxCount }));

  const totals = months.reduce(
    (acc, bucket) => {
      acc.orderCount += bucket.orderCount;
      acc.boxCount += bucket.boxCount;
      if (ratesIncluded) acc.totalValue = (acc.totalValue ?? 0) + (bucket.totalValue ?? 0);
      return acc;
    },
    { orderCount: 0, boxCount: 0 } as { orderCount: number; boxCount: number; totalValue?: number },
  );

  return { range, months, colours, totals, ratesIncluded };
}

const OUTCOMES: readonly LeadOutcome[] = ['converted', 'lost', 'quiet', 'open'];

export async function leadOutcomeReport(input: ReportRangeInput, actor: ActorContext): Promise<LeadOutcomesReport> {
  requirePermission(actor, 'reports.view');
  const { range, fromDate, toDateExclusive } = buildRange(input);

  const rows = await reportRepo.leadOutcomesByMonth({ tenantId: actor.tenantId, fromDate, toDateExclusive });

  const byMonth = new Map<string, Record<LeadOutcome, number>>();
  for (const month of range.months) byMonth.set(month, { converted: 0, lost: 0, quiet: 0, open: 0 });
  for (const row of rows) {
    const bucket = byMonth.get(row.month);
    if (bucket) bucket[row.outcome] += row.count;
  }

  const months = range.months.map((month) => ({ month, ...(byMonth.get(month) as Record<LeadOutcome, number>) }));

  const totals: Record<LeadOutcome, number> = { converted: 0, lost: 0, quiet: 0, open: 0 };
  for (const bucket of months) {
    for (const outcome of OUTCOMES) totals[outcome] += bucket[outcome];
  }

  return { range, months, totals, quietAfterDays: QUIET_AFTER_DAYS };
}

export async function topPartiesReport(
  input: ReportRangeInput & { limit?: number },
  actor: ActorContext,
): Promise<TopPartiesReport> {
  requirePermission(actor, 'reports.view');
  const { range, fromDate, toDateExclusive } = buildRange(input);
  const limit = clampTopLimit(input.limit);
  const ratesIncluded = canSeeRates(actor);

  const [partyRows, cityRows] = await Promise.all([
    ratesIncluded
      ? reportRepo.topPartiesByValue({ tenantId: actor.tenantId, fromDate, toDateExclusive }, limit)
      : reportRepo.topPartiesByOrderCount({ tenantId: actor.tenantId, fromDate, toDateExclusive }, limit),
    reportRepo.topPartiesByCity({ tenantId: actor.tenantId, fromDate, toDateExclusive }),
  ]);

  const parties: TopPartyRow[] = partyRows.map((row) => {
    const item: TopPartyRow = {
      partyId: row.partyId,
      partyName: row.partyName,
      partyCode: row.partyCode,
      city: row.city,
      orderCount: row.orderCount,
    };
    if (ratesIncluded) item.totalValue = row.totalValue;
    return item;
  });

  const cities: TopCityRow[] = cityRows.map((row) => {
    const item: TopCityRow = { city: row.city, partyCount: row.partyCount, orderCount: row.orderCount };
    if (ratesIncluded) item.totalValue = row.totalValue;
    return item;
  });

  return {
    range,
    parties,
    cities,
    orderedBy: ratesIncluded ? 'value' : 'orderCount',
    limit,
    ratesIncluded,
  };
}

const CSV_HEADERS: Record<ReportKind, string[]> = {
  dispatches: ['month', 'orderCount', 'boxCount', 'totalValue'],
  'lead-outcomes': ['month', 'converted', 'lost', 'quiet', 'open'],
  'top-parties': ['partyId', 'partyName', 'partyCode', 'city', 'orderCount', 'totalValue'],
};

export async function exportReport(
  kind: ReportKind,
  input: ReportRangeInput & { limit?: number },
  actor: ActorContext,
): Promise<{ csv: string; rowCount: number }> {
  requirePermission(actor, 'reports.export');

  let rows: unknown[][];
  let range: ReportRange;

  if (kind === 'dispatches') {
    const report = await dispatchReport(input, actor);
    range = report.range;
    rows = report.months.map((m) => [m.month, m.orderCount, m.boxCount, m.totalValue ?? '']);
  } else if (kind === 'lead-outcomes') {
    const report = await leadOutcomeReport(input, actor);
    range = report.range;
    rows = report.months.map((m) => [m.month, m.converted, m.lost, m.quiet, m.open]);
  } else if (kind === 'top-parties') {
    const report = await topPartiesReport(input, actor);
    range = report.range;
    rows = report.parties.map((p) => [p.partyId, p.partyName, p.partyCode ?? '', p.city ?? '', p.orderCount, p.totalValue ?? '']);
  } else {
    throw new ValidationError('validation.reports.kind.unknown', {}, { field: 'report' });
  }

  const csv = toCsv(CSV_HEADERS[kind], rows);

  await db().transaction((trx) =>
    activityLogRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'report',
        entityId: kind,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: { report: kind, from: range.fromDate, to: range.toDateExclusive, rowCount: rows.length },
      },
      actor,
      trx,
    ),
  );

  return { csv, rowCount: rows.length };
}

// Re-exported so a caller (route/socket layer) can validate `:report` /
// `report` against the same list `ReportKind` is derived from.
export { isReportKind } from '@orderbook/shared';
