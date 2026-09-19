/**
 * ProductDetail — the view-only body Catalog/Products opens on a row click
 * (`Products.dc.html`'s detail, the piece the QA review found missing
 * entirely — clicking a row previously jumped straight into the edit form
 * with no way to just look).
 *
 * Every figure here comes from the already-flowing snapshot: the info card
 * reads straight off `Product`, and the variants table joins the product's
 * own `variants[]` to `view.stock` by variant id — the same source
 * `StockByVariant` reads for the list row, just spelled out as code, weight
 * and real on-hand/reserved/free columns instead of a compact chip row
 * (`StockCell.tsx`'s doc comment explains that split). A variant with no
 * stock row yet is still listed, with dashes: it exists, it has a code, nobody
 * has received any.
 *
 * "Stock in" and "Adjust count" post straight through the already-wired
 * `api.stockInbound`/`api.stockAdjust`, per variant. Both are queued writes
 * like everything else in this app, so this component does not try to patch
 * `view.stock` locally — the number updates on its own once the event stream
 * catches up, same reasoning the module doc for `CatalogScreen.tsx` gives for
 * skipping a local echo on create.
 *
 * Editing is not done inline — it reuses `ProductDrawer`'s existing edit
 * mode via `onEdit`, which is a real, already-queued write path with its own
 * image section; duplicating that here would just be a second form for the
 * same record.
 */

import { useState } from 'react';
import type { Product, ProductVariant } from '@orderbook/shared';

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
  formatKg,
  formatMoney,
  rem,
  t,
  useColourHex,
  type DataTableColumn,
} from '@orderbook/ui';

const RATE_PERMISSION = 'field.saleRate.view';

type StockMode = 'none' | 'inbound' | 'adjust';

/** A variant row with whatever the snapshot knows about its stock. */
interface VariantRow {
  variant: ProductVariant;
  onHand: number | null;
  reserved: number | null;
  free: number | null;
  isLow: boolean;
}

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

  const levels = new Map(
    view.stock.filter((level) => level.productId === product.id).map((level) => [level.variantId, level]),
  );
  const rows: VariantRow[] = product.variants
    .filter((variant) => variant.isActive)
    .map((variant) => {
      const level = levels.get(variant.id);
      return {
        variant,
        onHand: level?.quantityBoxes ?? null,
        reserved: level?.reservedBoxes ?? null,
        free: level?.availableBoxes ?? null,
        isLow: level?.isLow ?? false,
      };
    });

  const columns: DataTableColumn<VariantRow>[] = [
    {
      key: 'variant',
      header: t('product.detail.stock.variant'),
      render: ({ variant, isLow }) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
          {variant.label ? (
            <ColourName name={variant.label} hex={colourHex(variant.label)} />
          ) : (
            <span style={{ color: 'var(--fg-tertiary)' }}>{t('product.detail.stock.oneForm')}</span>
          )}
          {isLow && <StatusPill tone="offline">{t('catalog.stock.low')}</StatusPill>}
        </span>
      ),
    },
    {
      key: 'code',
      header: t('product.detail.stock.code'),
      width: rem(110),
      render: ({ variant }) => <span className="ob-mono">{variant.code}</span>,
    },
    {
      key: 'weight',
      header: t('product.detail.stock.weight'),
      width: rem(132),
      align: 'right',
      render: ({ variant }) =>
        variant.weightKg === null ? (
          <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
        ) : (
          formatKg(variant.weightKg)
        ),
    },
    {
      key: 'onHand',
      header: t('product.detail.stock.onHand'),
      width: rem(84),
      align: 'right',
      render: ({ onHand }) => onHand ?? '—',
    },
    {
      key: 'reserved',
      header: t('product.detail.stock.reserved'),
      width: rem(84),
      align: 'right',
      render: ({ reserved }) => reserved ?? '—',
    },
    {
      key: 'free',
      header: t('product.detail.stock.free'),
      width: rem(84),
      align: 'right',
      render: ({ free }) =>
        free === null ? (
          '—'
        ) : (
          <span
            className="ob-body-strong"
            style={{
              color:
                free < 0 ? 'var(--state-conflict)' : free === 0 ? 'var(--fg-tertiary)' : 'var(--fg-primary)',
            }}
          >
            {free}
          </span>
        ),
    },
  ];

  return (
    <>
      <Card>
        <KeyValueList
          items={[
            { label: t('product.detail.category'), value: product.categoryName },
            { label: t('product.detail.type'), value: product.productType ?? '—' },
            { label: t('product.detail.size'), value: product.size ?? '—' },
            { label: t('product.detail.grade'), value: product.grade ?? '—' },
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
          {t('product.detail.variantsTitle')}
        </div>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.variant.id}
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
          mode={mode}
          variants={rows.map((row) => row.variant)}
          onHand={new Map(rows.map((row) => [row.variant.id, row.onHand ?? 0]))}
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
  mode,
  variants,
  onHand,
  onDone,
  onCancel,
  onError,
}: {
  mode: Exclude<StockMode, 'none'>;
  variants: ProductVariant[];
  /** On-hand pieces per variant, so switching the variant in "Adjust count" can default to today's count. */
  onHand: Map<string, number>;
  onDone: (message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [variantId, setVariantId] = useState(variants[0]?.id ?? '');
  const [quantity, setQuantity] = useState(
    mode === 'adjust' ? String(onHand.get(variants[0]?.id ?? '') ?? 0) : '',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOf = (variant: ProductVariant): string =>
    variant.label ? `${variant.label} · ${variant.code}` : variant.code;

  function selectVariant(id: string): void {
    setVariantId(id);
    // Adjust count corrects a physical count, so re-anchor to today's figure
    // for the newly chosen variant rather than leaving the previous one's.
    if (mode === 'adjust') setQuantity(String(onHand.get(id) ?? 0));
  }

  async function save(): Promise<void> {
    const variant = variants.find((candidate) => candidate.id === variantId);
    if (!variant) {
      onError(t('product.detail.stockForm.variantRequired'));
      return;
    }
    const parsed = Number(quantity);
    // `stockInbound` requires pieces-arrived > 0; `stockAdjust` takes the new
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
      const input = { variantId: variant.id, quantityBoxes: parsed, note: note.trim() || undefined };
      if (mode === 'inbound') await api.stockInbound(input);
      else await api.stockAdjust(input);
      onDone(
        mode === 'inbound'
          ? t('product.detail.stockForm.inboundDone', { variant: nameOf(variant), count: parsed })
          : t('product.detail.stockForm.adjustDone', { variant: nameOf(variant) }),
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
      <div style={{ display: 'grid', gridTemplateColumns: `1fr ${rem(130)}`, gap: 'var(--s-12)' }}>
        <FormField label={t('product.detail.stockForm.variant')}>
          {(id) => (
            <Select id={id} value={variantId} onChange={(event) => selectVariant(event.target.value)}>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {nameOf(variant)}
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
