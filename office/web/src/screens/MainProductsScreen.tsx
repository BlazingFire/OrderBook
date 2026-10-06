/**
 * Products → Products and → Brands: the two sidebar pages beside the
 * sub-product list (`docs/catalogue/CATALOGUE_MODEL.md` §1, §5).
 *
 * A **product** here is a category in the code's words — `One Piece
 * Toilet`, with a code, a brand and a catalogue order — and its sub products
 * are the models under it.
 *
 * **A product is company-wide configuration, so it is online-only.** The
 * list, create, edit and delete go to the Master through this panel's server
 * and fail with the Master's own sentence when it is off; the list alone falls
 * back to the snapshot's copy offline. Nothing here queues: a code clash or a
 * "still has sub products" refusal must reach the person who pressed the
 * button, not a sync log.
 *
 * **Delete is the Master's decision.** A product with live sub products is
 * refused with a `ConflictError`; the screen shows that message as sent rather
 * than predicting it from counts that may be a moment stale. A deleted product
 * goes to the Recycle Bin, where it is restored.
 *
 * A row opens a detail sub-screen, like every record in this panel: the
 * product's fields and its sub products in catalogue order, read off the
 * snapshot, which carries the whole catalogue. Edit is a dialog, because a form
 * is one.
 *
 * Brands are the `product.brand` option list — add, rename, reorder and retire
 * through the shared `OptionListEditor`, behind `fields.manage` like every
 * other managed list.
 */

import { exportCatalogueCsv, exportFailureText } from '../components/exportCatalogue';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CategoryInput, ProductCategory, ProductCategoryListRow } from '@orderbook/shared';
import { CATEGORY_CODE_PATTERN } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { optionListTransport } from '../optionListTransport';
import { byCatalogueOrder, codesOf, productLabel } from '../productSummary';
import {
  Button,
  Card,
  DataTable,
  EditorScreen,
  EmptyState,
  ErrorState,
  Field,
  FieldGroup,
  FilterChip,
  Input,
  KeyValueList,
  Modal,
  NumberInput,
  OptionListEditor,
  Select,
  SkeletonTable,
  apiErrorText,
  rem,
  t,
  useColourHex,
  useCommand,
  useDebounced,
  useEnterToAdvance,
  useFilterBar,
  useSubNav,
  useFormBaseline,
  useToast,
  useUnsavedWork,
  type DataTableColumn,
} from '@orderbook/ui';
import { SubProductColour } from './ProductDetail';

/** Long enough that a fast typist issues one request, short enough not to lag. */
const SEARCH_DEBOUNCE_MS = 250;

/** A snapshot push lands in bursts; one refetch per burst is plenty. */
const REFETCH_DEBOUNCE_MS = 500;

/** The active `product.brand` values, in the list's own order. */
function useBrands(view: LocalView) {
  return useMemo(
    () =>
      view.optionLists
        .filter(
          (option) => option.listKey === 'product.brand' && option.isActive && !option.deletedAt,
        )
        .sort((a, b) => a.sequence - b.sequence),
    [view.optionLists],
  );
}

