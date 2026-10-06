/** Display helpers shared across screens. */

import { t } from './i18n.js';

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

/**
 * Date and time to the minute. Seconds made "10/5/2026, 12:52:00 PM" wider
 * than every table's date column at 1080p, and nobody reads them off a list.
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The date alone, for a column that says when something began. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

/**
 * How long something has lasted, to the minute: "42 m", "1 h", "1 h 5 m".
 * The unit words come from the catalogue, so the numbers never sit in it.
 * Seconds are dropped and anything under a minute reads "0 m"; a negative
 * span (a clock that moved back) reads the same.
 */
export function formatElapsed(ms: number): string {
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : 0;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t('time.minutes.short', { count: rest });
  const whole = t('time.hours.short', { count: hours });
  return rest === 0 ? whole : `${whole} ${t('time.minutes.short', { count: rest })}`;
}
