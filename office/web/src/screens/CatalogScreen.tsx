/**
 * Catalog — Products and Parties, browsing and creation.
 *
 * Restyled onto the design system (6-UI-DESIGN.md, Products.dc.html,
 * Parties.dc.html). The two mockups are separate pages, not one shared shell
 * with an in-page tab switcher — the sidebar itself carries the two links —
 * so `tab` keeps working exactly as App.tsx already drives it; this screen
 * only republishes its search/filters into the shell's filter strip.
 *
 * Creation reuses the shared `PartyFormModal` (extracted from the inline
 * "+ New party" flow
 * that used to live only in AddLeadScreen, then moved into `ui/` when the
 * Master gained its own Parties screen) and a `ProductDrawer` built the same
 * way around the already-existing, previously UI-less `api.createProduct`.
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
 * Master — search and "load more" both run there. Offline, the
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
 * inside the detail, not the row click itself — the party form/`ProductDrawer`
 * both double as edit forms, and stay overlays because a form is a dialog.
 *
 * **The products side was redesigned on 2026-09-22** from the owner's artifact
 * (see `HANDOFF.md`). Its list is six proportional columns — code, product,
 * category, size, weight, colours — and its filter strip is the search box and
 * the two actions, nothing else: the category and missing-weight chips were
 * dropped at the owner's decision, and with them this screen's `categoryFilter`
 * and `weightFilter`. `api.listProducts` still accepts both, and the Master
 * still implements them, should they come back. Parties kept its city chips.
 *
 * The thumbnail and per-variant stock columns went the same way. Stock is read
 * on the product's own detail screen now, which is the same argument
 * `fitColumns` rests on: the whole record is one click from the row.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Party, Product } from '@orderbook/shared';

import { ApiError, api, type LocalView } from '../api';
import { partyFormTransport } from '../partyFormTransport';
import { ProductDrawer, type CreatedProduct } from '../components/ProductDrawer';
import { ProductImportModal } from '../components/ProductImportModal';
import { codesOf, weightLabel } from '../productSummary';
import {
  Button,
  type CreatedParty,
  DataTable,
  EditorScreen,
  EmptyState,
  ErrorState,
  FilterChip,
  PartyFormModal,
  Input,
  LoadMorePager,
  SkeletonTable,
  StatusPill,
  rem,
  t,
  useDebounced,
  useFilterBar,
  useSubNav,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';
import { PartyDetail } from './PartyDetail';
import { ProductDetail } from './ProductDetail';

/** Rows per fetch. `DataTable` virtualises past 100, so a page is cheap to show. */
const PAGE = 100;

/** Long enough that a fast typist issues one request, short enough not to lag. */
const SEARCH_DEBOUNCE_MS = 250;

/** A snapshot push lands in bursts; one refetch per burst is plenty. */
const REFETCH_DEBOUNCE_MS = 500;

interface ProductPage {
  items: Product[];
  total: number;
  /** The panel's server answered from its cached snapshot — the Master was unreachable. */
  offline: boolean;
}

function distinctSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function matchesProduct(product: Product, term: string): boolean {
  return (
    !term ||
    product.name.toLowerCase().includes(term) ||
    product.variants.some(
      (variant) =>
        variant.code.toLowerCase().includes(term) ||
        (variant.label ?? '').toLowerCase().includes(term),
    ) ||
    (product.alias ?? '').toLowerCase().includes(term) ||
    product.categoryName.toLowerCase().includes(term)
  );
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
  /*
   * Absent, not greyed — the convention `PartyAccessScreen.tsx` states.
   *
   * These controls had no permission check at all: `grep 'products.create'`
   * across both panels matched nothing but a toast token. Someone without the
   * key could open the whole form, fill it in, save, and earn a refusal that
   * (until the refusal-visibility fix) they would never see.
   */
  const canCreateParty = view.permissions.includes('parties.create');
  const canCreateProduct = view.permissions.includes('products.create');

  const [partySearch, setPartySearch] = useState('');
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const [partyFormOpen, setPartyFormOpen] = useState(false);
  const [openPartyId, setOpenPartyId] = useState<string | null>(null);
  const [editingParty, setEditingParty] = useState<Party | null>(null);

  const [productSearch, setProductSearch] = useState('');
  const [productDrawerOpen, setProductDrawerOpen] = useState(false);
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  /*
   * The open product's photos as the last photo write left them. A write comes
   * back with the whole product, but the snapshot only catches up a frame or
   * two later through the event stream, and a cover photo that stays on the
   * old thumbnail until then reads as a failed upload. Only `images` is taken
   * from it, so an unrelated field arriving through the stream still wins.
   */
  const [photoPatch, setPhotoPatch] = useState<Product | null>(null);
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
          limit: PAGE,
          offset: 0,
        },
        controller.signal,
      )
      .then((result) => {
        setPage({
          items: result.items,
          total: result.total,
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
  }, [tab, productTerm, revision]);

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
        (product) => !product.sync.hlc && matchesProduct(product, productTermLower),
      ),
    [view.products, productTermLower],
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
    setPartyFormOpen(false);
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
  const openProductRow =
    products.find((product) => product.id === openProductId) ??
    byId.get(openProductId ?? '') ??
    null;
  const openProduct =
    openProductRow && photoPatch?.id === openProductRow.id
      ? { ...openProductRow, images: photoPatch.images }
      : openProductRow;
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
        {canCreateParty && (
          <Button variant="primary" size="sm" icon="plus" onClick={() => setPartyFormOpen(true)}>
            {t('catalog.parties.new')}
          </Button>
        )}
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
        <span style={{ flex: 1 }} />
        {canImport && (
          <Button variant="secondary" size="sm" icon="upload" onClick={() => setImportOpen(true)}>
            {t('catalog.products.import')}
          </Button>
        )}
        {canCreateProduct && (
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            onClick={() => setProductDrawerOpen(true)}
          >
            {t('catalog.products.new')}
          </Button>
        )}
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
        <PartyFormModal
          transport={partyFormTransport}
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
                actionLabel={canCreateParty ? t('catalog.parties.new') : undefined}
                onAction={canCreateParty ? () => setPartyFormOpen(true) : undefined}
              />
            ) : (
              <EmptyState title={t('catalog.parties.empty.filtered')} />
            )
          }
        />

        <PartyFormModal
          transport={partyFormTransport}
          open={partyFormOpen}
          onClose={() => setPartyFormOpen(false)}
          onCreated={onPartyCreated}
          onError={onDrawerError}
        />
        <PartyFormModal
          transport={partyFormTransport}
          open={editingParty !== null}
          party={editingParty}
          onClose={() => setEditingParty(null)}
          onUpdated={onPartyUpdated}
          onError={onDrawerError}
        />
      </>
    );
  }

  /*
   * Code first, then the name — the two things anyone identifies a ceramic
   * model by, and the two a search is typed against. Proportional tracks
   * rather than fixed rem: the six columns share the width they are given
   * instead of leaving a ragged gutter at 4K, and `minmax(0, …)` is what stops
   * a long category name from pushing its track past its share.
   */
  const columns: DataTableColumn<Product>[] = [
    {
      key: 'code',
      header: t('catalog.products.column.codes'),
      width: 'minmax(0, 0.8fr)',
      render: (product) => (
        <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
          {codesOf(product)}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('catalog.products.column.name'),
      width: 'minmax(0, 2fr)',
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
      key: 'category',
      header: t('catalog.products.column.category'),
      priority: 2,
      width: 'minmax(0, 1.2fr)',
      render: (product) => product.categoryName,
    },
    {
      key: 'size',
      header: t('catalog.products.column.size'),
      priority: 3,
      width: 'minmax(0, 1.2fr)',
      render: (product) => product.size ?? '—',
    },
    {
      key: 'weight',
      header: t('catalog.products.column.weight'),
      priority: 2,
      width: 'minmax(0, 1fr)',
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
    {
      key: 'colours',
      header: t('catalog.products.column.colours'),
      priority: 3,
      width: 'minmax(0, 0.6fr)',
      render: (product) =>
        product.multiColour ? (
          <StatusPill tone="accent">{t('product.multiColour.pill')}</StatusPill>
        ) : (
          '—'
        ),
    },
  ];

  if (openProduct) {
    return (
      <EditorScreen
        onBack={() => {
          setOpenProductId(null);
          setPhotoPatch(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <ProductDetail
          product={openProduct}
          onEdit={() => {
            setEditingProduct(openProduct);
            setOpenProductId(null);
            setPhotoPatch(null);
          }}
          onPhotosChanged={setPhotoPatch}
          onError={onDrawerError}
        />
        <ProductDrawer
          open={editingProduct !== null}
          product={editingProduct}
          categories={view.categories}
          optionLists={view.optionLists}
          onClose={() => setEditingProduct(null)}
          onUpdated={onProductUpdated}
          onError={onDrawerError}
        />
      </EditorScreen>
    );
  }

  const searched = productTerm !== '';
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
            ) : !searched ? (
              <EmptyState
                title={t('catalog.products.empty.title')}
                description={t('catalog.products.empty.description')}
                actionLabel={canCreateProduct ? t('catalog.products.new') : undefined}
                onAction={canCreateProduct ? () => setProductDrawerOpen(true) : undefined}
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
        onClose={() => setProductDrawerOpen(false)}
        onCreated={onProductCreated}
        onError={onDrawerError}
      />
      <ProductDrawer
        open={editingProduct !== null}
        product={editingProduct}
        categories={view.categories}
        optionLists={view.optionLists}
        onClose={() => setEditingProduct(null)}
        onUpdated={onProductUpdated}
        onError={onDrawerError}
      />

      <ProductImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => setRevision((current) => current + 1)}
        onError={onDrawerError}
      />
    </>
  );
}
