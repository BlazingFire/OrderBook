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
 */

import type { InventoryStockLevel } from '@orderbook/shared';

export function StockCell({ level }: { level: InventoryStockLevel | undefined }) {
  if (!level) return <span className="muted">—</span>;

  if (level.availableBoxes < 0) {
    return (
      <span style={{ color: 'var(--danger)' }}>
        Short {Math.abs(level.availableBoxes)}
        <div className="muted">
          {level.quantityBoxes} on floor
          {level.reservedBoxes > 0 && `, ${level.reservedBoxes} reserved`}
        </div>
      </span>
    );
  }

  return (
    <span>
      <span className="num">{level.availableBoxes}</span> free
      {level.isLow && (
        <span className="chip short" style={{ marginLeft: 6 }}>
          low
        </span>
      )}
      {level.reservedBoxes > 0 && (
        <div className="muted">
          {level.quantityBoxes} on floor, {level.reservedBoxes} reserved
        </div>
      )}
    </span>
  );
}

/** Every colour a product is stocked in, for the catalogue's stock column. */
export function StockByColour({
  productId,
  stock,
}: {
  productId: string;
  stock: InventoryStockLevel[];
}) {
  const levels = stock.filter((level) => level.productId === productId);
  if (levels.length === 0) return <span className="muted">—</span>;

  return (
    <div>
      {levels.map((level) => (
        <div key={level.colour} style={{ marginBottom: 2 }}>
          <span className="muted">{level.colour}: </span>
          <StockCell level={level} />
        </div>
      ))}
    </div>
  );
}
