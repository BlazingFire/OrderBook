/**
 * `report-range.ts` and `lead-outcome.ts`'s pure halves —
 * `docs/backend-modules/10-TESTING.md` §6.6 (`RPT-1`…`RPT-4`, `RPT-11`'s
 * pure classifier). Deliberately database-free: this is the module that
 * exists precisely so a month boundary is never computed by constructing a
 * `Date`.
 */

import { describe, expect, it } from 'vitest';

import { MAX_RANGE_MONTHS, monthLabels, resolveReportRange } from '../src/domain/report-range.js';
import { classifyLeadOutcome, daysBetween, QUIET_AFTER_DAYS } from '../src/domain/lead-outcome.js';
import { ValidationError } from '../src/lib/errors.js';

const TODAY = { year: 2026, month: 3, day: 15 };

describe('resolveReportRange', () => {
  it('RPT-1: resolves "thisMonth" from components, half-open on the current month', () => {
    const range = resolveReportRange({ period: 'thisMonth' }, TODAY);
    expect(range.fromDate).toBe('2026-03-01');
    expect(range.toDateExclusive).toBe('2026-04-01');
    expect(range.months).toEqual(['2026-03']);
  });

  it('RPT-2: the range is half-open — the first of the next month is excluded', () => {
    const range = resolveReportRange({ period: 'last3Months' }, TODAY);
    // last3Months from March 2026 covers Jan, Feb, Mar — April 1st is the
    // exclusive upper boundary, never included as a bucket.
    expect(range.toDateExclusive).toBe('2026-04-01');
    expect(range.months).not.toContain('2026-04');
  });

  it('RPT-3: every month in the range is listed, including one crossing a year boundary', () => {
    const range = resolveReportRange({ period: 'last12Months' }, TODAY);
    expect(range.months).toHaveLength(12);
    expect(range.months[0]).toBe('2025-04');
    expect(range.months.at(-1)).toBe('2026-03');
  });

  it('RPT-4: a custom range longer than MAX_RANGE_MONTHS is refused', () => {
    expect(() =>
      resolveReportRange({ period: 'custom', fromMonth: '2025-01', toMonth: '2026-03' }, TODAY),
    ).toThrow(ValidationError);
  });

  it('accepts a custom range exactly at the cap', () => {
    const range = resolveReportRange({ period: 'custom', fromMonth: '2025-04', toMonth: '2026-03' }, TODAY);
    expect(range.months).toHaveLength(MAX_RANGE_MONTHS);
  });

  it('refuses a custom range with no fromMonth', () => {
    expect(() => resolveReportRange({ period: 'custom' }, TODAY)).toThrow(ValidationError);
  });

  it('refuses toMonth before fromMonth', () => {
    expect(() =>
      resolveReportRange({ period: 'custom', fromMonth: '2026-03', toMonth: '2026-01' }, TODAY),
    ).toThrow(ValidationError);
  });

  it('rejects a malformed month string', () => {
    expect(() => resolveReportRange({ period: 'custom', fromMonth: 'not-a-month' }, TODAY)).toThrow(
      ValidationError,
    );
  });
});

describe('monthLabels', () => {
  it('lists a single month when from equals to', () => {
    expect(monthLabels(2026, 3, 2026, 3)).toEqual(['2026-03']);
  });

  it('crosses a year boundary correctly', () => {
    expect(monthLabels(2025, 11, 2026, 2)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('daysBetween — pure calendar arithmetic, no Date', () => {
  it('counts zero for the same day', () => {
    expect(daysBetween({ year: 2026, month: 3, day: 15 }, { year: 2026, month: 3, day: 15 })).toBe(0);
  });

  it('crosses a month boundary correctly', () => {
    expect(daysBetween({ year: 2026, month: 2, day: 28 }, { year: 2026, month: 3, day: 1 })).toBe(1);
  });

  it('crosses a leap-year February correctly (2028 is a leap year)', () => {
    expect(daysBetween({ year: 2028, month: 2, day: 28 }, { year: 2028, month: 3, day: 1 })).toBe(2);
  });
});

describe('classifyLeadOutcome', () => {
  const asOf = { year: 2026, month: 3, day: 15 };

  it('a converted_order_id wins outright, even in a non-terminal stage', () => {
    expect(
      classifyLeadOutcome({ convertedOrderId: 'OR1', isTerminal: false, lastActivityAt: asOf }, asOf),
    ).toBe('converted');
  });

  it('RPT-10: a terminal, unconverted lead is lost — never by stage name, only by is_terminal', () => {
    expect(
      classifyLeadOutcome({ convertedOrderId: null, isTerminal: true, lastActivityAt: asOf }, asOf),
    ).toBe('lost');
  });

  it('a lead "in Won" without converted_order_id is still lost, not converted', () => {
    // The classifier has no concept of a stage name at all — `isTerminal`
    // is the only fact it reads, which is exactly what makes this true.
    expect(
      classifyLeadOutcome({ convertedOrderId: null, isTerminal: true, lastActivityAt: asOf }, asOf),
    ).not.toBe('converted');
  });

  it('RPT-11: agrees at the QUIET_AFTER_DAYS boundary — one day short is open, exactly at it is quiet', () => {
    const justShort = { year: 2026, month: 2, day: 15 }; // 28 days before asOf
    const exactly = { year: 2026, month: 2, day: 13 }; // 30 days before asOf

    expect(
      classifyLeadOutcome({ convertedOrderId: null, isTerminal: false, lastActivityAt: justShort }, asOf),
    ).toBe('open');
    expect(
      classifyLeadOutcome({ convertedOrderId: null, isTerminal: false, lastActivityAt: exactly }, asOf),
    ).toBe('quiet');
    expect(daysBetween(exactly, asOf)).toBe(QUIET_AFTER_DAYS);
  });

  it('an untouched, non-terminal lead within the window is open', () => {
    expect(
      classifyLeadOutcome({ convertedOrderId: null, isTerminal: false, lastActivityAt: asOf }, asOf),
    ).toBe('open');
  });

  it("moves the boundary with the company's own number, not this module's default", () => {
    // `leads.quietAfterDays` is a company setting now, and this classifier is
    // the JS half of a rule whose other half is SQL. A 30 left hardcoded in
    // here would go unnoticed: this half has no production caller, so nothing
    // but a test at a threshold that is *not* 30 can see it.
    const quiet = { convertedOrderId: null, isTerminal: false, lastActivityAt: asOf };
    const sevenDaysBefore = { year: 2026, month: 3, day: 8 };
    const facts = { ...quiet, lastActivityAt: sevenDaysBefore };

    expect(daysBetween(sevenDaysBefore, asOf)).toBe(7);
    expect(classifyLeadOutcome(facts, asOf, 7)).toBe('quiet');
    expect(classifyLeadOutcome(facts, asOf, 8)).toBe('open');

    // And the default still applies when nothing is passed, so an installation
    // that has never set the key keeps the documented 30.
    expect(classifyLeadOutcome(facts, asOf)).toBe('open');
  });

  it('a threshold of zero makes every open lead quiet, rather than reading as unset', () => {
    // 0 is outside what the setting accepts (its floor is 1), but the
    // classifier takes a plain number and a caller passing 0 must get the
    // arithmetic, not a silent fall back to 30.
    expect(
      classifyLeadOutcome(
        { convertedOrderId: null, isTerminal: false, lastActivityAt: asOf },
        asOf,
        0,
      ),
    ).toBe('quiet');
  });
});
