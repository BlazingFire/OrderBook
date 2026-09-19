/** Display helpers shared across screens. */

/** Money is stored in the smallest unit (paise); show it as rupees. */
export function formatMoney(smallestUnit: number | null): string {
  if (smallestUnit === null) return '—';
  return `₹${(smallestUnit / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A weight in kilograms, to three decimals at most — the precision the master
 * stores. `null` is an unentered weight, shown as a dash rather than a zero so
 * it never reads as "weighs nothing".
 */
export function formatKg(kg: number | null): string {
  if (kg === null || !Number.isFinite(kg)) return '—';
  return `${kg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
