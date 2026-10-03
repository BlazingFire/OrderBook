/**
 * `RecordNumber` and `recordNumberText`: the PO number when the Master gave
 * one, Provisional (with the temporary id beside it) while an Office save is
 * still waiting for it, and the id otherwise.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceCodeFromSeed, formatTemporaryId } from '@orderbook/shared';

import { t } from '../src/i18n.js';
import { RecordNumber, recordNumberText } from '../src/RecordNumber.js';

afterEach(cleanup);

const TEMP_ID = formatTemporaryId(deviceCodeFromSeed('counter'), 7);

describe('RecordNumber', () => {
  it('shows the PO number in place of the id', () => {
    render(<RecordNumber record={{ id: 'LD0000000042', poNumber: 'PO/2026-27/00042' }} />);
    expect(screen.getByText('PO/2026-27/00042')).toBeTruthy();
    expect(screen.queryByText('LD0000000042')).toBeNull();
  });

  it('shows Provisional with the temporary id while the Master has not numbered it', () => {
    const { container } = render(<RecordNumber record={{ id: TEMP_ID }} />);
    expect(screen.getByText(t('lead.number.provisional'))).toBeTruthy();
    expect(screen.getByText(TEMP_ID)).toBeTruthy();
    expect(container.querySelector('[data-provisional]')?.getAttribute('title')).toBe(
      t('lead.number.provisionalHint'),
    );
  });

  it('shows a numbered lead still under its temporary id by its number', () => {
    render(<RecordNumber record={{ id: TEMP_ID, poNumber: 'PO/2026-27/00043' }} />);
    expect(screen.getByText('PO/2026-27/00043')).toBeTruthy();
    expect(screen.queryByText(t('lead.number.provisional'))).toBeNull();
  });

  it('falls back to the id when there is no number (an order with no lead, an older Master)', () => {
    render(<RecordNumber record={{ id: 'OD0000000007', poNumber: null }} />);
    expect(screen.getByText('OD0000000007')).toBeTruthy();
  });
});

describe('recordNumberText', () => {
  it('names a record the way a toast should', () => {
    expect(recordNumberText({ id: 'LD0000000042', poNumber: 'PO/2026-27/00042' })).toBe(
      'PO/2026-27/00042',
    );
    expect(recordNumberText({ id: TEMP_ID })).toBe(t('lead.number.provisional'));
    expect(recordNumberText({ id: 'LD0000000042' })).toBe('LD0000000042');
  });
});
