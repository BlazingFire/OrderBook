/**
 * Who sees Reports and whose figures: the one rule `report-access.ts` states.
 * The server enforces it; these pin what the screens read.
 */

import { describe, expect, it } from 'vitest';

import {
  REPORT_KINDS,
  mayReportOnOthers,
  offeredReportKinds,
  reportsOffered,
  reportsVisibleForTier,
} from '../src/index.js';

describe('mayReportOnOthers', () => {
  it('is for administrators and above only', () => {
    expect(mayReportOnOthers('office')).toBe(false);
    expect(mayReportOnOthers('management')).toBe(false);
    expect(mayReportOnOthers('admin')).toBe(true);
  });
});

describe('reportsVisibleForTier', () => {
  it('is on for every tier on a company that never touched the switches', () => {
    for (const tier of ['office', 'management', 'admin'] as const) {
      expect(reportsVisibleForTier(tier, undefined)).toBe(true);
      expect(reportsVisibleForTier(tier, null)).toBe(true);
      expect(reportsVisibleForTier(tier, {})).toBe(true);
    }
  });

  it("follows each tier's own switch, and never switches an administrator off", () => {
    const features = { reportsVisibleToOffice: false, reportsVisibleToManagement: true };
    expect(reportsVisibleForTier('office', features)).toBe(false);
    expect(reportsVisibleForTier('management', features)).toBe(true);

    const allOff = { reportsVisibleToOffice: false, reportsVisibleToManagement: false };
    expect(reportsVisibleForTier('management', allOff)).toBe(false);
    expect(reportsVisibleForTier('admin', allOff)).toBe(true);
  });
});

describe('reportsOffered and offeredReportKinds', () => {
  const on = {};
  const off = { reportsVisibleToOffice: false };

  it('need the permission as well as the switch', () => {
    expect(reportsOffered('office', on, ['reports.view'])).toBe(true);
    expect(reportsOffered('office', on, ['reports.export'])).toBe(false);
    expect(reportsOffered('office', off, ['reports.view'])).toBe(false);
  });

  it('offer all fifteen kinds, or none', () => {
    expect(REPORT_KINDS).toHaveLength(15);
    expect(offeredReportKinds('office', on, ['reports.view'])).toEqual([...REPORT_KINDS]);
    expect(offeredReportKinds('office', off, ['reports.view'])).toEqual([]);
    expect(offeredReportKinds('office', on, [])).toEqual([]);
  });
});
