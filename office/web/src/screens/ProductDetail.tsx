/**
 * ProductDetail — the view-only body of the 520px drawer Catalog/Products
 * opens on a row click (`Products.dc.html`'s detail drawer, the piece the
 * QA review found missing entirely — clicking a row previously jumped
 * straight into the edit form with no way to just look).
 *
 * Every figure here comes from the already-flowing snapshot: the info card
 * reads straight off `Product`, and the stock table is `view.stock` filtered
 * to this product's id — the same source `StockByColour` reads for the list
 * row, just spelled out as real on-hand/reserved/free columns instead of a
 * compact chip row (`StockCell.tsx`'s doc comment explains that split).
 *
 * "Stock in" and "Adjust count" post straight through the already-wired
 * `api.stockInbound`/`api.stockAdjust` (there was no UI for either before
 * this). Both are queued writes like everything else in this app, so this
 * component does not try to patch `view.stock` locally — the number updates
 * on its own once the event stream catches up, same reasoning the module
 * doc for `CatalogScreen.tsx` gives for skipping a local echo on create.
 *
 * Editing is not done inline — it reuses `ProductDrawer`'s existing edit
 * mode via `onEdit`, which is a real, already-queued write path with its own
 * image section; duplicating that here would just be a second form for the
 * same record.
 */

import { useState } from 'react';
import type { InventoryStockLevel, Product } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import {
  Button,
  Card,
  ColourName,
  DataTable,
  FormField,
  Input,
  KeyValueList,
  NumberInput,
  Select,
  StatusPill,
  formatMoney,
  t,
  useColourHex,
  type DataTableColumn,
} from '@orderbook/ui';

const RATE_PERMISSION = 'field.saleRate.view';

type StockMode = 'none' | 'inbound' | 'adjust';

export function ProductDetail({
  product,
  view,
  onEdit,
  onMessage,
  onError,
}: {
  product: Product;
  view: LocalView;
  onEdit: () => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}) {
  const colourHex = useColourHex(view.optionLists);
  const [mode, setMode] = useState<StockMode>('none');

  const levels = view.stock.filter((level) => level.productId === product.id);
  const colours = Array.from(
    new Set(
      view.optionLists
        .filter((option) => option.listKey === 'stock.colour' && option.isActive)
        .map((option) => option.label),
    ),
  ).sort();

  const columns: DataTableColumn<InventoryStockLevel>[] = [
    {
      key: 'colour',
      header: t('product.detail.stock.colour'),
      render: (level) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
          <ColourName name={level.colour} hex={colourHex(level.colour)} />
          {level.isLow && <StatusPill tone="offline">{t('catalog.stock.low')}</StatusPill>}
        </span>
      ),
    },
    {
      key: 'onHand',
      header: t('product.detail.stock.onHand'),
      width: '84px',
      align: 'right',
      render: (level) => level.quantityBoxes,
    },
    {
      key: 'reserved',
      header: t('product.detail.stock.reserved'),
      width: '84px',
      align: 'right',
      render: (level) => level.reservedBoxes,
    },
    {
      key: 'free',
      header: t('product.detail.stock.free'),
      width: '84px',
      align: 'right',
      render: (level) => (
        <span
          className="ob-body-strong"
          style={{
            color:
              level.availableBoxes < 0
                ? 'var(--state-conflict)'
                : level.availableBoxes === 0
                  ? 'var(--fg-tertiary)'
                  : 'var(--fg-primary)',
          }}
        >
          {level.availableBoxes}
        </span>
      ),
    },
  ];

  return (
    <>
      <Card>
        <KeyValueList
          items={[
            {
              label: t('product.detail.type'),
              value: product.productType ?? product.categoryName ?? '—',
            },
            { label: t('product.detail.size'), value: product.size ?? '—' },
            { label: t('product.detail.grade'), value: product.grade ?? '—' },
            {
              label: t('product.detail.weight'),
              value: product.weightKg != null ? `${product.weightKg} kg` : '—',
            },
            {
              label: t('product.detail.rate'),
              value:
                product.rate === undefined ? (
                  <span
                    className="ob-redacted"
                    title={`Missing permission: ${RATE_PERMISSION}`}
                    aria-label="Hidden"
                  />
                ) : (
                  formatMoney(product.rate)
                ),
            },
          ]}
        />
      </Card>

      <div>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          {t('product.detail.stockTitle')}
        </div>
        <DataTable
          columns={columns}
          rows={levels}
          rowKey={(level) => level.colour}
          empty={
            <p
              className="ob-small"
              style={{ margin: 0, padding: 'var(--s-16)', color: 'var(--fg-tertiary)' }}
            >
              {t('product.detail.stock.none')}
            </p>
          }
        />
        <p className="ob-small" style={{ marginTop: 'var(--s-8)', color: 'var(--fg-tertiary)' }}>
          {t('product.detail.stock.note')}
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-8)' }}>
        <Button variant="primary" size="sm" icon="edit" onClick={onEdit}>
          {t('product.detail.editAction')}
        </Button>
        <Button
          size="sm"
          onClick={() => setMode((current) => (current === 'inbound' ? 'none' : 'inbound'))}
        >
          {t('product.detail.stockInAction')}
        </Button>
        <Button
          size="sm"
          onClick={() => setMode((current) => (current === 'adjust' ? 'none' : 'adjust'))}
        >
          {t('product.detail.adjustAction')}
        </Button>
      </div>

      {mode !== 'none' && (
        <StockMovementForm
          key={mode}
          productId={product.id}
          mode={mode}
          colours={colours}
          levels={new Map(levels.map((level) => [level.colour, level.quantityBoxes]))}
          onDone={(message) => {
            setMode('none');
            onMessage(message);
          }}
          onCancel={() => setMode('none')}
          onError={onError}
        />
      )}
    </>
  );
}

