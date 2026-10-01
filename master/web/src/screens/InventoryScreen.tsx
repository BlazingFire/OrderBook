/**
 * Inventory, per variant (docs/LEAD_GENERATION_FLOW.md §5.1, §6;
 * docs/catalogue/CATALOGUE_MODEL.md §7).
 *
 * A row is one variant of one product — the thing a code names, the thing a
 * lead line is raised on, the thing a reservation holds. In the catalogue's
 * words that is a sub product (every catalogue sub product is a model with
 * exactly one variant), so the row reads the way the catalogue does: brand,
 * product (`OPT · One Piece Toilet`), sub product, size, colour. Every live
 * variant is listed, stocked or not — a sub product nobody has counted yet is
 * a zero, not an absence.
 *
 * Three quantities are shown side by side because they answer different
 * questions: what is on the floor, what is already reserved for orders that
 * have not been dispatched, and what is therefore free to sell. Only the last
 * one is what a new order can actually draw on, so it is what "low stock" is
 * judged against.
 *
 * The code is read-only here: it belongs to the product master, where the
 * catalogue form edits it alongside the variant's label and weight. What this
 * screen owns is the stock band — reorder, min and max — edited inline,
 * because this is the only screen that lists every variant with its figures.
 *
 * Stock is allowed to go negative — a dealer routinely sells against a factory
 * order that has not arrived. The shortfall is surfaced, never blocked.
 *
 * Clicking a stock row opens that variant as a sub-screen (with a back button
 * and a nested sidebar entry): the same three quantities, a ledger of just
 * its movements, and "Stock in" / "Adjust to physical count" pre-locked to the
 * line so the fast path never requires re-picking the product and sub product.
 * The two forms themselves stay modals over it.
 *
 * What a person may do follows their role, as on the Office: Stock in needs
 * `inventory.edit`, Physical count `stock.adjust`, and the reorder / min / max
 * cells are plain figures without `inventory.edit`. The buttons are absent,
 * not greyed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PICK_MAX_LIMIT,
  shownColour,
  type InventoryStockLevel,
  type OptionListItem,
  type Product,
  type ProductCategory,
  type ProductVariant,
  type StockMovement,
} from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  Card,
  ColourChip,
  ColourName,
  DataTable,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  FormField,
  Input,
  Modal,
  NumberInput,
  Section,
  Select,
  SkeletonTable,
  StatusPill,
  formatDateTime,
  formatKg,
  rem,
  t,
  useColourHex,
  useDebounced,
  useEnterToAdvance,
  useFilterBar,
  useSubNav,
  type DataTableColumn,
} from '@orderbook/ui';

interface Props {
  revision: number;
  /** Which slice is showing — chosen here or from the sidebar's sub-pages. */
  filter: 'all' | 'low';
  onFilterChange: (filter: 'all' | 'low') => void;
  /**
   * The company's free-to-sell switch. Off, the Master already reports free as
   * the floor count and nothing reserved; this drops the two columns that
   * would then only repeat the first.
   */
  freeToSell: boolean;
  /** `inventory.adjustmentNoteRequired`, already coalesced by the shell. */
  adjustmentNoteRequired: boolean;
  /** The signed-in user's permission keys. */
  permissions: string[];
}

const MOVEMENT_TYPE_KEY = {
  inbound: 'inventory.movementType.inbound',
  outbound: 'inventory.movementType.outbound',
  adjustment: 'inventory.movementType.adjustment',
} as const;

/**
 * The stock list asks for the Master's whole cap. Every live variant has a row
 * even before any stock arrives, so the default page of 200 would cut the
 * catalogue's 549 sub products short.
 */
// ponytail: one page at the Master's 1,000-row clamp; page with `offset` once a catalogue outgrows it.
const STOCK_LIMIT = 1000;

/**
 * The variant's name as the screen speaks of it: its label, or the code alone
 * — the code alone too when the label only repeats the sub product's name
 * (`MAGENTA` in Magenta, CATALOGUE_MODEL.md §2), as the Colour column does.
 */
function variantName(level: {
  variantCode: string;
  variantLabel: string | null;
  productName: string;
}): string {
  const label = shownColour(level.variantLabel, level.productName);
  return label ? `${label} · ${level.variantCode}` : level.variantCode;
}

/** `OPT · One Piece Toilet`; just the name for a product from before codes. */
function categoryLabel(code: string | null, name: string | null): string {
  return [code, name].filter(Boolean).join(' · ');
}

