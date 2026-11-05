/**
 * The shared catalogue screens the Master mounts (`SubProductsScreen`,
 * `MainProductsScreen`, `BrandsScreen`, `ProductDetail`, `ProductImages`,
 * `ProductImportModal`), driven over a fake `CatalogueTransport` the way
 * `master/web/src/screens/ProductsScreen.tsx` mounts them.
 *
 * Ported from `catalog-product-filter.test.tsx` and `main-products-screen.test.tsx`,
 * which run the Office's own copies and stay as they are. On top of those, the
 * cases the shared copy adds: controls absent without `products.create`,
 * `products.edit` and `products.bulk`, the detail's sub products read off the
 * view, and the import and photo flows through the transport.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OptionListItem,
  Product,
  ProductCategory,
  ProductImage,
} from '@orderbook/shared';

import type { CatalogueTransport, CatalogueView } from '../src/catalogueSummary.js';
import { FilterBarOutlet, FilterBarProvider } from '../src/FilterBarSlot.js';
import { t } from '../src/i18n.js';
import { MainProductsScreen, BrandsScreen } from '../src/MainProductsScreen.js';
import { ProductDetail } from '../src/ProductDetail.js';
import { ProductImages } from '../src/ProductImages.js';
import { SubProductsScreen } from '../src/SubProductsScreen.js';
import { ProductEditScreen } from '../src/ProductEditScreen.js';
import { KeyboardProvider } from '../src/KeyboardProvider.js';
import type { OptionListTransport } from '../src/OptionListEditor.js';
import { installBrowserStubs } from './panel-harness.js';

// The crop editor needs a canvas and an image decoder; jsdom has neither. The
// stub is a button that saves a fixed crop, which is all this suite needs of it.
vi.mock('../src/ImageCropModal.js', async () => {
  const { createElement } = await import('react');
  return {
    ImageCropModal: ({ open, onSave }: { open: boolean; onSave: (result: unknown) => void }) =>
      open
        ? createElement(
            'button',
            {
              onClick: () =>
                onSave({ cropX: 0, cropY: 0, cropWidth: 10, cropHeight: 10, rotationDeg: 0 }),
            },
            'crop-save',
          )
        : null,
  };
});

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

beforeEach(() => {
  installBrowserStubs();
});

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

function brandOption(value: string): OptionListItem {
  return {
    id: `b-${value}`,
    tenantId: 'tenant',
    listKey: 'product.brand',
    value,
    label: value,
    sequence: value === 'Swisware+' ? 1 : 2,
    isActive: true,
    hex: null,
    deletedAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  } as OptionListItem;
}

const SWISWARE = brandOption('Swisware+');
const OTHER = brandOption('Other');

/** A sub product: one variant, its label the fixed colour or null. */
function subProduct(
  id: string,
  categoryId: string,
  extra: {
    name?: string;
    code?: string;
    sortOrder?: number | null;
    label?: string | null;
    multiColour?: boolean;
    images?: ProductImage[];
  } = {},
): Product {
  return {
    id,
    name: extra.name ?? id,
    alias: null,
    categoryId,
    categoryName: 'stale',
    categoryCode: 'OLD',
    brand: 'Old brand',
    sortOrder: extra.sortOrder ?? null,
    size: null,
    multiColour: extra.multiColour ?? false,
    hasVariants: Boolean(extra.label),
    variants: [
      {
        id: `${id}-v`,
        code: extra.code ?? `${id}-code`,
        label: extra.label ?? null,
        isActive: true,
        weightKg: 5,
      },
    ],
    images: extra.images ?? [],
    sync: { hlc: 'hlc-1' },
  } as unknown as Product;
}

function viewOf(overrides: Partial<CatalogueView> = {}): CatalogueView {
  return {
    permissions: ['products.view'],
    optionLists: [SWISWARE, OTHER],
    categories: [OPT, WB],
    products: [],
    ...overrides,
  };
}

