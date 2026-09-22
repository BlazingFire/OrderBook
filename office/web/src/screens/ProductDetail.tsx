/**
 * ProductDetail — the view-only body Catalog/Products opens on a row click
 * (`Products.dc.html`'s detail, the piece the QA review found missing
 * entirely — clicking a row previously jumped straight into the edit form
 * with no way to just look).
 *
 * Two columns above the variants: the **Photo** card and the **Details** card.
 * Photos used to live at the bottom of the edit drawer, which put the one
 * thing anyone opens a ceramic product to look at behind a form; they lead the
 * screen now, and the drawer is a form again. The details card carries the
 * edit button in its own header, next to the fields it edits, rather than in a
 * row of buttons under the whole screen.
 *
 * Every figure here comes from the already-flowing snapshot: the details card
 * reads straight off `Product` (through `productSummary.ts`, so its code and
 * weight read the same as the list row's), and the variants table joins the
 * product's own `variants[]` to `view.stock` by variant id. This is the only
 * place stock is shown now — the list dropped its compact chip column in the
 * redesign, which is defensible exactly because the whole record is one click
 * away. A variant with no stock row yet is still listed, with dashes: it
 * exists, it has a code, nobody has received any.
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
import type { ReactNode } from 'react';
import type { Product, ProductVariant } from '@orderbook/shared';

import { api, type LocalView } from '../api';
import {
  Button,
  Card,
  ColourName,
  DataTable,
  FormField,
  Input,
  NumberInput,
  Select,
  StatusPill,
  formatKg,
  rem,
  t,
  useColourHex,
  type DataTableColumn,
} from '@orderbook/ui';
import { ProductImages } from '../components/ProductImages';
import { codesOf, weightLabel } from '../productSummary';

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
  onPhotosChanged,
  onMessage,
  onError,
}: {
  product: Product;
  view: LocalView;
  onEdit: () => void;
  /**
   * A photo write came back with the whole product. The snapshot catches up on
   * its own, but not before the next frame, and a cover photo that keeps the
   * old thumbnail for a second reads as a failed upload.
   */
  onPhotosChanged: (product: Product) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}) {
  const colourHex = useColourHex(view.optionLists);
  const [mode, setMode] = useState<StockMode>('none');
  // Absent means an older Master, which sends every figure — read as "on".
  const freeToSell = view.features?.freeToSell ?? true;

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
    ...(freeToSell
      ? [
          {
            key: 'reserved',
            header: t('product.detail.stock.reserved'),
            width: rem(84),
            align: 'right' as const,
            render: ({ reserved }: VariantRow) => reserved ?? '—',
          },
          {
            key: 'free',
            header: t('product.detail.stock.free'),
            width: rem(84),
            align: 'right' as const,
            render: ({ free }: VariantRow) =>
              free === null ? (
                '—'
              ) : (
                <span
                  className="ob-body-strong"
                  style={{
                    color:
                      free < 0
                        ? 'var(--state-conflict)'
                        : free === 0
                          ? 'var(--fg-tertiary)'
                          : 'var(--fg-primary)',
                  }}
                >
                  {free}
                </span>
              ),
          },
        ]
      : []),
  ];

  const weight = weightLabel(product);

  return (
    <>
      {/* Photo left, facts right, and both wrap to one column when the window
          (or the scale) leaves no room — `flex-wrap` rather than a breakpoint,
          for the reason `FieldGrid` gives. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: 'var(--s-20)',
        }}
      >
        <div
          style={{
            flex: `1 1 ${rem(320)}`,
            minWidth: rem(220),
            maxWidth: rem(400),
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-16)',
          }}
        >
          <ProductImages product={product} onChanged={onPhotosChanged} onError={onError} />
        </div>

        <div
          style={{
            flex: `1 1 ${rem(280)}`,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-16)',
          }}
        >
          <Card padded={false}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--s-8)',
                padding: 'var(--s-12) var(--s-16)',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span className="ob-eyebrow" style={{ color: 'var(--fg-tertiary)' }}>
                {t('product.detail.detailsTitle')}
              </span>
              <Button variant="primary" size="sm" icon="edit" onClick={onEdit}>
                {t('product.detail.editAction')}
              </Button>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fit, minmax(${rem(150)}, 1fr))`,
                gap: 'var(--s-16) var(--s-20)',
                padding: 'var(--s-16)',
                alignItems: 'start',
              }}
            >
              <DetailField label={t('product.detail.category')} value={product.categoryName} />
              <DetailField
                label={t('product.detail.code')}
                value={<span className="ob-mono ob-body-strong">{codesOf(product)}</span>}
              />
              <DetailField label={t('product.field.alias')} value={product.alias} />
              <DetailField label={t('product.detail.size')} value={product.size} />
              <DetailField
                label={t('product.detail.weight')}
                value={
                  weight === null ? (
                    <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
                  ) : (
                    weight
                  )
                }
              />
              <DetailField
                label={t('product.multiColour.label')}
                value={
                  product.multiColour
                    ? t('product.multiColour.detailYes')
                    : t('product.multiColour.detailNo')
                }
              />
            </div>
          </Card>
        </div>
      </div>

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

/**
 * One labelled fact in the details grid.
 *
 * An empty value renders as a dash in the tertiary colour rather than an empty
 * cell: "this product has no alias" and "this row failed to render" have to
 * look different.
 */
function DetailField({ label, value }: { label: string; value: ReactNode }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: rem(4), minWidth: 0 }}>
      <span className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
        {label}
      </span>
      {empty ? (
        <span style={{ color: 'var(--fg-tertiary)' }}>—</span>
      ) : typeof value === 'string' ? (
        <span className="ob-body-strong">{value}</span>
      ) : (
        <span>{value}</span>
      )}
    </div>
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
