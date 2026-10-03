/**
 * The shared Reports screen over a fake `ReportsTransport`, the way both panels
 * mount it: one table for every kind, the controls only for those who may use
 * them, a refused range kept beside the last good report, a request aborted
 * when the controls change under it, and files that carry what is on screen.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportKind, ReportOptions, ReportQuery, ReportTable } from '@orderbook/shared';
import { REPORT_COLUMNS, REPORT_KINDS } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { ReportsScreen, type ReportsTransport } from '../src/ReportsScreen.js';
import { ToastProvider } from '../src/Toast.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RANGE = { period: 'last6Months' as const, fromDate: '2026-05-01', toDateExclusive: '2026-11-01', months: ['2026-05', '2026-10'], timeZone: 'Asia/Kolkata' };

function tableFor(kind: ReportKind, overrides: Partial<ReportTable> = {}): ReportTable {
  return {
    kind,
    range: RANGE,
    subject: { id: null, name: null },
    columns: REPORT_COLUMNS[kind].map((column) => ({ ...column, unit: column.unit ?? 'text' })),
    rows: [],
    totals: null,
    rowCount: 0,
    truncated: false,
    sections: [],
    ...overrides,
  };
}

const CITY_TABLE = tableFor('by-city', {
  rows: [
    { city: 'Morbi', parties: 2, orders: 5, pieces: 1200, kg: 3000.5 },
    { city: 'Rajkot', parties: 1, orders: 2, pieces: 400, kg: 1000 },
  ],
  totals: { parties: 3, orders: 7, pieces: 1600, kg: 4000.5 },
  rowCount: 2,
});

const ADMIN_OPTIONS: ReportOptions = {
  kinds: [...REPORT_KINDS],
  subjects: [
    { id: 'US1', name: 'alice' },
    { id: 'US2', name: 'zzbob' },
  ],
  canExport: true,
};

const OFFICE_OPTIONS: ReportOptions = { kinds: [...REPORT_KINDS], subjects: null, canExport: false };

function makeTransport(overrides: Partial<ReportsTransport> = {}): ReportsTransport {
  return {
    options: vi.fn(async () => ADMIN_OPTIONS),
    table: vi.fn(async (kind: ReportKind) => (kind === 'by-city' ? CITY_TABLE : tableFor(kind))),
    exportFile: vi.fn(async (_kind, query) => ({ blob: new Blob(['x']), fileName: `report.${query.format}` })),
    ...overrides,
  };
}

function mount(transport: ReportsTransport, props: Partial<{ kind: ReportKind; onKindChange: (kind: ReportKind) => void; revision: number | string; online: boolean }> = {}) {
  return render(
    <ToastProvider>
      <ReportsScreen transport={transport} kind="by-city" onKindChange={() => undefined} revision={0} {...props} />
    </ToastProvider>,
  );
}

/** The kit's Select is a combobox: focusing it opens the list, and an option is chosen on mouse-down. */
function combo(name: string | RegExp): HTMLElement {
  return screen.getByRole('combobox', { name });
}

function optionsOf(box: HTMLElement): string[] {
  fireEvent.focus(box);
  const labels = screen.getAllByRole('option').map((option) => option.textContent ?? '');
  fireEvent.blur(box);
  return labels;
}

function pick(box: HTMLElement, label: string): void {
  fireEvent.focus(box);
  fireEvent.mouseDown(screen.getByRole('option', { name: label }));
}

const lastQuery = (transport: ReportsTransport): ReportQuery => {
  const calls = vi.mocked(transport.table).mock.calls;
  return calls[calls.length - 1]![1];
};

