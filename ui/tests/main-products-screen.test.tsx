/**
 * The Office's Products → Products and → Brands pages (`MainProductsScreen`,
 * CATALOGUE_MODEL.md §1, §5), against a mocked api:
 *
 * - an edit that leaves a since-retired brand alone does not re-send it — the
 *   Master refuses a brand that is no longer on the list, which would lock the
 *   product out of every other edit;
 * - a product's detail lists its sub products in catalogue order, each with
 *   the colour its rule shows;
 * - the list refetches when a sub product moves between products, which
 *   leaves the snapshot's length unchanged and so would go unnoticed;
 * - Brands without `fields.view` says so instead of mounting an editor whose
 *   every read is refused, and reloads when the shell says the lists moved.
 *
 * Here rather than beside the screen because `ui/tests` is the only jsdom suite.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OptionListItem, Product, ProductCategory } from '@orderbook/shared';

import type { LocalView } from '../../office/web/src/api.js';
import {
  BrandsScreen,
  MainProductsScreen,
} from '../../office/web/src/screens/MainProductsScreen.js';
import { t } from '../src/i18n.js';

const api = vi.hoisted(() => ({
  categories: vi.fn(async () => [] as unknown[]),
  updateCategory: vi.fn(async () => ({})),
  createCategory: vi.fn(async () => ({})),
  deleteCategory: vi.fn(async () => ({})),
  fieldValues: vi.fn(async () => {
    throw new Error('Missing permission: fields.view');
  }),
  fieldUsage: vi.fn(async () => {
    throw new Error('Missing permission: fields.view');
  }),
  createFieldValue: vi.fn(),
  updateFieldValue: vi.fn(),
  deleteFieldValue: vi.fn(),
  reorderFieldValues: vi.fn(),
}));

vi.mock('../../office/web/src/api', () => ({ api, ApiError: class ApiError extends Error {} }));

// `DataTable` measures itself; jsdom has no layout.
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

function brandOption(value: string): OptionListItem {
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
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  } as OptionListItem;
}

function category(id: string, code: string, name: string, brand: string | null): ProductCategory {
  return {
    id,
    tenantId: 'tenant',
    code,
    name,
    brand,
    sortOrder: 5,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
  };
}

/** A sub product: one variant, its label the fixed colour or null. */
function subProduct(
  id: string,
  categoryId: string,
  hlc: string,
  extra: { name?: string; sortOrder?: number | null; label?: string | null; multiColour?: boolean } = {},
): Product {
  return {
    id,
    name: extra.name ?? id,
    categoryId,
    sortOrder: extra.sortOrder ?? null,
    size: null,
    multiColour: extra.multiColour ?? false,
    hasVariants: Boolean(extra.label),
    variants: [
      { id: `${id}-v`, code: `${id}-code`, label: extra.label ?? null, isActive: true, weightKg: null },
    ],
    sync: { hlc },
  } as unknown as Product;
}

function viewOf(overrides: Partial<LocalView>): LocalView {
  return {
    optionLists: [],
    permissions: [],
    categories: [],
    products: [],
    ...overrides,
  } as unknown as LocalView;
}

