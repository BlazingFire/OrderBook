/**
 * Reports' wire types (`docs/backend-modules/04-API-CONTRACT.md` §3). Every
 * money field is declared optional so redaction can *delete* the key rather
 * than nulling it — the same absent-not-zero rule the wire contract uses
 * everywhere else.
 */

import type { IsoDate, RecordId } from './entities.js';
import type { MessageKey } from '../i18n/keys.js';

export type ReportPeriod = 'thisMonth' | 'last3Months' | 'last6Months' | 'last12Months' | 'custom';

export interface ReportRangeInput {
  /** Default `'last6Months'`. */
  period?: ReportPeriod;
  /** `'YYYY-MM'`, required when `period === 'custom'`. */
  fromMonth?: string;
  /** `'YYYY-MM'`, inclusive. */
  toMonth?: string;
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
  totalValue?: number;
}

export interface DispatchMonthBucket {
  month: string;
  orderCount: number;
  boxCount: number;
  totalValue?: number;
}

export interface DispatchColourBucket {
  colour: string;
  boxCount: number;
  totalValue?: number;
}

export interface DispatchesReport {
  range: ReportRange;
  /** Zero-filled: every month in range is present, even with no dispatches. */
  months: DispatchMonthBucket[];
  colours: DispatchColourBucket[];
  totals: ReportTotals;
  ratesIncluded: boolean;
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
  totalValue?: number;
}

export interface TopCityRow {
  city: string | null;
  partyCount: number;
  orderCount: number;
  totalValue?: number;
}

export interface TopPartiesReport {
  range: ReportRange;
  parties: TopPartyRow[];
  cities: TopCityRow[];
  orderedBy: 'value' | 'orderCount';
  limit: number;
  ratesIncluded: boolean;
}

export type ReportKind = 'dispatches' | 'lead-outcomes' | 'top-parties';

export const REPORT_KINDS: readonly ReportKind[] = ['dispatches', 'lead-outcomes', 'top-parties'];

export function isReportKind(value: unknown): value is ReportKind {
  return (REPORT_KINDS as readonly unknown[]).includes(value);
}

// --- Export ----------------------------------------------------------------

export type ReportFormat = 'csv' | 'pdf';

export type ReportPaperSize = 'a4' | 'letter';
export type ReportOrientation = 'portrait' | 'landscape';

/**
 * One column of an exported report.
 *
 * `money` is the field that carries the rule. **A redacted money column keeps
 * its header and empties its cells** — it is not dropped and it is never
 * zeroed. Absent-key is the JSON wire rule, where a missing property is the
 * only way to say "not yours"; a table has a fixed shape, so dropping the
 * column would silently change what every other column means by position, and
 * a `0` would be a factual claim that the figure is nothing.
 */
export interface ReportColumn {
  key: string;
  labelToken: MessageKey;
  money?: boolean;
}

export const REPORT_COLUMNS: Record<ReportKind, readonly ReportColumn[]> = {
  dispatches: [
    { key: 'month', labelToken: 'reports.column.month' },
    { key: 'orderCount', labelToken: 'reports.column.orderCount' },
    { key: 'boxCount', labelToken: 'reports.column.boxCount' },
    { key: 'totalValue', labelToken: 'reports.column.totalValue', money: true },
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
    { key: 'totalValue', labelToken: 'reports.column.totalValue', money: true },
  ],
};

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
  /** Append a totals row. Text columns are blank in it; counts and money sum. */
  totals?: boolean;
  paperSize?: ReportPaperSize;
  orientation?: ReportOrientation;
}

export function isReportFormat(value: unknown): value is ReportFormat {
  return value === 'csv' || value === 'pdf';
}
