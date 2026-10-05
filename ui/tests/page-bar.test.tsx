/**
 * Paging the order lists (1.4.3 R17): the page arithmetic and its boundaries, the controls, the
 * remembered page size, and the Master's Final Orders list asking for the right page, with its
 * filters sent to the server so they hold across every page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureUi } from '../src/config.js';
import { t } from '../src/i18n.js';
import { FilterBarOutlet, FilterBarProvider } from '../src/FilterBarSlot.js';
import { DEFAULT_PAGE_SIZE, PageBar, pageWindow, usePageSize } from '../src/PageBar.js';
import { installBrowserStubs, json, routeFetch } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  window.localStorage.clear();
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(cleanup);

describe('pageWindow', () => {
  it('splits a total into pages and reports the range on each', () => {
    expect(pageWindow(120, 0, 50)).toEqual({ page: 0, pages: 3, offset: 0, from: 1, to: 50 });
    expect(pageWindow(120, 1, 50)).toEqual({ page: 1, pages: 3, offset: 50, from: 51, to: 100 });
    expect(pageWindow(120, 2, 50)).toEqual({ page: 2, pages: 3, offset: 100, from: 101, to: 120 });
  });

  it('puts an exact multiple on its last page, not an empty one after it', () => {
    expect(pageWindow(100, 1, 50)).toMatchObject({ pages: 2, from: 51, to: 100 });
    expect(pageWindow(100, 2, 50)).toMatchObject({ page: 1 });
  });

  it('clamps a page that no longer exists (rows were deleted) and handles nothing at all', () => {
    expect(pageWindow(30, 9, 25)).toMatchObject({ page: 1, from: 26, to: 30 });
    expect(pageWindow(0, 3, 50)).toEqual({ page: 0, pages: 1, offset: 0, from: 0, to: 0 });
    expect(pageWindow(7, -4, 50)).toMatchObject({ page: 0, from: 1, to: 7 });
  });
});

describe('usePageSize', () => {
  function Probe() {
    const [size, setSize] = usePageSize('probe');
    return (
      <button type="button" onClick={() => setSize(100)}>
        {size}
      </button>
    );
  }

  it('starts at the default, remembers a choice on this machine, and ignores a stored value it does not offer', () => {
    const view = render(<Probe />);
    expect(screen.getByRole('button').textContent).toBe(String(DEFAULT_PAGE_SIZE));
    fireEvent.click(screen.getByRole('button'));
    expect(window.localStorage.getItem('ob.pageSize.probe')).toBe('100');
    view.unmount();

    render(<Probe />);
    expect(screen.getByRole('button').textContent).toBe('100');
    cleanup();

    window.localStorage.setItem('ob.pageSize.probe', '37');
    render(<Probe />);
    expect(screen.getByRole('button').textContent).toBe(String(DEFAULT_PAGE_SIZE));
  });
});

describe('PageBar', () => {
  function bar(page: number, total = 120, size = 50) {
    const pages: number[] = [];
    const sizes: number[] = [];
    render(<PageBar total={total} page={page} pageSize={size} onPage={(next) => pages.push(next)} onPageSize={(next) => sizes.push(next)} />);
    return { pages, sizes };
  }

  it('says which rows are shown out of how many', () => {
    bar(1);
    expect(screen.getByText(t('pageBar.range', { from: 51, to: 100, total: 120 }))).toBeTruthy();
    expect(screen.getByText(t('pageBar.pageOf', { page: 2, pages: 3 }))).toBeTruthy();
  });

  it('disables Previous and First on the first page and Next and Last on the last', () => {
    bar(0);
    expect((screen.getByRole('button', { name: t('pageBar.previous') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('pageBar.first') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('pageBar.next') }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    bar(2);
    expect((screen.getByRole('button', { name: t('pageBar.next') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('pageBar.last') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for the neighbouring, first and last pages', () => {
    const { pages } = bar(1);
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.next') }));
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.previous') }));
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.first') }));
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.last') }));
    expect(pages).toEqual([2, 0, 0, 2]);
  });

  it('says there is nothing to show for an empty list', () => {
    bar(0, 0);
    expect(screen.getByText(t('pageBar.none'))).toBeTruthy();
  });
});

describe('the Master’s Final Orders list', () => {
  const TOTAL = 120;
  const order = (index: number) => ({
    id: `o${index}`, number: `PO/${index}`, partyId: 'p1', partyName: `Party ${index}`, stageId: 's1', items: [],
    totalWeightKg: 0, totalWeightKgOverride: null, weightSource: 'computed', createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z', dispatchedAt: null, version: 1, ownerId: null, notes: null,
  });

  async function mount(stageId: string | null = null) {
    const requests: URL[] = [];
    routeFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/orders/stage-counts')) {
        return json({ total: TOTAL, counts: { s1: 70, s2: 50 } });
      }
      if (method !== 'GET' || !url.startsWith('/api/orders?')) return undefined;
      const query = new URL(url, 'http://x').searchParams;
      requests.push(new URL(url, 'http://x'));
      const limit = Number(query.get('limit'));
      const offset = Number(query.get('offset') ?? 0);
      const items = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, at) => order(offset + at));
      return json({ items, total: TOTAL, limit, offset });
    });
    const path = '../../master/web/src/screens/OrdersScreen.tsx';
    const { OrdersScreen } = (await import(/* @vite-ignore */ path)) as { OrdersScreen: ComponentType<Record<string, unknown>> };
    const props = {
      revision: 0,
      stages: [
        { id: 's1', name: 'Open', sequence: 1, isDefault: true, isTerminal: false },
        { id: 's2', name: 'Packed', sequence: 2, isDefault: false, isTerminal: false },
      ],
      permissions: [], stageId, onStageChange: () => undefined, openId: null,
      onOpenId: () => undefined, onOpenLead: () => undefined, userId: 'u1',
    };
    const view = render(
      <FilterBarProvider>
        <FilterBarOutlet />
        <OrdersScreen {...props} />
      </FilterBarProvider>,
    );
    return { requests, view, OrdersScreen, props };
  }

  const last = (requests: URL[]) => requests.at(-1)!.searchParams;

  it('asks the Master for the first page and shows the total', async () => {
    const { requests } = await mount();
    expect(await screen.findByText(t('pageBar.range', { from: 1, to: 50, total: TOTAL }))).toBeTruthy();
    expect(last(requests).get('limit')).toBe('50');
    expect(last(requests).get('offset') ?? '0').toBe('0');
  });

  it('moves a page at a time by offset, and to the last page, which is the short one', async () => {
    const { requests } = await mount();
    await screen.findByText(t('pageBar.range', { from: 1, to: 50, total: TOTAL }));

    fireEvent.click(screen.getByRole('button', { name: t('pageBar.next') }));
    expect(await screen.findByText(t('pageBar.range', { from: 51, to: 100, total: TOTAL }))).toBeTruthy();
    expect(last(requests).get('offset')).toBe('50');

    fireEvent.click(screen.getByRole('button', { name: t('pageBar.last') }));
    expect(await screen.findByText(t('pageBar.range', { from: 101, to: 120, total: TOTAL }))).toBeTruthy();
    expect(last(requests).get('offset')).toBe('100');
    expect((screen.getByRole('button', { name: t('pageBar.next') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts again at the first page when the size changes, with the new size', async () => {
    const { requests } = await mount();
    await screen.findByText(t('pageBar.range', { from: 1, to: 50, total: TOTAL }));
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.next') }));
    await screen.findByText(t('pageBar.range', { from: 51, to: 100, total: TOTAL }));

    const select = within(screen.getByRole('navigation', { name: t('pageBar.label') })).getByRole('combobox');
    fireEvent.focus(select);
    fireEvent.mouseDown(screen.getByRole('option', { name: '100' }));

    expect(await screen.findByText(t('pageBar.range', { from: 1, to: 100, total: TOTAL }))).toBeTruthy();
    expect(last(requests).get('limit')).toBe('100');
    expect(last(requests).get('offset') ?? '0').toBe('0');
  });

  it('shows true per-stage totals on the chips, from the Master, the same on every page', async () => {
    await mount();
    const chip = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(within(chip('Open')).getByText('70')).toBeTruthy());
    expect(within(chip('Packed')).getByText('50')).toBeTruthy();
    expect(within(chip(t('orders.filter.allStages'))).getByText(String(TOTAL))).toBeTruthy();

    // A page of 50 rows holds at most 50 of any stage: the chips are not counts of the page.
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.next') }));
    await screen.findByText(t('pageBar.range', { from: 51, to: 100, total: TOTAL }));
    expect(within(chip('Open')).getByText('70')).toBeTruthy();
  });

  it('sends the stage filter to the Master, so it narrows every page, and starts at the first page', async () => {
    const { requests, view, OrdersScreen, props } = await mount();
    await screen.findByText(t('pageBar.range', { from: 1, to: 50, total: TOTAL }));
    fireEvent.click(screen.getByRole('button', { name: t('pageBar.next') }));
    await screen.findByText(t('pageBar.range', { from: 51, to: 100, total: TOTAL }));

    await act(async () => {
      view.rerender(
        <FilterBarProvider>
          <FilterBarOutlet />
          <OrdersScreen {...props} stageId="s1" />
        </FilterBarProvider>,
      );
    });
    await waitFor(() => expect(last(requests).get('stageIds')).toBe('s1'));
    expect(last(requests).get('offset') ?? '0').toBe('0');
  });
});

describe('the Office lists page what their filters leave', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

  it.each([
    ['office/web/src/screens/OrderBoardScreen.tsx', 'filteredOrders', 'pagedOrders'],
    ['office/web/src/screens/LeadBoardScreen.tsx', 'filtered', 'pagedLeads'],
  ])('%s totals the filtered rows and shows only one page of them', (file, filtered, paged) => {
    const source = read(file);
    expect(source).toContain('<PageBar');
    expect(source).toContain(`total={${filtered}.length}`);
    expect(source).toContain(`${paged} = ${filtered}.slice(`);
    expect(source).toContain(`rows={${paged}}`);
    // The stage chips count what the search and "my parties" leave, not the page.
    expect(source).toContain('count={countable.length}');
    expect(source).toContain('countable.filter(');
  });
});
