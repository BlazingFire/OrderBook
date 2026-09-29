/**
 * The Master's Inventory list refetches on every brand chip, product pick and
 * (debounced) search. Answers can come back out of order, and a slower, older
 * one must not land over the newer one — that showed brand A's rows under
 * brand B's highlighted chip.
 *
 * It also pins what the brand chips send: the `product.brand` value, as the
 * `brand` filter, with the list's whole cap rather than the default page (every
 * live sub product has a row, stocked or not — CATALOGUE_MODEL.md §7).
 *
 * Here rather than beside the screen because `ui/tests` is the only jsdom suite.
 * The screen is imported through a variable path, as `panel-harness.ts`
 * explains, so the Master's web sources stay out of this folder's type check.
 */

import type { ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InventoryStockLevel, OptionListItem } from '@orderbook/shared';

import { FilterBarOutlet, FilterBarProvider } from '../src/FilterBarSlot.js';

interface Pending {
  query: { brand?: string; limit?: number };
  resolve: (rows: InventoryStockLevel[]) => void;
}

const mocks = vi.hoisted(() => ({ pending: [] as Pending[] }));

function brand(value: string): OptionListItem {
  return {
    id: `id-${value}`,
    tenantId: 'tenant',
    listKey: 'product.brand',
    value,
    label: value,
    sequence: 0,
    isActive: true,
    hex: null,
    deletedAt: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    version: 1,
  } as OptionListItem;
}

vi.mock('../../master/web/src/api', () => ({
  api: {
    stock: vi.fn(
      (query: Pending['query']) => new Promise((resolve) => mocks.pending.push({ query, resolve })),
    ),
    stockMovements: vi.fn(async () => []),
    optionLists: vi.fn(async () => [brand('Alpha'), brand('Beta')]),
    categories: vi.fn(async () => []),
    pick: vi.fn(async () => ({ truncated: false, items: [] })),
  },
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

afterEach(() => {
  cleanup();
  mocks.pending.length = 0;
});

type ScreenProps = {
  revision: number;
  filter: 'all' | 'low';
  onFilterChange: (filter: 'all' | 'low') => void;
  freeToSell: boolean;
  adjustmentNoteRequired: boolean;
};

let InventoryScreen: ComponentType<ScreenProps>;

beforeAll(async () => {
  const path = '../../master/web/src/screens/InventoryScreen.tsx';
  ({ InventoryScreen } = (await import(/* @vite-ignore */ path)) as {
    InventoryScreen: ComponentType<ScreenProps>;
  });
});

function level(productName: string, brandName: string): InventoryStockLevel {
  return {
    productId: `p-${productName}`,
    productName,
    categoryId: 'c-1',
    categoryName: 'One Piece Toilet',
    categoryCode: 'OPT',
    brand: brandName,
    multiColour: false,
    size: null,
    variantId: `v-${productName}`,
    variantCode: `OPT-${productName}`,
    variantLabel: null,
    weightKg: null,
    quantityBoxes: 1,
    reservedBoxes: 0,
    availableBoxes: 1,
    reorderLevel: null,
    minStockLevel: null,
    maxStockLevel: null,
    isLow: false,
  } as unknown as InventoryStockLevel;
}

function answer(brandName: string | undefined, rows: InventoryStockLevel[]): void {
  const request = mocks.pending.find((entry) => entry.query.brand === brandName);
  if (!request) throw new Error(`no stock request for brand ${String(brandName)}`);
  request.resolve(rows);
}

describe('InventoryScreen stock list', () => {
  it('keeps the newest filter’s rows when an older answer arrives last', async () => {
    render(
      <FilterBarProvider>
        <FilterBarOutlet />
        <InventoryScreen
          revision={0}
          filter="all"
          onFilterChange={() => undefined}
          freeToSell
          adjustmentNoteRequired={false}
        />
      </FilterBarProvider>,
    );
    await waitFor(() => expect(mocks.pending).toHaveLength(1));
    expect(mocks.pending[0]?.query.limit).toBe(1000);
    await act(async () => answer(undefined, []));

    fireEvent.click(await screen.findByRole('button', { name: /Alpha/ }));
    await waitFor(() => expect(mocks.pending).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    await waitFor(() => expect(mocks.pending).toHaveLength(3));

    // Beta, asked for last, answers first; Alpha's slower answer trails in.
    await act(async () => answer('Beta', [level('BETA-ROW', 'Beta')]));
    await act(async () => answer('Alpha', [level('ALPHA-ROW', 'Alpha')]));

    expect(screen.getByText('BETA-ROW')).toBeTruthy();
    expect(screen.queryByText('ALPHA-ROW')).toBeNull();
  });
});