function makeTransport(overrides: Partial<CatalogueTransport> = {}) {
  const defaults = {
    listProducts: vi.fn(async (..._args: unknown[]) => ({
      items: [] as Product[],
      total: 0,
      limit: 100,
      offset: 0,
    })),
    categories: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    createCategory: vi.fn(async (..._args: unknown[]) => ({})),
    updateCategory: vi.fn(async (..._args: unknown[]) => ({})),
    deleteCategory: vi.fn(async (..._args: unknown[]) => ({})),
    createProduct: vi.fn(async (..._args: unknown[]) => ({ id: 'new' })),
    updateProduct: vi.fn(async (..._args: unknown[]) => ({})),
    uploadProductImage: vi.fn(async (..._args: unknown[]) => subProduct('p-1', 'c-opt')),
    updateProductImage: vi.fn(async (..._args: unknown[]) => subProduct('p-1', 'c-opt')),
    reorderProductImages: vi.fn(async (..._args: unknown[]) => subProduct('p-1', 'c-opt')),
    deleteProductImage: vi.fn(async (..._args: unknown[]) => subProduct('p-1', 'c-opt')),
    productImportTemplate: vi.fn(async (..._args: unknown[]) => ({
      blob: new Blob(['x']),
      fileName: 'products-template.csv',
    })),
    importProducts: vi.fn(async (..._args: unknown[]) => ({})),
  };
  return { ...defaults, ...overrides } as unknown as typeof defaults & CatalogueTransport;
}

function renderList(
  view: CatalogueView = viewOf(),
  transport: CatalogueTransport = makeTransport(),
) {
  return render(
    <FilterBarProvider>
      <FilterBarOutlet />
      <SubProductsScreen view={view} transport={transport} revision={0} />
    </FilterBarProvider>,
  );
}

describe('the sub-product list', () => {
  it('renders the product filter outside the clipping filter strip, and it still filters', async () => {
    const transport = makeTransport();
    const { container } = renderList(viewOf(), transport);

    const filter = await screen.findByRole('combobox', {
      name: t('catalog.products.productFilter'),
    });
    expect(container.querySelector('.ob-filterbar')).not.toBeNull();
    expect(filter.closest('.ob-filterbar')).toBeNull();

    fireEvent.focus(filter);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'One Piece Toilet' }));
    await waitFor(() =>
      expect(transport.listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ categoryId: 'c-opt' }),
        expect.anything(),
      ),
    );
  });

  it('clears a product of another brand when a brand chip is chosen', async () => {
    const transport = makeTransport();
    renderList(viewOf(), transport);
    await waitFor(() => expect(transport.listProducts).toHaveBeenCalled());

    const filter = screen.getByRole('combobox', { name: t('catalog.products.productFilter') });
    fireEvent.focus(filter);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'One Piece Toilet' }));
    await waitFor(() =>
      expect(transport.listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ categoryId: 'c-opt' }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    await waitFor(() =>
      expect(transport.listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ brand: 'Other', categoryId: undefined }),
        expect.anything(),
      ),
    );

    fireEvent.focus(screen.getByRole('combobox', { name: t('catalog.products.productFilter') }));
    expect(screen.getByRole('option', { name: 'Wash Basin' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'One Piece Toilet' })).toBeNull();
  });

  it('reads each row as the catalogue does: CODE · Name, the brand and the colour by its rule', async () => {
    const transport = makeTransport({
      listProducts: vi.fn(async () => ({
        items: [
          subProduct('p-white', 'c-opt', { name: '102 (9")', label: 'White' }),
          subProduct('p-orissa', 'c-opt', { name: 'ORISSA', multiColour: true }),
          subProduct('p-1111', 'c-opt', { name: '1111' }),
        ],
        total: 3,
        limit: 100,
        offset: 0,
      })),
    });
    renderList(viewOf(), transport);

    await screen.findByText('1111');
    const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

    for (const name of ['102 (9")', 'ORISSA', '1111']) {
      expect(row(name).textContent).toContain('One Piece Toilet');
      // The main-product code is its own column, never part of the product's name (R14).
      expect(row(name).textContent).not.toMatch(/OPT\s*[·-]\s*One Piece/);
      expect(row(name).textContent).toContain('Swisware+');
      // The row's own joined copy is stale on purpose: the category wins.
      expect(row(name).textContent).not.toContain('Old brand');
    }
    expect(row('102 (9")').textContent).toContain('White');
    expect(row('ORISSA').textContent).toContain(t('catalog.colourRule.multicolour'));
    expect(row('1111').textContent).not.toContain(t('catalog.colourRule.multicolour'));
  });

  it('has no stock column', async () => {
    const transport = makeTransport({
      listProducts: vi.fn(async () => ({
        items: [subProduct('p-1', 'c-opt', { name: 'ORISSA' })],
        total: 1,
        limit: 100,
        offset: 0,
      })),
    });
    renderList(viewOf(), transport);
    await screen.findByText('ORISSA');
    expect(screen.queryByText(/stock/i)).toBeNull();
  });

  it('offers no New or Import without products.create / products.bulk, and no Edit or photo controls without products.edit', async () => {
    const transport = makeTransport({
      listProducts: vi.fn(async () => ({
        items: [
          subProduct('p-1', 'c-opt', {
            name: 'Aqua',
            images: [
              {
                id: 'img-1',
                productId: 'p-1',
                caption: null,
                isPrimary: true,
                sequence: 1,
                width: 10,
                height: 10,
                checksum: 'x',
                blurhash: '',
                byteSize: 1,
                uploadedAt: STAMP,
              },
            ],
          }),
        ],
        total: 1,
        limit: 100,
        offset: 0,
      })),
    });
    renderList(viewOf({ permissions: ['products.view'] }), transport);

    fireEvent.click(await screen.findByText('Aqua'));
    await screen.findByText(t('product.detail.detailsTitle'));

    expect(screen.queryByRole('button', { name: t('catalog.products.new') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('catalog.products.import') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('product.detail.editAction') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('photo.change') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('photo.remove') })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('offers New on the list while intake lives on the conflicts screen', async () => {
    renderList(
      viewOf({ permissions: ['products.view', 'products.create', 'products.bulk'] }),
      makeTransport(),
    );

    expect(
      await screen.findAllByRole('button', { name: t('catalog.products.new') }),
    ).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: t('catalog.products.import') })).toBeNull();
  });
});

