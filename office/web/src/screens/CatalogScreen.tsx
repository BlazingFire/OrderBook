/**
 * Catalog — Products and Parties, browsing and creation.
 *
 * Restyled onto the design system (6-UI-DESIGN.md, Products.dc.html,
 * Parties.dc.html). The two mockups are separate pages, not one shared shell
 * with an in-page tab switcher — the sidebar itself carries the two links —
 * so `tab` keeps working exactly as App.tsx already drives it; this screen
 * only republishes its search/filters into the shell's filter strip.
 *
 * Creation reuses `PartyDrawer` (extracted from the inline "+ New party" flow
 * that used to live only in AddLeadScreen) and a new `ProductDrawer` built the
 * same way around the already-existing, previously UI-less `api.createProduct`.
 * Neither drawer is told to wait for the created record to come back through
 * the merged view before reporting success — the panel's SSE stream applies a
 * queued write to `view` right away (the same reason a lead saved offline
 * shows up immediately), so a toast plus closing the drawer is enough; the row
 * appears in the table on its own.
 *
 * **Products are paged from the Master, not read off the snapshot.** The
 * snapshot is this panel's offline working set and holds one page of the
 * catalogue (`SNAPSHOT_LIMIT`, 500 rows); it used to be the whole list, which
 * meant a shop that imported five thousand products could see the first five
 * hundred and reach the rest from nowhere. Online, the list now asks the
 * Master — search, category filter and "load more" all run there. Offline, the
 * panel's server pages the cached snapshot instead and says so, and the
 * screen shows a "cached page" pill rather than pretending.
 *
 * Two things still come from `view.products`, deliberately: a product created
 * on this panel and not yet acknowledged (its `sync.hlc` is empty) is shown at
 * the top with the "not synced" pill, because the Master cannot know about it
 * yet; and a row the Master did return is overlaid with the snapshot's copy,
 * so a queued edit or a live change shows without waiting for a refetch. The
 * refetch itself is driven by a fingerprint of `view.products` — the ids and
 * clocks — so a lead or order moving elsewhere does not reload the catalogue
 * (the v1.0.3 "refetches on every delta" blocker was exactly that).
 *
 * Row click opens a view-only detail sub-screen (`ProductDetail`/`PartyDetail`)
 * rather than jumping straight to an edit form — the same split
 * `LeadBoardScreen` + `LeadDetail` uses for leads. The detail replaces the list
 * and carries one way back in a fixed place, with its own entry nested under
 * Parties or Products in the sidebar while it is open. Editing is one button
 * inside the detail, not the row click itself — `PartyDrawer`/`ProductDrawer`
 * both double as edit forms, and stay overlays because a form is a dialog.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Party, Product } from '@orderbook/shared';

import { ApiError, api, type LocalView } from '../api';
import { PartyDrawer, type CreatedParty } from '../components/PartyDrawer';
import { ProductDrawer, type CreatedProduct } from '../components/ProductDrawer';
import { ProductImportModal } from '../components/ProductImportModal';
import { StockByVariant } from '../components/StockCell';
import {
  Button,
  DataTable,
  EditorScreen,
  EmptyState,
  ErrorState,
  FilterChip,
  Input,
  LoadMorePager,
  ProgressiveImage,
  SkeletonTable,
  StatusPill,
  formatKg,
  formatMoney,
  rem,
  t,
  useColourHex,
  useDebounced,
  useFilterBar,
  useSubNav,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';
import { PartyDetail } from './PartyDetail';
import { ProductDetail } from './ProductDetail';

const RATE_PERMISSION = 'field.saleRate.view';

/** Rows per fetch. `DataTable` virtualises past 100, so a page is cheap to show. */
const PAGE = 100;

/** Long enough that a fast typist issues one request, short enough not to lag. */
const SEARCH_DEBOUNCE_MS = 250;

/** A snapshot push lands in bursts; one refetch per burst is plenty. */
const REFETCH_DEBOUNCE_MS = 500;

