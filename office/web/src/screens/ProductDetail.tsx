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
 * **There is no stock on this screen**, and none anywhere in OrderBook (removed
 * in 1.4). Nothing here posts a write except the photo card.
 *
 * Every figure comes from the already-flowing snapshot: the details card reads
 * straight off `Product`, through `productSummary.ts` so that its code,
 * weight, product and colour read the same as the list row's.
 *
 * In the owner's words this is a **sub product** (`docs/catalogue/
 * CATALOGUE_MODEL.md` §1): its brand and product (`One Piece Toilet`)
 * are read through its category, and its colour is shown by the rule the
 * catalogue gives it (§2) — the fixed colour, "Multicolour", or, for a
 * numbered design, no Colour field at all.
 *
 * Editing is not done inline — it reuses `ProductDrawer`'s existing edit mode
 * via `onEdit`, which is a real, already-queued write path; duplicating that
 * here would just be a second form for the same record.
 */

import type { ReactNode } from 'react';
import type { Product } from '@orderbook/shared';

import { Button, Card, ColourName, StatusPill, rem, t } from '@orderbook/ui';
import { ProductImages } from '../components/ProductImages';
import { codesOf, productLabel, shownColours, weightLabel } from '../productSummary';

/**
 * A sub product's colour under its rule, for a list cell or a detail field:
 * "Multicolour" when the counter picks it, the fixed colour (with its swatch
 * when the colour range has a hex for it, plain text otherwise — a two-letter
 * ring for Black reads as nothing), and nothing at all for a numbered design.
 */
export function SubProductColour({
  product,
  colourHex,
}: {
  product: Product;
  colourHex: (colour: string) => string | undefined;
}) {
  if (product.multiColour) {
    return <StatusPill tone="accent">{t('catalog.colourRule.multicolour')}</StatusPill>;
  }
  const colours = shownColours(product);
  if (colours.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 'var(--s-8)', minWidth: 0 }}>
      {colours.map((colour) => {
        const hex = colourHex(colour);
        return hex ? (
          <ColourName key={colour} name={colour} hex={hex} />
        ) : (
          <span key={colour}>{colour}</span>
        );
      })}
    </span>
  );
}

export function ProductDetail({
  product,
  colourHex,
  onEdit,
  onDelete,
  onPhotosChanged,
  onError,
}: {
  product: Product;
  /** The `stock.colour` swatches (`useColourHex`), for the Colour field. */
  colourHex: (colour: string) => string | undefined;
  onEdit: () => void;
  /** `products.delete`: a Delete button beside Edit; absent without it. */
  onDelete?: () => void;
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
            <span style={{ display: 'inline-flex', gap: 'var(--s-8)' }}>
              <Button variant="primary" size="sm" icon="edit" onClick={onEdit}>
                {t('product.detail.editAction')}
              </Button>
              {onDelete && (
                <Button variant="danger" size="sm" icon="trash" onClick={onDelete}>
                  {t('catalog.subProducts.delete')}
                </Button>
              )}
            </span>
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
            <DetailField label={t('product.field.brand')} value={product.brand} />
            <DetailField
              label={t('product.detail.category')}
              value={productLabel(product.categoryName)}
            />
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
            {/* Absent rather than a dash for a numbered design: the owner's
                rule is that no colour is shown for one anywhere. */}
            {(product.multiColour || shownColours(product).length > 0) && (
              <DetailField
                label={t('product.detail.colour')}
                value={<SubProductColour product={product} colourHex={colourHex} />}
              />
            )}
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
