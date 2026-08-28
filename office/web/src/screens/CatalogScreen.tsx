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
 * Row click opens a view-only 520px detail drawer (`ProductDetail`/
 * `PartyDetail`) rather than jumping straight to an edit form — the same
 * split `LeadBoardScreen` + `LeadDetail` already use for leads. `openOn`
 * is `"click"` here, not the DataTable default of `"doubleClick"`: the
 * mockups open Products and Parties on a single click (Leads' list view is
 * the one that waits for a double-click, matching its Kanban drag
 * convention). Editing is one button inside that drawer, not the row click
 * itself — `PartyDrawer`/`ProductDrawer` both now double as edit forms.
 */

import { useMemo, useState } from 'react';
import type { Party, Product } from '@orderbook/shared';

import type { LocalView } from '../api';
import { PartyDrawer, type CreatedParty } from '../components/PartyDrawer';
import { ProductDrawer, type CreatedProduct } from '../components/ProductDrawer';
import { StockByColour } from '../components/StockCell';
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  FilterChip,
  Input,
  ProgressiveImage,
  StatusPill,
  formatMoney,
  t,
  useColourHex,
  useFilterBar,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';
import { PartyDetail } from './PartyDetail';
import { ProductDetail } from './ProductDetail';

const RATE_PERMISSION = 'field.saleRate.view';

function distinctSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

