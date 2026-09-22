/**
 * Inventory, per variant (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * A row is one variant of one product — the thing a code names, the thing a
 * lead line is raised on, the thing a reservation holds. Three quantities are
 * shown side by side because they answer different questions: what is on the
 * floor, what is already reserved for orders that have not been dispatched,
 * and what is therefore free to sell. Only the last one is what a new order
 * can actually draw on, so it is what "low stock" is judged against.
 *
 * The code is read-only here: it belongs to the product master, where the
 * catalogue form edits it alongside the variant's label and weight. What this
 * screen owns is the stock band — reorder, min and max — edited inline,
 * because this is the only screen that lists every variant with its figures.
 *
 * Stock is allowed to go negative — a dealer routinely sells against a factory
 * order that has not arrived. The shortfall is surfaced, never blocked.
 *
 * Clicking a stock row opens a dialog scoped to that one variant: the same
 * three quantities, a ledger of just its movements, and "Stock in" / "Adjust
 * to physical count" pre-locked to the line so the fast path never requires
 * re-picking the product and variant (6-UI-DESIGN.md §8).
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  InventoryStockLevel,
  OptionListItem,
  Product,
  ProductVariant,
  StockMovement,
} from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  Card,
  ColourChip,
  ColourName,
  DataTable,
  EmptyState,
  FilterChip,
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
  useFilterBar,
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
}

const MOVEMENT_TYPE_KEY = {
  inbound: 'inventory.movementType.inbound',
  outbound: 'inventory.movementType.outbound',
  adjustment: 'inventory.movementType.adjustment',
} as const;

/** A line-scoped Stock-in/Adjust locks the form to the drawer's variant. */
interface LineLock {
  variantId: string;
  variantCode: string;
  variantLabel: string | null;
  productName: string;
}

/** The variant's name as the screen speaks of it: the colour, or the code alone. */
function variantName(level: { variantCode: string; variantLabel: string | null }): string {
  return level.variantLabel ? `${level.variantLabel} · ${level.variantCode}` : level.variantCode;
}