export function MainProductsScreen({ view }: { view: LocalView }) {
  const toast = useToast();
  const colourHex = useColourHex(view.optionLists);
  const brands = useBrands(view);
  const can = (permission: string): boolean => view.permissions.includes(permission);

  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState<string | null>(null);
  const [rows, setRows] = useState<ProductCategoryListRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped to refetch — after a write, a sync that moved the catalogue, or a retry. */
  const [revision, setRevision] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The form: `'new'`, the product being edited, or closed. */
  const [editing, setEditing] = useState<ProductCategory | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ProductCategory | null>(null);
  const [busy, setBusy] = useState(false);

  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    // The categories call takes no signal; a flag drops a superseded answer.
    let superseded = false;
    api
      .categories({ search: term || undefined, brand: brand ?? undefined })
      .then((result) => {
        if (superseded) return;
        setRows(result);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!superseded) setLoadFailed(true);
      });
    return () => {
      superseded = true;
    };
  }, [term, brand, revision]);

  /*
   * Refetch when the snapshot says the catalogue moved: a product edited
   * anywhere, or a sub product added, removed or moved to another product (the
   * counts). Sub products by id and clock, as the sub-product list does — a
   * count alone misses a move, or a sync that drops one and adds another.
   */
  const fingerprint = useMemo(() => {
    const categories = view.categories.map((category) => `${category.id}:${category.updatedAt}`);
    const products = view.products.map((product) => `${product.id}:${product.sync.hlc}`);
    return `${categories.join('|')}#${products.join('|')}`;
  }, [view.categories, view.products]);
  const seenFingerprint = useRef(fingerprint);
  useEffect(() => {
    if (seenFingerprint.current === fingerprint) return;
    seenFingerprint.current = fingerprint;
    const timer = setTimeout(() => setRevision((current) => current + 1), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fingerprint]);

  const open =
    rows?.find((row) => row.id === openId) ??
    view.categories.find((category) => category.id === openId) ??
    null;

  // Registered under the Products module — the screen id the shell reads — and
  // hung under this page, not under the sub-product list beside it.
  useSubNav(
    'products',
    open
      ? {
          parentId: 'products.main',
          items: [
            {
              id: 'products.main.detail',
              label: productLabel(open.name),
              icon: 'products',
            },
          ],
          activeId: 'products.main.detail',
        }
      : null,
  );

  useFilterBar(
    open ? null : (
      <>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('catalog.mainProducts.searchPlaceholder')}
          aria-label={t('catalog.mainProducts.searchLabel')}
          data-screen-search
          style={{ width: rem(320) }}
        />
        <FilterChip
          active={brand === null}
          count={brand === null ? rows?.length : undefined}
          onClick={() => setBrand(null)}
        >
          {t('catalog.filter.all')}
        </FilterChip>
        {brands.map((option) => (
          <FilterChip
            key={option.id}
            active={brand === option.value}
            count={brand === option.value ? rows?.length : undefined}
            onClick={() => setBrand(option.value)}
          >
            {option.label}
          </FilterChip>
        ))}
        <span style={{ flex: 1 }} />
        <Button
          variant="secondary"
          size="sm"
          icon="upload"
          onClick={() =>
            void exportCatalogueCsv('main').catch((caught) =>
              toast.push(exportFailureText(caught), { tone: 'error' }),
            )
          }
        >
          {t('catalog.export')}
        </Button>
        {can('products.create') && (
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            {t('catalog.mainProducts.new')}
          </Button>
        )}
      </>
    ),
  );

  function saved(name: string, created: boolean): void {
    setEditing(null);
    setRevision((current) => current + 1);
    toast.push(
      t(created ? 'catalog.mainProducts.created' : 'catalog.mainProducts.updated', { name }),
    );
  }

  async function remove(category: ProductCategory): Promise<void> {
    setBusy(true);
    try {
      await api.deleteCategory(category.id);
      setDeleting(null);
      setOpenId(null);
      setRevision((current) => current + 1);
      toast.push(t('catalog.mainProducts.deleted', { name: category.name }));
    } catch (caught) {
      setDeleting(null);
      toast.push(apiErrorText(caught, 'catalog.mainProducts.deleteFailed'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const dialogs = (
    <>
      <MainProductForm
        open={editing !== null}
        category={editing === 'new' ? null : editing}
        brands={brands}
        onClose={() => setEditing(null)}
        onSaved={saved}
        onError={(message) => toast.push(message, { tone: 'error' })}
      />
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? t('catalog.mainProducts.delete.title', { name: deleting.name }) : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => deleting && void remove(deleting)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="ob-body">{t('catalog.mainProducts.delete.body')}</p>
      </Modal>
    </>
  );

  if (open) {
    const subProducts = view.products
      .filter((product) => product.categoryId === open.id)
      .sort(byCatalogueOrder);

    return (
      <EditorScreen
        title={productLabel(open.name)}
        meta={open.brand ? <span className="ob-small">{open.brand}</span> : undefined}
        onBack={() => {
          setOpenId(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <Card>
          <KeyValueList
            items={[
              {
                label: t('catalog.mainProducts.field.code'),
                value: <span className="ob-mono">{open.code ?? '—'}</span>,
              },
              { label: t('catalog.mainProducts.field.name'), value: open.name },
              { label: t('catalog.mainProducts.field.brand'), value: open.brand ?? '—' },
              { label: t('catalog.mainProducts.field.sortOrder'), value: open.sortOrder ?? '—' },
            ]}
          />
        </Card>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)' }}>
          {can('products.edit') && (
            <Button variant="primary" size="sm" icon="edit" onClick={() => setEditing(open)}>
              {t('action.edit')}
            </Button>
          )}
          {can('products.delete') && (
            <Button variant="danger" size="sm" icon="trash" onClick={() => setDeleting(open)}>
              {t('action.delete')}
            </Button>
          )}
        </div>

        <div>
          <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
            {t('catalog.mainProducts.detail.subProducts', { count: subProducts.length })}
          </div>
          <DataTable
            columns={[
              {
                key: 'name',
                header: t('catalog.products.column.name'),
                render: (product) => <span className="ob-body-strong">{product.name}</span>,
              },
              {
                key: 'code',
                header: t('catalog.products.column.codes'),
                width: rem(140),
                render: (product) => <span className="ob-mono">{codesOf(product)}</span>,
              },
              {
                key: 'size',
                header: t('catalog.products.column.size'),
                width: rem(160),
                render: (product) => product.size ?? '—',
              },
              {
                key: 'colour',
                header: t('catalog.products.column.colours'),
                width: rem(160),
                render: (product) => <SubProductColour product={product} colourHex={colourHex} />,
              },
            ]}
            rows={subProducts}
            rowKey={(product) => product.id}
            empty={
              <p
                className="ob-small"
                style={{ margin: 0, padding: 'var(--s-16)', color: 'var(--fg-tertiary)' }}
              >
                {t('catalog.mainProducts.detail.none')}
              </p>
            }
          />
        </div>
        {dialogs}
      </EditorScreen>
    );
  }

  const columns: DataTableColumn<ProductCategoryListRow>[] = [
    {
      key: 'code',
      header: t('catalog.mainProducts.column.code'),
      width: rem(100),
      render: (row) => (
        <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
          {row.code ?? '—'}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('catalog.mainProducts.column.name'),
      render: (row) => (
        <span className="ob-body-strong" style={{ fontSize: rem(13.5) }}>
          {row.name}
        </span>
      ),
    },
    {
      key: 'brand',
      header: t('catalog.products.column.brand'),
      width: rem(140),
      render: (row) => row.brand ?? '—',
    },
    {
      key: 'subProducts',
      header: t('catalog.mainProducts.column.subProducts'),
      width: rem(120),
      align: 'right',
      render: (row) => <span className="ob-data">{row.subProductCount}</span>,
    },
    {
      key: 'sortOrder',
      header: t('catalog.mainProducts.column.sortOrder'),
      priority: 3,
      width: rem(90),
      align: 'right',
      render: (row) => <span className="ob-data">{row.sortOrder ?? '—'}</span>,
    },
  ];

  return (
    <>
      {rows === null && !loadFailed ? (
        <SkeletonTable columns={columns} rows={8} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows ?? []}
          rowKey={(row) => row.id}
          onRowOpen={(row) => setOpenId(row.id)}
          empty={
            loadFailed ? (
              <ErrorState
                title={t('catalog.mainProducts.loadFailed')}
                actionLabel={t('action.retryNow')}
                onAction={() => setRevision((current) => current + 1)}
              />
            ) : term || brand ? (
              <EmptyState title={t('catalog.mainProducts.empty.filtered')} />
            ) : (
              <EmptyState
                title={t('catalog.mainProducts.empty.title')}
                description={t('catalog.mainProducts.empty.description')}
                actionLabel={can('products.create') ? t('catalog.mainProducts.new') : undefined}
                onAction={can('products.create') ? () => setEditing('new') : undefined}
              />
            )
          }
        />
      )}
      {dialogs}
    </>
  );
}

/**
 * Create or edit one product: code, name, brand, catalogue order.
 *
 * The code is checked against `CATEGORY_CODE_PATTERN` here only to save a
 * round trip; the Master checks it again, and alone decides uniqueness.
 */
function MainProductForm({
  open,
  category,
  brands,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  category: ProductCategory | null;
  brands: ReadonlyArray<{ value: string; label: string }>;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [sortOrder, setSortOrder] = useState('');
  const [busy, setBusy] = useState(false);
  const baseline = useFormBaseline<unknown>();

  useEffect(() => {
    if (!open) return;
    const loaded = {
      code: category?.code ?? '',
      name: category?.name ?? '',
      brand: category?.brand ?? '',
      sortOrder: category?.sortOrder != null ? String(category.sortOrder) : '',
    };
    baseline.mark(loaded);
    setCode(loaded.code);
    setName(loaded.name);
    setBrand(loaded.brand);
    setSortOrder(loaded.sortOrder);
    // Keyed on identity: a live update must not wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, category?.id]);

  // A brand since retired from the list still shows on the product it is on.
  const brandOptions =
    brand && !brands.some((option) => option.value === brand)
      ? [...brands, { value: brand, label: brand }]
      : brands;

  const fields = useRef<HTMLDivElement>(null);
  useEnterToAdvance(fields, () => void save(), open);
  useCommand('record.save', open && !busy ? () => void save() : null);

  /** True when the product was saved; false when it was refused or failed (the reason went to `onError`). */
  async function save(): Promise<boolean> {
    const input: CategoryInput = {
      code: code.trim(),
      name: name.trim(),
      brand: brand || null,
      sortOrder: sortOrder ? Number(sortOrder) : null,
    };
    // A brand retired since it was set stays on the product (`brandOptions`),
    // but the Master refuses to be told it again, as it refuses any brand off
    // the list. Unchanged, it is left out, so the rest of the form still saves.
    if (category && input.brand === category.brand) delete input.brand;
    if (!CATEGORY_CODE_PATTERN.test(input.code)) {
      onError(t('catalog.mainProducts.codeInvalid'));
      return false;
    }
    if (!input.name) {
      onError(t('catalog.mainProducts.nameRequired'));
      return false;
    }

    setBusy(true);
    try {
      if (category) await api.updateCategory(category.id, input);
      else await api.createCategory(input);
      onSaved(input.name, !category);
      return true;
    } catch (caught) {
      onError(apiErrorText(caught, 'catalog.mainProducts.saveFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // "Save all and update": a main product being added or changed is saved if it
  // is complete, and named if it is not.
  useUnsavedWork(
    'main-product-form',
    open && baseline.dirty({ code, name, brand, sortOrder })
      ? { label: t('updates.saveAll.mainProduct', { name: name.trim() || code.trim() || '…' }), save }
      : null,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={category ? t('catalog.mainProducts.edit.title') : t('catalog.mainProducts.new.title')}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div ref={fields}>
        <FieldGroup title={t('product.group.identity')}>
          <Field
            label={t('catalog.mainProducts.field.code')}
            hint={t('catalog.mainProducts.field.codeHint')}
            required
          >
            {(id) => (
              <Input
                id={id}
                value={code}
                className="ob-mono"
                autoFocus
                onChange={(event) => setCode(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('catalog.mainProducts.field.name')} required span={2}>
            {(id) => (
              <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field label={t('catalog.mainProducts.field.brand')}>
            {(id) => (
              <Select id={id} value={brand} onChange={(event) => setBrand(event.target.value)}>
                <option value="">{t('catalog.mainProducts.field.noBrand')}</option>
                {brandOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('catalog.mainProducts.field.sortOrder')}
            hint={t('catalog.mainProducts.field.sortOrderHint')}
          >
            {(id) => (
              <NumberInput
                id={id}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value.replace(/[^0-9]/g, ''))}
              />
            )}
          </Field>
        </FieldGroup>
      </div>
    </Modal>
  );
}

/** Products → Brands: the `product.brand` list, read by everyone, editable with `catalog.lists.manage`. */
export function BrandsScreen({ view, revision }: { view: LocalView; revision?: number }) {
  // No record opens here; say so, or a detail open on a sibling page would
  // stay highlighted in the sidebar while this one shows.
  useSubNav('products', null);

  return (
    <OptionListEditor
      listKey="product.brand"
      canManage={view.permissions.includes('catalog.lists.manage')}
      transport={optionListTransport}
      revision={revision}
    />
  );
}
