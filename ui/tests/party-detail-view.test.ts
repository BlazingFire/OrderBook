import { describe, expect, it } from 'vitest';

import { followUpLabel } from '../src/PartyDetailView';

describe('the follow-up column on a party screen', () => {
  const now = new Date(2026, 9, 8, 22, 30);

  it('says Today, Tomorrow, or Overdue against the local date', () => {
    expect(followUpLabel('2026-10-08', now)).toEqual({ text: 'Today', overdue: false });
    expect(followUpLabel('2026-10-09', now)).toEqual({ text: 'Tomorrow', overdue: false });
    expect(followUpLabel('2026-10-01', now).overdue).toBe(true);
    expect(followUpLabel('2026-10-01', now).text).toMatch(/^Overdue · /);
    expect(followUpLabel('2026-10-20', now).overdue).toBe(false);
  });

  it('draws a dash for no date', () => {
    expect(followUpLabel(null, now)).toEqual({ text: '—', overdue: false });
  });
});
