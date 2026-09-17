/**
 * The five-minute `panel:report`, normalised before it reaches typed columns.
 *
 * Pure — no cluster — so this suite cannot silently skip, which matters because
 * what it guards is a **500 on a screen an administrator opens**, not a dropped
 * report. `refreshPanelReport` routes through the same function
 * `recordPanelReport` does, so a report that cannot be written poisons the
 * panel's detail card until somebody fixes the row by hand.
 *
 * `office-panel.repository.ts` writes `storageBytes`/`diskFreeBytes`/
 * `diskTotalBytes` into BIGINTs and `report.startedAt ? new Date(…) : null`
 * into a timestamp, and nothing in the chain — `hub.ts`, `panel.service.ts`,
 * the repository — checked any of it.
 */

import { describe, expect, it } from 'vitest';

import { normalisePanelReport } from '../src/domain/panel-report.js';

/** What a healthy panel posts. */
const GOOD = {
  hostname: 'RECEPTION-PC',
  platform: 'win32',
  osVersion: '10.0.22631',
  appVersion: '1.1.0',
  nodeVersion: 'v20.11.0',
  dataDir: 'C:\\Users\\shop\\AppData\\Roaming\\OrderBook\\office',
  imagesDir: 'C:\\Users\\shop\\AppData\\Roaming\\OrderBook\\office\\images',
  storageBytes: 4_194_304,
  diskFreeBytes: 120_000_000_000,
  diskTotalBytes: 500_000_000_000,
  localPort: 4200,
  startedAt: '2026-09-14T08:00:00.000Z',
  pendingMutations: 3,
  cachedImages: 41,
  lastSnapshotAt: '2026-09-14T09:30:00.000Z',
  signedInUsername: 'priya',
};

describe('normalisePanelReport', () => {
  it('passes an honest report through unchanged', () => {
    expect(normalisePanelReport(GOOD)).toEqual(GOOD);
  });

  it('turns an unparseable startedAt into null rather than an Invalid Date', () => {
    const raw = 'the day before yesterday';

    // What the repository used to do with it, and why the screen 500'd:
    // `report.startedAt ? new Date(report.startedAt) : null` produced an
    // `Invalid Date`, which Postgres's date serializer rejects with
    // `RangeError: Invalid time value`.
    expect(() => new Date(raw).toISOString()).toThrow(RangeError);

    // Normalised, the field is the honest "we do not know" the column already
    // allows, and the rest of the report still lands.
    const report = normalisePanelReport({ ...GOOD, startedAt: raw });
    expect(report.startedAt).toBeNull();
    expect(report.hostname).toBe(GOOD.hostname);
  });

  it('re-serialises a valid but oddly-spelled timestamp', () => {
    const report = normalisePanelReport({ ...GOOD, lastSnapshotAt: '2026-09-14T09:30:00+05:30' });

    // What lands in the column is a value this process has already proved
    // `Date` can read, not whatever string the panel happened to send.
    expect(report.lastSnapshotAt).toBe('2026-09-14T04:00:00.000Z');
  });

  it.each([
    ['a fraction', 1.5],
    ['beyond a safe integer', 1e30],
    ['negative', -1],
    ['a string', '4194304'],
    ['absent', undefined],
  ])('drops a byte count that is %s', (_label, value) => {
    expect(normalisePanelReport({ ...GOOD, storageBytes: value }).storageBytes).toBeNull();
  });

  it('clamps unbounded TEXT rather than refusing the whole report', () => {
    // `dataDir` and `imagesDir` are unbounded columns, so without a clamp a
    // panel could post a multi-megabyte hostname every five minutes forever.
    const report = normalisePanelReport({
      ...GOOD,
      hostname: 'x'.repeat(5_000),
      dataDir: 'y'.repeat(5_000),
    });

    expect(report.hostname).toHaveLength(255);
    expect(report.dataDir).toHaveLength(1024);
    // The rest of the report survives — one odd field is not a reason to lose
    // the disk figures an administrator is looking at.
    expect(report.diskFreeBytes).toBe(GOOD.diskFreeBytes);
  });

  it('rejects a port outside the range a port can have', () => {
    for (const bad of [0, -1, 70_000, 4200.5, 'a lot']) {
      expect(normalisePanelReport({ ...GOOD, localPort: bad }).localPort).toBe(0);
    }
    expect(normalisePanelReport(GOOD).localPort).toBe(4200);
  });

  it('survives a payload that is not an object at all', () => {
    // An older build, a truncated frame, or something malicious — none of it
    // should be able to throw on the way in.
    for (const junk of [null, undefined, 'report', 42, []]) {
      expect(() => normalisePanelReport(junk)).not.toThrow();
    }
    expect(normalisePanelReport(null).hostname).toBe('');
  });
});
