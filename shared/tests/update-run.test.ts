/**
 * The Updating screen's arithmetic (1.5): which step is where, how far the bar
 * is, the time left, and the once-only "update finished" notice.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INSTALL_SECONDS,
  finishedUpdateNotice,
  formatClock,
  IDLE_PROGRESS,
  MASTER_UPDATE_STEPS,
  OFFICE_UPDATE_STEPS,
  updateRunFraction,
  updateSecondsLeft,
  updateStepStates,
  type UpdateDownloadProgress,
  type UpdateRunRecord,
} from '../src/index.js';

const downloading = (
  received: number,
  total: number,
  eta: number | null,
): UpdateDownloadProgress => ({
  ...IDLE_PROGRESS,
  phase: 'downloading',
  version: '1.5.0',
  receivedBytes: received,
  totalBytes: total,
  etaSeconds: eta,
});

describe('the steps', () => {
  it('are done before the current one, active on it and waiting after it', () => {
    expect(updateStepStates(OFFICE_UPDATE_STEPS, 'save', false)).toEqual([
      'done',
      'active',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('mark the current one failed when the update stopped there', () => {
    expect(updateStepStates(MASTER_UPDATE_STEPS, 'close', true)).toEqual([
      'done',
      'done',
      'failed',
      'pending',
      'pending',
    ]);
  });

  it('are the Master checking its own build and the Office downloading from the Master', () => {
    expect(MASTER_UPDATE_STEPS[0]).toBe('verify');
    expect(OFFICE_UPDATE_STEPS[0]).toBe('download');
    expect(MASTER_UPDATE_STEPS.slice(-2)).toEqual(['install', 'restart']);
  });
});

describe('the bar for the whole update', () => {
  it('counts whole steps, plus the real fraction of the download', () => {
    expect(
      updateRunFraction(OFFICE_UPDATE_STEPS, 'download', downloading(50, 100, 10)),
    ).toBeCloseTo(0.1);
    expect(updateRunFraction(OFFICE_UPDATE_STEPS, 'save', null)).toBeCloseTo(0.2);
  });

  it('never runs ahead of a step with nothing to measure', () => {
    expect(updateRunFraction(MASTER_UPDATE_STEPS, 'verify', null)).toBe(0);
    expect(updateRunFraction(MASTER_UPDATE_STEPS, 'install', null)).toBeCloseTo(0.6);
  });
});

describe('the time left', () => {
  it('is the download time left plus the install', () => {
    expect(
      updateSecondsLeft({
        current: 'download',
        download: downloading(1, 10, 30),
        installSeconds: 90,
      }),
    ).toBe(120);
  });

  it('is not guessed while the download speed is unknown', () => {
    expect(
      updateSecondsLeft({
        current: 'download',
        download: downloading(0, 10, null),
        installSeconds: 90,
      }),
    ).toBeNull();
  });

  it('uses the install time measured on this PC, else the stated default', () => {
    expect(updateSecondsLeft({ current: 'save', installSeconds: 75 })).toBe(75);
    expect(updateSecondsLeft({ current: 'save', installSeconds: null })).toBe(
      DEFAULT_INSTALL_SECONDS,
    );
  });
});

describe('formatClock', () => {
  it('reads as a running clock', () => {
    expect(formatClock(7_400)).toBe('0:07');
    expect(formatClock(102_000)).toBe('1:42');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('the update-finished notice', () => {
  const record: UpdateRunRecord = {
    from: '1.4.9',
    to: '1.5.0',
    outcome: 'updated',
    startedAt: '2026-10-13T10:00:00.000Z',
    finishedAt: '2026-10-13T10:01:42.000Z',
    seconds: 102,
  };

  it("shows the shell's record, with its times", () => {
    const notice = finishedUpdateNotice({
      running: '1.5.0',
      shell: record,
      lastSeenVersion: '1.4.9',
      seen: [],
    });
    expect(notice).toMatchObject({ from: '1.4.9', to: '1.5.0', outcome: 'updated', seconds: 102 });
  });

  it('shows once: an acknowledged record stays quiet', () => {
    const first = finishedUpdateNotice({
      running: '1.5.0',
      shell: record,
      lastSeenVersion: null,
      seen: [],
    });
    expect(
      finishedUpdateNotice({
        running: '1.5.0',
        shell: record,
        lastSeenVersion: '1.5.0',
        seen: [first?.key ?? ''],
      }),
    ).toBeNull();
  });

  it('falls back to the version this browser last ran, with no times', () => {
    expect(
      finishedUpdateNotice({ running: '1.5.0', shell: null, lastSeenVersion: '1.4.9', seen: [] }),
    ).toMatchObject({
      from: '1.4.9',
      to: '1.5.0',
      seconds: null,
      startedAt: null,
    });
  });

  it('says nothing on a first start, or when the version did not change', () => {
    expect(
      finishedUpdateNotice({ running: '1.5.0', shell: null, lastSeenVersion: null, seen: [] }),
    ).toBeNull();
    expect(
      finishedUpdateNotice({ running: '1.5.0', shell: null, lastSeenVersion: '1.5.0', seen: [] }),
    ).toBeNull();
  });
});