describe('MainProductsScreen', () => {
  it('saves an edit without re-asserting a brand retired since it was set', async () => {
    // WB is still under OldBrand, which the Brands page has since retired.
    const wb = category('c-wb', 'WB', 'Wash Basin', 'OldBrand');
    api.categories.mockResolvedValue([{ ...wb, subProductCount: 0 }]);
    render(
      <MainProductsScreen
        view={viewOf({
          optionLists: [brandOption('NewBrand')],
          permissions: ['products.view', 'products.edit'],
          categories: [wb],
        })}
      />,
    );

    fireEvent.click(await screen.findByText('Wash Basin'));
    fireEvent.click(screen.getByRole('button', { name: t('action.edit') }));
    fireEvent.change(screen.getByLabelText(t('catalog.mainProducts.field.sortOrder')), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));

    await waitFor(() => expect(api.updateCategory).toHaveBeenCalledTimes(1));
    const [id, patch] = api.updateCategory.mock.calls[0] as unknown as [string, object];
    expect(id).toBe('c-wb');
    expect(patch).toMatchObject({ code: 'WB', name: 'Wash Basin', sortOrder: 6 });
    expect(patch).not.toHaveProperty('brand');
  });

  it('lists the sub products of an open product in catalogue order, coloured by their rule', async () => {
    const opt = category('c-opt', 'OPT', 'One Piece Toilet', 'Swisware+');
    api.categories.mockResolvedValue([{ ...opt, subProductCount: 4 }]);
    render(
      <MainProductsScreen
        view={viewOf({
          categories: [opt],
          products: [
            // Out of order on purpose: the snapshot appends upserts.
            subProduct('p-4', 'c-opt', 'h', { name: '1111', sortOrder: 4 }),
            subProduct('p-2', 'c-opt', 'h', { name: 'MAGENTA', sortOrder: 2, label: 'Magenta' }),
            subProduct('p-1', 'c-opt', 'h', { name: '102 (9")', sortOrder: 1, label: 'White' }),
            subProduct('p-3', 'c-opt', 'h', { name: 'ORISSA', sortOrder: 3, multiColour: true }),
            subProduct('p-x', 'c-other', 'h', { name: 'Elsewhere', sortOrder: 1 }),
          ],
        })}
      />,
    );

    fireEvent.click(await screen.findByText('One Piece Toilet'));

    const names = ['102 (9")', 'MAGENTA', 'ORISSA', '1111'];
    const rows = names.map((name) => screen.getByText(name).closest('tr') as HTMLElement);
    expect(rows.every(Boolean)).toBe(true);
    // Document order is catalogue order.
    for (let index = 1; index < rows.length; index++) {
      expect(
        rows[index - 1]!.compareDocumentPosition(rows[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(screen.queryByText('Elsewhere')).toBeNull();

    // Fixed shows its colour; one that repeats the name, a numbered design and
    // nothing else show none; the multicolour one says so.
    expect(within(rows[0]!).getByText('White')).toBeTruthy();
    expect(within(rows[1]!).queryByText('Magenta')).toBeNull();
    expect(within(rows[2]!).getByText(t('catalog.colourRule.multicolour'))).toBeTruthy();
    expect(within(rows[3]!).queryByText(t('catalog.colourRule.multicolour'))).toBeNull();
  });

  it('refetches the counts when a sub product moves between products', async () => {
    const opt = category('c-opt', 'OPT', 'One Piece Toilet', null);
    const wb = category('c-wb', 'WB', 'Wash Basin', null);
    const before = viewOf({
      categories: [opt, wb],
      products: [subProduct('p-1', 'c-opt', 'hlc-1'), subProduct('p-2', 'c-opt', 'hlc-2')],
    });
    const { rerender } = render(<MainProductsScreen view={before} />);
    await waitFor(() => expect(api.categories).toHaveBeenCalledTimes(1));

    // Same number of sub products, one of them now under WB.
    rerender(
      <MainProductsScreen
        view={{
          ...before,
          products: [subProduct('p-1', 'c-wb', 'hlc-3'), subProduct('p-2', 'c-opt', 'hlc-2')],
        }}
      />,
    );

    await waitFor(() => expect(api.categories).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
});

describe('BrandsScreen', () => {
  it('lists the brands for a role with no list permission, read-only (1.4 D3)', async () => {
    api.fieldValues.mockResolvedValueOnce({ items: [brandOption('NewBrand')] } as never);
    render(<BrandsScreen view={viewOf({ permissions: ['products.view'] })} />);

    await waitFor(() => expect(api.fieldValues).toHaveBeenCalledWith('product.brand'));
    expect(screen.queryByRole('button', { name: t('fields.values.add') })).toBeNull();
  });

  it('offers Add with catalog.lists.manage (1.4 D3)', async () => {
    api.fieldValues.mockResolvedValueOnce({ items: [brandOption('NewBrand')] } as never);
    render(<BrandsScreen view={viewOf({ permissions: ['catalog.lists.manage'] })} />);
    expect(await screen.findByRole('button', { name: t('fields.values.add') })).toBeTruthy();
  });

  it('shows the editor to a role that holds fields.view', async () => {
    api.fieldValues.mockResolvedValueOnce({ items: [brandOption('NewBrand')] } as never);
    render(<BrandsScreen view={viewOf({ permissions: ['products.view', 'fields.view'] })} />);

    await waitFor(() => expect(api.fieldValues).toHaveBeenCalledWith('product.brand'));
  });

  it('reloads when the shell reports the option lists moved, as another desk edits a brand', async () => {
    const view = viewOf({ permissions: ['products.view', 'fields.view'] });
    const { rerender } = render(<BrandsScreen view={view} revision={1} />);
    await waitFor(() => expect(api.fieldValues).toHaveBeenCalledTimes(1));

    rerender(<BrandsScreen view={view} revision={2} />);
    await waitFor(() => expect(api.fieldValues).toHaveBeenCalledTimes(2));
  });
});
