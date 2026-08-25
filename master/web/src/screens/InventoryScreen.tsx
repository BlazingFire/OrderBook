/**
 * Inventory, per (product, colour) (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * Three quantities are shown side by side because they answer different
 * questions: what is on the floor, what is already reserved for orders that
 * have not been dispatched, and what is therefore free to sell. Only the last
 * one is what a new order can actually draw on, so it is what "low stock" is
 * judged against.
 *
 * Stock is allowed to go negative — a dealer routinely sells against a factory
 * order that has not arrived. The shortfall is surfaced, never blocked.
 *
 * Clicking a stock row opens a drawer scoped to that one (product, colour)
 * line: the same three quantities, a ledger of just its movements, and
 * "Stock in" / "Adjust to physical count" pre-locked to the line so the fast
 * path never requires re-picking the product and colour (6-UI-DESIGN.md §8).
 */

import { useCallback, useEffect, useId, useState } from 'react';
import type { InventoryStockLevel, OptionListItem, Product, StockMovement } from '@orderbook/shared';

import { api } from '../api';
import { formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Card, Section } from '../ui/Card';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { ColourChip, ColourName, StatusPill, useColourHex } from '../ui/DataDisplay';
import { FilterChip } from '../ui/FilterBar';
import { useFilterBar } from '../ui/FilterBarSlot';
import { FormField, Input, NumberInput, Select } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { EmptyState, SkeletonRows } from '../ui/States';

interface Props {
  revision: number;
}

const MOVEMENT_TYPE_KEY = {
  inbound: 'inventory.movementType.inbound',
  outbound: 'inventory.movementType.outbound',
  adjustment: 'inventory.movementType.adjustment',
} as const;

/** A line-scoped Stock-in/Adjust locks the form to the drawer's (product, colour). */
interface LineLock {
  productId: string;
  colour: string;
  productCode: string;
  productName: string;
}