describe('the table', () => {
  it('draws the columns, the rows and a tile for every column that sums', async () => {
    mount(makeTransport());

    expect(await screen.findByText('Morbi')).toBeTruthy();
    for (const key of ['reports.column.city', 'reports.column.parties', 'reports.column.orders', 'reports.column.pieces', 'reports.column.kg'] as const) {
      expect(screen.getAllByText(t(key)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Rajkot')).toBeTruthy();
    // The tiles carry the totals over every row; the text columns have none.
    expect(screen.getByText('4,000.5')).toBeTruthy();
    expect(screen.getByText('1,600')).toBeTruthy();
    expect(screen.getByText(t('reports.range.caption', { from: '2026-05', to: '2026-10', zone: 'Asia/Kolkata' }))).toBeTruthy();
  });

  it('captions an exact-dates range with the exact first and last day, not with month labels', async () => {
    const february = tableFor('by-city', {
      range: { period: 'customDates', fromDate: '2026-02-01', toDateExclusive: '2026-03-01', months: ['2026-02'], timeZone: 'Asia/Kolkata' },
      rows: [{ city: 'Morbi', parties: 1, orders: 1, pieces: 1, kg: 1 }],
      rowCount: 1,
    });
    mount(makeTransport({ table: vi.fn(async () => february) }));
    expect(await screen.findByText(t('reports.range.caption', { from: '2026-02-01', to: '2026-02-28', zone: 'Asia/Kolkata' }))).toBeTruthy();
    cleanup();

    // Across a year boundary the inclusive end is the day before the stored exclusive one.
    const newYear = tableFor('by-city', {
      range: { period: 'customDates', fromDate: '2025-12-15', toDateExclusive: '2026-01-01', months: ['2025-12'], timeZone: 'Asia/Kolkata' },
      rows: [{ city: 'Morbi', parties: 1, orders: 1, pieces: 1, kg: 1 }],
      rowCount: 1,
    });
    mount(makeTransport({ table: vi.fn(async () => newYear) }));
    expect(await screen.findByText(t('reports.range.caption', { from: '2025-12-15', to: '2025-12-31', zone: 'Asia/Kolkata' }))).toBeTruthy();
  });

  it('shows a dash for an empty cell and says when nothing happened', async () => {
    const empty = tableFor('by-party', { rows: [] });
    mount(makeTransport({ table: vi.fn(async () => empty) }), { kind: 'by-party' });
    expect(await screen.findByText(t('reports.empty.title'))).toBeTruthy();
  });

  it('says a snapshot report ignores the range, and a truncated one how much it shows', async () => {
    const snapshot = tableFor('stage-ageing', { rows: [{ stage: 'New', open: 2, avgDays: 3, oldestDays: 9 }], rowCount: 1 });
    mount(makeTransport({ table: vi.fn(async () => snapshot) }), { kind: 'stage-ageing' });
    expect(await screen.findByText(t('reports.snapshotNote'))).toBeTruthy();
    cleanup();

    const cut = tableFor('by-party', {
      rows: [{ partyCode: 'P-0001', partyName: 'Shah', city: 'Morbi', leads: 1, orders: 1, pieces: 1, kg: 1, lastOrder: '2026-10-01', daysSince: 2 }],
      rowCount: 5000,
      truncated: true,
    });
    mount(makeTransport({ table: vi.fn(async () => cut) }), { kind: 'by-party' });
    expect(await screen.findByText(t('reports.truncated', { shown: 1, total: 5000 }))).toBeTruthy();
  });

  it('draws the extra sections a legacy report carries, and the quiet threshold the server applied', async () => {
    const dispatches = tableFor('dispatches', {
      rows: [{ month: '2026-10', orderCount: 3, boxCount: 40 }],
      totals: { orderCount: 3, boxCount: 40 },
      rowCount: 1,
      sections: [
        {
          titleToken: 'reports.dispatches.byColour',
          columns: [
            { key: 'colour', labelToken: 'reports.column.colour', unit: 'text' },
            { key: 'boxCount', labelToken: 'reports.column.boxCount', unit: 'count' },
          ],
          rows: [{ colour: 'White', boxCount: 40 }],
        },
      ],
    });
    mount(makeTransport({ table: vi.fn(async () => dispatches) }), { kind: 'dispatches' });
    expect(await screen.findByText(t('reports.dispatches.byColour'))).toBeTruthy();
    expect(screen.getByText('White')).toBeTruthy();
    cleanup();

    const outcomes = tableFor('lead-outcomes', { rows: [{ month: '2026-10', converted: 1, lost: 0, quiet: 0, open: 2 }], rowCount: 1, quietAfterDays: 7 });
    mount(makeTransport({ table: vi.fn(async () => outcomes) }), { kind: 'lead-outcomes' });
    expect(await screen.findByText(t('reports.leadOutcomes.quietNote', { days: 7 }))).toBeTruthy();
  });

  it('filters the rows on screen from a search box the keyboard shortcut can find', async () => {
    mount(makeTransport());
    await screen.findByText('Morbi');

    const search = document.querySelector('input[data-screen-search]') as HTMLInputElement;
    expect(search).not.toBeNull();
    fireEvent.change(search, { target: { value: 'raj' } });

    expect(screen.queryByText('Morbi')).toBeNull();
    expect(screen.getByText('Rajkot')).toBeTruthy();
  });
});

describe('the controls', () => {
  it('offers the subject picker to somebody who may ask about others, and not to anybody else', async () => {
    const admin = makeTransport();
    mount(admin);
    await screen.findByText('Morbi');
    await screen.findByRole('combobox', { name: t('reports.subject.label') });
    expect(optionsOf(combo(t('reports.subject.label')))).toEqual([t('reports.subject.everyone'), 'alice', 'zzbob']);
    cleanup();

    mount(makeTransport({ options: vi.fn(async () => OFFICE_OPTIONS) }));
    await screen.findByText('Morbi');
    expect(screen.queryByRole('combobox', { name: t('reports.subject.label') })).toBeNull();
  });

  it('asks about the person chosen, and about nobody in particular by default', async () => {
    const transport = makeTransport();
    mount(transport);
    await screen.findByText('Morbi');
    expect(lastQuery(transport)).toMatchObject({ period: 'last6Months', subjectId: undefined });

    await screen.findByRole('combobox', { name: t('reports.subject.label') });
    pick(combo(t('reports.subject.label')), 'zzbob');
    await waitFor(() => expect(lastQuery(transport)).toMatchObject({ subjectId: 'US2' }));
  });

  it('asks only for what applies to the chosen period', async () => {
    const transport = makeTransport();
    mount(transport);
    await screen.findByText('Morbi');

    // Exact dates: two day boxes, and a query that carries them.
    pick(combo(t('reports.range.period')), t('reports.period.customDates'));
    fireEvent.change(await screen.findByLabelText(new RegExp(t('reports.range.fromDate'))), { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByLabelText(new RegExp(t('reports.range.toDate'))), { target: { value: '2026-04-30' } });
    await waitFor(() => expect(lastQuery(transport)).toMatchObject({ period: 'customDates', fromDate: '2026-04-01', toDate: '2026-04-30' }));
    expect(lastQuery(transport).fromMonth).toBeUndefined();

    // Back to a named period: the day boxes go, and so do their values from the query.
    pick(combo(t('reports.range.period')), t('reports.period.thisFinancialYear'));
    await waitFor(() => expect(lastQuery(transport)).toMatchObject({ period: 'thisFinancialYear' }));
    expect(lastQuery(transport).fromDate).toBeUndefined();
    expect(screen.queryByLabelText(new RegExp(t('reports.range.fromDate')))).toBeNull();
  });

  it('lists the kinds on offer in the picker and tells the shell which one was chosen', async () => {
    const onKindChange = vi.fn();
    mount(makeTransport(), { onKindChange });
    await screen.findByText('Morbi');

    const picker = combo(t('reports.title'));
    expect(optionsOf(picker)).toHaveLength(15);
    pick(picker, t('reports.kind.byUser'));
    expect(onKindChange).toHaveBeenCalledWith('by-user');
  });

  it('asks again when the live data changes, and not otherwise', async () => {
    const transport = makeTransport();
    const { rerender } = mount(transport);
    await screen.findByText('Morbi');
    const before = vi.mocked(transport.table).mock.calls.length;

    rerender(
      <ToastProvider>
        <ReportsScreen transport={transport} kind="by-city" onKindChange={() => undefined} revision={1} />
      </ToastProvider>,
    );
    await waitFor(() => expect(vi.mocked(transport.table).mock.calls.length).toBe(before + 1));

    rerender(
      <ToastProvider>
        <ReportsScreen transport={transport} kind="by-city" onKindChange={() => undefined} revision={1} />
      </ToastProvider>,
    );
    expect(vi.mocked(transport.table).mock.calls.length).toBe(before + 1);
  });
});

describe('a request the controls have moved on from', () => {
  it('is aborted, and its late answer never lands over the new one', async () => {
    const signals: AbortSignal[] = [];
    const resolvers = new Map<string, (table: ReportTable) => void>();
    const transport = makeTransport({
      table: vi.fn((kind: ReportKind, _query, signal) => {
        signals.push(signal as AbortSignal);
        return new Promise<ReportTable>((resolve) => resolvers.set(kind, resolve));
      }),
    });
    const { rerender } = mount(transport, { kind: 'by-city' });
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender(
      <ToastProvider>
        <ReportsScreen transport={transport} kind="by-brand" onKindChange={() => undefined} revision={0} />
      </ToastProvider>,
    );
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    // The old question's answer arrives last, and must not be drawn.
    resolvers.get('by-brand')!(tableFor('by-brand', { rows: [{ brand: 'Swisware+', orders: 1, pieces: 1, kg: 1 }], rowCount: 1 }));
    expect(await screen.findByText('Swisware+')).toBeTruthy();
    resolvers.get('by-city')!(CITY_TABLE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Morbi')).toBeNull();
  });
});

describe('a refusal', () => {
  it('names the field it refused, keeps the last good report on screen and offers no file for the refused range', async () => {
    const refused = Object.assign(new Error('Enter valid dates'), {
      code: 'validation_error',
      messageKey: 'validation.reports.dates.invalid',
      details: { field: 'fromDate' },
    });
    const table = vi.fn(async (_kind: ReportKind, query: ReportQuery) => {
      if (query.period === 'customDates') throw refused;
      return CITY_TABLE;
    });
    mount(makeTransport({ table }));
    await screen.findByText('Morbi');
    expect(screen.getAllByRole('button', { name: /CSV|Excel|PDF/ })).toHaveLength(3);

    pick(combo(t('reports.range.period')), t('reports.period.customDates'));
    expect(await screen.findByText(t('validation.reports.dates.invalid'))).toBeTruthy();
    // The previous report is still true and still labelled with its own range.
    expect(screen.getByText('Morbi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('reports.export.xlsx') })).toBeNull();
  });

  it('says why when the company has switched Reports off', async () => {
    const hidden = Object.assign(new Error('Reports are switched off'), {
      code: 'forbidden',
      messageKey: 'error.forbidden.reportsHidden',
    });
    mount(makeTransport({ table: vi.fn(async () => { throw hidden; }) }));
    expect(await screen.findByText(t('reports.hidden.title'))).toBeTruthy();
    expect(screen.getByText(t('reports.hidden.description'))).toBeTruthy();
  });

  it('says Reports need the Master when the Office cannot reach it, for the table and for a file', async () => {
    const unreachable = Object.assign(new Error('The Master Panel is not reachable'), {
      code: 'unavailable',
      messageKey: 'error.unavailable',
    });
    mount(makeTransport({ table: vi.fn(async () => { throw unreachable; }) }));
    expect(await screen.findByText(t('reports.offline'))).toBeTruthy();
    cleanup();

    mount(makeTransport({ exportFile: vi.fn(async () => { throw unreachable; }) }));
    await screen.findByText('Morbi');
    fireEvent.click(screen.getByRole('button', { name: t('reports.export.csv') }));
    expect(await screen.findByText(t('reports.offline'))).toBeTruthy();
  });

  it('offers a retry for a failure that is not about a field', async () => {
    const table = vi.fn<ReportsTransport['table']>().mockRejectedValueOnce(new Error('The Master Panel is not reachable')).mockResolvedValue(CITY_TABLE);
    mount(makeTransport({ table }));

    fireEvent.click(await screen.findByRole('button', { name: t('action.retryNow') }));
    expect(await screen.findByText('Morbi')).toBeTruthy();
  });
});

describe('files', () => {
  it('offers CSV, Excel and PDF only to somebody who may export', async () => {
    mount(makeTransport());
    await screen.findByText('Morbi');
    expect(screen.getByRole('button', { name: t('reports.export.csv') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('reports.export.xlsx') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('reports.export.pdf') })).toBeTruthy();
    cleanup();

    mount(makeTransport({ options: vi.fn(async () => OFFICE_OPTIONS) }));
    await screen.findByText('Morbi');
    expect(screen.queryByRole('button', { name: t('reports.export.xlsx') })).toBeNull();
  });

  it('previews the PDF in a window of its own, for the range the controls describe, and only to somebody who may export', async () => {
    mount(makeTransport());
    await screen.findByText('Morbi');
    const link = screen.getByRole('link', { name: t('reports.previewPdf') });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.getAttribute('href')).toBe(`/api/reports/by-city/pdf?period=last6Months`);

    pick(combo(t('reports.range.period')), t('reports.period.thisMonth'));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: t('reports.previewPdf') }).getAttribute('href')).toBe(
        '/api/reports/by-city/pdf?period=thisMonth',
      ),
    );
    cleanup();

    mount(makeTransport({ options: vi.fn(async () => OFFICE_OPTIONS) }));
    await screen.findByText('Morbi');
    expect(screen.queryByRole('link', { name: t('reports.previewPdf') })).toBeNull();
  });

  it('withdraws the PDF preview link while the Master is out of reach, and keeps the file buttons', async () => {
    mount(makeTransport(), { online: false });
    await screen.findByText('Morbi');
    expect(screen.queryByRole('link', { name: t('reports.previewPdf') })).toBeNull();
    expect(screen.getByRole('button', { name: t('reports.export.pdf') })).toBeTruthy();
  });

  it('writes the file the controls describe, in the language on screen, and stays busy until it arrives', async () => {
    let finish: (value: { blob: Blob; fileName: string }) => void = () => undefined;
    const transport = makeTransport({
      exportFile: vi.fn(() => new Promise<{ blob: Blob; fileName: string }>((resolve) => { finish = resolve; })),
    });
    mount(transport);
    await screen.findByText('Morbi');
    await screen.findByRole('combobox', { name: t('reports.subject.label') });
    pick(combo(t('reports.subject.label')), 'alice');
    await waitFor(() => expect(lastQuery(transport)).toMatchObject({ subjectId: 'US1' }));
    await screen.findByText('Morbi');

    fireEvent.click(screen.getByRole('button', { name: t('reports.export.xlsx') }));
    expect(transport.exportFile).toHaveBeenCalledWith('by-city', expect.objectContaining({ format: 'xlsx', lang: 'en', subjectId: 'US1', period: 'last6Months' }));

    // Busy: the others are disabled, so a second click cannot start a second file.
    expect(screen.getByRole('button', { name: t('reports.export.csv') }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('reports.export.pdf') }));
    expect(transport.exportFile).toHaveBeenCalledTimes(1);

    finish({ blob: new Blob(['x']), fileName: 'by-city.xlsx' });
    await waitFor(() => expect(screen.getByRole('button', { name: t('reports.export.csv') }).hasAttribute('disabled')).toBe(false));
  });

  it('says so when the file could not be made', async () => {
    const transport = makeTransport({ exportFile: vi.fn(async () => { throw new Error('boom'); }) });
    mount(transport);
    await screen.findByText('Morbi');
    fireEvent.click(screen.getByRole('button', { name: t('reports.export.csv') }));
    expect(await screen.findByText('boom')).toBeTruthy();
    await waitFor(() => expect(within(document.body).getByRole('button', { name: t('reports.export.csv') }).hasAttribute('disabled')).toBe(false));
  });
});
