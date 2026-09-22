/**
 * ProductDetail — the view-only body Catalog/Products opens on a row click.
 *
 * Two cards, and nothing else: the **Photo** card and the **Details** card.
 * Photos used to live at the bottom of the edit drawer, which put the one
 * thing anyone opens a ceramic product to look at behind a form; they lead the
 * screen now, and the drawer is a form again. The details card carries the
 * edit button in its own header, next to the fields it edits, rather than in a
 * row of buttons under the whole screen.
 *
 * **There is no stock on this screen** (2026-09-22). It used to carry a
 * variants-and-stock table and a "Stock in" / "Adjust count" form; the owner's
 * redesign has neither, and they are gone. Stock is the Master Panel's job —
 * `master/web`'s Inventory screen owns the reorder band, the per-variant
 * ledger and both movement forms — which is also where the single-writer rule
 * says it belongs. Nothing here posts a write except the photo card.
 *
 * Every figure comes from the already-flowing snapshot: the details card reads
 * straight off `Product`, through `productSummary.ts` so that its code and
 * weight read the same as the list row's.
 *
 * Editing is not done inline — it reuses `ProductDrawer`'s existing edit mode
 * via `onEdit`, which is a real, already-queued write path; duplicating that
 * here would just be a second form for the same record.
 */

import type { ReactNode } from 'react';
import type { Product } from '@orderbook/shared';

import { Button, Card, StatusPill, rem, t } from '@orderbook/ui';
import { ProductImages } from '../components/ProductImages';
import { codesOf, weightLabel } from '../productSummary';

export function ProductDetail({
  product,
  onEdit,
  onPhotosChanged,
  onError,
}: {
  product: Product;
  onEdit: () => void;
  /**
   * A photo write came back with the whole product. The snapshot catches up on
   * its own, but not before the next frame, and a cover photo that keeps the
   * old thumbnail for a second reads as a failed upload.
   */
  onPhotosChanged: (product: Product) => void;
  onError: (message: string) => void;
}) {
  const weight = weightLabel(product);

  // Photo left, facts right, and both wrap to one column when the window (or
  // the scale) leaves no room — `flex-wrap` rather than a breakpoint, for the
  // reason `FieldGrid` gives.
  return (
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
