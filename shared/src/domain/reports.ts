/**
 * Reports' wire types (`docs/backend-modules/04-API-CONTRACT.md` §3): counts
 * of orders, pieces and parties, and kilograms. The software carries no amounts.
 *
 * Two generations live here. The three **legacy** reports (`dispatches`,
 * `lead-outcomes`, `top-parties`) keep their own typed shapes, REST routes and
 * socket commands for Offices that predate the others, and their CSV is
 * byte-identical to what it always was. Every report — those three included —
 * is also answered as a **`ReportTable`** (`report:table`, `GET
 * /api/reports/table/:kind`), which is what both panels' Reports screen draws,
 * so a fifteenth kind is a row in `REPORT_META` and one query, not a screen.
 */

import type { IsoDate, RecordId } from './entities.js';
import type { MessageKey } from '../i18n/keys.js';

export type ReportPeriod =
  | 'thisMonth'
  | 'last3Months'
  | 'last6Months'
  | 'last12Months'
  /** From 1 April of the current Indian financial year to this month. */
  | 'thisFinancialYear'
  | 'custom'
  /** An exact day range, `fromDate` to `toDate` inclusive. */
  | 'customDates';

export interface ReportRangeInput {
  /** Default `'last6Months'`. */
  period?: ReportPeriod;
  /** `'YYYY-MM'`, required when `period === 'custom'`. */
  fromMonth?: string;
  /** `'YYYY-MM'`, inclusive. */
  toMonth?: string;
  /** `'YYYY-MM-DD'`, required when `period === 'customDates'`. */
  fromDate?: string;
  /** `'YYYY-MM-DD'`, inclusive; today when omitted. */
  toDate?: string;
}

/** Echoed back on every report, so a printed page states its own day boundary. */
export interface ReportRange {
  period: ReportPeriod;
  fromDate: IsoDate;
  toDateExclusive: IsoDate;
  /** Every bucket in order, e.g. `['2026-03', '2026-04']`. */
  months: string[];
  timeZone: string;
}

export interface ReportTotals {
  orderCount: number;
  boxCount: number;
}

export interface DispatchMonthBucket {
  month: string;
  orderCount: number;
  boxCount: number;
}

export interface DispatchColourBucket {
  colour: string;
  boxCount: number;
}

export interface DispatchesReport {
  range: ReportRange;
  /** Zero-filled: every month in range is present, even with no dispatches. */
  months: DispatchMonthBucket[];
  colours: DispatchColourBucket[];
  totals: ReportTotals;
}

export type LeadOutcome = 'converted' | 'lost' | 'quiet' | 'open';

export interface LeadOutcomeMonthBucket {
  month: string;
  converted: number;
  lost: number;
  quiet: number;
  open: number;
}

export interface LeadOutcomesReport {
  range: ReportRange;
  months: LeadOutcomeMonthBucket[];
  totals: Record<LeadOutcome, number>;
  /** The "went quiet" threshold actually applied, so the chart can label itself. */
  quietAfterDays: number;
}

export interface TopPartyRow {
  partyId: RecordId;
  partyName: string;
  partyCode: string | null;
  city: string | null;
  orderCount: number;
}

export interface TopCityRow {
  city: string | null;
  partyCount: number;
  orderCount: number;
}

export interface TopPartiesReport {
  range: ReportRange;
  parties: TopPartyRow[];
  cities: TopCityRow[];
  limit: number;
}

export type ReportKind =
  | 'dispatches'
  | 'lead-outcomes'
  | 'top-parties'
  | 'by-user'
  | 'user-daily'
  | 'by-party'
  | 'party-dormant'
  | 'by-city'
  | 'by-product'
  | 'by-variant'
  | 'by-brand'
  | 'stage-ageing'
  | 'lead-sources'
  | 'conversion-time'
  | 'open-pending-orders';

/** The three that predate the table API. Their REST routes, socket commands and CSV bytes are frozen. */
export const LEGACY_REPORT_KINDS: readonly ReportKind[] = ['dispatches', 'lead-outcomes', 'top-parties'];

export const REPORT_KINDS: readonly ReportKind[] = [
  ...LEGACY_REPORT_KINDS,
  'by-user',
  'user-daily',
  'by-party',
  'party-dormant',
  'by-city',
  'by-product',
  'by-variant',
  'by-brand',
  'stage-ageing',
  'lead-sources',
  'conversion-time',
  'open-pending-orders',
];