/**
 * A line named for a dialog title or a field label: `OPT · 1111`. The sub
 * product alone is not enough — `1111` or `MAGENTA` can sit under two products.
 */
function lineName(level: InventoryStockLevel): string {
  return [level.categoryCode ?? level.categoryName, level.productName].filter(Boolean).join(' · ');
}

/**
 * The Colour a row shows (CATALOGUE_MODEL.md §2, §7): a `fixed` sub product's
 * colour — its variant label — unless it only repeats the name (`MAGENTA` in
 * Magenta). Nothing for `dedicated` (no label) and nothing for `selectable`:
 * colour is not a stock key, so a multicolour sub product's one row stands for
 * every colour and naming one would be false.
 */
function lineColour(line: {
  multiColour: boolean;
  variantLabel: string | null;
  productName: string;
}): string | null {
  return line.multiColour ? null : shownColour(line.variantLabel, line.productName);
}

/**
 * A colour's name, with its swatch when the colour range has one. A label
 * outside the range (Wooden, a pattern such as `Vitrosa 41`) stays plain text:
 * the two-letter ring `ColourChip` falls back to would read as a swatch that
 * is not there.
 */
function ColourText({ name, hex }: { name: string; hex: string | undefined }) {
  return hex ? <ColourName name={name} hex={hex} /> : <span>{name}</span>;
}

