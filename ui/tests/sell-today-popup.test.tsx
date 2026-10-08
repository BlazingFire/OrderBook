/**
 * "What to sell today" (2026-10-08): the day's entry pops up once per person per day, waits for
 * whatever must go first, counts down and closes by itself when told to, and opens a product.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SellToday, SellTodayProduct } from '@orderbook/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import { SellTodayPopup, sellTodaySeen } from '../src/SellTodayPopup.js';

beforeAll(() => {
  // jsdom has no checkVisibility; the dialog's focus trap asks it which controls can take focus.
  Element.prototype.checkVisibility ??= () => true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

const card = (id: string, name: string): SellTodayProduct => ({
  id,
  name,
  code: `OPT-${id}`,
  size: '600 x 400',
  mainProduct: 'Table Top Basin',
  image: null,
});

const entry = (id: string, over: Partial<SellToday> = {}): SellToday => ({
  id,
  tenantId: 't1',
  title: `Push ${id}`,
  body: 'Both ranges, all day.',
  productIds: ['P1', 'P2', 'P3'],
  products: [card('P1', 'DAMRU'), card('P2', 'VITROSA 41'), card('P3', 'AQUA')],
  autoCloseSeconds: 10,
  showFrom: '2026-10-08',
  showUntil: '2026-10-08',
  audience: { kind: 'all' },
  authorId: null,
  authorName: null,
  createdAt: '2026-10-08T08:00:00.000Z',
  updatedAt: '2026-10-08T08:00:00.000Z',
  version: 1,
  ...over,
});

const TODAY = '2026-10-08';
const dialog = () => screen.queryByRole('dialog');

function show(props: Partial<Parameters<typeof SellTodayPopup>[0]> = {}) {
  return render(
    <SellTodayPopup entries={[entry('S1')]} today={TODAY} userId="U1" ready {...props} />,
  );
}

describe('SellTodayPopup', () => {
  it('shows the headline, the message and the products as cards, and Start work closes it', () => {
    show();
    expect(dialog()).not.toBeNull();
    expect(within(dialog()!).getByText('Push S1')).toBeTruthy();
    expect(within(dialog()!).getByText('Both ranges, all day.')).toBeTruthy();
    const cards = within(dialog()!).getByRole('list', { name: t('sellToday.popup.products') });
    expect(within(cards).getAllByRole('listitem').map((item) => item.getAttribute('data-product'))).toEqual([
      'P1',
      'P2',
      'P3',
    ]);
    expect(within(cards).getByText('OPT-P2 · 600 x 400')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('sellToday.popup.start') }));
    expect(dialog()).toBeNull();
  });

  it('waits while something else must go first, then opens', () => {
    const view = show({ ready: false });
    expect(dialog()).toBeNull();
    view.rerender(<SellTodayPopup entries={[entry('S1')]} today={TODAY} userId="U1" ready />);
    expect(dialog()).not.toBeNull();
  });

  it('counts down and closes by itself after the seconds set', () => {
    vi.useFakeTimers();
    show();
    expect(within(dialog()!).getByText(t('sellToday.popup.closesIn', { seconds: 10 }))).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(within(dialog()!).getByText(t('sellToday.popup.closesIn', { seconds: 6 }))).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(dialog()).toBeNull();
  });

  it('stays until closed when set to 0, with no countdown', () => {
    vi.useFakeTimers();
    show({ entries: [entry('S1', { autoCloseSeconds: 0 })] });
    expect(screen.queryByRole('timer')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(600_000);
    });
    expect(dialog()).not.toBeNull();
  });

  it('opens once per person per day: not again after a remount, again for somebody else or the next day', () => {
    const first = show();
    fireEvent.click(screen.getByRole('button', { name: t('sellToday.popup.start') }));
    first.unmount();
    expect(sellTodaySeen('U1', TODAY)).toEqual(['S1']);

    show();
    expect(dialog()).toBeNull();
    cleanup();

    show({ userId: 'U2' });
    expect(dialog()).not.toBeNull();
    cleanup();

    show({ today: '2026-10-09', entries: [entry('S1', { showUntil: '2026-10-09' })] });
    expect(dialog()).not.toBeNull();
  });

  it('opens an entry that arrives while signed in, and the newest when two cover the day', () => {
    const view = show({ entries: [] });
    expect(dialog()).toBeNull();

    view.rerender(
      <SellTodayPopup
        entries={[entry('older'), entry('newer', { createdAt: '2026-10-08T09:00:00.000Z' })]}
        today={TODAY}
        userId="U1"
        ready
      />,
    );
    expect(within(dialog()!).getByText('Push newer')).toBeTruthy();
  });

  it('lets the next entry open when the one showing goes away (deleted, then posted again)', () => {
    const view = show({ entries: [entry('wrong', { autoCloseSeconds: 0 })] });
    expect(within(dialog()!).getByText('Push wrong')).toBeTruthy();

    // Deleted while still open: it closes.
    view.rerender(<SellTodayPopup entries={[]} today={TODAY} userId="U1" ready />);
    expect(dialog()).toBeNull();

    // The corrected one arrives in the same session, and opens.
    view.rerender(
      <SellTodayPopup
        entries={[entry('fixed', { createdAt: '2026-10-08T09:00:00.000Z' })]}
        today={TODAY}
        userId="U1"
        ready
      />,
    );
    expect(within(dialog()!).getByText('Push fixed')).toBeTruthy();
  });

  it('opens the newer entry at once when the one showing is swapped for it in one update', () => {
    const view = show({ entries: [entry('A', { autoCloseSeconds: 0 })] });
    view.rerender(
      <SellTodayPopup
        entries={[entry('B', { createdAt: '2026-10-08T09:00:00.000Z' })]}
        today={TODAY}
        userId="U1"
        ready
      />,
    );
    expect(within(dialog()!).getByText('Push B')).toBeTruthy();
  });

  it('never opens when the company turned it off', () => {
    show({ enabled: false });
    expect(dialog()).toBeNull();
    expect(sellTodaySeen('U1', TODAY)).toEqual([]);
  });

  it('opens a product from its card, closing first', () => {
    const onOpenProduct = vi.fn();
    show({ onOpenProduct });
    fireEvent.click(screen.getByRole('button', { name: t('sellToday.popup.open', { name: 'VITROSA 41' }) }));
    expect(onOpenProduct).toHaveBeenCalledWith('P2');
    expect(dialog()).toBeNull();
  });
});
