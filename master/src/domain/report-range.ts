/**
 * The date-safety module for Reports (`docs/backend-modules/04-API-CONTRACT.md`
 * §3.2). Pure: takes `today` as `{year, month, day}` components and never
 * constructs a `Date` or calls `toISOString()` — the structural fix for the
 * shipped defect where a `DATE` column read a day early anywhere east of
 * UTC (`HANDOFF.md`).
 */

import type { ReportPeriod } from '@orderbook/shared';

import { ValidationError } from '../lib/errors.js';

export const MAX_RANGE_MONTHS = 12;

export interface DateComponents {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface ResolvedReportRange {
  period: ReportPeriod;
  /** 'YYYY-MM-DD' */
  fromDate: string;
  /** 'YYYY-MM-DD', exclusive */
  toDateExclusive: string;
  /** Every 'YYYY-MM' bucket in the range, in order. */
  months: string[];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function monthKey(year: number, month: number): string {
  return `${pad(year, 4)}-${pad(month)}`;
}

/** First-of-month date components, `count` months after `(year, month)`. Handles year rollover. */
function addMonths(year: number, month: number, count: number): { year: number; month: number } {
  const zeroBased = (month - 1) + count;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12;
  return { year: y, month: m + 1 };
}

function isoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Every 'YYYY-MM' from `[fromYear,fromMonth]` to `[toYear,toMonth]`, inclusive. */
export function monthLabels(fromYear: number, fromMonth: number, toYear: number, toMonth: number): string[] {
  const labels: string[] = [];
  let y = fromYear;
  let m = fromMonth;
  // Bounded by MAX_RANGE_MONTHS callers already enforce; this loop has no
  // independent cap because it is only ever reached after that validation.
  for (;;) {
    labels.push(monthKey(y, m));
    if (y === toYear && m === toMonth) break;
    const next = addMonths(y, m, 1);
    y = next.year;
    m = next.month;
  }
  return labels;
}

function parseMonth(value: string, field: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new ValidationError('validation.reports.range.invalid', {}, { field });
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new ValidationError('validation.reports.range.invalid', {}, { field });
  return { year, month };
}

/**
 * Resolves a `ReportPeriod` into calendar date strings, half-open
 * `[fromDate, toDateExclusive)`. `today` is read from the caller's own
 * components — this function reads no clock.
 */
export function resolveReportRange(
  input: { period?: ReportPeriod; fromMonth?: string; toMonth?: string },
  today: DateComponents,
): ResolvedReportRange {
  const period = input.period ?? 'last6Months';

  let fromYear: number;
  let fromMonth: number;
  let toYear: number;
  let toMonth: number;

  if (period === 'custom') {
    if (!input.fromMonth) {
      throw new ValidationError('validation.reports.range.fromMonthRequired', {}, { field: 'fromMonth' });
    }
    const from = parseMonth(input.fromMonth, 'fromMonth');
    const to = input.toMonth ? parseMonth(input.toMonth, 'toMonth') : { year: today.year, month: today.month };
    fromYear = from.year;
    fromMonth = from.month;
    toYear = to.year;
    toMonth = to.month;

    if (toYear < fromYear || (toYear === fromYear && toMonth < fromMonth)) {
      throw new ValidationError('validation.reports.range.toBeforeFrom', {}, { field: 'toMonth' });
    }
  } else {
    const span = period === 'thisMonth' ? 0 : period === 'last3Months' ? 2 : period === 'last6Months' ? 5 : 11;
    toYear = today.year;
    toMonth = today.month;
    const from = addMonths(today.year, today.month, -span);
    fromYear = from.year;
    fromMonth = from.month;
  }

  const monthSpan = (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
  if (monthSpan > MAX_RANGE_MONTHS) {
    throw new ValidationError(
      'validation.reports.range.tooWide',
      { maxMonths: MAX_RANGE_MONTHS },
      { field: 'toMonth', maxMonths: MAX_RANGE_MONTHS },
    );
  }

  const months = monthLabels(fromYear, fromMonth, toYear, toMonth);
  const exclusiveEnd = addMonths(toYear, toMonth, 1);

  return {
    period,
    fromDate: isoDate(fromYear, fromMonth, 1),
    toDateExclusive: isoDate(exclusiveEnd.year, exclusiveEnd.month, 1),
    months,
  };
}
