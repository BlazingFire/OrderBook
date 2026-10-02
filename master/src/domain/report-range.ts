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

/** An exact-dates range (`customDates`) may span a year and a day, so a leap year fits. */
export const MAX_RANGE_DAYS = 366;

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

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The day after, by arithmetic: no `Date`, so no time zone can move it. */
function nextDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1 };
  const next = addMonths(year, month, 1);
  return { year: next.year, month: next.month, day: 1 };
}

/** Days since a fixed epoch (the civil-calendar day number), so two dates subtract. */
function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
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

function parseDate(value: string, field: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ValidationError('validation.reports.dates.invalid', {}, { field });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ValidationError('validation.reports.dates.invalid', {}, { field });
  }
  return { year, month, day };
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
  input: { period?: ReportPeriod; fromMonth?: string; toMonth?: string; fromDate?: string; toDate?: string },
  today: DateComponents,
): ResolvedReportRange {
  const period = input.period ?? 'last6Months';

  if (period === 'customDates') return resolveExactDates(input, today);

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
  } else if (period === 'thisFinancialYear') {
    // The Indian financial year starts on 1 April: before April the year in
    // progress began last calendar year.
    toYear = today.year;
    toMonth = today.month;
    fromYear = today.month >= 4 ? today.year : today.year - 1;
    fromMonth = 4;
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

/**
 * `customDates`: `fromDate` to `toDate` **inclusive** (today when `toDate` is
 * omitted), as the half-open `[fromDate, day after toDate)` every query uses.
 * The month buckets are every month the days touch.
 */
function resolveExactDates(
  input: { fromDate?: string; toDate?: string },
  today: DateComponents,
): ResolvedReportRange {
  if (!input.fromDate) {
    throw new ValidationError('validation.reports.dates.fromRequired', {}, { field: 'fromDate' });
  }
  const from = parseDate(input.fromDate, 'fromDate');
  const to = input.toDate ? parseDate(input.toDate, 'toDate') : today;

  const days = dayNumber(to.year, to.month, to.day) - dayNumber(from.year, from.month, from.day) + 1;
  if (days < 1) throw new ValidationError('validation.reports.range.toBeforeFrom', {}, { field: 'toDate' });
  if (days > MAX_RANGE_DAYS) {
    throw new ValidationError(
      'validation.reports.dates.tooWide',
      { maxDays: MAX_RANGE_DAYS },
      { field: 'toDate', maxDays: MAX_RANGE_DAYS },
    );
  }

  const after = nextDay(to.year, to.month, to.day);
  return {
    period: 'customDates',
    fromDate: isoDate(from.year, from.month, from.day),
    toDateExclusive: isoDate(after.year, after.month, after.day),
    months: monthLabels(from.year, from.month, to.year, to.month),
  };
}
