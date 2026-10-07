/**
 * The report catalogue and the query a person's controls become: fifteen kinds
 * with columns and metadata, and a loose record read into a `ReportQuery` and
 * back into URL parameters.
 */

import { describe, expect, it } from 'vitest';

import {
  EN_MESSAGES,
  LEGACY_REPORT_KINDS,
  REPORT_COLUMNS,
  REPORT_KINDS,
  REPORT_META,
  ROLE_TEMPLATES,
  SUMMABLE_UNITS,
  isReportFormat,
  isReportKind,
  parseReportQuery,
  reportQueryParams,
} from '../src/index.js';

describe('the catalogue', () => {
  it('lists fifteen kinds, the three legacy ones first and each once', () => {
    expect(REPORT_KINDS).toHaveLength(15);
    expect(new Set(REPORT_KINDS).size).toBe(15);
    expect(REPORT_KINDS.slice(0, 3)).toEqual([...LEGACY_REPORT_KINDS]);
    expect(LEGACY_REPORT_KINDS).toEqual(['dispatches', 'lead-outcomes', 'top-parties']);
  });

  it('gives every kind columns, a title and an icon, all in the catalogue', () => {
    for (const kind of REPORT_KINDS) {
      expect(REPORT_COLUMNS[kind].length).toBeGreaterThan(0);
      expect(REPORT_META[kind].icon).toBeTruthy();
      const tokens = [REPORT_META[kind].titleToken, ...REPORT_COLUMNS[kind].map((column) => column.labelToken)];
      for (const token of tokens) {
        expect(Object.keys(EN_MESSAGES), token).toContain(token);
      }
    }
  });

  it('keeps the legacy CSV headers exactly as they always were', () => {
    expect(REPORT_COLUMNS.dispatches.map((column) => column.key)).toEqual(['month', 'orderCount', 'pieces']);
    expect(REPORT_COLUMNS['lead-outcomes'].map((column) => column.key)).toEqual([
      'month',
      'converted',
      'lost',
      'quiet',
      'open',
    ]);
    expect(REPORT_COLUMNS['top-parties'].map((column) => column.key)).toEqual([
      'partyId',
      'partyName',
      'partyCode',
      'city',
      'orderCount',
    ]);
  });

  it('carries no money: no title or column is about an amount', () => {
    const words = REPORT_KINDS.flatMap((kind) => [
      EN_MESSAGES[REPORT_META[kind].titleToken],
      ...REPORT_COLUMNS[kind].map((column) => EN_MESSAGES[column.labelToken]),
    ]).join(' ');
    expect(words).not.toMatch(/amount|\brate\b|price|revenue|total value|rupee/i);
  });

  it('declares a unit on every new column, and only count-like units sum', () => {
    for (const kind of REPORT_KINDS.filter((candidate) => !LEGACY_REPORT_KINDS.includes(candidate))) {
      for (const column of REPORT_COLUMNS[kind]) expect(column.unit, `${kind}.${column.key}`).toBeDefined();
    }
    expect(SUMMABLE_UNITS).toEqual(['count', 'pieces', 'kg']);
  });

  it('knows its kinds and formats', () => {
    expect(isReportKind('by-user')).toBe(true);
    expect(isReportKind('revenue')).toBe(false);
    expect(['csv', 'xlsx', 'pdf'].every(isReportFormat)).toBe(true);
    expect(isReportFormat('docx')).toBe(false);
  });
});

describe('parseReportQuery', () => {
  it('reads strings, trims them and drops what it does not understand', () => {
    expect(
      parseReportQuery({
        period: 'thisFinancialYear',
        fromMonth: ' 2026-04 ',
        toDate: '',
        subjectId: 'US0000000007',
        limit: '25',
        bogus: 'x',
      }),
    ).toEqual({
      period: 'thisFinancialYear',
      fromMonth: '2026-04',
      toMonth: undefined,
      fromDate: undefined,
      toDate: undefined,
      subjectId: 'US0000000007',
      limit: 25,
    });
  });

  it('drops an unknown period rather than guessing a span, and a limit that is not a number', () => {
    const query = parseReportQuery({ period: 'forever', limit: 'many' });
    expect(query.period).toBeUndefined();
    expect(query.limit).toBeUndefined();
  });

  it('survives values that are not strings', () => {
    expect(parseReportQuery({ period: ['thisMonth'], fromMonth: 5, subjectId: {} })).toMatchObject({
      period: undefined,
      fromMonth: undefined,
      subjectId: undefined,
    });
  });
});

describe('what a reader sees', () => {
  it('never heads two columns of one report with the same words', () => {
    for (const kind of REPORT_KINDS) {
      const heads = REPORT_COLUMNS[kind].map((column) => EN_MESSAGES[column.labelToken]);
      expect(new Set(heads).size, `${kind}: ${heads.join(' | ')}`).toBe(heads.length);
    }
    // Lead sources has a count of converted leads and a rate; the rate says so.
    expect(EN_MESSAGES['reports.column.conversion']).toBe('Conversion %');
  });

  it('puts the report keys on the Dispatch role, which the owner expects to run reports', () => {
    const dispatch = ROLE_TEMPLATES.find((template) => template.nameToken === 'roleTemplate.dispatch');
    expect(dispatch?.permissions).toEqual(expect.arrayContaining(['reports.view', 'reports.export']));
  });
});

describe('reportQueryParams', () => {
  it('writes only what is set, so the default URL stays empty', () => {
    expect(reportQueryParams({}).toString()).toBe('');
    expect(
      reportQueryParams({
        period: 'customDates',
        fromDate: '2026-04-01',
        toDate: '2026-04-30',
        subjectId: 'U1',
        limit: 10,
      }).toString(),
    ).toBe('period=customDates&fromDate=2026-04-01&toDate=2026-04-30&subjectId=U1&limit=10');
  });

  it('round-trips through parseReportQuery', () => {
    const query = { period: 'custom' as const, fromMonth: '2026-01', toMonth: '2026-03', subjectId: 'U1' };
    const params = Object.fromEntries(reportQueryParams(query));
    expect(parseReportQuery(params)).toMatchObject(query);
  });
});