interface ProductPage {
  items: Product[];
  total: number;
  categories: Array<{ id: string; name: string; count: number }>;
  /** The panel's server answered from its cached snapshot — the Master was unreachable. */
  offline: boolean;
}

function distinctSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

/** A variant whose weight nobody has entered yet — flagged, never treated as zero. */
function missingWeight(product: Product): boolean {
  return product.variants.some((variant) => variant.isActive && variant.weightKg === null);
}

function matchesProduct(
  product: Product,
  term: string,
  categoryFilter: string | null,
  weightFilter: boolean,
): boolean {
  return (
    (!term ||
      product.name.toLowerCase().includes(term) ||
      product.variants.some(
        (variant) =>
          variant.code.toLowerCase().includes(term) ||
          (variant.label ?? '').toLowerCase().includes(term),
      ) ||
      (product.alias ?? '').toLowerCase().includes(term) ||
      product.categoryName.toLowerCase().includes(term)) &&
    (!categoryFilter || product.categoryId === categoryFilter) &&
    (!weightFilter || missingWeight(product))
  );
}

/** The code column: the one code, or how many there are and the first of them. */
function codesOf(product: Product): string {
  const active = product.variants.filter((variant) => variant.isActive);
  if (active.length <= 1) return active[0]?.code ?? product.variants[0]?.code ?? '—';
  return t('catalog.products.variantCount', { count: active.length, first: active[0]!.code });
}

