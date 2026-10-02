/**
 * Products -> Sub products: the sub-product list, its detail sub-screen and the
 * dialogs that create, edit and import.
 *
 * Port of the products half of `office/web/src/screens/CatalogScreen.tsx`; keep
 * in step (until the Office switches to this copy the code exists twice).
 * Deliberate differences from the Office copy:
 *  - the parties half is not here (the Master has its own Parties screen);
 *  - it reads a `CatalogueView` and writes through a `CatalogueTransport`, held
 *    in a ref (`ui/tests/no-transport-dep.test.ts`);
 *  - the Master saves online, so there are no not-yet-synced rows, no overlay
 *    of a snapshot copy over the fetched page and no "cached page" pill; the
 *    list refetches when the host's `revision` moves (the catalogue changed
 *    anywhere) and after this screen's own writes;
 *  - New, Edit, the photo controls and Import are absent without
 *    `products.create`, `products.edit` and `products.bulk` - the Office leaves
 *    Edit and the photos ungated;
 *  - the toasts and the empty hint use the Master's wording
 *    (`catalog.products.savedOnline`, `catalog.products.empty.descriptionOnline`);
 *  - a cancelled request is told by `controller.signal.aborted`, not by an
 *    error code, and a failure shows the server's translated message.
 *
 * Original header, trimmed to what still applies, follows.
 *
 * **Catalogue v2 (2026-09-28) made the Products tab the sub-product list**
 * (`docs/catalogue/CATALOGUE_MODEL.md` §1): Brand, Product (`OPT - One Piece
 * Toilet`), Sub product, Size, the colour its rule shows (§2), Codes, Weight
 * and the free stock of its one variant - one figure per row. Its filters are
 * the catalogue's own and run on the server: brand chips from the
 * `product.brand` list, and a product picker. That picker sits above the
 * table, not in the strip, because `.ob-filterbar` clips anything that drops
 * below its band and a list opened inside it can never be seen. Search also
 * matches the brand and the product code.
 *
 * Row click opens a view-only detail sub-screen (`ProductDetail`) that replaces
 * the list, carries one way back in a fixed place and has its own entry nested
 * under Sub products in the sidebar while it is open. Editing is one button
 * inside the detail; the form stays a dialog because a form is one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '@orderbook/shared';

import { Button } from './Button.js';
import {
  byCatalogueOrder,
  codesOf,
  productLabel,
  weightLabel,
  type CatalogueTransport,
  type CatalogueView,
} from './catalogueSummary.js';
import { StatusPill, useColourHex } from './DataDisplay.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { EditorScreen } from './EditorScreen.js';
import { apiErrorText } from './errorText.js';
import { FilterChip } from './FilterBar.js';
import { useFilterBar } from './FilterBarSlot.js';
import { Input } from './Form.js';
import { t } from './i18n.js';
import { LoadMorePager } from './CursorPager.js';
import { ProductDetail, SubProductColour } from './ProductDetail.js';
import { ProductDrawer, type CreatedProduct } from './ProductDrawer.js';
import { ProductImportModal, exportCatalogueCsv } from './ProductImportModal.js';
import { rem } from './rem.js';
import { Select } from './SuggestInput.js';
import { EmptyState, ErrorState, SkeletonTable } from './States.js';
import { useSubNav } from './SubNavSlot.js';
import { useToast } from './Toast.js';
import { useDebounced } from './useDebounced.js';

/** Rows per fetch. `DataTable` virtualises past 100, so a page is cheap to show. */
const PAGE = 100;

/** Long enough that a fast typist issues one request, short enough not to lag. */
const SEARCH_DEBOUNCE_MS = 250;

interface ProductPage {
  items: Product[];
  total: number;
}

/** The sub-product list's two catalogue filters: a `product.brand` value and a product (category) id. */
interface ProductFilters {
  brand: string | null;
  categoryId: string | null;
}

const NO_FILTERS: ProductFilters = { brand: null, categoryId: null };

