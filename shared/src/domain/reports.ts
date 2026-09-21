/**
 * Reports' wire types (`docs/backend-modules/04-API-CONTRACT.md` §3): counts
 * of orders, pieces and parties. The software carries no amounts.
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

export type ReportKind = 'dispatches' | 'lead-outcomes' | 'top-parties';

export const REPORT_KINDS: readonly ReportKind[] = ['dispatches', 'lead-outcomes', 'top-parties'];

export function isReportKind(value: unknown): value is ReportKind {
  return (REPORT_KINDS as readonly unknown[]).includes(value);
}

// --- Export ----------------------------------------------------------------

export type ReportFormat = 'csv' | 'pdf';

export type ReportPaperSize = 'a4' | 'letter';
export type ReportOrientation = 'portrait' | 'landscape';

/** One column of an exported report. */
export interface ReportColumn {
  key: string;
  labelToken: MessageKey;
}

export const REPORT_COLUMNS: Record<ReportKind, readonly ReportColumn[]> = {
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
  /** Append a totals row. Text columns are blank in it; counts sum. */
  totals?: boolean;
  paperSize?: ReportPaperSize;
  orientation?: ReportOrientation;
}

export function isReportFormat(value: unknown): value is ReportFormat {
  return value === 'csv' || value === 'pdf';
}
