/**
 * Reports' wire types (`docs/backend-modules/04-API-CONTRACT.md` §3). Every
 * money field is declared optional so redaction can *delete* the key rather
 * than nulling it — the same absent-not-zero rule the wire contract uses
 * everywhere else.
 */

import type { IsoDate, RecordId } from './entities.js';

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