export function InventoryScreen({ revision }: Props) {
  const [levels, setLevels] = useState<InventoryStockLevel[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [optionLists, setOptionLists] = useState<OptionListItem[]>([]);
  const colourHex = useColourHex(optionLists);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stockInOpen, setStockInOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [lineLock, setLineLock] = useState<LineLock | null>(null);

  // Which (product, colour) line is opened into its detail band, and the
  // movements scoped to just that line. The band's summary numbers are *not*
  // stored here — they are derived from `levels` below so they stay live as
  // `levels` reloads.
  const [openLineKey, setOpenLineKey] = useState<string | null>(null);
  const [lineMovements, setLineMovements] = useState<StockMovement[]>([]);
  const [lineMovementsLoading, setLineMovementsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stock, recent] = await Promise.all([
        api.stock({ search: search || undefined, lowOnly }),
        api.stockMovements(),
      ]);
      setLevels(stock);
      setMovements(recent);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('inventory.error.load'));
    }
  }, [search, lowOnly]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    void api
      .products()
      .then((page) => setProducts(page.items))
      .catch(() => setProducts([]));
  }, []);

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

  // The movements endpoint filters by product server-side but not by colour
  // (colour is free text within a product), so the line's ledger is fetched
  // by product and narrowed to the one colour here.
  const loadLineMovements = useCallback(async (productId: string, colour: string) => {
    setLineMovementsLoading(true);
    setLineMovements([]);
    try {
      const productMovements = await api.stockMovements(productId);
      setLineMovements(productMovements.filter((movement) => movement.colour === colour));
    } catch {
      setLineMovements([]);
    } finally {
      setLineMovementsLoading(false);
    }
  }, []);

  function openLine(level: InventoryStockLevel): void {
    setOpenLineKey(`${level.productId}-${level.colour}`);
    void loadLineMovements(level.productId, level.colour);
  }

  function openLineStockIn(level: InventoryStockLevel): void {
    setLineLock({
      productId: level.productId,
      colour: level.colour,
      productCode: level.productCode,
      productName: level.productName,
    });
    setStockInOpen(true);
  }

  function openLineAdjust(level: InventoryStockLevel): void {
    setLineLock({
      productId: level.productId,
      colour: level.colour,
      productCode: level.productCode,
      productName: level.productName,
    });
    setAdjustOpen(true);
  }

  useFilterBar(
    <>
      <div className="ob-search">
        <Input
          value={search}
          placeholder={t('inventory.search.placeholder')}
          aria-label={t('inventory.search.placeholder')}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <FilterChip active={!lowOnly} onClick={() => setLowOnly(false)}>
        {t('inventory.filter.all')}
      </FilterChip>
      <FilterChip active={lowOnly} onClick={() => setLowOnly(true)}>
        {t('inventory.filter.lowOnly')}
      </FilterChip>
      <span style={{ flex: 1 }} />
      <span
        className="ob-small"
        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}
      >
        {t('inventory.filterNote')}
      </span>
    </>,
  );

  const totalFree = levels.reduce((sum, level) => sum + level.availableBoxes, 0);

  const levelColumns: DataTableColumn<InventoryStockLevel>[] = [
    {
      key: 'code',
      header: t('inventory.table.code'),
      width: '110px',
      render: (level) => <span className="ob-mono">{level.productCode}</span>,
    },
    {
      key: 'product',
      header: t('inventory.table.product'),
      render: (level) => level.productName,
    },
    {
      key: 'colour',
      header: t('inventory.table.colour'),
      width: '150px',
      render: (level) => <ColourName name={level.colour} hex={colourHex(level.colour)} />,
    },
    {
      key: 'onHand',
      header: t('inventory.table.onHand'),
      width: '90px',
      align: 'right',
      render: (level) => level.quantityBoxes,
    },
    {
      key: 'reserved',
      header: t('inventory.table.reserved'),
      width: '90px',
      align: 'right',
      render: (level) => String(level.reservedBoxes),
    },
    {
      key: 'free',
      header: t('inventory.table.free'),
      width: '90px',
      align: 'right',
      render: (level) => (
        <span
          className="ob-body-strong"
          style={{ color: level.availableBoxes < 0 ? 'var(--state-conflict)' : undefined }}
        >
          {level.availableBoxes}
        </span>
      ),
    },
    {
      key: 'reorder',
      header: t('inventory.table.reorder'),
      width: '110px',
      align: 'right',
      render: (level) => (
        <NumberInput
          defaultValue={level.reorderLevel ?? ''}
          aria-label={t('inventory.reorderLevelLabel', {
            product: level.productName,
            colour: level.colour,
          })}
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) =>
            void run(
              () =>
                api.setReorderLevel({
                  productId: level.productId,
                  colour: level.colour,
                  reorderLevel: event.target.value === '' ? null : Number(event.target.value),
                }),
              t('inventory.error.reorder'),
            )
          }
        />
      ),
    },
    {
      key: 'status',
      header: t('inventory.table.status'),
      width: '100px',
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
      width: '150px',
      render: (movement) => formatDateTime(movement.createdAt),
    },
    {
      key: 'product',
      header: t('inventory.movements.table.product'),
      render: (movement) => movement.productName,
    },
    {
      key: 'colour',
      header: t('inventory.movements.table.colour'),
      width: '130px',
      render: (movement) => <ColourName name={movement.colour} hex={colourHex(movement.colour)} />,
    },
    {
      key: 'type',
      header: t('inventory.movements.table.type'),
      width: '110px',
      render: (movement) => t(MOVEMENT_TYPE_KEY[movement.movementType]),
    },
    {
      key: 'change',
      header: t('inventory.movements.table.change'),
      width: '90px',
      align: 'right',
      render: (movement) => (
        <span style={{ color: movement.quantityBoxes < 0 ? 'var(--state-conflict)' : 'var(--state-ok)' }}>
          {movement.quantityBoxes > 0 ? '+' : ''}
          {movement.quantityBoxes}
        </span>
      ),
    },
    {
      key: 'reference',
      header: t('inventory.movements.table.reference'),
      width: '170px',
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

  // Same shape as `movementColumns` minus product/colour — the drawer's
  // ledger is already scoped to one (product, colour) line.
  const lineMovementColumns: DataTableColumn<StockMovement>[] = [
    {
      key: 'when',
      header: t('inventory.movements.table.when'),
      width: '112px',
      render: (movement) => formatDateTime(movement.createdAt),
    },
    {
      key: 'type',
      header: t('inventory.movements.table.type'),
      width: '86px',
      render: (movement) => t(MOVEMENT_TYPE_KEY[movement.movementType]),
    },
    {
      key: 'change',
      header: t('inventory.movements.table.change'),
      width: '72px',
      align: 'right',
      render: (movement) => (
        <span style={{ color: movement.quantityBoxes < 0 ? 'var(--state-conflict)' : 'var(--state-ok)' }}>
          {movement.quantityBoxes > 0 ? '+' : ''}
          {movement.quantityBoxes}
        </span>
      ),
    },
    {
      key: 'reference',
      header: t('inventory.movements.table.reference'),
      width: '112px',
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

  const openLevel = openLineKey
    ? (levels.find((level) => `${level.productId}-${level.colour}` === openLineKey) ?? null)
    : null;

  /**
   * One stock line, in full: the three figures that matter and that line's own
   * ledger. The two writes that act on it live in the dialog's footer.
   */
  function renderLineDetail(level: InventoryStockLevel) {
    return (
      <div className="ob-detail">
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--s-8)' }}>
          <Card>
            <div className="ob-eyebrow">{t('inventory.table.onHand')}</div>
            <div className="ob-display" style={{ marginTop: 'var(--s-6)', fontVariantNumeric: 'tabular-nums' }}>
              {level.quantityBoxes}
            </div>
          </Card>
          <Card>
            <div className="ob-eyebrow">{t('inventory.table.reserved')}</div>
            <div className="ob-display" style={{ marginTop: 'var(--s-6)', fontVariantNumeric: 'tabular-nums' }}>
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
        </section>

        <section className="ob-detail-section">
          <div className="ob-eyebrow">{t('inventory.drawer.ledgerTitle')}</div>
          {lineMovementsLoading ? (
            <SkeletonRows rows={4} columns={4} />
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
            <span className="ob-pill">{t('inventory.boxesFree', { count: totalFree })}</span>
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
          rowKey={(level) => `${level.productId}-${level.colour}`}
          onRowOpen={openLine}
          openOn="click"
          selectedId={openLineKey ?? undefined}
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
        onClose={() => setOpenLineKey(null)}
        size="lg"
        title={
          openLevel && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              <ColourChip hex={colourHex(openLevel.colour)} name={openLevel.colour} />
              {t('inventory.drawer.title', { product: openLevel.productName, colour: openLevel.colour })}
            </span>
          )
        }
        label={
          openLevel
            ? t('inventory.drawer.title', { product: openLevel.productName, colour: openLevel.colour })
            : ''
        }
        subtitle={openLevel && <span className="ob-mono">{openLevel.productCode}</span>}
        footer={
          openLevel && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  // One dialog at a time: the movement form replaces this one
                  // rather than stacking on it (HIG, Modality).
                  setOpenLineKey(null);
                  openLineAdjust(openLevel);
                }}
              >
                {t('inventory.drawer.adjust')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpenLineKey(null);
                  openLineStockIn(openLevel);
                }}
              >
                {t('inventory.action.stockIn')}
              </Button>
              <Button variant="primary" onClick={() => setOpenLineKey(null)}>
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
            ? t('inventory.stockIn.titleForLine', { product: lineLock.productName, colour: lineLock.colour })
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
          products={products}
          levels={levels}
          submitLabel={t('inventory.stockIn.submit')}
          busy={busy}
          lock={lineLock}
          onSubmit={async (input) => {
            const saved = await run(() => api.stockInbound(input), t('inventory.error.inbound'));
            if (!saved) return;
            if (lineLock) await loadLineMovements(lineLock.productId, lineLock.colour);
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
            ? t('inventory.physicalCount.titleForLine', { product: lineLock.productName, colour: lineLock.colour })
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
          products={products}
          levels={levels}
          submitLabel={t('inventory.physicalCount.submit')}
          busy={busy}
          lock={lineLock}
          onSubmit={async (input) => {
            const saved = await run(() => api.stockAdjust(input), t('inventory.error.adjust'));
            if (!saved) return;
            if (lineLock) await loadLineMovements(lineLock.productId, lineLock.colour);
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
 * When opened from a line's drawer, `lock` pins the product and colour to
 * that line — the picker and datalist are replaced by static text so the
 * only thing left to enter is the number (and an optional note).
 */
function MovementForm({
  description,
  products,
  levels,
  submitLabel,
  busy,
  lock,
  onSubmit,
}: {
  description: string;
  products: Product[];
  levels: InventoryStockLevel[];
  submitLabel: string;
  busy: boolean;
  lock?: LineLock | null;
  onSubmit: (input: {
    productId: string;
    colour: string;
    quantityBoxes: number;
    note?: string;
  }) => Promise<void>;
}) {
  const [productId, setProductId] = useState(lock?.productId ?? '');
  const [colour, setColour] = useState(lock?.colour ?? '');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const listId = useId();

  const knownColours = levels
    .filter((level) => level.productId === productId)
    .map((level) => level.colour);

  return (
    <>
      <p className="ob-small" style={{ margin: 0 }}>
        {description}
      </p>

      <FormField label={t('inventory.field.product')}>
        {(id) =>
          lock ? (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              {lock.productCode} — {lock.productName}
            </p>
          ) : (
            <Select id={id} value={productId} onChange={(event) => setProductId(event.target.value)}>
              <option value="">{t('inventory.field.productPlaceholder')}</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.productCode} — {product.name}
                </option>
              ))}
            </Select>
          )
        }
      </FormField>

      <FormField label={t('inventory.field.colour')}>
        {(id) =>
          lock ? (
            <p id={id} className="ob-body-strong" style={{ margin: 0 }}>
              {lock.colour}
            </p>
          ) : (
            <>
              <Input
                id={id}
                list={listId}
                value={colour}
                placeholder={t('inventory.field.colourPlaceholder')}
                onChange={(event) => setColour(event.target.value)}
              />
              <datalist id={listId}>
                {knownColours.map((known) => (
                  <option key={known} value={known} />
                ))}
              </datalist>
            </>
          )
        }
      </FormField>

      <FormField label={t('inventory.field.boxes')}>
        {(id) => (
          <NumberInput id={id} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        )}
      </FormField>

      <FormField label={t('inventory.field.note')}>
        {(id) => (
          <Input
            id={id}
            value={note}
            placeholder={t('inventory.field.notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </FormField>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          busy={busy}
          disabled={busy || !productId || !colour.trim() || quantity === ''}
          onClick={() =>
            // Nothing is reset here: a successful write closes the modal, which
            // unmounts this form, and after a rejected one the boxes and note
            // the operator typed are the only copy of what they meant to record.
            void onSubmit({
              productId,
              colour: colour.trim(),
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