export function SubProductsScreen({
  view,
  transport,
  revision,
  onImported,
}: {
  view: CatalogueView;
  transport: CatalogueTransport;
  /** A bulk import wrote something; the host refetches what else it shows (brands, stock). */
  onImported?: () => void;
  /** Moves when the catalogue changed anywhere; the list is read again. */
  revision: number;
}) {
  const toast = useToast();
  // Held in a ref so a host that builds the object inline cannot re-run an
  // effect (`ui/tests/no-transport-dep.test.ts`).
  const transportRef = useRef(transport);
  transportRef.current = transport;

  // Absent, not greyed - the convention `PartyAccessScreen.tsx` states.
  const canCreate = view.permissions.includes('products.create');
  const canEdit = view.permissions.includes('products.edit');
  const canImport = view.permissions.includes('products.bulk');

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ProductFilters>(NO_FILTERS);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /*
   * The open product's photos as the last photo write left them. A write comes
   * back with the whole product, but the list is read again only a moment
   * later, and a cover photo that stays on the old thumbnail until then reads
   * as a failed upload. Only `images` is taken from it.
   */
  const [photoPatch, setPhotoPatch] = useState<Product | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const [page, setPage] = useState<ProductPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped to refetch page one after this screen's own write, or on retry. */
  const [refetch, setRefetch] = useState(0);

  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  const colourHex = useColourHex(view.optionLists);

  // The brand chips in the list's own order; the products, live ones of the
  // chosen brand, in catalogue order for the picker.
  const brands = useMemo(
    () =>
      view.optionLists
        .filter(
          (option) => option.listKey === 'product.brand' && option.isActive && !option.deletedAt,
        )
        .sort((a, b) => a.sequence - b.sequence),
    [view.optionLists],
  );
  const categories = useMemo(
    () =>
      view.categories
        .filter(
          (category) =>
            !category.deletedAt &&
            (!filters.brand || category.brand?.toLowerCase() === filters.brand.toLowerCase()),
        )
        .sort(byCatalogueOrder),
    [view.categories, filters.brand],
  );

  /*
   * A row's product and brand, read through the category rather than the row's
   * own joined copy. A category edit (a new code, another brand) touches no
   * product, so the joined copy on a product row goes stale until that product
   * itself moves.
   */
  const categoryById = useMemo(
    () => new Map(view.categories.map((category) => [category.id, category])),
    [view.categories],
  );
  const productOf = (product: Product) => {
    const category = categoryById.get(product.categoryId);
    return category
      ? { code: category.code, name: category.name, brand: category.brand }
      : { code: product.categoryCode, name: product.categoryName, brand: product.brand };
  };

  // Free stock per sub product, summed over its variants' stock rows.
  const freeByProduct = useMemo(() => {
    const free = new Map<string, number>();
    for (const level of view.stock ?? []) {
      free.set(level.productId, (free.get(level.productId) ?? 0) + level.availableBoxes);
    }
    return free;
  }, [view.stock]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    transportRef.current
      .listProducts(
        {
          search: term || undefined,
          brand: filters.brand ?? undefined,
          categoryId: filters.categoryId ?? undefined,
          limit: PAGE,
          offset: 0,
        },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        setPage({ items: result.items, total: result.total });
        setLoadFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      })
      .finally(() => {
        // The next effect run owns `loading` once this one has been aborted.
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [term, filters, revision, refetch]);

  async function loadMore(): Promise<void> {
    if (!page || loading) return;
    setLoading(true);
    try {
      const result = await transportRef.current.listProducts({
        search: term || undefined,
        brand: filters.brand ?? undefined,
        categoryId: filters.categoryId ?? undefined,
        limit: PAGE,
        offset: page.items.length,
      });
      setPage((current) => {
        if (!current) return current;
        const seen = new Set(current.items.map((product) => product.id));
        return {
          items: [...current.items, ...result.items.filter((product) => !seen.has(product.id))],
          total: result.total,
        };
      });
    } catch (caught) {
      toast.push(apiErrorText(caught, 'catalog.products.loadFailed'), { tone: 'error' });
    } finally {
      setLoading(false);
    }
  }

  function onCreated(product: CreatedProduct): void {
    setDrawerOpen(false);
    setRefetch((current) => current + 1);
    toast.push(t('catalog.products.savedOnline', { name: product.name }));
  }

  function onUpdated(name: string): void {
    setEditing(null);
    setRefetch((current) => current + 1);
    toast.push(t('product.updated', { name }));
  }

  function onDrawerError(message: string): void {
    toast.push(message, { tone: 'error' });
  }

  const products = page?.items ?? [];
  const openRow = products.find((product) => product.id === openId) ?? null;
  const open =
    openRow && photoPatch?.id === openRow.id ? { ...openRow, images: photoPatch.images } : openRow;

  // Registered under the Products module - the screen id the shell reads - and
  // hung under this page, not beside Sub products, Products and Brands.
  useSubNav(
    'products',
    open
      ? {
          parentId: 'products.sub',
          items: [{ id: 'products.detail', label: open.name, icon: 'products' }],
          activeId: 'products.detail',
        }
      : null,
  );

  useFilterBar(
    open ? null : (
      <>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('catalog.products.searchPlaceholder')}
          aria-label={t('catalog.products.searchLabel')}
          data-screen-search
          style={{ width: rem(320) }}
        />
        {/* Counted only while chosen: the page's total is the one figure to
            hand, and a count per brand would be a query per chip. */}
        <FilterChip
          active={filters.brand === null}
          count={filters.brand === null && page ? page.total : undefined}
          onClick={() => setFilters((current) => ({ ...current, brand: null }))}
        >
          {t('catalog.filter.all')}
        </FilterChip>
        {brands.map((brand) => (
          <FilterChip
            key={brand.id}
            active={filters.brand === brand.value}
            count={filters.brand === brand.value && page ? page.total : undefined}
            // A product of another brand would filter the list to nothing.
            onClick={() => setFilters({ brand: brand.value, categoryId: null })}
          >
            {brand.label}
          </FilterChip>
        ))}
        <span style={{ flex: 1 }} />
        <Button
          variant="secondary"
          size="sm"
          icon="download"
          onClick={() =>
            void exportCatalogueCsv(transportRef.current, 'sub').catch((caught) =>
              toast.push(apiErrorText(caught, 'catalog.export.failed'), { tone: 'error' }),
            )
          }
        >
          {t('catalog.export')}
        </Button>
        {canImport && (
          <Button variant="secondary" size="sm" icon="upload" onClick={() => setImportOpen(true)}>
            {t('catalog.products.import')}
          </Button>
        )}
        {canCreate && (
          <Button variant="primary" size="sm" icon="plus" onClick={() => setDrawerOpen(true)}>
            {t('catalog.products.new')}
          </Button>
        )}
      </>
    ),
  );

  // Free to sell - the Master hands out on-hand as free while the company
  // does not split stock, so this one figure is right either way. A dash,
  // not a zero, for a sub product that has never had a stock row (and for
  // everyone without `inventory.view`, whose view carries no stock). No
  // column at all when the view has no `stock`: the Master's list.
  const stockColumn: DataTableColumn<Product> = {
    key: 'stock',
    header: t('catalog.products.column.stock'),
    priority: 2,
    width: 'minmax(0, 0.6fr)',
    align: 'right',
    render: (product) => {
      const free = freeByProduct.get(product.id);
      if (free === undefined) return '—';
      return (
        <span
          className="ob-data"
          style={{
            color:
              free < 0 ? 'var(--state-conflict)' : free === 0 ? 'var(--fg-tertiary)' : undefined,
          }}
        >
          {free}
        </span>
      );
    },
  };

  /*
   * The catalogue's own reading order (CATALOGUE_MODEL.md §1): brand, then
   * product, then the sub product as printed - the product and sub product
   * being the two a search is typed against, and the two never dropped.
   * Proportional tracks rather than fixed rem: the columns share the width
   * they are given instead of leaving a ragged gutter at 4K, and `minmax(0, ...)`
   * is what stops a long product name from pushing its track past its share.
   */
  const columns: DataTableColumn<Product>[] = [
    {
      key: 'brand',
      header: t('catalog.products.column.brand'),
      priority: 3,
      width: 'minmax(0, 0.8fr)',
      render: (product) => productOf(product).brand ?? '—',
    },
    {
      key: 'category',
      header: t('catalog.products.column.category'),
      width: 'minmax(0, 1.6fr)',
      render: (product) => {
        const category = productOf(product);
        return productLabel(category.code, category.name) || '—';
      },
    },
    {
      key: 'name',
      header: t('catalog.products.column.name'),
      width: 'minmax(0, 1.6fr)',
      render: (product) => (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)', minWidth: 0 }}
        >
          <span className="ob-body-strong" style={{ fontSize: rem(13.5) }}>
            {product.name}
          </span>
          {product.alias && (
            <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
              {product.alias}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'size',
      header: t('catalog.products.column.size'),
      priority: 3,
      width: 'minmax(0, 1.2fr)',
      render: (product) => product.size ?? '—',
    },
    {
      // Blank for a numbered design: the owner's rule is no colour anywhere.
      key: 'colours',
      header: t('catalog.products.column.colours'),
      priority: 2,
      width: 'minmax(0, 1fr)',
      render: (product) => <SubProductColour product={product} colourHex={colourHex} />,
    },
    {
      key: 'code',
      header: t('catalog.products.column.codes'),
      priority: 2,
      width: 'minmax(0, 0.9fr)',
      render: (product) => (
        <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
          {codesOf(product)}
        </span>
      ),
    },
    {
      key: 'weight',
      header: t('catalog.products.column.weight'),
      priority: 3,
      width: 'minmax(0, 0.8fr)',
      align: 'right',
      render: (product) => {
        const weight = weightLabel(product);
        return weight === null ? (
          <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
        ) : (
          weight
        );
      },
    },
    ...(view.stock === undefined ? [] : [stockColumn]),
  ];

  const drawers = (
    <>
      <ProductDrawer
        open={drawerOpen}
        transport={transport}
        categories={view.categories}
        optionLists={view.optionLists}
        onClose={() => setDrawerOpen(false)}
        onCreated={onCreated}
        onError={onDrawerError}
      />
      <ProductDrawer
        open={editing !== null}
        transport={transport}
        product={editing}
        categories={view.categories}
        optionLists={view.optionLists}
        onClose={() => setEditing(null)}
        onUpdated={onUpdated}
        onError={onDrawerError}
      />
    </>
  );

  if (open) {
    return (
      <EditorScreen
        onBack={() => {
          setOpenId(null);
          setPhotoPatch(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <ProductDetail
          product={open}
          transport={transport}
          colourHex={colourHex}
          canEdit={canEdit}
          onEdit={() => {
            setEditing(open);
            setOpenId(null);
            setPhotoPatch(null);
          }}
          onPhotosChanged={setPhotoPatch}
          onError={onDrawerError}
        />
        {drawers}
      </EditorScreen>
    );
  }

  const filtered = term !== '' || filters.brand !== null || filters.categoryId !== null;

  return (
    <>
      {/* Here rather than in the filter strip: the strip clips anything that
          drops below its band, and this list has to open. */}
      <div style={{ width: rem(320), marginBottom: 'var(--s-12)' }}>
        <Select
          value={filters.categoryId ?? ''}
          onChange={(event) =>
            setFilters((current) => ({ ...current, categoryId: event.target.value || null }))
          }
          aria-label={t('catalog.products.productFilter')}
        >
          <option value="">{t('catalog.products.allProducts')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {productLabel(category.code, category.name)}
            </option>
          ))}
        </Select>
      </div>
      {page === null && !loadFailed ? (
        <SkeletonTable columns={columns} rows={8} />
      ) : (
        <DataTable
          columns={columns}
          rows={products}
          rowKey={(product) => product.id}
          onRowOpen={(product) => setOpenId(product.id)}
          selectedId={openId ?? undefined}
          empty={
            loadFailed ? (
              <ErrorState
                title={t('catalog.products.loadFailed')}
                actionLabel={t('action.retryNow')}
                onAction={() => setRefetch((current) => current + 1)}
              />
            ) : !filtered ? (
              <EmptyState
                title={t('catalog.products.empty.title')}
                description={t('catalog.products.empty.descriptionOnline')}
                actionLabel={canCreate ? t('catalog.products.new') : undefined}
                onAction={canCreate ? () => setDrawerOpen(true) : undefined}
              />
            ) : (
              <EmptyState title={t('catalog.products.empty.filtered')} />
            )
          }
        />
      )}

      {page && products.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--s-12)',
            flexWrap: 'wrap',
            padding: 'var(--s-8) 0',
          }}
        >
          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {t('catalog.products.shown', { shown: products.length, total: page.total })}
          </span>
          <LoadMorePager
            hasMore={page.items.length < page.total}
            loading={loading}
            onLoadMore={() => void loadMore()}
            label={t('catalog.products.loadMore')}
          />
        </div>
      )}

      {drawers}

      <ProductImportModal
        open={importOpen}
        transport={transport}
        onClose={() => setImportOpen(false)}
        onImported={(result) => {
          setRefetch((current) => current + 1);
          onImported?.();
          toast.push(t('import.done', { created: result.created, updated: result.updated }));
        }}
        onError={onDrawerError}
      />
    </>
  );
}