export function CatalogScreen({
  view,
  tab,
  canImport = false,
}: {
  view: LocalView;
  tab: 'parties' | 'products';
  /** Holds `products.bulk`. Absent rather than disabled, like every gated control. */
  canImport?: boolean;
}) {
  const toast = useToast();
  const colourHex = useColourHex(view.optionLists);
  // Off with the company's pricing switch, or without the role's key: no
  // Rate column and no rate fields, rather than redacted ones.
  const showMoney = view.permissions.includes(RATE_PERMISSION);
  // Absent means an older Master, which sends every figure — read as "on".
  const freeToSell = view.features?.freeToSell ?? true;

  const [partySearch, setPartySearch] = useState('');
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const [partyDrawerOpen, setPartyDrawerOpen] = useState(false);
  const [openPartyId, setOpenPartyId] = useState<string | null>(null);
  const [editingParty, setEditingParty] = useState<Party | null>(null);

  const [productSearch, setProductSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [weightFilter, setWeightFilter] = useState(false);
  const [productDrawerOpen, setProductDrawerOpen] = useState(false);
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const [page, setPage] = useState<ProductPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped to refetch page one — after a sync moved the catalogue, or on retry. */
  const [revision, setRevision] = useState(0);

  const partyTerm = partySearch.trim().toLowerCase();
  const productTerm = useDebounced(productSearch.trim(), SEARCH_DEBOUNCE_MS);
  const productTermLower = productTerm.toLowerCase();

  const cities = useMemo(
    () => distinctSorted(view.parties.map((party) => party.city)),
    [view.parties],
  );

  const parties = useMemo(
    () =>
      view.parties.filter(
        (party) =>
          (!partyTerm ||
            party.name.toLowerCase().includes(partyTerm) ||
            party.partyCode.toLowerCase().includes(partyTerm) ||
            (party.phone ?? '').includes(partyTerm)) &&
          (!cityFilter || party.city === cityFilter),
      ),
    [view.parties, partyTerm, cityFilter],
  );

  // --- Products: one page from the Master (or the cached snapshot, offline) ---

  useEffect(() => {
    if (tab !== 'products') return;

    const controller = new AbortController();
    setLoading(true);

    api
      .listProducts(
        {
          search: productTerm || undefined,
          categoryId: categoryFilter ?? undefined,
          missingWeight: weightFilter || undefined,
          limit: PAGE,
          offset: 0,
        },
        controller.signal,
      )
      .then((result) => {
        setPage({
          items: result.items,
          total: result.total,
          categories: result.categories ?? [],
          offline: result.offline === true,
        });
        setLoadFailed(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.code === 'aborted') return;
        setLoadFailed(true);
      })
      .finally(() => {
        // The next effect run owns `loading` once this one has been aborted.
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [tab, productTerm, categoryFilter, weightFilter, revision]);

  /*
   * What the snapshot says about products, as one string: ids and clocks.
   * It moves when a queued create is acknowledged, when a product is edited
   * anywhere, and when the snapshot is refreshed after a bulk import — and
   * not when a lead, an order or a stock figure changes.
   */
  const fingerprint = useMemo(
    () => view.products.map((product) => `${product.id}:${product.sync.hlc}`).join('|'),
    [view.products],
  );
  const seenFingerprint = useRef(fingerprint);
  useEffect(() => {
    if (seenFingerprint.current === fingerprint) return;
    seenFingerprint.current = fingerprint;
    const timer = setTimeout(() => setRevision((current) => current + 1), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fingerprint]);

  async function loadMore(): Promise<void> {
    if (!page || loading) return;
    setLoading(true);
    try {
      const result = await api.listProducts({
        search: productTerm || undefined,
        categoryId: categoryFilter ?? undefined,
        missingWeight: weightFilter || undefined,
        limit: PAGE,
        offset: page.items.length,
      });
      setPage((current) => {
        if (!current) return current;
        const seen = new Set(current.items.map((product) => product.id));
        return {
          ...current,
          items: [...current.items, ...result.items.filter((product) => !seen.has(product.id))],
          total: result.total,
          offline: result.offline === true,
        };
      });
    } catch (caught) {
      toast.push(caught instanceof Error ? caught.message : t('catalog.products.loadFailed'), {
        tone: 'error',
      });
    } finally {
      setLoading(false);
    }
  }

  const byId = useMemo(
    () => new Map(view.products.map((product) => [product.id, product])),
    [view.products],
  );

  // Created here and not yet acknowledged: the Master cannot list these yet.
  const pending = useMemo(
    () =>
      view.products.filter(
        (product) =>
          !product.sync.hlc &&
          matchesProduct(product, productTermLower, categoryFilter, weightFilter),
      ),
    [view.products, productTermLower, categoryFilter, weightFilter],
  );

  const products = useMemo(() => {
    const shown = new Set(pending.map((product) => product.id));
    const fromMaster = (page?.items ?? [])
      .filter((product) => !shown.has(product.id))
      // The snapshot's copy carries a queued edit or a live change the page
      // predates; where it has one, it is the fresher row.
      .map((product) => byId.get(product.id) ?? product);
    return [...pending, ...fromMaster];
  }, [pending, page, byId]);

  function onPartyCreated(party: CreatedParty): void {
    setPartyDrawerOpen(false);
    toast.push(t('catalog.parties.created', { name: party.name }));
  }

  function onPartyUpdated(name: string): void {
    setEditingParty(null);
    toast.push(t('party.updated', { name }));
  }

  function onProductCreated(product: CreatedProduct): void {
    setProductDrawerOpen(false);
    toast.push(t('catalog.products.created', { name: product.name }));
  }

  function onProductUpdated(name: string): void {
    setEditingProduct(null);
    toast.push(t('product.updated', { name }));
  }

  function onDrawerError(message: string): void {
    toast.push(message, { tone: 'error' });
  }

  const openParty = view.parties.find((party) => party.id === openPartyId) ?? null;
  const openProduct =
    products.find((product) => product.id === openProductId) ??
    byId.get(openProductId ?? '') ??
    null;
  const openRecord = tab === 'parties' ? openParty : openProduct;

  useSubNav(
    tab,
    openRecord
      ? {
          parentId: tab,
          items: [
            {
              id: `${tab}.detail`,
              label: openRecord.name,
              icon: tab === 'parties' ? 'parties' : 'products',
            },
          ],
          activeId: `${tab}.detail`,
        }
      : null,
  );

  useFilterBar(
    openRecord ? null : tab === 'parties' ? (
      <>
        <Input
          value={partySearch}
          onChange={(event) => setPartySearch(event.target.value)}
          placeholder={t('catalog.parties.searchPlaceholder')}
          aria-label={t('catalog.parties.searchLabel')}
          data-screen-search
          style={{ width: rem(400) }}
        />
        <FilterChip
          active={cityFilter === null}
          count={view.parties.length}
          onClick={() => setCityFilter(null)}
        >
          {t('catalog.filter.all')}
        </FilterChip>
        {cities.map((city) => (
          <FilterChip
            key={city}
            active={cityFilter === city}
            count={view.parties.filter((party) => party.city === city).length}
            onClick={() => setCityFilter(city)}
          >
            {city}
          </FilterChip>
        ))}
        <span style={{ flex: 1 }} />
        <Button variant="primary" size="sm" icon="plus" onClick={() => setPartyDrawerOpen(true)}>
          {t('catalog.parties.new')}
        </Button>
      </>
    ) : (
      <>
        <Input
          value={productSearch}
          onChange={(event) => setProductSearch(event.target.value)}
          placeholder={t('catalog.products.searchPlaceholder')}
          aria-label={t('catalog.products.searchLabel')}
          data-screen-search
          style={{ width: rem(400) }}
        />
        <FilterChip
          active={categoryFilter === null}
          count={page ? page.total + pending.length : undefined}
          onClick={() => setCategoryFilter(null)}
        >
          {t('catalog.filter.all')}
        </FilterChip>
        {(page?.categories ?? []).map((facet) => (
          <FilterChip
            key={facet.id}
            active={categoryFilter === facet.id}
            count={facet.count}
            onClick={() => setCategoryFilter((current) => (current === facet.id ? null : facet.id))}
          >
            {facet.name}
          </FilterChip>
        ))}
        {/* Off by itself: it is a to-do list, not a category. */}
        <FilterChip active={weightFilter} onClick={() => setWeightFilter((current) => !current)}>
          {t('catalog.products.filter.missingWeight')}
        </FilterChip>
        <span style={{ flex: 1 }} />
        {canImport && (
          <Button variant="secondary" size="sm" icon="upload" onClick={() => setImportOpen(true)}>
            {t('catalog.products.import')}
          </Button>
        )}
        <Button variant="primary" size="sm" icon="plus" onClick={() => setProductDrawerOpen(true)}>
          {t('catalog.products.new')}
        </Button>
      </>
    ),
  );

  if (tab === 'parties' && openParty) {
    return (
      <EditorScreen
        title={openParty.name}
        meta={<span className="ob-mono ob-small">{openParty.partyCode}</span>}
        onBack={() => {
          setOpenPartyId(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <PartyDetail
          party={openParty}
          view={view}
          onEdit={() => {
            setEditingParty(openParty);
            setOpenPartyId(null);
          }}
        />
        <PartyDrawer
          open={editingParty !== null}
          party={editingParty}
          onClose={() => setEditingParty(null)}
          onUpdated={onPartyUpdated}
          onError={onDrawerError}
        />
      </EditorScreen>
    );
  }

  if (tab === 'parties') {
    const columns: DataTableColumn<Party>[] = [
      {
        key: 'code',
        header: t('catalog.parties.column.code'),
        width: rem(100),
        render: (party) => (
          <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
            {party.partyCode}
          </span>
        ),
      },
      {
        key: 'name',
        header: t('catalog.parties.column.name'),
        render: (party) => (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)', minWidth: 0 }}
          >
            <span className="ob-body-strong" style={{ fontSize: rem(13.5) }}>
              {party.name}
            </span>
            {!party.sync.hlc && (
              <StatusPill tone="offline">{t('catalog.parties.notSynced')}</StatusPill>
            )}
          </span>
        ),
      },
      {
        key: 'phone',
        header: t('catalog.parties.column.phone'),
        priority: 2,
        width: rem(130),
        render: (party) => <span className="ob-data">{party.phone ?? '—'}</span>,
      },
      {
        key: 'city',
        header: t('catalog.parties.column.city'),
        priority: 3,
        width: rem(110),
        render: (party) => party.city ?? '—',
      },
      {
        key: 'variants',
        header: t('catalog.parties.column.variants'),
        priority: 3,
        width: rem(140),
        render: (party) => {
          const count = view.partyVariants.filter((variant) => variant.partyId === party.id).length;
          return count > 0
            ? `${count} ${count === 1 ? t('unit.product') : t('unit.products')}`
            : '—';
        },
      },
      {
        // Only ever three states, and only two are worth a pill. A party with
        // no grant to this person is simply the ordinary case — everyone can
        // reach it — so it renders as nothing rather than as "Open", which
        // would put a badge on almost every row and say nothing.
        key: 'access',
        header: t('catalog.parties.column.access'),
        width: rem(110),
        render: (party) => {
          const grant = (view.partyGrants ?? []).find((entry) => entry.partyId === party.id);
          if (!grant) return '';
          return (
            <StatusPill tone={grant.level === 'manage' ? 'accent' : 'default'}>
              {grant.level === 'manage'
                ? t('partyAccess.level.manage')
                : t('partyAccess.level.view')}
            </StatusPill>
          );
        },
      },
    ];

    return (
      <>
        <DataTable
          columns={columns}
          rows={parties}
          rowKey={(party) => party.id}
          onRowOpen={(party) => setOpenPartyId(party.id)}
          selectedId={openPartyId ?? undefined}
          empty={
            view.parties.length === 0 ? (
              <EmptyState
                title={t('catalog.parties.empty.title')}
                description={t('catalog.parties.empty.description')}
                actionLabel={t('catalog.parties.new')}
                onAction={() => setPartyDrawerOpen(true)}
              />
            ) : (
              <EmptyState title={t('catalog.parties.empty.filtered')} />
            )
          }
        />

        <PartyDrawer
          open={partyDrawerOpen}
          onClose={() => setPartyDrawerOpen(false)}
          onCreated={onPartyCreated}
          onError={onDrawerError}
        />
        <PartyDrawer
          open={editingParty !== null}
          party={editingParty}
          onClose={() => setEditingParty(null)}
          onUpdated={onPartyUpdated}
          onError={onDrawerError}
        />
      </>
    );
  }

  const columns: DataTableColumn<Product>[] = [
    {
      key: 'photo',
      header: '',
      width: rem(40),
      render: (product) => {
        const primary = product.images.find((image) => image.isPrimary) ?? product.images[0];
        if (!primary) return null;
        return (
          <span style={{ width: rem(28), height: rem(28) }}>
            <ProgressiveImage
              imageId={primary.id}
              variant="micro"
              slotPx={28}
              blurhash={primary.blurhash}
              width={primary.width}
              height={primary.height}
              alt=""
            />
          </span>
        );
      },
    },
    {
      key: 'category',
      header: t('catalog.products.column.category'),
      priority: 2,
      width: rem(130),
      render: (product) => product.categoryName,
    },
    {
      key: 'codes',
      header: t('catalog.products.column.codes'),
      width: rem(120),
      render: (product) => (
        <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
          {codesOf(product)}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('catalog.products.column.name'),
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
          {!product.sync.hlc && (
            <StatusPill tone="offline">{t('catalog.parties.notSynced')}</StatusPill>
          )}
        </span>
      ),
    },
    {
      key: 'brand',
      header: t('catalog.products.column.brand'),
      priority: 3,
      width: rem(90),
      render: (product) => product.brand ?? '—',
    },
    {
      key: 'size',
      header: t('catalog.products.column.size'),
      priority: 3,
      width: rem(110),
      render: (product) => product.size ?? '—',
    },
    {
      key: 'weight',
      header: t('catalog.products.column.weight'),
      priority: 2,
      width: rem(132),
      align: 'right',
      render: (product) => {
        if (missingWeight(product)) {
          return <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>;
        }
        const active = product.variants.filter((variant) => variant.isActive);
        // One figure for a one-form product; a range for a model, because one
        // number for "each of its variants weighs something different" lies.
        if (active.length === 1) return formatKg(active[0]!.weightKg);
        const weights = active.map((variant) => variant.weightKg ?? 0);
        const low = Math.min(...weights);
        const high = Math.max(...weights);
        return low === high ? formatKg(low) : t('product.weight.range', { low: formatKg(low), high: formatKg(high) });
      },
    },
    ...(showMoney
      ? [
          {
            key: 'rate',
            header: t('catalog.products.column.rate'),
            width: rem(100),
            align: 'right',
            // `rate` is absent, not null, when the role cannot see it (UI-11).
            render: (product: Product) => formatMoney(product.rate ?? null),
            redactedReason: (product: Product) =>
              product.rate === undefined ? RATE_PERMISSION : undefined,
          } satisfies DataTableColumn<Product>,
        ]
      : []),
    {
      key: 'stock',
      header: t(freeToSell ? 'catalog.products.column.stock' : 'catalog.products.column.stockOnHand'),
      width: '1.3fr',
      render: (product) => (
        <StockByVariant productId={product.id} stock={view.stock} colourHex={colourHex} />
      ),
    },
  ];

  if (openProduct) {
    return (
      <EditorScreen
        title={openProduct.name}
        meta={
          <span className="ob-mono ob-small">
            {codesOf(openProduct)}
            {openProduct.alias ? ` · ${openProduct.alias}` : ''}
          </span>
        }
        onBack={() => {
          setOpenProductId(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <ProductDetail
          product={openProduct}
          view={view}
          onEdit={() => {
            setEditingProduct(openProduct);
            setOpenProductId(null);
          }}
          onMessage={(message) => toast.push(message)}
          onError={onDrawerError}
        />
        <ProductDrawer
          open={editingProduct !== null}
          product={editingProduct}
          categories={view.categories}
          optionLists={view.optionLists}
          showMoney={showMoney}
          onClose={() => setEditingProduct(null)}
          onUpdated={onProductUpdated}
          onError={onDrawerError}
        />
      </EditorScreen>
    );
  }

  const filtered = productTerm !== '' || categoryFilter !== null || weightFilter;
  const shownTotal = (page?.total ?? 0) + pending.length;

  return (
    <>
      {page === null && !loadFailed ? (
        <SkeletonTable columns={columns} rows={8} />
      ) : (
        <DataTable
          columns={columns}
          rows={products}
          rowKey={(product) => product.id}
          onRowOpen={(product) => setOpenProductId(product.id)}
          selectedId={openProductId ?? undefined}
          empty={
            loadFailed ? (
              <ErrorState
                title={t('catalog.products.loadFailed')}
                actionLabel={t('action.retryNow')}
                onAction={() => setRevision((current) => current + 1)}
              />
            ) : !filtered ? (
              <EmptyState
                title={t('catalog.products.empty.title')}
                description={t('catalog.products.empty.description')}
                actionLabel={t('catalog.products.new')}
                onAction={() => setProductDrawerOpen(true)}
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
          {page.offline && (
            <StatusPill tone="offline">{t('catalog.products.cachedPage')}</StatusPill>
          )}
          <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {t('catalog.products.shown', { shown: products.length, total: shownTotal })}
          </span>
          <LoadMorePager
            hasMore={page.items.length < page.total}
            loading={loading}
            onLoadMore={() => void loadMore()}
            label={t('catalog.products.loadMore')}
          />
        </div>
      )}

      <ProductDrawer
        open={productDrawerOpen}
        categories={view.categories}
        optionLists={view.optionLists}
        showMoney={showMoney}
        onClose={() => setProductDrawerOpen(false)}
        onCreated={onProductCreated}
        onError={onDrawerError}
      />
      <ProductDrawer
        open={editingProduct !== null}
        product={editingProduct}
        categories={view.categories}
        optionLists={view.optionLists}
        showMoney={showMoney}
        onClose={() => setEditingProduct(null)}
        onUpdated={onProductUpdated}
        onError={onDrawerError}
      />

      <ProductImportModal
        open={importOpen}
        showMoney={showMoney}
        onClose={() => setImportOpen(false)}
        onImported={() => setRevision((current) => current + 1)}
        onError={onDrawerError}
      />
    </>
  );
}