export function InventoryScreen({
  revision,
  filter,
  onFilterChange,
  freeToSell,
  adjustmentNoteRequired,
  permissions,
}: Props) {
  const canStockIn = permissions.includes('inventory.edit');
  const canCount = permissions.includes('stock.adjust');
  const canEditBand = permissions.includes('inventory.edit');
  const [levels, setLevels] = useState<InventoryStockLevel[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [optionLists, setOptionLists] = useState<OptionListItem[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const colourHex = useColourHex(optionLists);
  const [search, setSearch] = useState('');
  // The input stays wired to the raw value so typing feels instant; only the
  // network-triggering effect waits. Without this the screen fired a full
  // request per keystroke, so fast typing produced a burst of overlapping
  // requests for characters the person had already typed past.
  const debouncedSearch = useDebounced(search);
  const [brand, setBrand] = useState<string | null>(null);
  /** The Product filter — a category id, `''` for every product. */
  const [categoryId, setCategoryId] = useState('');
  const lowOnly = filter === 'low';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stockInOpen, setStockInOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [lineLock, setLineLock] = useState<InventoryStockLevel | null>(null);

  // Which variant is opened into its detail dialog, and the movements scoped
  // to just that line. The dialog's summary numbers are *not* stored here —
  // they are derived from `levels` below so they stay live as `levels`
  // reloads.
  const [openVariantId, setOpenVariantId] = useState<string | null>(null);
  const [lineMovements, setLineMovements] = useState<StockMovement[]>([]);
  const [lineMovementsLoading, setLineMovementsLoading] = useState(false);

  /*
   * Numbers each load; only the latest one's answer is kept. Every chip press,
   * product pick and search asks again, and a slower, older answer landing
   * last would show another filter's rows under the chip that is lit.
   */
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const [stock, recent] = await Promise.all([
        api.stock({
          search: debouncedSearch || undefined,
          lowOnly,
          brand: brand ?? undefined,
          categoryId: categoryId || undefined,
          limit: STOCK_LIMIT,
        }),
        api.stockMovements(),
      ]);
      if (request !== latestLoad.current) return;
      setLevels(stock);
      setMovements(recent);
    } catch (caught) {
      if (request !== latestLoad.current) return;
      setError(caught instanceof Error ? caught.message : t('inventory.error.load'));
    }
  }, [debouncedSearch, lowOnly, brand, categoryId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // Per revision, not once: the brand chips, the colour swatches and the
  // Product filter are the catalogue's, and an edit made elsewhere should
  // reach them here.
  useEffect(() => {
    void api
      .optionLists()
      .then(setOptionLists)
      .catch(() => setOptionLists([]));
    void api
      .categories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [revision]);

  const sameBrand = (value: string | null, other: string): boolean =>
    value?.toLowerCase() === other.toLowerCase();

  // The one still chosen stays listed after it is switched off, so a filter
  // never holds a value its chip no longer offers a way out of.
  const brands = optionLists.filter(
    (option) => option.listKey === 'product.brand' && (option.isActive || option.value === brand),
  );
  const productOptions = categories.filter(
    (category) => category.id === categoryId || brand === null || sameBrand(category.brand, brand),
  );

  function chooseBrand(value: string): void {
    // A second press clears it: the chips narrow, they never have to be
    // un-chosen through some other control.
    const next = brand === value ? null : value;
    setBrand(next);
    // A product of another brand would leave the two filters agreeing on
    // nothing, and an empty table that looks like missing stock.
    const chosen = categories.find((category) => category.id === categoryId);
    if (next !== null && chosen && !sameBrand(chosen.brand, next)) setCategoryId('');
  }

  // Reports whether the write landed. The movement modals close themselves on
  // success and stay open on failure, so a rejected write that resolves like an
  // accepted one is exactly what would make those two outcomes look identical.
  async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const loadLineMovements = useCallback(async (variantId: string) => {
    setLineMovementsLoading(true);
    setLineMovements([]);
    try {
      setLineMovements(await api.stockMovements({ variantId }));
    } catch {
      setLineMovements([]);
    } finally {
      setLineMovementsLoading(false);
    }
  }, []);

  // The opened line is held, so a filter or refetch that drops it from `levels` does not close its screen.
  const [heldLevel, setHeldLevel] = useState<InventoryStockLevel | null>(null);
  const freshLevel = openVariantId
    ? (levels.find((level) => level.variantId === openVariantId) ?? null)
    : null;
  useEffect(() => {
    if (freshLevel) setHeldLevel(freshLevel);
  }, [freshLevel]);
  const openLevel = openVariantId
    ? (freshLevel ?? (heldLevel?.variantId === openVariantId ? heldLevel : null))
    : null;
  const openColour = openLevel && lineColour(openLevel);
  const openHex = openColour ? colourHex(openColour) : undefined;

  function openLine(level: InventoryStockLevel): void {
    setHeldLevel(level);
    setOpenVariantId(level.variantId);
    void loadLineMovements(level.variantId);
  }

  function openLineStockIn(level: InventoryStockLevel): void {
    setLineLock(level);
    setStockInOpen(true);
  }

  function openLineAdjust(level: InventoryStockLevel): void {
    setLineLock(level);
    setAdjustOpen(true);
  }

  useFilterBar(
    openLevel ? null : (
    <>
      <div className="ob-search" style={{ width: rem(320) }}>
        <Input
          value={search}
          placeholder={t('inventory.search.placeholder')}
          aria-label={t('inventory.search.placeholder')}
          data-screen-search
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <FilterChip active={!lowOnly} onClick={() => onFilterChange('all')}>
        {t('inventory.filter.all')}
      </FilterChip>
      <FilterChip active={lowOnly} onClick={() => onFilterChange('low')}>
        {t('inventory.filter.lowOnly')}
      </FilterChip>
      {brands.length > 0 && <FilterDivider />}
      {brands.map((option) => (
        <FilterChip
          key={option.id}
          active={brand === option.value}
          onClick={() => chooseBrand(option.value)}
        >
          {option.label}
        </FilterChip>
      ))}
      <span style={{ flex: 1 }} />
      {freeToSell && (
        <span
          className="ob-small"
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
        >
          {t('inventory.filterNote')}
        </span>
      )}
    </>
    ),
  );

  useSubNav(
    'inventory',
    openLevel
      ? {
          parentId: 'inventory',
          items: [
            {
              id: 'inventory.detail',
              label: t('inventory.drawer.title', {
                product: lineName(openLevel),
                variant: variantName(openLevel),
              }),
              icon: 'inventory',
            },
          ],
          activeId: 'inventory.detail',
        }
      : null,
  );

  const totalFree = levels.reduce((sum, level) => sum + level.availableBoxes, 0);

  /**
   * One editable figure of the stock band. Saves on blur, sends only its own
   * field — absent means untouched on the Master, so the three cells on a row
   * never overwrite each other.
   */
  const bandCell = (
    level: InventoryStockLevel,
    field: 'reorderLevel' | 'minStockLevel' | 'maxStockLevel',
    labelKey: 'inventory.reorderLevelLabel' | 'inventory.minLevelLabel' | 'inventory.maxLevelLabel',
  ) =>
    !canEditBand ? (
      <span>{level[field] ?? '—'}</span>
    ) : (
    <NumberInput
      key={`${level.variantId}-${field}-${level[field] ?? ''}`}
      defaultValue={level[field] ?? ''}
      aria-label={t(labelKey, { product: lineName(level), variant: variantName(level) })}
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const next = event.target.value === '' ? null : Number(event.target.value);
        if (next === (level[field] ?? null)) return;
        void run(
          () => api.setReorderLevel({ variantId: level.variantId, [field]: next }),
          t('inventory.error.reorder'),
        );
      }}
    />
    );

  const levelColumns: DataTableColumn<InventoryStockLevel>[] = [
    {
      key: 'brand',
      header: t('inventory.table.brand'),
      priority: 3,
      width: rem(110),
      render: (level) => <span className="ob-ellipsis">{level.brand ?? ''}</span>,
    },
    {
      key: 'product',
      header: t('inventory.table.product'),
      render: (level) => (
        <span className="ob-ellipsis">{categoryLabel(level.categoryCode, level.categoryName)}</span>
      ),
    },
    {
      key: 'subProduct',
      header: t('inventory.table.subProduct'),
      width: rem(150),
      render: (level) => <span className="ob-ellipsis">{level.productName}</span>,
    },
    {
      key: 'size',
      header: t('inventory.table.size'),
      priority: 2,
      width: rem(130),
      render: (level) => <span className="ob-ellipsis">{level.size ?? ''}</span>,
    },
    {
      key: 'colour',
      header: t('inventory.table.colour'),
      width: rem(130),
      render: (level) => {
        const colour = lineColour(level);
        return colour && <ColourText name={colour} hex={colourHex(colour)} />;
      },
    },
    {
      // Read-only: the code is the product master's, edited on the catalogue
      // form beside the variant's label and weight.
      key: 'code',
      header: t('inventory.table.code'),
      priority: 2,
      width: rem(100),
      render: (level) => <span className="ob-mono">{level.variantCode}</span>,
    },
    {
      key: 'weight',
      header: t('inventory.table.weight'),
      priority: 3,
      width: rem(132),
      align: 'right',
      render: (level) =>
        level.weightKg === null ? (
          <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
        ) : (
          formatKg(level.weightKg)
        ),
    },
    {
      key: 'onHand',
      header: t('inventory.table.onHand'),
      width: rem(90),
      align: 'right',
      render: (level) => level.quantityBoxes,
    },
    ...(freeToSell
      ? [
          {
            key: 'reserved',
            header: t('inventory.table.reserved'),
            width: rem(90),
            align: 'right' as const,
            render: (level: InventoryStockLevel) => String(level.reservedBoxes),
          },
          {
            key: 'free',
            header: t('inventory.table.free'),
            width: rem(90),
            align: 'right' as const,
            render: (level: InventoryStockLevel) => (
              <span
                className="ob-body-strong"
                style={{ color: level.availableBoxes < 0 ? 'var(--state-conflict)' : undefined }}
              >
                {level.availableBoxes}
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'reorder',
      header: t('inventory.table.reorder'),
      priority: 3,
      width: rem(96),
      align: 'right',
      render: (level) => bandCell(level, 'reorderLevel', 'inventory.reorderLevelLabel'),
    },
    {
      key: 'min',
      header: t('inventory.table.min'),
      priority: 3,
      width: rem(90),
      align: 'right',
      render: (level) => bandCell(level, 'minStockLevel', 'inventory.minLevelLabel'),
    },
    {
      key: 'max',
      header: t('inventory.table.max'),
      priority: 3,
      width: rem(90),
      align: 'right',
      render: (level) => bandCell(level, 'maxStockLevel', 'inventory.maxLevelLabel'),
    },
    {
      key: 'status',
      header: t('inventory.table.status'),
      width: rem(100),
      render: (level) =>
        level.isLow ? (
          <StatusPill tone="offline">{t('inventory.status.low')}</StatusPill>
        ) : (
          <StatusPill tone="ok">{t('inventory.status.healthy')}</StatusPill>
        ),
    },
  ];

  const movementColumns: DataTableColumn<StockMovement>[] = [
    {
      key: 'when',
      header: t('inventory.movements.table.when'),
      width: rem(150),
      render: (movement) => formatDateTime(movement.createdAt),
    },
    {
      key: 'product',
      header: t('inventory.movements.table.product'),
      render: (movement) => movement.productName,
    },
    {
      key: 'variant',
      header: t('inventory.movements.table.variant'),
      width: rem(170),
      render: (movement) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
          {/* The fixed colour, as the stock rows show it — not `MAGENTA`'s Magenta. */}
          {movement.variantLabel && shownColour(movement.variantLabel, movement.productName) && (
            <ColourText name={movement.variantLabel} hex={colourHex(movement.variantLabel)} />
          )}
          <span className="ob-mono ob-small">{movement.variantCode}</span>
        </span>
      ),
    },
    {
      key: 'type',
      header: t('inventory.movements.table.type'),
      width: rem(110),
      render: (movement) => t(MOVEMENT_TYPE_KEY[movement.movementType]),
    },
    {
      key: 'change',
      header: t('inventory.movements.table.change'),
      width: rem(90),
      align: 'right',
      render: (movement) => (
        <span
          style={{
            color: movement.quantityBoxes < 0 ? 'var(--state-conflict)' : 'var(--state-ok)',
          }}
        >
          {movement.quantityBoxes > 0 ? '+' : ''}
          {movement.quantityBoxes}
        </span>
      ),
    },
    {
      key: 'reference',
      header: t('inventory.movements.table.reference'),
      width: rem(170),
      render: (movement) => (
        <span className="ob-small">
          {movement.referenceType}
          {movement.referenceId ? ` ${movement.referenceId}` : ''}
        </span>
      ),
    },
    {
      key: 'note',
      header: t('inventory.movements.table.note'),
      render: (movement) => movement.note ?? '—',
    },
  ];

  // Same shape as `movementColumns` minus product/variant — the dialog's
  // ledger is already scoped to one variant.
  const lineMovementColumns: DataTableColumn<StockMovement>[] = [
    {
      key: 'when',
      header: t('inventory.movements.table.when'),
      width: rem(112),
      render: (movement) => formatDateTime(movement.createdAt),
    },
    {
      key: 'type',
      header: t('inventory.movements.table.type'),
      width: rem(86),
      render: (movement) => t(MOVEMENT_TYPE_KEY[movement.movementType]),
    },
    {
      key: 'change',
      header: t('inventory.movements.table.change'),
      width: rem(72),
      align: 'right',
      render: (movement) => (
        <span
          style={{
            color: movement.quantityBoxes < 0 ? 'var(--state-conflict)' : 'var(--state-ok)',
          }}
        >
          {movement.quantityBoxes > 0 ? '+' : ''}
          {movement.quantityBoxes}
        </span>
      ),
    },
    {
      key: 'reference',
      header: t('inventory.movements.table.reference'),
      width: rem(112),
      render: (movement) => (
        <span className="ob-small">
          {movement.referenceType}
          {movement.referenceId ? ` ${movement.referenceId}` : ''}
        </span>
      ),
    },
    {
      key: 'note',
      header: t('inventory.movements.table.note'),
      render: (movement) => movement.note ?? '—',
    },
  ];

  /**
   * One stock line, in full: the three figures that matter and that line's own
   * ledger. The two writes that act on it live in the dialog's footer.
   */
  function renderLineDetail(level: InventoryStockLevel) {
    return (
      <div className="ob-detail">
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${freeToSell ? 3 : 1}, 1fr)`,
            gap: 'var(--s-8)',
          }}
        >
          <Card>
            <div className="ob-eyebrow">{t('inventory.table.onHand')}</div>
            <div
              className="ob-display"
              style={{ marginTop: 'var(--s-6)', fontVariantNumeric: 'tabular-nums' }}
            >
              {level.quantityBoxes}
            </div>
          </Card>
          {freeToSell && (
            <>
              <Card>
                <div className="ob-eyebrow">{t('inventory.table.reserved')}</div>
                <div
                  className="ob-display"
                  style={{ marginTop: 'var(--s-6)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {level.reservedBoxes}
                </div>
              </Card>
              <Card>
                <div className="ob-eyebrow">{t('inventory.table.free')}</div>
                <div
                  className="ob-display"
                  style={{
                    marginTop: 'var(--s-6)',
                    fontVariantNumeric: 'tabular-nums',
                    color: level.availableBoxes < 0 ? 'var(--state-conflict)' : undefined,
                  }}
                >
                  {level.availableBoxes}
                </div>
              </Card>
            </>
          )}
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('inventory.drawer.ledgerTitle')}</div>
          {lineMovementsLoading ? (
            <SkeletonTable columns={lineMovementColumns} rows={4} />
          ) : (
            <DataTable
              columns={lineMovementColumns}
              rows={lineMovements}
              rowKey={(movement) => String(movement.id)}
              empty={
                <EmptyState
                  title={t('inventory.drawer.ledgerEmpty.title')}
                  description={t('inventory.drawer.ledgerEmpty.description')}
                />
              }
            />
          )}
        </section>
      </div>
    );
  }

  // Over either view: the forms are modals, the detail is a screen.
  const movementModals = (
    <>
      <Modal
        open={stockInOpen}
        onClose={() => {
          setStockInOpen(false);
          setLineLock(null);
        }}
        title={
          lineLock
            ? t('inventory.stockIn.titleForLine', {
                product: lineName(lineLock),
                variant: variantName(lineLock),
              })
            : t('inventory.stockIn.title')
        }
      >
        {/* The page banner sits under this modal's scrim, so a rejected write
            has to say so inside the dialog the operator is looking at. */}
        {error && (
          <div className="ob-banner ob-banner--conflict" role="alert">
            <span style={{ flex: 1 }}>{error}</span>
          </div>
        )}
        <MovementForm
          description={t('inventory.stockIn.description')}
          submitLabel={t('inventory.stockIn.submit')}
          busy={busy}
          lock={lineLock}
          categories={categories}
          colourHex={colourHex}
          onSubmit={async (input) => {
            const saved = await run(() => api.stockInbound(input), t('inventory.error.inbound'));
            if (!saved) return;
            if (lineLock) await loadLineMovements(lineLock.variantId);
            setStockInOpen(false);
            setLineLock(null);
          }}
        />
      </Modal>

      <Modal
        open={adjustOpen}
        onClose={() => {
          setAdjustOpen(false);
          setLineLock(null);
        }}
        title={
          lineLock
            ? t('inventory.physicalCount.titleForLine', {
                product: lineName(lineLock),
                variant: variantName(lineLock),
              })
            : t('inventory.physicalCount.title')
        }
      >
        {error && (
          <div className="ob-banner ob-banner--conflict" role="alert">
            <span style={{ flex: 1 }}>{error}</span>
          </div>
        )}
        <MovementForm
          description={t('inventory.physicalCount.description')}
          levels={levels}
          noteRequired={adjustmentNoteRequired}
          submitLabel={t('inventory.physicalCount.submit')}
          busy={busy}
          lock={lineLock}
          categories={categories}
          colourHex={colourHex}
          onSubmit={async (input) => {
            const saved = await run(() => api.stockAdjust(input), t('inventory.error.adjust'));
            if (!saved) return;
            if (lineLock) await loadLineMovements(lineLock.variantId);
            setAdjustOpen(false);
            setLineLock(null);
          }}
        />
      </Modal>
    </>
  );

  if (openLevel) {
    return (
      <>
        <EditorScreen
          title={t('inventory.drawer.title', {
            product: lineName(openLevel),
            variant: variantName(openLevel),
          })}
          meta={
            <>
              {openColour && openHex && <ColourChip hex={openHex} name={openColour} />}
              <span className="ob-mono ob-small">
                {openLevel.variantCode}
                {openLevel.weightKg !== null ? ` · ${formatKg(openLevel.weightKg)}` : ''}
              </span>
            </>
          }
          actions={
            <>
              {canCount && (
                <Button variant="secondary" size="sm" onClick={() => openLineAdjust(openLevel)}>
                  {t('inventory.drawer.adjust')}
                </Button>
              )}
              {canStockIn && (
                <Button variant="primary" size="sm" onClick={() => openLineStockIn(openLevel)}>
                  {t('inventory.action.stockIn')}
                </Button>
              )}
            </>
          }
          onBack={() => {
            setOpenVariantId(null);
            return true;
          }}
          backLabel={t('action.backToList')}
        >
          {error && (
            <div className="ob-banner ob-banner--conflict" role="alert">
              <span style={{ flex: 1 }}>{error}</span>
            </div>
          )}
          {renderLineDetail(openLevel)}
        </EditorScreen>
        {movementModals}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-24)' }}>
      {error && (
        <div className="ob-banner ob-banner--conflict" role="alert">
          <span style={{ flex: 1 }}>{error}</span>
        </div>
      )}

      <Section
        title={t('inventory.section.stockLevels')}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
            {/* Here rather than in the filter strip: the strip scrolls sideways
                and clips anything taller than itself, so this list would open
                out of sight there. Typing a code or a name narrows it. */}
            <Select
              value={categoryId}
              aria-label={t('inventory.filter.product')}
              style={{ width: rem(260) }}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">{t('inventory.filter.allProducts')}</option>
              {productOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {categoryLabel(category.code, category.name)}
                </option>
              ))}
            </Select>
            <span className="ob-pill">
              {t(freeToSell ? 'inventory.piecesFree' : 'inventory.piecesOnHand', {
                count: totalFree,
              })}
            </span>
            {canStockIn && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setLineLock(null);
                  setStockInOpen(true);
                }}
              >
                {t('inventory.action.stockIn')}
              </Button>
            )}
            {canCount && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setLineLock(null);
                  setAdjustOpen(true);
                }}
              >
                {t('inventory.action.physicalCount')}
              </Button>
            )}
          </div>
        }
      >
        <DataTable
          columns={levelColumns}
          rows={levels}
          rowKey={(level) => level.variantId}
          onRowOpen={openLine}
          selectedId={openVariantId ?? undefined}
          empty={
            <EmptyState
              title={t('inventory.empty.title')}
              description={t('inventory.empty.description')}
            />
          }
        />
      </Section>

      <Section title={t('inventory.movements.title')}>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('inventory.movements.description')}
        </p>
        <DataTable
          columns={movementColumns}
          rows={movements}
          rowKey={(movement) => String(movement.id)}
          empty={
            <EmptyState
              title={t('inventory.movements.empty.title')}
              description={t('inventory.movements.empty.description')}
            />
          }
        />
      </Section>

      {movementModals}
    </div>
  );
}

/** A sub product as its bar lists it: `102 (9") · White · L-27, B-15 · OPT-0001`. */
function subProductLabel(product: Product): string {
  const active = product.variants.filter((variant) => variant.isActive);
  const colour =
    active.length === 1
      ? lineColour({
          multiColour: product.multiColour,
          variantLabel: active[0]?.label ?? null,
          productName: product.name,
        })
      : null;
  return [product.name, colour, product.size, active.map((variant) => variant.code).join(', ')]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Shared by stock-in and physical count: they differ only in what the number
 * means and which endpoint receives it, so one form with two labels beats two
 * near-identical ones.
 *
 * The walk is the lead screen's (CATALOGUE_MODEL.md §7): the product bar (a
 * name or a code narrows it), then every sub product of that product in
 * catalogue order, then the variant — a catalogue sub product has exactly one,
 * so it is chosen for you and its colour shown locked when it has one worth
 * showing. Enter steps through it and saves from the last field. A product
 * from before the catalogue with several variants still asks which.
 *
 * When opened from a line's dialog, `lock` pins it to that line: the bars are
 * replaced by static text so the only thing left to enter is the number (and
 * an optional note).
 *
 * Exported for `ui/tests/inventory-movement-form.test.tsx`, the only jsdom suite.
 */
export function MovementForm({
  description,
  submitLabel,
  busy,
  lock,
  categories,
  colourHex,
  levels = [],
  noteRequired,
  onSubmit,
}: {
  description: string;
  submitLabel: string;
  busy: boolean;
  lock?: InventoryStockLevel | null;
  /** The live products (categories), in catalogue order — the product bar's rows. */
  categories: readonly ProductCategory[];
  colourHex: (colour: string) => string | undefined;
  /**
   * The lines this screen loaded, for the adjustment's "does this change the
   * count" check. Only the adjust form passes it.
   */
  levels?: readonly InventoryStockLevel[];
  /** `inventory.adjustmentNoteRequired`, already coalesced by the screen. */
  noteRequired?: boolean;
  onSubmit: (input: { variantId: string; quantityBoxes: number; note?: string }) => Promise<void>;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [subProducts, setSubProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [variantId, setVariantId] = useState(lock?.variantId ?? '');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const formRef = useRef<HTMLDivElement>(null);
  const subProductRef = useRef<HTMLInputElement>(null);

  // Every sub product of the chosen product, not a first page: one product
  // (One Piece Toilet) alone holds 56, and a bar that stops short hides the
  // tail as if it did not exist.
  useEffect(() => {
    if (!categoryId) return;
    let cancelled = false;
    void api
      .pick<Product>('product', { term: '', categoryId, limit: PICK_MAX_LIMIT })
      .then((page) => {
        if (!cancelled) setSubProducts(page.items);
      })
      .catch(() => {
        if (!cancelled) setSubProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [categoryId]);

  // The sub-product bar is disabled until a product is chosen, so the Enter
  // that took the product could not step into it; the caret follows here.
  useEffect(() => {
    if (categoryId) subProductRef.current?.focus();
  }, [categoryId]);

  const product = subProducts.find((candidate) => candidate.id === productId) ?? null;
  const variants: ProductVariant[] = product
    ? product.variants.filter((variant) => variant.isActive)
    : [];
  const colour = lock
    ? lineColour(lock)
    : product && variants.length === 1
      ? lineColour({
          multiColour: product.multiColour,
          variantLabel: variants[0]?.label ?? null,
          productName: product.name,
        })
      : null;

  const nameOf = (variant: ProductVariant): string =>
    variant.label ? `${variant.label} · ${variant.code}` : variant.code;

  function chooseCategory(id: string): void {
    setCategoryId(id);
    // Never the last product's rows under the new one while its list loads.
    setSubProducts([]);
    setProductId('');
    setVariantId('');
  }

  function chooseProduct(id: string): void {
    setProductId(id);
    const chosen = subProducts.find((candidate) => candidate.id === id);
    const active = chosen?.variants.filter((variant) => variant.isActive) ?? [];
    // One sub product, one variant: nothing to choose, so it is chosen.
    setVariantId(active.length === 1 ? active[0]!.id : '');
  }

  /*
   * Whether this particular submission needs a reason.
   *
   * `levels` is the filtered, clamped page this screen loaded, NOT the stock
   * table — so a line missing from it means "this screen does not know today's
   * count", never zero. Treating absence as zero would compute no delta for a
   * count of 0 and let a write-off through unasked, which is the exact
   * correction the setting exists to police. Over-ask instead: the server
   * discards the note on a no-op anyway, so over-asking is recoverable and
   * under-asking is not.
   */
  const known = levels.find((level) => level.variantId === variantId);
  const noteNeeded =
    noteRequired === true && (known === undefined || Number(quantity) !== known.quantityBoxes);
  const ready = !busy && variantId !== '' && quantity !== '' && !(noteNeeded && note.trim() === '');

  function submit(): void {
    if (!ready) return;
    // Nothing is reset here: a successful write closes the modal, which
    // unmounts this form, and after a rejected one the pieces and note the
    // operator typed are the only copy of what they meant to record.
    void onSubmit({
      variantId,
      quantityBoxes: Number(quantity),
      note: note.trim() || undefined,
    });
  }

  useEnterToAdvance(formRef, submit);

  return (
    <div ref={formRef} style={{ display: 'contents' }}>
      <p className="ob-small" style={{ margin: 0 }}>
        {description}
      </p>

      <FormField label={t('inventory.field.product')}>
        {(id) =>
          lock ? (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              {categoryLabel(lock.categoryCode, lock.categoryName) || '—'}
            </p>
          ) : (
            <Select
              id={id}
              value={categoryId}
              autoFocus
              onChange={(event) => chooseCategory(event.target.value)}
            >
              <option value="">{t('inventory.field.productPlaceholder')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {[categoryLabel(category.code, category.name), category.brand]
                    .filter(Boolean)
                    .join(' · ')}
                </option>
              ))}
            </Select>
          )
        }
      </FormField>

      <FormField label={t('inventory.field.subProduct')}>
        {(id) =>
          lock ? (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              {lock.productName}
              <span className="ob-mono ob-small">{` · ${lock.variantCode}`}</span>
            </p>
          ) : (
            <Select
              ref={subProductRef}
              id={id}
              value={productId}
              disabled={!categoryId}
              onChange={(event) => chooseProduct(event.target.value)}
            >
              <option value="">{t('inventory.field.subProductPlaceholder')}</option>
              {subProducts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {subProductLabel(candidate)}
                </option>
              ))}
            </Select>
          )
        }
      </FormField>

      {!lock && variants.length > 1 && (
        <FormField label={t('inventory.field.variant')}>
          {(id) => (
            <Select
              id={id}
              value={variantId}
              onChange={(event) => setVariantId(event.target.value)}
            >
              <option value="">{t('inventory.field.variantPlaceholder')}</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {nameOf(variant)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}

      {colour && (
        <FormField label={t('inventory.field.colour')}>
          {(id) => (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              <ColourText name={colour} hex={colourHex(colour)} />
            </p>
          )}
        </FormField>
      )}

      <FormField label={t('inventory.field.pieces')}>
        {(id) => (
          <NumberInput
            id={id}
            value={quantity}
            autoFocus={Boolean(lock)}
            onChange={(event) => setQuantity(event.target.value)}
          />
        )}
      </FormField>

      <FormField
        label={t('inventory.field.note')}
        hint={noteNeeded ? t('validation.stock.adjustmentNoteRequired') : undefined}
      >
        {(id) => (
          <Input
            id={id}
            value={note}
            placeholder={t('inventory.field.notePlaceholder')}
            aria-invalid={noteNeeded && note.trim() === '' ? true : undefined}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </FormField>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" busy={busy} disabled={!ready} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