export function CatalogScreen({ view, tab }: { view: LocalView; tab: 'parties' | 'products' }) {
  const toast = useToast();
  const colourHex = useColourHex(view.optionLists);

  const [partySearch, setPartySearch] = useState('');
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const [partyDrawerOpen, setPartyDrawerOpen] = useState(false);
  const [openPartyId, setOpenPartyId] = useState<string | null>(null);
  const [editingParty, setEditingParty] = useState<Party | null>(null);

  const [productSearch, setProductSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [productDrawerOpen, setProductDrawerOpen] = useState(false);
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const partyTerm = partySearch.trim().toLowerCase();
  const productTerm = productSearch.trim().toLowerCase();

  const cities = useMemo(
    () => distinctSorted(view.parties.map((party) => party.city)),
    [view.parties],
  );
  const types = useMemo(
    () => distinctSorted(view.products.map((product) => product.productType)),
    [view.products],
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

  const products = useMemo(
    () =>
      view.products.filter(
        (product) =>
          (!productTerm ||
            product.name.toLowerCase().includes(productTerm) ||
            product.productCode.toLowerCase().includes(productTerm) ||
            (product.alias ?? '').toLowerCase().includes(productTerm) ||
            (product.categoryName ?? '').toLowerCase().includes(productTerm)) &&
          (!typeFilter || product.productType === typeFilter),
      ),
    [view.products, productTerm, typeFilter],
  );

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

  useFilterBar(
    tab === 'parties' ? (
      <>
        <Input
          value={partySearch}
          onChange={(event) => setPartySearch(event.target.value)}
          placeholder={t('catalog.parties.searchPlaceholder')}
          aria-label={t('catalog.parties.searchLabel')}
          style={{ width: 240 }}
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
          style={{ width: 240 }}
        />
        <FilterChip
          active={typeFilter === null}
          count={view.products.length}
          onClick={() => setTypeFilter(null)}
        >
          {t('catalog.filter.all')}
        </FilterChip>
        {types.map((type) => (
          <FilterChip
            key={type}
            active={typeFilter === type}
            count={view.products.filter((product) => product.productType === type).length}
            onClick={() => setTypeFilter(type)}
          >
            {type}
          </FilterChip>
        ))}
        <span style={{ flex: 1 }} />
        <Button variant="primary" size="sm" icon="plus" onClick={() => setProductDrawerOpen(true)}>
          {t('catalog.products.new')}
        </Button>
      </>
    ),
  );

  if (tab === 'parties') {
    const columns: DataTableColumn<Party>[] = [
      {
        key: 'code',
        header: t('catalog.parties.column.code'),
        width: '100px',
        render: (party) => (
          <span className="ob-mono" style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
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
            <span className="ob-body-strong" style={{ fontSize: 13.5 }}>
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
        width: '130px',
        render: (party) => <span className="ob-data">{party.phone ?? '—'}</span>,
      },
      {
        key: 'city',
        header: t('catalog.parties.column.city'),
        width: '110px',
        render: (party) => party.city ?? '—',
      },
      {
        key: 'variants',
        header: t('catalog.parties.column.variants'),
        width: '140px',
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
        width: '110px',
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

    const openParty = view.parties.find((party) => party.id === openPartyId) ?? null;

    return (
      <>
        <DataTable
          columns={columns}
          rows={parties}
          rowKey={(party) => party.id}
          onRowOpen={(party) => setOpenPartyId(party.id)}
          openOn="click"
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

        <Drawer
          open={openParty !== null}
          onClose={() => setOpenPartyId(null)}
          title={openParty?.name}
          subtitle={openParty && <span className="ob-mono">{openParty.partyCode}</span>}
        >
          {openParty && (
            <PartyDetail
              party={openParty}
              view={view}
              onEdit={() => {
                setEditingParty(openParty);
                setOpenPartyId(null);
              }}
            />
          )}
        </Drawer>

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
      width: '40px',
      render: (product) => {
        const primary = product.images.find((image) => image.isPrimary) ?? product.images[0];
        if (!primary) return null;
        return (
          <span style={{ width: 28, height: 28 }}>
            <ProgressiveImage
              imageId={primary.id}
              variant="micro"
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
      key: 'code',
      header: t('catalog.products.column.code'),
      width: '100px',
      render: (product) => (
        <span className="ob-mono" style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
          {product.productCode}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('catalog.products.column.name'),
      render: (product) => (
        <span style={{ minWidth: 0 }}>
          <span className="ob-body-strong" style={{ fontSize: 13.5 }}>
            {product.name}
          </span>
          {product.alias && (
            <span
              className="ob-small"
              style={{ marginLeft: 'var(--s-8)', color: 'var(--fg-tertiary)' }}
            >
              {product.alias}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('catalog.products.column.type'),
      width: '90px',
      render: (product) => product.productType ?? product.categoryName ?? '—',
    },
    {
      key: 'size',
      header: t('catalog.products.column.size'),
      width: '110px',
      render: (product) => product.size ?? '—',
    },
    {
      key: 'grade',
      header: t('catalog.products.column.grade'),
      width: '80px',
      render: (product) => product.grade ?? '—',
    },
    {
      key: 'rate',
      header: t('catalog.products.column.rate'),
      width: '100px',
      align: 'right',
      // `rate` is absent, not null, when the role cannot see it (UI-11).
      render: (product) => formatMoney(product.rate ?? null),
      redactedReason: (product) => (product.rate === undefined ? RATE_PERMISSION : undefined),
    },
    {
      key: 'stock',
      header: t('catalog.products.column.stock'),
      width: '1.3fr',
      render: (product) => (
        <StockByColour productId={product.id} stock={view.stock} colourHex={colourHex} />
      ),
    },
  ];

  const openProduct = view.products.find((product) => product.id === openProductId) ?? null;

  return (
    <>
      <DataTable
        columns={columns}
        rows={products}
        rowKey={(product) => product.id}
        onRowOpen={(product) => setOpenProductId(product.id)}
        openOn="click"
        selectedId={openProductId ?? undefined}
        empty={
          view.products.length === 0 ? (
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

      <Drawer
        open={openProduct !== null}
        onClose={() => setOpenProductId(null)}
        title={openProduct?.name}
        subtitle={
          openProduct && (
            <span className="ob-mono">
              {openProduct.productCode}
              {openProduct.alias ? ` · ${openProduct.alias}` : ''}
            </span>
          )
        }
      >
        {openProduct && (
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
        )}
      </Drawer>

      <ProductDrawer
        open={productDrawerOpen}
        onClose={() => setProductDrawerOpen(false)}
        onCreated={onProductCreated}
        onError={onDrawerError}
      />
      <ProductDrawer
        open={editingProduct !== null}
        product={editingProduct}
        onClose={() => setEditingProduct(null)}
        onUpdated={onProductUpdated}
        onError={onDrawerError}
      />
    </>
  );
}
