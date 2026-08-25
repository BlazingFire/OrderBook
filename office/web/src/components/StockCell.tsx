/**
 * Shared stock display for the Office Panel, now per (product, colour).
 *
 * Shows three different things because they answer three different questions:
 * what is on the floor, what is already promised to an order, and what is
 * actually free to sell. A single number cannot say "we have 40, 30 of them
 * spoken for", and that is exactly the situation staff need to see at the
 * counter.
 *
 * A shortfall is stated in plain words rather than hidden behind a negative
 * number: selling against undelivered factory stock is normal here, but staff
 * must know the goods are not in the building.
 *
 * `StockByColour` renders compactly (one line per colour, chip + free count +
 * a "low" pill) so it fits inside a fixed-height `DataTable` row (6-UI-DESIGN.md
 * §9.1); the on-floor/reserved breakdown that `StockCell` prints is carried in
 * a tooltip instead of a second line.
 */

import type { InventoryStockLevel } from '@orderbook/shared';
import { ColourChip, StatusPill } from '../ui/DataDisplay';
import { t } from '../i18n/strings';

export function StockCell({ level }: { level: InventoryStockLevel | undefined }) {
  if (!level) return <span style={{ color: 'var(--fg-tertiary)' }}>{t('catalog.stock.none')}</span>;

  if (level.availableBoxes < 0) {
    return (
      <span style={{ color: 'var(--state-conflict)' }}>
        {t('catalog.stock.short', { count: Math.abs(level.availableBoxes) })}
        <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
          {level.reservedBoxes > 0
            ? t('catalog.stock.onFloorReserved', { onFloor: level.quantityBoxes, reserved: level.reservedBoxes })
            : t('catalog.stock.onFloor', { onFloor: level.quantityBoxes })}
        </div>
      </span>
    );
  }

  return (
    <span>
      <span className="ob-data">{level.availableBoxes}</span> {t('catalog.stock.free')}
      {level.isLow && (
        <span style={{ marginLeft: 'var(--s-6)' }}>
          <StatusPill tone="offline">{t('catalog.stock.low')}</StatusPill>
        </span>
      )}
      {level.reservedBoxes > 0 && (
        <div className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
          {t('catalog.stock.onFloorReserved', { onFloor: level.quantityBoxes, reserved: level.reservedBoxes })}
        </div>
      )}
    </span>
  );
}

/** Every colour a product is stocked in, compact enough for a DataTable row. */
export function StockByColour({
  productId,
  stock,
  colourHex,
}: {
  productId: string;
  stock: InventoryStockLevel[];
  colourHex?: (colour: string) => string | undefined;
}) {
  const levels = stock.filter((level) => level.productId === productId);
  if (levels.length === 0) return <span style={{ color: 'var(--fg-tertiary)' }}>{t('catalog.stock.none')}</span>;

  return (
    <span style={{ display: 'inline-flex', gap: 'var(--s-12)', flexWrap: 'wrap' }}>
      {levels.map((level) => (
        <span
          key={level.colour}
          title={
            level.reservedBoxes > 0
              ? t('catalog.stock.tooltipReserved', {
                  colour: level.colour,
                  onFloor: level.quantityBoxes,
                  reserved: level.reservedBoxes,
                })
              : t('catalog.stock.tooltip', { colour: level.colour, onFloor: level.quantityBoxes })
          }
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}
        >
          <ColourChip name={level.colour} hex={colourHex?.(level.colour)} />
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
      ))}
    </span>
  );
}
