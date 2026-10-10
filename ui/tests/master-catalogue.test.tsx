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
  ProductRestoreJob,
  ProductZipReport,
} from '@orderbook/shared';

import type { CatalogueTransport, CatalogueView } from '../src/catalogueSummary.js';
import { FilterBarOutlet, FilterBarProvider } from '../src/FilterBarSlot.js';
import { t } from '../src/i18n.js';
import { MainProductsScreen, BrandsScreen } from '../src/MainProductsScreen.js';
import { ProductDetail } from '../src/ProductDetail.js';
import { ProductImages } from '../src/ProductImages.js';
import { ProductImportModal } from '../src/ProductImportModal.js';
import { SubProductsScreen } from '../src/SubProductsScreen.js';
import type { OptionListTransport } from '../src/OptionListEditor.js';
import { installBrowserStubs } from './panel-harness.js';

// The crop editor needs a canvas and an image decoder; jsdom has neither. The
// stub is a button that saves a fixed crop, which is all this suite needs of it.
vi.mock('../src/ImageCropModal.js', async () => {
  const { createElement } = await import('react');
  return {
    ImageCropModal: ({
      open,
      onSave,
    }: {
      open: boolean;
      onSave: (result: unknown) => void;
    }) =>
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

  it('offers them to a role holding the permissions', async () => {
    renderList(
      viewOf({ permissions: ['products.view', 'products.create', 'products.bulk'] }),
      makeTransport(),
    );

    expect(await screen.findAllByRole('button', { name: t('catalog.products.new') })).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: t('catalog.products.import') })).toBeTruthy();
  });
});

describe('Clear filters on the sub-product list (1.4 rework)', () => {
  it('clears the search, the brand chip, the product and the size together', async () => {
    const transport = makeTransport();
    renderList(viewOf(), transport);
    await waitFor(() => expect(transport.listProducts).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox', { name: t('catalog.products.searchLabel') }), {
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
      (screen.getByRole('textbox', { name: t('catalog.products.searchLabel') }) as HTMLInputElement).value,
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

describe('the import dialog', () => {
  const RESULT = {
    dryRun: true,
    mode: 'create' as const,
    fileName: 'products.csv',
    totalRows: 2,
    created: 2,
    updated: 0,
    skipped: 0,
    failed: 0,
    issues: [],
    issuesTruncated: false,
    ignoredColumns: [],
    sample: [],
  };

  it('previews with a dry run, imports on confirm, and tells the host', async () => {
    const importProducts = vi.fn(async (_file: File, options: { dryRun: boolean }) => ({
      ...RESULT,
      dryRun: options.dryRun,
    }));
    const transport = makeTransport({ importProducts });
    const onImported = vi.fn();

    render(
      <ProductImportModal
        open
        transport={transport}
        onClose={() => undefined}
        onImported={onImported}
        onError={() => undefined}
      />,
    );

    const file = new File(['categoryName,name,code\r\nA,B,C\r\n'], 'products.csv', {
      type: 'text/csv',
    });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(importProducts).toHaveBeenCalledTimes(1));
    expect(importProducts.mock.calls[0]![1]).toMatchObject({ dryRun: true, mode: 'create' });
    expect(onImported).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: t('import.confirm', { count: 2 }) }));

    await waitFor(() => expect(importProducts).toHaveBeenCalledTimes(2));
    expect(importProducts.mock.calls[1]![1]).toMatchObject({ dryRun: false, mode: 'create' });
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });

  it('shows the translated message when the preview is refused', async () => {
    const refused = Object.assign(new Error('Missing permission'), {
      code: 'forbidden',
      messageKey: 'validation.import.fileRequired',
    });
    const transport = makeTransport({
      importProducts: vi.fn(async () => {
        throw refused;
      }),
    });
    render(
      <ProductImportModal
        open
        transport={transport}
        onClose={() => undefined}
        onImported={() => undefined}
        onError={() => undefined}
      />,
    );

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'p.csv', { type: 'text/csv' })] },
    });
    expect(await screen.findByText(t('validation.import.fileRequired'))).toBeTruthy();
  });
});

