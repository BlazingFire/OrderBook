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

/**
 * Low stock judged against the company's default level, for a line that has
 * none of its own.
 *
 * `reorder_level` is NULL on every row a stock movement creates, and low stock
 * is judged on the reorder level alone — so without this the Dashboard's "Low
 * stock" tile reads 0 and the "Low only" filter is empty until somebody opens
 * each line and types a number by hand.
 *
 * **`reorderLevel` itself is deliberately left null.** The drawer's field must
 * stay blank, or editing anything else on that line would silently persist the
 * company default onto it as if somebody had chosen it. This decides what a
 * figure *means*, never what is stored — the same division `withoutReservations`
 * above already draws.
 *
 * Applied *after* `withoutReservations`, so it judges the same `availableBoxes`
 * every screen is showing.
 */
export function withDefaultReorderLevel(
  level: InventoryStockLevel,
  defaultLevel: number | null,
): InventoryStockLevel {
  if (level.reorderLevel !== null || defaultLevel === null) return level;
  return { ...level, isLow: level.availableBoxes <= defaultLevel };
}