export function InventoryScreen({
  revision,
  filter,
  onFilterChange,
  freeToSell,
  adjustmentNoteRequired,
}: Props) {
  const [levels, setLevels] = useState<InventoryStockLevel[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [optionLists, setOptionLists] = useState<OptionListItem[]>([]);
  const colourHex = useColourHex(optionLists);
  const [search, setSearch] = useState('');
  // The input stays wired to the raw value so typing feels instant; only the
  // network-triggering effect waits. Without this the screen fired a full
  // request per keystroke, so fast typing produced a burst of overlapping
  // requests for characters the person had already typed past.
  const debouncedSearch = useDebounced(search);
  const lowOnly = filter === 'low';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stockInOpen, setStockInOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [lineLock, setLineLock] = useState<LineLock | null>(null);

  // Which variant is opened into its detail dialog, and the movements scoped
  // to just that line. The dialog's summary numbers are *not* stored here —
  // they are derived from `levels` below so they stay live as `levels`
  // reloads.
  const [openVariantId, setOpenVariantId] = useState<string | null>(null);
  const [lineMovements, setLineMovements] = useState<StockMovement[]>([]);
  const [lineMovementsLoading, setLineMovementsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stock, recent] = await Promise.all([
        api.stock({ search: debouncedSearch || undefined, lowOnly }),
        api.stockMovements(),
      ]);
      setLevels(stock);
      setMovements(recent);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('inventory.error.load'));
    }
  }, [debouncedSearch, lowOnly]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    void api
      .optionLists()
      .then(setOptionLists)
      .catch(() => setOptionLists([]));
  }, []);

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

  function openLine(level: InventoryStockLevel): void {
    setOpenVariantId(level.variantId);
    void loadLineMovements(level.variantId);
  }

  function lockFor(level: InventoryStockLevel): LineLock {
    return {
      variantId: level.variantId,
      variantCode: level.variantCode,
      variantLabel: level.variantLabel,
      productName: level.productName,
    };
  }

  function openLineStockIn(level: InventoryStockLevel): void {
    setLineLock(lockFor(level));
    setStockInOpen(true);
  }

  function openLineAdjust(level: InventoryStockLevel): void {
    setLineLock(lockFor(level));
    setAdjustOpen(true);
  }

  useFilterBar(
    <>
      <div className="ob-search" style={{ width: rem(400) }}>
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
    </>,
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
  ) => (
    <NumberInput
      key={`${level.variantId}-${field}-${level[field] ?? ''}`}
      defaultValue={level[field] ?? ''}
      aria-label={t(labelKey, { product: level.productName, variant: variantName(level) })}
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
      key: 'product',
      header: t('inventory.table.product'),
      render: (level) => (
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="ob-ellipsis">{level.productName}</span>
          {level.categoryName && (
            <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
              {level.categoryName}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'variant',
      header: t('inventory.table.variant'),
      width: rem(150),
      render: (level) =>
        level.variantLabel ? (
          <ColourName name={level.variantLabel} hex={colourHex(level.variantLabel)} />
        ) : (
          <span style={{ color: 'var(--fg-tertiary)' }}>—</span>
        ),
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
          {movement.variantLabel && (
            <ColourName name={movement.variantLabel} hex={colourHex(movement.variantLabel)} />
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

  const openLevel = openVariantId
    ? (levels.find((level) => level.variantId === openVariantId) ?? null)
    : null;

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
            <span className="ob-pill">
              {t(freeToSell ? 'inventory.piecesFree' : 'inventory.piecesOnHand', { count: totalFree })}
            </span>
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

      <Modal
        open={Boolean(openLevel)}
        onClose={() => setOpenVariantId(null)}
        size="lg"
        title={
          openLevel && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              {openLevel.variantLabel && (
                <ColourChip hex={colourHex(openLevel.variantLabel)} name={openLevel.variantLabel} />
              )}
              {t('inventory.drawer.title', {
                product: openLevel.productName,
                variant: variantName(openLevel),
              })}
            </span>
          )
        }
        label={
          openLevel
            ? t('inventory.drawer.title', {
                product: openLevel.productName,
                variant: variantName(openLevel),
              })
            : ''
        }
        subtitle={
          openLevel && (
            <span className="ob-mono">
              {openLevel.variantCode}
              {openLevel.weightKg !== null ? ` · ${formatKg(openLevel.weightKg)}` : ''}
            </span>
          )
        }
        footer={
          openLevel && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  // One dialog at a time: the movement form replaces this one
                  // rather than stacking on it (HIG, Modality).
                  setOpenVariantId(null);
                  openLineAdjust(openLevel);
                }}
              >
                {t('inventory.drawer.adjust')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpenVariantId(null);
                  openLineStockIn(openLevel);
                }}
              >
                {t('inventory.action.stockIn')}
              </Button>
              <Button variant="primary" onClick={() => setOpenVariantId(null)}>
                {t('action.done')}
              </Button>
            </>
          )
        }
      >
        {openLevel && renderLineDetail(openLevel)}
      </Modal>

      <Modal
        open={stockInOpen}
        onClose={() => {
          setStockInOpen(false);
          setLineLock(null);
        }}
        title={
          lineLock
            ? t('inventory.stockIn.titleForLine', {
                product: lineLock.productName,
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
                product: lineLock.productName,
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
          onSubmit={async (input) => {
            const saved = await run(() => api.stockAdjust(input), t('inventory.error.adjust'));
            if (!saved) return;
            if (lineLock) await loadLineMovements(lineLock.variantId);
            setAdjustOpen(false);
            setLineLock(null);
          }}
        />
      </Modal>
    </div>
  );
}

/**
 * Shared by stock-in and physical count: they differ only in what the number
 * means and which endpoint receives it, so one form with two labels beats two
 * near-identical ones.
 *
 * The product is found by typing — a name or any of its codes, through the
 * same picker the lead screen uses, so a catalogue of any size is reachable
 * (a select over "the first page of products" stopped at a hundred). Then one
 * of its variants — a one-form product has exactly one, chosen for you. When
 * opened from a line's dialog, `lock` pins both to that line: the pickers are
 * replaced by static text so the only thing left to enter is the number (and
 * an optional note).
 */
function MovementForm({
  description,
  submitLabel,
  busy,
  lock,
  levels = [],
  noteRequired,
  onSubmit,
}: {
  description: string;
  submitLabel: string;
  busy: boolean;
  lock?: LineLock | null;
  /**
   * The lines this screen loaded, for the adjustment's "does this change the
   * count" check. Only the adjust form passes it.
   */
  levels?: readonly InventoryStockLevel[];
  /** `inventory.adjustmentNoteRequired`, already coalesced by the screen. */
  noteRequired?: boolean;
  onSubmit: (input: { variantId: string; quantityBoxes: number; note?: string }) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [variantId, setVariantId] = useState(lock?.variantId ?? '');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');

  const term = useDebounced(query, 200);
  useEffect(() => {
    if (lock) return;
    let cancelled = false;
    void api
      .pick<Product>('product', { term, include: productId ? [productId] : [] })
      .then((page) => {
        if (!cancelled) setMatches(page.items);
      })
      .catch(() => {
        if (!cancelled) setMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [term, lock, productId]);

  const product = matches.find((candidate) => candidate.id === productId) ?? null;
  const variants: ProductVariant[] = product
    ? product.variants.filter((variant) => variant.isActive)
    : [];

  const nameOf = (variant: ProductVariant): string =>
    variant.label ? `${variant.label} · ${variant.code}` : variant.code;

  function chooseProduct(id: string): void {
    setProductId(id);
    const chosen = matches.find((candidate) => candidate.id === id);
    const active = chosen?.variants.filter((variant) => variant.isActive) ?? [];
    // One form, one variant: nothing to choose, so it is chosen.
    setVariantId(active.length === 1 ? active[0]!.id : '');
  }

  /*
   * Whether this particular submission needs a reason.
   *
   * `levels` is the search/lowOnly-filtered, clamped page this screen loaded,
   * NOT the stock table — so a line missing from it means "this screen does not
   * know today's count", never zero. Treating absence as zero would compute no
   * delta for a count of 0 and let a write-off through unasked, which is the
   * exact correction the setting exists to police. Over-ask instead: the server
   * discards the note on a no-op anyway, so over-asking is recoverable and
   * under-asking is not.
   */
  const known = levels.find((level) => level.variantId === variantId);
  const noteNeeded =
    noteRequired === true && (known === undefined || Number(quantity) !== known.quantityBoxes);

  return (
    <>
      <p className="ob-small" style={{ margin: 0 }}>
        {description}
      </p>

      <FormField label={t('inventory.field.product')}>
        {(id) =>
          lock ? (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              {lock.productName}
            </p>
          ) : (
            <>
              <Input
                id={id}
                value={query}
                placeholder={t('inventory.field.productSearchPlaceholder')}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
              <Select
                value={productId}
                aria-label={t('inventory.field.product')}
                style={{ marginTop: rem(6) }}
                onChange={(event) => chooseProduct(event.target.value)}
              >
                <option value="">{t('inventory.field.productPlaceholder')}</option>
                {matches.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.categoryName ? ` — ${candidate.categoryName}` : ''}
                  </option>
                ))}
              </Select>
            </>
          )
        }
      </FormField>

      <FormField label={t('inventory.field.variant')}>
        {(id) =>
          lock ? (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              {variantName(lock)}
            </p>
          ) : (
            <Select
              id={id}
              value={variantId}
              disabled={!product}
              onChange={(event) => setVariantId(event.target.value)}
            >
              <option value="">{t('inventory.field.variantPlaceholder')}</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {nameOf(variant)}
                </option>
              ))}
            </Select>
          )
        }
      </FormField>

      <FormField label={t('inventory.field.pieces')}>
        {(id) => (
          <NumberInput
            id={id}
            value={quantity}
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
        <Button
          variant="primary"
          busy={busy}
          disabled={
            busy || !variantId || quantity === '' || (noteNeeded && note.trim() === '')
          }
          onClick={() =>
            // Nothing is reset here: a successful write closes the modal, which
            // unmounts this form, and after a rejected one the pieces and note
            // the operator typed are the only copy of what they meant to record.
            void onSubmit({
              variantId,
              quantityBoxes: Number(quantity),
              note: note.trim() || undefined,
            })
          }
        >
          {submitLabel}
        </Button>
      </div>
    </>
  );
}