describe('the import dialog: guards, problems and export', () => {
  const BASE = {
    dryRun: true,
    mode: 'create' as const,
    fileName: 'p.csv',
    totalRows: 3,
    created: 2,
    updated: 0,
    skipped: 0,
    failed: 1,
    issues: [
      { row: 4, kind: 'error' as const, messageKey: 'validation.import.fileRequired' as const },
    ],
    issuesTruncated: false,
    ignoredColumns: [],
    sample: [],
  };

  function open(transport: CatalogueTransport, onError = vi.fn()) {
    render(
      <ProductImportModal
        open
        transport={transport}
        onClose={() => undefined}
        onImported={() => undefined}
        onError={onError}
      />,
    );
    return onError;
  }

  it('refuses a wrong extension and an empty file before asking the server', async () => {
    const importProducts = vi.fn(async () => BASE);
    open(makeTransport({ importProducts }));
    const input = () => document.querySelector('input[type="file"]')!;

    fireEvent.change(input(), { target: { files: [new File(['x'], 'p.pdf')] } });
    expect(await screen.findByText(t('validation.import.unsupportedFormat'))).toBeTruthy();
    fireEvent.change(input(), { target: { files: [new File([], 'p.csv')] } });
    expect(await screen.findByText(t('validation.import.emptyFile'))).toBeTruthy();
    expect(importProducts).not.toHaveBeenCalled();
  });

  it('shows the row-numbered problems, the left-out count, and downloads the report', async () => {
    const importProducts = vi.fn(async () => BASE);
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    open(makeTransport({ importProducts }));

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'p.csv')] },
    });
    expect(await screen.findByText(t('import.preview.partial', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('import.report.download') }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('shows the unchanged count so an unedited round trip is not silent', async () => {
    const importProducts = vi.fn(async () => ({
      ...BASE,
      created: 0,
      failed: 0,
      issues: [],
      unchanged: 5,
    }));
    open(makeTransport({ importProducts }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'p.csv')] },
    });
    expect(await screen.findByText(t('import.unchanged', { count: 5 }))).toBeTruthy();
    expect(screen.queryByText(t('import.preview.nothing'))).toBeNull();
  });

  it('shows a server message key with its params (too many rows)', async () => {
    const refused = Object.assign(new Error('x'), {
      code: 'validation_failed',
      messageKey: 'validation.import.tooManyRows',
      params: { max: 20000 },
    });
    open(
      makeTransport({
        importProducts: vi.fn(async () => {
          throw refused;
        }),
      }),
    );
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'p.csv')] },
    });
    expect(
      await screen.findByText(t('validation.import.tooManyRows', { max: 20000 })),
    ).toBeTruthy();
  });

  it('does not import a file with nothing importable', async () => {
    const importProducts = vi.fn(async () => ({ ...BASE, created: 0 }));
    open(makeTransport({ importProducts }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'p.csv')] },
    });
    const confirm = await screen.findByRole('button', { name: t('import.confirm', { count: 0 }) });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('exports through the transport and reports a failure', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const exportProducts = vi
      .fn()
      .mockResolvedValueOnce({ blob: new Blob(['a']), fileName: 'products.csv' })
      .mockRejectedValueOnce(new Error('boom'));
    const onError = open(makeTransport({ exportProducts }));

    fireEvent.click(screen.getByRole('button', { name: t('import.export.csv') }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(exportProducts).toHaveBeenCalledWith('csv');

    fireEvent.click(screen.getByRole('button', { name: t('import.export.csv') }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
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
        images: [{ ...COVER, isPrimary: false }, { ...added, isPrimary: true }],
      })),
    });
    const onChanged = vi.fn();

    render(
      <ProductImages product={withCover} transport={transport} canEdit onChanged={onChanged} onError={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: t('photo.change') }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'tile.png', { type: 'image/png' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'crop-save' }));

    await waitFor(() => expect(transport.uploadProductImage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(transport.updateProductImage).toHaveBeenCalledWith('p-1', 'img-2', { isPrimary: true }),
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

describe('the product backup zip (Master only)', () => {
  const ALL = ['products.view', 'products.export', 'products.bulk', 'products.create', 'products.edit', 'products.delete'];

  function zipReport(overrides: Partial<ProductZipReport> = {}): ProductZipReport {
    return {
      dryRun: true,
      fileName: 'backup.zip',
      mainProducts: { added: [{ code: 'NEW', name: 'New range', brand: null }], renamed: [] },
      products: {
        dryRun: true,
        mode: 'upsert',
        fileName: 'products.csv',
        totalRows: 549,
        created: 0,
        updated: 1,
        unchanged: 548,
        skipped: 0,
        failed: 0,
        issues: [],
        issuesTruncated: false,
        ignoredColumns: [],
        sample: [],
      },
      rows: {
        added: [],
        changed: [{ code: 'OPT-0003', name: '103', fields: [{ column: 'Size', from: '10x10', to: '99x99' }] }],
        notInFile: [{ code: 'OPT-0004', name: '104' }],
      },
      colours: { added: [], changed: [] },
      photos: {
        added: [],
        replaced: ['OPT-0002.jpg'],
        unchanged: 2,
        unmatched: [],
        duplicate: [],
        notImage: [],
        notInZip: ['OPT-0001_2'],
      },
      problems: [],
      ...overrides,
    };
  }

  function zipTransport() {
    return {
      exportZip: vi.fn(async () => ({ blob: new Blob(['PK']), fileName: 'OrderBook-Products-x.zip' })),
      preview: vi.fn(async (_file: File, _options: unknown) => zipReport()),
      start: vi.fn(async (_file: File, _options: unknown) => ({
        id: 'job-1',
        phase: 'checking' as const,
        done: 0,
        total: 0,
        startedAt: STAMP,
      })),
      job: vi.fn(async (): Promise<ProductRestoreJob | null> => null),
    };
  }

  it('offers Backup with products.export and Restore with the import permissions, on a panel that has the zip', async () => {
    const productZip = zipTransport();
    const { unmount } = renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));
    expect(await screen.findByRole('button', { name: t('productZip.backup') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('productZip.restore') })).toBeTruthy();
    unmount();

    // A viewer, and a panel without the zip (the Office), see neither.
    const viewer = renderList(viewOf({ permissions: ['products.view'] }), makeTransport({ productZip }));
    await screen.findByRole('button', { name: t('catalog.export') });
    expect(screen.queryByRole('button', { name: t('productZip.backup') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('productZip.restore') })).toBeNull();
    viewer.unmount();

    renderList(viewOf({ permissions: ALL }), makeTransport());
    await screen.findByRole('button', { name: t('catalog.export') });
    expect(screen.queryByRole('button', { name: t('productZip.backup') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('productZip.restore') })).toBeNull();
  });

  it('saves the backup the Master builds', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const productZip = zipTransport();
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));

    fireEvent.click(await screen.findByRole('button', { name: t('productZip.backup') }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(productZip.exportZip).toHaveBeenCalledTimes(1);
  });

  it('previews the zip, applies it with the opt-in ticked, follows the job and refetches', async () => {
    const productZip = zipTransport();
    productZip.job
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'job-1', phase: 'photos', done: 1, total: 2, startedAt: STAMP })
      .mockResolvedValue({
        id: 'job-1',
        phase: 'done',
        done: 2,
        total: 2,
        startedAt: STAMP,
        finishedAt: STAMP,
        result: zipReport({ dryRun: false, binned: 1, photosRemoved: 0 }),
      });
    const transport = makeTransport({ productZip });
    renderList(viewOf({ permissions: ALL }), transport);

    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    const input = await screen.findByTestId('product-zip-file');

    // Neither a zip nor a products sheet: refused here, the Master never asked.
    expect(input.getAttribute('accept')).toBe('.zip,.csv,.xlsx,application/zip');
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt')] } });
    expect(await screen.findByText(t('validation.productZip.fileRequired'))).toBeTruthy();
    expect(productZip.preview).not.toHaveBeenCalled();

    const file = new File(['PK'], 'backup.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(t('productZip.item.changed', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('OPT-0003 — 103: Size: 10x10 → 99x99')).toBeTruthy();
    expect(screen.getByText('NEW — New range')).toBeTruthy();
    expect(screen.getByText(t('productZip.item.replaced', { count: 1 }))).toBeTruthy();
    expect(screen.getByText(t('productZip.reportOnly'))).toBeTruthy();

    // Both removals are off until ticked.
    const bin = screen.getByLabelText(t('productZip.opt.bin', { count: 1 })) as HTMLInputElement;
    const photos = screen.getByLabelText(t('productZip.opt.photos', { count: 1 })) as HTMLInputElement;
    expect(bin.checked).toBe(false);
    expect(photos.checked).toBe(false);
    fireEvent.click(bin);

    const listCalls = transport.listProducts.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: t('productZip.apply') }));
    await waitFor(() => expect(productZip.start).toHaveBeenCalledWith(file, { binMissingProducts: true }));

    expect(await screen.findByText(t('productZip.photoProgress', { done: 1, total: 2 }))).toBeTruthy();
    expect(await screen.findByText(t('productZip.done'))).toBeTruthy();
    expect(screen.getByText(t('productZip.done.binned', { count: 1 }))).toBeTruthy();
    await waitFor(() => expect(transport.listProducts.mock.calls.length).toBeGreaterThan(listCalls));
  });

  it('offers no Recycle Bin opt-in without products.delete, and no Apply when the zip changes nothing', async () => {
    const productZip = zipTransport();
    productZip.preview.mockResolvedValue(
      zipReport({
        mainProducts: { added: [], renamed: [] },
        products: { ...zipReport().products, updated: 0, unchanged: 549 },
        rows: { added: [], changed: [], notInFile: [{ code: 'OPT-0004', name: '104' }] },
        photos: { ...zipReport().photos, replaced: [], notInZip: [] },
      }),
    );
    renderList(viewOf({ permissions: ALL.filter((key) => key !== 'products.delete') }), makeTransport({ productZip }));

    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });

    expect(await screen.findByText(t('productZip.nothing'))).toBeTruthy();
    expect(screen.queryByLabelText(t('productZip.opt.bin', { count: 1 }))).toBeNull();
    // No box to tick, so no "tick it below".
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(t('productZip.reportOnly.noTick'))).toBeTruthy();
    expect(screen.queryByText(t('productZip.reportOnly'))).toBeNull();
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what the exact catalogue took out only when it took something out', async () => {
    const productZip = zipTransport();
    productZip.job
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'job-1',
        phase: 'done',
        done: 0,
        total: 0,
        startedAt: STAMP,
        finishedAt: STAMP,
        result: zipReport({
          dryRun: false,
          binned: 1,
          photosRemoved: 0,
          exactRemoved: { mainProducts: 0, colours: 0, brands: 0 },
        }),
      });
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));
    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });
    const exact = (await screen.findByLabelText(t('productZip.opt.exact'))) as HTMLInputElement;
    fireEvent.click(exact);
    await waitFor(() => expect(exact.checked).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: t('productZip.apply') }));

    expect(await screen.findByText(t('productZip.done.binned', { count: 1 }), {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(t('productZip.done.exact', { mainProducts: 0, colours: 0, brands: 0 }))).toBeNull();
  });

  it('lists captions and main photos the zip puts back, and offers Apply for those alone', async () => {
    const productZip = zipTransport();
    productZip.preview.mockResolvedValue(
      zipReport({
        mainProducts: { added: [], renamed: [] },
        products: { ...zipReport().products, updated: 0, unchanged: 549 },
        rows: { added: [], changed: [], notInFile: [] },
        photos: {
          ...zipReport().photos,
          replaced: [],
          notInZip: [],
          recaptioned: ['PRB-0009.webp'],
          reordered: ['PRB-0010'],
        },
      }),
    );
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));

    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });

    expect(await screen.findByText(t('productZip.item.recaptioned', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('PRB-0009.webp')).toBeTruthy();
    expect(screen.getByText(t('productZip.item.reordered', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('PRB-0010')).toBeTruthy();
    expect(screen.queryByText(t('productZip.nothing'))).toBeNull();
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists what the exact catalogue takes out, offers it with products.delete, and sends it implying both removals', async () => {
    const productZip = zipTransport();
    const base = zipReport();
    productZip.preview.mockResolvedValue(
      zipReport({
        mainProducts: {
          added: [],
          renamed: [],
          notInFile: [{ code: 'MER', name: 'Merchandise', brand: 'Swisware+' }],
        },
        products: {
          ...base.products,
          updated: 0,
          failed: 3,
          issues: [
            { row: 4, kind: 'error', column: 'Code', messageKey: 'validation.import.binnedNeedsDelete', params: { name: 'Damru' } },
            { row: 5, kind: 'error', column: 'Code', messageKey: 'validation.product.restoreCodesTaken', params: { codes: 'WB-0002' } },
            {
              row: 7,
              kind: 'error',
              column: 'Size',
              messageKey: 'validation.import.subProductCellsDiffer',
              params: { name: 'Duo', column: 'Size', firstRow: 6 },
            },
          ],
        },
        rows: {
          added: [],
          changed: [],
          notInFile: [{ code: 'OPT-0003', name: '103' }],
          variantsNotInFile: [{ code: 'WB-0002', name: 'Damru' }],
          restoredFromBin: [{ code: 'OPT-0009', name: '109', fields: [] }],
          reordered: [{ code: 'WB', name: 'Wash Basin' }],
        },
        colours: { added: [], changed: [], noFile: true },
        brands: { added: [], changed: [], notInFile: ['Swisware+'] },
        photos: { ...base.photos, replaced: [], notInZip: ['OPT-0002'] },
      }),
    );
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));

    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    const file = new File(['PK'], 'backup.zip');
    fireEvent.change(await screen.findByTestId('product-zip-file'), { target: { files: [file] } });

    expect(await screen.findByText(t('productZip.item.mainNotInFile', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('MER — Merchandise')).toBeTruthy();
    expect(screen.getByText(t('productZip.item.variantsNotInFile', { count: 1 }))).toBeTruthy();
    expect(screen.getByText(t('productZip.item.restoredFromBin', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('OPT-0009 — 109')).toBeTruthy();
    expect(screen.getByText(t('productZip.item.rowsReordered', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('WB — Wash Basin')).toBeTruthy();
    expect(screen.getByText(t('productZip.item.listNotInFile', { count: 1 }))).toBeTruthy();
    expect(screen.getByText(t('productZip.item.noColoursFile'))).toBeTruthy();
    // Each refusal the import can now give reads as a sentence, never as its key.
    expect(screen.getByText(`${t('import.column.row')} 4 (Code): Damru is in the Recycle Bin — bringing it back needs the Delete products permission`)).toBeTruthy();
    expect(screen.getByText(`${t('import.column.row')} 5 (Code): Cannot restore — another product now uses WB-0002`)).toBeTruthy();
    // The column is said once, before the sentence.
    expect(screen.getByText(new RegExp(`^${t('import.column.row')} 7 \\(Size\\): Differs from row 6 of Duo\\.`))).toBeTruthy();

    // A reorder alone is something to apply; the exact catalogue is off until ticked.
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(false);
    const exact = screen.getByLabelText(t('productZip.opt.exact')) as HTMLInputElement;
    expect(exact.checked).toBe(false);
    expect(screen.getByText(t('productZip.opt.exact.hint'))).toBeTruthy();
    // The zip has photos: only the colour list stays.
    expect(screen.getByText(t('productZip.opt.exact.keepsColours'))).toBeTruthy();
    expect(screen.queryByText(t('productZip.opt.exact.keepsPhotos'))).toBeNull();
    fireEvent.click(exact);
    await waitFor(() => expect(exact.checked).toBe(true));
    const bin = screen.getByLabelText(t('productZip.opt.bin', { count: 1 })) as HTMLInputElement;
    const photos = screen.getByLabelText(t('productZip.opt.photos', { count: 1 })) as HTMLInputElement;
    expect([bin.checked, bin.disabled, photos.checked, photos.disabled]).toEqual([true, true, true, true]);

    fireEvent.click(screen.getByRole('button', { name: t('productZip.apply') }));
    await waitFor(() => expect(productZip.start).toHaveBeenCalledWith(file, { exactCatalogue: true }));
  });

  it('offers no exact catalogue without products.delete, and counts what only it takes out when ticked', async () => {
    const productZip = zipTransport();
    const nothing = zipReport({
      mainProducts: { added: [], renamed: [], notInFile: [{ code: 'MER', name: 'Merchandise', brand: null }] },
      products: { ...zipReport().products, updated: 0, unchanged: 549 },
      rows: { added: [], changed: [], notInFile: [] },
      colours: { added: [], changed: [], notInFile: ['Rustic Alpine Blue'], switchedOff: true },
      photos: { ...zipReport().photos, replaced: [], notInZip: [] },
    });
    productZip.preview.mockResolvedValue(nothing);
    const limited = renderList(
      viewOf({ permissions: ALL.filter((key) => key !== 'products.delete') }),
      makeTransport({ productZip }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });
    expect(await screen.findByText(t('productZip.nothing'))).toBeTruthy();
    expect(screen.queryByLabelText(t('productZip.opt.exact'))).toBeNull();
    limited.unmount();

    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));
    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });
    const exact = (await screen.findByLabelText(t('productZip.opt.exact'))) as HTMLInputElement;
    expect(screen.getByText(t('productZip.opt.exact.switchedOff'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(exact);
    await waitFor(() =>
      expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('says under the exact catalogue that a file with no colours.csv or no photos leaves those as they are', async () => {
    const productZip = zipTransport();
    // A bare products sheet 1.2.4-1.4.6 saved: no colours.csv, no photos.
    productZip.preview.mockResolvedValue(
      zipReport({
        fileName: 'products-2026-10-07.csv',
        colours: { added: [], changed: [], noFile: true },
        photos: { ...zipReport().photos, replaced: [], notInZip: [], noFile: true },
      }),
    );
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));
    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['Brand'], 'products-2026-10-07.csv')] },
    });

    expect(await screen.findByLabelText(t('productZip.opt.exact'))).toBeTruthy();
    expect(screen.getByText(t('productZip.opt.exact.keepsColours'))).toBeTruthy();
    expect(screen.getByText(t('productZip.opt.exact.keepsPhotos'))).toBeTruthy();
  });

  it('previews again whenever the exact catalogue is ticked or unticked, says it is reading, and keeps the other ticks', async () => {
    const productZip = zipTransport();
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));
    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    const file = new File(['PK'], 'backup.zip');
    fireEvent.change(await screen.findByTestId('product-zip-file'), { target: { files: [file] } });

    const bin = (await screen.findByLabelText(t('productZip.opt.bin', { count: 1 }))) as HTMLInputElement;
    fireEvent.click(bin);
    const exact = screen.getByLabelText(t('productZip.opt.exact')) as HTMLInputElement;
    fireEvent.click(exact);
    expect(screen.getByText(t('productZip.checking'))).toBeTruthy();
    expect(exact.disabled).toBe(true);
    await waitFor(() => expect(exact.checked).toBe(true));
    expect(productZip.preview).toHaveBeenLastCalledWith(file, { binMissingProducts: true, exactCatalogue: true });

    fireEvent.click(exact);
    await waitFor(() => expect(exact.checked).toBe(false));
    expect(productZip.preview).toHaveBeenLastCalledWith(file, { binMissingProducts: true, exactCatalogue: false });
    expect(bin.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('productZip.apply') }));
    await waitFor(() =>
      expect(productZip.start).toHaveBeenCalledWith(file, { binMissingProducts: true, exactCatalogue: false }),
    );
  });

  it('shows the exact catalogue locked, and why, to a person who may not take colours or brands out', async () => {
    const productZip = zipTransport();
    productZip.preview.mockResolvedValue(
      zipReport({
        mainProducts: { added: [], renamed: [] },
        products: { ...zipReport().products, updated: 0, unchanged: 549 },
        rows: { added: [], changed: [], notInFile: [] },
        brands: { added: [], changed: [], notInFile: ['Swisware+'] },
        photos: { ...zipReport().photos, replaced: [], notInZip: [] },
        exactNeedsLists: true,
      }),
    );
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));
    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });

    const exact = (await screen.findByLabelText(t('productZip.opt.exact'))) as HTMLInputElement;
    expect([exact.checked, exact.disabled]).toEqual([false, true]);
    expect(screen.getByText(t('productZip.opt.exact.needsLists'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('previews an earlier version\'s products sheet, and lists main products back from the Bin and each list it changes or reorders', async () => {
    const productZip = zipTransport();
    const nothing = zipReport({
      mainProducts: { added: [], renamed: [] },
      products: { ...zipReport().products, updated: 0, unchanged: 549 },
      rows: { added: [], changed: [], notInFile: [] },
      photos: { ...zipReport().photos, replaced: [], notInZip: [] },
    });
    productZip.preview
      .mockResolvedValueOnce({
        ...nothing,
        mainProducts: {
          added: [],
          renamed: [{ code: 'WBX', fields: [{ column: 'Main product code', from: 'WBX', to: 'WB' }] }],
          restoredFromBin: [{ code: 'UR', name: 'Urinal', brand: null }],
        },
        brands: { added: ['Zeta'], changed: [{ column: 'Alpha — Label', from: 'Alpha', to: 'Alpha Ware' }] },
      })
      .mockResolvedValueOnce({ ...nothing, colours: { added: [], changed: [], reordered: true } });
    renderList(viewOf({ permissions: ALL }), makeTransport({ productZip }));

    fireEvent.click(await screen.findByRole('button', { name: t('productZip.restore') }));
    const sheet = new File(['Brand,Code'], 'products-2026-10-07.csv', { type: 'text/csv' });
    fireEvent.change(await screen.findByTestId('product-zip-file'), { target: { files: [sheet] } });

    expect(await screen.findByText(t('productZip.item.restoredFromBin', { count: 1 }))).toBeTruthy();
    expect(productZip.preview).toHaveBeenCalledWith(sheet, {});
    expect(screen.getByText('UR — Urinal')).toBeTruthy();
    expect(screen.getByText('WBX: Main product code: WBX → WB')).toBeTruthy();
    expect(screen.getByText(t('productZip.section.brands'))).toBeTruthy();
    expect(screen.getByText('Zeta')).toBeTruthy();
    expect(screen.getByText('Alpha — Label: Alpha → Alpha Ware')).toBeTruthy();
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(false);

    // A list put in the file's order, and nothing else: still something for Apply to do.
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    fireEvent.change(await screen.findByTestId('product-zip-file'), {
      target: { files: [new File(['PK'], 'backup.zip')] },
    });
    expect(await screen.findByText(t('productZip.item.listReordered'))).toBeTruthy();
    expect(screen.queryByText(t('productZip.nothing'))).toBeNull();
    expect((screen.getByRole('button', { name: t('productZip.apply') }) as HTMLButtonElement).disabled).toBe(false);
  });
});
