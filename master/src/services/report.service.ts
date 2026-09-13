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
  MessageKey,
  ReportExportOptions,
} from '@orderbook/shared';
import { REPORT_COLUMNS, t } from '@orderbook/shared';
import { requirePermission, type ActorContext } from '../domain/actor.js';
import { resolvePartyScope } from '../domain/party-scope.js';
import { canSeeRates } from '../domain/visibility.js';
import { renderReportPdf } from '../pdf/table-renderer.js';
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
    reportRepo.dispatchesByMonth({ tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor) }),
    reportRepo.dispatchesByColour({ tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor) }),
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

  const rows = await reportRepo.leadOutcomesByMonth({ tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor) });

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
      ? reportRepo.topPartiesByValue({ tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor) }, limit)
      : reportRepo.topPartiesByOrderCount({ tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor) }, limit),
    reportRepo.topPartiesByCity({ tenantId: actor.tenantId, fromDate, toDateExclusive, scope: resolvePartyScope(actor) }),
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

/**
 * A catalogue string for a key that is only known as `MessageKey`.
 *
 * The same cast `lib/errors.ts` makes, for the same reason: at this boundary
 * the key is the whole union, so `ParamsFor<K>` cannot be checked per call the
 * way a literal `t('en', 'some.key')` can. Every key reached here is a column
 * or report label with no placeholders — `shared/tests/i18n-coverage.test.ts`
 * is what keeps that true.
 */
function label(key: MessageKey): string {
  return (t as (locale: 'en', key: MessageKey) => string)('en', key);
}

/**
 * One exported report, in whichever shape was asked for.
 *
 * A discriminated union rather than an optional `bytes`, because the Office
 * panel forwards this over a socket and has to know which door to send it out
 * of: a CSV becomes a `text/csv` body, a PDF becomes a file download. It used
 * to cast the ack to `{ csv: string }` unconditionally and always set
 * `text/csv` — so the moment a second format existed, a PDF would have arrived
 * as a corrupt CSV.
 */
export type ExportedReport =
  | { format: 'csv'; csv: string; rowCount: number }
  | {
      format: 'pdf';
      fileName: string;
      contentType: string;
      bytes: Buffer;
      rowCount: number;
    };

/** The rows of one report, as raw values keyed by column. */
async function reportRows(
  kind: ReportKind,
  input: ReportRangeInput & { limit?: number },
  actor: ActorContext,
): Promise<{ rows: Array<Record<string, unknown>>; range: ReportRange }> {
  if (kind === 'dispatches') {
    const report = await dispatchReport(input, actor);
    return {
      range: report.range,
      rows: report.months.map((month) => ({
        month: month.month,
        orderCount: month.orderCount,
        boxCount: month.boxCount,
        totalValue: month.totalValue,
      })),
    };
  }

  if (kind === 'lead-outcomes') {
    const report = await leadOutcomeReport(input, actor);
    return {
      range: report.range,
      rows: report.months.map((month) => ({
        month: month.month,
        converted: month.converted,
        lost: month.lost,
        quiet: month.quiet,
        open: month.open,
      })),
    };
  }

  if (kind === 'top-parties') {
    const report = await topPartiesReport(input, actor);
    return {
      range: report.range,
      rows: report.parties.map((party) => ({
        partyId: party.partyId,
        partyName: party.partyName,
        partyCode: party.partyCode ?? '',
        city: party.city ?? '',
        orderCount: party.orderCount,
        totalValue: party.totalValue,
      })),
    };
  }

  throw new ValidationError('validation.reports.kind.unknown', {}, { field: 'report' });
}

/**
 * The columns this export will carry, in order.
 *
 * A `columns` list narrows and reorders; an unknown key is ignored rather than
 * refused, so a bookmarked URL keeps working when a column is renamed. Asking
 * for nothing recognisable falls back to everything, because an empty
 * spreadsheet is never what somebody meant.
 */
function chosenColumns(kind: ReportKind, requested: string[] | undefined) {
  const all = REPORT_COLUMNS[kind];
  if (!requested || requested.length === 0) return all;

  const picked = requested
    .map((key) => all.find((column) => column.key === key))
    .filter((column): column is (typeof all)[number] => column !== undefined);

  return picked.length > 0 ? picked : all;
}