describe('Clear filters on the sub-product list (1.4 rework)', () => {
  it('clears the search, the brand chip, the product and the size together', async () => {
    const transport = makeTransport();
    renderList(viewOf(), transport);
    await waitFor(() => expect(transport.listProducts).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('searchbox', { name: t('catalog.products.searchLabel') }), {
      target: { value: 'damru' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    fireEvent.change(screen.getByLabelText(t('listFilter.size')), { target: { value: '600x600' } });
    await waitFor(() =>
      expect(transport.listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'damru', brand: 'Other', size: '600x600' }),
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: t('listFilter.clear') }));
    await waitFor(() =>
      expect(transport.listProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: undefined,
          brand: undefined,
          categoryId: undefined,
          size: undefined,
        }),
        expect.anything(),
      ),
    );
    expect(
      (screen.getByRole('searchbox', { name: t('catalog.products.searchLabel') }) as HTMLInputElement)
        .value,
    ).toBe('');
    expect((screen.getByLabelText(t('listFilter.size')) as HTMLInputElement).value).toBe('');
  });
});

describe('the Products page', () => {
  it('saves an edit without re-asserting a brand retired since it was set', async () => {
    // WB is still under OldBrand, which the Brands page has since retired.
    const wb = category('c-wb', 'WB', 'Wash Basin', 'OldBrand');
    const transport = makeTransport({
      categories: vi.fn(async () => [{ ...wb, subProductCount: 0 }]),
    });
    render(
      <MainProductsScreen
        view={viewOf({
          optionLists: [brandOption('NewBrand')],
          permissions: ['products.view', 'products.edit'],
          categories: [wb],
        })}
        transport={transport}
        revision={0}
      />,
    );

    fireEvent.click(await screen.findByText('Wash Basin'));
    fireEvent.click(screen.getByRole('button', { name: t('action.edit') }));
    fireEvent.change(screen.getByLabelText(t('catalog.mainProducts.field.sortOrder')), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));

    await waitFor(() => expect(transport.updateCategory).toHaveBeenCalledTimes(1));
    const [id, patch] = transport.updateCategory.mock.calls[0] as unknown as [string, object];
    expect(id).toBe('c-wb');
    expect(patch).toMatchObject({ code: 'WB', name: 'Wash Basin', sortOrder: 6 });
    expect(patch).not.toHaveProperty('brand');
  });

  it('lists the sub products of an open product, from view.products, in catalogue order', async () => {
    const transport = makeTransport({
      categories: vi.fn(async () => [{ ...OPT, subProductCount: 4 }]),
    });
    render(
      <MainProductsScreen
        view={viewOf({
          categories: [OPT],
          products: [
            // Out of order on purpose: nothing arrives in catalogue order by itself.
            subProduct('p-4', 'c-opt', { name: '1111', sortOrder: 4 }),
            subProduct('p-2', 'c-opt', { name: 'MAGENTA', sortOrder: 2, label: 'Magenta' }),
            subProduct('p-1', 'c-opt', { name: '102 (9")', sortOrder: 1, label: 'White' }),
            subProduct('p-3', 'c-opt', { name: 'ORISSA', sortOrder: 3, multiColour: true }),
            subProduct('p-x', 'c-other', { name: 'Elsewhere', sortOrder: 1 }),
          ],
        })}
        transport={transport}
        revision={0}
      />,
    );

    fireEvent.click(await screen.findByText('One Piece Toilet'));

    const names = ['102 (9")', 'MAGENTA', 'ORISSA', '1111'];
    const rows = names.map((name) => screen.getByText(name).closest('tr') as HTMLElement);
    for (let index = 1; index < rows.length; index++) {
      expect(
        rows[index - 1]!.compareDocumentPosition(rows[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(within(rows[0]!).getByText('White')).toBeTruthy();
    expect(within(rows[2]!).getByText(t('catalog.colourRule.multicolour'))).toBeTruthy();
  });

  it('reads the list again when the host says the catalogue moved', async () => {
    const transport = makeTransport();
    const view = viewOf();
    const { rerender } = render(
      <MainProductsScreen view={view} transport={transport} revision={1} />,
    );
    await waitFor(() => expect(transport.categories).toHaveBeenCalledTimes(1));

    rerender(<MainProductsScreen view={view} transport={transport} revision={2} />);
    await waitFor(() => expect(transport.categories).toHaveBeenCalledTimes(2));
  });
});

describe('the Brands page', () => {
  function optionTransport() {
    const fail = vi.fn(async () => {
      throw new Error('Missing permission: fields.view');
    });
    return {
      fieldValues: fail,
      fieldUsage: fail,
      createFieldValue: vi.fn(),
      updateFieldValue: vi.fn(),
      deleteFieldValue: vi.fn(),
      reorderFieldValues: vi.fn(),
      conflictOf: () => null,
    } as unknown as OptionListTransport & { fieldValues: ReturnType<typeof vi.fn> };
  }

  it('lists the brands for a role with no list permission, read-only: no Add button that would answer 403', async () => {
    const transport = optionTransport();
    render(<BrandsScreen permissions={['products.view']} transport={transport} />);

    await waitFor(() => expect(transport.fieldValues).toHaveBeenCalledWith('product.brand'));
    expect(screen.queryByRole('button', { name: t('fields.values.add') })).toBeNull();
  });

  it('offers Add with catalog.lists.manage, and not with fields.manage alone', async () => {
    const manager = optionTransport();
    const { unmount } = render(
      <BrandsScreen permissions={['catalog.lists.manage']} transport={manager} />,
    );
    expect(await screen.findByRole('button', { name: t('fields.values.add') })).toBeTruthy();
    unmount();

    const fieldsOnly = optionTransport();
    render(<BrandsScreen permissions={['fields.view', 'fields.manage']} transport={fieldsOnly} />);
    await waitFor(() => expect(fieldsOnly.fieldValues).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: t('fields.values.add') })).toBeNull();
  });

  it('shows the editor to a role that holds fields.view, and reloads when the lists moved', async () => {
    const transport = optionTransport();
    const permissions = ['products.view', 'fields.view'];
    const { rerender } = render(
      <BrandsScreen permissions={permissions} transport={transport} revision={1} />,
    );
    await waitFor(() => expect(transport.fieldValues).toHaveBeenCalledWith('product.brand'));
    const calls = transport.fieldValues.mock.calls.length;

    rerender(<BrandsScreen permissions={permissions} transport={transport} revision={2} />);
    await waitFor(() => expect(transport.fieldValues.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe('the photo card', () => {
  const COVER: ProductImage = {
    id: 'img-1',
    productId: 'p-1',
    caption: null,
    isPrimary: true,
    sequence: 1,
    width: 10,
    height: 10,
    checksum: 'x',
    blurhash: '',
    byteSize: 1,
    uploadedAt: STAMP,
  };

  it('makes the upload from Change photo the cover', async () => {
    const withCover = subProduct('p-1', 'c-opt', { images: [COVER] });
    const added = { ...COVER, id: 'img-2', isPrimary: false, sequence: 2 };
    const uploaded = { ...withCover, images: [COVER, added] } as Product;
    const transport = makeTransport({
      uploadProductImage: vi.fn(async () => uploaded),
      updateProductImage: vi.fn(async () => ({
        ...uploaded,
        images: [
          { ...COVER, isPrimary: false },
          { ...added, isPrimary: true },
        ],
      })),
    });
    const onChanged = vi.fn();

    render(
      <ProductImages
        product={withCover}
        transport={transport}
        canEdit
        onChanged={onChanged}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: t('photo.change') }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'tile.png', { type: 'image/png' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'crop-save' }));

    await waitFor(() => expect(transport.uploadProductImage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(transport.updateProductImage).toHaveBeenCalledWith('p-1', 'img-2', {
        isPrimary: true,
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('shows the photos and changes none without products.edit', () => {
    const withCover = subProduct('p-1', 'c-opt', { images: [COVER] });
    render(
      <ProductImages
        product={withCover}
        transport={makeTransport()}
        canEdit={false}
        onChanged={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: t('photo.change') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('photo.remove') })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('the detail', () => {
  it('shows the Edit button only with canEdit', () => {
    const product = subProduct('p-1', 'c-opt', { name: 'Aqua' });
    const common = {
      product,
      transport: makeTransport(),
      colourHex: () => undefined,
      onEdit: () => undefined,
      onPhotosChanged: () => undefined,
      onError: () => undefined,
    };
    const { rerender } = render(<ProductDetail {...common} canEdit={false} />);
    expect(screen.queryByRole('button', { name: t('product.detail.editAction') })).toBeNull();

    rerender(<ProductDetail {...common} canEdit />);
    expect(screen.getByRole('button', { name: t('product.detail.editAction') })).toBeTruthy();
  });
});

describe('the product edit screen', () => {
  it('saves the drawer field set through updateProduct', async () => {
    const product = subProduct('p-1', 'c-opt', { name: 'Aqua', code: 'AQ-1' });
    const transport = makeTransport();
    const onSaved = vi.fn();
    render(
      <KeyboardProvider panel="master">
        <ProductEditScreen
          product={product}
          categories={[OPT, WB]}
          optionLists={[SWISWARE, OTHER]}
          transport={transport}
          onSaved={onSaved}
          onCancel={vi.fn()}
          onError={vi.fn()}
        />
      </KeyboardProvider>,
    );
    fireEvent.change(screen.getByLabelText(new RegExp(t('product.field.name'))), {
      target: { value: 'Aqua Plus' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('product.saveChanges') }));
    await waitFor(() => expect(transport.updateProduct).toHaveBeenCalledTimes(1));
    expect(transport.updateProduct.mock.calls[0]?.[0]).toBe('p-1');
    expect(transport.updateProduct.mock.calls[0]?.[1]).toMatchObject({ name: 'Aqua Plus' });
    expect(onSaved).toHaveBeenCalledWith('Aqua Plus');
  });
});
