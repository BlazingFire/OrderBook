/**
 * A pending or final order's number, the way every screen shows it.
 *
 * The Master gives a pending order its PO number (`PO/2026-27/00042`) when it
 * creates it, and a final order shows its pending order's. A pending order
 * saved on an Office while the Master was out of reach has none yet: it shows
 * **Provisional** beside its temporary id until it syncs, never a guessed
 * number. A record with neither (an order with no lead, or an older Master)
 * shows its id.
 */

import { isTemporaryId, recordNumber } from '@orderbook/shared';

import { StatusPill } from './DataDisplay.js';
import { t } from './i18n.js';

interface NumberedRecord {
  id: string;
  poNumber?: string | null;
}

/** Whether the record is still waiting for the Master to number it. */
function provisional(record: NumberedRecord): boolean {
  return !record.poNumber && isTemporaryId(record.id);
}

/** The number as text, for a toast or a dialog title: "Provisional" while there is none. */
export function recordNumberText(record: NumberedRecord): string {
  return provisional(record) ? t('lead.number.provisional') : recordNumber(record);
}

export function RecordNumber({ record, small = false }: { record: NumberedRecord; small?: boolean }) {
  const className = small ? 'ob-mono ob-small' : 'ob-mono';
  if (!provisional(record)) {
    return <span className={className}>{recordNumber(record)}</span>;
  }
  return (
    <span
      className="ob-recordnumber"
      data-provisional="true"
      title={t('lead.number.provisionalHint')}
    >
      <StatusPill tone="offline">{t('lead.number.provisional')}</StatusPill>
      <span className={className} style={{ color: 'var(--fg-tertiary)' }}>
        {record.id}
      </span>
    </span>
  );
}
