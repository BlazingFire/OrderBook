/**
 * The shell's one exception to "nothing opens a window": a lead's or a report's
 * PDF (`docs/catalogue/CATALOGUE_MODEL.md` §8). That window gets the PDF viewer,
 * so the rule must stay exactly these paths on exactly this panel.
 */

import { REPORT_KINDS } from '@orderbook/shared';
import { describe, expect, it } from 'vitest';

import { isPdfWindowUrl, PDF_QUERY_KEYS, PDF_REPORT_KINDS } from '../lib/lead-pdf.js';

const ORIGIN = 'http://localhost:4100';

describe('which URL may open a PDF window', () => {
  it("allows a lead's PDF on this panel", () => {
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/leads/L-0001/pdf`)).toBe(true);
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/leads/L-TMP%201/pdf`)).toBe(true);
  });

  it("allows a final order's PDF, bare or with no query", () => {
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/orders/O-1/pdf`)).toBe(true);
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/orders/OD0000000002/pdf`)).toBe(true);
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/orders/O-1/pdf?x=1`)).toBe(false);
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/orders/a/b/pdf`)).toBe(false);
  });

  it('allows a report PDF, bare or with allowlisted keys', () => {
    expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/reports/dispatches/pdf`)).toBe(true);
    expect(
      isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/reports/top-parties/pdf?period=month&columns=a,b&fromDate=2026-04-01`),
    ).toBe(true);
    expect(
      isPdfWindowUrl(
        ORIGIN,
        `${ORIGIN}/api/reports/by-user/pdf?period=customDates&fromDate=2026-04-01&toDate=2026-06-30&subjectId=u-1&columns=party%2Cqty&totals=true&paperSize=letter&orientation=portrait&limit=20`,
      ),
    ).toBe(true);
  });

  it('knows every report kind, and no other', () => {
    expect([...PDF_REPORT_KINDS]).toEqual([...REPORT_KINDS]);
    expect(PDF_REPORT_KINDS).toHaveLength(15);
    for (const kind of REPORT_KINDS) {
      expect(isPdfWindowUrl(ORIGIN, `${ORIGIN}/api/reports/${kind}/pdf`)).toBe(true);
    }
  });

  it.each([
    ['another panel', 'http://localhost:4101/api/leads/L-1/pdf'],
    ['a look-alike host', 'http://localhost:4100.evil/api/leads/L-1/pdf'],
    ['a look-alike host on a report', 'http://localhost:4100.evil/api/reports/dispatches/pdf'],
    ['a query on a lead PDF', `${ORIGIN}/api/leads/L-1/pdf?x=1`],
    ['an empty query on a lead PDF', `${ORIGIN}/api/leads/L-1/pdf?`],
    ['a fragment', `${ORIGIN}/api/leads/L-1/pdf#page=2`],
    ['a longer path', `${ORIGIN}/api/leads/L-1/pdf/more`],
    ['a nested id', `${ORIGIN}/api/leads/a/b/pdf`],
    ['no id', `${ORIGIN}/api/leads//pdf`],
    ['the panel itself', `${ORIGIN}/`],
    ['the export route with format=pdf', `${ORIGIN}/api/reports/dispatches/export?format=pdf`],
    ['a report fragment', `${ORIGIN}/api/reports/dispatches/pdf#page=2`],
    ['a fragment after a query', `${ORIGIN}/api/reports/dispatches/pdf?period=month#x`],
    ['an unknown report', `${ORIGIN}/api/reports/x/pdf`],
    ['a report id with an underscore', `${ORIGIN}/api/reports/X_Y/pdf`],
    ['a nested report path', `${ORIGIN}/api/reports/a/b/pdf`],
    ['a prefix of a kind', `${ORIGIN}/api/reports/by/pdf`],
    ['a path under a kind', `${ORIGIN}/api/reports/dispatches/pdf/x`],
    ['the table route', `${ORIGIN}/api/reports/table/dispatches`],
    ['an unknown key', `${ORIGIN}/api/reports/dispatches/pdf?a=1`],
    ['the old range key', `${ORIGIN}/api/reports/top-parties/pdf?from=2026-04-01`],
    ['the format key', `${ORIGIN}/api/reports/dispatches/pdf?format=csv`],
    ['a script in a value', `${ORIGIN}/api/reports/dispatches/pdf?columns=<script>`],
    ['an encoded script', `${ORIGIN}/api/reports/dispatches/pdf?columns=%3Cscript%3E`],
    ['a repeated key', `${ORIGIN}/api/reports/dispatches/pdf?period=month&period=week`],
    ['an encoded slash in a value', `${ORIGIN}/api/reports/dispatches/pdf?subjectId=..%2F..`],
    ['an unknown key beside a good one', `${ORIGIN}/api/reports/dispatches/pdf?period=month&x=1`],
    ['an encoded path', `${ORIGIN}/api/reports/dispatches%2Fpdf`],
  ])('refuses %s', (_, url) => {
    expect(isPdfWindowUrl(ORIGIN, url)).toBe(false);
  });

  it('keeps the query allowlist to the keys a report PDF is asked with', () => {
    expect([...PDF_QUERY_KEYS].sort()).toEqual(
      [
        'columns', 'fromDate', 'fromMonth', 'limit', 'orientation', 'paperSize',
        'period', 'subjectId', 'toDate', 'toMonth', 'totals',
      ].sort(),
    );
  });
});