export function isReportKind(value: unknown): value is ReportKind {
  return (REPORT_KINDS as readonly unknown[]).includes(value);
}

export function isLegacyReportKind(kind: ReportKind): boolean {
  return LEGACY_REPORT_KINDS.includes(kind);
}

// --- What each report is ----------------------------------------------------

/** How a column's figure reads: a count, a quantity, a date. Drives alignment, formatting and which columns total. */
export type ReportUnit = 'count' | 'pieces' | 'kg' | 'days' | 'percent' | 'date' | 'text';

/** Units a totals row sums. Days and percentages are not additive; a date or a name is not a number. */
export const SUMMABLE_UNITS: readonly ReportUnit[] = ['count', 'pieces', 'kg'];

/** One column of a report, exported or drawn. */
export interface ReportColumn {
  key: string;
  labelToken: MessageKey;
  /** Absent on the three legacy kinds' export columns, which predate it. */
  unit?: ReportUnit;
}

const col = (key: string, labelToken: MessageKey, unit: ReportUnit): ReportColumn => ({ key, labelToken, unit });

export const REPORT_COLUMNS: Record<ReportKind, readonly ReportColumn[]> = {
  // The three legacy kinds: keys are the CSV header, so they never change.
  dispatches: [
    { key: 'month', labelToken: 'reports.column.month' },
    { key: 'orderCount', labelToken: 'reports.column.orderCount' },
    { key: 'boxCount', labelToken: 'reports.column.boxCount' },
  ],
  'lead-outcomes': [
    { key: 'month', labelToken: 'reports.column.month' },
    { key: 'converted', labelToken: 'reports.column.converted' },
    { key: 'lost', labelToken: 'reports.column.lost' },
    { key: 'quiet', labelToken: 'reports.column.quiet' },
    { key: 'open', labelToken: 'reports.column.open' },
  ],
  'top-parties': [
    { key: 'partyId', labelToken: 'reports.column.partyId' },
    { key: 'partyName', labelToken: 'reports.column.partyName' },
    { key: 'partyCode', labelToken: 'reports.column.partyCode' },
    { key: 'city', labelToken: 'reports.column.city' },
    { key: 'orderCount', labelToken: 'reports.column.orderCount' },
  ],
  'by-user': [
    col('user', 'reports.column.user', 'text'),
    col('created', 'reports.column.leadsCreated', 'count'),
    col('converted', 'reports.column.converted', 'count'),
    col('lost', 'reports.column.lost', 'count'),
    col('open', 'reports.column.open', 'count'),
    col('dispatched', 'reports.column.dispatched', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
    col('kg', 'reports.column.kg', 'kg'),
  ],
  'user-daily': [
    col('day', 'reports.column.day', 'date'),
    col('user', 'reports.column.user', 'text'),
    col('created', 'reports.column.leadsCreated', 'count'),
    col('converted', 'reports.column.converted', 'count'),
    col('dispatched', 'reports.column.dispatched', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
  ],
  'by-party': [
    col('partyCode', 'reports.column.partyCode', 'text'),
    col('partyName', 'reports.column.partyName', 'text'),
    col('city', 'reports.column.city', 'text'),
    col('leads', 'reports.column.leads', 'count'),
    col('orders', 'reports.column.orders', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
    col('kg', 'reports.column.kg', 'kg'),
    col('lastOrder', 'reports.column.lastOrder', 'date'),
    col('daysSince', 'reports.column.daysSince', 'days'),
  ],
  'party-dormant': [
    col('partyCode', 'reports.column.partyCode', 'text'),
    col('partyName', 'reports.column.partyName', 'text'),
    col('city', 'reports.column.city', 'text'),
    col('lastOrder', 'reports.column.lastOrder', 'date'),
    col('daysSince', 'reports.column.daysSince', 'days'),
    col('orders', 'reports.column.ordersInPeriod', 'count'),
  ],
  'by-city': [
    col('city', 'reports.column.city', 'text'),
    col('parties', 'reports.column.parties', 'count'),
    col('orders', 'reports.column.orders', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
    col('kg', 'reports.column.kg', 'kg'),
  ],
  'by-product': [
    col('code', 'reports.column.code', 'text'),
    col('product', 'reports.column.product', 'text'),
    col('orders', 'reports.column.orders', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
    col('kg', 'reports.column.kg', 'kg'),
  ],
  'by-variant': [
    col('code', 'reports.column.code', 'text'),
    col('subProduct', 'reports.column.subProduct', 'text'),
    col('orders', 'reports.column.orders', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
    col('kg', 'reports.column.kg', 'kg'),
  ],
  'by-brand': [
    col('brand', 'reports.column.brand', 'text'),
    col('orders', 'reports.column.orders', 'count'),
    col('pieces', 'reports.column.pieces', 'pieces'),
    col('kg', 'reports.column.kg', 'kg'),
  ],
  'stage-ageing': [
    col('stage', 'reports.column.stage', 'text'),
    col('open', 'reports.column.openLeads', 'count'),
    col('avgDays', 'reports.column.avgDays', 'days'),
    col('oldestDays', 'reports.column.oldestDays', 'days'),
  ],
  'lead-sources': [
    col('source', 'reports.column.source', 'text'),
    col('leads', 'reports.column.leads', 'count'),
    col('converted', 'reports.column.converted', 'count'),
    col('percent', 'reports.column.conversion', 'percent'),
  ],
  'conversion-time': [
    col('month', 'reports.column.month', 'text'),
    col('converted', 'reports.column.converted', 'count'),
    col('avgDays', 'reports.column.avgDaysToConvert', 'days'),
    col('maxDays', 'reports.column.maxDays', 'days'),
  ],
  'open-pending-orders': [
    col('number', 'reports.column.pendingOrder', 'text'),
    col('party', 'reports.column.party', 'text'),
    col('owner', 'reports.column.owner', 'text'),
    col('stage', 'reports.column.stage', 'text'),
    col('daysOpen', 'reports.column.daysOpen', 'days'),
    col('pieces', 'reports.column.pieces', 'pieces'),
  ],
};

/** What the screen needs to know about a kind besides its columns. */
export interface ReportMeta {
  titleToken: MessageKey;
  /** A kit icon name; the screen's tab and the sidebar sub-page use it. */
  icon: 'orders' | 'report' | 'parties' | 'users' | 'calendar' | 'products';
  /**
   * `range` — the date range decides the rows. `snapshot` — it is a picture of
   * now (open pending orders, stage ageing), so the range is echoed but
   * ignored, and the screen says so.
   */
  basis: 'range' | 'snapshot';
}

export const REPORT_META: Record<ReportKind, ReportMeta> = {
  dispatches: { titleToken: 'reports.kind.dispatches', icon: 'orders', basis: 'range' },
  'lead-outcomes': { titleToken: 'reports.kind.leadOutcomes', icon: 'report', basis: 'range' },
  'top-parties': { titleToken: 'reports.kind.topParties', icon: 'parties', basis: 'range' },
  'by-user': { titleToken: 'reports.kind.byUser', icon: 'users', basis: 'range' },
  'user-daily': { titleToken: 'reports.kind.userDaily', icon: 'calendar', basis: 'range' },
  'by-party': { titleToken: 'reports.kind.byParty', icon: 'parties', basis: 'range' },
  'party-dormant': { titleToken: 'reports.kind.partyDormant', icon: 'parties', basis: 'range' },
  'by-city': { titleToken: 'reports.kind.byCity', icon: 'parties', basis: 'range' },
  'by-product': { titleToken: 'reports.kind.byProduct', icon: 'products', basis: 'range' },
  'by-variant': { titleToken: 'reports.kind.byVariant', icon: 'products', basis: 'range' },
  'by-brand': { titleToken: 'reports.kind.byBrand', icon: 'products', basis: 'range' },
  'stage-ageing': { titleToken: 'reports.kind.stageAgeing', icon: 'report', basis: 'snapshot' },
  'lead-sources': { titleToken: 'reports.kind.leadSources', icon: 'report', basis: 'range' },
  'conversion-time': { titleToken: 'reports.kind.conversionTime', icon: 'report', basis: 'range' },
  'open-pending-orders': { titleToken: 'reports.kind.openPendingOrders', icon: 'orders', basis: 'snapshot' },
};

// --- The table every kind answers -------------------------------------------

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

/** A second table under the main one: a breakdown a legacy report always carried (colours, cities). */
export interface ReportSection {
  titleToken: MessageKey;
  columns: readonly ReportColumn[];
  rows: ReportRow[];
}

/** Who a report's figures are about. */
export interface ReportSubject {
  /** Null is everyone — an administrator's default. */
  id: string | null;
  name: string | null;
}

export interface ReportTable {
  kind: ReportKind;
  range: ReportRange;
  subject: ReportSubject;
  columns: readonly ReportColumn[];
  rows: ReportRow[];
  /** Sums of the `SUMMABLE_UNITS` columns over *every* row, not just the ones returned. Null when none sums. */
  totals: Record<string, number> | null;
  /** Rows before the screen's cap. */
  rowCount: number;
  /** True when `rows` was cut at `REPORT_TABLE_ROW_CAP`; an export has the lot. */
  truncated: boolean;
  /** Extra tables: the colours under Dispatches, the cities under Top parties. */
  sections: ReportSection[];
  /** The "went quiet" threshold, on the kinds that quote it. */
  quietAfterDays?: number;
}

/** The screen draws this many rows; exports are capped separately. */
export const REPORT_TABLE_ROW_CAP = 2000;

/** Exports: a PDF is a page per few dozen rows and is built in memory, so it stops earlier. */
export const REPORT_EXPORT_CAPS = { csv: 100_000, xlsx: 100_000, pdf: 10_000 } as const;

/** What a person may ask for besides the range — the report screen's controls. */
export interface ReportOptions {
  /** The kinds this person is offered, in tab order. Empty when Reports is off for their tier. */
  kinds: ReportKind[];
  /** Every active user, for the "whose figures" picker. Null for someone who may only see their own. */
  subjects: ReportSubject[] | null;
  canExport: boolean;
}

/** Everything a report asks of the server, in one object; the REST query string and the socket payload are both this. */
export interface ReportQuery extends ReportRangeInput {
  /** Whose figures. Absent: one's own for the Office and Management tiers, everyone's for an administrator. */
  subjectId?: string;
  /** Top-N on the kinds that rank. */
  limit?: number;
}

const PERIODS: readonly ReportPeriod[] = [
  'thisMonth',
  'last3Months',
  'last6Months',
  'last12Months',
  'thisFinancialYear',
  'custom',
  'customDates',
];

/**
 * A query string (or any loose record) read into a `ReportQuery`. Reads
 * strings only and drops what it does not understand, so an Office route and
 * the Master's can share it and a bookmarked URL keeps working.
 */
export function parseReportQuery(query: Record<string, unknown>): ReportQuery {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const period = text(query.period);
  const limit = Number(query.limit);
  return {
    period: PERIODS.includes(period as ReportPeriod) ? (period as ReportPeriod) : undefined,
    fromMonth: text(query.fromMonth),
    toMonth: text(query.toMonth),
    fromDate: text(query.fromDate),
    toDate: text(query.toDate),
    subjectId: text(query.subjectId),
    limit: query.limit !== undefined && Number.isFinite(limit) ? limit : undefined,
  };
}

/** The `ReportQuery` as URL parameters — only what is set, so the default URL stays short. */
export function reportQueryParams(query: ReportQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ['period', 'fromMonth', 'toMonth', 'fromDate', 'toDate', 'subjectId'] as const) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params;
}

// --- Export ----------------------------------------------------------------

export type ReportFormat = 'csv' | 'xlsx' | 'pdf';

export type ReportPaperSize = 'a4' | 'letter';
export type ReportOrientation = 'portrait' | 'landscape';

/** The language an Excel or PDF export is written in; a CSV is keys, never words. */
export type ReportLocale = 'en' | 'hi';

/**
 * What an export asks for beyond the date range.
 *
 * Every field is optional and the defaults reproduce today's output **byte for
 * byte** — a CSV of every column, no totals row, no paper size. An export that
 * changed shape because a new option existed would break whatever spreadsheet
 * somebody has been pointing at it.
 */
export interface ReportExportOptions {
  format?: ReportFormat;
  /** Column keys, in the order asked for. Omitted means every column. */
  columns?: string[];
  /** Append a totals row. Text columns are blank in it; counts sum. */
  totals?: boolean;
  paperSize?: ReportPaperSize;
  orientation?: ReportOrientation;
  /** Words for the Excel and PDF headings and cells. English when omitted. */
  lang?: ReportLocale;
}

export function isReportFormat(value: unknown): value is ReportFormat {
  return value === 'csv' || value === 'xlsx' || value === 'pdf';
}
