/**
 * How stock reads with the company's free-to-sell switch off.
 *
 * Pure and shared, like `visibility.ts`: the Master applies it to every stock
 * figure it hands out, and the panels read the same shape either way. With the
 * switch off there is one number per colour — what is on the floor — so
 * "free" *is* the floor count, nothing is reserved as far as any screen can
 * see, and low stock is judged on the floor count. The reservations still
 * exist underneath; this only decides what a figure means on the way out.
 */

import type { InventoryStockLevel } from './entities.js';

export function withoutReservations(level: InventoryStockLevel): InventoryStockLevel {
  return {
    ...level,
    reservedBoxes: 0,
    availableBoxes: level.quantityBoxes,
    isLow: level.reorderLevel !== null && level.quantityBoxes <= level.reorderLevel,
  };
}