function StockMovementForm({
  productId,
  mode,
  colours,
  levels,
  onDone,
  onCancel,
  onError,
}: {
  productId: string;
  mode: Exclude<StockMode, 'none'>;
  colours: string[];
  /** On-hand boxes per colour, so switching the colour in "Adjust count" can default to today's count. */
  levels: Map<string, number>;
  onDone: (message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [colour, setColour] = useState(colours[0] ?? '');
  const [quantity, setQuantity] = useState(
    mode === 'adjust' ? String(levels.get(colours[0] ?? '') ?? 0) : '',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  function selectColour(name: string): void {
    setColour(name);
    // Adjust count corrects a physical count, so re-anchor to today's figure
    // for the newly chosen colour rather than leaving the previous one's.
    if (mode === 'adjust') setQuantity(String(levels.get(name) ?? 0));
  }

  async function save(): Promise<void> {
    const trimmedColour = colour.trim();
    if (!trimmedColour) {
      onError(t('product.detail.stockForm.colourRequired'));
      return;
    }
    const parsed = Number(quantity);
    // `stockInbound` requires boxes-arrived > 0; `stockAdjust` takes the new
    // counted total (never negative) and the server derives the delta
    // itself — see inventory.service.ts's recordAdjustment.
    const valid =
      quantity.trim() !== '' &&
      Number.isFinite(parsed) &&
      (mode === 'inbound' ? parsed > 0 : parsed >= 0);
    if (!valid) {
      onError(t('product.detail.stockForm.quantityInvalid'));
      return;
    }

    setBusy(true);
    try {
      const input = {
        productId,
        colour: trimmedColour,
        quantityBoxes: parsed,
        note: note.trim() || undefined,
      };
      if (mode === 'inbound') await api.stockInbound(input);
      else await api.stockAdjust(input);
      onDone(
        mode === 'inbound'
          ? t('product.detail.stockForm.inboundDone', { colour: trimmedColour, count: parsed })
          : t('product.detail.stockForm.adjustDone', { colour: trimmedColour }),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('product.detail.stockForm.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
        {mode === 'inbound' ? t('product.detail.stockInAction') : t('product.detail.adjustAction')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 'var(--s-12)' }}>
        <FormField label={t('product.detail.stockForm.colour')}>
          {(id) => (
            <Select id={id} value={colour} onChange={(event) => selectColour(event.target.value)}>
              {colours.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label={
            mode === 'inbound'
              ? t('product.detail.stockForm.quantity')
              : t('product.detail.stockForm.counted')
          }
        >
          {(id) => (
            <NumberInput
              id={id}
              value={quantity}
              autoFocus
              onChange={(event) => setQuantity(event.target.value.replace(/[^0-9]/g, ''))}
            />
          )}
        </FormField>
      </div>
      <FormField
        label={t('product.detail.stockForm.note')}
        hint={t('product.detail.stockForm.noteHint')}
      >
        {(id) => <Input id={id} value={note} onChange={(event) => setNote(event.target.value)} />}
      </FormField>
      <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-8)' }}>
        <Button variant="primary" size="sm" busy={busy} onClick={() => void save()}>
          {busy ? t('product.detail.stockForm.saving') : t('product.detail.stockForm.save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>
    </Card>
  );
}
