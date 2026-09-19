/**
 * Shared stock display for the Office Panel, per variant.
 *
 * Shows what is actually free to sell rather than what is on the floor: a
 * single number cannot say "we have 40, 30 of them spoken for", and that is
 * exactly the situation staff need to see at the counter — so the on-floor and
 * reserved figures ride along in a tooltip.
 *
 * A shortfall is stated in colour rather than hidden behind a negative
 * number: selling against undelivered factory stock is normal here, but staff
 * must know the goods are not in the building.
 *
 * `StockByVariant` renders compactly (one entry per variant: colour chip or
 * code, free count, a "low" pill) so it fits inside a fixed-height `DataTable`
 * row (6-UI-DESIGN.md §9.1).
 */

import type { InventoryStockLevel } from '@orderbook/shared';
import { ColourChip, StatusPill, t } from '@orderbook/ui';

/** Every variant a product is stocked in, compact enough for a DataTable row. */
export function StockByVariant({
  productId,
  stock,
  colourHex,
}: {
  productId: string;
  stock: InventoryStockLevel[];
  colourHex?: (colour: string) => string | undefined;
}) {
  const levels = stock.filter((level) => level.productId === productId);
  if (levels.length === 0)
    return <span style={{ color: 'var(--fg-tertiary)' }}>{t('catalog.stock.none')}</span>;

  return (
    <span style={{ display: 'inline-flex', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
      {levels.map((level) => {
        const name = level.variantLabel ?? level.variantCode;
        return (
          <span
            key={level.variantId}
            title={
              level.reservedBoxes > 0
                ? t('catalog.stock.tooltipReserved', {
                    variant: name,
                    onFloor: level.quantityBoxes,
                    reserved: level.reservedBoxes,
                  })
                : t('catalog.stock.tooltip', { variant: name, onFloor: level.quantityBoxes })
            }
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}
          >
            {level.variantLabel ? (
              <ColourChip name={level.variantLabel} hex={colourHex?.(level.variantLabel)} />
            ) : (
              <span className="ob-mono ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
                {level.variantCode}
              </span>
            )}
            <span
              className="ob-data"
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
            {level.isLow && <StatusPill tone="offline">{t('catalog.stock.low')}</StatusPill>}
          </span>
        );
      })}
    </span>
  );
}
