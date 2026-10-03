/**
 * Pending order numbers (1.3 rule 2): `PO/2026-27/00001`.
 *
 * One series per Indian financial year, which runs from 1 April 00:00 to
 * 31 March, in the company's time zone. Only the Master mints a number, inside
 * the transaction that creates the lead (`identity.repository.ts`), so the
 * series is gap-free and a number is never reused. A pending order saved on an
 * Office while the Master was out of reach has no number until it syncs; the
 * screens show it as Provisional until then.
 *
 * A final order has no number of its own: it shows its pending order's, read
 * through the lead it came from.
 */

/** The stored shape. The sequence is at least five digits and grows past them, never truncated. */
export const PO_NUMBER_PATTERN = /^PO\/[0-9]{4}-[0-9]{2}\/[0-9]{5,}$/;

/**
 * The financial year `at` falls in, as `2026-27`.
 *
 * Read through `formatToParts` rather than by shifting the date by a fixed
 * offset, so it holds for any zone the company is configured with and runs on
 * the Win7 Office's Node 16 as well.
 */
export function financialYearLabel(at: Date, timeZone = 'Asia/Kolkata'): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(at);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** `PO/<fy>/<seq>`, the sequence padded to five digits. */
export function formatPendingOrderNumber(financialYear: string, sequence: number): string {
  return `PO/${financialYear}/${String(sequence).padStart(5, '0')}`;
}

/** What a screen shows for a pending or final order: its PO number, or its id when it has none. */
export function recordNumber(record: { id: string; poNumber?: string | null }): string {
  return record.poNumber || record.id;
}
