/**
 * Shared stock display for the Office Panel.
 *
 * Shows a shortfall in plain words rather than hiding a negative number:
 * selling against undelivered factory stock is normal, and staff need to know
 * at the counter that the goods are not on the floor.
 */

import type { InventoryStockLevel } from '@orderbook/shared';

export function StockCell({ level }: { level: InventoryStockLevel | undefined }) {
  if (!level) return <span className="muted">—</span>;

  if (level.quantityBoxes < 0) {
    return (
      <span style={{ color: 'var(--danger)' }}>
        Short {Math.abs(level.quantityBoxes)}
        <div className="muted">not in stock</div>
      </span>
    );
  }

  return (
    <span>
      {level.quantityBoxes} {level.quantityBoxes === 1 ? 'box' : 'boxes'}
      {level.isLow && <span className="badge cancelled" style={{ marginLeft: 6 }}>Low</span>}
    </span>
  );
}
