/**
 * The Office sub-product list (`CatalogScreen` on Products → Sub products,
 * CATALOGUE_MODEL.md §1, §2), against a mocked api:
 *
 * - its Product filter opens a list below itself, so it must not sit in the
 *   shell's filter strip: `.ob-filterbar` scrolls sideways and clips
 *   vertically at its band, and a list opened inside it can never be seen
 *   (the Master's Products screen moved its product Picker out for the
 *   same reason). This pins where it renders, and that choosing from it filters;
 * - a brand chip asks the Master for that brand and clears a product of
 *   another brand;
 * - each row reads as the catalogue does — `One Piece Toilet`, the
 *   brand, and the colour its rule shows.
 *
 * Here rather than beside the screen because `ui/tests` is the only jsdom suite.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OptionListItem, Product, ProductCategory } from '@orderbook/shared';

import type { LocalView } from '../../office/web/src/api.js';
import { CatalogScreen } from '../../office/web/src/screens/CatalogScreen.js';
import { FilterBarOutlet, FilterBarProvider } from '../src/FilterBarSlot.js';
import { t } from '../src/i18n.js';

const listProducts = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ items: [] as unknown[], total: 0 })),
);

vi.mock('../../office/web/src/api', () => ({
  api: { listProducts },
  ApiError: class ApiError extends Error {},
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
  vi.clearAllMocks();
});

const STAMP = '2026-09-28T00:00:00.000Z';

function category(id: string, code: string, name: string, brand: string | null): ProductCategory {
  return {
    id,
    tenantId: 'tenant',
    code,
    name,
    brand,
    sortOrder: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
  };
}

const OPT = category('c-opt', 'OPT', 'One Piece Toilet', 'Swisware+');
const WB = category('c-wb', 'WB', 'Wash Basin', 'Other');

const SWISWARE: OptionListItem = {
  id: 'b-swisware',
  tenantId: 'tenant',
  listKey: 'product.brand',
  value: 'Swisware+',
  label: 'Swisware+',
  sequence: 1,
  isActive: true,
  hex: null,
  deletedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
} as OptionListItem;

function viewOf(overrides: Partial<LocalView> = {}): LocalView {
  return {
    optionLists: [SWISWARE],
    permissions: [],
    parties: [],
    partyVariants: [],
    products: [],
    categories: [OPT, WB],
    ...overrides,
  } as unknown as LocalView;
}

function renderList(view: LocalView = viewOf()) {
  return render(
    <FilterBarProvider>
      <FilterBarOutlet />
      <CatalogScreen view={view} tab="products" />
    </FilterBarProvider>,
  );
}

/** A sub product of OPT, as the Master lists it: one variant, its label the fixed colour or null. */
function subProduct(
  id: string,
  name: string,
  variant: { code: string; label: string | null; multiColour?: boolean },
): Product {
  return {
    id,
    name,
    alias: null,
    categoryId: 'c-opt',
    categoryName: 'One Piece Toilet',
    // The row's own joined copy is stale on purpose: the snapshot's category wins.
    categoryCode: 'OLD',
    brand: 'Old brand',
    sortOrder: null,
    size: null,
    multiColour: variant.multiColour ?? false,
    hasVariants: variant.label !== null,
    variants: [
      { id: `${id}-v`, code: variant.code, label: variant.label, isActive: true, weightKg: null },
    ],
    sync: { hlc: 'hlc-1' },
  } as unknown as Product;
}

describe('CatalogScreen sub-product list', () => {
  it('renders the product filter outside the clipping filter strip, and it still filters', async () => {
    const { container } = renderList();

    const filter = await screen.findByRole('combobox', {
      name: t('catalog.products.productFilter'),
    });
    // The strip is published, so this is a real "not in it" rather than "no strip".
    expect(container.querySelector('.ob-filterbar')).not.toBeNull();
    expect(filter.closest('.ob-filterbar')).toBeNull();

    fireEvent.focus(filter);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'One Piece Toilet' }));
    await waitFor(() =>
      expect(listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ categoryId: 'c-opt' }),
        expect.anything(),
      ),
    );
  });

  it('asks the Master for a brand, and narrows the product filter to its products', async () => {
    renderList();
    await waitFor(() => expect(listProducts).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Swisware\+/ }));
    await waitFor(() =>
      expect(listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ brand: 'Swisware+', categoryId: undefined }),
        expect.anything(),
      ),
    );

    fireEvent.focus(
      screen.getByRole('combobox', { name: t('catalog.products.productFilter') }),
    );
    expect(screen.getByRole('option', { name: 'One Piece Toilet' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Wash Basin' })).toBeNull();
  });

  it('reads each row as the catalogue does: brand, product, and the colour by its rule', async () => {
    listProducts.mockResolvedValueOnce({
      items: [
        subProduct('p-white', '102 (9")', { code: 'OPT-0001', label: 'White' }),
        subProduct('p-magenta', 'MAGENTA', { code: 'OPT-0002', label: 'Magenta' }),
        subProduct('p-orissa', 'ORISSA', { code: 'OPT-0003', label: null, multiColour: true }),
        subProduct('p-1111', '1111', { code: 'OPT-0004', label: null }),
      ],
      total: 4,
    });
    renderList();

    const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    await screen.findByText('1111');

    for (const name of ['102 (9")', 'MAGENTA', 'ORISSA', '1111']) {
      expect(row(name).textContent).toContain('One Piece Toilet');
      // The main-product code is its own column, never part of the product's name (R14).
      expect(row(name).textContent).not.toMatch(/OPT\s*[·-]\s*One Piece/);
      expect(row(name).textContent).toContain('Swisware+');
      expect(row(name).textContent).not.toContain('Old brand');
    }
    expect(row('102 (9")').textContent).toContain('White');
    // The colour only repeats the name, so it is not said again.
    expect(row('MAGENTA').textContent?.match(/magenta/gi)).toHaveLength(1);
    expect(row('ORISSA').textContent).toContain(t('catalog.colourRule.multicolour'));
    expect(row('1111').textContent).not.toContain(t('catalog.colourRule.multicolour'));
  });
});
