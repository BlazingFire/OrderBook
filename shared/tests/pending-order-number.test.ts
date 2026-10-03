/**
 * Pending order numbers (`pending-order-number.ts`): the financial year a
 * moment falls in, and the number's printed shape.
 */

import { describe, expect, it } from 'vitest';

import {
  financialYearLabel,
  formatPendingOrderNumber,
  matchesRecordSearch,
  PO_NUMBER_PATTERN,
  recordNumber,
} from '../src/index.js';

describe('financialYearLabel', () => {
  it('turns over at 1 April 00:00 in India, not at midnight UTC', () => {
    // 31 March 23:59:59 IST is 18:29:59 UTC; 1 April 00:00 IST is 18:30 UTC.
    expect(financialYearLabel(new Date('2027-03-31T18:29:59Z'))).toBe('2026-27');
    expect(financialYearLabel(new Date('2027-03-31T18:30:00Z'))).toBe('2027-28');
  });

  it('puts January to March in the year that began the April before', () => {
    expect(financialYearLabel(new Date('2027-01-15T06:00:00Z'))).toBe('2026-27');
    expect(financialYearLabel(new Date('2026-04-01T06:00:00Z'))).toBe('2026-27');
  });

  it('wraps the second half at a century', () => {
    expect(financialYearLabel(new Date('2099-06-01T06:00:00Z'))).toBe('2099-00');
  });

  it('reads the zone it is given', () => {
    // 1 April 02:00 UTC is still 31 March in New York.
    expect(financialYearLabel(new Date('2027-04-01T02:00:00Z'), 'America/New_York')).toBe('2026-27');
    expect(financialYearLabel(new Date('2027-04-01T02:00:00Z'), 'UTC')).toBe('2027-28');
  });
});

describe('formatPendingOrderNumber', () => {
  it('pads the sequence to five digits', () => {
    expect(formatPendingOrderNumber('2026-27', 1)).toBe('PO/2026-27/00001');
    expect(formatPendingOrderNumber('2026-27', 42)).toBe('PO/2026-27/00042');
    expect(formatPendingOrderNumber('2026-27', 99999)).toBe('PO/2026-27/99999');
  });

  it('widens past five digits rather than truncating', () => {
    expect(formatPendingOrderNumber('2026-27', 100000)).toBe('PO/2026-27/100000');
    expect(formatPendingOrderNumber('2026-27', 1234567)).toBe('PO/2026-27/1234567');
  });

  it('always makes a number the stored CHECK accepts', () => {
    for (const sequence of [1, 99999, 100000, 1234567]) {
      expect(formatPendingOrderNumber('2026-27', sequence)).toMatch(PO_NUMBER_PATTERN);
    }
    expect('PO/2026-27/0001').not.toMatch(PO_NUMBER_PATTERN);
    expect('PO/26-27/00001').not.toMatch(PO_NUMBER_PATTERN);
    expect('LD0000000001').not.toMatch(PO_NUMBER_PATTERN);
  });
});

describe('recordNumber', () => {
  it('shows the PO number, and the id when there is none', () => {
    expect(recordNumber({ id: 'LD0000000042', poNumber: 'PO/2026-27/00042' })).toBe('PO/2026-27/00042');
    expect(recordNumber({ id: 'LD0000000042', poNumber: null })).toBe('LD0000000042');
    expect(recordNumber({ id: 'OD0000000007' })).toBe('OD0000000007');
  });
});

describe('record search', () => {
  const record = { id: 'LD0000000042', poNumber: 'PO/2026-27/00042', partyName: 'Patel Tiles', items: [] };

  it('finds a record by its PO number, whole or by the sequence alone', () => {
    expect(matchesRecordSearch(record, 'PO/2026-27/00042')).toBe(true);
    expect(matchesRecordSearch(record, '00042')).toBe(true);
    expect(matchesRecordSearch(record, '00043')).toBe(false);
  });
});