export async function exportReport(
  kind: ReportKind,
  input: ReportRangeInput & { limit?: number } & ReportExportOptions,
  actor: ActorContext,
): Promise<ExportedReport> {
  requirePermission(actor, 'reports.export');

  const { rows, range } = await reportRows(kind, input, actor);
  const columns = chosenColumns(kind, input.columns);

  /*
   * The tabular redaction rule, and it is deliberately not the JSON one.
   *
   * On the wire a masked money field is **absent**, because a missing property
   * is the only way to say "not yours" without claiming a value. A table has a
   * fixed shape: dropping the column would silently change what every other
   * column means by position, and a `0` would be a factual claim that the
   * figure is nothing. So the header stays and the cells go empty.
   */
  const allowed = canSeeRates(actor);

  const cell = (row: Record<string, unknown>, column: (typeof columns)[number]): unknown => {
    if (column.money && !allowed) return '';
    const value = row[column.key];
    return value === null || value === undefined ? '' : value;
  };

  const body = rows.map((row) => columns.map((column) => cell(row, column)));

  /*
   * A totals row, when asked for. Only the numeric columns sum — a total of a
   * month name is nonsense, and a total of a redacted money column would
   * reconstruct exactly the figure the redaction withheld.
   */
  let totals: unknown[] | undefined;
  if (input.totals) {
    // The label goes in the first column that cannot hold a number, not
    // unconditionally in position 0 — `?columns=` can narrow and reorder the
    // list, and a caller who puts a numeric or money column first would
    // otherwise have its grand total silently replaced with the word
    // "Totals". Computed once, outside the map, so exactly one cell gets the
    // label even when several columns qualify; -1 (no safe column at all)
    // leaves every cell to fall through to the sum/blank logic below.
    const labelIndex = columns.findIndex(
      (column) => !column.money && !rows.some((row) => typeof row[column.key] === 'number'),
    );

    totals = columns.map((column, index) => {
      if (index === labelIndex) return label('reports.export.totals');
      if (column.money && !allowed) return '';

      const sum = rows.reduce((running, row) => {
        const value = row[column.key];
        return typeof value === 'number' ? running + value : running;
      }, 0);

      const anyNumeric = rows.some((row) => typeof row[column.key] === 'number');
      return anyNumeric ? sum : '';
    });
  }

  await db().transaction((trx) =>
    activityLogRepo.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'report',
        entityId: kind,
        action: 'exported',
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          report: kind,
          from: range.fromDate,
          to: range.toDateExclusive,
          rowCount: rows.length,
          format: input.format ?? 'csv',
        },
      },
      actor,
      trx,
    ),
  );

  const headers = columns.map((column) => column.key);

  if ((input.format ?? 'csv') === 'csv') {
    // Header keys, not translated labels: the default output has to stay
    // byte-identical to what it was, because somebody's spreadsheet is pointing
    // at it.
    const csv = toCsv(headers, totals ? [...body, totals] : body);
    return { format: 'csv', csv, rowCount: rows.length };
  }

  const bytes = await renderReportPdf({
    title: label(REPORT_TITLE[kind]),
    subtitle: `${range.fromDate} — ${range.toDateExclusive}`,
    columns: columns.map((column) => ({
      label: label(column.labelToken),
      numeric: column.money || typeof rows[0]?.[column.key] === 'number',
    })),
    rows: body.map((row) => row.map((value) => String(value))),
    totals: totals?.map((value) => String(value)),
    paperSize: input.paperSize ?? 'a4',
    orientation: input.orientation ?? 'landscape',
  });

  return {
    format: 'pdf',
    fileName: `${kind}.pdf`,
    contentType: 'application/pdf',
    bytes,
    rowCount: rows.length,
  };
}

/** The heading a printed report carries. */
const REPORT_TITLE: Record<ReportKind, MessageKey> = {
  dispatches: 'reports.kind.dispatches',
  'lead-outcomes': 'reports.kind.leadOutcomes',
  'top-parties': 'reports.kind.topParties',
};
