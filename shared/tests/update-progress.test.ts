import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatEta,
  formatSpeed,
  IDLE_PROGRESS,
  UpdateProgressTracker,
} from '../src/domain/update-progress.js';

describe('UpdateProgressTracker', () => {
  it('is idle until a download starts', () => {
    expect(new UpdateProgressTracker().snapshot(0)).toEqual(IDLE_PROGRESS);
  });

  it('reports bytes done, percent, speed and time left', () => {
    const tracker = new UpdateProgressTracker();
    tracker.start('1.3.0', 100_000_000, 0);
    tracker.add(10_000_000, 1_000);
    tracker.add(10_000_000, 2_000);
    const snap = tracker.snapshot(2_000);
    expect(snap.phase).toBe('downloading');
    expect(snap.receivedBytes).toBe(20_000_000);
    expect(snap.percent).toBe(20);
    expect(snap.bytesPerSecond).toBe(10_000_000);
    expect(snap.etaSeconds).toBe(8);
  });

  it('looks only at the last few seconds, so a stall shows as a stall', () => {
    const tracker = new UpdateProgressTracker();
    tracker.start('1.3.0', 1_000_000_000, 0);
    tracker.add(500_000_000, 1_000);
    // Nothing arrives for ten seconds: the average over the run would still be ~45 MB/s.
    const stalled = tracker.snapshot(11_000);
    expect(stalled.bytesPerSecond).toBe(0);
    expect(stalled.etaSeconds).toBeNull();
  });

  it('ignores chunks after it is no longer downloading', () => {
    const tracker = new UpdateProgressTracker();
    tracker.start('1.3.0', 100, 0);
    tracker.add(100, 10);
    tracker.verifying();
    tracker.add(50, 20);
    expect(tracker.snapshot(30).receivedBytes).toBe(100);
    expect(tracker.snapshot(30).phase).toBe('verifying');
    tracker.done();
    expect(tracker.snapshot(40)).toMatchObject({ phase: 'done', percent: 100, etaSeconds: null });
  });

  it('keeps the failure reason', () => {
    const tracker = new UpdateProgressTracker();
    tracker.start('1.3.0', 100, 0);
    tracker.fail('no route');
    expect(tracker.snapshot(1)).toMatchObject({ phase: 'failed', error: 'no route' });
    tracker.reset();
    expect(tracker.snapshot(2)).toEqual(IDLE_PROGRESS);
  });
});

describe('formatting', () => {
  it('writes sizes, speeds and times a person can read', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
    expect(formatSpeed(2.4 * 1024 * 1024)).toBe('2.40 MB/s');
    expect(formatEta(45)).toBe('45 s');
    expect(formatEta(190)).toBe('3 min 10 s');
    expect(formatEta(3900)).toBe('1 h 05 min');
    expect(formatEta(null)).toBe('—');
  });
});
