/**
 * The two periods the 1.3 reports added to `resolveReportRange`:
 * `thisFinancialYear` (Indian financial year, 1 April) and `customDates` (an
 * exact inclusive day range). Pure, so it always runs; like the rest of the
 * module, none of it may build a `Date`.
 */

import { describe, expect, it } from 'vitest';

import { MAX_RANGE_DAYS, resolveReportRange } from '../src/domain/report-range.js';
import { ValidationError } from '../src/lib/errors.js';

function refusal(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected a ValidationError');
}

describe('thisFinancialYear', () => {
  it('starts on 1 April of this calendar year from April onwards', () => {
    const range = resolveReportRange({ period: 'thisFinancialYear' }, { year: 2026, month: 10, day: 3 });
    expect(range.fromDate).toBe('2026-04-01');
    expect(range.toDateExclusive).toBe('2026-11-01');
    expect(range.months).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  });

  it('starts last calendar year until March is over, and 1 April itself is the new year', () => {
    const march = resolveReportRange({ period: 'thisFinancialYear' }, { year: 2027, month: 3, day: 31 });
    expect(march.fromDate).toBe('2026-04-01');
    expect(march.months).toHaveLength(12);
    expect(march.months.at(-1)).toBe('2027-03');

    const april = resolveReportRange({ period: 'thisFinancialYear' }, { year: 2027, month: 4, day: 1 });
    expect(april.fromDate).toBe('2027-04-01');
    expect(april.months).toEqual(['2027-04']);
  });
});

describe('customDates', () => {
  const TODAY = { year: 2026, month: 10, day: 3 };

  it('is inclusive of the last day: the exclusive end is the day after', () => {
    const range = resolveReportRange({ period: 'customDates', fromDate: '2026-04-01', toDate: '2026-04-30' }, TODAY);
    expect(range).toMatchObject({ fromDate: '2026-04-01', toDateExclusive: '2026-05-01', months: ['2026-04'] });
  });

  it('runs to today when no end is given', () => {
    const range = resolveReportRange({ period: 'customDates', fromDate: '2026-09-28' }, TODAY);
    expect(range.toDateExclusive).toBe('2026-10-04');
    expect(range.months).toEqual(['2026-09', '2026-10']);
  });

  it('rolls over a month, a year and a leap day by arithmetic', () => {
    expect(resolveReportRange({ period: 'customDates', fromDate: '2026-12-31', toDate: '2026-12-31' }, TODAY).toDateExclusive).toBe('2027-01-01');
    expect(resolveReportRange({ period: 'customDates', fromDate: '2028-02-28', toDate: '2028-02-28' }, TODAY).toDateExclusive).toBe('2028-02-29');
    expect(resolveReportRange({ period: 'customDates', fromDate: '2028-02-29', toDate: '2028-02-29' }, TODAY).toDateExclusive).toBe('2028-03-01');
    expect(resolveReportRange({ period: 'customDates', fromDate: '2100-02-28', toDate: '2100-02-28' }, TODAY).toDateExclusive).toBe('2100-03-01');
  });

  it('lists every month the days touch, across a year boundary', () => {
    const range = resolveReportRange({ period: 'customDates', fromDate: '2026-11-20', toDate: '2027-01-05' }, TODAY);
    expect(range.months).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('allows a year and a day, and refuses one more', () => {
    const widest = resolveReportRange({ period: 'customDates', fromDate: '2027-01-01', toDate: '2027-12-31' }, TODAY);
    expect(widest.toDateExclusive).toBe('2028-01-01');

    const leapYear = resolveReportRange({ period: 'customDates', fromDate: '2028-01-01', toDate: '2028-12-31' }, TODAY);
    expect(leapYear.toDateExclusive).toBe('2029-01-01');

    const tooWide = refusal(() =>
      resolveReportRange({ period: 'customDates', fromDate: '2026-01-01', toDate: '2027-01-02' }, TODAY),
    );
    expect(tooWide.messageKey).toBe('validation.reports.dates.tooWide');
    expect(tooWide.params).toEqual({ maxDays: MAX_RANGE_DAYS });
  });

  it('names the field it refuses: a missing start, a bad date, an end before the start', () => {
    expect(refusal(() => resolveReportRange({ period: 'customDates' }, TODAY))).toMatchObject({
      messageKey: 'validation.reports.dates.fromRequired',
      details: { field: 'fromDate' },
    });
    expect(refusal(() => resolveReportRange({ period: 'customDates', fromDate: '2026-02-30' }, TODAY))).toMatchObject({
      messageKey: 'validation.reports.dates.invalid',
      details: { field: 'fromDate' },
    });
    expect(refusal(() => resolveReportRange({ period: 'customDates', fromDate: '2026-04-01', toDate: '04/30/2026' }, TODAY))).toMatchObject({
      details: { field: 'toDate' },
    });
    expect(refusal(() => resolveReportRange({ period: 'customDates', fromDate: '2026-04-10', toDate: '2026-04-09' }, TODAY))).toMatchObject({
      messageKey: 'validation.reports.range.toBeforeFrom',
      details: { field: 'toDate' },
    });
  });
});
