/**
 * Notice board management's "Sell today" tab (2026-10-08): offered only with its writes, the list
 * with where each entry stands today, and the editor (headline, products picked by search, how
 * long it stays, the days, the audience) sending what the Master takes.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Product, SellToday, SellTodayInput, SellTodayUpdate } from '@orderbook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureUi } from '../src/config.js';
import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { NoticeManageView, sellTodayStatus } from '../src/NoticeManageView.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  configureUi({ panel: 'master', defaultTheme: 'light', themeStorageKey: 'ob.theme' });
});
afterEach(cleanup);

const TODAY = '2026-10-08';

const entry = (id: string, over: Partial<SellToday> = {}): SellToday => ({
  id,
  tenantId: 't1',
  title: `Push ${id}`,
  body: '',
  productIds: ['P1'],
  products: [{ id: 'P1', name: 'DAMRU', code: 'OPT-0001', size: null, mainProduct: 'Basin', image: null }],
  autoCloseSeconds: 15,
  showFrom: TODAY,
  showUntil: TODAY,
  audience: { kind: 'all' },
  authorId: null,
  authorName: null,
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
  version: 2,
  ...over,
});

const PRODUCT = {
  id: 'P2',
  name: 'VITROSA 41',
  size: '600 x 400',
  categoryName: 'Table Top Basin',
  isActive: true,
  variants: [{ code: 'TTB-0041', isActive: true }],
  images: [],
} as unknown as Product;

function manage(over: Partial<Parameters<typeof NoticeManageView>[0]> = {}) {
  const created: SellTodayInput[] = [];
  const updated: Array<[string, SellTodayUpdate]> = [];
  const deleted: string[] = [];
  const search = vi.fn(async () => [PRODUCT]);
  render(
    <ConfirmProvider>
      <NoticeManageView
        notices={[]}
        roles={[{ id: 'r1', name: 'Sales' }]}
        onCreate={async () => undefined}
        onUpdate={async () => undefined}
        onDelete={async (id) => void deleted.push(id)}
        loadReaders={async (id) => ({ noticeId: id, readers: [] })}
        today={TODAY}
        sellToday={[
          entry('now', { createdAt: '2026-10-08T09:00:00.000Z' }),
          entry('older'),
          entry('later', { showFrom: '2026-10-10', showUntil: null }),
          entry('gone', { showFrom: '2026-10-01', showUntil: '2026-10-02', autoCloseSeconds: 0, productIds: [], products: [] }),
        ]}
        onCreateSellToday={async (input) => void created.push(input)}
        onUpdateSellToday={async (id, update) => void updated.push([id, update])}
        searchProducts={search}
        {...over}
      />
    </ConfirmProvider>,
  );
  return { created, updated, deleted, search };
}

const openTab = () => fireEvent.click(screen.getByRole('tab', { name: new RegExp(t('notices.manage.tab.sellToday')) }));
const row = (title: string) => screen.getByText(title).closest('[role="row"]') as HTMLElement;

describe('the Sell today tab', () => {
  it('is not offered without its writes (a Master too old for it)', () => {
    manage({ onCreateSellToday: undefined, onUpdateSellToday: undefined });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getAllByRole('button', { name: t('notices.manage.new') }).length).toBeGreaterThan(0);
  });

  it('lists every entry with where it stands today, its products, its days and how it closes', () => {
    manage();
    openTab();
    const status = (title: string) => row(title).querySelector('[data-status]')?.getAttribute('data-status');
    expect(status('Push now')).toBe('today');
    expect(status('Push older')).toBe('superseded');
    expect(status('Push later')).toBe('upcoming');
    expect(status('Push gone')).toBe('ended');
    expect(within(row('Push now')).getByText(t('sellToday.manage.productCount', { count: 1 }))).toBeTruthy();
    expect(within(row('Push gone')).getByText(t('sellToday.manage.messageOnly'))).toBeTruthy();
    expect(within(row('Push later')).getByText(t('sellToday.days.open', { from: '2026-10-10' }))).toBeTruthy();
    expect(within(row('Push gone')).getByText(t('sellToday.days.range', { from: '2026-10-01', to: '2026-10-02' }))).toBeTruthy();
    expect(within(row('Push gone')).getByText(t('sellToday.closes.never'))).toBeTruthy();
    expect(within(row('Push now')).getByText(t('sellToday.closes.after', { seconds: 15 }))).toBeTruthy();
    expect(sellTodayStatus(entry('x'), [], '2026-10-09')).toBe('ended');
  });

  it('refuses an entry with no headline or nothing to sell, then sends one with a product picked by search', async () => {
    const { created, search } = manage();
    openTab();
    fireEvent.click(screen.getByRole('button', { name: t('sellToday.manage.new') }));
    const save = () => fireEvent.click(screen.getByRole('button', { name: t('sellToday.editor.save') }));

    save();
    expect(await screen.findByText(t('sellToday.problem.title_required'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(new RegExp(t('sellToday.editor.titleLabel'))), {
      target: { value: ' Push the Vitrosa range ' },
    });
    save();
    expect(await screen.findByText(t('sellToday.problem.nothing_to_sell'))).toBeTruthy();
    expect(created).toEqual([]);

    const field = screen.getByRole('combobox', { name: t('sellToday.editor.searchLabel') });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'vitro' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('vitro'));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /VITROSA 41/ }));
    expect(screen.getByText('TTB-0041 · 600 x 400 · Table Top Basin')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(t('sellToday.editor.autoCloseLabel')), { target: { value: '30' } });
    save();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      title: 'Push the Vitrosa range',
      body: '',
      productIds: ['P2'],
      autoCloseSeconds: 30,
      showFrom: TODAY,
      showUntil: TODAY,
      audience: { kind: 'all' },
    });
  });

  it('refuses a last day before the first, and edits against the version it saw', async () => {
    const { updated } = manage();
    openTab();
    fireEvent.click(within(row('Push now')).getByRole('button', { name: t('notices.manage.edit') }));
    fireEvent.change(screen.getByLabelText(t('sellToday.editor.untilLabel')), { target: { value: '2026-10-07' } });
    fireEvent.click(screen.getByRole('button', { name: t('sellToday.editor.save') }));
    expect(await screen.findByText(t('sellToday.problem.dates_reversed'))).toBeTruthy();

    fireEvent.change(screen.getByLabelText(t('sellToday.editor.untilLabel')), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: t('sellToday.editor.remove', { name: 'DAMRU' }) }));
    fireEvent.change(screen.getByLabelText(new RegExp(t('sellToday.editor.bodyLabel'))), { target: { value: 'Clear old stock' } });
    fireEvent.click(screen.getByRole('button', { name: t('sellToday.editor.save') }));
    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]).toEqual([
      'now',
      expect.objectContaining({ productIds: [], body: 'Clear old stock', showUntil: null, expectedVersion: 2 }),
    ]);
  });

  it('deletes only after a confirmation', async () => {
    const { deleted } = manage();
    openTab();
    fireEvent.click(within(row('Push later')).getByRole('button', { name: t('notices.manage.delete') }));
    const dialog = await screen.findByRole('dialog', { name: t('sellToday.delete.title', { title: 'Push later' }) });
    fireEvent.click(within(dialog).getByRole('button', { name: t('sellToday.delete.confirm') }));
    await waitFor(() => expect(deleted).toEqual(['later']));
  });
});
