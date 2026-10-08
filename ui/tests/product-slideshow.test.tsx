/**
 * The product band on Basic Home (2026-10-08): what it shows, how it turns over, and the carousel
 * rules it shares with the notice band (pause on hover and focus, stop, previous and next).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Product, SellToday, SellTodayProduct } from '@orderbook/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n.js';
import {
  PRODUCT_SLIDE_MS,
  ProductSlideshow,
  featuredProducts,
  homeProducts,
} from '../src/ProductSlideshow.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
});

const card = (id: string): SellTodayProduct => ({
  id,
  name: `Name ${id}`,
  code: `C-${id}`,
  size: null,
  mainProduct: null,
  image: null,
});
const SIX = ['A', 'B', 'C', 'D', 'E', 'F'].map(card);

const product = (id: string, photos: number, isActive = true): Product =>
  ({
    id,
    name: `Product ${id}`,
    size: null,
    categoryName: 'Basin',
    isActive,
    variants: [{ code: `C-${id}`, isActive: true }],
    images: Array.from({ length: photos }, (_, index) => ({ id: `${id}-img${index}`, isPrimary: index === 0, blurhash: '' })),
  }) as unknown as Product;

const band = () => screen.getByRole('region', { name: t('productShow.label') });
const shown = () =>
  within(band())
    .getAllByRole('group')
    .map((slide) => slide.querySelector('[data-product]')?.getAttribute('data-product'));

describe('what the band shows', () => {
  it('features live sub products that have a photo, a stable selection for the day', () => {
    const catalogue = [product('P1', 1), product('P2', 0), product('P3', 2), product('P4', 1, false)];
    const today = featuredProducts(catalogue, '2026-10-08');
    expect(today.map((each) => each.id).sort()).toEqual(['P1', 'P3']);
    expect(featuredProducts(catalogue, '2026-10-08')).toEqual(today);
    expect(featuredProducts(Array.from({ length: 40 }, (_, i) => product(`X${i}`, 1)), '2026-10-08')).toHaveLength(24);
  });

  it('prefers today’s "Sell today" products, and falls back when the entry has none', () => {
    const entry = { id: 'S1', title: 'Push', createdAt: '2026-10-08T08:00:00Z', showFrom: null, showUntil: null, products: [card('Z')] } as SellToday;
    const catalogue = [product('P1', 1)];

    expect(homeProducts([entry], catalogue, '2026-10-08')).toMatchObject({ products: [{ id: 'Z' }], sellToday: { id: 'S1' } });
    expect(homeProducts([{ ...entry, products: [] }], catalogue, '2026-10-08')).toMatchObject({
      products: [{ id: 'P1' }],
      sellToday: null,
    });
    expect(homeProducts(undefined, [], '2026-10-08').products).toEqual([]);
  });
});

describe('ProductSlideshow', () => {
  it('draws nothing without products', () => {
    render(<ProductSlideshow products={[]} />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows four cards, turns over by one every few seconds, and opens a product', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    render(<ProductSlideshow products={SIX} onOpen={onOpen} />);
    expect(shown()).toEqual(['A', 'B', 'C', 'D']);

    act(() => {
      vi.advanceTimersByTime(PRODUCT_SLIDE_MS);
    });
    expect(shown()).toEqual(['B', 'C', 'D', 'E']);

    fireEvent.click(within(band()).getByTitle(t('productShow.open', { name: 'Name C' })));
    expect(onOpen).toHaveBeenCalledWith('C');
  });

  it('pauses while the pointer is over it, and moves on previous and next', () => {
    vi.useFakeTimers();
    render(<ProductSlideshow products={SIX} />);
    fireEvent.mouseEnter(band());
    act(() => {
      vi.advanceTimersByTime(PRODUCT_SLIDE_MS * 3);
    });
    expect(shown()).toEqual(['A', 'B', 'C', 'D']);

    fireEvent.click(screen.getByRole('button', { name: t('productShow.previous') }));
    expect(shown()).toEqual(['F', 'A', 'B', 'C']);
    fireEvent.click(screen.getByRole('button', { name: t('productShow.next') }));
    fireEvent.click(screen.getByRole('button', { name: t('productShow.next') }));
    expect(shown()).toEqual(['B', 'C', 'D', 'E']);

    fireEvent.mouseLeave(band());
    fireEvent.click(screen.getByRole('button', { name: t('productShow.pause') }));
    act(() => {
      vi.advanceTimersByTime(PRODUCT_SLIDE_MS * 2);
    });
    expect(shown()).toEqual(['B', 'C', 'D', 'E']);
  });

  it('never moves by itself under reduced motion, and has no controls when everything fits', () => {
    vi.useFakeTimers();
    document.documentElement.dataset.motion = 'off';
    const view = render(<ProductSlideshow products={SIX} />);
    act(() => {
      vi.advanceTimersByTime(PRODUCT_SLIDE_MS * 2);
    });
    expect(shown()).toEqual(['A', 'B', 'C', 'D']);
    expect(screen.queryByRole('button', { name: t('productShow.pause') })).toBeNull();

    view.rerender(<ProductSlideshow products={SIX.slice(0, 3)} />);
    expect(screen.queryByRole('button', { name: t('productShow.next') })).toBeNull();
  });

  it('is headed "Sell today" with the headline when it shows the day’s entry', () => {
    render(<ProductSlideshow products={SIX.slice(0, 2)} sellToday={{ title: 'Push the Damru range' }} />);
    const region = screen.getByRole('region', { name: t('productShow.sellToday') });
    expect(within(region).getByText('Push the Damru range')).toBeTruthy();
  });
});
